"use strict";
// newstream 1.99akv (owner 2026-11-05: "When a new stream is created, the website isnt aware of it so you need to refresh to see it. Thats
// annoying."): the pads list (/p, views/rooms.ejs) had no script at all - a stream going live or ending, a booking, Pepe on air, a pad's room
// going live never showed until a reload. padsonair.js answers GET /api/pads/onair with a short signature of what the cards show (one shared
// snapshot every 10 s for the whole site); the page asks every 30 s while visible and swaps its sections only when it moved.
// Each test failed on 1.99akr (eaaf29c9).
//   node --test test/newstream-pads.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "newstream-pads-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const ejs = require("ejs");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

const slot = (id, extra) => Object.assign({ id, display: "Juniper", username: "juniper", live: true, featured: false, title: "Fresh set", mode: "stream" }, extra || {});
const row = (id, extra) => Object.assign({ id, slug: id.toLowerCase(), title: id, live: true, bridged: true, count: 5, micCount: 1, slot_count: 2, pepe_here: false, now: [], next: [] }, extra || {});

test("1: the signature moves with what a stage shows - a slot live / ended / featured / retitled, a booking, a room going live, Pepe - not with headcounts", () => {
  const PO = require(path.join(repo, "padsonair"));
  const base = [row("A"), row("B", { live: false })];
  const s0 = PO.sigOf(base, { active: false });
  assert.equal(typeof s0, "string"); assert.ok(s0.length >= 8 && s0.length <= 16);
  assert.equal(PO.sigOf([base[1], base[0]], { active: false }), s0, "the order of the rows doesn't matter");
  assert.equal(PO.sigOf([row("A", { count: 40, micCount: 9, followers: 3 }), base[1]], { active: false }), s0, "headcounts never refetch the page");
  const moved = {
    "a stream went live": [row("A", { now: [slot("s1")] }), base[1]],
    "it is starting (not live yet)": [row("A", { now: [slot("s1", { live: false })] }), base[1]],
    "featured": [row("A", { now: [slot("s1", { featured: true })] }), base[1]],
    "a new title (📼 next)": [row("A", { now: [slot("s1", { title: "📼 Next one" })] }), base[1]],
    "a booking": [row("A", { next: [{ id: "b1", start_at: 123, title: "Late set" }] }), base[1]],
    "the room went live": [base[0], row("B", { live: true })],
    "Pepe is in the pad": [row("A", { pepe_here: true }), base[1]],
  };
  const seen = new Set([s0]);
  for (const [why, rows] of Object.entries(moved)) { const s = PO.sigOf(rows, { active: false }); assert.ok(!seen.has(s), why); seen.add(s); }
  assert.notEqual(PO.sigOf(base, { active: true }), s0, "Pepe on air");
});

test("2: one shared snapshot (10 s) for every viewer - the guide and the bridge are read once per window, then the new stream shows", async () => {
  const PO = require(path.join(repo, "padsonair"));
  const MS = require(path.join(repo, "mainstage")), B = require(path.join(repo, "bridge")), PA = require(path.join(repo, "padaccess"));
  const keep = { guide: MS.guide, summary: B.summary, stage: B.stage, pepeIn: B.pepeIn, init: PA.init, canSee: PA.canSee, camVisible: PA.camVisible };
  let T = 1e12, guides = 0, now = [];
  PO._setClock(() => T); PO._reset();
  MS.guide = async () => { guides++; return new Map([["Pad.A", { now: now.slice(), next: [] }]]); };
  B.summary = async () => [{ id: "Pad.A", live: true }, { id: "Pad.B", live: false }];
  B.stage = () => ({ active: false }); B.pepeIn = () => false;
  PA.init = async () => {}; PA.canSee = (v, id) => id !== "Pad.B"; PA.camVisible = (v) => !!v;
  try {
    const a = await PO.sigFor(null), b = await PO.sigFor({ userId: "u1" });
    assert.equal(guides, 1, "two viewers, one read");
    now = [slot("s1")];
    T += 5000;
    assert.equal(await PO.sigFor(null), a, "inside the window: the snapshot");
    T += PO.SNAP_MS;
    const c = await PO.sigFor(null);
    assert.equal(guides, 2);
    assert.notEqual(c, a, "the stream that started is in the next window");
    // a 🎬 cam slot counts only for a viewer who may see the pad's live room; a pad the viewer can't see never counts
    now = [slot("s1"), slot("c1", { cam: true })];
    T += PO.SNAP_MS;
    assert.equal(await PO.sigFor(null), c, "signed out: the cam isn't on their card");
    assert.notEqual(await PO.sigFor({ userId: "u1" }), b);
    assert.ok(b);
  } finally {
    Object.assign(MS, { guide: keep.guide }); Object.assign(B, { summary: keep.summary, stage: keep.stage, pepeIn: keep.pepeIn });
    Object.assign(PA, { init: keep.init, canSee: keep.canSee, camVisible: keep.camVisible }); PO._setClock(null); PO._reset();
  }
});

// ── the page ──
const renderPads = (extra) => ejs.renderFile(path.join(repo, "views", "rooms.ejs"), {
  user: null, signedIn: true, staff: false, owned: [], pepe: { active: false }, ul: (n) => String(n), rows: [row("A")], followRows: [], ...extra });

test("3a: /p carries its signature and the ids of the sections it swaps; no signature (an old render) = no script", async () => {
  const html = await renderPads({ onairSig: "sigONE" });
  assert.match(html, /<main class="ds-page wide cg" data-onair="sigONE">/);
  for (const id of ["following", "padsPepe", "trending", "padsAll", "padsSched"]) assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.match(html, /fetch\('\/api\/pads\/onair'/);
  const old = await renderPads({});
  assert.doesNotMatch(old, /data-onair|\/api\/pads\/onair/);
  assert.match(read("bridge.js"), /require\("\.\/padsonair"\)\.register\(app, \{ addUser \}\);/);
  assert.match(read("bridge.js"), /res\.render\("rooms", \{ followRows, onairSig,/);
});

test("3b: the script - asks every 30 s and on coming back, never while hidden; swaps the sections only when the signature moved; keeps the focused link", async () => {
  const html = await renderPads({ onairSig: "sigONE" });
  const at = html.indexOf("fetch('/api/pads/onair'");
  const js = html.slice(html.lastIndexOf("<script>", at) + 8, html.indexOf("</script>", at));
  const IDS = ["following", "padsPepe", "trending", "padsAll", "padsSched"];
  const node = (id, gen) => ({ id, gen, parentNode: null, contains(x) { return x === this.link; }, link: { getAttribute: (k) => (k === "href" ? "/p/a" : null) } });
  const page = {}, links = [];
  const parent = { replaceChild(neu, old) { page[old.id] = neu; neu.parentNode = parent; } };
  for (const id of IDS) { page[id] = node(id, 0); page[id].parentNode = parent; }
  let hidden = false, answer = "sigONE", pageFetches = 0, focused = null, timer = null;
  const vis = [];
  const docNew = (sig) => ({ querySelector: (s) => (s === "main.cg" ? { getAttribute: () => sig } : null), getElementById: (id) => node(id, 1) });
  const ctx = { console,
    document: { get hidden() { return hidden; }, body: {}, activeElement: null, querySelector: (s) => (s === "main.cg" ? { getAttribute: () => "sigONE" } : null),
      getElementById: (id) => page[id] || null, importNode: (n) => Object.assign({}, n, { imported: true, parentNode: null }),
      querySelectorAll: () => links, addEventListener: (k, f) => { if (k === "visibilitychange") vis.push(f); } },
    location: { pathname: "/p", search: "?platform=site" }, DOMParser: function () { this.parseFromString = (h) => docNew(h); },
    setInterval: (f, ms) => { assert.equal(ms, 30000, "one 30 s turn"); timer = f; return 1; },
    fetch: (url) => {
      if (url === "/api/pads/onair") return Promise.resolve({ json: () => Promise.resolve({ ok: true, sig: answer }) });
      pageFetches++; assert.equal(url, "/p?platform=site", "the same page, its filter kept");
      return Promise.resolve({ ok: true, text: () => Promise.resolve(answer) });
    } };
  ctx.window = ctx; ctx.window.PATVChipFit = { run() { ctx.chipfit = (ctx.chipfit || 0) + 1; } };
  vm.runInNewContext(js, ctx);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  timer(); await settle();
  assert.equal(pageFetches, 0, "the same signature: nothing fetched, nothing swapped");
  assert.ok(IDS.every((id) => page[id].gen === 0));
  answer = "sigTWO";
  hidden = true; timer(); await settle();
  assert.equal(pageFetches, 0, "hidden: not even the signature");
  hidden = false;
  ctx.document.activeElement = page.padsAll.link;
  links.push({ getAttribute: (k) => (k === "href" ? "/p/a" : null), focus() { focused = "/p/a"; } });
  vis.forEach((f) => f()); await settle();
  assert.equal(pageFetches, 1, "back in view: asked at once, and the list moved - the page again");
  assert.ok(IDS.every((id) => page[id].gen === 1 && page[id].imported), "every section swapped");
  assert.equal(focused, "/p/a", "the focused card is focused again");
  assert.equal(ctx.chipfit, 1, "the badges re-fitted");
  timer(); await settle();
  assert.equal(pageFetches, 1, "the new signature is the page's now");
});
