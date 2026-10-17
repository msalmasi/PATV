// 1.99abt: the 🏳️ country flag on profiles - a "country" layout item (shown by default, members can hide it), drawn
// from the newest sign-in session's Cloudflare country, with the self-hosted flag font for Windows.
//   node --test test/profile-country.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const PL = require(path.join(__dirname, "..", "profilelayout"));

test("a 'country' layout item: shown to visitors by default, hideable", () => {
  const v = PL.view(PL.clean ? PL.clean({}) : { order: [], hidden: [] }, { owner: false, admin: false });
  assert.equal(v.show("country"), true);
  const h = PL.view(PL.clean ? PL.clean({ hidden: ["country"] }) : { order: [], hidden: ["country"] }, { owner: false, admin: false });
  assert.equal(h.show("country"), false, "hidden from visitors when the member hides it");
});

test("the profile reads the newest session's country (never XX / T1, never while incognito) and draws a flag", () => {
  const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(idx, /FROM sessions WHERE user_id = \? AND country IS NOT NULL[\s\S]{0,200}NOT IN \('XX', 'T1'\) ORDER BY created DESC LIMIT 1/);
  assert.match(idx, /country: await \(async \(\) => \{\s*if \(!L\.show\("country"\)\) return null;[\s\S]{0,200}incognito/);
  const view = fs.readFileSync(path.join(__dirname, "..", "views", "profile.ejs"), "utf8");
  assert.match(view, /0x1F1E6 \+ c\.charCodeAt\(0\) - 65/);
  assert.match(view, /TwemojiCountryFlags\.woff2/);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "public", "fonts", "twemoji-flags", "TwemojiCountryFlags.woff2")));
  assert.ok(fs.existsSync(path.join(__dirname, "..", "public", "fonts", "twemoji-flags", "LICENSE.md")), "the CC-BY attribution ships with it");
});
