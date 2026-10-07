// 1.99ep: website-action error codes (weberrors.js). The code list is pinned (it mirrors the bot's
// pepe_weberrors.WEBACT_ERRORS - a rename breaks old rows), the ack stores code / hint / incident, old rows
// (no code; 1.99ds "something went wrong: <Type>: <reason>") still render friendly, and the activity list shows
// the friendly message + hint with the code in small print - never an exception name.
//   node --test test/weberrors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "weberrors-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const W = require(path.join(repo, "weberrors"));

const STABLE = ["E_NOT_LINKED", "E_NO_PERMISSION", "E_BANNED", "E_INSUFFICIENT_PAT", "E_BAD_ARGS", "E_TARGET_NOT_FOUND",
  "E_EXPIRED", "E_ALREADY", "E_UNSUPPORTED", "E_COOLDOWN", "E_GAME_BUSY", "E_ROOM_OFFLINE", "E_FEATURE_OFF",
  "E_RATE_LIMITED", "E_TIMEOUT", "E_TEMPORARY", "E_INTERRUPTED", "E_UPSTREAM", "E_REFUSED", "E_INTERNAL"];

test("the code list is pinned and every code has a friendly message + hint", () => {
  assert.deepEqual(W.CODES, STABLE, "same codes, same order as the bot's pepe_weberrors.py");
  for (const c of W.CODES) {
    const [msg, hint] = W.ERRORS[c];
    assert.match(msg, /^[A-Z].*[.!]$/, c + " message");
    assert.match(hint, /^[A-Z].*[.!]$/, c + " hint");
    assert.doesNotMatch(msg + hint, /Error\b|Exception/, c + " names no exception");
  }
  for (const [c] of W.RULES) assert.ok(W.CODES.includes(c), "rule code " + c);
});

test("classify: the bot's refusal sentences -> codes (old rows without a code)", () => {
  const cases = [
    ["link your Camfrog name on your profile first (!verify in a room) — you act as that name", "E_NOT_LINKED"],
    ["a new avatar costs 20,000 PAT — insufficient PAT (need 20,000, you have 5).", "E_INSUFFICIENT_PAT"],
    ["you're banned from the casino", "E_BANNED"],
    ["Pepe isn't in that room right now", "E_ROOM_OFFLINE"],
    ["that snapshot expired - take a fresh one and save it", "E_EXPIRED"],
    ["Pepe didn't get to it in time — nothing happened. Try again.", "E_TIMEOUT"],
    ["a poll is already running — vote on it, or wait for it to end", "E_GAME_BUSY"],
    ["only this pad's owner can change that", "E_NO_PERMISSION"],
    ["that can't be done from the site", "E_UNSUPPORTED"],
    ["no market M99", "E_TARGET_NOT_FOUND"],
    ["usage: !wager @user <amount>", "E_BAD_ARGS"],
    ["interrupted by a restart — check before trying again", "E_INTERRUPTED"],
    ["something went wrong: KeyError: 'x'", "E_INTERNAL"],
    ["the moon is made of cheese", "E_REFUSED"],
    ["", "E_REFUSED"],
  ];
  for (const [m, want] of cases) assert.equal(W.classify(m), want, m);
});

test("present: ok / waiting -> null; a coded row keeps Pepe's words; legacy exception text is never shown", () => {
  assert.equal(W.present({ status: "done", message: "ok" }), null);
  assert.equal(W.present({ status: "pending" }), null);
  const coded = W.present({ status: "failed", message: "you don't have enough PAT for that loan", code: "E_INSUFFICIENT_PAT", hint: "Top up." });
  assert.deepEqual(coded, { code: "E_INSUFFICIENT_PAT", message: "you don't have enough PAT for that loan", hint: "Top up.", incident: null, legacy: false });
  const internal = W.present({ status: "failed", message: "Something went wrong on Pepe's side (incident ab12cd34). Check your balance before trying again.",
    code: "E_INTERNAL", incident: "ab12cd34" });
  assert.equal(internal.incident, "ab12cd34");
  assert.match(internal.message, /incident ab12cd34/);
  // a 1.99ds row: the exception type + reason are replaced by the friendly line
  const ds = W.present({ status: "failed", message: "something went wrong: KeyError: 'sk_live_x' at <path>" });
  assert.equal(ds.code, "E_INTERNAL");
  assert.equal(ds.legacy, true);
  assert.doesNotMatch(ds.message, /KeyError|sk_live|<path>/);
  assert.equal(ds.hint, W.ERRORS.E_INTERNAL[1]);
  // the bare 2026-10-05 bug text keeps its old wording
  assert.match(W.present({ status: "failed", message: "something went wrong" }).message, /since fixed/);
  // an old refusal: the code is inferred, Pepe's words stay
  const old = W.present({ status: "failed", message: "no market M99" });
  assert.equal(old.code, "E_TARGET_NOT_FOUND");
  assert.equal(old.message, "no market M99");
  // an unknown code from a newer bot: inferred instead, hint from the table
  assert.equal(W.present({ status: "failed", message: "usage: x", code: "E_FROM_THE_FUTURE" }).code, "E_BAD_ARGS");
  // no message at all: the code's friendly line
  assert.equal(W.present({ status: "failed", message: "", code: "E_TIMEOUT" }).message, W.ERRORS.E_TIMEOUT[0]);
  // a junk incident id is dropped
  assert.equal(W.present({ status: "failed", message: "x", code: "E_INTERNAL", incident: "<script>" }).incident, null);
});

let base, server, actions;
test("the ack stores code / hint / incident (old table migrated); recentFor decorates; the list renders the code", async () => {
  // an OLD pepe_actions table (no code / hint / incident / idem columns)
  await runQuery(`CREATE TABLE pepe_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, camfrog TEXT,
    site_admin INTEGER DEFAULT 0, kind TEXT NOT NULL, args TEXT NOT NULL, tag TEXT, label TEXT,
    status TEXT NOT NULL DEFAULT 'pending', message TEXT, created INTEGER, claimed INTEGER, updated INTEGER)`);
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u1', 'alice', 'alice', 'x', 'alice')");
  // a legacy 1.99ds failure already in the table
  await runQuery(`INSERT INTO pepe_actions (user_id, username, kind, args, tag, label, status, message, created)
                  VALUES ('u1', 'alice', 'cmd', '["lotto","buy"]', 'lotto', '!lotto buy', 'failed', 'something went wrong: TypeError: NoneType has no attribute x', 1)`);
  actions = require(path.join(repo, "actions"));
  await new Promise((r) => setTimeout(r, 200));
  const cols = (await getQuery("PRAGMA table_info(pepe_actions)")).map((c) => c.name);
  for (const c of ["code", "hint", "incident"]) assert.ok(cols.includes(c), "column " + c);
  const app = express();
  app.use(express.json());
  actions.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await actions.queue("u1", { kind: "cmd", args: ["lotto", "buy", String(i)], tag: "lotto", label: "!lotto buy " + i }));
    const ack = (results) => fetch(base + "/api/actions/ack", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "bot-token", results }) });
    await ack([
      { id: ids[0], ok: false, message: "Something went wrong on Pepe's side (incident 0a1b2c3d). Check your balance before trying again.",
        code: "E_INTERNAL", hint: W.ERRORS.E_INTERNAL[1], incident: "0a1b2c3d" },
      { id: ids[1], ok: false, message: "a lotto ticket costs 1,000 PAT - you have 3" },                  // an old bot: no code
      { id: ids[2], ok: true, message: "🎟 ticket bought", code: "E_INTERNAL" },                          // ok never keeps a code
      { id: ids[3], ok: false, message: "no draw is open", code: "E_TARGET_NOT_FOUND", incident: "not hex!" },
    ]);
    const R = Object.fromEntries((await getQuery("SELECT id, status, code, hint, incident FROM pepe_actions")).map((r) => [r.id, r]));
    assert.equal(R[ids[0]].code, "E_INTERNAL"); assert.equal(R[ids[0]].incident, "0a1b2c3d");
    assert.equal(R[ids[1]].code, "E_INSUFFICIENT_PAT", "inferred when the bot sent none");
    assert.equal(R[ids[1]].hint, W.ERRORS.E_INSUFFICIENT_PAT[1]);
    assert.equal(R[ids[2]].status, "done"); assert.equal(R[ids[2]].code, null);
    assert.equal(R[ids[3]].incident, null, "a junk incident id isn't stored");

    const acts = await actions.recentFor("u1", "lotto", 10);
    assert.equal(acts.length, 5);
    const html = await ejs.renderFile(path.join(repo, "views/partials/actions.ejs"), { acts, msg: "" });
    assert.match(html, /class="act-code">code E_INTERNAL · incident 0a1b2c3d</);
    assert.match(html, /class="act-code">code E_INSUFFICIENT_PAT</);
    assert.match(html, /class="act-hint">Check your balance on your wallet page/);
    assert.match(html, /a lotto ticket costs 1,000 PAT - you have 3/, "Pepe's own words stay the message");
    assert.doesNotMatch(html, /TypeError|NoneType/, "the legacy exception text is never shown");
    assert.match(html, /Something went wrong on Pepe&#39;s side\. Check your balance/);
    assert.equal((html.match(/class="act-code"/g) || []).length, 4, "every failure carries its code, the success none");
  } finally {
    server.close();
  }
});

test("the activity list without decoration (raw rows) still never shows a 1.99ds exception name", async () => {
  const html = await ejs.renderFile(path.join(repo, "views/partials/actions.ejs"), {
    acts: [{ status: "failed", label: "x", message: "something went wrong: KeyError: 'boom'" }], msg: "" });
  assert.doesNotMatch(html, /KeyError/);
  assert.match(html, /Something went wrong on Pepe&#39;s side/);
});
