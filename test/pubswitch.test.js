// pubswitch (owner 2026-11-05 ~22:45Z): Players Lounge switched Members -> Public and the owner's signed-in Chrome showed the old
// layout (no Room Dock) on every load - through reloads, a sign-out / sign-in and the switch back - while signed out was fine, Pepe's
// Pad (Public from the start) was fine, and clearing the site's data fixed it. The server's answer was the same Dock page every time;
// what the clear removed was the browser's remembered cam strip (patv.camstrip.<slug>): every broken load restored a pinned cam while
// the page was still being read, and the page's own start-up (deferred scripts, the Dock's DOMContentLoaded start) came 16-61 s late
// or never - even on a load whose restore was refused at once (22:41:58Z: 400 not_on_cam, nothing connected), so the trigger was a
// tile made while the page was read, not the cam's connect. HOW that held the page up is not reproduced (the kit's WebRTC, a WHEP that
// never finds the cam, a cam without frames, a dead TURN: no stall) - no failing test for the stall itself; the restore now waits until
// after DOMContentLoaded, and a page with remembered cams reports its start-up once (/livecam/boot) so a recurrence can be proven.
// This file:
//   A. the real pad route + room.ejs through Members -> Public -> Members, Approved -> Public and a pad Public from the start: the
//      signed-in Dock page every time, the page never kept by the browser (private, no-store - Back from Settings came out of the
//      bfcache with the pre-switch page), the strip told whose memory it is; CL3 still holds (an Approved pad opening up never shows
//      its Approved-era lines to non-members);
//   B. pad-camstrip.js in a sandbox: remembered cams come back only after the page loaded (never while it is read), a cam that ended
//      is forgotten (no restore on the next load; ↻ Retry remembers it again), the memory is per account (the old per-browser key goes).
//   C. the reviews: a pin is forgotten only when its end is about the cam (never a site restart's unwatched, a deploy's 502, lapsed
//      beats, Pepe offline, an unknown code); the restore waits for DOMContentLoaded itself; the start-up report (client + route); every
//      pad page and the homepage reload when shown from the back/forward cache, the homepage private, no-store; a pin made while the
//      page loads keeps the cams not brought back yet; the restore re-reads the memory; the popover's hand-over re-remembers a forgotten
//      tile; the first page after a sign-out drops every remembered strip of the browser.
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

const LOUNGE = "Lounge.Room", ALWAYS = "Always.Room", GARDEN = "Garden.Room", VAULT = "Vault.Room";
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
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.member = await mkUser("plainmember", { camfrog: "membercf" });
  U.unlinked = await mkUser("webonly");
  U.approved = await mkUser("invitee", { camfrog: "inviteecf" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('pepe-bot', 'pepe', 'Pepe', 'x', 'pepefrog')");
  await rooms.init();
  for (const [id, title] of [[LOUNGE, "Players Lounge"], [ALWAYS, "Always Public"], [GARDEN, "Secret Garden"], [VAULT, "The Vault"]]) {
    await rooms.addRoom(id, title, "test");
    await rooms.setOwner(id, "padowner", "test");
  }
  await PA.init();
  await setLevel(ALWAYS, "public");
  await setLevel(GARDEN, "approved");
  await setLevel(VAULT, "approved");
  await PA.request(U.approved, await rooms.get(GARDEN), "hi");
  await PA.decide(U.owner, await rooms.get(GARDEN), U.approved.userId, true);
  // the Room Dock for everyone (prod: paddock mode everyone since 20:17:58Z)
  await runQuery(`CREATE TABLE IF NOT EXISTS paddock_cfg (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER)`);
  await runQuery("INSERT INTO paddock_cfg (id, v, data, updated_at) VALUES (1, 1, ?, ?)", [JSON.stringify({ mode: "everyone", cfstickers: false, gifs: false }), Date.now()]);
  await require(path.join(repo, "paddock")).init();
  await say(LOUNGE, "LOUNGE-said-while-members");
  await say(ALWAYS, "ALWAYS-said-while-public");
  await say(GARDEN, "GARDEN-said-while-approved");
  await say(VAULT, "VAULT-said-while-approved");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; req.flash = () => []; next(); });
  require(path.join(repo, "cosmetics")).locals(app);
  require(path.join(repo, "userlinks")).install(app);
  require(path.join(repo, "boostmark")).install(app);
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  S.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  require(path.join(repo, "paddock")).register(app, { addUser });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "home")).register(app, { addUser, xpForNextLevel: () => 100 });   // (review C4: the homepage's headers)
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
// live: "never" (the watch never settles) | "fails" | "plays" | "refused" | "code:<x>";  beat: the beat's answer (an object), "html" (a
// 502 page: no JSON) or "reject" (the site unreachable);  perf: { nav, now } - the page's navigation timing
function sandbox({ store = {}, readyState, live = "never", beat, perf } = {}) {
  const posts = [], winL = {}, docL = {}, timers = [], intervals = [];
  const mk = (tag) => ({
    tag, children: [], attrs: {}, listeners: {}, style: {}, textContent: "", hidden: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); return this._s.has(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return null; }, addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
    scrollIntoView() { scrolls.push(tag); }, play() { return Promise.resolve(); } });
  const scrolls = [];
  const document = { createElement: mk, addEventListener(k, fn) { (docL[k] = docL[k] || []).push(fn); } };
  if (readyState) document.readyState = readyState;
  const ctx = { document, console,
                // (beats run only when the test says so: beatNow)
                setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: (id) => { if (id) intervals[id - 1] = null; }, clearTimeout() {},
                // (timers run only when the test says so - the page's own clock)
                setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
                localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
                fetch: (u, o) => {
                  posts.push([u, o && o.body != null ? JSON.parse(o.body) : null, !!(o && o.keepalive)]);
                  if (/\/beat$/.test(u) && beat === "reject") return Promise.reject(new TypeError("Failed to fetch"));
                  if (/\/beat$/.test(u) && beat === "html") return Promise.resolve({ json: () => Promise.reject(new SyntaxError("Unexpected token '<'")) });
                  // a ticket, then Pepe never gets the cam up (prod 22:40Z: [livecam] end ... why=start_timeout): the beat says ended
                  const d = /\/livecam$/.test(u) ? (live === "refused" ? { ok: false, code: "start_timeout" } : /^code:/.test(live) ? { ok: false, code: live.slice(5) } : { ok: true, whep: "/whep/x" })
                          : /\/beat$/.test(u) ? (beat || { ok: true, state: "ended", why: "start_timeout" }) : { ok: true };
                  return Promise.resolve({ json: () => Promise.resolve(d) });
                },
                RTCPeerConnection: function () {},
                PATVRtc: { watch: () => (live === "fails" ? Promise.reject(new Error("Live cam timed out")) : live === "plays" ? Promise.resolve({ close() {}, blocked: false }) : new Promise(() => {})) } };
  if (perf) ctx.performance = { getEntriesByType: (t) => (t === "navigation" ? [Object.assign({ domContentLoadedEventStart: 0, domContentLoadedEventEnd: 0, loadEventStart: 0 }, perf.nav || {})] : []), now: () => perf.now || 0 };
  ctx.window = ctx; ctx.addEventListener = (k, fn) => { (winL[k] = winL[k] || []).push(fn); };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-camstrip.js"), "utf8"), ctx);
  const runTimers = () => { const t = timers.splice(0); t.forEach((x) => x.fn()); return t.length; };
  const fire = (L, k) => (L[k] || []).forEach((fn) => fn({}));
  return { ctx, posts, mk, store, scrolls, runTimers, timers, load: () => { document.readyState = "complete"; fire(winL, "load"); },
           dcl: () => { document.readyState = "interactive"; fire(docL, "DOMContentLoaded"); },
           beatNow: () => intervals.forEach((fn) => fn && fn()), hide: () => fire(winL, "pagehide") };
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
  for (const code of ["slots_busy", "budget", "nopepe", "signin", "room_off", "offline", "rate"]) {
    const T = sandbox({ live: "code:" + code, store: { [key]: PIN("alice") } });
    T.ctx.PATVCamStrip.init(T.mk("section"), "pad", { viewer: "pb" }).update(INFO);
    for (let i = 0; i < 3; i++) await flush();
    assert.deepEqual(asks(T.posts), [{ login: "alice" }], code);
    assert.deepEqual(JSON.parse(T.store[key]).map((x) => x.login), ["alice"], code + ": still remembered");
  }
  // the cam itself can't be watched: forgotten (review C1: relay_lost is no longer one - a relay restart isn't the cam; the next load's
  // one ask finds out)
  for (const code of ["not_on_cam", "opted_out", "unavailable", "ended_by", "pad_access", "blocked"]) {
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
  assert.match(part, /pad-camstrip\.js\?v=7/, "the new script's version (v6: the review fixes; v7: camstutter's fast_end)");
  assert.match(part, /viewer: <%- JSON\.stringify\(locals\.user \? String\(locals\.user\) : null\)\.replace\(\/<\/g, '\\\\u003c'\) %>/);
});

// ───────────────────────── C. the reviews ─────────────────────────
/** the storage key the strip uses for `viewer` on pad "pad" (found by pinning once, as the page does) */
function keyFor(viewer) {
  const W = sandbox();
  const s = W.ctx.PATVCamStrip.init(W.mk("section"), "pad", { viewer });
  s.update(INFO); s.add({ login: "probe" });
  return Object.keys(W.store).find((k) => k.startsWith("patv.camstrip.pad."));
}
const flushN = async (n = 5) => { for (let i = 0; i < n; i++) await flush(); };
const logins = (store, k) => JSON.parse(store[k]).map((x) => x.login);
const boots = (posts) => posts.filter((p) => /\/livecam\/boot$/.test(p[0]));

test("review C1: a cam that PLAYED stays remembered when it ends for a reason that isn't the cam; the cam's own end forgets it", async () => {
  const K = keyFor("pb");
  const run = async (beat, live = "plays") => {
    const T = sandbox({ live, beat, store: { [K]: PIN("alice") } });
    const s = T.ctx.PATVCamStrip.init(T.mk("section"), "pad", { viewer: "pb" });
    s.update(INFO);
    await flushN();
    assert.deepEqual(asks(T.posts), [{ login: "alice" }]);
    if (live === "plays") { T.beatNow(); await flushN(); }
    return logins(T.store, K);
  };
  for (const [what, beat] of [["unwatched (a site restart: live-cam sessions are in memory)", { ok: true, state: "ended", why: "unwatched" }],
                              ["a 502 page (the deploy's restart)", "html"], ["no answer at all (a network blip)", "reject"],
                              ["gone (beats lapsed: an iPhone in the background)", { ok: true, state: "ended", why: "gone" }],
                              ["offline (Pepe's bridge)", { ok: true, state: "ended", why: "offline" }],
                              ["relay_lost (a relay restart)", { ok: true, state: "ended", why: "relay_lost" }],
                              ["no code", { ok: false }], ["a code this page doesn't know", { ok: true, state: "ended", why: "something_new" }]]) {
    assert.deepEqual(await run(beat), ["alice"], what + ": still remembered");
  }
  // the watch timed out and the site couldn't be reached either: a network blip, not the cam
  assert.deepEqual(await run("reject", "fails"), ["alice"], "watch failed + the site unreachable: kept");
  for (const why of ["not_on_cam", "cam_closed", "opted_out", "ended_by", "ended_by_admin", "start_timeout", "unavailable", "veil_changed", "no_video", "failed"]) {
    assert.deepEqual(await run({ ok: true, state: "ended", why }), [], why + ": forgotten");
  }
  assert.deepEqual(await run({ ok: false, code: "blocked", state: "ended" }), [], "blocked: forgotten");
  assert.deepEqual(await run({ ok: false, code: "pad_access" }), [], "no access: forgotten");
});

test("review C2: the restore waits for DOMContentLoaded itself - a page still 'interactive' (deferred scripts running) arms no timer before it", async () => {
  const K = keyFor("pb");
  const S = sandbox({ readyState: "interactive", store: { [K]: PIN("alice") } });
  S.ctx.PATVCamStrip.init(S.mk("section"), "pad", { viewer: "pb" }).update(INFO);
  for (let i = 0; i < 4; i++) S.runTimers();
  await flush();
  assert.deepEqual(asks(S.posts), [], "deferred scripts still running (a slow video.min.js): nothing asked, however long");
  S.dcl(); S.runTimers(); S.runTimers(); await flush();
  assert.deepEqual(asks(S.posts), [{ login: "alice" }], "DOMContentLoaded + the settle time");
  // a page whose DOMContentLoaded is already over (navigation timing says so): the settle time only
  const S2 = sandbox({ readyState: "interactive", perf: { nav: { domContentLoadedEventStart: 700, domContentLoadedEventEnd: 720 } }, store: { [K]: PIN("alice") } });
  S2.ctx.PATVCamStrip.init(S2.mk("section"), "pad", { viewer: "pb" }).update(INFO);
  S2.runTimers(); S2.runTimers(); await flush();
  assert.deepEqual(asks(S2.posts), [{ login: "alice" }]);
});

test("review C2: a page with remembered cams reports its start-up once (/livecam/boot) - at the restore, or at pagehide when it never ran; never without", async () => {
  const K = keyFor("pb");
  const nav = { domContentLoadedEventStart: 812.4, domContentLoadedEventEnd: 830, loadEventStart: 2400.2 };
  const S = sandbox({ readyState: "loading", perf: { nav, now: 2410.7 }, store: { [K]: PIN("alice") } });
  const s = S.ctx.PATVCamStrip.init(S.mk("section"), "pad", { viewer: "pb" });
  s.update(INFO);
  S.dcl(); S.load(); S.runTimers(); await flush();
  assert.deepEqual(boots(S.posts).map((p) => p[1]), [{ ran: 1, via: "load", n: 1, dcl: 812, load: 2400, at: 2411 }]);
  assert.equal(boots(S.posts)[0][0], "/api/rooms/pad/livecam/boot");
  S.hide(); s.update(INFO); await flush();
  assert.equal(boots(S.posts).length, 1, "once per page");
  // left before the restore ran (what prod's stalled loads did: reloaded 16-61 s in) - said at pagehide, keepalive
  const H = sandbox({ readyState: "loading", perf: { nav: {}, now: 29000 }, store: { [K]: PIN("alice") } });
  H.ctx.PATVCamStrip.init(H.mk("section"), "pad", { viewer: "pb" }).update(INFO);
  H.hide(); await flush();
  assert.deepEqual(boots(H.posts).map((p) => [p[1], p[2]]), [[{ ran: 0, via: "hide", n: 1, dcl: -1, load: -1, at: 29000 }, true]]);
  assert.deepEqual(asks(H.posts), []);
  // no remembered cams: never
  const N = sandbox({ readyState: "loading", perf: { nav, now: 1 } });
  N.ctx.PATVCamStrip.init(N.mk("section"), "pad", { viewer: "pb" }).update(INFO);
  N.dcl(); N.load(); N.runTimers(); N.hide(); await flush();
  assert.deepEqual(boots(N.posts), []);
  // signed out (an old per-browser key on the page): never
  const O = sandbox({ readyState: "loading", perf: { nav, now: 1 }, store: { "patv.camstrip.pad": PIN("alice") } });
  O.ctx.PATVCamStrip.init(O.mk("section"), "pad", { viewer: null }).update({ on: true, signin: true });
  O.hide(); await flush();
  assert.deepEqual(O.posts, []);
});

test("review C2: POST /api/rooms/<slug>/livecam/boot - signed in, a same-site fetch only; one log line of numbers (no login, no cam)", async () => {
  const slug = await slugOf(ALWAYS);
  const send = async (u, body, h = {}) => {
    const r = await fetch(base + "/api/rooms/" + slug + "/livecam/boot", { method: "POST", body: JSON.stringify(body),
      headers: Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, h) });
    return { status: r.status, d: await r.json().catch(() => null), cc: r.headers.get("cache-control") };
  };
  const logs = [], ol = console.log;
  console.log = (...a) => { const l = a.map(String).join(" "); if (l.startsWith("[livecam] boot")) logs.push(l); else ol(...a); };
  try {
    let r = await send(U.member, { ran: 1, via: "load", n: 1, dcl: 812, load: 2400, at: 2411, login: "alicecf" });
    assert.equal(r.status, 200); assert.deepEqual(r.d, { ok: true }); assert.equal(r.cc, "no-store");
    r = await send(U.member, { ran: "yes", via: "<b>x</b>", n: 99, dcl: -5, load: 1e12, at: "abc" });
    assert.equal(r.status, 200);
    assert.deepEqual(logs, [`[livecam] boot pad=${slug} ran=1 via=load n=1 dcl=812 load=2400 at=2411`,
                            `[livecam] boot pad=${slug} ran=0 via=? n=8 dcl=-1 load=-1 at=-1`], "numbers only - the login sent along is never logged");
    assert.equal((await send(null, { ran: 1 })).status, 401, "signed out");
    assert.equal((await send(U.member, { ran: 1 }, { "x-requested-with": "" })).status, 403, "not the page's fetch");
    assert.equal((await send(U.member, { ran: 1 }, { origin: "https://evil.example" })).status, 403, "another site");
    assert.equal(logs.length, 2);
  } finally { console.log = ol; }
});

test("review C3/C4: every pad page and the homepage reload when shown from the back/forward cache; the homepage is private, no-store", async () => {
  const RE = /<script>window\.addEventListener\('pageshow', function \(e\) \{ if \(e && e\.persisted\) location\.reload\(\); \}\);<\/script>/;
  const once = (r, what) => { assert.match(r.text, RE, what + ": reloads when restored"); assert.equal(r.text.split("e.persisted) location.reload()").length, 2, what + ": once"); };
  const lounge = await slugOf(LOUNGE), always = await slugOf(ALWAYS), vault = await slugOf(VAULT);
  once(await get("/p/" + lounge, U.member), "the Dock page");
  once(await get("/p/" + lounge, null), "Members, signed out");
  once(await get("/p/" + always, null), "Public, signed out");
  const cw = await get("/p/" + always + "/chat", U.member);
  assert.equal(cw.status, 200); once(cw, "the chat window");
  const locked = await get("/p/" + vault, U.unlinked);
  assert.equal(locked.status, 403); assert.equal(locked.cc, "private, no-store"); once(locked, "an Approved pad's outsider");
  const PD = require(path.join(repo, "paddock"));
  try {
    await PD.save(U.admin, { cfg: { mode: "off" } });
    const classic = await get("/p/" + lounge, U.member);
    assert.doesNotMatch(classic.text, /<main class="[^"]*\brm-dock\b/);
    once(classic, "the classic page (Dock off)");
    assert.equal(classic.cc, "private, no-store");
    for (const u of [null, U.member]) {
      const h = await get("/", u);
      assert.equal(h.status, 200, h.text.slice(0, 200));
      assert.equal(h.cc, "private, no-store", "the homepage (Dock off), " + (u ? "signed in" : "signed out"));
      once(h, "the homepage (Dock off)");
    }
  } finally { await PD.save(U.admin, { cfg: { mode: "everyone" } }); }
  for (const u of [null, U.member]) {
    const h = await get("/", u);
    assert.equal(h.status, 200);
    assert.equal(h.cc, "private, no-store", "the homepage (Dock), " + (u ? "signed in" : "signed out") + ": its live chat follows the front pad's level and the viewer");
    once(h, "the homepage (Dock)");
  }
});

test("review P2: a pin made while the page loads keeps the remembered cams not brought back yet (a page left before the load loses nothing)", async () => {
  const K = keyFor("pb");
  const S = sandbox({ readyState: "loading", store: { [K]: PIN("alice") } });
  const s = S.ctx.PATVCamStrip.init(S.mk("section"), "pad", { viewer: "pb" });
  s.update(INFO);
  assert.equal(s.add({ login: "bob", display: "Bob" }), true);
  assert.deepEqual(logins(S.store, K).sort(), ["alice", "bob"], "left now: both remembered");
  S.dcl(); S.load(); S.runTimers(); await flush();
  assert.deepEqual(asks(S.posts), [{ login: "bob" }, { login: "alice" }], "the load brings alice back beside bob, once");
  assert.equal(s.count(), 2);
  // a remembered cam the viewer pinned again while loading, which then ended for the cam: never written back from the memory
  const F = sandbox({ readyState: "loading", live: "code:not_on_cam", store: { [K]: PIN("alice") } });
  const f = F.ctx.PATVCamStrip.init(F.mk("section"), "pad", { viewer: "pb" });
  f.update(INFO);
  f.add({ login: "alice", display: "Alice" });
  await flushN();
  assert.deepEqual(JSON.parse(F.store[K]), [], "forgotten, not re-added from the memory");
  F.dcl(); F.load(); F.runTimers(); await flush();
  assert.deepEqual(asks(F.posts), [{ login: "alice" }], "and not asked for twice");
});

test("review C6: the restore reads the memory when it runs - another tab of this pad and account closed a cam meanwhile", async () => {
  const K = keyFor("pb");
  const S = sandbox({ readyState: "loading", store: { [K]: JSON.stringify([{ login: "alice", display: "Alice" }, { login: "bob", display: "Bob" }]) } });
  S.ctx.PATVCamStrip.init(S.mk("section"), "pad", { viewer: "pb" }).update(INFO);
  S.store[K] = PIN("alice");                                // the other tab's ✕ on bob
  S.dcl(); S.load(); S.runTimers(); await flush();
  assert.deepEqual(asks(S.posts), [{ login: "alice" }]);
  assert.deepEqual(logins(S.store, K), ["alice"]);
});

test("review C5: the popover handing a playing cam to a forgotten tile remembers it again", async () => {
  const K = keyFor("pb");
  const A = sandbox({ live: "refused", store: { [K]: PIN("alice") } });
  const a = A.ctx.PATVCamStrip.init(A.mk("section"), "pad", { viewer: "pb" });
  a.update(INFO);
  await flushN();
  assert.deepEqual(JSON.parse(A.store[K]), [], "the restore failed: forgotten (an off tile)");
  assert.equal(a.adopt({ login: "alice", display: "Alice" }, { sess: { close() {} }, stream: {} }), true);
  assert.deepEqual(logins(A.store, K), ["alice"], "playing again on that tile: remembered");
});

test("review P1: the first page after a sign-out drops every remembered cam strip of this browser (patv.camstrip.*) - only with the sign-out marker", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(repo, "views", "partials", "chat-sweep.ejs"), "utf8"))[1];
  const lsOf = (o) => ({ get length() { return Object.keys(o).length; }, key: (i) => Object.keys(o)[i] ?? null, getItem: (k) => (k in o ? o[k] : null),
                         setItem: (k, v) => { o[k] = String(v); }, removeItem: (k) => { delete o[k]; } });
  const mkStore = () => ({ "patv.camstrip.pad.4f4e56f7": PIN("alice"), "patv.camstrip.lounge-room": PIN("bob"), "patv.camstrip.other.0badc0de": PIN("cat"),
                           "patv.dock.pins": "[1]", "patv.camstripx": "keep", "draft": "x" });
  const st = mkStore();
  const doc = { cookie: "a=b; patv_chat_sweep=1" };
  vm.runInNewContext(script, { window: { localStorage: lsOf(st) }, document: doc, JSON });
  assert.deepEqual(Object.keys(st).sort(), ["draft", "patv.camstripx", "patv.dock.pins"], "every account's strip memory goes - nothing else");
  assert.match(doc.cookie, /^patv_chat_sweep=; Max-Age=0/, "the sweep still finishes (no IndexedDB here: the marker goes)");
  const kept = mkStore();
  vm.runInNewContext(script, { window: { localStorage: lsOf(kept) }, document: { cookie: "a=b" }, JSON });
  assert.equal(Object.keys(kept).length, 6, "no marker: nothing touched");
  const blocked = { cookie: "patv_chat_sweep=1" }, win = {};
  Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError"); } });
  vm.runInNewContext(script, { window: win, document: blocked, JSON });
  assert.match(blocked.cookie, /Max-Age=0/, "blocked storage: the rest of the sweep runs");
});
