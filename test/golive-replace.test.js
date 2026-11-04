// Offline tests for 1.99?? golive - "Go live" with a second video replaced the first one (owner 2026-11-04: "I played a youtube
// video through 'Go Live' on its own stage. When I tried to play a different video, it just replayed the last video").
// The cause (prod logs): every later booking was refused 409 "You already have a stage slot" (a small line on /stage), the old
// slot kept the stage, and the viewer's YouTube iframe restarted it from 0 each time the player was rebuilt (the 🎙 mic stage
// came and went, a reload).
//   1. book(): the refusal names the slot in the way (have_slot + `have`, replaceable only for a video link playing now on the
//      same pad and a video booking for now); `replace` ends it ("replaced") and books the new video in ONE transaction - the
//      holder, the pad's owner, staff; strangers / other pads / streams / later bookings refused, nothing changed; a new video
//      that can't be booked leaves the old one playing; a feature moves to the new video, an auto-feature is re-made; the
//      queue's refusal names the slot too; the house pad (Pepe's) and another pad; the HTTP answer carries `have`
//   2. a replaced slot that is Pepe's on-air pick comes off air (onair check)
//   3. stage-room.js: a video slot's player starts where the broadcast is (YouTube start= / Twitch VOD time=, from the slot's
//      since + the server's clock), a poll never rebuilds it, a rebuild after the mic stage resumes (never from 0)
//   4. stage-book.js: on have_slot the page offers to replace (confirm) and books again with `replace`; a slot it can't replace
//      says where it is; /api/stage answers the server clock
//   node --test test/golive-replace.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golive-replace-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));

let T = Date.UTC(2026, 10, 4, 20, 0, 0);
S._setClock(() => T);
rooms.notify = async () => true;
const HOUSE = rooms.HOUSE_ROOM, PLANT = "plant_based_chatting";
const A = "https://www.youtube.com/watch?v=AAAAAAAAAAA", B = "https://youtu.be/BBBBBBBBBBB", C = "https://www.twitch.tv/videos/123456789";
let n = 0;
async function mkUser(extra = {}) {
  const id = "g" + (++n);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, class) VALUES (?, ?, ?, 'x', 100000, ?)`,
                 [id, extra.username || "member" + n, extra.display || "Member " + n, extra.class || "pleb"]);
  return { userId: id, username: extra.username || "member" + n, class: extra.class || "pleb" };
}
const video = (u, room, url, extra = {}) => S.book(u, { room, minutes: 30, mode: "embed", embed: url, ...extra });
const refused = (status, code) => (e) => { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code, e.message); return true; };
async function clear() {
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  await runQuery("UPDATE stage_queue SET status = 'left' WHERE status = 'waiting'");
  await S.setConfig({ bookings_per_hour: 50, takeover_mode: "when_idle" }, "test");
}
let holder, stranger, padOwner, staff;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  holder = await mkUser({ username: "holder" });
  stranger = await mkUser({ username: "stranger" });
  padOwner = await mkUser({ username: "padowner" });
  staff = await mkUser({ username: "boss", class: "Admin" });
  await S.init();
  await S.setConfig({ price_per_min: 0, min_minutes: 2, max_minutes: 60, max_concurrent: 6, start_window_min: 10, idle_grace_min: 5,
                      bookings_per_hour: 50, revenue_vault: "reserve", enabled: true, schedule_days: 14, schedule_per_user: 3, lead_min: 5, queue_max: 10 }, "test");
  for (const room of [HOUSE, PLANT]) await rooms.setStage(room, { slot_count: 1, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await rooms.setOwner(PLANT, "padowner", "boss");
});
test.afterEach(clear);

for (const room of [HOUSE, PLANT]) {
  test(`${room}: a second video while the first plays -> 409 naming it; replace -> the new video plays, the old one ended 'replaced'`, async () => {
    const a = await video(holder, room, A);
    assert.equal(a.slot.status, "active");
    let seen = null;
    await assert.rejects(video(holder, room, B), (e) => { seen = e; return refused(409, "have_slot")(e); });
    assert.equal(seen.message, "You already have a stage slot.");
    assert.deepEqual({ ...seen.have, label: !!seen.have.label }, { id: a.slot.id, room_id: room, same_pad: true, mode: "embed", status: "active",
                                                                  label: true, title: null, replaceable: true });
    T += 30000;
    const b = await video(holder, room, B, { replace: a.slot.id });
    assert.equal(b.slot.status, "active");
    assert.equal(b.slot.embed.id, "BBBBBBBBBBB");
    assert.notEqual(b.slot.id, a.slot.id, "a NEW slot (on-air picks / golive / the log follow slot ids)");
    const old = await S.getSlot(a.slot.id);
    assert.deepEqual([old.status, old.end_reason, old.ended_by, old.settled], ["ended", "replaced", "holder", 1]);
    const live = await S.publicSlots(room);
    assert.deepEqual(live.map((s) => [s.id, s.embed && s.embed.id]), [[b.slot.id, "BBBBBBBBBBB"]], "the stage shows only the new video, at once");
    assert.equal(live[0].since, T, "its since is the replace (the page starts it from 0)");
    const ev = await getQuery("SELECT what, detail FROM stage_events WHERE slot_id = ? ORDER BY id", [b.slot.id]).catch(() => []);
    if (ev.length) assert.ok(ev.some((x) => /replaced /.test(x.detail || "")), "the booking's event names the slot it replaced");
  });
}

test("the feature follows: an auto-feature is re-made on the new video; a feature someone gave moves to it", async () => {
  const a = await video(holder, HOUSE, A);
  assert.equal((await S.getSlot(a.slot.id)).feature_by, "auto");
  const b = await video(holder, HOUSE, B, { replace: a.slot.id });
  const sb = await S.getSlot(b.slot.id);
  assert.deepEqual([sb.featured, sb.feature_by], [1, "auto"]);
  await S.unfeature(b.slot.id, "system", "test");
  await S.featureByOwner(b.slot.id, "boss");
  assert.equal((await S.getSlot(b.slot.id)).feature_by, "owner");
  const c = await video(holder, HOUSE, C, { replace: b.slot.id });
  const sc = await S.getSlot(c.slot.id);
  assert.deepEqual([sc.featured, sc.feature_by, sc.embed && JSON.parse(sc.embed).p], [1, "owner", "twitch"], "the hand-given feature moved with it");
  assert.equal((await S.getSlot(b.slot.id)).featured, 0);
});

test("the pad's owner and staff may replace someone's video on their pad; a stranger may not (nothing changes)", async () => {
  const a = await video(holder, PLANT, A);
  await assert.rejects(video(stranger, PLANT, B, { replace: a.slot.id }), refused(404, "replace_gone"));
  assert.equal((await S.getSlot(a.slot.id)).status, "active", "the stranger's try changed nothing");
  const b = await video(padOwner, PLANT, B, { replace: a.slot.id });
  assert.equal(b.slot.username, "padowner");
  assert.deepEqual([(await S.getSlot(a.slot.id)).end_reason, (await S.getSlot(a.slot.id)).ended_by], ["replaced", "padowner"]);
  // the pad's owner has no say on Pepe's pad; staff do
  const h = await video(holder, HOUSE, A);
  await assert.rejects(video(padOwner, HOUSE, C, { replace: h.slot.id }), refused(404, "replace_gone"));
  const s = await video(staff, HOUSE, C, { replace: h.slot.id });
  assert.equal(s.slot.username, "boss");
  assert.equal((await S.getSlot(h.slot.id)).end_reason, "replaced");
});

test("refusals change nothing: a stream, a later booking, a bad link, another pad's video, a stream slot, an ended slot", async () => {
  const a = await video(holder, HOUSE, A);
  const still = async () => assert.equal((await S.getSlot(a.slot.id)).status, "active");
  await assert.rejects(S.book(holder, { room: HOUSE, minutes: 30, mode: "stream", replace: a.slot.id }), refused(400, "replace_kind"));
  await assert.rejects(video(holder, HOUSE, B, { replace: a.slot.id, start_at: T + 3600000 }), refused(400, "replace_kind"));
  await assert.rejects(video(holder, HOUSE, "https://example.com/not-a-video", { replace: a.slot.id }), refused(400));
  await still();
  await assert.rejects(video(holder, PLANT, B, { replace: a.slot.id }), refused(409, "replace_other_pad"));
  await still();
  await S.end(a.slot.id, "owner_ended", "holder");
  await assert.rejects(video(holder, HOUSE, B, { replace: a.slot.id }), refused(409, "replace_gone"));
  await assert.rejects(video(holder, HOUSE, B, { replace: "no-such-slot" }), refused(404, "replace_gone"));
  // a stream slot in the way: named, but not replaceable (end it first)
  const st = await S.book(holder, { room: HOUSE, minutes: 30 });
  let seen = null;
  await assert.rejects(video(holder, HOUSE, B), (e) => { seen = e; return refused(409, "have_slot")(e); });
  assert.deepEqual([seen.have.id, seen.have.mode, seen.have.replaceable], [st.slot.id, "stream", false]);
  await assert.rejects(video(holder, HOUSE, B, { replace: st.slot.id }), refused(409, "replace_kind"));
  assert.equal((await S.getSlot(st.slot.id)).status, "waiting");
  // a video on another pad: named (same_pad false), not replaceable from here
  await S.end(st.slot.id, "owner_ended", "holder");
  const p = await video(holder, PLANT, A);
  await assert.rejects(video(holder, HOUSE, B), (e) => { seen = e; return refused(409, "have_slot")(e); });
  assert.deepEqual([seen.have.id, seen.have.same_pad, seen.have.replaceable], [p.slot.id, false, false]);
});

test("one transaction: a new video that can't be booked leaves the old one playing (members keep the hourly limit, owners / staff don't)", async () => {
  const a = await video(holder, HOUSE, A);
  const o = await video(padOwner, PLANT, A);
  await S.setConfig({ bookings_per_hour: 1 }, "test");       // (both already booked in this hour)
  await assert.rejects(video(holder, HOUSE, B, { replace: a.slot.id }), refused(429));
  const s = await S.getSlot(a.slot.id);
  assert.deepEqual([s.status, s.settled, s.end_reason, s.featured], ["active", 0, null, 1], "rolled back: still playing, still featured");
  assert.deepEqual((await S.publicSlots(HOUSE)).map((x) => x.id), [a.slot.id]);
  T += 1000;
  const o2 = await video(padOwner, PLANT, B, { replace: o.slot.id });
  assert.equal(o2.slot.status, "active", "the pad's owner changing the video on their own stage isn't held to the hourly count");
});

test("a paid pad: the old video's hold settles and the new one is held in the same step; a hold that can't be paid rolls both back", async () => {
  await S.setConfig({ price_per_min: 10 }, "test");
  await rooms.setStage(PLANT, { slot_count: 1, slot_price: 10 }, "test", { maxSlots: 4, maxPrice: 10 });
  const bal = async () => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [holder.userId]))[0].b;
  const rows = async () => (await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = ?", [holder.userId]))[0].n;
  try {
    const b0 = await bal();
    const a = await video(holder, PLANT, A);                       // 30 min x 10 = 300 held
    assert.equal(await bal(), b0 - 300);
    T += 90 * 1000;
    const b = await video(holder, PLANT, B, { replace: a.slot.id });
    const old = await S.getSlot(a.slot.id);
    assert.deepEqual([old.status, old.end_reason, old.charged + old.refunded], ["ended", "replaced", 300], "the old hold is settled in full");
    assert.equal(await bal(), b0 - old.charged - 300, "the old refund in, the new hold out - once each");
    // the next replace asks for more than the holder has: nothing moves (the refund is rolled back with the failed hold)
    await runQuery("UPDATE users SET points_balance = 0 WHERE userId = ?", [holder.userId]);
    const n0 = await rows();
    await assert.rejects(video(holder, PLANT, A, { replace: b.slot.id, minutes: 60 }), refused(402));
    const sb = await S.getSlot(b.slot.id);
    assert.deepEqual([sb.status, sb.settled, sb.end_reason], ["active", 0, null], "the playing video is untouched");
    assert.equal(await bal(), 0, "no refund leaked out of the rolled-back replace");
    assert.equal(await rows(), n0, "no ledger row either");
  } finally {
    await runQuery("UPDATE users SET points_balance = 100000 WHERE userId = ?", [holder.userId]);
    await S.setConfig({ price_per_min: 0 }, "test");
    await rooms.setStage(PLANT, { slot_count: 1, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  }
});

test("the queue's refusal names the slot too (the page then books for now with replace)", async () => {
  const a = await video(holder, PLANT, A);
  let seen = null;
  await assert.rejects(S.joinQueue(holder, { room: PLANT, minutes: 30, mode: "embed", embed: B }), (e) => { seen = e; return refused(409, "have_slot")(e); });
  assert.deepEqual([seen.have.id, seen.have.replaceable], [a.slot.id, true]);
  const b = await video(holder, PLANT, B, { replace: a.slot.id });
  assert.equal(b.slot.status, "active");
});

test("HTTP: POST /api/stage/book answers have_slot with `have`, then replaces", async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { req.user = req.headers["x-test-user"] === holder.userId ? holder : null; next(); };
  S.register(app, { addUser, isBotToken: () => false, noTimers: true });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const post = (body) => fetch(base + "/api/stage/book", { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": holder.userId }, body: JSON.stringify(body) });
  try {
    let r = await post({ minutes: 30, mode: "embed", embed: A });
    const a = await r.json();
    assert.equal(a.ok, true);
    r = await post({ minutes: 30, mode: "embed", embed: B });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.code, "have_slot");
    assert.equal(j.have.id, a.slot.id);
    assert.equal(j.have.replaceable, true);
    r = await post({ minutes: 30, mode: "embed", embed: B, replace: j.have.id });
    const b = await r.json();
    assert.equal(b.ok, true);
    assert.equal(b.slot.embed.id, "BBBBBBBBBBB");
  } finally { srv.close(); }
});

test("on air: a replaced slot that is Pepe's on-air pick comes off air", async () => {
  const OA = require(path.join(repo, "onair"));
  OA._setClock(() => T);
  await OA.init();
  await OA.saveConfig({ enabled: true }, "test");
  try {
    const a = await video(holder, HOUSE, A);
    await OA.setSlot(a.slot.id, "web:boss", { admin: true, rights: true });
    assert.ok(OA.view().target, "on air");
    await video(holder, HOUSE, B, { replace: a.slot.id });
    await OA.check();
    assert.equal(OA.view().target, null, "the replaced pick is off air");
    const last = (await getQuery("SELECT what, detail FROM onair_log ORDER BY id DESC LIMIT 1"))[0];
    assert.deepEqual([last.what, last.detail], ["end", "ended"]);
  } finally { await OA.clear("test", "test").catch(() => {}); await OA.saveConfig({ enabled: false }, "test"); }
});

// ── the pages ──
function el(tag) {
  const e = { tagName: String(tag || "div").toUpperCase(), children: [], attrs: {}, style: {}, listeners: {}, className: "", value: "", checked: false, disabled: false,
    _text: "", options: [], parentNode: null,
    classList: { add(c) { if (!e.className.split(" ").includes(c)) e.className = (e.className + " " + c).trim(); },
                 remove(c) { e.className = e.className.split(" ").filter((x) => x && x !== c).join(" "); },
                 toggle(c, on) { const want = on === undefined ? !e.className.split(" ").includes(c) : !!on; if (want) this.add(c); else this.remove(c); return want; },
                 contains(c) { return e.className.split(" ").includes(c); } },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    insertBefore(c) { this.children.unshift(c); c.parentNode = this; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; }, addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; }, focus() {}, play() { return Promise.resolve(); }, closest() { return null; },
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get innerHTML() { return ""; }, set innerHTML(v) { this.children = []; this._html = String(v); } };
  e.selectedOptions = [e];
  return e;
}

function switcher(opts) {
  const ctx = { document: { readyState: "complete", createElement: el }, console, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    location: { hostname: "publicaccess.tv" }, fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }), confirm: () => false, alert() {}, Date };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  ctx.PATVStage = { player: () => ({ stop() {}, setSrc() {}, start() {}, running: () => false }) };
  ctx.PATVStageMic = { render: () => ({ update() {}, stop() {}, selection: () => ({ stream: "mic", embed: true, capture: false, nsfw: false }) }) };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8"), ctx);
  const host = el("div");
  const sw = ctx.PATVStage.switcher(Object.assign({ tabs: null, wrap: el("div"), embedHost: host, api: "/api/stage?room=pad", slots: [], pepeOn: true,
                                                    pepeHere: true, slug: "pad", watch: false }, opts));
  return { sw, host, ctx, src: () => (host.children[0] ? host.children[0].src : null), frames: () => host.children.length };
}

test("stage-room.js: a video slot starts where the broadcast is; polls never rebuild it; after the mic stage it resumes, never from 0", () => {
  const since = Date.now() - 95 * 1000;
  const x = switcher({ slots: [{ id: "s1", display: "holder", featured: true, feature_by: "owner", embed: { p: "youtube", t: "video", id: "BBBBBBBBBBB" }, since }] });
  assert.equal(x.sw.view(), "slot:s1");
  const m = /[?&]start=(\d+)/.exec(x.src() || "");
  assert.ok(m, x.src());
  assert.ok(Number(m[1]) >= 94 && Number(m[1]) <= 97, "starts ~95 s in: " + m[1]);
  const first = x.host.children[0];
  x.sw.show();
  x.sw.show();
  assert.equal(x.host.children[0], first, "the same iframe (a show / poll never rebuilds it)");
  // the 🎙 mic stage takes the view (a featured-by-hand slot wins the default, so the viewer picks it), then back
  x.sw.setMic({ v: 1, active: true, count: 1, default: "first", layout: "split", src: [{ id: "a" }] });
  assert.equal(x.frames(), 1);
  const E = x.ctx.PATVStage.embedUrl;
  assert.equal(E({ p: "youtube", t: "video", id: "BBBBBBBBBBB" }), "https://www.youtube-nocookie.com/embed/BBBBBBBBBBB?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1");
  assert.match(E({ p: "youtube", t: "video", id: "BBBBBBBBBBB" }, 125.7), /&start=125$/);
  assert.doesNotMatch(E({ p: "youtube", t: "video", id: "BBBBBBBBBBB" }, 3), /start=/, "under 5 s: from the top");
  assert.doesNotMatch(E({ p: "youtube", t: "live", id: "BBBBBBBBBBB" }, 300), /start=/, "a live video: no seek");
  assert.match(E({ p: "twitch", t: "vod", id: "123456789" }, 3725), /&time=1h2m5s$/);
  assert.doesNotMatch(E({ p: "twitch", t: "channel", id: "somebody" }, 300), /time=/, "a live channel: no seek");
  assert.doesNotMatch(E({ p: "youtube", t: "channel", id: "UC" + "x".repeat(22) }, 300), /start=/);
});

test("stage-room.js: the mic stage destroys the player; coming back rebuilds it at the broadcast position (the owner's replay)", () => {
  const since = Date.now() - 40 * 1000;
  const x = switcher({ slots: [{ id: "s1", display: "holder", featured: true, feature_by: "auto", embed: { p: "youtube", t: "video", id: "AAAAAAAAAAA" }, since }] });
  assert.equal(x.sw.view(), "slot:s1");
  x.sw.setMic({ v: 1, active: true, count: 1, default: "first", layout: "split", src: [{ id: "a" }] });
  assert.equal(x.sw.view(), "mic", "an auto-featured video yields to the mic stage");
  assert.equal(x.frames(), 0, "its player is gone meanwhile");
  x.sw.setMic(null);                                       // mic follows off -> back at once
  assert.equal(x.sw.view(), "slot:s1");
  const m = /[?&]start=(\d+)/.exec(x.src() || "");
  assert.ok(m && Number(m[1]) >= 39, "rebuilt where the broadcast is, not from 0: " + x.src());
});

test("stage-room.js: the poll's server clock corrects this one (skew)", async () => {
  const since = 1_000_000_000_000;                          // the server's clock is far behind this machine's
  let answer = null;
  const x = switcher({ slots: [] });
  x.ctx.fetch = () => Promise.resolve({ json: () => Promise.resolve(answer) });
  answer = { active: true, now: since + 60 * 1000, slots: [{ id: "s2", display: "h", featured: true, feature_by: "owner", embed: { p: "youtube", t: "video", id: "BBBBBBBBBBB" }, since }] };
  await x.sw.poll();
  const m = /[?&]start=(\d+)/.exec(x.src() || "");
  assert.ok(m && Number(m[1]) >= 59 && Number(m[1]) <= 61, "60 s by the SERVER's clock: " + x.src());
});

test("/api/stage answers the server's clock (now)", () => {
  const src = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  assert.match(src, /res\.json\(\{ \.\.\.stage\(\), slots, front, pepe_here: here !== false, now: t \}\)/);
  assert.equal(typeof S.clockNow, "function");
  assert.equal(S.clockNow(), T);
});

function bookPage() {
  const els = {};
  const $ = (id) => (els[id] = els[id] || el("div"));
  const radios = { mode: "embed", when: "now" };
  const calls = [], confirms = [];
  let answers = [];
  const ctx = { console, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, Date, JSON, Math, Number, String, Promise,
    location: { hostname: "publicaccess.tv", search: "", pathname: "/stage", href: "https://publicaccess.tv/stage" },
    navigator: {}, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    confirm: (q) => { confirms.push(q); return ctx._yes.shift() !== false; }, alert() {}, prompt() {}, _yes: [],
    fetch: (url, init) => {
      calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      const a = /\/api\/stage\/(book|queue)$/.test(url) ? answers.shift() : { slots: [] };
      return Promise.resolve({ status: 200, json: () => Promise.resolve(a || {}) });
    },
    document: { getElementById: $, readyState: "complete", createElement: el, addEventListener() {}, body: el("body"), visibilityState: "visible",
      querySelector: (sel) => { const m = /input\[name=(\w+)\](?:\[value=(\w+)\])?(:checked)?/.exec(sel); if (!m) return null;
                                if (m[3]) { const r = el("input"); r.value = radios[m[1]]; return r; } if (m[2]) { const r = el("input"); r.value = m[2]; return r; } return null; },
      querySelectorAll: () => [] } };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  $("sb").setAttribute("data-signed", "1");
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "stage-book.js"), "utf8"), ctx);
  return { $, ctx, calls, confirms, radios, answer: (...a) => { answers = a; },
           submit: () => { for (const fn of $("bookForm").listeners.submit || []) fn({ preventDefault() {} }); } };
}
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test("stage-book.js: 'You already have a stage slot' -> offers to replace it, books again with replace; declined = nothing", async () => {
  let p;
  try { p = bookPage(); } catch (e) { assert.fail("stage-book.js didn't load in the test page: " + e.message); }
  p.$("room").value = PLANT; p.$("embed").value = B; p.$("mins").value = "30"; p.$("title").value = "";
  p.ctx._yes = [true, true];
  p.answer({ ok: false, error: "You already have a stage slot.", code: "have_slot", have: { id: "old1", same_pad: true, replaceable: true, label: "YouTube video", mode: "embed" } },
           { ok: true, slot: { id: "new1", status: "active" } });
  p.submit();
  await flush(); await flush();
  const books = p.calls.filter((c) => /\/api\/stage\/book$/.test(c.url));
  assert.equal(books.length, 2, JSON.stringify(p.calls));
  assert.equal(books[1].body.replace, "old1");
  assert.equal(books[1].body.embed, B);
  assert.match(p.confirms[1], /already playing YouTube video on this pad\. Replace it with this video\?/);
  assert.equal(p.$("bookMsg").textContent, "Replaced - your new video is on.");
  // declined: nothing more is sent, the message says what's still on
  const q = bookPage();
  q.$("room").value = PLANT; q.$("embed").value = B; q.$("mins").value = "30";
  q.ctx._yes = [true, false];
  q.answer({ ok: false, error: "You already have a stage slot.", code: "have_slot", have: { id: "old1", same_pad: true, replaceable: true, label: "YouTube video" } });
  q.submit();
  await flush(); await flush();
  assert.equal(q.calls.filter((c) => /\/api\/stage\/book$/.test(c.url)).length, 1);
  assert.match(q.$("bookMsg").textContent, /Your video is still on/);
  // not replaceable (a stream / another pad): says where it is, never offers
  const r = bookPage();
  r.$("room").value = PLANT; r.$("embed").value = B; r.$("mins").value = "30";
  r.ctx._yes = [true];
  r.answer({ ok: false, error: "You already have a stage slot.", code: "have_slot", have: { id: "x", same_pad: false, replaceable: false, mode: "embed" } });
  r.submit();
  await flush(); await flush();
  assert.equal(r.confirms.length, 1, "only the booking's own confirm");
  assert.equal(r.$("bookMsg").textContent, "You already have a stage slot. It's on another pad - end it there first.");
  // the queue's refusal: the replace books for NOW
  const w = bookPage();
  w.radios.when = "queue";
  w.$("room").value = PLANT; w.$("embed").value = B; w.$("mins").value = "30";
  w.ctx._yes = [true, true];
  w.answer({ ok: false, error: "You already have a stage slot.", code: "have_slot", have: { id: "old2", same_pad: true, replaceable: true, title: "My clip" } },
           { ok: true, slot: { id: "new2", status: "active" } });
  w.submit();
  await flush(); await flush();
  const wb = w.calls.filter((c) => /\/api\/stage\/(book|queue)$/.test(c.url));
  assert.deepEqual(wb.map((c) => c.url.replace(/^.*\/api\/stage\//, "")), ["queue", "book"]);
  assert.equal(wb[1].body.replace, "old2");
  assert.match(w.confirms[1], /already playing My clip/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["js.stage.q_replace", "js.stage.replacing", "js.stage.replaced", "js.stage.replace_no", "js.stage.have_other_pad", "js.stage.have_slot_end",
                   "js.stage.your_video", "js.stage.r_replaced"]) assert.ok(en[k], k);
});
