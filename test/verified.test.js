// verified.js (1.99ws, connections audit B): one "proven identity" test - any of Camfrog, Discord, Twitch (columns),
// Telegram, Google, Plex (link tables); a verified email doesn't count; a bare row is judged by its columns only.
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
});

test("columns: Camfrog, Discord, Twitch are proofs; a verified email and a bare account aren't", async () => {
  assert.equal(V.isVerified({ userId: "a", camfrogUsername: "bob" }), true);
  assert.equal(V.isVerified({ userId: "a", discordId: "1" }), true);
  assert.equal(V.isVerified({ userId: "a", twitchId: "1" }), true);
  assert.equal(await V.verify({ userId: "nobody", isEmailVerified: 1 }), false);
  assert.equal(V.isVerified(null), false);
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
