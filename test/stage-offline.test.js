// Offline tests for 1.99eo: the homepage stage card when nothing plays - an off-air slate in the player's
// 16:9 box (pad name, Off air, "Nothing on stage right now", 🎥 Go live, Next up / Browse Top Pads), the
// stage widgets stay in the side column, and the live-label semantics (LIVE / ON AIR = video; a pad's
// Camfrog room is 💬 ROOM ACTIVE / ROOM OFFLINE) on the homepage, the pad page and the /p guide.
//   node --test test/stage-offline.test.js      (needs the repo's node_modules; uses a temp dir)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stageoff-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const ejs = require("ejs");
const BM = require(path.join(repo, "boostmark"));
const home = require(path.join(repo, "home"));
const mainstage = require(path.join(repo, "mainstage"));

const UL = (n) => String(n == null ? "" : n);
const FRONT = { id: "PepeFrog.Room", slug: "pepefrog-room", title: "Pepe's Pad", pinned: false, owner: null, boost: 0 };
async function renderHome(locals = {}) {
  return ejs.renderFile(path.join(repo, "views", "home.ejs"), Object.assign({
    username: null, me: null, mine: null, S: {}, rooms: [], room: null, roomLive: null, stage: { active: false }, top: [], tops: [],
    story: { rooms: [], caps: [], room: null, signed: false }, hot: null, fx: {}, roomOnStage: false, stageAdmin: null,
    frontInfo: FRONT, pepeHere: true, featuredPrice: 0, slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "",
    boostMark: BM.boostMark, ul: UL,
  }, locals));
}
const between = (html, a, b) => { const i = html.indexOf(a); assert.ok(i >= 0, "found " + a); return html.slice(i, html.indexOf(b, i)); };
const tops = [{ id: "PepeFrog.Room", slug: "pepefrog-room", name: "Pepe's Pad", count: 9, micCount: 1, boost: 0 }];

test("home off air: the slate sits in the player's 16:9 box with the pad name, Off air, the message, Go live and Browse Top Pads", async () => {
  const html = await renderHome({ tops });
  assert.match(html, /<section class="stage off" id="stage"/);
  const player = between(html, '<div class="player" id="player">', '<div class="stcap');
  assert.match(player, /<div class="slate" id="stSlate" role="status"/, "the slate is INSIDE the player box (same 16:9 aspect)");
  assert.match(player, /<span class="pill off">.*OFF AIR<\/span><b id="slPad">Pepe&#39;s Pad<\/b>/s);
  assert.match(player, /<p class="sl-msg">Nothing on stage right now<\/p>/);
  assert.match(player, /<a class="golive-btn" href="\/stage\?room=pepefrog-room">🎥 Go live<\/a>/);
  assert.match(player, /<a class="btn" href="\/p" id="slBrowse">Browse Top Pads<\/a>/);
  assert.doesNotMatch(player, /Next up/);
  // CSS: the player box is 16:9, the stage body is a grid ON and OFF air, the slate hides when live
  assert.match(html, /\.hm \.player \{[^}]*aspect-ratio: 16 \/ 9;/);
  assert.match(html, /\.hm \.stage-body \{ display: grid;/);
  assert.doesNotMatch(html, /\.hm \.stage-body \{ display: none;/);
  assert.match(html, /\.hm \.stage\.live \.slate \{ display: none; \}/);
});

test("home off air: the wheel and Top Pads stay in the side column (no off-air strip, no widget shuffling); Top Pads fills the column", async () => {
  const html = await renderHome({ tops, me: { username: "bob", displayname: "Bob", level: 2, xp: 10, points_balance: 50000, camfrogUsername: "bob" }, username: "bob", mine: {} });
  assert.doesNotMatch(html, /id="stageOff"|id="stageWidgets"|placeWidgets/);
  const side = between(html, '<div class="stage-side" id="stageSide">', '<!-- ───── you');
  assert.match(side, /id="wheelBox"/);
  assert.match(side, /id="spinButton"/);
  assert.match(side, /<h2 id="tpH"><span>Top Pads<\/span>/);
  assert.ok(side.indexOf('id="wheelBox"') < side.indexOf('id="tpH"'), "wheel above Top Pads, as when live");
  assert.match(html, /@media \(min-width: 1101px\) \{[^@]*\.hm \.stage-side \{ display: flex; flex-direction: column; align-self: stretch; \}[^@]*\.hm \.stage-side > \.tp \{ flex: 1 1 auto; \}/);
});

test("home off air with a booking: 'Next up' (name, title, time) replaces Browse Top Pads; the time is marked for local display", async () => {
  const at = Date.UTC(2026, 9, 7, 22, 30);
  const html = await renderHome({ tops, nextUp: { display: "Alice <3", title: "Plant talk", start_at: at } });
  const slate = between(html, 'id="stSlate"', '<div class="stcap');
  assert.match(slate, /Next up: <b>Alice &lt;3<\/b> · Plant talk · <time datetime="2026-10-07T22:30:00.000Z" data-local-time="\d+">22:30 UTC<\/time>/);
  assert.doesNotMatch(slate, /Browse Top Pads/);
  assert.match(slate, /🎥 Go live/);
  assert.match(html, /querySelectorAll\('time\[data-local-time\]'\)/);
});

test("home live: the stage is .live (slate hidden by CSS), ON AIR pill; the slate markup stays for a later drop", async () => {
  const html = await renderHome({ tops, stage: { active: true, since: Date.now() - 60000 } });
  assert.match(html, /<section class="stage live" id="stage"/);
  assert.match(html, /id="stPillTxt">ON AIR</);
  assert.match(html, /id="stSlate"/);
});

test("home: setPill (the switcher's onAir) only toggles .live/.off - the slate swaps for the player without a reload", async () => {
  const html = await renderHome({ tops });
  const fn = between(html, "function setPill(on, how) {", "\n    }\n");
  assert.match(fn, /stageEl\.classList\.toggle\('live', on\); stageEl\.classList\.toggle\('off', !on\);/);
  assert.match(html, /onAir: function \(on, sub\) \{ setPill\(on,/);
});

test("stage-room.js: a stream coming back on the 10 s /api/stage poll calls onAir(true) and starts the player", async () => {
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  const calls = [], timers = [];
  let started = 0, stopped = 0, api = { active: false, slots: [], pepe_here: true };
  const ctx = { PATVStage: { player: () => ({ start: () => started++, stop: () => stopped++, setSrc: () => {}, running: () => false }) },
                addEventListener: () => {}, document: { readyState: "complete", visibilityState: "visible" }, location: { hostname: "publicaccess.tv" },
                setInterval: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearInterval: () => {},
                fetch: () => Promise.resolve({ json: () => Promise.resolve(api), status: 200 }), Math, Date, JSON, String, Array, Number, encodeURIComponent, decodeURIComponent };
  ctx.window = ctx;
  const win = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const sw = win.PATVStage.switcher({ api: "/api/stage", slots: [], pepeOn: false, pepeHere: true, watch: false, onAir: (on, sub) => calls.push([on, sub]) });
  assert.deepEqual(calls.at(-1), [false, "nothing streaming right now"], "first render: off air");
  assert.ok(timers.some((t) => t.ms === 10000), "polls every 10 s");
  api = { active: true, slots: [], pepe_here: true };
  await sw.poll();
  assert.equal(calls.at(-1)[0], true, "back on air");
  assert.ok(started >= 1, "the player started");
  api = { active: false, slots: [], pepe_here: true };
  await sw.poll();
  assert.equal(calls.at(-1)[0], false, "dropped again -> slate");
});

test("nextSlot: the front pad's first SCHEDULED slot (no requests, nothing long past), public fields only", async () => {
  const T = Date.UTC(2026, 9, 7, 18, 0);
  const orig = mainstage.futureSlots;
  try {
    mainstage.futureSlots = async (room) => {
      assert.equal(room, "PepeFrog.Room");
      return [
        { id: "s0", userId: "u0", username: "old", status: "scheduled", start_at: T - 3600e3, title: "stale" },
        { id: "s1", userId: "u1", username: "asker", status: "requested", start_at: T + 600e3 },
        { id: "s2", userId: "u2", username: "alice", displayname: "Alice", status: "scheduled", start_at: T + 1800e3, title: "Plant talk", stream_key: "SECRET" },
      ];
    };
    assert.deepEqual(await home.nextSlot("PepeFrog.Room", T), { display: "Alice", title: "Plant talk", start_at: T + 1800e3 });
    mainstage.futureSlots = async () => [];
    assert.equal(await home.nextSlot("PepeFrog.Room", T), null);
  } finally { mainstage.futureSlots = orig; }
});

test("labels: the homepage's room card says 💬 ROOM ACTIVE / ROOM OFFLINE (never LIVE), in the server render and the poll", async () => {
  const room = { name: "Pepe's Pad", slug: "pepefrog-room", count: 9, micCount: 1, live: true, topic: "" };
  let html = await renderHome({ room, roomOnStage: true });
  const h2 = between(html, '<h2 id="lrH">', "</h2>");
  assert.match(h2, /On stage: Pepe&#39;s Pad <span class="pill chat" id="lrLive"[^>]*><span class="dot" aria-hidden="true"><\/span><span id="lrLiveTxt">💬 ROOM ACTIVE<\/span>/);
  assert.doesNotMatch(h2, /LIVE/);
  html = await renderHome({ room: { ...room, live: false }, roomOnStage: true });
  assert.match(html, /<span class="pill off" id="lrLive"[^>]*>.*<span id="lrLiveTxt">ROOM OFFLINE<\/span>/);
  const src = fs.readFileSync(path.join(repo, "views", "home.ejs"), "utf8");
  assert.match(src, /'lrLive'\)\.className = 'pill ' \+ \(r\.live \? 'chat' : 'off'\)/);
  assert.match(src, /lrLiveTxt'\)\.textContent = r\.live \? '💬 ROOM ACTIVE' : 'ROOM OFFLINE'/);
  assert.doesNotMatch(src, /lrLiveTxt'\)\.textContent = r\.live \? 'LIVE'/);
  assert.match(html, /\.hm \.pill\.chat \.dot \{ display: none; \}/);
});

test("labels: the pad page header pill and the /p guide use the same room wording; the stage pills keep ON AIR / ON STAGE", async () => {
  const src = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(src, /id="rmLive" title="Is the Camfrog room active\? \(ON AIR on the stage = a video stream\)"/);
  assert.match(src, /<span id="rmLiveTxt"><%= room\.live \? '💬 ROOM ACTIVE' : 'ROOM OFFLINE' %><\/span>/);
  assert.match(src, /rmLiveTxt'\)\.textContent = r\.live \? '💬 ROOM ACTIVE' : 'ROOM OFFLINE'/);
  assert.match(src, /live\.classList\.toggle\('chat', !!r\.live\)/);
  assert.match(src, /id="rmStPillTxt"><%= live \? 'ON AIR' : 'OFF AIR' %>/, "the pad's stage pill is unchanged");
  const guide = fs.readFileSync(path.join(repo, "views", "rooms.ejs"), "utf8");
  assert.match(guide, /r\.live \? '💬 ROOM ACTIVE' : \(r\.bridged \? 'QUIET' : 'OFF THE WEB'\)/);
  assert.match(guide, /📺 <%= liveNow\.length %> ON STAGE/);
  assert.doesNotMatch(guide, /r\.live \? 'LIVE'/);
  // a real render of the pad page header
  const html = await ejs.renderFile(path.join(repo, "views", "room.ejs"), {
    user: "u", signedIn: true, linked: true, room: { name: "Houseplants", slug: "plant_based_chatting", count: 2, live: true, topic: "", platform: "camfrog",
      description: "Plants and chat", owner: "pb", ownerUser: "pb", camfrogName: "Plant Based Chatting" },
    initial: { room: {}, members: [], mic: [], feed: [], cursor: 0 }, onStage: false, stage: {}, latest: [] });
  assert.match(html, /<span class="live chat" id="rmLive"[^>]*><span class="dot" aria-hidden="true"><\/span><span id="rmLiveTxt">💬 ROOM ACTIVE<\/span>/);
});
