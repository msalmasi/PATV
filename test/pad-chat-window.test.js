"use strict";
// 1.99ajh dockpop (owner P1: "have chat persist as you navigate the pad tabs, or even the site ... playing holdem and having chat on the
// side"): GET /p/:slug/chat - the pad's chat in its OWN window (bridge.js; views/room.ejs chatOnly + views/partials/popout-head.ejs).
//   * only where the pad page's Live chat is (a live bridged Camfrog pad, its bridge perk, padaccess.full, the 18+ gate, the Room Dock for
//     this viewer) - anything else is a 302 to the pad page; never cached, indexed or framed
//   * the Dock's chat card alone: no stage, tabs, navbar or footer; the site's own head; ONE copy of the live script
//   * /live?pop=1 carries the viewer tag (roompm.tag, never the account id) and no mic-stage program; the pad page's answers are as before
//   * the same lines as the pad page (veils, masked bars, Reveal); room PM rows only in their owner's answers
//   * the window's script: another account's answer (a vt change) or a 401 wipes it - lines, room PM rows, people - and stops the poll,
//     with no navigation
//   node --test test/pad-chat-window.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-chat-window-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
process.env.MEDIA_DIR = path.join(tmp, "media"); fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
process.env.FEED_DIR = path.join(tmp, "feed"); fs.mkdirSync(process.env.FEED_DIR, { recursive: true });
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const PD = require(path.join(repo, "paddock"));
const RPM = require(path.join(repo, "roompm"));
const bridge = require(path.join(repo, "bridge"));
const premium = require(path.join(repo, "premium"));
require(path.join(repo, "terms"))._setRequired(false);

const CHAT = "Window.Pad", MEMBERS = "Members.Pad", OFFLINE = "Offline.Pad";
const users = new Map(), U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u); return u;
}
let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "cw-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });
const snapOf = (id, extra = {}) => ({ room: { id, name: id }, topic: "Tonight in the orchard", count: 4, cams: true, relay: true, mic_relay: true, audio: false, ...extra,
  members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, { id: "alicecf", login: "alicecf", display: "Alice", on_cam: true },
            { id: "viewercf", login: "viewercf", display: "Viewer" }],
  mic: [{ id: "alicecf", login: "alicecf", display: "Alice" }] });
let base, server, SLUG, MSLUG, OSLUG;
const H = (u) => Object.assign({ "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function get(url, u) {
  const r = await fetch(base + url, { headers: H(u), redirect: "manual" });
  const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, headers: r.headers, text, d };
}
const mode = (m) => PD.save(U.admin, { cfg: { mode: m } });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  U.viewer = await mkUser("viewer", { camfrog: "viewercf" });
  U.other = await mkUser("otherone", { camfrog: "othercf" });
  U.unlinked = await mkUser("webonly");
  U.staff = await mkUser("helper", { class: "Staff" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('pepe-bot', 'pepe', 'Pepe', 'x', 'pepefrog')");
  await rooms.init();
  for (const id of [CHAT, MEMBERS, OFFLINE]) await rooms.addRoom(id, id, "test");
  SLUG = (await rooms.get(CHAT)).slug; MSLUG = (await rooms.get(MEMBERS)).slug; OSLUG = (await rooms.get(OFFLINE)).slug;
  await PA.init();
  await runQuery("INSERT INTO pad_access (room_id, level, updated, updated_by) VALUES (?, 'public', ?, 'test')", [CHAT, Date.now()]);
  PA._reset(); await PA.init();
  for (const id of [CHAT, MEMBERS]) {
    await bridge.ingest({ events: [
      ev({ id, name: id }, "message", { user: { id: "alicecf", login: "alicecf", display: "Alice" }, text: "LINE-one from " + id }),
      ev({ id, name: id }, "message", { user: { id: "viewercf", login: "viewercf", display: "Viewer" }, text: "LINE-two from " + id }),
    ], rooms: [snapOf(id)] });
  }
  await PD.init();
  await mode("everyone");
  const app = express();
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; req.flash = () => []; next(); });
  require(path.join(repo, "cosmetics")).locals(app);
  require(path.join(repo, "userlinks")).install(app);
  require(path.join(repo, "boostmark")).install(app);
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: () => false });
  bridge.register(app, { addUser, isBotToken: () => false });
  require(path.join(repo, "home")).register(app, { addUser, xpForNextLevel: () => 100 });   // (the homepage's Room Dock follows the same switch)
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

const SAME = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive", "x-frame-options": "DENY",
               "content-security-policy": "frame-ancestors 'none'", "referrer-policy": "same-origin" };
const headersOk = (r, what) => { for (const [k, v] of Object.entries(SAME)) assert.equal(r.headers.get(k), v, what + ": " + k); };

test("the window: the Dock's chat card alone, the site's head, never cached / indexed / framed; one #rmFeed; vt = roompm.tag", async () => {
  const r = await get("/p/" + SLUG + "/chat", U.viewer);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  headersOk(r, "200");
  const h = r.text;
  assert.match(h, /<body class="rmd-pop">/);
  assert.match(h, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(h, /<main class="ds-page rm chatlog[^"]* rm-dock rmd-popout"/);
  assert.match(h, /<title>Window\.Pad · chat<\/title>/);
  for (const id of ["rmChat", "chatH", "rmFeed", "rmScroll", "rmCompose", "rmRelay", "rmPtt", "rmAudioBox", "rmPplCard", "rmPeople", "rmMod", "rmdId", "padPanel-live"])
    assert.equal((h.match(new RegExp('id="' + id + '"', "g")) || []).length, 1, id);
  for (const id of ["rmStage", "padTabs", "rmHero", "rmGoLive", "rmStrip", "padPanel-feed", "padPanel-about", "siteFootTpl", "padLaunch"]) assert.doesNotMatch(h, new RegExp('id="' + id + '"'), id);
  assert.doesNotMatch(h, /class="navbar"|<script src="[^"]*\/(?:pad-tabs|stage-room|stage-player|stage-mic|pad-camstrip|pad-launch)\.js|patv_chat_sweep|\/api\/u\/[^'"]+\/profile/);
  assert.match(h, /<script src="\/public\/js\/dock-link\.js\?v=2"><\/script><script src="\/public\/js\/pad-dock\.js\?v=10"><\/script>/);   // (1.99ajn padppl: v6 - a veiled line opens the person menu; the chat ⋯ mention items; 1.99ajq dockpol: v7; 1.99ajw casino2: dock-link v2 + pad-dock v8 - the chat beside a casino table; 1.99ajy dockmedia: v9)
  assert.match(h, /var pageVt = "([^"]+)", chatOnly = true;/);
  assert.equal(/var pageVt = "([^"]+)"/.exec(h)[1], RPM.tag(U.viewer.userId), "the window's viewer tag is roompm.tag");
  assert.notEqual(RPM.tag(U.viewer.userId), U.viewer.userId); assert.doesNotMatch(h, new RegExp('pageVt = "' + U.viewer.userId));
  assert.match(h, /mode: chatOnly \? 'popout' : 'pad'/);
  assert.match(h, /&pop=1/);
  // the head is the site's own (layout.ejs): the same stylesheets and scripts, in the same order
  const tags = (s) => (s.match(/<link rel="stylesheet" href="[^"]+">|<link href="[^"]+" rel="stylesheet">|<script src="[^"]+"><\/script>|<script>window\.(?:PATV_TZ_SAVED|__t)[^<]*/g) || []);
  const rdLf = (f) => fs.readFileSync(path.join(repo, f), "utf8").replace(/\r\n/g, "\n");
  const layout = rdLf("views/layout.ejs"), popHead = rdLf("views/partials/popout-head.ejs");
  const lh = layout.slice(0, layout.indexOf("</head>")).replace(/<%[\s\S]*?%>/g, (m) => (/cwHead_/.test(m) ? "" : m));
  assert.deepEqual(tags(popHead.slice(0, popHead.indexOf("</head>"))), tags(lh).filter((t) => !/cwHead_|fonts\b(?!\.googleapis)/.test(t)), "the head's link and script tags equal layout.ejs's");
  const signedOut = await get("/p/" + SLUG + "/chat", null);
  assert.equal(signedOut.status, 200, "a Public pad's window, read-only");
  assert.match(signedOut.text, /var pageVt = null, chatOnly = true;/);
});

test("every way it isn't the pad's live chat for this viewer goes to the pad page (302), with the same headers", async () => {
  const cases = [
    ["no such pad", "/p/no-such-pad/chat", U.viewer, "/p/no-such-pad"],
    ["a pad Pepe isn't bridging", "/p/" + OSLUG + "/chat", U.viewer, "/p/" + OSLUG],
    ["members-tier, signed out", "/p/" + MSLUG + "/chat", null, "/p/" + MSLUG],
  ];
  for (const [what, url, u, to] of cases) {
    const r = await get(url, u);
    assert.equal(r.status, 302, what); assert.equal(r.headers.get("location"), to, what); headersOk(r, what);
  }
  const orig = premium.bridgeAllowed;
  try {
    premium.bridgeAllowed = () => false;
    const r = await get("/p/" + SLUG + "/chat", U.viewer);
    assert.equal(r.status, 302, "no 💎 bridge perk"); assert.equal(r.headers.get("location"), "/p/" + SLUG);
  } finally { premium.bridgeAllowed = orig; }
  const ag = PA.adultGate;
  try {
    PA.adultGate = () => "confirm";
    assert.equal((await get("/p/" + SLUG + "/chat", U.viewer)).status, 302, "the 18+ gate");
  } finally { PA.adultGate = ag; }
  const getPad = rooms.get;
  try {
    rooms.get = async (id) => { const r = await getPad(id); return r && id === CHAT ? Object.assign({}, r, { platform: "site" }) : r; };
    assert.equal((await get("/p/" + SLUG + "/chat", U.viewer)).status, 302, "not a Camfrog pad (a site pad - its chat is the chat hub's)");
  } finally { rooms.get = getPad; }
  // the Room Dock: off for everyone, then staff only
  await mode("off");
  try {
    for (const u of [U.viewer, U.staff, null]) assert.equal((await get("/p/" + SLUG + "/chat", u)).status, 302, "Dock off");
    await mode("staff");
    assert.equal((await get("/p/" + SLUG + "/chat", U.viewer)).status, 302, "'staff' - a viewer");
    assert.equal((await get("/p/" + SLUG + "/chat", null)).status, 302, "'staff' - signed out");
    assert.equal((await get("/p/" + SLUG + "/chat", U.staff)).status, 200, "'staff' - staff");
  } finally { await mode("everyone"); }
  assert.equal((await get("/p/" + MSLUG + "/chat", U.viewer)).status, 200, "members-tier, signed in");
});

test("/live?pop=1 carries the viewer tag and no mic-stage program; the pad page's answers are unchanged (no vt)", async () => {
  const pop = await get("/api/rooms/" + SLUG + "/live?pad=1&pop=1", U.viewer);
  assert.equal(pop.status, 200);
  assert.equal(pop.d.vt, RPM.tag(U.viewer.userId));
  assert.equal("stage_program" in pop.d, false, "no stage program for the window");
  const pad = await get("/api/rooms/" + SLUG + "/live?pad=1", U.viewer);
  assert.equal("vt" in pad.d, false, "the pad page's answer has no vt");
  assert.equal("stage_program" in pad.d, true, "the pad page keeps its mic stage");
  const home = await get("/api/rooms/" + SLUG + "/live", U.viewer);
  assert.equal("vt" in home.d, false);
  const out = await get("/api/rooms/" + SLUG + "/live?pad=1&pop=1", null);
  assert.equal("vt" in out.d, false, "signed out: no tag");
  assert.notEqual(RPM.tag(U.viewer.userId), RPM.tag(U.other.userId));
  assert.match(RPM.tag(U.viewer.userId), /^[A-Za-z0-9_-]{16}$/);
  assert.equal(RPM.tag(null), null);
});

test("the window's lines are the pad page's (the same view, veils and all); room PM rows only in their owner's own answers", async () => {
  RPM.addLocal(U.viewer.userId, CHAT, "Your balance: 12,345 PAT", "!bal");
  const initOf = (h) => JSON.parse(/<script id="rmInit" type="application\/json">([\s\S]*?)<\/script>/.exec(h)[1].replace(/\\u003c/g, "<"));
  const win = initOf((await get("/p/" + SLUG + "/chat", U.viewer)).text), pad = initOf((await get("/p/" + SLUG, U.viewer)).text);
  assert.deepEqual(win.feed.map((x) => [x.k, x.c, x.text, x.u && x.u.login]), pad.feed.map((x) => [x.k, x.c, x.text, x.u && x.u.login]));
  assert.deepEqual(win.rpm.rows.map((r) => r.text), ["Your balance: 12,345 PAT"]);
  assert.deepEqual(win.rpm.rows, pad.rpm.rows);
  assert.equal("stage_program" in win, false); assert.equal("stage_program" in pad, true);
  const other = initOf((await get("/p/" + SLUG + "/chat", U.other)).text);
  assert.equal((other.rpm && other.rpm.rows || []).length, 0, "another account never gets these rows");
  const otherLive = await get("/api/rooms/" + SLUG + "/live?pad=1&pop=1&rpm=0", U.other);
  assert.equal((otherLive.d.rpm && otherLive.d.rpm.rows || []).length, 0);
  const mine = await get("/api/rooms/" + SLUG + "/live?pad=1&pop=1&rpm=0", U.viewer);
  assert.deepEqual(mine.d.rpm.rows.map((r) => r.text), ["Your balance: 12,345 PAT"]);
});

// ── the window's own script (views/room.ejs chatOnly) in a small fake DOM ──
class FText { constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; } get textContent() { return this.data; } }
class FEl {
  constructor(tag, doc) { this.nodeType = tag === "#fragment" ? 11 : 1; this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.attrs = {}; this.childNodes = []; this.parentNode = null; this.style = {}; this._cls = []; this.listeners = {}; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 0; this.hidden = false; }
  get className() { return this._cls.join(" "); } set className(v) { this._cls = String(v).split(/\s+/).filter(Boolean); }
  get classList() { const me = this; return { add: (...c) => c.forEach((x) => { if (!me._cls.includes(x)) me._cls.push(x); }), remove: (...c) => { me._cls = me._cls.filter((x) => !c.includes(x)); }, contains: (c) => me._cls.includes(c), toggle: (c, on) => { const has = me._cls.includes(c), want = on === undefined ? !has : !!on; if (want && !has) me._cls.push(c); if (!want && has) me._cls = me._cls.filter((x) => x !== c); return want; } }; }
  setAttribute(k, v) { if (k === "class") this.className = v; else this.attrs[k] = String(v); } getAttribute(k) { return k === "class" ? this.className : k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  get firstChild() { return this.childNodes[0] || null; } get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = v == null || v === "" ? [] : [Object.assign(new FText(v), { parentNode: this })]; }
  _take(n) { if (n.nodeType === 11) { const k = n.childNodes.slice(); n.childNodes = []; return k; } if (n.parentNode) n.parentNode.removeChild(n); return [n]; }
  appendChild(n) { for (const k of this._take(n)) { k.parentNode = this; this.childNodes.push(k); } return n; }
  insertBefore(n, ref) { if (!ref) return this.appendChild(n); if (n === ref) return n; const kids = this._take(n), i = this.childNodes.indexOf(ref); kids.forEach((k) => { k.parentNode = this; }); this.childNodes.splice(i, 0, ...kids); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } removeEventListener() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; } focus() {}
  matches(sel) { const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/i.exec(sel.trim()); if (!m) return false; if (m[1] && this.tagName !== m[1].toUpperCase()) return false; for (const c of m[2].split(".").filter(Boolean)) if (!this._cls.includes(c)) return false; return !m[3] || this.attrs[m[3]] === m[4]; }
  querySelectorAll(sel) { const out = [], walk = (n) => { for (const k of n.childNodes) if (k.nodeType === 1) { if (sel.split(",").some((s) => k.matches(s))) out.push(k); walk(k); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest() { return null; }
}
async function runWindow(html, viewer) {
  const init = html.indexOf('<script id="rmInit" type="application/json">');
  const json = html.slice(html.indexOf(">", init) + 1, html.indexOf("</script>", init));
  const open = html.indexOf("<script>", init), close = html.indexOf("</script>", open), src = html.slice(open + 8, close);
  const doc = { documentElement: { lang: "en", dir: "ltr" }, hidden: false, listeners: {}, body: null };
  doc.createElement = (t) => new FEl(t, doc); doc.createTextNode = (t) => new FText(t); doc.createDocumentFragment = () => new FEl("#fragment", doc);
  doc.addEventListener = (t, fn) => { (doc.listeners[t] = doc.listeners[t] || []).push(fn); };
  const main = new FEl("main", doc); main.className = "ds-page rm chatlog rm-dock rmd-popout";
  doc.querySelector = (s) => (s === "main.rm" ? main : null); doc.querySelectorAll = () => [];
  const byId = {};
  const ids = ["rmFeed", "rmJump", "rmScroll", "rmOlder", "rmMic", "rmPeople", "rmPplN", "rmListNote", "rmTopic", "rmAudioBox", "rmCompose", "rmRelay", "rmPtt", "rmStatus", "rmChat", "rmClip", "rmMod", "rmHistTop", "rmHistBot", "rmHistJump", "rmSearchBtn", "rmHist"];
  doc.getElementById = (id) => { if (id === "rmInit") { const e = new FEl("script", doc); e.textContent = json; return e; } if (!ids.includes(id)) return null; if (!byId[id]) { byId[id] = new FEl("div", doc); byId[id].id = id; main.appendChild(byId[id]); } return byId[id]; };
  const timers = [], urls = [], errors = [], winListeners = {}, goneKeys = [], destroyed = { relay: 0, ptt: 0 };
  let answer = null, status = 200, paused = 0, relayOpts = null;
  // (1.99ajh dockpop review: a Room Dock that records the card the window asks for; the relay / push-to-talk know destroy())
  const dock = new Proxy({}, { get: (t, k) => (k === "gone" ? (key) => { goneKeys.push(key || "pop_gone"); } : k === "visible" || k === "floating" || k === "popped" ? () => false : () => undefined) });
  const win = {
    document: doc, location: { search: "", href: "/p/x/chat", pathname: "/p/x/chat", hash: "" }, navigator: { userAgent: "test" }, history: { replaceState() {} },
    console: { error: (...a) => errors.push(a.map(String).join(" ")), log() {}, warn() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); }, removeEventListener() {},
    fetch: (url) => { urls.push(String(url)); const a = answer, s = status; return Promise.resolve({ status: s, ok: s === 200, json: () => Promise.resolve(a) }); },
    PATVRoom: { audio: () => ({ update() {}, pause() { paused++; return true; }, isPlaying: () => true }), ptt: () => ({ update() {}, destroy() { destroyed.ptt++; } }),
      relay: (h, s, o) => { relayOpts = o; return { anchor: () => null, update() {}, refetch: () => 0, reset() {}, wantsMe: () => false, getInput: () => null, destroy() { destroyed.relay++; } }; } },
    PATVPadDock: { init: () => dock },
    JSON, Math, Date, String, Number, Array, Object, RegExp, Error, encodeURIComponent, decodeURIComponent, isNaN, isFinite, parseInt,
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/chatlog-core.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/pad-roompm.js"), "utf8"), ctx);
  vm.runInContext(src, ctx, { filename: "room.ejs (chatOnly)" });
  const feed = doc.getElementById("rmFeed");
  async function poll(a, s = 200) {
    answer = a; status = s;
    const t = timers.pop(); assert.ok(t, "a poll is scheduled");
    t.fn(); for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  }
  return { feed, doc, main, urls, errors, timers, poll, win, paused: () => paused, people: doc.getElementById("rmPeople"), goneKeys, destroyed, relayOpts: () => relayOpts, listeners: winListeners };
}
test("the window's script: another account's answer (vt) or a 401 wipes every line, room PM row and person, stops the poll, never navigates", async () => {
  RPM.addLocal(U.viewer.userId, CHAT, "Your balance: 99 PAT", "!bal");
  const html = (await get("/p/" + SLUG + "/chat", U.viewer)).text;
  const live = (await get("/api/rooms/" + SLUG + "/live?pad=1&pop=1&rpm=0&after=0", U.viewer)).d;
  for (const [what, answer, status] of [["vt", Object.assign({}, live, { vt: RPM.tag(U.other.userId), lp: true }), 200], ["no vt", Object.assign({}, live, { vt: undefined, lp: true }), 200], ["401", { error: "Sign in" }, 401]]) {
    const P = await runWindow(html, U.viewer);
    assert.ok(P.feed.childNodes.length >= 2, what + ": lines drawn");
    assert.ok(P.feed.querySelectorAll(".rpm").length >= 1, what + ": the viewer's room PM row");
    // a normal answer (the same account) keeps everything
    await P.poll(Object.assign({}, live, { feed: [], lp: true }));
    assert.match(P.urls.at(-1), /[?&]pad=1&pop=1&/, "the window asks with pop=1");
    assert.ok(P.feed.childNodes.length >= 2 && P.timers.length === 1, what + ": still running");
    await P.poll(answer, status);
    assert.equal(P.feed.childNodes.length, 0, what + ": the lines are gone");
    assert.equal(P.feed.querySelectorAll(".rpm").length, 0, what + ": room PM rows gone");
    assert.equal(P.people.childNodes.length, 0, what + ": the people list is gone");
    assert.equal(P.doc.getElementById("rmCompose").parentNode, null, what + ": the composer is removed");
    assert.equal(P.timers.length, 0, what + ": no poll scheduled any more");
    assert.equal(P.win.location.href, "/p/x/chat", what + ": no navigation (never /login)");
    assert.ok(P.paused() >= 1, what + ": the room audio stopped");
    assert.equal(P.destroyed.relay, 1, what + ": review - the relay's outbox ends first (nothing queued goes out as another account)");
    assert.equal(P.destroyed.ptt, 1, what + ": and a clip being recorded is never uploaded");
    assert.deepEqual(P.goneKeys, ["pop_gone"], what + ": 'You signed out or switched accounts'");
    assert.deepEqual(P.errors, [], what);
  }
});
test("review: the window's reason is the real one - 403 = not available to you any more; a signed-out window rides out a 401 (a restart), signs in -> Reload", async () => {
  const html = (await get("/p/" + SLUG + "/chat", U.viewer)).text;
  const live = (await get("/api/rooms/" + SLUG + "/live?pad=1&pop=1&rpm=0&after=0", U.viewer)).d;
  const P = await runWindow(html, U.viewer);
  assert.equal(P.relayOpts().vt, RPM.tag(U.viewer.userId), "the relay sends the window's viewer tag");
  await P.poll({ error: "This pad is for approved members." }, 403);
  assert.deepEqual(P.goneKeys, ["pop_unavail"], "a 403: 'This chat isn't available to you any more'");
  assert.equal(P.feed.childNodes.length, 0, "and it is wiped all the same");
  const outHtml = (await get("/p/" + SLUG + "/chat", null)).text;
  const outLive = (await get("/api/rooms/" + SLUG + "/live?pad=1&pop=1&after=0", null)).d;
  const Q = await runWindow(outHtml, null);
  for (let i = 0; i < 3; i++) { await Q.poll({ error: "Sign in to watch the room." }, 401); assert.deepEqual(Q.goneKeys, [], "a signed-out window's 401 #" + (i + 1) + ": a retry"); }
  assert.ok(Q.feed.childNodes.length >= 1, "its (public) lines stay meanwhile");
  await Q.poll(Object.assign({}, outLive, { feed: [], lp: true }));
  assert.deepEqual(Q.goneKeys, [], "the room is back: nothing happened");
  await Q.poll(Object.assign({}, outLive, { vt: RPM.tag(U.viewer.userId), lp: true }));
  assert.deepEqual(Q.goneKeys, ["pop_signed_in"], "signed IN in another tab: its own card (with Reload)");
  const R2 = await runWindow(outHtml, null);
  for (let i = 0; i < 4; i++) await R2.poll({ error: "Sign in to watch the room." }, 401);
  assert.deepEqual(R2.goneKeys, ["pop_unavail"], "four 401s in a row: the chat isn't available here any more");
  // a focus re-checks only after the window was away 15 s or more (clicking between Hold'em and the chat cost one view each time)
  const F = await runWindow(html, U.viewer), now0 = Date.now(), realNow = Date.now;
  try {
    let t = now0; Date.now = () => t;
    const n = F.urls.length;
    (F.listeners.blur || []).forEach((f) => f({})); t += 3000; (F.listeners.focus || []).forEach((f) => f({}));
    assert.equal(F.urls.length, n, "away 3 s: no re-check");
    (F.listeners.blur || []).forEach((f) => f({})); t += 20000; (F.listeners.focus || []).forEach((f) => f({}));
    assert.equal(F.urls.length, n + 1, "away 20 s: one re-check");
    assert.doesNotMatch(F.urls.at(-1), /wait=1/, "at once, not a long-poll");
  } finally { Date.now = realNow; }
});
test("review: the pad page prints the viewer tag only for the Room Dock, and such a page is private to its viewer", async () => {
  const on = await get("/p/" + SLUG, U.other);   // (an account with no room PM rows here: those make it private, no-store)
  assert.match(on.text, new RegExp('var pageVt = "' + RPM.tag(U.other.userId) + '", chatOnly = false;'));
  assert.match(String(on.headers.get("cache-control")), /private/);
  await mode("off");
  try {
    const off = await get("/p/" + SLUG, U.other);
    assert.doesNotMatch(off.text, /var pageVt = "/, "Dock off: no tag in the page");
    assert.equal(off.headers.get("cache-control"), null, "Dock off: the pad page's headers as before");
  } finally { await mode("everyone"); }
});
test("the homepage's Room Dock follows the same switch: off = today's homepage, 'staff' = staff only, 'everyone' = all", async () => {
  const dockOf = async (u) => { const r = await get("/", u); assert.equal(r.status, 200, r.text.slice(0, 200)); return /id="hmDock"/.test(r.text) ? "dock" : /class="hm ds-page"/.test(r.text) ? "legacy" : "?"; };
  try {
    await mode("off");
    for (const u of [null, U.viewer, U.staff]) assert.equal(await dockOf(u), "legacy", "off");
    await mode("staff");
    assert.equal(await dockOf(U.viewer), "legacy", "'staff' - a viewer"); assert.equal(await dockOf(null), "legacy", "'staff' - signed out");
    assert.equal(await dockOf(U.staff), "dock", "'staff' - staff");
    await mode("everyone");
    for (const u of [null, U.viewer, U.staff]) assert.equal(await dockOf(u), "dock", "everyone");
    const h = (await get("/", U.viewer)).text;
    const init = JSON.parse(/<script id="hmdInit" type="application\/json">([\s\S]*?)<\/script>/.exec(h)[1]);   // (JSON.parse reads the page's \u003c escapes itself)
    assert.equal(init.vt, RPM.tag(U.viewer.userId), "the homepage's viewer tag");
  } finally { await mode("everyone"); }
});

// ── 1.99ajw casino2: the EMBED variant (a casino table's 💬 Chat panel frames the window) ──
async function getH(url, u, headers) {
  const r = await fetch(base + url, { headers: Object.assign(H(u), headers || {}), redirect: "manual" });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
test("casino2: ?embed=1 from a same-origin frame is the same page with SAMEORIGIN / frame-ancestors 'self'; every other request stays DENY / 'none'", async () => {
  const FRAME = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" };
  const ok = await getH("/p/" + SLUG + "/chat?embed=1", U.viewer, FRAME);
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  assert.equal(ok.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(ok.headers.get("content-security-policy"), "frame-ancestors 'self'");
  for (const k of ["cache-control", "x-robots-tag", "referrer-policy"]) assert.equal(ok.headers.get(k), SAME[k], "the other headers stay: " + k);
  assert.match(ok.text, /embed: true,/, "the Dock is told it is framed (pad-dock.js checks the parent itself)");
  assert.equal((ok.text.match(/id="rmFeed"/g) || []).length, 1, "the same one chat");
  // an older browser that sends no Sec-Fetch-* headers
  const old = await getH("/p/" + SLUG + "/chat?embed=1", U.viewer, {});
  assert.equal(old.headers.get("x-frame-options"), "SAMEORIGIN");
  // never framed: a top-level ?embed=1, a cross-site frame, the plain window
  const cases = [["top-level ?embed=1", "?embed=1", { "sec-fetch-dest": "document", "sec-fetch-site": "none" }],
                 ["a cross-site frame", "?embed=1", { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" }],
                 ["a same-site (another subdomain) frame", "?embed=1", { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" }],
                 ["the plain window, framed", "", FRAME], ["embed=2", "?embed=2", FRAME]];
  for (const [what, qs, hd] of cases) {
    const r = await getH("/p/" + SLUG + "/chat" + qs, U.viewer, hd);
    assert.equal(r.status, 200, what); headersOk(r, what);
    assert.match(r.text, /embed: false,/, what);
  }
  // the gates are the window's own. Review F7: an EMBED that isn't the viewer's chat answers a small card (never the pad page drawn inside
  // the table's panel): no chat, nothing about the room, it tells the casino table page (its parent, same origin, a table path) to close
  const no = await getH("/p/" + MSLUG + "/chat?embed=1", null, FRAME);
  assert.equal(no.status, 200);
  assert.equal(no.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(no.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'");
  assert.equal(no.headers.get("cache-control"), "private, no-store");
  assert.doesNotMatch(no.text, /rmFeed|rmInit|chatOnly|id="rm/, "no chat, no room data");
  assert.match(no.text, /parent\.postMessage\(\{t:'patv-chat:closed',why:'gate'\},location\.origin\)/);
  assert.ok(no.text.includes("/^\\/casino\\/(?:blackjack|holdem)\\/t\\/[0-9a-f]{10}$/.test(parent.location.pathname)"), "only a casino table page is told");
  assert.match(no.text, new RegExp('href="/p/' + MSLUG + '" target="_top"'));
  assert.doesNotThrow(() => new Function(no.text.match(/<script>([\s\S]*?)<\/script>/)[1]), "the card's script parses");
  // ...and the plain window (not an embed) still goes to the pad page, which renders the right gate
  const plain = await getH("/p/" + MSLUG + "/chat", null, {});
  assert.equal(plain.status, 302); assert.equal(plain.headers.get("location"), "/p/" + MSLUG);
  const top = await getH("/p/" + MSLUG + "/chat?embed=1", null, { "sec-fetch-dest": "document", "sec-fetch-site": "none" });
  assert.equal(top.status, 302, "a top-level ?embed=1 is the plain window");
});

test("casino2: bridge.chatGate = the window's gate (the casino's 💬 Chat asks it); liveBridged = a live bridged pad or null", async () => {
  assert.equal((await bridge.chatGate(U.viewer, SLUG)).ok, true);
  assert.equal((await bridge.chatGate(U.viewer, SLUG)).slug, SLUG);
  assert.equal((await bridge.chatGate(null, MSLUG)).ok, false, "members-tier, signed out");
  assert.equal((await bridge.chatGate(U.viewer, MSLUG)).ok, true);
  assert.equal((await bridge.chatGate(U.viewer, OSLUG)).ok, false, "not bridged");
  assert.equal((await bridge.chatGate(U.viewer, "no-such-pad")).ok, false);
  await mode("off");
  try { assert.equal((await bridge.chatGate(U.viewer, SLUG)).ok, false, "the Room Dock off"); } finally { await mode("everyone"); }
  assert.equal(bridge.liveBridged(CHAT).id, CHAT);
  assert.equal(bridge.liveBridged(OFFLINE), null);
  assert.equal(bridge.liveBridged("Nope.Pad"), null);
});

test("casino2: a chat beside a casino table and a pad tab of the same pad are ONE 🌐 web user (presence counts the account, /privacy#rooms-web)", async () => {
  const W = require(path.join(repo, "padweb"));
  W._reset();
  await get("/api/rooms/" + SLUG + "/live?after=0&pad=1", U.unlinked);              // the pad tab
  await get("/api/rooms/" + SLUG + "/live?after=0&pad=1&pop=1", U.unlinked);        // the frame beside the table (the window's poll)
  const noted = W.sweep(CHAT);         // (what forRoom lists from, before its privacy filters - test/bridge-web-presence.test.js has those)
  assert.equal(noted.filter((x) => x.userId === U.unlinked.userId).length, 1, "one entry for the account, whichever surfaces poll");
});
