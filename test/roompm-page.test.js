// 1.99?? roompm: the pad page's REAL script (views/room.ejs rendered with ejs) + public/js/chatlog-core.js + public/js/pad-roompm.js in
// a small fake DOM (test/chatlog-page.test.js's): Pepe's private answers to your typed commands are lines of the pad's chat -
//   * one of Pepe's lines (.line.pepe) with .rpm, "only you can see this · from Pepe" and a screen-reader prefix; never pickable (no
//     data-c / data-text / data-name / data-k anywhere in it, _c = 0)
//   * the first render places the rows by time among the lines; a new one that came before the echo of its own command moves below
//     the echo when it comes in; the long-poll asks with ?rpm=<the last one it has>
//   * root.rpm-on while the site says on (roompm.css hides the composer's 🔒 copies then); {on: 0} or no block = off
//   node --test test/roompm-page.test.js      (no database, no network)
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
const RPM_SRC = rd("public", "js", "pad-roompm.js");

// ── the fake DOM of test/chatlog-page.test.js ──
class FakeText {
  constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; }
  get textContent() { return this.data; }
}
class FakeStyle {
  constructor() { this._d = {}; }
  set cssText(v) { this._d = {}; for (const part of String(v || "").split(";")) { const i = part.indexOf(":"); if (i > 0) this._d[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); } }
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
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; }
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
    if (n === ref) return n;
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
function fakeDocument(ids, main) {
  const doc = { documentElement: { lang: "en", dir: "ltr" }, hidden: false, listeners: {} };
  doc.createElement = (t) => new FakeEl(t, doc);
  doc.createTextNode = (t) => new FakeText(t);
  doc.createDocumentFragment = () => new FakeEl("#fragment", doc);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); };
  doc.querySelector = (sel) => (sel === "main.rm" ? main : null);
  doc.querySelectorAll = () => [];
  const byId = {};
  doc.getElementById = (id) => {
    if (!(id in ids)) return null;
    if (!byId[id]) { const e = new FakeEl(ids[id].tag || "div", doc); e.id = id; Object.assign(e.attrs, ids[id].attrs || {}); if (ids[id].text != null) e.textContent = ids[id].text; byId[id] = e; }
    return byId[id];
  };
  return doc;
}
const allAttrs = (n, out = []) => { if (n.nodeType === 1) { out.push(...Object.keys(n.attrs)); n.childNodes.forEach((k) => allAttrs(k, out)); } return out; };

// ── the page, seeded ──
const NOW = Date.now();
const T = (minAgo) => NOW - minAgo * 60e3;
const PEPE = { login: "pepefrog", display: "PepeFrog", self: true };
const BOB = { login: "bob", display: "Bob" };
const FEED = [
  { k: "msg", c: 1, ts: T(30), u: BOB, text: "first" },
  { k: "msg", c: 2, ts: T(20), u: BOB, text: "second" },
  { k: "msg", c: 3, ts: T(10), u: BOB, text: "third" },
];
const R1 = { id: 1001, ts: T(15), text: "Your balance: PAT 12,345", cmd: "!balance" };
const R2 = { id: 1002, ts: T(5), text: "usage: !topic <new room topic>", cmd: "!topic" };
const INITIAL = {
  room: { name: "Houseplants", slug: "plant_based_chatting", topic: "Grow stuff", count: 2, live: true, updated: NOW, listAt: NOW - 60e3, listFresh: true,
          seenTtl: 15 * 60e3, listStaleAfter: 10 * 60e3, transcripts: true, audio: false, relay: true, micRelay: false, cams: true, clip: null,
          cmds: { "!spin": 5000, "!balance": 0 }, pepe: null },
  mine: [], ver: 1, mver: 0, mod: null, members: [BOB, Object.assign({ src: "self" }, PEPE)], mic: [], feed: FEED, cursor: 3,
  history: { chat_s: 86400, search: true, explain: "/privacy#chat-history", v: "v1" },
  rpm: { on: 1, v: 1002, u: PEPE, rows: [R1, R2] },
};
const ROOM = { id: "Plant Based Chatting", name: "Houseplants", slug: "plant_based_chatting", count: 2, live: true, topic: "Grow stuff", platform: "camfrog",
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
async function run() {
  const { json, src } = pageScript(await page());
  const ids = { rmInit: { tag: "script", text: json } };
  for (const id of ["rmFeed", "rmJump", "rmScroll", "rmOlder", "rmMic", "rmPeople", "rmPplN", "rmListNote", "rmTopic", "rmCount", "rmStDot", "rmLive", "rmLiveTxt",
    "rmAudioBox", "rmCompose", "rmRelay", "rmStatus", "rmChat", "rmClip", "rmMod", "rmHistTop", "rmHistBot", "rmHistJump", "rmSearchBtn"]) ids[id] = {};
  ids.rmHist = { tag: "a" };
  ids.rmTopic.attrs = { "data-desc": "Plants and chat" };
  const main = new FakeEl("main", null);
  main.className = "ds-page rm chatlog";
  const doc = fakeDocument(ids, main);
  const errors = [], timers = [], urls = [];
  let answer = null;
  const win = {
    document: doc, location: { search: "", href: "", origin: "https://publicaccess.tv" }, navigator: { userAgent: "test" },
    console: { error: (...a) => errors.push(a.map(String).join(" ")), log() {}, warn() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, removeEventListener() {},
    fetch: (url) => { urls.push(String(url)); const a = answer; return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(a) }); },
    PATVRoom: {
      audio: () => ({ update() {} }), ptt: () => ({ update() {} }),
      relay: () => ({ anchor: () => null, update() {}, refetch: () => 0, reset() {}, wantsMe: () => false }),
    },
    JSON, Math, Date, String, Number, Array, Object, RegExp, Error, encodeURIComponent, decodeURIComponent, isNaN, isFinite, parseInt,
  };
  win.window = win; win.self = win;
  const ctx = vm.createContext(win);
  vm.runInContext(CORE_SRC, ctx, { filename: "chatlog-core.js" });
  vm.runInContext(RPM_SRC, ctx, { filename: "pad-roompm.js" });
  vm.runInContext(src, ctx, { filename: "room.ejs page script" });
  const feed = doc.getElementById("rmFeed");
  async function poll(a) {
    answer = a;
    const t = timers.pop();
    assert.ok(t, "a poll is scheduled");
    t.fn();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  }
  return { doc, errors, feed, main, urls, poll };
}
const rpmNodes = (feed) => feed.childNodes.filter((n) => n.classList && n.classList.contains("rpm"));
const order = (feed) => feed.childNodes.map((n) => (n._rpm ? "rpm:" + n._rpm : "c:" + n._c));

test("the rendered pad page loads pad-roompm.js and roompm.css after room-bridge.js; the CSS hides the 🔒 copies while on", async () => {
  const html = await page();
  const rb = html.indexOf("/public/js/room-bridge.js"), js = html.search(/<script src="\/public\/js\/pad-roompm\.js\?v=\d+"><\/script>/),
        css = html.search(/<link rel="stylesheet" href="\/public\/css\/roompm\.css\?v=\d+">/), init = html.indexOf('<script id="rmInit"');
  assert.ok(rb > 0 && js > rb && css > rb && js < init, "after room-bridge.js, before the page script");
  const c = rd("public", "css", "roompm.css");
  assert.match(c, /\.rpm-on \.rb-cmdfeed \.rb-cmd-r \{ display: none; \}/);
  assert.match(c, /\.chatlog \.line\.rpm \{ border-inline-start: 2px dashed/);
});

test("the first render: the viewer's private answers are Pepe's lines, by time, marked, never pickable; root.rpm-on", async () => {
  const P = await run();
  assert.deepEqual(P.errors, [], "nothing logged");
  assert.deepEqual(order(P.feed), ["c:1", "c:2", "rpm:1001", "c:3", "rpm:1002"], "placed by time among the lines");
  const [a, b] = rpmNodes(P.feed);
  assert.ok(a.classList.contains("line") && a.classList.contains("pepe") && a.classList.contains("rpm"), a.className);
  assert.equal(a.getAttribute("data-rpm"), "1001");
  assert.equal(a._c, 0, "refilter / dropRemoved / redoLines skip it");
  const picks = allAttrs(a).filter((k) => /^data-(c|text|name|k|tx|own|vc|rmc|rm|hold|reveal)$/.test(k));
  assert.deepEqual(picks, [], "nothing ✂️ Clip chat, quotes, 🔊 Clip or the ⋯ menu could pick");
  assert.match(a.textContent, /Your balance: PAT 12,345/);
  assert.match(a.textContent, /only you can see this · from Pepe/);
  assert.equal(a.querySelector(".rpm-chip").textContent, "only you can see this · from Pepe");
  assert.match(a.querySelector(".sr-only").textContent, /^Private answer from Pepe:/);
  assert.match(a.getAttribute("title"), /private answer to your !balance/);
  assert.match(b.textContent, /usage: !topic <new room topic>/, "shown as text, never markup");
  assert.ok(P.main.classList.contains("rpm-on"), "the composer's 🔒 copies are hidden (roompm.css)");
  assert.match(P.main.style.cssText, /--rpm-cmd-done:"answered privately in the chat"/);
});

test("live: the long-poll asks with ?rpm=, a new answer goes below its command's late echo, off removes rpm-on", async () => {
  const P = await run();
  const base = Object.assign({}, INITIAL, { feed: [], lp: true, rpm: undefined });
  // an answer that reached the site before the echo of its command (Pepe's clock: the end of the second he sent it)
  const R3 = { id: 1003, ts: Math.floor(NOW / 1000) * 1000 + 999, text: "Spinning the wheel for PAT 5000, good luck!", cmd: "!spin" };
  await P.poll(Object.assign({}, base, { rpm: { on: 1, v: 1003, u: PEPE, rows: [R3] } }));
  assert.match(P.urls[P.urls.length - 1], /&rpm=1002(&|$)/, "asked from the last one the page had");
  assert.deepEqual(order(P.feed).slice(-2), ["rpm:1002", "rpm:1003"]);
  // the room's echo of "!spin" comes in now - said before the answer
  const echo = { k: "msg", c: 4, ts: Math.floor(NOW / 1000) * 1000 - 500, u: PEPE, text: "🌐 Alice (web): !spin" };
  await P.poll(Object.assign({}, base, { feed: [echo], cursor: 4, rpm: { on: 1, v: 1003, u: PEPE, rows: [] } }));
  assert.match(P.urls[P.urls.length - 1], /&rpm=1003(&|$)/);
  assert.deepEqual(order(P.feed).slice(-3), ["rpm:1002", "c:4", "rpm:1003"], "the answer moved below its echo");
  // the same row again (another tab's answer, a re-sent block): drawn once
  await P.poll(Object.assign({}, base, { cursor: 4, rpm: { on: 1, v: 1003, u: PEPE, rows: [R3] } }));
  assert.equal(rpmNodes(P.feed).length, 3);
  // the site switched them off: the composer's 🔒 copies show again
  await P.poll(Object.assign({}, base, { cursor: 4, rpm: { on: 0 } }));
  assert.equal(P.main.classList.contains("rpm-on"), false);
  await P.poll(Object.assign({}, base, { cursor: 4, rpm: { on: 1, v: 1003, rows: [] } }));
  assert.equal(P.main.classList.contains("rpm-on"), true);
  await P.poll(Object.assign({}, base, { cursor: 4 }));
  assert.equal(P.main.classList.contains("rpm-on"), false, "no block (an older site) = off");
  assert.deepEqual(P.errors, []);
});

test("a chat with nothing said yet: the private answer replaces the placeholder", async () => {
  const { json, src } = pageScript(await page());
  const data = JSON.parse(json);
  assert.ok(data.rpm && data.rpm.rows.length === 2, "the seeded page carries the rows");
  // pad-roompm on its own (the module's API), on an empty chat
  const doc = fakeDocument({}, null);
  const win = { document: doc, JSON, Math, Date, String, Number, Array, Object };
  win.window = win;
  vm.runInContext(RPM_SRC, vm.createContext(win), { filename: "pad-roompm.js" });
  const feed = new FakeEl("div", doc);
  const p = new FakeEl("p", doc); p.className = "muted"; p.textContent = "Nothing said yet"; feed.appendChild(p);
  const line = (it) => { const n = new FakeEl("div", doc); n.className = "line pepe"; n.setAttribute("data-c", "9"); n.setAttribute("data-text", it.text);
    const lt = new FakeEl("div", doc); lt.className = "line-text"; lt.textContent = it.text; n.appendChild(lt); return n; };
  let bottom = 0;
  const pm = win.PATVRoomPm.init({ feed, line, nearBottom: () => true, toBottom: () => { bottom++; } });
  assert.equal(pm.query(), "&rpm=0");
  pm.update({ rpm: { on: 1, v: 5, rows: [{ id: 5, ts: Date.now(), text: "hi", cmd: "!help" }] } });
  assert.equal(feed.childNodes.length, 1, "the placeholder went");
  assert.equal(feed.childNodes[0].getAttribute("data-c"), null);
  assert.equal(feed.childNodes[0].getAttribute("data-text"), null);
  assert.equal(bottom, 1, "a reader at the bottom stays there");
  assert.equal(pm.query(), "&rpm=5");
  // the page cleared its chat (a fresh view after its join cursor ran out): the rows it had come back with the next answer
  feed.textContent = "";
  assert.equal(pm.query(), "&rpm=0");
  pm.update({ rpm: { on: 1, v: 5, rows: [{ id: 5, ts: Date.now(), text: "hi", cmd: "!help" }] } });
  assert.equal(feed.childNodes.length, 1, "drawn again");
  // ... but a live log that merely trimmed its oldest lines (300) never brings them back
  pm.update({ rpm: { on: 1, v: 6, rows: [{ id: 6, ts: Date.now(), text: "two", cmd: "!help" }] } });
  feed.removeChild(feed.childNodes[0]);
  assert.equal(pm.query(), "&rpm=6");
  void src;
});
