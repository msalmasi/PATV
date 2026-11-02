// public/js/avatar.js is mirrored byte for byte into the bot repo's poll-site/public/avatar.js (1.99ahe). This file is the source
// of truth (the GTF catalog's layers are painted here first); Pepe's pages on pepe.publicaccess.tv load the bot's copy as /avatar.js.
// The copy drifted twice (1.99re and 1.99agq layers never reached it), so both repos pin the same sha256 of it (LF line ends):
// a change here fails this test until the file is copied to the bot repo and BOTH pins move (this AVATAR_PIN + the bot's
// avatar_sync_test.py PIN). With PEPE_BOT_DIR=<a bot checkout> the bot's copy is also compared byte for byte.
//   node --test test/avatar-sync.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
// = public/js/avatar.js at 1.99ahe (d5c480b0, the Winter Lights layers: earmuffs, winterlights, lantern; was a01b7c23... at
// 1.99agq 5cd7d0fb, the Fireside layers). Move together with the bot's avatar_sync_test.py PIN.
const AVATAR_PIN = "34c586164b895fa820fdccfe3edd31ae2caef1324b05f761a56c0417cce8133f";
const lf = (p) => fs.readFileSync(p).toString("latin1").replace(/\r\n/g, "\n");
const sha = (s) => crypto.createHash("sha256").update(Buffer.from(s, "latin1")).digest("hex");

test("avatar.js is the pinned version - after a change copy it to the bot's poll-site/public/avatar.js and move BOTH pins", () => {
  assert.equal(sha(lf(path.join(repo, "public", "js", "avatar.js"))), AVATAR_PIN);
});

test("the bot's poll-site/public/avatar.js is byte-identical (PEPE_BOT_DIR)", (t) => {
  const bot = process.env.PEPE_BOT_DIR;
  if (!bot) return t.skip("PEPE_BOT_DIR not set - the bot's copy isn't compared here (its avatar_sync_test.py pins the same sha)");
  const copy = path.join(bot, "poll-site", "public", "avatar.js");
  assert.ok(fs.existsSync(copy), copy + " exists");
  assert.equal(sha(lf(copy)), sha(lf(path.join(repo, "public", "js", "avatar.js"))), "copy public/js/avatar.js to " + copy);
});
