"use strict";
// newstream 1.99ala (owner 2026-11-05: "When a new stream is created, the website isnt aware of it so you need to refresh to see it. Thats
// annoying."): the homepage's pieces that only learned about a stream at load:
//   1. Top Pads' "now playing" line of a SITE pad (no Camfrog room) - /api/home/nowplaying read the bridge's summary only, so a site pad's id
//      was never answered and its line never moved after load (rooms.withSitePads: the rows the page's Top Pads come from)
// Each test failed on 1.99akr (eaaf29c9).
//   node --test test/newstream-home.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "newstream-home-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const bridge = require(path.join(repo, "bridge"));
const MS = require(path.join(repo, "mainstage"));
const home = require(path.join(repo, "home"));

let server, base;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await rooms.init();
  const app = express();
  home.register(app, { addUser: (req, res, next) => next(), xpForNextLevel: () => 100 });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => new Promise((r) => server.close(r)));

const PS = require(path.join(repo, "padsignals"));
test("1: a site pad's Top Pads line follows a stream that started after load (/api/home/nowplaying answers site pads)", async () => {
  const keep = { summary: bridge.summary, sitePads: PS.sitePads, publicSlots: MS.publicSlots };
  let slots = [];
  bridge.summary = async () => [{ id: "Cf.Room", slug: "cf-room", name: "Cf Room", live: true, count: 3, micCount: 0, mic: [] }];
  // (the listed pads without a Camfrog room, from the registry's cache)
  PS.sitePads = () => [{ id: "Site.Pad", slug: "site-pad", title: "Site Pad" }];
  MS.publicSlots = async () => slots;
  try {
    const ask = async () => (await fetch(base + "/api/home/nowplaying?ids=Site.Pad,Cf.Room")).json();
    let d = await ask();
    assert.equal(d.ok, true);
    assert.ok("Site.Pad" in d.np, "the site pad is answered");
    assert.equal(d.np["Site.Pad"], null, "nothing on yet");
    slots = [{ id: "s1", room_id: "Site.Pad", display: "Juniper", title: "Fresh set", hls: "/x.m3u8", featured: true }];
    d = await ask();
    assert.deepEqual(d.np["Site.Pad"], { k: "stage", name: "Juniper", title: "Fresh set" }, "🎥 Juniper — Fresh set, no refresh");
    assert.ok("Cf.Room" in d.np, "Camfrog pads as before");
  } finally { Object.assign(bridge, { summary: keep.summary }); PS.sitePads = keep.sitePads; MS.publicSlots = keep.publicSlots; }
});

test("1b: the line reads no site activity - never padsignals' feed / watch scans (rooms.withSitePads: four queries + engagement on a cold cache) (review L3)", async () => {
  const keep = { summary: bridge.summary, sitePads: PS.sitePads, rows: PS.rows, withSitePads: rooms.withSitePads, publicSlots: MS.publicSlots, isListed: rooms.isListed };
  let scans = 0;
  bridge.summary = async () => [{ id: "Cf.Room", slug: "cf-room", name: "Cf Room", live: true, count: 3, micCount: 0, mic: [] },
                                { id: "Cf.Hidden", slug: "cf-hidden", name: "Unlisted", live: true, count: 2, micCount: 0, mic: [] }];
  PS.sitePads = () => [{ id: "Site.Pad", slug: "site-pad", title: "Site Pad" }, { id: "Site.Other", slug: "site-other", title: "Other" }];
  PS.rows = async () => { scans++; return [{ id: "Site.Pad", slug: "site-pad", name: "Site Pad", live: true, site: true }]; };
  rooms.withSitePads = async (sum) => { scans++; return (sum || []).concat([{ id: "Site.Pad", slug: "site-pad", name: "Site Pad", live: true, site: true }]); };
  rooms.isListed = (id) => id !== "Cf.Hidden";
  MS.publicSlots = async () => [{ id: "s1", room_id: "Site.Pad", display: "Juniper", title: "Fresh set", hls: "/x.m3u8", featured: true },
                                { id: "s2", room_id: "Cf.Hidden", display: "Aster", title: "Unlisted set", hls: "/y.m3u8", featured: true }];
  try {
    const d = await (await fetch(base + "/api/home/nowplaying?ids=Site.Pad,Cf.Room,Cf.Hidden")).json();
    assert.equal(d.ok, true);
    assert.deepEqual(d.np["Site.Pad"], { k: "stage", name: "Juniper", title: "Fresh set" });
    assert.equal(scans, 0, "no site-activity read");
    assert.ok(!("Site.Other" in d.np), "only the pads asked about");
    assert.ok(!("Cf.Hidden" in d.np), "an unlisted pad is never answered");
  } finally {
    Object.assign(bridge, { summary: keep.summary }); Object.assign(PS, { sitePads: keep.sitePads, rows: keep.rows });
    Object.assign(rooms, { withSitePads: keep.withSitePads, isListed: keep.isListed }); MS.publicSlots = keep.publicSlots;
  }
});

// ── 2. the homepage stage's "Next up" + the old homepage's pad name: drawn once at load, now from the stage's own 10 s poll ──
const ejs = require("ejs");
const vm = require("vm");
const BM = require(path.join(repo, "boostmark"));
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const FRONT = { id: "Night.Orchard", slug: "night-orchard", title: "Night Orchard", pinned: false, owner: null, boost: 1500 };
const renderHome = (locals = {}) => ejs.renderFile(path.join(repo, "views", "home.ejs"), Object.assign({
  username: null, me: null, mine: null, S: {}, rooms: [], room: null, roomLive: null, stage: { active: false }, top: [], tops: [],
  story: { rooms: [], caps: [], room: null, signed: false }, hot: null, fx: {}, roomOnStage: false, stageAdmin: null,
  frontInfo: FRONT, pepeHere: true, featuredPrice: 0, slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "",
  boostMark: BM.boostMark, ul: (n) => String(n == null ? "" : n) }, locals));

/** the old homepage's stage script against stub nodes -> {o: the switcher's options, nodes} */
async function oldSlate(locals) {
  const html = await renderHome(locals);
  const at = html.indexOf("PATVStage.switcher({", html.indexOf("function slateNext"));
  assert.ok(at > 0, "the old homepage's stage script");
  const from = html.lastIndexOf("var stageEl = document.getElementById('stage');", at), to = html.indexOf("});", at) + 3;
  const js = html.slice(from, to);
  const mkEl = (tag, extra) => Object.assign({ tag, children: [], attrs: {}, className: "", textContent: "", parentNode: null,
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); if (c.text != null) this.textContent += c.text; else this.textContent += c.textContent; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }, classList: { toggle() {} } }, extra || {});
  const acts = mkEl("div"), stRoom = mkEl("span"), roomOn = mkEl("a", { textContent: "Night Orchard" }), slPad = mkEl("b", { textContent: "Night Orchard" });
  const badge = mkEl("span", { className: "bm boost-mark" }), go1 = mkEl("a"), go2 = mkEl("a"), parent = mkEl("div");
  parent.appendChild(stRoom); parent.appendChild(badge); stRoom.nextElementSibling = badge;
  const ids = { stage: mkEl("section"), stPill: mkEl("span"), stPillTxt: mkEl("span"), stSub: mkEl("span"), stRoom, slPad };
  const hasNext = /id="slNext"/.test(html), hasBrowse = /id="slBrowse"/.test(html);
  if (hasNext) { ids.slNext = mkEl("span", { id: "slNext", textContent: "Next up: old" }); acts.appendChild(ids.slNext); }
  if (hasBrowse) { ids.slBrowse = mkEl("a", { id: "slBrowse", textContent: "Browse Top Pads" }); acts.appendChild(ids.slBrowse); }
  let o = null;
  const document = { getElementById: (id) => { if (ids[id] && ids[id].parentNode !== null || ["stage", "stPill", "stPillTxt", "stSub", "stRoom", "slPad"].includes(id)) return ids[id] || null; return null; },
    querySelector: (s) => (s === "#stRoom .room-on" ? roomOn : s === "#stSlate .sl-acts" ? acts : null),
    querySelectorAll: (s) => (s === "#stSlate .golive-btn, #stageShow .golive-btn" ? [go1, go2] : []),
    createElement: (tag) => { const e = mkEl(tag); Object.defineProperty(e, "id", { set(v) { this._id = v; ids[v] = e; }, get() { return this._id; } }); return e; },
    createTextNode: (text) => ({ text }) };
  const ctx = { document, console, PATVTime: { format: (ts) => "AT " + ts },
    PATVStage: { capture: () => ({ update() {}, reload() { ctx.reloaded = (ctx.reloaded || 0) + 1; } }), switcher: (opts) => { o = opts; return {}; } } };
  ctx.window = ctx;
  vm.runInNewContext("var _t = function (k, d) { return d; }; var initSlots = []; var stCap = PATVStage.capture(); var frontSlug = " + JSON.stringify(FRONT.slug) + ";\n" + js.replace(/^[\s\S]*?(function frontNamed)/, "$1").replace(/var initSlots[^\n]*\n/, "").replace(/var frontSlug[^\n]*\n/, ""), ctx);
  return { o, ids, acts, roomOn, slPad, badge, go: [go1, go2], ctx, html };
}

test("2a: the old homepage - after a front-page change the header and the slate name the NEW pad (its stream played under the old name)", async () => {
  const s = await oldSlate({});
  assert.equal(typeof s.o.onPoll, "function");
  s.o.onPoll({ front: { id: "Plain.Pad", slug: "plain-pad", title: "Plain Pad" }, slots: [] });
  assert.equal(s.roomOn.textContent, "Plain Pad"); assert.equal(s.roomOn.attrs.href, "/p/plain-pad");
  assert.equal(s.slPad.textContent, "Plain Pad");
  assert.deepEqual(s.go.map((g) => g.attrs.href), ["/stage?room=plain-pad", "/stage?room=plain-pad"], "Go live goes to the pad on the front page");
  assert.equal(s.badge.parentNode, null, "the old pad's 🚀 badge goes");
  assert.equal(s.ctx.reloaded, 1, "the capture row follows it, as before");
});

test("2b: the slate's \"Next up\" follows the poll - a booking made since appears, one that's gone gives way to Browse Top Pads", async () => {
  const s = await oldSlate({ nextUp: null });
  assert.ok(s.ids.slBrowse && !s.ids.slNext, "no booking at load: Browse Top Pads");
  s.o.onPoll({ front: { slug: "night-orchard", title: "Night Orchard" }, next: { display: "Willow", title: "Late set", start_at: 1234 } });
  assert.equal(s.ids.slNext.textContent, "Next up: Willow · Late set · AT 1234");
  assert.equal(s.ids.slBrowse.parentNode, null, "one or the other, as the server renders it");
  s.o.onPoll({ front: { slug: "night-orchard", title: "Night Orchard" }, next: null });
  assert.equal(s.ids.slNext.parentNode, null);
  assert.ok(s.acts.children.some((c) => c.id === "slBrowse" && c.textContent === "Browse Top Pads"));
  s.o.onPoll({ front: { slug: "night-orchard", title: "Night Orchard" } });
  assert.ok(s.acts.children.some((c) => c.id === "slBrowse"), "an answer without `next` (a pad page's) moves nothing");
  assert.match(read("locales", "en.json"), /"js\.home\.slate\.next_up": "Next up:"/);
});

test("2b2: the slate's \"Next up\" is written only when the booking changed - #stSlate is role=status, a rewrite every 10 s is read out again (review F4)", async () => {
  const n = { display: "Willow", title: "Late set", start_at: 2e12 };
  const s = await oldSlate({ nextUp: n });
  assert.ok(s.ids.slNext && !s.ids.slBrowse, "booked at load: Next up");
  let writes = 0;
  const count = (node) => {
    const a = node.appendChild, r = node.removeChild;
    node.appendChild = function (c) { writes++; return a.call(this, c); };
    node.removeChild = function (c) { writes++; return r.call(this, c); };
    let t = node.textContent;
    Object.defineProperty(node, "textContent", { get: () => t, set: (v) => { writes++; t = v; } });
  };
  count(s.ids.slNext); count(s.acts);
  const front = { slug: "night-orchard", title: "Night Orchard" };
  for (let i = 0; i < 3; i++) s.o.onPoll({ front, next: Object.assign({}, n) });
  assert.equal(writes, 0, "the booking the page was rendered with: nothing written, poll after poll");
  s.o.onPoll({ front, next: { display: "Willow", title: "Later set", start_at: 2e12 } });
  assert.ok(writes > 0, "a changed booking is written");
  assert.match(s.ids.slNext.textContent, /Later set/);
  const w = writes;
  s.o.onPoll({ front, next: { display: "Willow", title: "Later set", start_at: 2e12 } });
  assert.equal(writes, w, "the same again: nothing");
  // none at load (Browse Top Pads) and none in the poll: nothing either
  const e = await oldSlate({ nextUp: null });
  let ew = 0; const ea = e.acts.appendChild; e.acts.appendChild = function (c) { ew++; return ea.call(this, c); };
  e.o.onPoll({ front, next: null }); e.o.onPoll({ front, next: null });
  assert.equal(ew, 0);
  // the key the page starts from is a script string: a title with markup stays text (escaped), and still matches the poll's
  const m = { display: "Wil<low", title: "a</script><b>", start_at: 2e12 };
  const x = await oldSlate({ nextUp: m });
  assert.ok(!x.html.includes("a</script><b>"), "never raw in the page");
  let xw = 0; const xa = x.ids.slNext.appendChild; x.ids.slNext.appendChild = function (c) { xw++; return xa.call(this, c); };
  x.o.onPoll({ front, next: Object.assign({}, m) });
  assert.equal(xw, 0);
});

test("2c: /api/stage carries the shown pad's next booking on the homepage's answers only, cached per pad (home.nextUpCached)", async () => {
  const src = read("bridge.js");
  assert.match(src, /if \(home\) next = await require\("\.\/home"\)\.nextUpCached\(R\.id\)\.catch\(\(\) => null\);/);
  assert.match(src, /\.\.\.\(next !== undefined \? \{ next \} : \{\}\)/);
  const keep = MS.futureSlots; let reads = 0;
  MS.futureSlots = async () => { reads++; return [{ status: "scheduled", start_at: 2e12, displayname: "Willow", title: "Late set" }]; };
  try {
    home._nextReset();
    const a = await home.nextUpCached("Pad.A", 1e12), b = await home.nextUpCached("Pad.A", 1e12 + 5000);
    assert.deepEqual(a, { display: "Willow", title: "Late set", start_at: 2e12 }); assert.deepEqual(b, a);
    assert.equal(reads, 1, "every viewer's 10 s poll: one read per pad per 15 s");
    await home.nextUpCached("Pad.A", 1e12 + 16000); assert.equal(reads, 2);
    assert.equal(await home.nextUpCached("", 1e12), null);
  } finally { MS.futureSlots = keep; home._nextReset(); }
  // the Dock's off-air bar does the same from home-dock.js (v6)
  const hd = read("public", "js", "home-dock.js");
  assert.match(hd, /if \(Object\.prototype\.hasOwnProperty\.call\(g, 'next'\)\) nextChanged\(g\.next\);/);
  assert.match(hd, /function nextChanged\(n\) \{/);
  assert.match(read("views", "home.ejs"), /home-dock\.js\?v=7/);   // (upnext2: v7 - the stage asks at once on the long-poll's stage version)
});
