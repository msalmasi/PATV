"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixtureRunner, rawLine } = require("../tools/clerk-find");
const fixture = require("./fixtures/clerk_catalog.json");
const evaluation = require("./fixtures/clerk_eval.json");
const PHASES = new Set(["1"]);

function check(caseRow, result) {
  const expected = caseRow.expect, rows = result.rows || [];
  if (expected.code === "none") { assert.equal(rows.length, 0, "no library match"); return; }
  if (expected.code) { assert.equal(result.code, expected.code); return; }
  assert.ok(rows.length > 0, "expected a verified catalog pick");
  const keys = rows.flatMap(r => r.keys || [r.key]);
  const source = keys.map(key => fixture.rows.find(r => r.key === key));
  assert.ok(source.every(Boolean), "all output keys are in the fixture catalog");
  assert.ok(source.every(r => ["71", "72"].includes(r.section) && r.content_rating !== "X"), "no denied row escapes");
  if (expected.keys) assert.deepEqual(keys, expected.keys, "verified key/order");
  if (expected.exact) assert.equal(result.exact, true);
  if (expected.count != null) assert.equal(rows.length, expected.count);
  if (expected.items != null) assert.equal(keys.length, expected.items);
  if (expected.kind) assert.ok(rows.every(r => r.kind === expected.kind), "kind");
  if (expected.show) assert.ok(rows.every(r => r.show === expected.show || r.title === expected.show) || source.every(r => r.show === expected.show), "show");
  if (expected.genre) assert.ok(source.every(r => r.genres.includes(expected.genre)), "genre");
  if (expected.shelf) {
    const members = fixture.shelves.find(s => s.name === expected.shelf).members;
    assert.ok(source.every(r => members.includes(r.key) || members.includes(r.show_key)), "shelf membership");
  }
  if (expected.warn) assert.ok(rows.every(r => r.warn === expected.warn), "warning");
  if (expected.not_season != null) assert.ok(source.every(r => r.season !== expected.not_season), "specials excluded");
  if (expected.years) assert.ok(source.every(r => r.year >= expected.years[0] && r.year <= expected.years[1]), "year range");
  if (expected.max_minutes) assert.ok(source.every(r => r.duration <= expected.max_minutes * 60), "duration");
  if (expected.min_rating) assert.ok(source.every(r => (r.rating || r.audience_rating || 0) >= expected.min_rating), "rating floor");
  if (expected.deep_cut) assert.ok(source.every(r => !r.pad_plays && r.server_plays <= (r.type === "movie" ? 2 : 10)), "deep cut");
  if (expected.people) assert.ok(source.every(r => [...r.directors, ...r.cast].some(n => n.toLowerCase().includes(expected.people.toLowerCase()))), "person filter");
  if (expected.order === "aired") assert.deepEqual(source.map(r => r.aired), source.map(r => r.aired).slice().sort(), "oldest first");
  if (expected.unseen) assert.ok(keys.every(k => !(caseRow.context.seen || []).includes(k)), "requester-only seen keys");
}

test("shared clerk fixtures are byte-identical when the bot checkout is supplied", () => {
  if (!process.env.PEPE_BOT_DIR) return;
  for (const name of ["clerk_catalog.json", "clerk_eval.json"]) {
    assert.deepEqual(fs.readFileSync(path.join(__dirname, "fixtures", name)),
      fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "ci/fixtures", name)), name);
  }
});

test("phase 1 golden selections use the real catalog and finder", async t => {
  const runner = await fixtureRunner(fixture);
  try {
    for (const caseRow of evaluation.cases.filter(c => PHASES.has(c.phase) && !c.expect.not_ours)) {
      await t.test(caseRow.id, async () => {
        const result = await runner.find({ ask: caseRow.expect_interp, raw: rawLine(caseRow.line), context: caseRow.context });
        check(caseRow, result);
      });
    }
  } finally { await runner.close(); }
});

module.exports = { check };

test("catalog admin card renders translated labels and treats provider metadata as text", async () => {
  const vm = require("node:vm");
  const ejs = require("ejs");
  const locale = require("../locales/en.json");
  const view = fs.readFileSync(path.join(__dirname, "../views/mediaAdmin.ejs"), "utf8");
  const card = view.slice(view.indexOf('  <section class="sb-card" id="plexCatalog"'), view.indexOf("  <% if (libraryOk)"));
  const html = ejs.render(card, { t: key => { assert.ok(locale[key], key); return locale[key]; } });
  assert.ok(html.includes("Read-only count") && html.includes("Sync now"));
  assert.ok(!html.includes("undefined"));
  const nodes = new Map(), calls = [], timers = new Map();
  let timerId = 0;
  function element(tag) {
    return { tag, children: [], textContent: "", handlers: {}, disabled: false,
      get firstChild() { return this.children[0] || null; },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      set innerHTML(value) { throw new Error("Catalog metadata must not become HTML"); },
    };
  }
  for (const id of ["pcOut", "pcSync", "pcDry", "pcRefresh", "pcMsg"]) { const n = element("div"); n.style = {}; nodes.set(id, n); }
  let status = { ok: true, ready: true, allow_list_set: true, version: "1.7.0", count: 496, at: 1793872800000,
    full_at: 1793872800000, sections: [{ id: "71", title: '<img src=x onerror="unsafe()">', type: "movie", policy: "allowed", count: 126 },
      { id: "73", title: "Synthetic Hidden Name", type: "movie", policy: "adult", count: 1 }] };
  const document = { hidden: false, getElementById: id => nodes.get(id) || null,
    createElement: element, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const context = { document, window: { addEventListener() {}, __t(key, fallback, values) {
    assert.ok(locale[key], key); return fallback.replace(/\{(\w+)\}/g, (m, n) => values && values[n] != null ? String(values[n]) : m);
  } }, console, Promise, Date, Number,
  setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
  fetch(url, options) {
    calls.push([url, options]);
    let result;
    if (url === "/api/media/admin/checks") result = { ok: true, checks: {} };
    else if (url.endsWith("/catalog/dry")) result = { ...status, dry: true, allowed_count: 496 };
    else if (url.endsWith("/catalog/sync")) { status = { ...status, syncing: true }; result = { ok: true, started: true }; }
    else { assert.equal(url, "/api/media/admin/catalog"); result = status; }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/media-admin.js"), "utf8"), context);
  const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)); };
  const text = node => [node.textContent, ...node.children.map(text)].join(" ");
  await flush();
  assert.match(text(nodes.get("pcOut")), /496 titles/);
  assert.match(text(nodes.get("pcOut")), /<img src=x/);
  assert.ok(!text(nodes.get("pcOut")).includes("Synthetic Hidden Name"));
  nodes.get("pcDry").handlers.click(); await flush();
  assert.match(text(nodes.get("pcOut")), /catalog was not changed/);
  nodes.get("pcSync").handlers.click(); await flush();
  assert.match(text(nodes.get("pcOut")), /sync is running/);
  assert.equal(nodes.get("pcSync").disabled, false);
  assert.equal(timers.size, 1, "one status poll during sync");
  assert.ok(calls.every(([, options]) => options.credentials === "same-origin"));
});
