// Offline tests for display names (displaynames.js, 1.99az): cleaning, the source order for automatic
// names, which existing names count as automatic, the backfill's selection, Pepe's Camfrog-name sync
// never touching a user-chosen name, and a user's own name / reset.
//   node --test test/displaynames.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const dn = require(path.join(repo, "displaynames"));

const one = async (username) => (await getQuery("SELECT displayname, displayname_auto FROM users WHERE username = ?", [username]))[0];

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  email TEXT, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  const rows = [
    // userId, username, displayname, camfrog, discord, twitch
    ["a1", "CFabc12345", null, "partysan", null, null],          // Pepe's account, no name
    ["a2", "CFdef67890", "", "mr_x", null, null],                 // empty name
    ["a3", "CFghi11111", "CFghi11111", "tricon", null, null],     // the random name
    ["a4", "CFjkl22222", "joe514", "joe514", null, null],         // camfrog login (automatic)
    ["w1", "webby", "webby", null, null, null],                   // web sign-up (automatic)
    ["w2", "chooser", "The Real Chooser", "chooser_cf", null, null],  // typed by the user
    ["d1", "discy", null, null, "DiscyOnDiscord", null],          // discord, no name
    ["t1", "twitchy", "", null, null, "TwitchyTV"],               // twitch, no name
    ["g1", "CFytt6zfhr", "CFf70z6znh", "cff70z6znh", null, null], // ghost: nothing better known
    ["u1", "CFredSmith", "CFredSmith", null, null, null],         // a person's own name that looks CF-ish
  ];
  for (const r of rows) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, discordUsername, twitchDisplayname) VALUES (?, ?, ?, 'x', ?, ?, ?)",
      [r[0], r[1], r[2], r[3], r[4], r[5]]);
  }
  await dn.ready();
});

test("clean strips markup, control characters and caps the length", () => {
  assert.equal(dn.clean("<font color=red>Plant</font> <b>Baked</b>"), "Plant Baked");
  assert.equal(dn.clean("  a\u0000b​c\n  d "), "abc d");
  assert.equal(Array.from(dn.clean("x".repeat(50))).length, dn.MAX_LEN);
  assert.equal(dn.clean(null), "");
});

test("random CF names: strict for display names, loose for logins", () => {
  assert.ok(dn.isCfRandom("CFf70z6znh"));
  assert.ok(!dn.isCfRandom("CFredSmith"));
  assert.ok(!dn.isCfRandom("cff70z6znh"));
  assert.ok(dn.isCfRandom("cff70z6znh", true));
  assert.ok(!dn.isCfRandom("partysan", true));
});

test("pickAuto order: Camfrog display > Discord > Twitch > Camfrog login > username", () => {
  const all = { camfrogDisplay: "<b>Plant</b>", discordName: "D", twitchName: "T", camfrogUsername: "foamy", username: "CFabc12345" };
  assert.deepEqual(dn.pickAuto(all), { name: "Plant", source: "camfrog_display" });
  assert.equal(dn.pickAuto(Object.assign({}, all, { camfrogDisplay: "" })).source, "discord");
  assert.equal(dn.pickAuto({ twitchName: "T", camfrogUsername: "foamy", username: "x" }).source, "twitch");
  assert.deepEqual(dn.pickAuto({ camfrogUsername: "foamy", username: "CFabc12345" }), { name: "foamy", source: "camfrog_login" });
  assert.deepEqual(dn.pickAuto({ camfrogUsername: "cfabc12345", username: "bob" }), { name: "bob", source: "username" });
  // never the random CF name when a login is known
  assert.equal(dn.pickAuto({ camfrogDisplay: "CFzzz99999", camfrogUsername: "sam310", username: "CFabc12345" }).name, "sam310");
});

test("ready() marks existing automatic names; a typed name stays user-set", async () => {
  assert.equal((await one("webby")).displayname_auto, 1);
  assert.equal((await one("CFjkl22222")).displayname_auto, 1);
  assert.equal((await one("CFabc12345")).displayname_auto, 1);
  assert.equal((await one("chooser")).displayname_auto, 0);
  // runs once: a later ready() doesn't re-mark
  await runQuery("UPDATE users SET displayname_auto = 0 WHERE username = 'webby'");
  await dn.ready();
  assert.equal((await one("webby")).displayname_auto, 0);
  await runQuery("UPDATE users SET displayname_auto = 1 WHERE username = 'webby'");
});

test("backfill dry run selects only missing / random names, by source", async () => {
  const { changes, bySource, unresolved } = await dn.backfill({ dryRun: true });
  const by = Object.fromEntries(changes.map((c) => [c.username, c]));
  assert.equal(by.CFabc12345.after, "partysan");
  assert.equal(by.CFdef67890.after, "mr_x");
  assert.equal(by.CFghi11111.after, "tricon");
  assert.equal(by.discy.after, "DiscyOnDiscord");
  assert.equal(by.twitchy.after, "TwitchyTV");
  assert.ok(!by.CFjkl22222 && !by.webby && !by.chooser && !by.CFredSmith, "fine names are left alone");
  assert.ok(!by.CFytt6zfhr);
  assert.deepEqual(unresolved, ["CFytt6zfhr"]);
  assert.deepEqual(bySource, { camfrog_login: 3, discord: 1, twitch: 1 });
  assert.equal((await one("CFabc12345")).displayname, null, "dry run writes nothing");
});

test("backfill with Camfrog names upgrades automatic names only", async () => {
  const { changes } = await dn.backfill({ dryRun: true, camfrogNames: { joe514: "Joe", chooser_cf: "Nope", partysan: "Party San" } });
  const by = Object.fromEntries(changes.map((c) => [c.username, c]));
  assert.equal(by.CFjkl22222.after, "Joe");
  assert.equal(by.CFjkl22222.source, "camfrog_display");
  assert.equal(by.CFabc12345.after, "Party San");
  assert.ok(!by.chooser, "a user-set name is never replaced");
});

test("backfill --apply writes in one go and is idempotent", async () => {
  const r = await dn.backfill({ dryRun: false });
  assert.equal(r.changes.length, 5);
  assert.deepEqual(await one("CFabc12345"), { displayname: "partysan", displayname_auto: 1 });
  assert.deepEqual(await one("discy"), { displayname: "DiscyOnDiscord", displayname_auto: 1 });
  assert.equal((await dn.backfill({ dryRun: false })).changes.length, 0);
});

test("Pepe's Camfrog names refresh automatic names, never user-set ones", async () => {
  const r = await dn.applyCamfrogNames([
    { login: "joe514", display: "<b>Joey</b>" },
    { login: "chooser_cf", display: "Overwrite Me" },
    { login: "tricon", display: "tricon" },        // same as the login: not an upgrade of a fine name
    { login: "", display: "x" },
  ]);
  assert.equal(r.updated, 1);
  assert.equal((await one("CFjkl22222")).displayname, "Joey");
  assert.equal((await one("chooser")).displayname, "The Real Chooser");
  assert.equal((await one("CFghi11111")).displayname, "tricon");
});

test("a login-only push fills a random CF name but leaves a linked web name alone", async () => {
  await runQuery("INSERT INTO users (userId, username, displayname, displayname_auto, password, camfrogUsername) VALUES ('w3', 'pb', 'pb', 1, 'x', 'foamy1111')");
  await runQuery("INSERT INTO users (userId, username, displayname, displayname_auto, password, camfrogUsername) VALUES ('a5', 'CFmno33333', 'CFmno33333', 1, 'x', 'drama1')");
  await dn.applyCamfrogNames([{ login: "foamy1111", display: "foamy1111" }, { login: "drama1", display: "drama1" }]);
  assert.equal((await one("pb")).displayname, "pb");
  assert.equal((await one("CFmno33333")).displayname, "drama1");
  await dn.applyCamfrogNames([{ login: "foamy1111", display: "plantbaked" }]);
  assert.equal((await one("pb")).displayname, "plantbaked");
});

test("setByUser: a typed name is protected; an empty one resets to automatic", async () => {
  await dn.setByUser("a4", "  <i>My Name</i> ");
  assert.deepEqual(await one("CFjkl22222"), { displayname: "My Name", displayname_auto: 0 });
  await dn.applyCamfrogNames([{ login: "joe514", display: "Joe Again" }]);
  assert.equal((await one("CFjkl22222")).displayname, "My Name");
  const r = await dn.setByUser("a4", "   ");
  assert.deepEqual(r, { displayname: "joe514", auto: true });
  assert.deepEqual(await one("CFjkl22222"), { displayname: "joe514", displayname_auto: 1 });
});

test("markNewAccount: new accounts get an automatic name, never empty or random", async () => {
  await runQuery("INSERT INTO users (userId, username, displayname, password) VALUES ('n1', 'newbie', 'newbie', 'x')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('n2', 'CFpqr44444', NULL, 'x', 'cool_cat')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('n3', 'CFstu55555', 'Cool <b>Dog</b>', 'x', 'cool_dog')");
  for (const id of ["n1", "n2", "n3"]) await dn.markNewAccount(id);
  assert.deepEqual(await one("newbie"), { displayname: "newbie", displayname_auto: 1 });
  assert.deepEqual(await one("CFpqr44444"), { displayname: "cool_cat", displayname_auto: 1 });
  assert.deepEqual(await one("CFstu55555"), { displayname: "Cool Dog", displayname_auto: 1 });
});
