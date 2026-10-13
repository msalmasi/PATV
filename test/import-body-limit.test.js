// 1.99sy: the cutover imports (pools / escrow / gangs / the capital cluster) carry exports far bigger than the global 100 KB JSON limit -
// the prod pools cutover of 2026-10-12 failed with "request entity too large". Each path is skipped by index.js's
// global parser and parses its own body with a 32 MB limit.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

for (const [file, route] of [["pools.js", "/api/pools/admin/import"], ["escrow/ledger.js", "/api/escrow/admin/import"],
                             ["gangs.js", "/api/gangs/admin/import"], ["capital/service.js", "/api/capital/admin/import"],
                             // 2026-10-12: Pepe's econ docs push (the prod PayloadTooLargeError since the pools cutover)
                             ["econstore.js", "/api/econ/docs/put"],
                             // P4-1: the Fed's journal export (every mint ever)
                             ["fed/service.js", "/api/fed/admin/import"]]) {
  test(`${route} skips the global JSON parser and parses a big body itself`, () => {
    assert.ok(read("index.js").includes(`req.path === "${route}"`), "index.js skip list has " + route);
    const src = read(file);
    const line = src.split("\n").find((l) => l.includes(`app.post("${route}"`));
    assert.ok(line, "route registered in " + file);
    assert.match(line, /express"\)\.json\(\{ limit: "32mb" \}\)/);
  });
}

test("a 1 MB JSON body parses under the route's own limit", async () => {
  const express = require("express");
  const app = express();
  app.post("/x", express.json({ limit: "32mb" }), (req, res) => res.json({ n: req.body.blob.length }));
  const srv = app.listen(0);
  const port = srv.address().port;
  const blob = "a".repeat(1024 * 1024);
  const r = await fetch(`http://127.0.0.1:${port}/x`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blob }) });
  srv.close();
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).n, blob.length);
});

// Phase 4: the policy scheduler's bot routes that carry Pepe's inputs parse their own body too
for (const route of ["/api/policy/bot/config", "/api/policy/bot/report", "/api/policy/admin/cutover"]) {
  test(`${route} skips the global JSON parser and parses its own body`, () => {
    assert.ok(read("index.js").includes(`req.path === "${route}"`), "index.js skip list has " + route);
    const line = read("policy/scheduler.js").split("\n").find((l) => l.includes(`app.post("${route}"`));
    assert.ok(line && /, big, /.test(line), "the route parses with its own limit");
  });
}
