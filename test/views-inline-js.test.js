// 1.99aij (privacy controls hotfix): every inline <script> in views/ must parse. On 2026-11-03 the /admin/bridge "Incognito cams" card
// shipped with `haven't` inside a single-quoted confirm() string - a syntax error that killed the whole card script, so it stayed on
// "Loading…" with its button disabled and the switch couldn't be turned on. No test rendered that script; this one parses them all.
// EJS tags are stubbed out first (<%= / <%- -> a value, <%# / <% -> nothing), so only the JavaScript itself is checked.
//   node --test test/views-inline-js.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const views = path.resolve(__dirname, "..", "views");

function ejsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...ejsFiles(p));
    else if (e.name.endsWith(".ejs")) out.push(p);
  }
  return out;
}

function inlineScripts(src) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["'](?!text\/javascript|module)[^"']+["']/i.test(attrs)) continue;   // JSON, templates
    const js = m[2]
      .replace(/<%[-=]([\s\S]*?)%>/g, "0")
      .replace(/<%#[\s\S]*?%>/g, "")
      .replace(/<%[\s\S]*?%>/g, "");
    out.push({ line: src.slice(0, m.index).split("\n").length, js });
  }
  return out;
}

test("every inline script in views/ parses (EJS tags stubbed)", () => {
  const bad = [];
  let n = 0;
  for (const f of ejsFiles(views)) {
    for (const s of inlineScripts(fs.readFileSync(f, "utf8"))) {
      n++;
      try { new vm.Script(s.js, { filename: f }); }
      catch (e) { bad.push(`${path.relative(views, f)}:${s.line}: ${e.message}`); }
    }
  }
  assert.ok(n > 50, `found the inline scripts (${n})`);
  assert.deepEqual(bad, [], "inline scripts with syntax errors");
});

test("the Incognito cams card's confirm text keeps its apostrophe escaped", () => {
  const src = fs.readFileSync(path.join(views, "admin", "bridge.ejs"), "utf8");
  assert.ok(src.includes("haven\\'t switched live cam off"), "the confirm string escapes haven't");
});
