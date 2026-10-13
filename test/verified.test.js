// verified.js (1.99ws, connections audit B): one "proven identity" test - any of Camfrog, Discord, Twitch (columns),
// Telegram, Google, Plex (link tables); 1.99wy: a VERIFIED email counts too (an unconfirmed one doesn't); a bare row is
// judged by its columns only.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verified-test-"));
process.chdir(tmp);
const { runQuery } = require(path.join(repo, "dbUtils"));
const V = require(path.join(repo, "verified"));

test.before(async () => {
  await runQuery("CREATE TABLE telegram_links (user_id TEXT PRIMARY KEY, tg_id TEXT NOT NULL UNIQUE, link_source TEXT NOT NULL DEFAULT 'self', linked_at INTEGER)");
  await runQuery("CREATE TABLE sso_links (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, link_source TEXT NOT NULL DEFAULT 'self', PRIMARY KEY (provider, subject))");
  await runQuery("CREATE TABLE plex_members (plex_id TEXT PRIMARY KEY, user_id TEXT, link_source TEXT)");
  await runQuery("INSERT INTO telegram_links (user_id, tg_id) VALUES ('tg', '1')");
  await runQuery("INSERT INTO sso_links (provider, subject, user_id) VALUES ('google', 'sub-1', 'gg')");
  await runQuery("INSERT INTO plex_members (plex_id, user_id, link_source) VALUES ('p1', 'px', 'wizarr'), ('p2', 'pxguess', 'email-guess')");
  await runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, email TEXT, isEmailVerified INTEGER DEFAULT 0)");
  await runQuery(`INSERT INTO users (userId, email, isEmailVerified) VALUES ('em', 'me@example.com', 1), ('emno', 'me2@example.com', 0),
                  ('emfake', 'CFabc12345xyz', 1)`);
});

test("columns: Camfrog, Discord, Twitch and (1.99wy) a verified email are proofs; a bare account isn't", async () => {
  assert.equal(V.isVerified({ userId: "a", camfrogUsername: "bob" }), true);
  assert.equal(V.isVerified({ userId: "a", discordId: "1" }), true);
  assert.equal(V.isVerified({ userId: "a", twitchId: "1" }), true);
  assert.equal(V.isVerified({ userId: "a", email: "a@b.co", isEmailVerified: 1 }), true, "a confirmed address counts");
  assert.equal(V.isVerified({ userId: "a", email: "a@b.co", isEmailVerified: 0 }), false, "an unconfirmed one doesn't");
  assert.equal(V.isVerified({ userId: "a", email: "CFabc12345xyz", isEmailVerified: 1 }), false, "Pepe's @-less placeholder isn't an address");
  assert.equal(await V.verify({ userId: "nobody", isEmailVerified: 1 }), false, "the flag alone (no address, no users row) isn't");
  assert.equal(V.isVerified(null), false);
});

test("1.99wy: a verified email from the users table (rows that don't carry the columns)", async () => {
  assert.equal(await V.verify({ userId: "em" }), true);
  assert.deepEqual((await V.attach({ userId: "em", email: "me@example.com", isEmailVerified: 1 })).proofs, ["email"], "listed once");
  assert.equal(await V.verify({ userId: "emno" }), false);
  assert.equal(await V.verify({ userId: "emfake" }), false);
});

test("tables: Telegram, Google (self link), Plex (trusted source only)", async () => {
  assert.equal(await V.verify({ userId: "tg" }), true);
  assert.equal(await V.verify({ userId: "gg" }), true);
  assert.equal(await V.verify({ userId: "px" }), true);
  assert.equal(await V.verify({ userId: "pxguess" }), false, "an untrusted Plex match doesn't count");
  const u = await V.attach({ userId: "tg", camfrogUsername: "tgcf" });
  assert.deepEqual(u.proofs, ["camfrog", "telegram"]);
  assert.equal(JSON.stringify(u).includes("proofs"), false, "proofs never serialise with the row");
  assert.equal(V.isVerified({ userId: "tg" }), false, "a bare row (no attach) is judged by its columns only");
});

test("cache: forget() picks up an unlink", async () => {
  assert.equal(await V.verify({ userId: "tg" }), true);
  await runQuery("DELETE FROM telegram_links WHERE user_id = 'tg'");
  assert.equal(await V.verify({ userId: "tg" }), true, "cached for a minute");
  V.forget("tg");
  assert.equal(await V.verify({ userId: "tg" }), false);
});
