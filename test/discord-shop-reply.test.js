// 1.99ans: the Discord /shop purchase reply (discord-bot/shopReply.js). A virtual in-game collectible (NY S5935-A, owner
// 2026-11-11) is in the buyer's PATV collection at once - the reply never says to wait for an activation; roles and invites
// keep the old line. The command passes /api/prizes' delivery and /chatshop's `collectible` flag.
//   NODE_PATH=G:/PATV/node_modules TZ=UTC node --test test/discord-shop-reply.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const { purchaseReply } = require(path.join(repo, "discord-bot", "shopReply"));

test("a virtual collectible: in the PATV collection now, nothing shipped or activated, no cash value - never 'wait for activation'", () => {
  for (const args of [{ delivery: "collectible" }, { delivery: null, collectible: true }, { delivery: "staff", collectible: true }]) {
    const r = purchaseReply({ name: "Discord Nitro 1 Month - virtual collectible, not a membership", cost: "9,000,000", balance: "1", ...args });
    assert.match(r, /^You successfully purchased Discord Nitro 1 Month - virtual collectible, not a membership \(PAT 9,000,000\)! You have PAT 1\./);
    assert.match(r, /virtual in-game collectible: it's in your PATV collection now/);
    assert.match(r, /Nothing is shipped or activated; it has no cash value\./);
    assert.doesNotMatch(r, /24 hours|activation|wait/i, JSON.stringify(args));
  }
});

test("roles and invites keep the activation line; the instant spin boost says it's on", () => {
  for (const d of ["role", "invite", "staff", undefined]) {
    assert.match(purchaseReply({ name: "Scout role", cost: "1", balance: "0", delivery: d }), /Please wait up to 24 hours for activation\.$/, String(d));
  }
  assert.match(purchaseReply({ name: "+100 Daily Gold Spins", cost: "3,000,000", balance: "0", delivery: "instant" }), /It's on your account now\.$/);
});

test("the command uses it, with /api/prizes' delivery and /chatshop's collectible flag", () => {
  const cmd = fs.readFileSync(path.join(repo, "discord-bot", "commands", "shop.js"), "utf8");
  assert.match(cmd, /require\('\.\.\/shopReply'\)/);
  assert.match(cmd, /purchaseReply\(\{[^}]*delivery: selectedPrizeName\.delivery, collectible: !!response\.data\.collectible \}\)/);
  assert.match(cmd, /delivery: prize\.delivery \|\| null/);
  assert.doesNotMatch(cmd, /wait up to 24 hours/, "the wording lives in shopReply.js only");
  const shop = fs.readFileSync(path.join(repo, "shop.js"), "utf8");
  assert.match(shop, /message: "Purchase successful", \.\.\.\(r\.collectible \? \{ collectible: true \} : \{\}\)/);
});
