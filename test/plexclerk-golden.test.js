"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fixtureRunner, rawLine } = require("../tools/clerk-find");
const fixture = require("./fixtures/clerk_catalog.json");
const evaluation = require("./fixtures/clerk_eval.json");
const PHASES = new Set(["1", "2a", "2b"]);

function check(caseRow, result) {
  const expected = caseRow.expect, rows = result.rows || [];
  if (expected.recall) assert.ok((result.recall || []).some(r => r.status === expected.recall), "recall status");
  if (expected.match) assert.ok((result.recall || []).some(r => r.match === expected.match), "recall match");
  if (expected.request) {
    const mode = result.seerr ? result.request && result.request.may ? "offer" : "link" : "none";
    assert.equal(mode, expected.request, "verified request offer/link only");
  }
  if (expected.season != null && result.seerr) assert.equal(result.seerr.season, expected.season);
  if (expected.newer) assert.ok(result.seerr && result.seerr.year > Math.max(...rows.map(r => r.year || 0)), "newer release note");
  if (caseRow.context.adult || ["pm", "tg"].includes(caseRow.context.via) || caseRow.context.requests === false) assert.equal(result.lookup_count, 0, "no external lookup in restricted context");
  if (expected.max_rows) assert.ok(rows.length <= expected.max_rows);
  if (caseRow.phase === "2b") {
    if (caseRow.context.embed_down || expected.recall === "in") assert.equal(result.vector_count, 0, "no vector search on down/verified recall");
    else assert.equal(result.vector_count, 1, "one filtered vector search");
  }
  if (expected.code === "none") { assert.equal(rows.length, 0, "no library match"); return; }
  if (expected.code) { assert.equal(result.code, expected.code); return; }
  assert.ok(rows.length > 0, "expected a verified catalog pick");
  const keys = rows.flatMap(r => r.keys || [r.key]);
  const source = keys.map(key => fixture.rows.find(r => r.key === key));
  assert.ok(source.every(Boolean), "all output keys are in the fixture catalog");
  assert.ok(source.every(r => ["71", "72"].includes(r.section) && r.content_rating !== "X"), "no denied row escapes");
  if (expected.keys) {
    if (caseRow.embed) {
      const top3 = rows.slice(0, 3).flatMap(row => row.keys || [row.key]);
      assert.ok(expected.keys.every(key => top3.includes(key)), "expected vector candidate in top3 before the bot rerank");
    } else assert.deepEqual(keys, expected.keys, "verified key/order");
  }
  if (expected.exclude) assert.ok(keys.every(key => !expected.exclude.includes(key)), "reference excluded");
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

test("phase 1 through 2b golden selections use the real catalog and finder", async t => {
  const runner = await fixtureRunner(fixture);
  try {
    for (const caseRow of evaluation.cases.filter(c => PHASES.has(c.phase) && !c.expect.not_ours)) {
      await t.test(caseRow.id, async () => {
        const result = await runner.find({ id: caseRow.id, ask: caseRow.expect_interp, raw: rawLine(caseRow.line), context: caseRow.context });
        check(caseRow, result);
      });
    }
  } finally { await runner.close(); }
});

module.exports = { check };

test("embedding comparison disables real searches, and fixture documents stay within catalog policy", async () => {
  const runner = await fixtureRunner(fixture);
  try {
    const cases = evaluation.cases.filter(row => row.embed);
    let enabledHits = 0, disabledHits = 0;
    for (const row of cases) {
      const ask = { id: row.id, ask: row.expect_interp, raw: rawLine(row.line), context: row.context };
      const enabled = await runner.find(ask), disabled = await runner.find({ ...ask, no_embed: true });
      const hit = result => row.expect.keys.every(key => result.rows.slice(0, 3).some(candidate => (candidate.keys || [candidate.key]).includes(key)));
      enabledHits += Number(hit(enabled)); disabledHits += Number(hit(disabled));
      assert.equal(disabled.vector_count, 0);
      if (row.context.embed_down || row.expect.recall === "in") assert.deepEqual(enabled.rows, disabled.rows);
    }
    assert.equal(enabledHits, cases.length);
    assert.ok(enabledHits > disabledHits, "toy concept vectors demonstrate the intended plumbing difference");
    const docs = await runner.find({ op: "documents", context: {} });
    const allowed = new Set(fixture.sections.filter(row => row.policy === "allowed").map(row => row.id));
    assert.ok(docs.rows.length > 0);
    for (const row of docs.rows) {
      const original = fixture.rows.find(candidate => candidate.key === row.key);
      assert.ok(allowed.has(original.section));
      assert.ok(!["X", "XXX", "AO", "R18", "R18+"].includes(original.content_rating));
      assert.ok(row.text.length <= 1200); assert.match(row.hash, /^[a-f0-9]{64}$/);
    }
  } finally { await runner.close(); }
});

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
    full_at: 1793872800000, embed: { enabled: true, ready: true, done: 8, left: 488, model: "fixture-concepts", dim: 8 }, sections: [{ id: "71", title: '<img src=x onerror="unsafe()">', type: "movie", policy: "allowed", count: 126 },
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
  assert.match(text(nodes.get("pcOut")), /8 ready.*488 left/);
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
