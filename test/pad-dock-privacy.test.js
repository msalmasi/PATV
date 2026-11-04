"use strict";
// 1.99?? dock: review - privacy (the Room Dock spec K, "in every view"): what the Dock's own surfaces must keep for veiled people.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const repo = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(repo, p), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
// the declarations of every rule whose selector list matches `sel` exactly (one selector of the list)
function rules(css, sel) {
  const out = [], re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(css))) if (m[1].split(",").map(s => s.replace(/\s+/g, " ").trim()).includes(sel)) out.push(m[2]);
  return out.join(";");
}
const has = (decls, prop, value) => new RegExp("(^|;)\\s*" + prop + "\\s*:\\s*" + value + "\\s*(;|$)").test(decls);

// The composer's holder chips are narrow (max 180px with the avatar) and clip their name with an ellipsis. A veiled holder's name
// node is "<i>Soggy Bullfrog</i> <span class=veil-tag>incognito</span>": clipped as one run, the TEXT tag goes first, leaving an
// italic frog name that reads like a real Camfrog name (a real display name may look like one - chatlog-core ALIAS_RE). As in the
// chat's line head (chatlog.css), only the frog name gives way; the tag ("incognito" / "hidden") always shows.
test("1.99?? dock: review - a veiled mic holder's chip keeps its incognito / hidden tag; only the frog name ellipsizes", () => {
  const css = read("public/css/pad-dock.css");
  const veil = rules(css, "main.rm.rm-dock .rmd-holders .who.veil");
  assert.ok(has(veil, "display", "(inline-)?flex"), "the veiled name lays out its parts");
  assert.ok(has(veil, "min-inline-size", "0") || has(veil, "min-width", "0"), "the veiled name can shrink in the chip");
  const tag = rules(css, "main.rm.rm-dock .rmd-holders .who.veil > .veil-tag");
  assert.ok(has(tag, "flex", "none") || has(tag, "flex-shrink", "0"), "the text tag never shrinks away");
  const alias = rules(css, "main.rm.rm-dock .rmd-holders .who.veil > i");
  assert.ok(has(alias, "text-overflow", "ellipsis") && has(alias, "overflow", "hidden"), "the frog name is what ellipsizes");
  assert.ok(has(alias, "min-inline-size", "0") || has(alias, "min-width", "0"), "the frog name can shrink");
});
