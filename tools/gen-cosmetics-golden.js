#!/usr/bin/env node
// tools/gen-cosmetics-golden.js — S1 Q5a (1.99adp): regenerates test/fixtures/cosmetics-css-golden.json, the golden of the
// structured cosmetics (ADR 0007 D13: "golden-tested to render today's CSS").
//
//   node tools/gen-cosmetics-golden.js [--css-ref <git ref>]      (default ref 5662bc88: the last catalog with hand-written CSS -
//                                                                 staging 1.99adn, with the 🍏 Brushed Metal border; main's was 5d153c18)
//
// For every catalog item it records
//   render  what cosmetics.js render() drew at <css-ref> (that commit's cosmetics.js + cosmetics.json, run in a bare VM
//           context: the functions are pure, and the module itself opens a database, so it is never required);
//   look    the item's structured look today (cosmeticstyle.lookOf on the working tree's catalog) - the piece of the chat
//           hub's look (looks/changed, POST /internal/v1/looks) the item contributes, next to the CSS it replaced, which
//           is the golden the platform's chat-core reads (C2) once it vendors this file.
// test/cosmetics-structured.test.js then asserts that today's render() equals `render` for every item and that lookOf
// still gives `look`. Regenerating with the default ref only changes `look` (a deliberate change of the look mapping).
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const OUT = path.join(repo, "test", "fixtures", "cosmetics-css-golden.json");
const i = process.argv.indexOf("--css-ref");
const ref = i > 0 ? process.argv[i + 1] : "5662bc88";
const show = (file) => execFileSync("git", ["-C", repo, "show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 64 << 20 }).replace(/\r\n/g, "\n");

const src = show("cosmetics.js");
const grab = (re, what) => { const m = re.exec(src); if (!m) throw new Error(`cosmetics.js@${ref}: ${what} not found`); return m[0]; };
const fn = (name) => {
  const start = src.indexOf(`function ${name}(item) {`);
  const end = src.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`cosmetics.js@${ref}: ${name} not found`);
  return src.slice(start, end + 2);
};
const code = [
  grab(/^const GTF_OPT = \{.*\};$/m, "GTF_OPT"),
  grab(/^const LAYER_EMOJI = \{[\s\S]*?\n\};$/m, "LAYER_EMOJI"),
  grab(/^const EFFECTS = \[.*\];$/m, "EFFECTS"),
  grab(/^const cssSafe = .*;$/m, "cssSafe"),
  fn("nameCss"),
  fn("render"),
  "render;",
].join("\n");
const oldRender = vm.runInNewContext(code, Object.create(null));
const oldCat = JSON.parse(show("cosmetics.json"));
const newCat = JSON.parse(fs.readFileSync(path.join(repo, "cosmetics.json"), "utf8"));
const CS = require(path.join(repo, "cosmeticstyle.js"));
const byId = new Map(newCat.items.map((it) => [it.id, it]));

const items = oldCat.items.filter((it) => it && it.id && it.kind).map((it) => {
  if (!byId.has(it.id)) throw new Error(`${it.id}: gone from today's catalog`);
  return { id: it.id, kind: it.kind, render: JSON.parse(JSON.stringify(oldRender(it))), look: CS.lookOf(byId.get(it.id)) };
});
let commit = ref;
try { commit = execFileSync("git", ["-C", repo, "rev-parse", "--short", ref], { encoding: "utf8" }).trim(); } catch (e) { /* keep the ref */ }
const out = {
  $comment: "S1 Q5a: every cosmetics.json item's render() at css_ref (the hand-written CSS) and its structured look today " +
            "(cosmeticstyle.lookOf). Regenerate with tools/gen-cosmetics-golden.js; do not edit.",
  source: { repo: "v1 site", css_ref: commit, render: "cosmetics.js render()", look: "cosmeticstyle.js lookOf()" },
  items,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`gen-cosmetics-golden: ${items.length} items (render from ${commit}) -> ${path.relative(repo, OUT)}`);
