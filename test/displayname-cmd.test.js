// Offline tests for Pepe's !displayname (1.99bc): the shared validation (profile page + chat), the
// bot route's get / set / reset for the account linked to a Camfrog login, the auto flag, the
// one-change-an-hour limit (admins exempt), the audit log and an unlinked Camfrog name.
//   node --test test/displayname-cmd.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dncmd-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const dn = require(path.join(repo, "displaynames"));

const one = async (username) => (await getQuery("SELECT displayname, displayname_auto FROM users WHERE username = ?", [username]))[0];
const logOf = async (userId) => getQuery("SELECT old_name, new_name, auto, via, actor, by_admin FROM displayname_log WHERE userId = ? ORDER BY id", [userId]);
const HOUR = dn.RATE_LIMIT_MS;
const T0 = 1_800_000_000_000;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  email TEXT, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  const rows = [
    // userId, username, displayname, camfrog, discord
    ["c1", "CFabc12345", "partysan", "partysan", null],   // Pepe's auto account
    ["w1", "webby", "webby", "webby_cf", "WebbyDiscord"],  // web account linked to Camfrog
    ["x1", "CFold99999", "old", "dupe_cf", null],          // leftover CF account ...
    ["x2", "realdupe", "Real Dupe", "dupe_cf", null],      // ... and the real one, same login
  ];
  for (const r of rows) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, discordUsername) VALUES (?, ?, ?, 'x', ?, ?)",
      [r[0], r[1], r[2], r[3], r[4]]);
  }
  await dn.ready();
});

test("validate: markup stripped, empty / too long / random-CF refused with a reason", () => {
  assert.deepEqual(dn.validate("  <b>Plant</b>   Baked "), { ok: true, name: "Plant Baked" });
  assert.equal(dn.validate("").ok, false);
  assert.match(dn.validate("").error, /empty/);
  assert.match(dn.validate("<b></b>​").error, /nothing is left/);
  assert.match(dn.validate("x".repeat(dn.MAX_LEN + 1)).error, /too long/);
  assert.equal(dn.validate("x".repeat(dn.MAX_LEN)).ok, true);
  // a long name inside markup counts only its visible characters
  assert.equal(dn.validate("<font color=#ff0000>" + "y".repeat(dn.MAX_LEN) + "</font>").ok, true);
  // the profile page cuts instead of refusing
  assert.equal(Array.from(dn.validate("z".repeat(50), { truncate: true }).name).length, dn.MAX_LEN);
  assert.match(dn.validate("CFqwe12345").error, /automatic CF/);
  assert.equal(dn.validate("CFredSmith").ok, true);
  assert.deepEqual(dn.validate("🐸 Froggy 🐸"), { ok: true, name: "🐸 Froggy 🐸" });
});

test("get shows the current name and whether it's automatic", async () => {
  const r = await dn.camfrogChange({ login: "PartySan", action: "get" });
  assert.equal(r.status, 200);
  assert.equal(r.body.displayname, "partysan");
  assert.equal(r.body.auto, true);
  assert.equal(r.body.username, "CFabc12345");
});

test("an unlinked Camfrog name gets a 404 with a reason", async () => {
  for (const action of ["get", "set", "reset"]) {
    const r = await dn.camfrogChange({ login: "nobody_here", action, name: "Hi" });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /no publicaccess.tv account/);
  }
  assert.equal((await dn.camfrogChange({ login: "", action: "get" })).status, 404);
});

test("set: user-set (auto 0), logged, survives the Camfrog sync", async () => {
  const r = await dn.camfrogChange({ login: "partysan", action: "set", name: "<i>Party</i> San", actor: "partysan", now: T0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.displayname, "Party San");
  assert.equal(r.body.old, "partysan");
  assert.deepEqual(await one("CFabc12345"), { displayname: "Party San", displayname_auto: 0 });
  await dn.applyCamfrogNames([{ login: "partysan", display: "Something Else" }]);
  assert.equal((await one("CFabc12345")).displayname, "Party San", "the sync never overwrites it");
  assert.deepEqual(await logOf("c1"), [{ old_name: "partysan", new_name: "Party San", auto: 0, via: "camfrog", actor: "partysan", by_admin: 0 }]);
});

test("invalid names are refused without using up the hourly change", async () => {
  const r = await dn.camfrogChange({ login: "webby_cf", action: "set", name: "w".repeat(40), now: T0 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /too long/);
  assert.equal((await logOf("w1")).length, 0);
  assert.equal((await one("webby")).displayname, "webby");
});

test("rate limit: one self-change an hour; the same name again is a no-op", async () => {
  const same = await dn.camfrogChange({ login: "partysan", action: "set", name: "Party San", now: T0 + 60_000 });
  assert.equal(same.status, 200);
  assert.equal(same.body.unchanged, true);
  const r = await dn.camfrogChange({ login: "partysan", action: "set", name: "Again", now: T0 + 10 * 60_000 });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /once an hour - try again in 50 min/);
  assert.equal((await one("CFabc12345")).displayname, "Party San");
  const later = await dn.camfrogChange({ login: "partysan", action: "set", name: "Again", now: T0 + HOUR + 1 });
  assert.equal(later.status, 200);
  assert.equal((await one("CFabc12345")).displayname, "Again");
});

test("admins aren't limited and don't use up the user's change", async () => {
  const t = T0 + HOUR + 5_000;
  const a = await dn.camfrogChange({ login: "partysan", action: "set", name: "Admin Pick", actor: "plantbaked", admin: true, now: t });
  assert.equal(a.status, 200);
  const log = await logOf("c1");
  assert.deepEqual(log[log.length - 1], { old_name: "Again", new_name: "Admin Pick", auto: 0, via: "camfrog", actor: "plantbaked", by_admin: 1 });
  // the user's own last change was at T0 + HOUR + 1, so they're still limited until an hour after that
  assert.equal((await dn.camfrogChange({ login: "partysan", action: "set", name: "Mine", now: t + 1000 })).status, 429);
});

test("reset: back to the automatic name (Camfrog display name first), auto = 1", async () => {
  const r = await dn.camfrogChange({ login: "partysan", action: "reset", camfrogDisplay: "<b>Party Sanchez</b>", now: T0 + 3 * HOUR });
  assert.equal(r.status, 200);
  assert.equal(r.body.auto, true);
  assert.deepEqual(await one("CFabc12345"), { displayname: "Party Sanchez", displayname_auto: 1 });
  // automatic again: the sync may refresh it
  await dn.applyCamfrogNames([{ login: "partysan", display: "Party Time" }]);
  assert.equal((await one("CFabc12345")).displayname, "Party Time");
  // without a Camfrog display name: Discord > ... > Camfrog login
  await dn.camfrogChange({ login: "webby_cf", action: "set", name: "Web Guy", now: T0 });
  const w = await dn.camfrogChange({ login: "webby_cf", action: "reset", now: T0 + 2 * HOUR });
  assert.equal(w.body.displayname, "WebbyDiscord");
  // resetting an already-automatic name is a no-op
  const again = await dn.camfrogChange({ login: "webby_cf", action: "reset", now: T0 + 2 * HOUR + 1 });
  assert.equal(again.body.unchanged, true);
});

test("a login linked to two accounts resolves to the real one, not the leftover CF account", async () => {
  const r = await dn.camfrogChange({ login: "dupe_cf", action: "get" });
  assert.equal(r.body.username, "realdupe");
});

test("profile page: shared rules, logged, counts toward the hourly limit", async () => {
  const bad = await dn.setByUser("x2", "CFzzz00000");
  assert.match(bad.error, /automatic CF/);
  assert.equal((await one("realdupe")).displayname, "Real Dupe");
  const before = Date.now();
  const ok = await dn.setByUser("x2", "Real Deal");
  assert.deepEqual(ok, { displayname: "Real Deal", auto: false });
  const log = await logOf("x2");
  assert.equal(log[log.length - 1].via, "web");
  const r = await dn.camfrogChange({ login: "dupe_cf", action: "set", name: "Chat Name", now: before + 1000 });
  assert.equal(r.status, 429);
});

test("unknown action is refused", async () => {
  assert.equal((await dn.camfrogChange({ login: "partysan", action: "nuke" })).status, 400);
});
