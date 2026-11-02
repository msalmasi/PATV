// privacy controls S0 (G:/ops/privacy-controls-spec-2026-11-02.md section 5 "S0", section 8 = the owner's answers of 2026-11-02):
// the privacy copy that is false today.
//   * Settings → Privacy, the incognito card: while the Privacy wire v2 switch is on, incognito people are a random frog name and
//     !bridge hide blacks lines out - the card said "someone" and "keeps your lines off the website altogether". New _v2 keys
//     (inc.what_web_someone_v2 / _acct_v2); with the switch off the card is exactly as before
//   * /about's "Getting started": "!bridge hide (or !incognito on) keeps you off the live room view" is no longer true
//   NODE_PATH=G:/PATV/node_modules node --test test/privm-s0-copy.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s0-copy-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const I = require(path.join(repo, "incognito"));
const PW = require(path.join(repo, "privwire"));

const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
const users = new Map();
let base, server;
const V1 = "The website shows you as “someone”";
const V2 = "The website shows you under a random frog name instead of your name and picture";

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived_at INTEGER)`);
  require(path.join(repo, "actions"));
  require(path.join(repo, "inbox"));
  await I.init();
  for (const [name, cf] of [["alice", "alicecf"], ["webonly", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', 'pleb', ?)", ["u_" + name, name, name, cf]);
    users.set("u_" + name, { userId: "u_" + name, username: name, class: "pleb" });
  }
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  I.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
const page = async (uid) => (await fetch(base + "/settings/privacy", { headers: { "x-test-user": uid } })).text();
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

test("S0: the v2 incognito keys say what privacy wire v2 shows (a frog name; !bridge hide blacks out) - never \"someone\"", () => {
  const a = en["inc.what_web_someone_v2"], b = en["inc.what_web_someone_acct_v2"];
  assert.ok(a && b);
  for (const s of [a, b]) {
    assert.match(s, /random frog name/);
    assert.match(s, /incognito hides who you are, not what you say/);
    assert.doesNotMatch(s, /someone/);
    assert.doesNotMatch(s, /altogether/, "!bridge hide no longer keeps lines off the website on v2 (they are a blacked-out bar)");
  }
  assert.match(a, /To black out what you say too, type !bridge hide in a Camfrog room\./);
  assert.ok(!/!bridge hide/.test(b) && /Remove my line/.test(b), "a web-only identity isn't told to type !bridge hide");
  assert.doesNotMatch(a + b, /cams?/i, "nothing about cams (S5's sentence ships behind its own switch)");
  // the v1 keys are unchanged (other languages keep their translations)
  assert.match(en["inc.what_web_someone"], /“someone”/);
});

test("S0: Settings → Privacy shows the v2 wording only while the Privacy wire v2 switch is on; off, the card is as before", async () => {
  const real = PW.isOn;
  try {
    PW.isOn = () => false;
    let p = unesc(await page("u_alice"));
    assert.ok(p.includes(V1) && p.includes("To keep your lines off the website altogether, type !bridge hide"), "switch off: the v1 text");
    assert.ok(!p.includes(V2));
    PW.isOn = () => true;
    p = unesc(await page("u_alice"));
    assert.ok(p.includes(en["inc.what_web_someone_v2"]), "switch on: the v2 text, whole");
    assert.ok(!p.includes(V1) && !p.includes("altogether"), "...and not the v1 one");
    // an identity with no chat login (st.account: the account key u:<id>) gets the _acct variant on v2, the old one on v1
    const v = fs.readFileSync(path.join(repo, "views", "privacy-settings.ejs"), "utf8");
    assert.match(v, /locals\.pwOn \? t\(st\.account \? 'inc\.what_web_someone_acct_v2' : 'inc\.what_web_someone_v2'\) : t\(st\.account \? 'inc\.what_web_someone_acct' : 'inc\.what_web_someone'\)/);
  } finally { PW.isOn = real; }
});

test("S0: /about no longer says !bridge hide / !incognito on keep you off the live room view", () => {
  const src = fs.readFileSync(path.join(repo, "views", "about.ejs"), "utf8");
  assert.doesNotMatch(src, /stay off the website's live room view/);
  assert.doesNotMatch(src, /<code>!bridge hide<\/code> \(or <code>!incognito on<\/code>\)/);
  assert.match(src, /Want to stay private on the website's live room view\? In the chat room, type <code>!incognito on<\/code> to hide your name there, <code>!bridge hide<\/code> to hide your lines too, or <code>!livecam off<\/code> to keep your cam off it\./);
});
