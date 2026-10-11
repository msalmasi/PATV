// 1.99mv: the legacy Discord blackjack routes - off by default, no unset-token bypass, results only settle an open hand.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../legacybj");

const isBot = (t) => t === "site-bot-token";

test("off by default: 410, even with a good token", () => {
  for (const env of [{}, { LEGACY_DISCORD_BLACKJACK: "0" }, { LEGACY_DISCORD_BLACKJACK: "" }]) {
    const g = L.gate({ password: "site-bot-token" }, isBot, env);
    assert.equal(g.status, 410);
  }
});

test("on: an unset BOT_TOKEN never matches a missing / empty password (the old bypass)", () => {
  const env = { LEGACY_DISCORD_BLACKJACK: "1" };
  for (const body of [{}, { password: undefined }, { password: "" }, { password: null }, undefined]) {
    assert.equal(L.gate(body, isBot, env).status, 403);
  }
  assert.equal(L.gate({ password: "" }, isBot, Object.assign({ BOT_TOKEN: "" }, env)).status, 403, "an empty BOT_TOKEN isn't a token");
  assert.equal(L.gate({ password: "nope" }, isBot, env).status, 403);
  assert.equal(L.gate({ password: "site-bot-token" }, isBot, env), null);
  assert.equal(L.gate({ password: "bj-tok" }, isBot, Object.assign({ BOT_TOKEN: "bj-tok" }, env)), null);
});

test("checkResult: open hand of the same user, payout within -3x..7x the wager", () => {
  const hand = { userId: "u1", wager: 1000, payoutTransactionId: null };
  assert.equal(L.checkResult(hand, "u1", 2000), null);
  assert.equal(L.checkResult(hand, "u1", 7000), null);
  assert.equal(L.checkResult(hand, "u1", -3000), null);
  assert.equal(L.checkResult(hand, "u1", 0), null);
  assert.equal(L.checkResult(null, "u1", 2000), "no_hand");
  assert.equal(L.checkResult({ ...hand, payoutTransactionId: "t" }, "u1", 2000), "settled");
  assert.equal(L.checkResult(hand, "u2", 2000), "wrong_user");
  assert.equal(L.checkResult(hand, "u1", 7001), "bad_payout");
  assert.equal(L.checkResult(hand, "u1", -3001), "bad_payout");
  assert.equal(L.checkResult(hand, "u1", "lots"), "bad_payout");
  assert.equal(L.checkResult(hand, "u1", 1e15), "bad_payout");
});

test("index.js: both routes go through the gate, and no route compares with process.env.BOT_TOKEN any more", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  for (const r of ["/api/blackjack/wager", "/api/blackjack/result"]) {
    const at = src.indexOf(`app.post("${r}"`);
    assert.ok(at > 0, r);
    assert.match(src.slice(at, at + 700), /require\("\.\/legacybj"\)\.gate\(req\.body, isBotToken\)/, r);
  }
  assert.doesNotMatch(src, /[!=]==?\s*process\.env\.BOT_TOKEN\b/);
  const res = src.slice(src.indexOf('app.post("/api/blackjack/result"'));
  assert.match(res.slice(0, 2500), /legacybj"\)\.checkResult\(hand, userId, payout\)/);
  assert.match(res.slice(0, 3500), /WHERE blackjackId = \? AND payoutTransactionId IS NULL/);
});
