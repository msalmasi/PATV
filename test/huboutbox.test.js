// 1.99acf huboutbox.js: the v1 -> chat hub outbox (the chat design §1.7). emit() only inside a transaction (and gone with a
// rollback); the sessions trigger (any writer, a raw UPDATE too) only while hubseam.sessions is on; sessions.revokeAll's
// account cutoff only when nothing is excepted; the merge row; the poster idle without HUB_V1_URL; against a fake hub:
// batches of <= 300 per topic in id order, trigger rows filled with the current state, HMAC headers that verify, posted only
// on a 2xx, retried after a 500, the proxy; the 7-day cleanups; the heartbeat (signed, outbox_head; nothing unconfigured).
//   node --test test/huboutbox.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "huboutbox-test-")));
delete process.env.STAGING;
delete process.env.HUB_V1_URL; delete process.env.HUB_V1_PROXY;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "sessions"));
const HO = require(path.join(repo, "huboutbox"));
const hubsign = require(path.join(repo, "hubsign"));

const DAY = 86400000;
const rows = (topic) => getQuery("SELECT * FROM hub_outbox WHERE topic = ? ORDER BY id", [topic]);
const fakeReq = { get: (h) => (h === "user-agent" ? "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" : "") };

// a fake hub: records every request, answers from a status queue (default 200)
const got = [];
let statuses = [];
const hub = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => { b += c; });
  req.on("end", () => { got.push({ method: req.method, url: req.url, headers: req.headers, body: b }); const s = statuses.length ? statuses.shift() : 200; res.writeHead(s); res.end("{}"); });
});
let hubBase;

test.before(async () => {
  await HO.init();
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  hubBase = `http://127.0.0.1:${hub.address().port}`;
});
test.after(() => { hub.close(); HO.stop(); });

test("emit(): only inside a transaction; a rolled-back transaction leaves no row; off switches write nothing; deduped", async () => {
  await assert.rejects(HO.emit("econ/committed", "ix:a", {}), /inside dbUtils\.tx/);
  await assert.rejects(tx(() => HO.emit("nope/topic", "x", {})), /unknown topic/);
  assert.equal(await tx(() => HO.emit("econ/committed", "ix:off", { a: 1 })), false, "econ switch off -> nothing");
  await HO.setSettings({ econ: true, privacy: true });
  await assert.rejects(tx(async () => { await HO.emit("econ/committed", "ix:rolled", { a: 1 }); throw new Error("boom"); }), /boom/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE entity = 'ix:rolled'"))[0].n, 0, "rolled back with the action");
  assert.equal(await tx(() => HO.emit("econ/committed", "ix:kept", { a: 1 }, { dedupe: "d1" })), true);
  assert.equal(await tx(() => HO.emit("econ/committed", "ix:kept", { a: 2 }, { dedupe: "d1" })), false, "same dedupe key -> one row");
  const r = (await getQuery("SELECT * FROM hub_outbox WHERE entity = 'ix:kept'"));
  assert.equal(r.length, 1);
  assert.deepEqual(JSON.parse(r[0].payload), { a: 1 });
  assert.equal(r[0].posted_at, null);
});

test("sessions/revoked: the trigger writes sid: rows only with the switch on (a raw UPDATE too); account cutoff only without except; merges", async () => {
  await runQuery("DELETE FROM hub_outbox");
  const a = await S.create(fakeReq, "acc-a", "password");
  await S.revoke("acc-a", a.id, "signed out");
  assert.equal((await rows("sessions/revoked")).length, 0, "switch off: nothing");
  await HO.setSettings({ sessions: true });
  const b = await S.create(fakeReq, "acc-a", "password");
  await S.revoke("acc-a", b.id, "signed out");
  let r = await rows("sessions/revoked");
  assert.deepEqual(r.map((x) => [x.entity, x.payload]), [["sid:" + b.id, null]], "one trigger row, payload read at post time");
  const c = await S.create(fakeReq, "acc-a", "password");
  await runQuery("UPDATE sessions SET revoked_at = ?, revoked_why = 'cli' WHERE id = ?", [Date.now(), c.id]);   // an admin script
  r = await rows("sessions/revoked");
  assert.equal(r[r.length - 1].entity, "sid:" + c.id, "a raw UPDATE writes its row too");
  await runQuery("DELETE FROM hub_outbox");
  // sign out everywhere ELSE (keeps this device): per-session rows only
  const keep = await S.create(fakeReq, "acc-b", "password");
  const o1 = await S.create(fakeReq, "acc-b", "password");
  const o2 = await S.create(fakeReq, "acc-b", "password");
  await S.revokeAll("acc-b", { except: keep.id, why: "signed out everywhere else" });
  r = await rows("sessions/revoked");
  assert.deepEqual(r.map((x) => x.entity).sort(), ["sid:" + o1.id, "sid:" + o2.id].sort(), "no account cutoff when a device is kept");
  await runQuery("DELETE FROM hub_outbox");
  // sign out everywhere: the sessions + an account cutoff
  await S.revokeAll("acc-b", { why: "signed out everywhere" });
  r = await rows("sessions/revoked");
  assert.deepEqual(r.map((x) => x.entity), ["sid:" + keep.id, "acct:acc-b"]);
  const cut = JSON.parse(r[1].payload);
  assert.equal(cut.kind, "account");
  assert.equal(cut.account, null, "a legacy id without CHAT_GENESIS_NS has no hub account id");
  assert.equal(cut.v1_user, "acc-b", "the raw users.userId rides beside it");
  assert.equal(cut.why, "signed out everywhere");
  // `before` is epoch SECONDS (the ticket iat's unit), rounded up: a ticket issued before the cutoff has iat < before
  const nowS = Math.ceil(Date.now() / 1000);
  assert.ok(Number.isInteger(cut.before) && cut.before > 1e9 && cut.before < 1e11, "seconds, not milliseconds: " + cut.before);
  assert.ok(cut.before <= nowS && cut.before >= nowS - 5);
  await runQuery("DELETE FROM hub_outbox");
  // a merge: its sessions are deleted (no trigger) and one merge row says where the account went
  await S.create(fakeReq, "acc-old", "password");
  assert.equal(await S.revokeForMerge("acc-old", "acc-new"), 1);
  r = await rows("sessions/revoked");
  assert.equal(r.length, 1);
  const merge = JSON.parse(r[0].payload);
  assert.ok(merge.before > 1e9 && merge.before < 1e11, "the merge cutoff is in seconds too");
  assert.deepEqual({ ...merge, before: 0 }, { kind: "merge", account: null, into: null, v1_user: "acc-old", v1_into: "acc-new", before: 0 });
  assert.equal(r[0].entity, "acct:acc-old");
});

test("account ids in the seam rows are the ticket's sub: chatticket.subjectOf (a legacy id -> its UUIDv5 in CHAT_GENESIS_NS)", async () => {
  const CT = require(path.join(repo, "chatticket"));
  const NS = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
  process.env.CHAT_GENESIS_NS = NS;
  try {
    await runQuery("DELETE FROM hub_outbox");
    const s1 = await S.create(fakeReq, "12345", "password");               // a legacy (non-UUID) users.userId
    await S.revoke("12345", s1.id, "signed out");
    await S.revokeAll("12345", { why: "signed out everywhere" });
    await S.create(fakeReq, "old-777", "password");
    await S.revokeForMerge("old-777", "12345");
    const r = await rows("sessions/revoked");
    const sub = CT.subjectOf("12345");
    assert.equal(sub, require("uuid").v5("12345", NS));
    const sessRow = await HO.readers["sessions/revoked"](r[0].entity);
    assert.equal(sessRow.account, sub, "a session row: the account as the ticket's sub");
    assert.equal(sessRow.v1_user, "12345");
    const acct = JSON.parse(r.find((x) => x.entity === "acct:12345").payload);
    assert.equal(acct.account, sub, "the account cutoff");
    const merge = JSON.parse(r.find((x) => x.entity === "acct:old-777").payload);
    assert.equal(merge.account, CT.subjectOf("old-777"), "the merged-away account");
    assert.equal(merge.into, sub, "...and where it went - so the hub matches both to their tickets");
  } finally { delete process.env.CHAT_GENESIS_NS; }
});

test("hub_outbox ids never go backwards, even after the table empties (AUTOINCREMENT)", async () => {
  const sql = (await getQuery("SELECT sql FROM sqlite_master WHERE name = 'hub_outbox'"))[0].sql;
  assert.match(sql, /id INTEGER PRIMARY KEY AUTOINCREMENT/);
  await tx(() => HO.emit("econ/committed", "ix:seq-a", { a: 1 }, { dedupe: "seq-a" }));
  const top = (await getQuery("SELECT MAX(id) AS id FROM hub_outbox"))[0].id;
  await runQuery("DELETE FROM hub_outbox");
  await tx(() => HO.emit("econ/committed", "ix:seq-b", { a: 1 }, { dedupe: "seq-b" }));
  const next = (await getQuery("SELECT id FROM hub_outbox WHERE entity = 'ix:seq-b'"))[0].id;
  assert.ok(next > top, `the next id (${next}) is above every id ever handed out (${top})`);
});

test("the poster: idle without HUB_V1_URL", async () => {
  delete process.env.HUB_V1_URL;
  assert.deepEqual(await HO.pumpOnce(), { posted: 0, idle: true });
  assert.equal(await HO.heartbeatOnce(), null, "no heartbeat either");
});

test("against a fake hub: <= 300 rows per topic in id order, trigger rows filled, HMAC verifies, posted only on 2xx, retried after a 500", async () => {
  await runQuery("DELETE FROM hub_outbox");
  HO._resetPoster();
  await tx(async () => { for (let i = 0; i < 650; i++) await HO.emit("econ/committed", "ix:k" + i, { n: i }, { dedupe: "e" + i }); });
  const s = await S.create(fakeReq, "acc-c", "password");
  await S.revoke("acc-c", s.id, "signed out from Settings");
  process.env.HUB_V1_URL = hubBase + "/";              // after the emits: no background wake races the passes below
  process.env.HUB_V1_KEY_ID = "v1-prod-test";
  process.env.HUB_V1_KEY = "hub-key-not-real";
  // two passes started together never post a row twice
  got.length = 0;
  await Promise.all([HO.pumpOnce(), HO.pumpOnce()]);
  assert.equal(got.filter((g) => g.url === "/internal/v1/sessions/revoked").length, 1, "one pass at a time");
  await runQuery("UPDATE hub_outbox SET posted_at = NULL");
  got.length = 0;
  statuses = [500];
  const first = await HO.pumpOnce();
  assert.equal(first.failed, true);
  assert.equal(first.topic, "econ/committed");
  assert.deepEqual(got.map((g) => g.url), ["/internal/v1/econ/committed", "/internal/v1/sessions/revoked"],
                   "the refused topic backs off; the next topic's batch still goes in the same pass");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NOT NULL AND topic = 'econ/committed'"))[0].n, 0, "nothing marked after a 500");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NOT NULL AND topic = 'sessions/revoked'"))[0].n, 1);
  const sessReq = got[1];
  const st0 = await HO.status();
  assert.ok(st0.failing["econ/committed"] && st0.failing["econ/committed"].retry_in_ms > 0 && st0.failing["econ/committed"].status === 500,
            "/admin/keys#seam shows the topic backing off");
  got.length = 0;
  assert.equal((await HO.pumpOnce()).posted, 0);
  assert.equal(got.length, 0, "during its back-off the topic is skipped");
  HO._resetPoster();                                    // the back-off ran out
  let total = 0;
  for (let i = 0; i < 5; i++) { const r = await HO.pumpOnce(); total += r.posted; if (!r.posted) break; }
  assert.equal(total, 650);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NULL"))[0].n, 0, "all posted");
  got.push(sessReq);
  const keys = { "v1-prod-test": "hub-key-not-real" };
  let lastId = { };
  for (const g of got) {
    assert.equal(g.method, "POST");
    const v = hubsign.verify({ method: "POST", path: g.url, body: g.body, headers: g.headers, keys });
    assert.equal(v.ok, true, "signed: " + JSON.stringify(v));
    const body = JSON.parse(g.body);
    assert.ok(body.rows.length <= 300 && body.rows.length > 0);
    const topic = g.url.replace("/internal/v1/", "");
    for (const r of body.rows) {
      assert.equal(r.topic, topic);
      assert.ok(!(lastId[topic] >= r.id), "id order per topic, each row once");
      lastId[topic] = r.id;
    }
  }
  const econBatches = got.filter((g) => g.url === "/internal/v1/econ/committed").map((g) => JSON.parse(g.body).rows.length);
  assert.deepEqual(econBatches, [300, 300, 50]);
  const sess = got.find((g) => g.url === "/internal/v1/sessions/revoked");
  const row = JSON.parse(sess.body).rows[0];
  assert.equal(row.entity, "sid:" + s.id);
  assert.deepEqual({ ...row.payload, at: 0, until: 0 }, { kind: "session", sid: s.id.slice(0, 32), account: null, v1_user: "acc-c", at: 0, until: 0,
                                                       why: "signed out from Settings" },
                   "the trigger row is filled with the session's current state");
  const st = await HO.status();
  assert.equal(st.configured, true);
  assert.equal(st.pending, 0);
  assert.ok(st.last_post && st.last_post.ok);
  // the background poster backs the topic off after a failure, then delivers
  statuses = [500];
  await tx(() => HO.emit("econ/committed", "ix:late", { n: 1 }, { dedupe: "late" }));
  await new Promise((r) => setTimeout(r, 150));          // the emit's wake-up ran one pass (and got the 500)
  assert.ok((await HO.status()).retry_in_ms > 0, "backing off");
  const n0 = got.length;
  assert.equal((await HO.pump()).posted, 0, "no post of that topic during its back-off");
  assert.equal(got.length, n0);
  HO._resetPoster();
  assert.equal((await HO.pump()).posted, 1);
});

test("one topic the hub refuses for good (a 404: endpoint not built yet) never holds up the others", async () => {
  await runQuery("DELETE FROM hub_outbox");
  HO._resetPoster();
  process.env.HUB_V1_URL = hubBase;
  const refuse = (g) => g.url === "/internal/v1/econ/committed";
  const savedHandler = hub.listeners("request")[0];
  hub.removeAllListeners("request");
  hub.on("request", (req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => { const g = { method: req.method, url: req.url, headers: req.headers, body: b }; got.push(g); res.writeHead(refuse(g) ? 404 : 200); res.end("{}"); });
  });
  try {
    // the refused topic's oldest row is the oldest overall (it sorts first every pass)
    await tx(() => HO.emit("econ/committed", "ix:stuck", { n: 1 }, { dedupe: "stuck" }));
    for (let round = 0; round < 3; round++) {
      const s2 = await S.create(fakeReq, "acc-r" + round, "password");
      await S.revoke("acc-r" + round, s2.id, "signed out");
      await HO.pumpOnce();
      HO._resetPoster();                                 // as if each back-off had run out
    }
    const posted = await getQuery("SELECT topic, COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NOT NULL GROUP BY topic");
    assert.deepEqual(posted, [{ topic: "sessions/revoked", n: 3 }], "every revocation reached the hub");
    assert.equal((await getQuery("SELECT posted_at FROM hub_outbox WHERE entity = 'ix:stuck'"))[0].posted_at, null, "the refused row waits");
    // and in order within a topic
    const sessBodies = got.filter((g) => g.url === "/internal/v1/sessions/revoked").map((g) => JSON.parse(g.body).rows.map((r) => r.id)).flat();
    assert.deepEqual(sessBodies, [...sessBodies].sort((a, b) => a - b));
  } finally {
    hub.removeAllListeners("request");
    hub.on("request", savedHandler);
  }
});

test("a plain http:// hub address that isn't loopback is never posted to without the tailnet proxy (insecure_url)", async () => {
  const savedUrl = process.env.HUB_V1_URL;
  try {
    got.length = 0;
    process.env.HUB_V1_URL = "http://hub.example.test:8443";
    delete process.env.HUB_V1_PROXY;
    assert.equal(HO.insecureUrl(), true);
    const r = await HO.postSigned("/internal/v1/heartbeat", { v: 1 });
    assert.equal(r.error, "insecure_url");
    HO._resetPoster();
    await tx(() => HO.emit("econ/committed", "ix:cleartext", { n: 1 }, { dedupe: "cleartext" }));
    const p = await HO.pumpOnce();
    // the emit's own wake-up (50 ms) can run first on a busy machine (the whole suite at once): then this pass finds the
    // topic already backing off - refused for the same reason - and posts nothing (passes chain, so either order is settled)
    const refused = p.failed ? p.error : ((await HO.status()).failing["econ/committed"] || {}).error;
    assert.equal(refused, "insecure_url", "the outbox isn't posted either");
    await new Promise((res) => setTimeout(res, 150));     // the emit's own wake-up runs here too (and posts nothing)
    assert.equal(got.length, 0);
    await runQuery("DELETE FROM hub_outbox WHERE entity IN ('ix:cleartext', 'ix:stuck')");
    assert.equal(got.length, 0, "nothing sent");
    assert.equal((await HO.status()).insecure, true, "/admin/keys#seam says why");
    assert.equal(HO.insecureUrl("https://hub.example.test"), false, "https is fine");
    assert.equal(HO.insecureUrl("http://127.0.0.1:9999"), false, "loopback is fine");
    assert.equal(HO.insecureUrl("http://[::1]:9999"), false);
    process.env.HUB_V1_PROXY = "127.0.0.1:1055";
    // 1.99acm: the proxy carries only tailnet destinations - tailscaled dials any other host directly, in the clear
    assert.equal(HO.insecureUrl("http://hub.example.test:8443"), true, "a public name stays refused with the proxy set");
    assert.equal(HO.insecureUrl("http://203.0.113.7:8080"), true, "a public address too");
    assert.equal(HO.insecureUrl("http://100.63.255.1:8080"), true, "just below 100.64.0.0/10");
    assert.equal(HO.insecureUrl("http://100.128.0.1:8080"), true, "just above it");
    for (const ok of ["http://100.64.0.1:8080", "http://100.127.255.254", "http://patv-v2.tail1234.ts.net:8080", "http://[fd7a:115c:a1e0::5]:8080",
                      "http://127.3.4.5", "http://localhost:8080"]) {
      assert.equal(HO.insecureUrl(ok), false, ok);
    }
    assert.equal(HO.insecureUrl("http://[fd7a:115c:a1e1::5]:8080"), true, "another ULA prefix");
    assert.equal(HO.insecureUrl("http://evil.ts.net.example.test"), true, "*.ts.net only as the suffix");
    assert.equal(HO.refusal(), "insecure_url", "with the proxy set, a public hub address is still refused");
  } finally { process.env.HUB_V1_URL = savedUrl; delete process.env.HUB_V1_PROXY; }
});

test("1.99acm: an outbound key that equals an inbound key is never used (key_reuse)", async () => {
  const saved = { k: process.env.HUB_V1_KEY, i: process.env.HUB_V1_IN_KEY, p: process.env.HUB_V1_IN_PREV_KEY };
  try {
    assert.equal(HO.refusal(), null);
    process.env.HUB_V1_IN_KEY = process.env.HUB_V1_KEY;
    assert.equal(HO.refusal(), "key_reuse");
    assert.equal((await HO.postSigned("/internal/v1/heartbeat", { v: 1 })).error, "key_reuse");
    process.env.HUB_V1_IN_KEY = "another-inbound-secret-0123456789abcdef";
    process.env.HUB_V1_IN_PREV_KEY = process.env.HUB_V1_KEY;
    assert.equal(HO.refusal(), "key_reuse", "the previous inbound key counts too");
    delete process.env.HUB_V1_IN_PREV_KEY;
    assert.equal(HO.refusal(), null);
  } finally {
    for (const [k, v] of [["HUB_V1_KEY", saved.k], ["HUB_V1_IN_KEY", saved.i], ["HUB_V1_IN_PREV_KEY", saved.p]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("the heartbeat: signed, carries outbox_head; off by switch; the proxy for an http:// hub", async () => {
  got.length = 0;
  assert.equal(await HO.heartbeatOnce(), null, "switch off: nothing sent");
  await HO.setSettings({ heartbeat: true });
  const hb = await HO.heartbeatOnce();
  assert.equal(hb.ok, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].url, "/internal/v1/heartbeat");
  const body = JSON.parse(got[0].body);
  const head = (await getQuery("SELECT seq FROM sqlite_sequence WHERE name = 'hub_outbox'"))[0].seq;   // 1.99acm: the AUTOINCREMENT high-water mark
  assert.equal(body.outbox_head, head);
  assert.equal(body.v, 1);
  assert.equal(body.env, "prod");
  assert.equal(body.version, HO.VERSION);
  assert.ok(Array.isArray(body.jwks_kids));
  assert.equal(hubsign.verify({ method: "POST", path: got[0].url, body: got[0].body, headers: got[0].headers, keys: { "v1-prod-test": "hub-key-not-real" } }).ok, true);
  // through the userspace tailscaled proxy: an absolute-URI request to the proxy
  const seen = [];
  const proxy = http.createServer((req, res) => { seen.push({ url: req.url, host: req.headers.host }); res.writeHead(200); res.end(); });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  process.env.HUB_V1_URL = "http://patv-v2.tail1234.ts.net:8443";        // 1.99acm: the proxy only ever carries a tailnet host
  process.env.HUB_V1_PROXY = "127.0.0.1:" + proxy.address().port;
  try {
    assert.equal((await HO.heartbeatOnce()).ok, true);
    assert.deepEqual(seen, [{ url: "http://patv-v2.tail1234.ts.net:8443/internal/v1/heartbeat", host: "patv-v2.tail1234.ts.net:8443" }]);
  } finally {
    proxy.close();
    delete process.env.HUB_V1_PROXY;
    process.env.HUB_V1_URL = hubBase;
  }
  delete process.env.HUB_V1_KEY;
  assert.equal((await HO.heartbeatOnce()).error, "no_key", "no key -> nothing sent");
  process.env.HUB_V1_KEY = "hub-key-not-real";
});

test("cleanup: posted rows go after 7 days; unposted ones only while no hub is configured", async () => {
  const t = Date.now();
  await runQuery("INSERT INTO hub_outbox (topic, entity, created_at, posted_at) VALUES ('econ/committed', 'old-posted', ?, ?)", [t - 9 * DAY, t - 8 * DAY]);
  await runQuery("INSERT INTO hub_outbox (topic, entity, created_at, posted_at) VALUES ('econ/committed', 'new-posted', ?, ?)", [t - 2 * DAY, t - DAY]);
  await runQuery("INSERT INTO hub_outbox (topic, entity, created_at) VALUES ('econ/committed', 'old-unposted', ?)", [t - 8 * DAY]);
  process.env.HUB_V1_URL = hubBase;
  let r = await HO.cleanup();
  assert.deepEqual(r, { posted: 1, unposted: 0, nonces: 0 }, "a configured hub still gets its old unposted rows");
  delete process.env.HUB_V1_URL;
  r = await HO.cleanup();
  assert.deepEqual(r, { posted: 0, unposted: 1, nonces: 0 });
  const left = (await getQuery("SELECT entity FROM hub_outbox WHERE entity IN ('old-posted', 'new-posted', 'old-unposted')")).map((x) => x.entity);
  assert.deepEqual(left, ["new-posted"]);
});
