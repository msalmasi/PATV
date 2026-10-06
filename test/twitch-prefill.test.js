// Offline tests for the "Use my Twitch channel" suggestion on the Go live page's link field (/stage):
// the signed-in user's OWN connected Twitch channel is server-rendered into the form (no API), only for
// an account with twitchId and a display name that is a valid login; the suggested URL passes the same
// embed validation (stageembed.parse) every link goes through; nobody else's name leaks into the page.
// Also writes stub renders of /stage to $TWITCH_SHOTS (if set) for screenshots.
//   NODE_PATH=G:/PATV/node_modules node --test test/twitch-prefill.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "twitch-prefill-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const E = require(path.join(repo, "stageembed"));

test("twitchChannelUrl: connected accounts only, valid logins only, lower-cased", () => {
  const u = (twitchId, twitchDisplayname) => ({ twitchId, twitchDisplayname });
  assert.equal(E.twitchChannelUrl(u("123", "PlantBaked_TV")), "https://twitch.tv/plantbaked_tv");
  assert.equal(E.twitchChannelUrl(u(null, "PlantBaked")), null, "a name without a connected account isn't offered");
  assert.equal(E.twitchChannelUrl(u("123", "")), null);
  assert.equal(E.twitchChannelUrl(u("123", "日本語の名前")), null, "a localized display name isn't a login");
  assert.equal(E.twitchChannelUrl(u("123", "a b")), null);
  assert.equal(E.twitchChannelUrl(u("123", "x\"><script>")), null);
  assert.equal(E.twitchChannelUrl(u("123", "directory")), null, "Twitch page paths aren't channels");
  assert.equal(E.twitchChannelUrl(null), null);
});

test("the suggested URL passes the normal embed validation", () => {
  const url = E.twitchChannelUrl({ twitchId: "1", twitchDisplayname: "SomeStreamer" });
  assert.deepEqual(E.parse(url), { p: "twitch", t: "channel", id: "somestreamer" });
});

let base, srv;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchId TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  for (const [id, name, tid, tname] of [["tw", "streamer", "555", "CoolStreamer"], ["plain", "plainuser", null, null],
                                          ["cjk", "cjkuser", "777", "日本語の名前"], ["other", "otheruser", "888", "SomeoneElse"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, twitchId, twitchDisplayname) VALUES (?, ?, ?, 'x', 1000, ?, ?)",
                   [id, name, name, tid, tname]);
  }
  const express = require("express");
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  S.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  base = "http://127.0.0.1:" + srv.address().port;
});
test.after(() => srv && srv.close());
const page = async (u, url = "/stage") => (await fetch(base + url, { headers: u ? { "x-test-user": u } : {} })).text();

test("/stage: chip for the user's own connected Twitch, nobody else's", async () => {
  const html = await page("tw", "/stage?room=pepefrog-room");
  assert.match(html, /id="twChip" data-url="https:\/\/twitch\.tv\/coolstreamer"/);
  assert.match(html, /Use my Twitch channel <small>twitch\.tv\/coolstreamer<\/small>/);
  assert.match(html, /<div class="twsug hide" id="twSug">/, "hidden until they pick the link option");
  assert.doesNotMatch(html, /someoneelse/i, "another user's Twitch name never appears");
  assert.match(html, /id="embed" name="embed"[^>]*>/);
  assert.doesNotMatch(html, /id="embed"[^>]*value=/, "the field itself isn't server-filled (the script prefills only an empty field)");

  for (const u of ["plain", "cjk"]) {
    const h = await page(u);
    assert.match(h, /id="bookForm"/, u + " sees the form");
    assert.doesNotMatch(h, /twChip|twSug/, u + " gets no suggestion");
  }
  assert.doesNotMatch(await page(null), /twChip/, "signed out: no suggestion");

  if (process.env.TWITCH_SHOTS) {
    // stub render for screenshots: the real page with local asset paths, the link option picked
    const pub = "file:///" + path.join(repo, "public").replace(/\\/g, "/");
    const out = html.replace(/(href|src)="\/public\//g, `$1="${pub}/`)
      .replace('name="mode" value="stream" checked', 'name="mode" value="stream"')
      .replace('name="mode" value="embed"', 'name="mode" value="embed" checked');
    fs.mkdirSync(process.env.TWITCH_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.TWITCH_SHOTS, "stage.html"), out);
  }
});

test("booking with the suggested link goes through the normal embed path", async () => {
  const r = await fetch(base + "/api/stage/book", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "tw" },
    body: JSON.stringify({ room: "pepefrog-room", minutes: 15, feature: false, mode: "embed", embed: "https://twitch.tv/coolstreamer", title: "" }) });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  const s = (await getQuery("SELECT mode, embed FROM stage_slots WHERE userId = 'tw' ORDER BY rowid DESC LIMIT 1"))[0];
  assert.equal(s.mode, "embed");
  assert.deepEqual(JSON.parse(s.embed), { p: "twitch", t: "channel", id: "coolstreamer" });

  const bad = await fetch(base + "/api/stage/book", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "plain" },
    body: JSON.stringify({ room: "pepefrog-room", minutes: 15, mode: "embed", embed: "https://twitch.tv/directory" }) });
  assert.equal(bad.status, 400, "an edited link is still validated");
});
