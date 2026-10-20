// CL5 fix-up: the pad page's REAL script (views/room.ejs, rendered with ejs) run against the shared renderer
// (public/js/chatlog-core.js) in a small fake DOM - and without it, the way a page whose chatlog-core.js didn't load (a
// blocked request, an edge-cached 404 around a deploy) runs:
//   * with the renderer: every live line is exactly renderItem's, the mic / people lists use its avatars and names, the 📜 chip
//     its spans, your pending relay line its line, a ?line= link highlights its line (.line.hl, chatlog.css);
//   * without it: nothing throws, the poll still starts, the chat shows plain "name: text · 21:04" lines (no system lines, no
//     hidden line, never an account key), the people and mic lists and the relay composer still work;
//   * the rendered page: <main class="… chatlog …">, chatlog.css right after the page's style block, chatlog-core.js before the
//     page script - the CL5 assertions of pad-look / pad-flair / mentions, here in a file Node 16 runs (those files need fetch).
//   node --test test/chatlog-page.test.js      (needs the repo's node_modules: ejs; no database, no network)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const CORE_SRC = rd("public", "js", "chatlog-core.js");
const CL = require(path.join(repo, "public", "js", "chatlog-core.js"));

// ── a small DOM: what the page script and the renderer touch ──
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
  // tag? (.class)* ([attr="value"])? - the selectors the page script asks for
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
  doc.createElement = (t) => new FakeEl(t, doc);
  doc.createTextNode = (t) => new FakeText(t);
  doc.createDocumentFragment = () => new FakeEl("#fragment", doc);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); };
  doc.querySelector = () => null;
  doc.querySelectorAll = () => [];
  const byId = {};
  doc.getElementById = (id) => {
    if (!(id in ids)) return null;                           // an element this page variant doesn't have
    if (!byId[id]) { const e = new FakeEl(ids[id].tag || "div", doc); e.id = id; Object.assign(e.attrs, ids[id].attrs || {}); if (ids[id].text != null) e.textContent = ids[id].text; byId[id] = e; }
    return byId[id];
  };
  return doc;
}
// one tree shape: {t, a: {attrs + class + style}, k: [children, adjacent text merged, empty text dropped]}
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

// ── the page: rendered from views/room.ejs with a seeded live view ──
const NOW = Date.UTC(2026, 9, 19, 1, 30);
const T = (minAgo) => NOW - minAgo * 60e3;
const PB = { login: "foamy1111", display: "Plantbaked", cf: "Plantbaked", patv: { username: "pb", avatar: "/uploads/avatars/pb.png", style: "color: #ffd54f", flair: { name: "Frog Wrangler", emoji: "🐸", color: "#2e7d32", ink: "#ffffff" } } };
const BOB = { login: "bob", display: "Bob" };
const KEY = { login: "u:ABC-123456", display: "u:ABC-123456", acct: true, web: true };     // a web member whose name didn't resolve
const FEED = [
  { k: "join", c: 1, ts: T(30), u: BOB },
  { k: "msg", c: 2, ts: T(29), u: PB, text: "hello room" },
  { k: "msg", c: 3, ts: T(28), u: { login: "bobcf", display: "Bobby" }, text: "display differs" },
  { k: "msg", c: 4, ts: T(27), u: { login: "u:ABC-654321", display: "Mae", acct: true, web: true, patv: { username: "mae", avatar: null, style: "" } }, text: "typed on the website" },
  { k: "msg", c: 5, ts: T(26), u: KEY, text: "my name didn't resolve" },
  { k: "mic", c: 6, ts: T(25), u: BOB },
  { k: "tx", c: 7, ts: T(24), id: "tx-0123abcd", u: BOB, text: "said on the mic" },
  { k: "unmic", c: 8, ts: T(23), u: BOB, ms: 180000 },
  { k: "msg", c: 9, ts: T(22), u: { former: true }, text: "a former member's line" },
  { k: "leave", c: 10, ts: T(21), u: { anon: true, display: "someone" } },
  { k: "topic", c: 11, ts: T(20), text: "movie night at 9" },
  { k: "live", c: 12, ts: T(19), who: "pb", pad: "Houseplants", what: "Movie night", link: "/p/plant_based_chatting" },
  { k: "note", c: 13, ts: T(17), w: "window", s: 86400 },
  { k: "msg", c: 14, ts: T(16), u: BOB, text: "hidden by a mod", removed: { at: T(15), by: "mod", who: "mae", why: "spam" } },
  { k: "msg", c: 15, ts: T(1), u: { login: "pepefrog", display: "PepeFrog", self: true }, text: "the newest line" },
];
const MEMBERS = [PB, Object.assign({}, BOB, { on_cam: true, on_mic: true, src: "list" }), { login: "bobcf", display: "Bobby", src: "seen" }, { anon: true, display: "someone" },
  { login: "pepefrog", display: "PepeFrog", self: true, src: "self" }, KEY];
const INITIAL = {
  room: { name: "Houseplants", slug: "plant_based_chatting", topic: "Grow stuff", count: MEMBERS.length, live: true, updated: NOW, listAt: NOW - 60e3, listFresh: true,
          seenTtl: 15 * 60e3, listStaleAfter: 10 * 60e3, transcripts: true, audio: false, relay: true, micRelay: false, cams: true, clip: null, cmds: null, pepe: null },
  mine: [], ver: 1, mver: 0, mod: null, members: MEMBERS, mic: [Object.assign({}, BOB, { on_mic: true })], feed: FEED, cursor: 15,
  history: { chat_s: 86400, search: true, explain: "/privacy#chat-history", v: "v1" },
};
const ROOM = { id: "Plant Based Chatting", name: "Houseplants", slug: "plant_based_chatting", count: MEMBERS.length, live: true, topic: "Grow stuff", platform: "camfrog",
               description: "Plants and chat", owner: "pb", ownerUser: "pb", camfrogName: "Plant Based Chatting" };
let HTML = null;
async function page() {
  if (HTML) return HTML;
  HTML = (await ejs.renderFile(path.join(repo, "views", "room.ejs"), {
    user: "viewer", signedIn: true, linked: true, room: ROOM, initial: INITIAL, onStage: false, stage: {}, latest: [],
    padTabs: { tabs: ["live", "about"], initial: "live", active: true, camfrog: true, posts: [] },
  })).replace(/\r\n/g, "\n");
  return HTML;
}
function pageScript(html) {
  const init = html.indexOf('<script id="rmInit" type="application/json">');
  assert.ok(init > 0, "the seeded view");
  const json = html.slice(html.indexOf(">", init) + 1, html.indexOf("</script>", init));
  const open = html.indexOf("<script>", init), close = html.indexOf("</script>", open);
  return { json, src: html.slice(open + 8, close) };
}

/** Runs the page's script; core = load chatlog-core.js first (as the page does) or not (it failed to load). */
async function run({ core, search = "" }) {
  const { json, src } = pageScript(await page());
  const ids = { rmInit: { tag: "script", text: json } };
  for (const id of ["rmFeed", "rmJump", "rmScroll", "rmOlder", "rmMic", "rmPeople", "rmPplN", "rmListNote", "rmTopic", "rmCount", "rmStDot", "rmLive", "rmLiveTxt",
    "rmAudioBox", "rmCompose", "rmRelay", "rmStatus", "rmChat", "rmClip", "rmMod", "rmHistTop", "rmHistBot", "rmHistJump", "rmSearchBtn"]) ids[id] = {};
  ids.rmHist = { tag: "a" };
  ids.rmTopic.attrs = { "data-desc": "Plants and chat" };
  const doc = fakeDocument(ids);
  const errors = [], timers = [], relay = {};
  const win = {
    document: doc, location: { search, href: "", origin: "https://publicaccess.tv" }, navigator: { userAgent: "test" },
    console: { error: (...a) => errors.push(a.map(String).join(" ")), log() {}, warn() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, removeEventListener() {},
    fetch: () => new Promise(() => {}),                      // the long poll never answers here
    // room-bridge.js's pieces the page needs (stubs); the relay hands back the page's own line builder
    PATVRoom: {
      audio: () => ({ update() {} }), ptt: () => ({ update() {} }),
      relay: (host, slug, opts) => { relay.opts = opts; return { anchor: () => null, update() {}, refetch: () => 0, reset() {}, wantsMe: () => false }; },
    },
    JSON, Math, Date, String, Number, Array, Object, RegExp, Error, encodeURIComponent, decodeURIComponent, isNaN, isFinite, parseInt,
  };
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  if (core) vm.runInContext(CORE_SRC, ctx, { filename: "chatlog-core.js" });
  vm.runInContext(src, ctx, { filename: "room.ejs page script" });
  return { doc, errors, timers, relay, feed: doc.getElementById("rmFeed"), win };
}
const tEN = (k, d, v) => { if (d && typeof d === "object") d = v && v.count === 1 ? d.one : d.other; return String(d).replace(/\{!?(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)); };

test("the rendered pad page: <main> carries .chatlog, chatlog.css right after the style block, chatlog-core.js before the page script", async () => {
  const html = await page();
  assert.match(html, /<main class="ds-page rm chatlog">/);
  // right after the page's own style block (the comment between renders to nothing): its rules keep their order in the cascade
  assert.match(html, /<\/style>\s*<link rel="stylesheet" href="\/public\/css\/chatlog\.css\?v=\d+">/);
  const core = html.search(/<script src="\/public\/js\/chatlog-core\.js\?v=\d+"><\/script>/), init = html.indexOf('<script id="rmInit"');
  assert.ok(core > 0 && core < init, "the renderer loads before the page script");
  assert.match(html, /<link rel="stylesheet" href="\/public\/css\/ds\.css\?v=3">/, "the tokens chatlog.css reads (--ds-chat-*)");
  // mentions.js's ?line= highlight is styled by chatlog.css (in both directions)
  const css = rd("public", "css", "chatlog.css");
  assert.match(css, /\.chatlog \.line\.hl \{/);
  assert.match(css, /\[dir="rtl"\] \.chatlog \.line\.hl \{ box-shadow: inset -3px 0 0 /);
  assert.match(rd("public", "js", "chatlog-core.js"), /function flairNode\(u, ctx, h\)/, "pad flair on the chat: chatlog-core draws the chip");
});

test("the page's real script with chatlog-core: every line, the lists, the chip and your pending line are the renderer's", async () => {
  const P = await run({ core: true });
  assert.deepEqual(P.errors, [], "nothing logged");
  assert.ok(P.timers.length >= 1, "the poll started");
  const doc = P.doc, H = CL.domH(doc), ctx = { t: tEN, lang: "en" };
  const want = FEED.map((it) => CL.renderItem(it, ctx, H)).filter(Boolean);
  assert.equal(P.feed.childNodes.length, want.length, "every renderable item is a line");
  want.forEach((n, i) => assert.deepEqual(tree(P.feed.childNodes[i]), tree(n), "line " + i));
  assert.ok(P.feed.childNodes.some((n) => n._c === 14 && n.className === "line rm"), "the owner's / staff's muted copy of a hidden line");
  // no account key anywhere on the page's chat
  const all = JSON.stringify(P.feed.childNodes.map(tree)) + JSON.stringify(tree(doc.getElementById("rmPeople")));
  assert.doesNotMatch(all, /ABC-123456/i);
  assert.match(all, /a PATV member/);
  // the people and mic lists: the renderer's avatars and names
  const ppl = doc.getElementById("rmPeople").childNodes;
  assert.equal(ppl.length, MEMBERS.length);
  const pb = ppl.find((li) => li.textContent.includes("Plantbaked"));
  assert.deepEqual(tree(pb.childNodes[0]), tree(CL.avatarNode(PB, ctx, H)));
  assert.deepEqual(tree(pb.childNodes[1].childNodes[0]), tree(CL.nameNode(PB, ctx, H)));
  const mic = doc.getElementById("rmMic").childNodes[0];
  assert.deepEqual(tree(mic.childNodes[0]), tree(CL.avatarNode(BOB, ctx, H)));
  assert.equal(doc.getElementById("rmPplN").textContent, "(" + MEMBERS.length + ")");
  // the 📜 chip, with chatlog-core's span
  assert.match(doc.getElementById("rmHist").textContent, /^📜 24 h\s🔍$/);
  // your pending relay line (room-bridge.js builds it with the page's line builder)
  const mine = P.relay.opts.line({ k: "msg", u: { display: "you", login: "", web: true }, text: "on its way", ts: T(0) });
  assert.deepEqual(tree(mine), tree(CL.renderItem({ k: "msg", u: { display: "you", login: "", web: true }, text: "on its way", ts: T(0) }, ctx, H)));
  assert.equal(P.relay.opts.feed, P.feed);
});

test("a ?line= link (a 📣 mention alert) highlights its line: .line.hl", async () => {
  const P = await run({ core: true, search: "?line=3" });
  assert.deepEqual(P.errors, []);
  const n = P.feed.childNodes.find((x) => x.getAttribute("data-c") === "3");
  assert.ok(n && n.classList.contains("hl"), "the line carries .hl");
  assert.equal(P.feed.childNodes.filter((x) => x.classList.contains("hl")).length, 1);
});

test("chatlog-core.js didn't load: the page still runs - plain lines, the lists, the composer, the poll", async () => {
  const P = await run({ core: false });
  assert.equal(P.errors.length, 1, P.errors.join(" | "));
  assert.match(P.errors[0], /chatlog-core\.js did not load/);
  assert.ok(P.timers.length >= 1, "the poll started");
  // chat and mic lines, plain: "name: text · hh:mm"; no system lines, no hidden line, no account key
  const shown = FEED.filter((it) => (it.k === "msg" || it.k === "tx") && !it.removed);
  assert.equal(P.feed.childNodes.length, shown.length);
  const texts = P.feed.childNodes.map((n) => n.textContent);
  shown.forEach((it, i) => {
    assert.equal(P.feed.childNodes[i].className, "sys");
    assert.match(texts[i], / · \d\d:\d\d$/);
  });
  assert.equal(texts[0], "Plantbaked: hello room · " + texts[0].slice(-5));
  assert.ok(texts.some((s) => s.startsWith("Bob: “said on the mic”")), "🎙 in quotes");
  assert.ok(texts.some((s) => s.startsWith("a PATV member: my name didn't resolve")), "no account key");
  assert.ok(texts.some((s) => s.startsWith("former member: ")));
  assert.doesNotMatch(texts.join("\n"), /ABC-123456|hidden by a mod/i);
  // the people and mic lists still render (a plain "?" bubble), the count, the 📜 chip, your pending line
  const ppl = P.doc.getElementById("rmPeople").childNodes;
  assert.equal(ppl.length, MEMBERS.length);
  assert.equal(ppl[0].childNodes[0].className, "av anon");
  assert.doesNotMatch(P.doc.getElementById("rmPeople").textContent, /ABC-123456/i);
  assert.equal(P.doc.getElementById("rmMic").childNodes.length, 1);
  assert.match(P.doc.getElementById("rmHist").textContent, /^📜 24 h\s🔍$/, "hours without the renderer too");
  const mine = P.relay.opts.line({ k: "msg", u: { display: "you", login: "", web: true }, text: "on its way", ts: T(0) });
  assert.match(mine.textContent, /^you: on its way · \d\d:\d\d$/);
});
