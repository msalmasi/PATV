// 1.99?? Pepe account rotation: pepelogins.js - the site's ONE list of Pepe's Camfrog logins (deny-only), and the places that
// read it instead of a hard-coded {pepefrog, pepebeta}: the stale-account sweep (+ his house room ids), the pad streaks, the
// policy digest, the AI-judge words.
//   TZ=UTC NODE_PATH=G:/PATV/node_modules node --test test/pepelogins.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepelogins-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STAGE_DEFAULT_ROOM;
process.env.PEPE_LOGINS = "EnvPepe, bad login!";
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const PL = require(path.join(repo, "pepelogins"));

const one = async (sql, p = []) => (await getQuery(sql, p))[0] || null;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, class TEXT DEFAULT 'pleb', email TEXT,
    isEmailVerified INTEGER DEFAULT 0, discordId TEXT, twitchId TEXT, camfrogUsername TEXT, points_balance INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, displayname TEXT, created_at TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS bonus_winners (bonusId TEXT, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER, timestamp DATETIME)");
  await runQuery("CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT, userId TEXT, type TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS wallet_snapshots (key TEXT PRIMARY KEY, data TEXT, updated INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS camfrog_userstats (login TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS rooms_kv (key TEXT PRIMARY KEY, value TEXT)");
});

test("the list: built-in + env + the rotation's record + the login Pepe was seen acting as; has() / sqlIn()", async () => {
  await PL.refresh();
  assert.deepEqual([...PL.list()].sort(), ["envpepe", "pepebeta", "pepefrog"], "a bad env entry is dropped");
  assert.ok(PL.has("PepeFrog") && PL.has(" pepebeta ") && !PL.has("pepe_frog") && !PL.has("") && !PL.has(null));
  // the learned login (escrow / oracle meta) counts
  await runQuery("CREATE TABLE IF NOT EXISTS escrow_meta (key TEXT PRIMARY KEY, value TEXT)");
  await runQuery("INSERT INTO escrow_meta (key, value) VALUES ('pepe_login', ?)", [JSON.stringify("Pepe_Learned")]);
  await PL.refresh();
  assert.ok(PL.has("pepe_learned"));
  // the rotation's record
  const rec = await PL.save({ current: "Pepe_Frog", former: ["PepeFrog"] });
  assert.deepEqual(rec, { current: "pepe_frog", former: ["pepefrog"] });
  await PL.refresh();
  assert.equal(PL.current(), "pepe_frog");
  assert.ok(PL.has("PEPE_FROG"));
  const q = PL.sqlIn(["pepe", "pepebot"]);
  assert.equal(q.sql, "(" + q.params.map(() => "?").join(", ") + ")");
  assert.ok(["pepefrog", "pepebeta", "pepe_frog", "pepe", "pepebot", "envpepe"].every((x) => q.params.includes(x)));
  assert.equal((await one(`SELECT COUNT(*) AS n FROM (SELECT 'pepe_frog' AS l UNION SELECT 'alice') WHERE l NOT IN ${q.sql}`, q.params)).n, 1);
});

test("deny-only: a record is a union - the old current joins former, nothing drops off; garbage is cleaned", async () => {
  assert.deepEqual(PL.merge({ current: "a", former: ["b"] }, { current: "c", former: ["d"] }), { current: "c", former: ["b", "a", "d"] });
  assert.deepEqual(PL.merge(null, { current: "x" }), { current: "x", former: [] });
  assert.deepEqual(PL.merge({ current: "x", former: ["x", "y"] }, { current: "x" }), { current: "x", former: ["y"] }, "the current one isn't former too");
  assert.deepEqual(PL.parseRecord('{"current":"Bad Login!","former":["ok_one",7,"<b>"]}'), { current: null, former: ["ok_one", "7"], at: null });
  assert.deepEqual(PL.parseRecord("not json"), { current: null, former: [], at: null });
  // a write inside a transaction that rolls back leaves the record as it was
  const before = await one("SELECT value FROM rooms_kv WHERE key = 'pepe_logins'");
  await assert.rejects(tx(async () => { await PL.save({ current: "Somebody_Else" }); throw new Error("rollback (test)"); }), /rollback/);
  assert.deepEqual(await one("SELECT value FROM rooms_kv WHERE key = 'pepe_logins'"), before);
});

test("the owner sync's identity: recorded only when it adds a login", async () => {
  assert.equal(await PL.noteIdentity(null), false);
  assert.equal(await PL.noteIdentity({ login: "Pepe_Frog", former_logins: ["PepeFrog"] }), false, "nothing new");
  assert.equal(await PL.noteIdentity({ login: "Pepe_Frog", former_logins: ["PepeFrog", "Retired_Pepe"] }), true);
  assert.deepEqual(PL.record(), { current: "pepe_frog", former: ["pepefrog", "retired_pepe"] });
  assert.equal(await PL.noteIdentity({ login: "Pepe_Next" }), true, "a new current login: the old one stays on the list");
  assert.deepEqual(PL.record(), { current: "pepe_next", former: ["pepefrog", "retired_pepe", "pepe_frog"] });
  assert.ok(PL.has("pepe_frog") && PL.has("pepe_next"));
});

test("readers: the stale-account sweep (logins + house room ids), the policy digest, the pad streaks, the AI judge words", async () => {
  const stale = require(path.join(repo, "staleaccounts"));
  const ts = new Date(Date.now() - 400 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  for (const [id, cf] of [["cf_new", "pepe_frog"], ["cf_room", "the_swamp"], ["cf_someone", "someone_else"]]) {
    await runQuery("INSERT INTO users (userId, username, camfrogUsername, created_at) VALUES (?, ?, ?, ?)", [id, "CF" + id, cf, ts]);
  }
  await runQuery("INSERT INTO rooms_kv (key, value) VALUES ('house_room', ?)", [JSON.stringify({ id: "The_Swamp", title: "The Swamp", slug: "the-swamp", prev: [{ id: "PepeFrog.Room" }] })]);
  assert.ok((await stale.holdsFor("cf_new")).includes("Pepe's own login"), "Pepe's new login is never swept");
  assert.ok((await stale.holdsFor("cf_room")).includes("Pepe's own login"), "nor an account named after his house room");
  assert.ok(!(await stale.holdsFor("cf_someone")).includes("Pepe's own login"));
  // the digest: a notice to any of his logins counts as sent - the same set as the bot's _pepe_accounts()
  const D = require(path.join(repo, "policy", "digest"));
  assert.ok(D.PEPE_LOGINS.has("pepe_frog") && D.PEPE_LOGINS.has("pepefrog") && D.PEPE_LOGINS.has("pepebeta"));
  // the pad streaks: Pepe's rows never make a pad day or a regular
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL, lines INTEGER, mic_min REAL, cmds INTEGER,
                  active_min INTEGER, updated INTEGER, PRIMARY KEY (room_id, day, login))`);
  const PS = require(path.join(repo, "padstreaks"));
  await PS.ready;
  const day = new Date().toISOString().slice(0, 10);
  const rows = ["pepe_frog", "pepe_next", "pepefrog"].map((login) => ({ room: "The_Swamp", day, login, lines: 50, mic_min: 0 }));
  for (const r of rows) await runQuery("INSERT INTO econ_participation (room_id, day, login, lines, mic_min) VALUES (?, ?, ?, 50, 0)", [r.room, r.day, r.login]);
  await PS.fromParticipation(rows, { live: false }).catch((e) => console.log("fromParticipation:", e.message));
  const pd = await one("SELECT users FROM pad_days WHERE room_id = 'The_Swamp'").catch(() => null);
  assert.ok(!pd || Number(pd.users) === 0, "Pepe's own logins never count as people: " + JSON.stringify(pd));
  // escrow: "judge: Pepe_Frog" is the AI judge, like "judge: pepe"
  const src = fs.readFileSync(path.join(repo, "escrow", "pools.js"), "utf8") + fs.readFileSync(path.join(repo, "escrow", "wagers.js"), "utf8");
  assert.equal((src.match(/isAiWord\(low\(jword\)\)/g) || []).length, 2, "both judge parsers read the list");
});

// review S5: an admin's way to take a typo off the recorded list (tools/house-rotate.js --forget-login); never a built-in or the current login
test("forget(): a former login comes off the record; built-ins and the current login can't", async () => {
  await tx(() => PL.save({ current: "pepe_frog", former: ["pepe_frogg"] }));
  await PL.refresh();
  assert.ok(PL.has("pepe_frogg"));
  await assert.rejects(PL.forget("pepefrog"), /built in/);
  await assert.rejects(PL.forget("pepe_frog"), /current login/);
  await assert.rejects(PL.forget("not a login"), /not a Camfrog login/);
  const r = await tx(() => PL.forget("Pepe_Frogg"));
  assert.equal(r.removed, true);
  await PL.refresh();
  assert.ok(!PL.has("pepe_frogg") && PL.has("pepe_frog") && PL.has("pepefrog"));
  assert.equal((await tx(() => PL.forget("pepe_frogg"))).removed, false, "again: nothing to remove");
});
