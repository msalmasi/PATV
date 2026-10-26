// 1.99ck: "pad" is the one user-facing word for PATV's hubs (was room / channel / community). This scans
// every view and client script for "community" / "channel" copy and for links to the old addresses
// (/rooms..., /feed/c/...). Code identifiers, comments and the legitimate uses (people as a community,
// Discord / Twitch / YouTube channels) are allow-listed below - add to the list only for a real reason.
//   node --test test/pads-copy.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const VENDORED = path.join(repo, "public", "js", "patv-chat");
function files() {
  const out = [];
  const walk = (dir, re) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      // S1 V2: public/js/patv-chat/ is the chat widget's vendored build (the platform repo's export; its copy is that repo's)
      if (f.isDirectory() && p === VENDORED) continue;
      if (f.isDirectory()) walk(p, re);
      else if (re.test(f.name) && !/\.min\.js$/.test(f.name)) out.push(p);
    }
  };
  walk(path.join(repo, "views"), /\.ejs$/);
  walk(path.join(repo, "public", "js"), /\.js$/);
  return out;
}
// whole-line comments (EJS, JS, CSS, HTML) aren't copy
const COMMENT = /^\s*(\/\/|<%#|\/\*|\*|<!--)/;
// code identifiers / API names and the meanings that aren't the PATV entity
const ALLOW = [
  /name="community"|input\[name=community\]|name === 'community'|\bcommunity: |\.community\b|communities\s*\|\||\(d\.communities|data-comm[\w-]*|fc-comm[\w-]*|\/api\/feed\/communities/g,
  /discord\.com\/channels\/[\d/]+/g, /#(poker|blackjack)(<\/a>)? channel/g, /\.name = 'community'/g, /Twitch channel/g, /twitch\.tv\/channel/g, /\?channel=|channel: '|e\.t === 'channel'/g,
  /spin the channel Wheel/gi,
  /T === 'channel'|o\.channel = /g,   // 1.99aag: onair-player.js - the YouTube / Twitch embed players' own parameter names
  /community pot/g,   // 1.99mn: the incentive budget's public name (banner + /support), the people's pot - not a pad
  /\bchannel[- ]points?\b/gi,   // 1.99afh: Twitch's own name for its viewer reward points (/admin/economy#twitchcp) - not a pad
  /PATV is a community|is a community hangout|The community|community website|community site|community token|community perks|Public Access community|from the community|private streaming video platform and community/g,
];
const WORD = /\b(channels?|communit(y|ies))\b/i;
const OLD_URL = /["'`(]\/rooms(\/|\b)(?!\w)|\/feed\/c\//;

test("no user-facing 'community' / 'channel' copy and no links to the old /rooms, /feed/c/ addresses", () => {
  const hits = [];
  for (const f of files()) {
    const rel = path.relative(repo, f).replace(/\\/g, "/");
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (COMMENT.test(line)) return;
      let s = line.replace(/\/\/ .*$/, "").replace(/<%#[\s\S]*?%>/g, "").replace(/<!--[\s\S]*?-->/g, "");
      for (const re of ALLOW) s = s.replace(re, "");
      if (WORD.test(s)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
      if (OLD_URL.test(line.replace(/\/api\/rooms/g, ""))) hits.push(`${rel}:${i + 1} (old URL): ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(hits, [], "say 'pad' (or allow-list a legitimate use):\n" + hits.join("\n"));
});
