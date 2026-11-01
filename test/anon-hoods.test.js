// wave2 WP-4 (incognito / mic-stage spec F.4, J-11): the hooded-frog covers for veiled speakers - public/img/anon/hood-peek-{0..7}.svg
// (incognito, "Peek B" bandana) and hood-shadow-{0..7}.svg (hidden, "Shadow"), one per frog-name hood. Small, static, nothing
// that could run or load anything, never Pepe's red lips, every hood present; tools/gen-stickers.py owns them (`anon --check`).
//   node --test test/anon-hoods.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const DIR = path.join(repo, "public", "img", "anon");
const HOODS = Number((fs.readFileSync(path.join(repo, "frognames.js"), "utf8").match(/\bHOODS = (\d+)/) || [])[1]);
const KINDS = [["peek", "Incognito frog"], ["shadow", "Hidden frog"]];

test("the frog-name generator's hood count is the art's (8)", () => {
  assert.equal(HOODS, 8);
});

test("16 covers: every hood index for both veils, each at most 3 KB, and nothing else in the folder", () => {
  const want = [];
  for (const [kind] of KINDS) for (let i = 0; i < HOODS; i++) want.push(`hood-${kind}-${i}.svg`);
  assert.deepEqual(fs.readdirSync(DIR).sort(), want.slice().sort());
  for (const f of want) {
    const st = fs.lstatSync(path.join(DIR, f));
    assert.ok(st.isFile() && !st.isSymbolicLink(), f);
    assert.ok(st.size > 200 && st.size <= 3072, `${f}: ${st.size} bytes`);
  }
});

test("each cover is a static 24 x 24 pixel SVG: svg / title / path only - no script, style, link, image or foreignObject", () => {
  for (const [kind, title] of KINDS) {
    for (let i = 0; i < HOODS; i++) {
      const f = `hood-${kind}-${i}.svg`;
      const s = fs.readFileSync(path.join(DIR, f), "utf8");
      assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">/, f);
      assert.ok(s.trimEnd().endsWith("</svg>"), f);
      const tags = [...s.matchAll(/<\/?([A-Za-z][\w:-]*)/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(tags)].sort(), ["path", "svg", "title"], f + ": only svg / title / path");
      assert.doesNotMatch(s, /script|style|href|foreignObject|<image|on[a-z]+=|url\(|javascript:|data:/i, f);
      assert.equal((s.match(/<title>([^<]*)<\/title>/) || [])[1], title, f);
      // every attribute is one we expect (no event handler, no external reference)
      for (const m of s.matchAll(/\s([a-zA-Z:-]+)="/g)) assert.ok(["xmlns", "viewBox", "shape-rendering", "fill", "d"].includes(m[1]), `${f}: ${m[1]}`);
      for (const m of s.matchAll(/ fill="([^"]*)"/g)) assert.match(m[1], /^#[0-9a-f]{3}([0-9a-f]{3})?$/, f + ": a plain colour");
      for (const m of s.matchAll(/ d="([^"]*)"/g)) assert.match(m[1], /^[MhvHVz0-9 -]+$/, f + ": rect paths only");
    }
  }
});

test("an anonymous frog, never Pepe: none of his red lip colours; the hood colour differs per index", () => {
  for (const [kind] of KINDS) {
    const firstFills = new Set();
    for (let i = 0; i < HOODS; i++) {
      const s = fs.readFileSync(path.join(DIR, `hood-${kind}-${i}.svg`), "utf8").toLowerCase();
      assert.ok(!s.includes("#e5383b") && !s.includes("#9d0208"), `hood-${kind}-${i}: Pepe's lips`);
      // the hood's cloth: the second fill (after the outline) - distinct across the 8 hoods
      const fills = [...s.matchAll(/ fill="([^"]*)"/g)].map((m) => m[1]);
      assert.equal(fills[0], "#111", "the outline is painted first");
      firstFills.add(fills[1]);
    }
    assert.equal(firstFills.size, HOODS, kind + ": eight different hoods");
  }
});

test("tools/gen-stickers.py owns them: `anon --check` reproduces all 16 byte for byte (writes nothing)", (t) => {
  const py = spawnSync(process.platform === "win32" ? "python" : "python3", ["--version"], { encoding: "utf8" });
  if (py.error || py.status !== 0) { t.skip("no python here"); return; }
  const r = spawnSync(process.platform === "win32" ? "python" : "python3", [path.join(repo, "tools", "gen-stickers.py"), "anon", "--check"],
                      { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  assert.match(r.stdout, /anon same/);
});
