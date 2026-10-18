// 1.99acf incognito.js -> the chat hub's privacy cache (huboutbox.js topic privacy/changed, switch hubseam.privacy; the chat
// design §9.2): a web request writes ONE "requested" row in the same transaction as Pepe's action (a busy refusal writes
// none, the action and the row roll back together); Pepe's report writes "confirmed" rows for linked logins, unlinked logins
// and account keys (u:<id>); deduped; nothing while the switch is off; never any line text.
//   node --test test/incognito-hubseam.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "incog-hub-test-")));
delete process.env.STAGING;
delete process.env.HUB_V1_URL;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const I = require(path.join(repo, "incognito"));
const HO = require(path.join(repo, "huboutbox"));
const HH = require(path.join(repo, "hubhidden"));
const cf = (l) => "cfh:" + HH.loginHash(l);                 // 1.99acm: a chat login leaves v1 only as its hash (seam plan D-6)

const outbox = () => getQuery("SELECT topic, entity, payload, dedupe_key FROM hub_outbox WHERE topic = 'privacy/changed' ORDER BY id");
const payloads = async () => (await outbox()).map((r) => ({ ...JSON.parse(r.payload), entity: r.entity, dedupe: r.dedupe_key }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived_at INTEGER)`);
  require(path.join(repo, "actions"));
  require(path.join(repo, "inbox"));
  await I.init();
  await HO.init();
  for (const [id, cf] of [["u-alice", "AliceCF"], ["u-bob", "bobcf"], ["u-nolink-1234", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, id, id, cf]);
  }
  await new Promise((r) => setTimeout(r, 100));          // actions.js / inbox.js create their tables on load
});

test("switch off: a request and a report write nothing for the hub", async () => {
  await I.request("u-alice", true);
  await I.sync({ items: [{ login: "alicecf", on: true, via: "web", ts: Date.now() }] });
  assert.equal((await outbox()).length, 0);
});

test("a web request: one 'requested' row in the action's transaction (ON and OFF), the subject ids only", async () => {
  await HO.setSettings({ privacy: true });
  await runQuery("DELETE FROM pepe_actions");
  const { id } = await I.request("u-alice", true, { ip: "203.0.113.9" });
  const p = await payloads();
  assert.equal(p.length, 1);
  assert.deepEqual({ ...p[0], at: 0 }, { flag: "incognito", value: true, phase: "requested", via: "web", at: 0,
                                         subject: { platform: "camfrog", login_h: HH.loginHash("alicecf"), acct: null, v1_user: "u-alice" }, entity: cf("alicecf"), dedupe: "incog-req:" + id },
                   "a legacy id without CHAT_GENESIS_NS: no hub account id (acct null), the raw id as v1_user");
  assert.ok(!JSON.stringify(p).includes("203.0.113.9"), "no address");
  assert.ok(!/alicecf/i.test(JSON.stringify(p.map((x) => ({ ...x, dedupe: null })))), "no login in what the hub gets");
  const { id: id2 } = await I.request("u-alice", false);
  const q = await payloads();
  assert.equal(q.length, 2);
  assert.equal(q[1].value, false);
  assert.equal(q[1].dedupe, "incog-req:" + id2);
  // an account with no chat login -> its account key u:<id>
  require(path.join(repo, "actorcap")).note({ relay_cap: 1 });     // a Pepe that honours account keys
  await I.request("u-nolink-1234", true);
  const r = (await payloads()).pop();
  assert.deepEqual(r.subject, { acct: null, v1_user: "u-nolink-1234" });
  assert.equal(r.entity, "acct:u-nolink-1234");
});

test("a busy refusal writes nothing (no action, no hub row)", async () => {
  await runQuery("DELETE FROM pepe_actions"); await runQuery("DELETE FROM hub_outbox");
  for (let i = 0; i < 6; i++) {
    await runQuery("INSERT INTO pepe_actions (user_id, username, kind, args, status, created, updated) VALUES ('u-bob', 'u-bob', 'cmd', '[]', 'pending', ?, ?)", [Date.now(), Date.now()]);
  }
  await assert.rejects(I.request("u-bob", true), (e) => e.code === "busy");
  assert.equal((await outbox()).length, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE user_id = 'u-bob' AND kind = 'privacy.incognito'"))[0].n, 0);
});

test("Pepe's report: 'confirmed' rows for linked logins, unlinked logins and account keys; deduped; older reports skipped", async () => {
  await runQuery("DELETE FROM hub_outbox");
  const ts = Date.now();
  await I.sync({ items: [{ login: "AliceCF", on: true, via: "web", ts }, { login: "stranger", on: true, via: "chat", ts },
                         { login: "u:u-nolink-1234", on: false, via: "chat", ts }] });
  let p = await payloads();
  assert.deepEqual(p.map((x) => [x.entity, x.phase, x.value, x.via, x.at]), [
    [cf("alicecf"), "confirmed", true, "web", ts], [cf("stranger"), "confirmed", true, "chat", ts], ["acct:u-nolink-1234", "confirmed", false, "chat", ts]]);
  assert.deepEqual(p[0].subject, { platform: "camfrog", login_h: HH.loginHash("alicecf"), acct: null, v1_user: "u-alice" }, "a linked login carries its account");
  assert.deepEqual(p[1].subject, { platform: "camfrog", login_h: HH.loginHash("stranger") }, "an unlinked login is covered too");
  assert.deepEqual(p[2].subject, { acct: null, v1_user: "u-nolink-1234" });
  assert.equal(p[0].dedupe, `incog:alicecf:${ts}`);
  // the same report again -> nothing new; an older report for a stored login -> nothing
  await I.sync({ items: [{ login: "alicecf", on: true, via: "web", ts }, { login: "alicecf", on: false, via: "chat", ts: ts - 5000 }] });
  p = await payloads();
  assert.equal(p.length, 3);
  assert.equal((await getQuery(`SELECT "on" AS v FROM incognito_state WHERE login = 'alicecf'`))[0].v, 1, "the stored state is unchanged");
});

test("the subject's acct is the hub's account_id - the ticket's sub (a legacy id -> its UUIDv5 once CHAT_GENESIS_NS is set)", async () => {
  const CT = require(path.join(repo, "chatticket"));
  const NS = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
  process.env.CHAT_GENESIS_NS = NS;
  try {
    await runQuery("DELETE FROM hub_outbox");
    const ts = Date.now() + 1000;
    await I.sync({ items: [{ login: "alicecf", on: false, via: "chat", ts }, { login: "u:u-nolink-1234", on: true, via: "chat", ts }] });
    const p = await payloads();
    const want = require("uuid").v5("u-alice", NS);
    assert.equal(p[0].subject.acct, want, "uuidv5(users.userId, the genesis namespace)");
    assert.equal(p[0].subject.acct, CT.subjectOf("u-alice"), "...exactly the ticket's sub");
    assert.equal(p[0].subject.v1_user, "u-alice");
    assert.equal(p[1].subject.acct, CT.subjectOf("u-nolink-1234"));
    assert.equal(HO.accountOf("0F9E3C1A-1B2C-4D5E-8F90-A1B2C3D4E5F6"), "0f9e3c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6", "a UUID userId is its own account_id");
  } finally { delete process.env.CHAT_GENESIS_NS; }
});

test("1.99acm: Pepe's full list writes a 'confirmed' row for every key it turns ON or OFF, in one transaction with the heal", async () => {
  await HO.setSettings({ privacy: true });
  await runQuery("DELETE FROM hub_outbox");
  // state now: alicecf OFF (last report), stranger ON (anon), u:u-nolink-1234 ON. A list without stranger, with bobcf and newbie:
  const before = new Set((await getQuery("SELECT login FROM incognito_anon")).map((r) => r.login));
  assert.ok(before.has("stranger"));
  await I.sync({ items: [], full: ["BobCF", "newbie", "u:u-nolink-1234"] });
  const p = await payloads();
  const by = Object.fromEntries(p.map((x) => [x.entity, x]));
  assert.equal(by[cf("bobcf")].value, true, "a login ON only because the full list says so reaches the hub at once");
  assert.equal(by[cf("bobcf")].phase, "confirmed");
  assert.deepEqual(by[cf("bobcf")].subject, { platform: "camfrog", login_h: HH.loginHash("bobcf"), acct: null, v1_user: "u-bob" });
  assert.equal(by[cf("newbie")].value, true, "an unlinked one too");
  assert.deepEqual(by[cf("newbie")].subject, { platform: "camfrog", login_h: HH.loginHash("newbie") });
  assert.equal(by[cf("stranger")].value, false, "a login the list drops is turned OFF");
  assert.equal(by["acct:u-nolink-1234"], undefined, "an unchanged key writes nothing");
  assert.equal(p.length, 3);
  assert.equal((await getQuery(`SELECT "on" AS v FROM incognito_state WHERE login = 'bobcf'`))[0].v, 1, "the heal itself still happens");
  // the same list again: nothing changes, nothing is written
  await I.sync({ items: [], full: ["bobcf", "newbie", "u:u-nolink-1234"] });
  assert.equal((await payloads()).length, 3);
  // switch off: the heal runs, the hub gets nothing
  await HO.setSettings({ privacy: false });
  await I.sync({ items: [], full: [] });
  assert.equal((await payloads()).length, 3);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM incognito_anon"))[0].n, 0);
});
