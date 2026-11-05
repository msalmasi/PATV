// pubswitch (owner 2026-11-05 ~22:45Z): Players Lounge switched Members -> Public and the owner's signed-in Chrome showed the old
// layout (no Room Dock) on every load - through reloads, a sign-out / sign-in and the switch back - while signed out was fine, Pepe's
// Pad (Public from the start) was fine, and clearing the site's data fixed it. The server's answer was the same Dock page every time;
// what the clear removed was the browser's remembered cam strip (patv.camstrip.<slug>): every broken load restored a pinned cam that
// couldn't start (prod: start_timeout / no media), and the page's own start-up (deferred scripts, the Dock's DOMContentLoaded start)
// came 16-61 s late behind it. This file:
//   A. the real pad route + room.ejs through Members -> Public -> Members, Approved -> Public and a pad Public from the start: the
//      signed-in Dock page every time, the page never kept by the browser (private, no-store - Back from Settings came out of the
//      bfcache with the pre-switch page), the strip told whose memory it is; CL3 still holds (an Approved pad opening up never shows
//      its Approved-era lines to non-members);
//   B. pad-camstrip.js in a sandbox: remembered cams come back only after the page loaded (never while it is read), a cam that ended
//      is forgotten (no restore on the next load; ↻ Retry remembers it again), the memory is per account (the old per-browser key goes).
//   TZ=UTC node --test test/pubswitch.test.js      (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pubswitch-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const PA = require(path.join(repo, "padaccess"));
const bridge = require(path.join(repo, "bridge"));
const S = require(path.join(repo, "mainstage"));

const LOUNGE = "Lounge.Room", ALWAYS = "Always.Room", GARDEN = "Garden.Room";
const users = new Map(), U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u); return u;
}
let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "ps-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });
async function say(id, text) {
  const room = { id, name: id };
  await bridge.ingest({
    events: [ev(room, "message", { user: { id: "alicecf", login: "alicecf", display: "Alice" }, text })],
    rooms: [{ room, topic: "TOPIC " + id, count: 4,
              members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, { id: "alicecf", login: "alicecf", display: "Alice" },
                        { id: "membercf", login: "membercf", display: "Me" }],
              mic: [{ id: "alicecf", login: "alicecf", display: "Alice" }] }],
  });
}
let base, server;
async function get(url, u) {
  const r = await fetch(base + url, { headers: Object.assign({ "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}), redirect: "manual" });
  return { status: r.status, text: await r.text(), cc: r.headers.get("cache-control") };
}
const slugOf = async (id) => (await rooms.get(id)).slug;
const setLevel = async (id, lv) => PA.setLevel(U.owner, await rooms.get(id), lv);
function page(r) {
  const init = (/<script id="rmInit" type="application\/json">([\s\S]*?)<\/script>/.exec(r.text) || [])[1];
  let d = null; try { d = JSON.parse(init); } catch (e) { d = null; }
  const strip = /PATVCamStrip\.init\([\s\S]*?viewer: ([^ }]+) \}\)/.exec(r.text);
  return { main: (/<main class="([^"]*)"/.exec(r.text) || [])[1] || "", dockInit: /PATVPadDock\.init\(/.test(r.text),
           lines: d && Array.isArray(d.feed) ? d.feed.map((x) => x.text).filter(Boolean) : null, viewer: strip ? JSON.parse(strip[1]) : undefined };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.member = await mkUser("plainmember", { camfrog: "membercf" });
  U.unlinked = await mkUser("webonly");
  U.approved = await mkUser("invitee", { camfrog: "inviteecf" });
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('pepe-bot', 'pepe', 'Pepe', 'x', 'pepefrog')");
  await rooms.init();
  for (const [id, title] of [[LOUNGE, "Players Lounge"], [ALWAYS, "Always Public"], [GARDEN, "Secret Garden"]]) {
    await rooms.addRoom(id, title, "test");
    await rooms.setOwner(id, "padowner", "test");
  }
  await PA.init();
  await setLevel(ALWAYS, "public");
  await setLevel(GARDEN, "approved");
  await PA.request(U.approved, await rooms.get(GARDEN), "hi");
  await PA.decide(U.owner, await rooms.get(GARDEN), U.approved.userId, true);
  // the Room Dock for everyone (prod: paddock mode everyone since 20:17:58Z)
  await runQuery(`CREATE TABLE IF NOT EXISTS paddock_cfg (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER)`);
  await runQuery("INSERT INTO paddock_cfg (id, v, data, updated_at) VALUES (1, 1, ?, ?)", [JSON.stringify({ mode: "everyone", cfstickers: false, gifs: false }), Date.now()]);
  await require(path.join(repo, "paddock")).init();
  await say(LOUNGE, "LOUNGE-said-while-members");
  await say(ALWAYS, "ALWAYS-said-while-public");
  await say(GARDEN, "GARDEN-said-while-approved");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  S.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  require(path.join(repo, "paddock")).register(app, { addUser });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

/** the signed-in viewer's pad page: the Dock page, never kept, the strip's memory theirs */
async function dockPage(slug, u, tag) {
  const r = await get("/p/" + slug, u);
  assert.equal(r.status, 200, tag);
  const p = page(r);
  assert.match(p.main, /\brm-dock\b/, tag + ": the Room Dock page");
  assert.ok(p.dockInit, tag + ": the Dock starts");
  assert.equal(r.cc, "private, no-store", tag + ": the browser never keeps (or shows on Back) a pad page");
  assert.equal(p.viewer, u.username, tag + ": the cam strip remembers for this account");
  return p;
}
async function signedOut(slug, tag) {
  const r = await get("/p/" + slug, null);
  assert.equal(r.status, 200, tag);
  assert.equal(r.cc, "private, no-store", tag + ": signed out too (a signed-out copy is no one's to show after a sign-in)");
  const v = page(r).viewer;
  assert.ok(v === undefined || v === null, tag + ": no viewer, no strip memory (" + v + ")");
  return page(r);
}

test("Members -> Public -> Members: a signed-in viewer gets the Dock page every time, never kept by the browser; signed out follows the level", async () => {
  const slug = await slugOf(LOUNGE);
  for (const u of [U.member, U.unlinked, U.owner]) await dockPage(slug, u, "members, " + u.username);
  const out0 = await signedOut(slug, "members, signed out");
  assert.equal(out0.lines, null, "signed out at Members: no live room");
  await setLevel(LOUNGE, "public");
  await say(LOUNGE, "LOUNGE-said-while-public");
  for (const u of [U.member, U.unlinked, U.owner]) {
    const p = await dockPage(slug, u, "public, " + u.username);
    assert.ok(p.lines.includes("LOUNGE-said-while-members") && p.lines.includes("LOUNGE-said-while-public"), "a signed-in viewer saw Members lines before: " + JSON.stringify(p.lines));
  }
  const out1 = await signedOut(slug, "public, signed out");
  assert.match(out1.main, /\brm-dock\b/, "signed out at Public: the Dock page");
  assert.deepEqual(out1.lines.filter((x) => /^LOUNGE-/.test(x)), ["LOUNGE-said-while-public"], "CL3: a Members-era line stays members-only once it's Public");
  await setLevel(LOUNGE, "members");
  for (const u of [U.member, U.unlinked, U.owner]) await dockPage(slug, u, "back to members, " + u.username);
  assert.equal((await signedOut(slug, "back to members, signed out")).lines, null);
});

test("Approved -> Public: the Dock page for everyone signed in; CL3 - the Approved-era line never reaches a non-member", async () => {
  const slug = await slugOf(GARDEN);
  const inv = await dockPage(slug, U.approved, "approved, the approved member");
  assert.ok(inv.lines.includes("GARDEN-said-while-approved"));
  await setLevel(GARDEN, "public");
  await say(GARDEN, "GARDEN-said-while-public");
  for (const u of [U.member, U.unlinked]) {
    const p = await dockPage(slug, u, "opened up, " + u.username);
    assert.ok(!p.lines.includes("GARDEN-said-while-approved"), "CL3: no Approved-era line for a non-member: " + JSON.stringify(p.lines));
    assert.ok(p.lines.includes("GARDEN-said-while-public"));
  }
  assert.ok((await dockPage(slug, U.approved, "opened up, the approved member")).lines.includes("GARDEN-said-while-approved"), "its members still see it");
  const out = await signedOut(slug, "opened up, signed out");
  assert.ok(!out.lines.includes("GARDEN-said-while-approved"));
});

test("guard: a pad Public from the start (Pepe's Pad) - the same Dock page, the same headers", async () => {
  const slug = await slugOf(ALWAYS);
  for (const u of [U.member, U.unlinked, U.owner]) await dockPage(slug, u, "always public, " + u.username);
  assert.match((await signedOut(slug, "always public, signed out")).main, /\brm-dock\b/);
});

// ───────────────────────── B. the cam strip (pad-camstrip.js, the page's own JS in a sandbox) ─────────────────────────
function sandbox({ store = {}, readyState, live = "never" } = {}) {
  const posts = [], winL = {}, docL = {}, timers = [];
  const mk = (tag) => ({
    tag, children: [], attrs: {}, listeners: {}, style: {}, textContent: "", hidden: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); return this._s.has(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return null; }, addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
    scrollIntoView() { scrolls.push(tag); }, play() { return Promise.resolve(); } });
  const scrolls = [];
  const document = { createElement: mk, addEventListener(k, fn) { (docL[k] = docL[k] || []).push(fn); } };
  if (readyState) document.readyState = readyState;
  const ctx = { document, console, setInterval: () => 0, clearInterval() {}, clearTimeout() {},
                // (timers run only when the test says so - the page's own clock)
                setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
                localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
                fetch: (u, o) => {
                  posts.push([u, o && o.body != null ? JSON.parse(o.body) : null]);
                  // a ticket, then Pepe never gets the cam up (prod 22:40Z: [livecam] end ... why=start_timeout): the beat says ended
                  const d = /\/livecam$/.test(u) ? (live === "refused" ? { ok: false, code: "start_timeout" } : /^code:/.test(live) ? { ok: false, code: live.slice(5) } : { ok: true, whep: "/whep/x" })
                          : /\/beat$/.test(u) ? { ok: true, state: "ended", why: "start_timeout" } : { ok: true };
                  return Promise.resolve({ json: () => Promise.resolve(d) });
                },
                RTCPeerConnection: function () {},
                PATVRtc: { watch: () => (live === "fails" ? Promise.reject(new Error("Live cam timed out")) : new Promise(() => {})) } };
  ctx.window = ctx; ctx.addEventListener = (k, fn) => { (winL[k] = winL[k] || []).push(fn); };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-camstrip.js"), "utf8"), ctx);
  const runTimers = () => { const t = timers.splice(0); t.forEach((x) => x.fn()); return t.length; };
  const fire = (L, k) => (L[k] || []).forEach((fn) => fn({}));
  return { ctx, posts, mk, store, scrolls, runTimers, timers, load: () => { document.readyState = "complete"; fire(winL, "load"); },
           dcl: () => { document.readyState = "interactive"; fire(docL, "DOMContentLoaded"); } };
}
const INFO = { on: true, slots: { used: 0, max: 4 }, watching: [] };
const flush = () => new Promise((r) => setImmediate(r));
const asks = (posts) => posts.filter((p) => /\/livecam$/.test(p[0])).map((p) => p[1]);
const PIN = (who) => JSON.stringify([{ login: who, display: who }]);

test("strip: a remembered cam is asked for only after the page has loaded - never while the page is read (the Dock's start comes first)", async () => {
  // the last visit: the viewer pinned a cam (a loaded page)
  const W = sandbox();
  const ws = W.ctx.PATVCamStrip.init(W.mk("section"), "pad", { viewer: "pb" });
  ws.update(INFO);
  assert.equal(ws.add({ login: "superman1976", display: "Superman" }), true);
  const pbKey = Object.keys(W.store).find((k) => k.startsWith("patv.camstrip.pad"));
  assert.ok(pbKey, "remembered under the account's key: " + JSON.stringify(Object.keys(W.store)));
  assert.equal(W.scrolls.length, 1, "a pin the viewer just made scrolls the strip into view");
  // this visit: the page is still being read when room.ejs hands the strip its first live view
  const S1 = sandbox({ readyState: "loading", store: { [pbKey]: W.store[pbKey] } });
  const strip1 = S1.ctx.PATVCamStrip.init(S1.mk("section"), "pad", { viewer: "pb" });
  strip1.update(INFO);                                     // room.ejs's first apply(data, true) - inline, while the page loads
  await flush();
  assert.deepEqual(asks(S1.posts), [], "nothing asked while the page is still being read (prod: the page's start-up waited behind it)");
  assert.equal(strip1.count(), 0);
  strip1.update(INFO);                                     // a poll before the load: still nothing
  S1.dcl(); await flush();
  assert.deepEqual(asks(S1.posts), [], "DOMContentLoaded (the Dock's start) runs first");
  S1.load(); S1.runTimers(); await flush();
  assert.deepEqual(asks(S1.posts), [{ login: "superman1976" }], "after the load: the remembered cam comes back");
  assert.equal(strip1.count(), 1);
  assert.equal(S1.scrolls.length, 0, "a strip coming back never scrolls the page");
  // a load event that never comes (a slow picture, the stage's stream): DOMContentLoaded + a few seconds do
  const S3 = sandbox({ readyState: "loading", store: { [pbKey]: W.store[pbKey] } });
  const strip3 = S3.ctx.PATVCamStrip.init(S3.mk("section"), "pad", { viewer: "pb" });
  strip3.update(INFO);
  S3.dcl(); await flush();
  assert.deepEqual(asks(S3.posts), []);
  S3.runTimers(); S3.runTimers(); await flush();
  assert.deepEqual(asks(S3.posts), [{ login: "superman1976" }], "after DOMContentLoaded + the settle time");
  // a page that has loaded already (a pin restored on a later live view) - at once
  const S4 = sandbox({ readyState: "complete", store: { [pbKey]: W.store[pbKey] } });
  S4.ctx.PATVCamStrip.init(S4.mk("section"), "pad", { viewer: "pb" }).update(INFO);
  await flush();
  assert.deepEqual(asks(S4.posts), [{ login: "superman1976" }]);
});

test("strip: a remembered cam that ends is forgotten - the next load doesn't start it again; ↻ Retry remembers it; a full strip keeps it", async () => {
  for (const live of ["fails", "refused"]) {
    const A = sandbox();
    const a = A.ctx.PATVCamStrip.init(A.mk("section"), "pad", { viewer: "pb" });
    a.update(INFO);
    a.add({ login: "superman1976", display: "Superman" });
    const key = Object.keys(A.store).find((k) => k.startsWith("patv.camstrip.pad"));
    // the next load: the cam can't start
    const B = sandbox({ live, store: { [key]: A.store[key] } });
    const b = B.ctx.PATVCamStrip.init(B.mk("section"), "pad", { viewer: "pb" });
    b.update(INFO);
    for (let i = 0; i < 5; i++) await flush();
    assert.deepEqual(asks(B.posts), [{ login: "superman1976" }], live + ": restored once");
    assert.equal(b.count(), 1, live + ": the tile stays here (off, ↻ Retry)");
    assert.deepEqual(JSON.parse(B.store[key]), [], live + ": but it is no longer remembered");
    // the load after that: nothing to restore, nothing asked
    const C = sandbox({ live, store: { [key]: B.store[key] } });
    C.ctx.PATVCamStrip.init(C.mk("section"), "pad", { viewer: "pb" }).update(INFO);
    await flush();
    assert.deepEqual(asks(C.posts), [], live + ": a cam that ended never follows the viewer from load to load");
  }
  // ↻ Retry: remembered again
  const R = sandbox({ live: "refused" });
  const r = R.ctx.PATVCamStrip.init(R.mk("section"), "pad", { viewer: "pb" });
  r.update(INFO);
  r.add({ login: "superman1976", display: "Superman" });
  for (let i = 0; i < 5; i++) await flush();
  const key = Object.keys(R.store).find((k) => k.startsWith("patv.camstrip.pad"));
  assert.deepEqual(JSON.parse(R.store[key]), [], "refused: forgotten");
  r.add({ login: "superman1976" });                         // the popover's pin of an ended tile = its Retry
  assert.deepEqual(JSON.parse(R.store[key]).map((x) => x.login), ["superman1976"], "asked again: remembered again");
  // more remembered cams than slots: the rest wait as "off" tiles (no slot - not a failure) and stay remembered
  const F = sandbox({ store: { [key]: JSON.stringify([{ login: "alice", display: "Alice" }, { login: "bob", display: "Bob" }]) } });
  const f = F.ctx.PATVCamStrip.init(F.mk("section"), "pad", { viewer: "pb" });
  f.update({ on: true, slots: { used: 0, max: 1 } });
  await flush();
  assert.deepEqual(asks(F.posts), [{ login: "alice" }]);
  assert.equal(f.count(), 2);
  assert.deepEqual(JSON.parse(F.store[key]).map((x) => x.login), ["alice", "bob"], "a full strip keeps its remembered cams");
  // refused at once for a reason that isn't the cam (capacity for a moment, Pepe away, signed out): nothing connected - kept
  for (const code of ["slots_busy", "budget", "nopepe", "signin", "room_off"]) {
    const T = sandbox({ live: "code:" + code, store: { [key]: PIN("alice") } });
    T.ctx.PATVCamStrip.init(T.mk("section"), "pad", { viewer: "pb" }).update(INFO);
    for (let i = 0; i < 3; i++) await flush();
    assert.deepEqual(asks(T.posts), [{ login: "alice" }], code);
    assert.deepEqual(JSON.parse(T.store[key]).map((x) => x.login), ["alice"], code + ": still remembered");
  }
  // the cam itself can't be watched: forgotten
  for (const code of ["not_on_cam", "opted_out", "unavailable", "ended_by", "relay_lost", "pad_access"]) {
    const T = sandbox({ live: "code:" + code, store: { [key]: PIN("alice") } });
    T.ctx.PATVCamStrip.init(T.mk("section"), "pad", { viewer: "pb" }).update(INFO);
    for (let i = 0; i < 3; i++) await flush();
    assert.deepEqual(JSON.parse(T.store[key]), [], code + ": forgotten");
  }
});

test("strip: the memory is per account - another account on this browser gets nothing; the old per-browser key is dropped", async () => {
  const store = { "patv.camstrip.pad": PIN("superman1976") };      // what 1.99ala wrote (anyone's who used this browser)
  const A = sandbox({ store });
  const a = A.ctx.PATVCamStrip.init(A.mk("section"), "pad", { viewer: "pb" });
  a.update(INFO);
  await flush();
  assert.deepEqual(asks(A.posts), [], "the old per-browser memory isn't restored for whoever signs in");
  assert.equal("patv.camstrip.pad" in store, false, "and it is gone");
  a.add({ login: "alice", display: "Alice" });
  const keys = Object.keys(store).filter((k) => k.startsWith("patv.camstrip.pad."));
  assert.equal(keys.length, 1);
  assert.doesNotMatch(keys[0], /pb/, "no name in the key");
  const B = sandbox({ store });
  B.ctx.PATVCamStrip.init(B.mk("section"), "pad", { viewer: "someoneelse" }).update(INFO);
  await flush();
  assert.deepEqual(asks(B.posts), [], "another account signed in on this browser: no cams of the first one");
  const A2 = sandbox({ store });
  A2.ctx.PATVCamStrip.init(A2.mk("section"), "pad", { viewer: "PB" }).update(INFO);
  await flush();
  assert.deepEqual(asks(A2.posts), [{ login: "alice" }], "the same account (any case) gets its own back");
  const part = fs.readFileSync(path.join(repo, "views", "partials", "cam-strip.ejs"), "utf8");
  assert.match(part, /pad-camstrip\.js\?v=5/, "the new script's version");
  assert.match(part, /viewer: <%- JSON\.stringify\(locals\.user \? String\(locals\.user\) : null\)\.replace\(\/<\/g, '\\\\u003c'\) %>/);
});
