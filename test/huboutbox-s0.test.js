// 1.99acm huboutbox.js, the S0 slices of R-14 / R-12 (seam plan §2, §4): the privacy/changed triggers on profile_layout ("pa:")
// and hub_hidden_h ("hh:") and their readers (switch on / off); the erasure topics gated by their own switch; the head is
// sqlite_sequence (an emptied table keeps it); the heartbeat's env, switches and per-topic stats; snapshots per topic (paging
// and ranges in byte order, the head read with the rows, non-default state only, a pending incognito ON, 404 while the switch
// is off); rewind; the key-env and URL-path refusals; getSigned (streamed to a 0600 file, the size cap, the timeout, nothing
// left behind on a failure); the fault hook between the hub's 2xx and posted_at; the contract driver's directory guard.
//   node --test test/huboutbox-s0.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "huboutbox-s0-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.HUB_V1_URL; delete process.env.HUB_V1_PROXY; delete process.env.HUB_V1_ENV;
process.env.SECRET_KEY = "test-secret";
process.env.CHAT_GENESIS_NS = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const HO = require(path.join(repo, "huboutbox"));
const S = require(path.join(repo, "sessions"));
const PL = require(path.join(repo, "profilelayout"));
const HH = require(path.join(repo, "hubhidden"));
const I = require(path.join(repo, "incognito"));
const hubsign = require(path.join(repo, "hubsign"));
const CT = require(path.join(repo, "chatticket"));

const fakeReq = { get: (h) => (h === "user-agent" ? "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" : "") };
const rows = (topic) => getQuery("SELECT * FROM hub_outbox WHERE topic = ? ORDER BY id", [topic]);
const KEY = "v1-test-key-0123456789abcdef-not-real";

const got = [];
let answer = () => ({ status: 200, body: "{}" });
const hub = http.createServer((req, res) => {
  const b = [];
  req.on("data", (c) => b.push(c));
  req.on("end", () => {
    const g = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(b).toString("utf8") };
    got.push(g);
    const a = answer(g);
    if (a.hang) return;                                      // never answers (the timeout)
    res.writeHead(a.status, a.headers || {});
    res.end(a.body);
  });
});
let hubBase;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, archived_at INTEGER)`);
  await HO.init();
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  hubBase = `http://127.0.0.1:${hub.address().port}`;
});
test.after(() => { hub.close(); HO.stop(); });

test("privacy/changed pa: and hh: triggers write rows only while hubseam.privacy is on; the readers report the current state", async () => {
  await PL.save("u1", { hidden: ["analytics"] });
  assert.deepEqual(await HH.note(["0123456789abcdef0123"]), { ignored: true }, "1.99acm: Pepe's hidden set isn't even stored while the switch is off");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_hidden_h"))[0].n, 0);
  assert.equal((await rows("privacy/changed")).length, 0, "switch off: nothing");
  await HO.setSettings({ privacy: true });
  await PL.save("u1", { hidden: ["an_rooms"] });
  await PL.save("u2", { hidden: [] });
  await HH.note(["0123456789abcdef0123", "fedcba9876543210fedc"]);
  // 1.99add: the set is sticky - a hash goes only on an explicit un-hide (Pepe's privacy.shown), never because a list lacks it
  await HH.noteSync({ list: ["fedcba9876543210fedc"], events: [{ op: "event", type: "privacy.shown", data: { h: "0123456789abcdef0123", scope: "bridge" } }] });
  await PL.reset("u2");
  const r = await rows("privacy/changed");
  assert.deepEqual(r.map((x) => [x.entity, x.payload]), [["pa:u1", null], ["pa:u2", null], ["hh:0123456789abcdef0123", null], ["hh:fedcba9876543210fedc", null],
                                                          ["hh:0123456789abcdef0123", null], ["pa:u2", null]],
                   "trigger rows carry only the entity (the first sync after the switch turned on writes the whole set)");
  const rd = HO.readers["privacy/changed"];
  const pa1 = await rd("pa:u1");
  assert.deepEqual({ ...pa1, at: 0 }, { flag: "private_activity", value: true, subject: { acct: CT.subjectOf("u1"), v1_user: "u1" }, at: 0 },
                   "the Rooms panel hidden is private activity (stories.privateLogins' rule)");
  assert.equal((await rd("pa:u2")).value, false, "no layout: public");
  assert.deepEqual({ ...(await rd("hh:fedcba9876543210fedc")), at: 0 }, { flag: "hidden_h", h: "fedcba9876543210fedc", value: true, at: 0 });
  assert.equal((await rd("hh:0123456789abcdef0123")).value, false, "explicitly un-hidden");
  await runQuery("UPDATE profile_layout SET layout = 'not json' WHERE user_id = 'u1'");
  assert.equal((await rd("pa:u1")).value, true, "an unreadable layout fails closed");
  // 1.99acm: switching privacy off empties the stored set without writing a row for it
  const n0 = (await rows("privacy/changed")).length;
  await HO.setSettings({ privacy: false });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_hidden_h"))[0].n, 0, "the set is gone with the switch");
  assert.equal((await rows("privacy/changed")).length, n0, "and the hub isn't told (the switch is off)");
});

test("the erasure topics: off by default (a separate switch), on together; unknown topics refused", async () => {
  assert.equal(HO.DEFAULTS.erasure, false);
  assert.equal(HO.DEFAULTS.export, false);
  assert.equal(HO.TOPICS["privacy/account-deleted"], "erasure");
  assert.equal(HO.TOPICS["privacy/forget"], "erasure");
  assert.equal(await tx(() => HO.emit("privacy/forget", "forget:1", { a: 1 })), false, "off: nothing");
  await HO.setSettings({ erasure: true });
  assert.equal(await tx(() => HO.emit("privacy/forget", "forget:1", { a: 1 }, { dedupe: "forget:1" })), true);
  assert.equal(await tx(() => HO.emit("privacy/account-deleted", "acct:9", { a: 1 }, { dedupe: "acctdel:9" })), true);
  await HO.setSettings({ erasure: false });
});

test("the head is sqlite_sequence: an emptied table keeps it", async () => {
  await HO.setSettings({ privacy: true });
  await HH.note(["1111111111111111111a"]);
  const top = (await getQuery("SELECT MAX(id) AS id FROM hub_outbox"))[0].id;
  assert.equal(await HO.headId(), top);
  await runQuery("DELETE FROM hub_outbox");
  assert.equal(await HO.headId(), top, "never 0 after cleanup");
  await HO.setSettings({ privacy: false });
});

test("the heartbeat: env (HUB_V1_ENV, else STAGING), the switches (not spans), per-topic head / pending / oldest", async () => {
  await runQuery("DELETE FROM hub_outbox");
  await HO.setSettings({ sessions: true, heartbeat: true });
  const s = await S.create(fakeReq, "hb1", "password");
  await S.revoke("hb1", s.id, "signed out");
  let b = await HO.heartbeatBody();
  assert.equal(b.env, "prod");
  assert.deepEqual(Object.keys(b.switches).sort(), ["econ", "erasure", "export", "heartbeat", "privacy", "sessions", "tickets"]);
  assert.equal(b.switches.sessions, true);
  const sr = b.topics["sessions/revoked"];
  assert.equal(sr.pending, 1);
  assert.equal(sr.head, (await getQuery("SELECT MAX(id) AS id FROM hub_outbox"))[0].id);
  assert.ok(sr.oldest_pending_at > 0);
  assert.equal(b.outbox_head, await HO.headId());
  assert.equal(b.version, "1.99acm");
  process.env.STAGING = "1";
  assert.equal((await HO.heartbeatBody()).env, "staging");
  process.env.HUB_V1_ENV = "test";
  assert.equal((await HO.heartbeatBody()).env, "test", "HUB_V1_ENV wins");
  delete process.env.STAGING;
  await HO.setSettings({ privacy: true });
  b = await HO.heartbeatBody();
  assert.deepEqual(b.topics["privacy/changed"], { head: 0, pending: 0, oldest_pending_at: null }, "a switched-on topic without rows is listed");
  assert.equal(b.topics["privacy/forget"], undefined, "an off topic without rows is not");
  await HO.setSettings({ privacy: false, heartbeat: false });
});

test("refusals: the key id must be v1-<env>-<n>, HUB_V1_URL an origin, HUB_V1_ENV a known env", async () => {
  process.env.HUB_V1_ENV = "test";
  process.env.HUB_V1_URL = hubBase;
  process.env.HUB_V1_KEY = KEY;
  got.length = 0;
  for (const [id, want] of [["v1-staging-1", "key_env"], ["hub-test-1", "key_env"], ["v1stg-test", "key_env"], ["v1-test-1", null]]) {
    process.env.HUB_V1_KEY_ID = id;
    assert.equal(HO.refusal(), want, id);
  }
  const r = await HO.postSigned("/internal/v1/heartbeat", { v: 1 });
  assert.equal(r.ok, true);
  process.env.HUB_V1_KEY_ID = "v1-staging-1";
  assert.equal((await HO.postSigned("/internal/v1/heartbeat", { v: 1 })).error, "key_env", "never signs with another env's key");
  process.env.HUB_V1_KEY_ID = "v1-test-1";
  process.env.HUB_V1_URL = hubBase + "/hub";
  assert.equal((await HO.postSigned("/internal/v1/heartbeat", { v: 1 })).error, "url_path", "the signed path is the raw target: no prefix");
  process.env.HUB_V1_URL = hubBase + "/";
  assert.equal(HO.refusal(), null, "a trailing slash is still an origin");
  process.env.HUB_V1_ENV = "qa";
  assert.equal(HO.refusal(), "bad_env");
  process.env.HUB_V1_ENV = "test";
  assert.equal(got.length, 1, "only the good request was sent");
  const st = await HO.status();
  assert.equal(st.env, "test");
  assert.equal(st.key_id, "v1-test-1");
  assert.ok(st.inbound && st.inbound.configured === false);
  assert.ok(st.export_wait && st.export_wait.waiting === 0);
});

test("getSigned: streamed into a new 0600 file; the size cap and the timeout leave nothing behind; non-2xx is a failure", async () => {
  process.env.HUB_V1_URL = hubBase;
  const dir = fs.mkdtempSync(path.join(tmp, "get-"));
  answer = (g) => ({ status: 200, headers: { "content-type": "application/x-ndjson" }, body: '{"t":"header"}\n{"t":"end","complete":true}\n' });
  got.length = 0;
  const f1 = path.join(dir, "a.jsonl");
  const r = await HO.getSigned("/internal/v1/privacy/export/acct/0192a5b4-1111-7c2d-8e3f-4a5b6c7d8e9f?ref=77", { toFile: f1 });
  assert.equal(r.ok, true);
  assert.equal(r.bytes, fs.statSync(f1).size);
  assert.match(fs.readFileSync(f1, "utf8"), /"t":"end"/);
  assert.equal(got[0].method, "GET");
  assert.equal(got[0].url, "/internal/v1/privacy/export/acct/0192a5b4-1111-7c2d-8e3f-4a5b6c7d8e9f?ref=77");
  assert.equal(got[0].body, "");
  assert.equal(got[0].headers["content-type"], undefined, "a GET carries no body type");
  const v = hubsign.verifyFrom({ dir: "v1", env: "test", method: "GET", path: got[0].url, body: "", headers: got[0].headers, keys: { "v1-test-1": KEY } });
  assert.equal(v.ok, true, "signed over the path with its query");
  if (process.platform !== "win32") assert.equal(fs.statSync(f1).mode & 0o777, 0o600);
  answer = () => ({ status: 200, body: "x".repeat(5000) });
  const f2 = path.join(dir, "b.jsonl");
  assert.equal((await HO.getSigned("/internal/v1/x", { toFile: f2, maxBytes: 1000 })).error, "too_large");
  assert.equal(fs.existsSync(f2), false, "a capped body leaves no file");
  answer = () => ({ status: 503, body: "busy" });
  const f3 = path.join(dir, "c.jsonl");
  const r3 = await HO.getSigned("/internal/v1/x", { toFile: f3 });
  assert.deepEqual([r3.ok, r3.status, fs.existsSync(f3)], [false, 503, false]);
  answer = () => ({ hang: true });
  const f4 = path.join(dir, "d.jsonl");
  assert.equal((await HO.getSigned("/internal/v1/x", { toFile: f4, timeoutMs: 200 })).error, "ETIMEDOUT");
  assert.equal(fs.existsSync(f4), false);
  answer = () => ({ status: 200, body: "{}" });
});

test("snapshots: byte-ordered pages with ranges and an opaque cursor, the head, non-default state only, 404 while off", async () => {
  await runQuery("DELETE FROM hub_outbox");
  HO._setClock(() => Date.now());
  await HO.setSettings({ sessions: false, privacy: false, erasure: false });
  assert.equal(await HO.snapshot("sessions/revoked", null), null, "switch off: no snapshot");
  assert.equal(await HO.snapshot("econ/committed", null), null, "no snapshot topic");
  await HO.setSettings({ sessions: true, privacy: true, erasure: true });
  // sessions: revoked unexpired sessions, cutoffs, merges
  const keep = await S.create(fakeReq, "sn1", "password");
  const gone = await S.create(fakeReq, "sn1", "password");
  await S.revoke("sn1", gone.id, "signed out");
  await runQuery("UPDATE sessions SET expires = 1 WHERE id = ?", [keep.id]);
  await runQuery("UPDATE sessions SET revoked_at = 5, revoked_why = 'x' WHERE id = ?", [keep.id]);     // revoked but expired: not listed
  await S.revokeAll("sn2", { why: "ban" });
  await runQuery(`CREATE TABLE IF NOT EXISTS account_merge_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, via TEXT NOT NULL, from_id TEXT NOT NULL,
                  to_id TEXT NOT NULL, from_username TEXT, to_username TEXT, pat REAL, xp INTEGER, moved TEXT, folded TEXT, left_over TEXT, unclassified TEXT, note TEXT)`);
  await runQuery("INSERT INTO account_merge_log (at, via, from_id, to_id) VALUES (1760727599500, 'test', 'sn3', 'sn2')");
  const head = await HO.headId();
  const p = await HO.snapshot("sessions/revoked", null);
  assert.equal(p.v, 1);
  assert.equal(p.topic, "sessions/revoked");
  assert.equal(p.head, head);
  assert.equal(p.complete, true);
  assert.equal(p.next, null);
  assert.deepEqual(p.range, { after: null, through: null });
  const ents = p.rows.map((r) => r.entity);
  assert.ok(ents.includes("sid:" + gone.id) && !ents.includes("sid:" + keep.id));
  assert.deepEqual(p.rows.find((r) => r.entity === "acct:sn2").payload,
                   { kind: "account", account: CT.subjectOf("sn2"), v1_user: "sn2", before: Math.ceil(Number((await getQuery("SELECT after FROM session_cutoffs WHERE user_id = 'sn2'"))[0].after) / 1000), why: "ban" });
  assert.deepEqual(p.rows.find((r) => r.entity === "acct:sn3").payload,
                   { kind: "merge", account: CT.subjectOf("sn3"), into: CT.subjectOf("sn2"), v1_user: "sn3", v1_into: "sn2", before: 1760727600 });
  assert.deepEqual(ents, [...ents].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))), "byte order");
  // paging: one row per page, the cursor carries the last entity, ranges chain, the last page completes
  let cursor = null, seen = [], afterK = null, pages = 0;
  for (;;) {
    const pg = await HO.snapshot("sessions/revoked", cursor, { limit: 1 });
    pages++;
    assert.equal(pg.range.after, afterK);
    seen.push(...pg.rows.map((r) => r.entity));
    if (pg.complete) { assert.equal(pg.next, null); assert.equal(pg.range.through, null); break; }
    assert.equal(pg.range.through, pg.rows[0].entity);
    assert.deepEqual(JSON.parse(Buffer.from(pg.next, "base64url").toString()).k, pg.rows[0].entity);
    cursor = pg.next;
    afterK = pg.rows[0].entity;
  }
  assert.deepEqual(seen, ents);
  assert.equal(pages, ents.length, "the last page carries the last row and completes");
  await assert.rejects(HO.snapshot("sessions/revoked", "not-a-cursor"), (e) => e.status === 400);

  // privacy: confirmed ON (linked + unlinked), a pending ON, private activity, hidden hashes; OFF / public are not listed
  await I.init();
  await runQuery("INSERT INTO users (userId, username, camfrogUsername) VALUES ('alice-id', 'alice', 'Alice'), ('bob-id', 'bob', 'bobcf'), ('acc-id', 'acc', NULL)");
  // 1.99add: a fresh hidden set (the earlier tests' hashes stay sticky in this process - and, since the refix, on disk too)
  HH._reset();
  for (const t of ["hub_hidden_set", "hub_hidden_meta", "hub_hidden_held", "hub_hidden_h"]) await runQuery(`DELETE FROM ${t}`);
  await I.sync({ items: [{ login: "carol.x", on: true, ts: 1760727590000, via: "chat" }, { login: "bobcf", on: false, ts: 1760727590000, via: "chat" },
                         { login: "alice", on: false, ts: 1760727530000, via: "chat" }] });
  await require(path.join(repo, "actions")).queue("alice-id", { kind: "privacy.incognito", args: ["on"], tag: "privacy", label: "incognito on" });
  await PL.save("acc-id", { hidden: ["analytics"] });
  await PL.save("bob-id", { hidden: [] });
  await HH.note(["abcdefabcdefabcdef12"]);
  const pv = await HO.snapshot("privacy/changed", null);
  const by = Object.fromEntries(pv.rows.map((r) => [r.entity, r.payload]));
  const cf = (l) => "cfh:" + HH.loginHash(l);                 // 1.99acm: a login leaves v1 only as its hash (seam plan D-6)
  // 1.99add refix: Pepe's ON report for carol.x hid her hash at once (hubhidden.hiddenReported) - "hh:<her hash>" is listed too
  assert.deepEqual(Object.keys(by), [...[cf("alice"), cf("carol.x")].sort(), ...["hh:abcdefabcdefabcdef12", "hh:" + HH.hash("carol.x")].sort(), "pa:acc-id", "pa:u1"],
                   "bob (confirmed OFF) and bob's public layout are not listed; u1's unreadable layout is (fail closed)");
  assert.doesNotMatch(JSON.stringify(pv), /alice"|carol|bobcf/, "no login in the page");
  assert.equal(by[cf("alice")].value, false);
  assert.equal(by[cf("alice")].pending_on, true, "an unanswered ON request newer than Pepe's last report");
  assert.ok(by[cf("alice")].pending_at > 1760727530000);
  assert.deepEqual(by[cf("alice")].subject, { platform: "camfrog", login_h: HH.loginHash("alice"), acct: CT.subjectOf("alice-id"), v1_user: "alice-id" });
  assert.deepEqual({ ...by[cf("carol.x")] }, { flag: "incognito", value: true, phase: "state", via: "chat", subject: { platform: "camfrog", login_h: HH.loginHash("carol.x") },
                                                   at: by[cf("carol.x")].at, pending_on: false, pending_at: null }, "an unlinked login Pepe reports on");
  assert.equal(by["pa:acc-id"].value, true);
  assert.equal(by["hh:abcdefabcdefabcdef12"].value, true);
  // Pepe answers the request: no longer pending
  await I.sync({ items: [{ login: "alice", on: true, ts: Date.now() + 1000, via: "web" }] });
  const pv2 = Object.fromEntries((await HO.snapshot("privacy/changed", null)).rows.map((r) => [r.entity, r.payload]));
  assert.deepEqual([pv2[cf("alice")].value, pv2[cf("alice")].pending_on, pv2[cf("alice")].via], [true, false, "web"]);
  await HO.setSettings({ privacy: false });
  assert.equal(await HO.snapshot("privacy/changed", null), null, "the switch is the kill switch for the topic's data");

  // erasure topics
  const fs1 = await HO.snapshot("privacy/forget", null);
  assert.deepEqual(fs1.rows, [], "no forget-me yet");
  await HO.setSettings({ erasure: false });
  assert.equal(await HO.snapshot("privacy/forget", null), null);
  await HO.setSettings({ sessions: false });
});

test("1.99acm: the sessions/revoked snapshot lists only the account cutoffs the feed sent (never 'sign out everywhere else')", async () => {
  await runQuery("DELETE FROM hub_outbox");
  await HO.setSettings({ sessions: true });
  const keep = await S.create(fakeReq, "ex1", "password");
  const other = await S.create(fakeReq, "ex1", "password");
  await S.revokeAll("ex1", { except: keep.id, why: "signed out everywhere else" });
  const fed = (await rows("sessions/revoked")).map((r) => r.entity);
  assert.deepEqual(fed, ["sid:" + other.id], "the feed: the other device's session only, no account cutoff");
  assert.ok((await getQuery("SELECT after FROM session_cutoffs WHERE user_id = 'ex1'"))[0].after > 0, "the cookie cutoff is still written");
  const snap = async () => Object.fromEntries((await HO.snapshot("sessions/revoked", null)).rows.map((r) => [r.entity, r.payload]));
  let p = await snap();
  assert.equal(p["acct:ex1"], undefined, "...and the repair snapshot doesn't invent one (the kept device's chat stays open)");
  assert.ok(p["sid:" + other.id]);
  // a password change (except too) - still nothing at account level
  await S.revokeAll("ex1", { except: keep.id, why: "password changed" });
  assert.equal((await snap())["acct:ex1"], undefined);
  // sign out everywhere: the feed's account row, and the snapshot agrees
  await S.revokeAll("ex1", { why: "signed out everywhere" });
  const acct = (await rows("sessions/revoked")).filter((r) => r.entity === "acct:ex1");
  assert.equal(acct.length, 1);
  p = await snap();
  assert.deepEqual(p["acct:ex1"], JSON.parse(acct[0].payload), "the snapshot row is the feed's row");
  // a later "everywhere else" doesn't move it or rename it
  await S.revokeAll("ex1", { except: keep.id, why: "signed out everywhere else" });
  assert.deepEqual((await snap())["acct:ex1"], JSON.parse(acct[0].payload));
  await HO.setSettings({ sessions: false });
});

test("1.99acm: snapshot pages are keyset reads - more than two pages, each source reads at most limit + 1, indexed lookups", async () => {
  await HO.setSettings({ sessions: true, privacy: true });
  await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS users_camfrog_login ON users (lower(trim(camfrogUsername)))
                  WHERE camfrogUsername IS NOT NULL AND trim(camfrogUsername) != ''`);   // accountMerge.ensureCamfrogUnique's index
  // 12 linked logins ON (Pepe's report), 9 private layouts
  for (let i = 0; i < 12; i++) {
    await runQuery("INSERT OR IGNORE INTO users (userId, username, camfrogUsername) VALUES (?, ?, ?)", ["pg-" + i, "pg" + i, " PgLogin" + i + " "]);
  }
  await I.sync({ items: Array.from({ length: 12 }, (_, i) => ({ login: "pglogin" + i, on: true, ts: 1760727590000 + i, via: "chat" })) });
  for (let i = 0; i < 9; i++) await PL.save("pgpa-" + i, { hidden: ["analytics"] });
  const lim = 4;
  let cursor = null, pages = 0;
  const seen = [];
  for (;;) {
    HO._resetScan();
    const pg = await HO.snapshot("privacy/changed", cursor, { limit: lim });
    pages++;
    const sc = HO._scan();
    assert.ok(sc.resolved <= lim + 1, `page ${pages}: ${sc.resolved} accounts resolved (at most ${lim + 1})`);
    seen.push(...pg.rows.map((r) => r.entity));
    if (pg.complete) break;
    cursor = pg.next;
  }
  assert.ok(pages > 2, "more than two pages");
  assert.deepEqual(seen, [...seen].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))), "byte order across pages");
  assert.equal(new Set(seen).size, seen.length, "no entity twice");
  for (let i = 0; i < 12; i++) assert.ok(seen.includes("cfh:" + HH.loginHash("pglogin" + i)), "every ON login listed once");
  for (let i = 0; i < 9; i++) assert.ok(seen.includes("pa:pgpa-" + i));
  // each linked login resolved to its account (the trimmed, case-folded login - the index's expression)
  const one = (await HO.snapshot("privacy/changed", null, { limit: 500 })).rows.find((r) => r.entity === "cfh:" + HH.loginHash("pglogin3"));
  assert.equal(one.payload.subject.v1_user, "pg-3");
  // the query plans: no full scans for the sessions keyset and the login lookups
  const plan = async (sql, args) => (await getQuery("EXPLAIN QUERY PLAN " + sql, args)).map((r) => r.detail).join(" | ");
  const sp = await plan(`SELECT id, user_id, revoked_at, revoked_why, expires FROM sessions
                         WHERE revoked_at IS NOT NULL AND id > ? AND expires > ? ORDER BY id LIMIT ?`, ["", 0, 5]);
  assert.match(sp, /USING (COVERING )?INDEX hub_sessions_revoked/, sp);
  assert.doesNotMatch(sp, /TEMP B-TREE/, "no sort: " + sp);
  const up = await plan(`SELECT userId, lower(trim(camfrogUsername)) AS l FROM users WHERE lower(trim(camfrogUsername)) IN (?, ?)
                         AND camfrogUsername IS NOT NULL AND trim(camfrogUsername) != '' AND archived_at IS NULL`, ["a", "b"]);
  assert.match(up, /USING INDEX users_camfrog_login/, up);
  const u1 = await plan(`SELECT userId, username, camfrogUsername FROM users WHERE lower(trim(camfrogUsername)) = ?
                         AND camfrogUsername IS NOT NULL AND trim(camfrogUsername) != '' AND archived_at IS NULL LIMIT 1`, ["a"]);
  assert.match(u1, /USING INDEX users_camfrog_login/, u1);
  assert.equal((await I.userByLogin("PGLOGIN5")).userId, "pg-5", "userByLogin matches the trimmed login through the index");
  const cp = await plan("SELECT user_id, hub_before, hub_why FROM session_cutoffs WHERE user_id > ? AND hub_before IS NOT NULL ORDER BY user_id LIMIT ?", ["", 5]);
  assert.doesNotMatch(cp, /TEMP B-TREE/, cp);
  await HO.setSettings({ sessions: false, privacy: false });
});

test("rewind: kept rows of the topic above after_id are posted again; unknown topics and bad ids refused", async () => {
  await runQuery("DELETE FROM hub_outbox");
  await HO.setSettings({ erasure: true });
  for (let i = 0; i < 4; i++) await tx(() => HO.emit("privacy/forget", "forget:r" + i, { i }, { dedupe: "rw" + i }));
  await HO.setSettings({ erasure: false });
  const ids = (await rows("privacy/forget")).map((r) => r.id);
  await runQuery("UPDATE hub_outbox SET posted_at = 1");
  const r = await HO.rewind("privacy/forget", ids[1]);
  assert.deepEqual(r, { ok: true, reposted: 2, oldest_kept_id: ids[0], head: await HO.headId() });
  assert.deepEqual((await rows("privacy/forget")).map((x) => x.posted_at == null), [false, false, true, true]);
  await assert.rejects(HO.rewind("nope/topic", 0), (e) => e.status === 404);
  await assert.rejects(HO.rewind("privacy/forget", -1), (e) => e.status === 400);
  await runQuery("DELETE FROM hub_outbox");
});

test("the fault hook runs between the hub's 2xx and posted_at (the contract suite kills v1 there)", async () => {
  process.env.HUB_V1_URL = hubBase;
  HO._resetPoster();
  await HO.setSettings({ erasure: true });
  await tx(() => HO.emit("privacy/forget", "forget:f1", { a: 1 }, { dedupe: "f1" }));
  await HO.setSettings({ erasure: false });
  let seen = null;
  HO._setFault(async (b) => { seen = { ...b, posted: (await rows("privacy/forget"))[0].posted_at }; throw new Error("killed"); });
  try { await HO.pumpOnce(); } catch (e) { assert.equal(e.message, "killed"); }
  HO._setFault(null);
  assert.equal(seen.topic, "privacy/forget");
  assert.equal(seen.posted, null, "posted_at still unset when the hook runs");
  assert.equal((await rows("privacy/forget"))[0].posted_at, null, "...so a restarted v1 posts it again");
  const again = await HO.pumpOnce();
  assert.equal(again.posted, 1);
});

test("the contract driver refuses any directory but a fresh one under the OS temp dir", () => {
  const driver = path.join(repo, "tools", "hubseam-driver.js");
  const r1 = spawnSync(process.execPath, [driver, "--dir", repo], { encoding: "utf8", timeout: 20000 });
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /under/);
  const busy = fs.mkdtempSync(path.join(os.tmpdir(), "hubseam-driver-busy-"));
  fs.writeFileSync(path.join(busy, "myapp.db"), "");
  const r2 = spawnSync(process.execPath, [driver, "--dir", busy], { encoding: "utf8", timeout: 20000 });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /empty/);
  assert.equal(fs.statSync(path.join(busy, "myapp.db")).size, 0, "nothing touched");
});
