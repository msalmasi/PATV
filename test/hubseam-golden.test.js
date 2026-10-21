// 1.99acm the golden rows of the v1 seam (test/fixtures/hubseam-golden-rows.json, byte-identical in the hub repo; seam plan
// §5.1): every v1 builder - the sessions trigger reader, the account / merge emits, the incognito request and Pepe-report emits,
// the private-activity and hidden_h triggers, account deletion, forget-me - produces the golden row's topic, entity and payload
// for its input; v1 never produces the rows the hub must quarantine (a non-ASCII login); the snapshot pages and the heartbeat
// have the golden shapes and payloads.
//   node --test test/hubseam-golden.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubseam-golden-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.HUB_V1_URL;
delete process.env.CHAT_GENESIS_NS;
process.env.HUB_V1_ENV = "test";
process.env.SECRET_KEY = "test-secret";
const repo = path.resolve(__dirname, "..");
const G = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "hubseam-golden-rows.json"), "utf8"));
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

// the golden rows' fixed hub account ids (their users.userId -> account_id); legacy7 has none (CHAT_GENESIS_NS unset)
// The account key of a member with no chat login is "u:<userId>" with an id of 6+ characters (incognito.js ACCT_RE - every real
// id is longer): the golden "1002" is played by "acc1002" here and swapped back before comparing.
const ACCT = { 1001: "0192a5b4-1111-7c2d-8e3f-4a5b6c7d8e9f", acc1002: "0192a5b4-2222-7c2d-8e3f-4a5b6c7d8e9f", 1003: "0192a5b4-3333-7c2d-8e3f-4a5b6c7d8e9f",
               1004: "0192a5b4-4444-7c2d-8e3f-4a5b6c7d8e9f" };
const swap = (x) => JSON.parse(JSON.stringify(x).replace(/acc1002/g, "1002"));
const T0 = 1760727590000, T1 = 1760727600000;
const golden = (name) => { const r = G.rows.find((x) => x.name === name); assert.ok(r, "golden row " + name); return r; };
const fakeReq = { get: (h) => (h === "user-agent" ? "golden" : "") };

let runQuery, getQuery, HO, S, I, PL, HH, D, PF;
// keep(entity): the newest row of the topic whose entity it keeps (default: any)
const lastRow = async (topic, keep = () => true) => {
  const r = (await getQuery("SELECT * FROM hub_outbox WHERE topic = ? ORDER BY id DESC LIMIT 50", [topic])).find((x) => keep(x.entity));
  const payload = r.payload != null ? JSON.parse(r.payload) : await HO.readers[topic](r.entity);
  return swap({ topic: r.topic, entity: r.entity, payload });
};
const same = (name, got) => {
  const g = golden(name).row;
  assert.deepEqual(got, { topic: g.topic, entity: g.entity, payload: g.payload }, name);
};

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  HO = require(path.join(repo, "huboutbox"));
  S = require(path.join(repo, "sessions"));
  I = require(path.join(repo, "incognito"));
  PL = require(path.join(repo, "profilelayout"));
  HH = require(path.join(repo, "hubhidden"));
  D = require(path.join(repo, "accountdelete"));
  PF = require(path.join(repo, "pepeforget"));
  HO._setAccountOf((id) => ACCT[String(id)] || null);
  await HO.init();
  for (const m of [S, I, D, PF]) await m.init();
  await require(path.join(repo, "ledger")).ensure();
  await require(path.join(repo, "staleaccounts")).ensure();
  await HO.setSettings({ heartbeat: true, sessions: true, privacy: true, erasure: true });
  for (const [id, cf] of [["1001", "alice"], ["acc1002", null], ["1003", null], ["1004", "dave"], ["legacy7", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', 'pleb', ?, 0)",
                   [id, "user" + id, "user" + id, cf]);
  }
});
test.after(() => HO._setAccountOf(null));

test("sessions/revoked: a revoked session (trigger + reader), one deleted before the post, a cutoff, a merge, a legacy id", async () => {
  const sid = "ab".repeat(32);
  await runQuery("INSERT INTO sessions (id, user_id, created, expires, method) VALUES (?, '1001', ?, ?, 'password')", [sid, T0 - 1000, 1763319590000]);
  S._setClock(() => T0);
  await S.revoke("1001", sid, "signed out");
  same("sessions: one session signed out", await lastRow("sessions/revoked"));
  assert.deepEqual({ topic: "sessions/revoked", entity: "sid:" + "cd".repeat(32), payload: await HO.readers["sessions/revoked"]("sid:" + "cd".repeat(32)) },
                   (({ topic, entity, payload }) => ({ topic, entity, payload }))(golden("sessions: a session deleted before the post (gone)").row));
  S._setClock(() => T1);
  await S.revokeAll("1001", { why: "signed out everywhere" });
  same("sessions: sign out everywhere (account cutoff)", await lastRow("sessions/revoked"));
  await S.revokeForMerge("1003", "1001");
  same("sessions: account merge", await lastRow("sessions/revoked"));
  await S.revokeAll("legacy7", { why: "ban" });
  same("sessions: a cutoff without a hub account (legacy id, no namespace) is quarantined", await lastRow("sessions/revoked"));
});

test("privacy/changed: incognito requested (web) / confirmed (Pepe, linked + unlinked + account key), private activity, hidden_h", async () => {
  // 1.99add refix: a website ON and Pepe's ON report also hide the key's hash in the sticky hidden set at once (hubhidden.js), so
  // an "hh:" row follows those incognito rows - the golden rows are the incognito rows themselves
  const incog = (e) => !e.startsWith("hh:");
  const hh = async (key) => (await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE topic = 'privacy/changed' AND entity = ?", ["hh:" + HH.hash(key)]))[0].n;
  HH._setClock(() => T0);
  I._setClock(() => T0);
  await I.request("1001", true);
  same("privacy: incognito requested ON from the web (linked login)", await lastRow("privacy/changed", incog));
  assert.equal(await hh("alice"), 1, "the web ON hides alice's hash at once");
  await I.sync({ items: [{ login: "bob.smith", on: true, ts: T0, via: "chat" }] });
  same("privacy: incognito confirmed ON by Pepe (unlinked login)", await lastRow("privacy/changed", incog));
  assert.equal(await hh("bob.smith"), 1, "Pepe's ON report hides the hash at once");
  await I.sync({ items: [{ login: "alice", on: false, ts: 1760727530000, via: "chat" }] });
  same("privacy: incognito confirmed OFF (a newer pending ON stays)", await lastRow("privacy/changed", incog));
  await I.sync({ items: [{ login: "u:acc1002", on: true, ts: T0, via: "web" }] });
  same("privacy: incognito of an account with no chat login", await lastRow("privacy/changed", incog));
  await PL.save("1001", { hidden: ["analytics"] });
  await runQuery("UPDATE profile_layout SET updated = ? WHERE user_id = '1001'", [T0]);
  same("privacy: private activity (profile layout hides analytics)", await lastRow("privacy/changed"));
  HH._setClock(() => T0);
  await HH.note(["6aa77af5451168dd40a5"]);
  same("privacy: a hash in Pepe's hidden_h set", await lastRow("privacy/changed"));
});

test("a raw login: v1 never sends one, nor a login outside the accepted alphabet (the hub quarantines either, scrubbed, if it ever arrives)", async () => {
  const g = golden("privacy: a raw login (never sent since the cfh: form) is quarantined without it");
  assert.equal(g.input.login, "zoë");
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM hub_outbox"))[0].n;
  await runQuery("INSERT INTO users (userId, username, password, camfrogUsername) VALUES ('zoe', 'zoe', 'x', 'zoë')");
  await assert.rejects(I.request("zoe", true), (e) => e.code === "unlinked");
  assert.deepEqual(await I.sync({ items: [{ login: "zoë", on: true, ts: T0, via: "chat" }] }), { applied: 0, ignored: 1 });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox"))[0].n, n0);
});

test("erasure: account deleted, \"Make Pepe forget me\"", async () => {
  D._setClock(() => T0);
  await runQuery(`INSERT INTO account_deletions (id, user_id, state, requested_at, execute_at, requested_by) VALUES (17, '1004', 'scheduled', ?, ?, 'self')`, [T0 - 1, T0 - 1]);
  const r = await D.execute("1004", { force: true });
  assert.equal(r.state, "done");
  const got = await lastRow("privacy/account-deleted");
  const g = golden("erasure: account deleted").row;
  assert.match(got.payload.pseudonym, /^deleted-[0-9a-f]{10}$/);
  assert.deepEqual({ ...got, payload: { ...got.payload, pseudonym: "*" } }, { topic: g.topic, entity: g.entity, payload: { ...g.payload, pseudonym: "*" } });
  assert.ok(!("login_h" in got.payload), "1.99acm: never a login hash on a deletion");
  PF._setClock(() => T0);
  await runQuery("INSERT INTO pepe_forget_log (id, user_id, login, at, via, dms) VALUES (41, NULL, 'x', 1, 'chat', 0)");
  await runQuery("DELETE FROM pepe_forget_log WHERE id = 41");
  const f = await PF.request("1001");
  assert.equal(f.ref, 42);
  same("erasure: \"Make Pepe forget me\" (scope bot)", await lastRow("privacy/forget"));
});

test("snapshot pages: the golden shapes and payloads", async () => {
  HO._setClock(() => T1);
  await runQuery("INSERT INTO account_merge_log (at, via, from_id, to_id) VALUES (?, 'golden', '1003', '1001')", [T1]);
  await runQuery("UPDATE pepe_actions SET created = ? WHERE kind = 'privacy.incognito' AND user_id = '1001'", [T0]);
  for (const [topic, gp] of Object.entries(G.snapshots)) {
    const limit = gp.complete ? 500 : gp.rows.length;
    const p = await HO.snapshot(topic, null, { limit });
    assert.deepEqual(Object.keys(p).sort(), Object.keys(gp).sort(), topic + ": page keys");
    assert.equal(p.v, 1);
    assert.equal(p.topic, topic);
    assert.ok(Number.isInteger(p.head) && p.head > 0);
    const mine = Object.fromEntries(swap(p.rows).map((r) => [r.entity, r.payload]));
    for (const row of gp.rows) {
      assert.ok(mine[row.entity], `${topic}: ${row.entity} listed`);
      const strip = (x) => (topic === "privacy/account-deleted" ? { ...x, pseudonym: "*" } : x);
      assert.deepEqual(strip(mine[row.entity]), strip(row.payload), `${topic}: ${row.entity}`);
    }
    if (!gp.complete) {
      assert.deepEqual(swap(p.rows.map((r) => r.entity)), gp.rows.map((r) => r.entity), topic + ": the first page");
      assert.deepEqual(p.range, gp.range);
      assert.equal(p.next, gp.next, topic + ": the cursor");
      assert.equal(p.complete, false);
    }
  }
});

test("the heartbeat: the golden body's shape, switches and topic stats", async () => {
  HO._setClock(() => T1);
  await HO.setSettings({ erasure: false });
  const b = await HO.heartbeatBody();
  const g = G.heartbeat;
  assert.deepEqual(Object.keys(b).sort(), Object.keys(g).sort());
  assert.equal(b.env, g.env);
  assert.equal(b.at, g.at);
  // the version is informational: the golden (byte-pinned in both repos) keeps the release that recorded it, the live body names this one
  assert.match(String(b.version), /^\d+\.\d+[a-z]+$/, "the heartbeat names a site version");
  assert.match(String(g.version), /^\d+\.\d+[a-z]+$/, "the golden heartbeat names a site version");
  // 1.99ads: S1 adds switches (seam plan §12.10, additive): S0's keep the golden's values, the S1 ones are off here
  for (const k of Object.keys(g.switches)) assert.equal(b.switches[k], g.switches[k], k);
  for (const k of Object.keys(b.switches)) if (!(k in g.switches)) assert.ok(["identity", "looks"].includes(k) && b.switches[k] === false, k);
  for (const t of Object.keys(g.topics)) assert.deepEqual(Object.keys(b.topics[t]).sort(), Object.keys(g.topics[t]).sort(), t);
  assert.ok(Array.isArray(b.jwks_kids));
  assert.equal(b.outbox_head, await HO.headId());
});
