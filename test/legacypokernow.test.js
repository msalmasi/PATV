// 2026-10-11: the legacy PokerNow games list (POST /api/pokernow/add) - retired with the selfbot; 410 unless LEGACY_POKERNOW=1.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const P = require("../legacypokernow");

test("off by default: 410", () => {
  for (const env of [{}, { LEGACY_POKERNOW: "0" }, { LEGACY_POKERNOW: "" }, { LEGACY_POKERNOW: "yes" }]) {
    const g = P.gate(env);
    assert.equal(g.status, 410);
  }
  assert.equal(P.gate({ LEGACY_POKERNOW: "1" }), null);
  assert.equal(P.gate({ LEGACY_POKERNOW: " 1 " }), null);
});

test("index.js: /api/pokernow/add answers the gate before it reads the body or writes", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const at = src.indexOf('app.post("/api/pokernow/add"');
  assert.ok(at > 0);
  const body = src.slice(at, at + 900);
  const g = body.indexOf('require("./legacypokernow").gate()');
  assert.ok(g > 0, "gated");
  assert.ok(g < body.indexOf("req.body") && g < body.indexOf("addPokerNowGame("), "the gate comes first");
  assert.match(body, /if \(gate\) return res\.status\(gate\.status\)\.json\(gate\.body\);/);
});
