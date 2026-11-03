// 1.99ahm: A/V sync's two new mic switches on the real pages - "Delay the On the mic card" (avsync apply_mic_card) and "Delay mic
// grab/drop lines in chat" (apply_mic_chat). The pad page's script (views/room.ejs) and the homepage panel's (views/home.ejs), rendered
// with ejs, run in a small fake DOM with the REAL controller (public/js/av-sync.js) and renderer (public/js/chatlog-core.js) on one
// fake clock; the long poll is answered by the test. Room audio here is MP3 with an empty buffer, so the mic-sign offset is
// 1000 (Pepe's MP3 latency) + 0 (browser buffer) + 0 (calibration) - 300 (delivery time) = 700 ms.
//   node --test test/avsync-micsigns.test.js      (needs the repo's node_modules: ejs; no database, no network)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const CORE_SRC = rd("public", "js", "chatlog-core.js"), AVS_SRC = rd("public", "js", "av-sync.js");
const CL = require(path.join(repo, "public", "js", "chatlog-core.js"));
const D = 700;

// ── a small DOM (chatlog-page.test.js's, + isConnected: av-sync.js never holds a line that isn't in the page) ──
class FakeText {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
}
class FakeStyle {
  constructor() { this._d = {}; }
  set cssText(v) { this._d = {}; for (const part of String(v || "").split(";")) { const i = part.indexOf(":"); if (i > 0) this._d[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().replace(/\s+/g, " "); } }
  get cssText() { return Object.keys(this._d).sort().map((k) => k + ":" + this._d[k]).join(";"); }
  setProperty(k, v) { this._d[k] = String(v); }
}
class FakeEl {
  constructor(tag, doc) {
    this.nodeType = tag === "#fragment" ? 11 : 1; this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc;
    this.attrs = {}; this.childNodes = []; this.parentNode = null; this.style = new FakeStyle(); this._cls = [];
    this.listeners = {}; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 0; this.hidden = false;
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.body; }
  get className() { return this._cls.join(" "); }
  set className(v) { this._cls = String(v).split(/\s+/).filter(Boolean); }
  get classList() {
    const me = this;
    return { add: (...c) => c.forEach((x) => { if (!me._cls.includes(x)) me._cls.push(x); }), remove: (...c) => { me._cls = me._cls.filter((x) => !c.includes(x)); },
             contains: (c) => me._cls.includes(c), toggle: (c, on) => { const has = me._cls.includes(c); const want = on === undefined ? !has : !!on; if (want && !has) me._cls.push(c); if (!want && has) me._cls = me._cls.filter((x) => x !== c); return want; } };
  }
  setAttribute(k, v) { if (k === "class") this.className = v; else this.attrs[k] = String(v); }
  getAttribute(k) { return k === "class" ? this.className : k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = v == null || v === "" ? [] : [Object.assign(new FakeText(v), { parentNode: this })]; }
  _take(n) {
    if (n.nodeType === 11) { const kids = n.childNodes.slice(); n.childNodes = []; return kids; }
    if (n.parentNode) n.parentNode.removeChild(n);
    return [n];
  }
  appendChild(n) { for (const k of this._take(n)) { k.parentNode = this; this.childNodes.push(k); } return n; }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    const kids = this._take(n);
    const i = this.childNodes.indexOf(ref);
    assert.ok(i >= 0, "insertBefore: ref is a child");
    kids.forEach((k) => { k.parentNode = this; });
    this.childNodes.splice(i, 0, ...kids);
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); assert.ok(i >= 0, "removeChild: a child"); this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  focus() {}
  matches(sel) {
    const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/i.exec(sel.trim());
    if (!m) throw new Error("selector not supported by the fake DOM: " + sel);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const c of m[2].split(".").filter(Boolean)) if (!this._cls.includes(c)) return false;
    return !m[3] || this.attrs[m[3]] === m[4];
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const k of n.childNodes) if (k.nodeType === 1) { if (k.matches(sel)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function fakeDocument(ids) {
  const doc = { documentElement: { lang: "en", dir: "ltr" }, hidden: false, listeners: {} };
  doc.body = new FakeEl("body", doc);
  doc.createElement = (t) => new FakeEl(t, doc);
  doc.createTextNode = (t) => new FakeText(t);
  doc.createDocumentFragment = () => new FakeEl("#fragment", doc);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); };
  doc.fire = (type) => (doc.listeners[type] || []).forEach((fn) => fn({ type }));
  doc.querySelector = () => null;
  doc.querySelectorAll = () => [];
  const byId = {};
  doc.getElementById = (id) => {
    if (!(id in ids)) return null;
    if (!byId[id]) { const e = new FakeEl(ids[id].tag || "div", doc); e.id = id; Object.assign(e.attrs, ids[id].attrs || {}); if (ids[id].text != null) e.textContent = ids[id].text; doc.body.appendChild(e); byId[id] = e; }
    return byId[id];
  };
  return doc;
}
function tree(n) {
  if (n == null) return null;
  if (n.nodeType === 3) return n.data;
  const a = Object.assign({}, n.attrs);
  if (n.className) a.class = n.className;
  if (n.style.cssText) a.style = n.style.cssText;
  const k = [];
  for (const c of n.childNodes.map(tree)) {
    if (typeof c === "string") { if (!c) continue; if (typeof k[k.length - 1] === "string") k[k.length - 1] += c; else k.push(c); } else k.push(c);
  }
  return { t: n.tagName.toLowerCase(), a, k };
}
const tEN = (k, d, v) => { if (d && typeof d === "object") d = v && v.count === 1 ? d.one : d.other; return String(d).replace(/\{!?(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)); };

// ── one fake clock for the page and the controller ──
function fakeClock(start) {
  let now = start, seq = 0;
  const timers = new Map();
  const setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms; let turns = 0;
    await flush();
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
      if (!next) break;
      if (++turns > 20000) throw new Error("timer loop");
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } }
  return { setTimeout, clearTimeout, flush, advance, Date: FakeDate, now: () => now };
}

const T0 = Date.UTC(2026, 10, 2, 19, 0);
const BOB = { login: "bob", display: "Bob" }, ALICE = { login: "alice", display: "Alice" };
// a veiled holder as the site sends them (chatlogview VEIL_U / VEIL_ROSTER_U): a frog name, an opaque id, never a login
const FROG = { anon: true, display: "someone", veil: "incognito", alias: "Soggy Bullfrog", hood: "h3", id: "opaque-7f" };
const on = (u) => Object.assign({}, u, { on_mic: true });
function baseConfig() {
  return { ok: true, on: true, dbg: false, audio: { rtc_ms: 1000, mp3_ms: 1000, mix_ms: 700, helper_ms: 270, age_s: 0 }, cams: {},
    k: { pt: 0, re: 0, ind: 0 }, fallback: { rtc: 500, mp3: 1500 }, cap: 3000, cap_ind: 3000, deadband: 40, period_s: 2,
    apply: { video: true, mic: true, mp3: true, mic_card: true, mic_chat: true, mic_list: true }, engines: { chromium: true, firefox: false, safari: false },
    ind_path_ms: 300, mods_instant: false };
}

/** Runs a page script with (avsync) or without the controller; the long poll is answered by deliver(). */
function harness({ script, json, ids, avsync, config, playFirst, slug }) {
  const clock = fakeClock(T0);
  const doc = fakeDocument(Object.assign({ [ids.init]: { tag: "script", text: json } }, ids.els));
  const errors = [], pending = [], requests = [];
  const win = {
    document: doc, location: { search: "", href: "", origin: "https://publicaccess.tv" }, navigator: { userAgent: "Chrome/145.0", platform: "Win32", maxTouchPoints: 0 },
    console: { error: (...a) => errors.push(a.map(String).join(" ")), log() {}, warn() {} },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: () => 0, clearInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener(type, fn) { (win.listeners[type] = win.listeners[type] || []).push(fn); }, removeEventListener() {},
    listeners: {}, localStorage: { getItem: () => null, setItem() {} },
    fetch(url) {
      requests.push(url);
      if (/\/avsync\?/.test(url)) return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(config)) });
      if (/\/live\?/.test(url)) return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      return new Promise(() => {});
    },
    PATVRoom: {
      audio: () => ({ update() {} }), ptt: () => ({ update() {} }),
      relay: () => ({ anchor: () => null, update() {}, refetch: () => 0, reset() {}, wantsMe: () => false }),
    },
    JSON, Math, Date: clock.Date, String, Number, Array, Object, RegExp, Error, Promise, encodeURIComponent, decodeURIComponent, isNaN, isFinite, parseInt, Intl,
  };
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  vm.runInContext(CORE_SRC, ctx, { filename: "chatlog-core.js" });
  if (avsync) vm.runInContext(AVS_SRC, ctx, { filename: "av-sync.js" });
  const H = {
    win, doc, errors, requests, clock, config, advance: clock.advance,
    // the viewer starts the room audio; what is on screen at that moment stays (a view never moves back), later changes wait D
    play() { win.PATVAvSync.audio({ slug, playing: true, mode: "mp3", ahead: () => 0 }); return clock.advance(100); },
    stop() { win.PATVAvSync.audio({ slug, playing: false, mode: "mp3" }); return clock.flush(); },
    waiting: () => pending.length,
    async deliver(answer) {
      assert.ok(pending.length, "the page is waiting on its long poll");
      pending.shift().resolve({ ok: true, status: 200, json: async () => answer });
      await clock.flush();
    },
    async fail() {             // review fix (T3): the open long poll fails (a dropped connection)
      assert.ok(pending.length, "the page is waiting on its long poll");
      pending.shift().reject(new TypeError("Failed to fetch"));
      await clock.flush();
    },
  };
  H.start = async () => {
    if (avsync && playFirst) { win.PATVAvSync.pad(slug); await H.play(); }
    vm.runInContext(script, ctx, { filename: "page script" });
    await clock.flush();
  };
  return H;
}
function pageScript(html, initId) {
  const init = html.indexOf('<script id="' + initId + '" type="application/json">');
  assert.ok(init > 0, "the seeded view");
  const json = html.slice(html.indexOf(">", init) + 1, html.indexOf("</script>", init));
  const open = html.indexOf("<script>", init), close = html.indexOf("</script>", open);
  return { json, src: html.slice(open + 8, close) };
}

// ── the pad page ──
const SLUG = "plant_based_chatting";
const RTC = () => ({ base: "https://relay.example.invalid", turn: "/api/turn" });   // av-sync.js loads inside the pages' WebRTC block
const ROOMD = { name: "Houseplants", slug: SLUG, topic: "Grow stuff", count: 4, live: true, updated: T0, listAt: T0 - 60e3, listFresh: true, seenTtl: 15 * 60e3,
  listStaleAfter: 10 * 60e3, transcripts: true, audio: true, relay: false, micRelay: false, cams: false, clip: null, cmds: null, pepe: null };
const FEED0 = [
  { k: "msg", c: 1, ts: T0 - 300e3, u: ALICE, text: "hi all" },
  { k: "mic", c: 2, ts: T0 - 200e3, u: BOB },
  { k: "unmic", c: 3, ts: T0 - 150e3, u: ALICE, ms: 4000 },
  { k: "mic", c: 4, ts: T0 - 100e3, u: FROG },
  { k: "unmic", c: 5, ts: T0 - 90e3, u: FROG },
  { k: "msg", c: 6, ts: T0 - 60e3, u: BOB, text: "the newest line" },
];
const MEMBERS0 = [on(BOB), ALICE, FROG];
const INITIAL = { room: ROOMD, mine: [], ver: 1, mver: 0, mod: null, members: MEMBERS0, mic: [on(BOB)], feed: FEED0, cursor: 6, lp: 1,
  history: { chat_s: 86400, search: true, explain: "/privacy#chat-history", v: "v1" } };
const ROOM = { id: "Plant Based Chatting", name: "Houseplants", slug: SLUG, count: 4, live: true, topic: "Grow stuff", platform: "camfrog",
  description: "Plants and chat", owner: "pb", ownerUser: "pb", camfrogName: "Plant Based Chatting" };
const PAD_IDS = ["rmFeed", "rmJump", "rmScroll", "rmOlder", "rmMic", "rmPeople", "rmPplN", "rmListNote", "rmTopic", "rmCount", "rmStDot", "rmLive", "rmLiveTxt",
  "rmAudioBox", "rmCompose", "rmRelay", "rmStatus", "rmChat", "rmClip", "rmMod", "rmHistTop", "rmHistBot", "rmHistJump", "rmSearchBtn", "rmHist"];
let PAD_HTML = null;
async function padHtml(avsyncOn = true) {
  const html = (await ejs.renderFile(path.join(repo, "views", "room.ejs"), {
    user: "viewer", signedIn: true, linked: true, room: ROOM, initial: INITIAL, onStage: false, stage: {}, latest: [], avsyncOn, webrtcCfg: RTC,
    padTabs: { tabs: ["live", "about"], initial: "live", active: true, camfrog: true, posts: [] },
  })).replace(/\r\n/g, "\n");
  if (avsyncOn) PAD_HTML = html;
  return html;
}
async function pad({ avsync = true, config = baseConfig(), playFirst = false } = {}) {
  const { json, src } = pageScript(PAD_HTML || await padHtml(), "rmInit");
  const els = {}; for (const id of PAD_IDS) els[id] = {};
  els.rmHist = { tag: "a" }; els.rmTopic = { attrs: { "data-desc": "Plants and chat" } };
  const H = harness({ script: src, json, ids: { init: "rmInit", els }, avsync, config, playFirst, slug: SLUG });
  await H.start();
  H.feed = H.doc.getElementById("rmFeed"); H.scroll = H.doc.getElementById("rmScroll"); H.jump = H.doc.getElementById("rmJump");
  H.line = (c) => { const all = H.feed.childNodes.filter((n) => n._c === c); assert.ok(all.length <= 1, "never duplicated: " + c); return all[0] || null; };
  H.shown = (c) => { const n = H.line(c); return !!n && n.style.display !== "none"; };
  H.order = () => H.feed.childNodes.map((n) => n._c);
  H.card = () => H.doc.getElementById("rmMic").children.filter((n) => n.className === "holder").map((n) => n.childNodes[1].textContent);
  let cursor = 6, ver = 1;
  H.answer = (over) => { if (over.feed) for (const it of over.feed) cursor = Math.max(cursor, it.c); return Object.assign({ room: ROOMD, mine: [], ver: ++ver, mver: 0, mod: null,
    members: MEMBERS0, mic: [on(BOB)], feed: [], cursor, lp: 1 }, over); };
  await H.advance(1500);                                  // the first long poll (the seeded view has no lp yet)
  assert.equal(H.waiting(), 1, "the page polls");
  return H;
}
const grab = (c, u) => ({ k: "mic", c, ts: T0 + c, u });
const drop = (c, u, ms) => ({ k: "unmic", c, ts: T0 + c, u, ms });
const say = (c, u, text) => ({ k: "msg", c, ts: T0 + c, u, text });

test("1.99ahm: the rendered pages load the controller (v=5: + the people list's 🎙; 1.99ahp v=6: + stable slots' places; 1.99?? avf v=7: the toggle's on / off, the mic signs' fallback) only while A/V sync applies to the viewer", async () => {
  assert.match(await padHtml(true), /<script src="\/public\/js\/av-sync\.js\?v=7"><\/script>/);
  assert.doesNotMatch(await padHtml(false), /av-sync\.js/);
});

test("1.99ahm: pad page - the On the mic card and the grab/drop lines wait for the room audio; typed chat is immediate; a held line shows in its true place", async () => {
  const P = await pad();
  assert.deepEqual(P.errors, []);
  assert.deepEqual(P.card(), ["Bob"]);
  await P.play();
  assert.deepEqual([P.win.PATVAvSync.debug().card_ms, P.win.PATVAvSync.debug().chat_ms], [D, D]);
  await P.deliver(P.answer({ feed: [grab(7, ALICE), say(8, BOB, "typed right after")], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  assert.ok(P.line(7), "the grab line is in the log already, in its place"); assert.equal(P.shown(7), false, "... hidden");
  assert.equal(P.shown(8), true, "typed chat is never held");
  assert.deepEqual(P.order().slice(-2), [7, 8]);
  assert.deepEqual(P.card(), ["Bob"], "Alice isn't on the card before the viewer hears her");
  await P.advance(D - 1);
  assert.equal(P.shown(7), false); assert.deepEqual(P.card(), ["Bob"]);
  await P.advance(1);
  assert.equal(P.shown(7), true); assert.deepEqual(P.order().slice(-2), [7, 8], "shown above the newer typed line - true time order");
  assert.deepEqual(P.card(), ["Bob", "Alice"]);
  assert.equal(P.line(7).textContent.includes("Alice grabbed the mic"), true);
  // a drop: the card keeps Bob and his drop line waits, until the audio stops - then both at once
  await P.advance(100);
  await P.deliver(P.answer({ feed: [drop(9, BOB, 5000)], mic: [on(ALICE)], members: [BOB, on(ALICE), FROG] }));
  assert.equal(P.shown(9), false); assert.deepEqual(P.card(), ["Bob", "Alice"]);
  await P.advance(300);
  await P.stop();
  assert.equal(P.shown(9), true, "audio stopped: the held line shows at once"); assert.deepEqual(P.card(), ["Alice"], "and the card is now's");
  // audio off: nothing is held
  await P.advance(100);
  await P.deliver(P.answer({ feed: [grab(10, BOB)], mic: [on(ALICE), on(BOB)], members: [on(BOB), on(ALICE), FROG] }));
  assert.equal(P.shown(10), true); assert.deepEqual(P.card(), ["Alice", "Bob"]);
  assert.deepEqual(P.errors, []);
});

test("1.99ahm: review fix (T2) - pad page: a turn shorter than the offset is on the card one offset late, for as long as it lasted - in step with its lines", async () => {
  const P = await pad();
  await P.play();
  await P.deliver(P.answer({ feed: [grab(7, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  await P.advance(500);
  await P.deliver(P.answer({ feed: [drop(8, ALICE, 500)], mic: [on(BOB)], members: [on(BOB), ALICE, FROG] }));   // a 500 ms turn
  await P.advance(199); assert.deepEqual(P.card(), ["Bob"]); assert.equal(P.shown(7), false);
  await P.advance(1); assert.deepEqual(P.card(), ["Bob", "Alice"], "held back, not dropped (today's card shows such a turn too)");
  assert.equal(P.shown(7), true); assert.equal(P.shown(8), false);
  await P.advance(499); assert.deepEqual(P.card(), ["Bob", "Alice"]); assert.equal(P.shown(8), false);
  await P.advance(1); assert.deepEqual(P.card(), ["Bob"]); assert.equal(P.shown(8), true, "off the card with its drop line");
  assert.deepEqual(P.errors, []);
});

test("1.99ahm: pad page - switches off, sync not for this viewer, or no controller at all (signed out): exactly today's page", async () => {
  const script = async (P) => {
    await P.play().catch(() => {});
    await P.deliver(P.answer({ feed: [grab(7, ALICE), say(8, BOB, "typed")], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
    const at = { shown: P.shown(7), card: P.card() };
    await P.advance(D + 100);
    await P.deliver(P.answer({ feed: [drop(9, BOB)], mic: [on(ALICE)], members: [BOB, on(ALICE), FROG] }));
    return { at, now: { shown: P.shown(9), card: P.card() }, feed: P.feed.childNodes.map(tree), mic: tree(P.doc.getElementById("rmMic")),
      people: tree(P.doc.getElementById("rmPeople")) };   // 1.99ahm: + the people list (apply_mic_list)
  };
  const none = await script(Object.assign(await pad({ avsync: false }), { play: async () => {} }));
  assert.deepEqual(none.at, { shown: true, card: ["Bob", "Alice"] }); assert.deepEqual(none.now, { shown: true, card: ["Alice"] });
  const control = await script(await pad());
  assert.deepEqual(control.at, { shown: false, card: ["Bob"] }, "the control: with both switches on the same answers are held");
  const off = baseConfig(); off.apply.mic_card = false; off.apply.mic_chat = false; off.apply.mic_list = false;
  const oldServer = baseConfig(); delete oldServer.apply.mic_card; delete oldServer.apply.mic_chat; delete oldServer.apply.mic_list;
  const notMine = baseConfig(); notMine.on = false;
  for (const [name, config] of [["switches off", off], ["an older site without the switches", oldServer], ["mode not for this viewer", notMine]]) {
    const got = await script(await pad({ config }));
    assert.deepEqual(got, none, name + ": the same lines, the same card");
  }
});

test("1.99ahm: pad page - the page's first lines and lines drawn again are never held; a held line the site takes out never comes back; never duplicated", async () => {
  const P = await pad({ playFirst: true });
  assert.deepEqual(P.errors, []);
  for (const c of [2, 3, 4, 5]) assert.equal(P.shown(c), true, "first lines (history) show as they are: " + c);
  await P.deliver(P.answer({ feed: [grab(7, ALICE), say(8, BOB, "x")] }));
  assert.equal(P.shown(7), false);
  await P.advance(100);
  // the same line again (a refetch from just before it) - still one, still held
  await P.deliver(P.answer({ feed: [grab(7, ALICE), say(8, BOB, "x")], cursor: 8 }));
  assert.equal(P.feed.childNodes.filter((n) => n._c === 7).length, 1); assert.equal(P.shown(7), false);
  await P.advance(100);
  // the speaker went incognito: the site takes the held line out - it is gone, and stays gone after the delay
  await P.deliver(P.answer({ feed: [], removed: [7] }));
  assert.equal(P.line(7), null);
  await P.advance(D * 2);
  assert.equal(P.line(7), null, "never shown late"); assert.deepEqual(P.errors, []);
  // a line drawn again (redo: named -> someone) is in the log already: drawn at once, never hidden again
  await P.deliver(P.answer({ feed: [grab(11, ALICE)] }));
  await P.advance(D);
  assert.equal(P.shown(11), true);
  await P.advance(100);
  const again = Object.assign(grab(11, { anon: true, display: "someone" }));
  await P.deliver(P.answer({ feed: [], redo: [again] }));
  assert.equal(P.shown(11), true, "the redrawn line shows at once"); assert.match(P.line(11).textContent, /someone grabbed the mic/);
});

test("1.99ahm: pad page privacy - a veiled holder is held exactly like a named one; holding adds nothing to a line; the card shows only the frog name", async () => {
  const P = await pad();
  await P.play();
  await P.deliver(P.answer({ feed: [grab(7, ALICE), grab(8, FROG)], mic: [on(BOB), on(ALICE), on(FROG)], members: [on(BOB), on(ALICE), on(FROG)] }));
  const held = [P.line(7), P.line(8)];
  assert.deepEqual(held.map((n) => n.style.display), ["none", "none"], "the same hold, named or veiled");
  const H = CL.domH(P.doc), ctx = { t: tEN, lang: "en" };
  const fresh = [CL.renderItem(grab(7, ALICE), ctx, H), CL.renderItem(grab(8, FROG), ctx, H)];
  held.forEach((n, i) => {
    assert.deepEqual(n.attrs, fresh[i].attrs, "holding adds no attribute");
    assert.deepEqual(Object.keys(n).filter((k) => !(k in fresh[i])).sort(), ["_c", "_k", "_patvAvSyncHeld", "_ts"], "only the page's own fields + a timing flag");
    assert.equal(n._patvAvSyncHeld, true);
  });
  assert.doesNotMatch(JSON.stringify(tree(held[1])), /alice|bob|opaque-7f/i, "the veiled line names no one");
  await P.advance(D - 1);
  assert.deepEqual(held.map((n) => n.style.display), ["none", "none"]); assert.deepEqual(P.card(), ["Bob"]);
  await P.advance(1);
  assert.deepEqual(held.map((n) => n.style.display), ["", ""], "shown at the same moment");
  held.forEach((n, i) => { assert.deepEqual(tree(n), tree(fresh[i]), "shown exactly as it would have been drawn"); assert.equal(n._patvAvSyncHeld, undefined); });
  assert.deepEqual(P.card(), ["Bob", "Alice", "Soggy Bullfrog incognito"]);
  assert.doesNotMatch(JSON.stringify(tree(P.doc.getElementById("rmMic"))), /opaque-7f|h3/, "the card shows the frog name only");
  assert.doesNotMatch(JSON.stringify(P.win.PATVAvSync.debug()), /alice|bob|Soggy|plant_based/i, "measurements name no one");
});

test("1.99ahm: review fix (PRIV-L1) - pad page: after an alias-less incognito holder drops, the card keeps a someone · incognito for the offset - never a someone · hidden who never held the mic", async () => {
  const P = await pad();
  await P.play();
  const SI = { anon: true, display: "someone", veil: "incognito" }, SH = { anon: true, display: "someone", veil: "hidden" };
  await P.deliver(P.answer({ feed: [grab(7, SI)], mic: [on(BOB), on(SI)], members: [on(BOB), SH, on(SI)] }));
  await P.advance(D); assert.deepEqual(P.card(), ["Bob", "someone incognito"]);
  await P.advance(100);
  await P.deliver(P.answer({ feed: [drop(8, SI)], mic: [on(BOB)], members: [on(BOB), SH, SI] }));
  const seen = new Set();
  for (let i = 0; i < D; i += 25) { seen.add(JSON.stringify(P.card())); await P.advance(25); }
  seen.add(JSON.stringify(P.card()));
  assert.deepEqual([...seen], [JSON.stringify(["Bob", "someone incognito"]), JSON.stringify(["Bob"])], "held one offset as it was, then gone - no someone · hidden");
  assert.equal(P.shown(8), true);
  assert.deepEqual(P.errors, []);
});

test("1.99ahm: pad page - a hidden tab shows held lines at once (the poll sleeps); a reader at the bottom stays at the bottom, one reading back gets the jump", async () => {
  const P = await pad();
  await P.play();
  P.scroll.scrollHeight = 500; P.scroll.clientHeight = 500; P.scroll.scrollTop = 0;
  await P.deliver(P.answer({ feed: [grab(7, ALICE)] }));
  P.jump.style.display = "none"; P.scroll.scrollHeight = 540;
  await P.advance(D);
  assert.equal(P.shown(7), true); assert.equal(P.scroll.scrollTop, 540, "kept at the bottom"); assert.equal(P.jump.style.display, "none");
  await P.advance(100);
  P.scroll.scrollHeight = 5000; P.scroll.scrollTop = 0;
  await P.deliver(P.answer({ feed: [grab(8, BOB)] }));
  P.jump.style.display = "none";
  await P.advance(D);
  assert.equal(P.shown(8), true); assert.equal(P.scroll.scrollTop, 0, "a reader further up isn't moved"); assert.equal(P.jump.style.display, "block");
  await P.advance(100);
  await P.deliver(P.answer({ feed: [drop(9, ALICE)] }));
  assert.equal(P.shown(9), false);
  P.doc.hidden = true; P.doc.fire("visibilitychange");
  assert.equal(P.shown(9), true, "hidden tab: shown at once");
  P.doc.hidden = false; P.doc.fire("visibilitychange");
  await P.advance(0);
  assert.deepEqual(P.errors, []);
});

test("1.99ahm: review fix (T3) - pad page: the first answer after the tab comes back, or after a failed poll, is old news - its card and grab/drop lines show at once; later ones wait again", async () => {
  const P = await pad();
  await P.play();
  await P.deliver(P.answer({ feed: [grab(7, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  await P.advance(2000); assert.deepEqual(P.card(), ["Bob", "Alice"]); assert.equal(P.shown(7), true);
  // the tab is hidden: the open poll answers (a typed line), then the page stops asking
  P.doc.hidden = true; P.doc.fire("visibilitychange");
  await P.deliver(P.answer({ feed: [say(8, BOB, "while you were away")] }));
  await P.advance(60000); assert.equal(P.waiting(), 0, "a hidden page doesn't ask");
  P.doc.hidden = false; P.doc.fire("visibilitychange"); await P.advance(0);
  assert.equal(P.waiting(), 1, "back in view: it asks at once");
  const d9 = drop(9, ALICE, 5000); d9.ts = P.clock.now() - 55000;                     // said ~55 s ago
  await P.deliver(P.answer({ feed: [d9, say(10, BOB, "said while hidden")], mic: [on(BOB)], members: [on(BOB), ALICE, FROG] }));
  assert.equal(P.shown(10), true);
  assert.equal(P.shown(9), true, "the backlog's drop line shows at once, with the typed line from the same answer");
  assert.deepEqual(P.card(), ["Bob"], "the card drops Alice at once");
  assert.deepEqual(people(P.doc).find(([n]) => n === "Alice"), ["Alice", false], "and the people list's 🎙 (1.99ahm: apply_mic_list)");
  assert.deepEqual(P.order().slice(-2), [9, 10]);
  // the next live answer waits the offset again
  await P.advance(100);
  await P.deliver(P.answer({ feed: [grab(11, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  assert.equal(P.shown(11), false); assert.deepEqual(P.card(), ["Bob"]);
  await P.advance(D); assert.equal(P.shown(11), true); assert.deepEqual(P.card(), ["Bob", "Alice"]);
  // a failed poll: the answer after it (the retry, 3 s later) is a backlog too
  await P.advance(100);
  await P.fail();
  await P.advance(3000); assert.equal(P.waiting(), 1, "the retry");
  await P.deliver(P.answer({ feed: [drop(12, ALICE)], mic: [on(BOB)], members: [on(BOB), ALICE, FROG] }));
  assert.equal(P.shown(12), true); assert.deepEqual(P.card(), ["Bob"]);
  await P.advance(100);
  await P.deliver(P.answer({ feed: [grab(13, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  assert.equal(P.shown(13), false, "and live again after it");
  assert.deepEqual(P.errors, []);
});

// ── the homepage panel (the front pad's chat + its "On the mic" box) ──
const HOME_LIVE = { room: ROOMD, mine: [], ver: 1, mver: 0, members: MEMBERS0, mic: [on(BOB)], feed: FEED0, cursor: 6, lp: 1 };
async function homeHtml(avsyncOn) {
  return (await ejs.renderFile(path.join(repo, "views", "home.ejs"), { username: "fan", me: null, mine: null, S: {}, rooms: [],
    room: { id: ROOM.id, name: "Houseplants", slug: SLUG, count: 4, live: true, topic: "Grow stuff" }, roomLive: HOME_LIVE, roomGate: "ok",
    stage: { active: false }, top: [], tops: [], story: { rooms: [], caps: [], room: null, signed: false, compose: false }, hot: null, banner: null,
    roomOnStage: false, stageAdmin: null, frontInfo: null, pepeHere: false, slots: [], nextUp: null, staff: false, avsyncOn, webrtcCfg: RTC })).replace(/\r\n/g, "\n");
}
async function home({ avsync = true, config = baseConfig() } = {}) {
  const html = await homeHtml(avsync);
  if (avsync) assert.match(html, /<script src="\/public\/js\/av-sync\.js\?v=7"><\/script>/); else assert.doesNotMatch(html, /av-sync\.js/);
  const { json, src } = pageScript(html, "lrInit");
  const els = {}; for (const id of ["lrFeed", "lrTopic", "lrCount", "lrLive", "lrLiveTxt", "lrMic", "lrPeople", "lrAudioBox"]) els[id] = {};
  const H = harness({ script: src, json, ids: { init: "lrInit", els }, avsync, config, slug: SLUG });
  await H.start();
  H.feed = H.doc.getElementById("lrFeed");
  H.line = (c) => { const all = H.feed.childNodes.filter((n) => n._c === c); assert.ok(all.length <= 1, "never duplicated: " + c); return all[0] || null; };
  H.shown = (c) => { const n = H.line(c); return !!n && n.style.display !== "none"; };
  H.chips = () => H.doc.getElementById("lrMic").children.map((n) => n.textContent);
  let cursor = 6, ver = 1;
  H.answer = (over) => { if (over.feed) for (const it of over.feed) cursor = Math.max(cursor, it.c); return Object.assign({ room: ROOMD, mine: [], ver: ++ver, mver: 0,
    members: MEMBERS0, mic: [on(BOB)], feed: [], cursor, lp: 1 }, over); };
  await H.advance(300);
  assert.equal(H.waiting(), 1, "the panel polls");
  return H;
}

test("1.99ahm: homepage panel - its On the mic box and grab/drop lines follow the same two switches; without them it is today's panel", async () => {
  const P = await home();
  assert.deepEqual(P.errors, []);
  assert.deepEqual(P.chips(), ["Bob"]);
  for (const c of [2, 3, 4, 5]) assert.equal(P.shown(c), true, "the panel's first lines show as they are");
  await P.play();
  await P.deliver(P.answer({ feed: [grab(7, FROG), say(8, BOB, "typed")], mic: [on(BOB), on(FROG)], members: [on(BOB), ALICE, on(FROG)] }));
  assert.equal(P.shown(7), false); assert.equal(P.shown(8), true); assert.deepEqual(P.feed.childNodes.map((n) => n._c).slice(-2), [7, 8]);
  assert.deepEqual(P.chips(), ["Bob"]);
  assert.deepEqual(Object.keys(P.line(7).attrs), [], "a held line carries no attribute");
  await P.advance(D - 1); assert.equal(P.shown(7), false);
  await P.advance(1);
  assert.equal(P.shown(7), true); assert.match(P.line(7).textContent, /^🎙️ Soggy Bullfrog grabbed the mic/);
  assert.deepEqual(P.chips(), ["Bob", "Soggy Bullfrog incognito"]);
  await P.advance(100);
  await P.deliver(P.answer({ feed: [drop(9, BOB)], mic: [on(FROG)], members: [BOB, ALICE, on(FROG)] }));
  assert.equal(P.shown(9), false); assert.deepEqual(P.chips(), ["Bob", "Soggy Bullfrog incognito"]);
  P.doc.hidden = true; P.doc.fire("visibilitychange");
  assert.equal(P.shown(9), true, "hidden tab: shown at once");
  assert.deepEqual(P.errors, []);
  // switches off / no controller: the same panel as today
  const run = async (H) => {
    await H.play().catch(() => {});
    await H.deliver(H.answer({ feed: [grab(7, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
    return { shown: H.shown(7), chips: H.chips(), feed: H.feed.childNodes.map(tree), people: tree(H.doc.getElementById("lrPeople")) };   // 1.99ahm: + the chips
  };
  const none = await run(Object.assign(await home({ avsync: false }), { play: async () => {} }));
  assert.deepEqual([none.shown, none.chips], [true, ["Bob", "Alice"]]);
  const off = baseConfig(); off.apply.mic_card = false; off.apply.mic_chat = false; off.apply.mic_list = false;
  assert.deepEqual(await run(await home({ config: off })), none);
});

test("1.99ahm: review fix (T3) - homepage panel: the first answer after the tab comes back, or after a failed poll, shows its mic box and lines at once", async () => {
  const P = await home();
  await P.play();
  await P.deliver(P.answer({ feed: [grab(7, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  await P.advance(2000); assert.deepEqual(P.chips(), ["Bob", "Alice"]); assert.equal(P.shown(7), true);
  // hidden with its long poll still open (a frozen tab gets the answer late): the answer that lands after the tab is back is old news
  P.doc.hidden = true; P.doc.fire("visibilitychange");
  await P.advance(60000);
  P.doc.hidden = false; P.doc.fire("visibilitychange"); await P.advance(0);
  await P.deliver(P.answer({ feed: [drop(8, ALICE), say(9, BOB, "said while hidden")], mic: [on(BOB)], members: [on(BOB), ALICE, FROG] }));
  assert.equal(P.shown(8), true); assert.equal(P.shown(9), true); assert.deepEqual(P.chips(), ["Bob"]);
  await P.advance(100);
  await P.deliver(P.answer({ feed: [grab(10, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  assert.equal(P.shown(10), false, "live again"); assert.deepEqual(P.chips(), ["Bob"]);
  await P.advance(D); assert.equal(P.shown(10), true); assert.deepEqual(P.chips(), ["Bob", "Alice"]);
  await P.advance(100);
  await P.fail();
  await P.advance(6000); assert.equal(P.waiting(), 1, "the retry");
  await P.deliver(P.answer({ feed: [drop(11, ALICE)], mic: [on(BOB)], members: [on(BOB), ALICE, FROG] }));
  assert.equal(P.shown(11), true); assert.deepEqual(P.chips(), ["Bob"]);
  assert.deepEqual(P.errors, []);
});

// ── 1.99ahm: "Delay the people list's 🎙 icons" (avsync apply_mic_list) - the pad page's people list (its 🎙 icons and on-mic order) and
// the homepage panel's In the room chips (their "mic" highlight and order), from the same micView as the card ──
// [name as shown, 🎙 lit] in the list's order
function people(doc) {
  return doc.getElementById("rmPeople").children.map((li) => [li.children[1].textContent, li.children[2].lastChild.className !== "off"]);
}
const FROG_NAME = "Soggy Bullfrog incognito";

test("1.99ahm: pad page - the people list's 🎙 icons and on-mic order wait for the room audio, in step with the card and the grab/drop lines", async () => {
  const P = await pad();
  await P.play();
  assert.equal(P.win.PATVAvSync.debug().list_ms, D);
  assert.deepEqual(people(P.doc), [["Bob", true], ["Alice", false], [FROG_NAME, false]]);
  await P.deliver(P.answer({ feed: [grab(7, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  assert.deepEqual(people(P.doc), [["Bob", true], ["Alice", false], [FROG_NAME, false]], "Alice's 🎙 isn't lit before the viewer hears her");
  await P.advance(D - 1);
  assert.deepEqual(people(P.doc), [["Bob", true], ["Alice", false], [FROG_NAME, false]]); assert.deepEqual(P.card(), ["Bob"]); assert.equal(P.shown(7), false);
  await P.advance(1);
  assert.deepEqual(people(P.doc), [["Alice", true], ["Bob", true], [FROG_NAME, false]], "lit, and up with the people on the mic");
  assert.deepEqual(P.card(), ["Bob", "Alice"], "the same moment as the card"); assert.equal(P.shown(7), true, "and her grab line");
  assert.equal(P.doc.getElementById("rmPplN").textContent, "(3)");
  // a drop: Bob's 🎙 stays lit until the audio catches up, with the card and his drop line
  await P.advance(100);
  await P.deliver(P.answer({ feed: [drop(8, BOB, 5000)], mic: [on(ALICE)], members: [BOB, on(ALICE), FROG] }));
  await P.advance(D - 1);
  assert.deepEqual(people(P.doc), [["Alice", true], ["Bob", true], [FROG_NAME, false]]); assert.deepEqual(P.card(), ["Bob", "Alice"]); assert.equal(P.shown(8), false);
  await P.advance(1);
  assert.deepEqual(people(P.doc), [["Alice", true], ["Bob", false], [FROG_NAME, false]]); assert.deepEqual(P.card(), ["Alice"]); assert.equal(P.shown(8), true);
  // a veiled holder is held like a named one; the audio stopping shows today's list at once
  await P.advance(100);
  await P.deliver(P.answer({ feed: [grab(9, FROG)], mic: [on(ALICE), on(FROG)], members: [BOB, on(ALICE), on(FROG)] }));
  assert.deepEqual(people(P.doc), [["Alice", true], ["Bob", false], [FROG_NAME, false]]);
  await P.stop();
  assert.deepEqual(people(P.doc), [["Alice", true], [FROG_NAME, true], ["Bob", false]], "audio stopped: the list is now's");
  assert.deepEqual(P.card(), ["Alice", "Soggy Bullfrog incognito"]);
  assert.deepEqual(P.errors, []);
});

test("1.99ahm: pad page - the list's switch is its own: with only the card's the list is immediate, with only the list's the card is", async () => {
  const run = async (config) => {
    const P = await pad({ config });
    await P.play();
    await P.deliver(P.answer({ feed: [grab(7, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
    const at = { people: people(P.doc), card: P.card(), line: P.shown(7) };
    await P.advance(D);
    assert.deepEqual(P.errors, []);
    return { at, later: { people: people(P.doc), card: P.card(), line: P.shown(7) } };
  };
  const lit = [["Alice", true], ["Bob", true], [FROG_NAME, false]], dark = [["Bob", true], ["Alice", false], [FROG_NAME, false]];
  const cardOnly = baseConfig(); cardOnly.apply.mic_list = false;
  assert.deepEqual(await run(cardOnly), { at: { people: lit, card: ["Bob"], line: false }, later: { people: lit, card: ["Bob", "Alice"], line: true } },
    "the card's switch alone: the list is today's");
  const listOnly = baseConfig(); listOnly.apply.mic_card = false; listOnly.apply.mic_chat = false;
  assert.deepEqual(await run(listOnly), { at: { people: dark, card: ["Bob", "Alice"], line: true }, later: { people: lit, card: ["Bob", "Alice"], line: true } },
    "the list's switch alone: the card and the lines are today's");
});

test("1.99ahm: pad page privacy - the held list is today's list (frog names, someone, no login added); an alias-less someone's 🎙 never moves to another veil level", async () => {
  const P = await pad(), T = await pad({ avsync: false });
  await P.play();
  const SI = { anon: true, display: "someone", veil: "incognito" }, SH = { anon: true, display: "someone", veil: "hidden" }, SH2 = { anon: true, display: "someone", veil: "hidden" };
  await P.deliver(P.answer({ feed: [grab(7, SI)], mic: [on(BOB), on(SI)], members: [on(BOB), SH, on(SI), FROG] }));
  await P.advance(D);
  const before = people(P.doc);
  assert.deepEqual(before.filter(([, m]) => m).map(([n]) => n), ["Bob", "someone incognito"]);
  await P.advance(100);
  // the incognito someone drops as another hidden someone joins ahead of them (veil.js's keyed order): for one offset the list
  // still shows the 🎙 on the incognito someone - never on a hidden one
  const after = P.answer({ feed: [drop(8, SI)], mic: [on(BOB)], members: [on(BOB), SH2, SH, SI, FROG] });
  await P.deliver(after);
  const seen = new Set();
  for (let i = 0; i < D; i += 25) { seen.add(JSON.stringify(people(P.doc).filter(([, m]) => m).map(([n]) => n))); await P.advance(25); }
  seen.add(JSON.stringify(people(P.doc).filter(([, m]) => m).map(([n]) => n)));
  assert.deepEqual([...seen], [JSON.stringify(["Bob", "someone incognito"]), JSON.stringify(["Bob"])], "held one offset as it was, then out - no someone · hidden lit");
  assert.equal(P.shown(8), true); assert.deepEqual(P.card(), ["Bob"]);
  // caught up: exactly the list a page without A/V sync draws from the same answer
  await T.deliver(after);
  assert.deepEqual(tree(P.doc.getElementById("rmPeople")), tree(T.doc.getElementById("rmPeople")), "the same list, node for node");
  assert.doesNotMatch(JSON.stringify(tree(P.doc.getElementById("rmPeople"))), /opaque-7f|"h3"/, "the frog name only");
  assert.deepEqual(P.errors, []); assert.deepEqual(T.errors, []);
});

test("1.99ahm: homepage panel - the In the room chips' mic highlight and order wait for the room audio with the mic box; the switch off: today's chips", async () => {
  const chips = (H) => H.doc.getElementById("lrPeople").children.map((n) => [n.textContent, n.className.split(" ").includes("mic")]);
  const P = await home();
  assert.deepEqual(chips(P), [["Bob", true], ["Alice", false], [FROG_NAME, false]]);
  await P.play();
  await P.deliver(P.answer({ feed: [grab(7, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  assert.deepEqual(chips(P), [["Bob", true], ["Alice", false], [FROG_NAME, false]]); assert.deepEqual(P.chips(), ["Bob"]);
  await P.advance(D - 1); assert.deepEqual(chips(P), [["Bob", true], ["Alice", false], [FROG_NAME, false]]);
  await P.advance(1);
  assert.deepEqual(chips(P), [["Alice", true], ["Bob", true], [FROG_NAME, false]], "highlighted and first, with the mic box");
  assert.deepEqual(P.chips(), ["Bob", "Alice"]); assert.equal(P.shown(7), true);
  assert.deepEqual(P.errors, []);
  const off = baseConfig(); off.apply.mic_list = false;
  const Q = await home({ config: off });
  await Q.play();
  await Q.deliver(Q.answer({ feed: [grab(7, ALICE)], mic: [on(BOB), on(ALICE)], members: [on(BOB), on(ALICE), FROG] }));
  assert.deepEqual(chips(Q), [["Alice", true], ["Bob", true], [FROG_NAME, false]], "the switch off: at once");
  assert.deepEqual(Q.chips(), ["Bob"], "(the mic box's own switch still holds it)");
  assert.deepEqual(Q.errors, []);
});
