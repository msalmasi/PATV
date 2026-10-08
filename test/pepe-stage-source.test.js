// Offline tests for 1.99fv - Pepe's main stage source (mainstage.js pepe_embed / pepeSource / pepePlayer,
// bridge.stage().pepe_src, stage-room.js, /stage/admin):
//   * Twitch being live (our relay to it running) never swaps the player: default = his HLS (+ ⚡ WHEP)
//   * an admin can choose a Twitch embed (channel name, "twitch" = the configured channel, or a link) or a
//     YouTube embed (watch / live / youtu.be / channel/UC…/live), with the same parse + clean as streamer slots;
//     bad links are refused (400) and change nothing; "pepe" goes back to his stream
//   * live detection (bridge.stage().active, ON AIR, the Pepe tab) and snaps / clips follow his own stream only
//   NODE_PATH=../node_modules node --test test/pepe-stage-source.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-src-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.PEPE_TWITCH_CHANNEL;
process.env.SECRET_KEY = "test-secret";
const HLS_DIR = path.join(tmp, "hls");
process.env.HLS_PLAYLIST_PATH = path.join(HLS_DIR, "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const R = require(path.join(repo, "restream"));

const HLS = "https://publicaccess.tv/hls/broadcast.m3u8";
const WHEP = "https://stream.publicaccess.tv/whep/pepe";
const twitchRelayLive = () => R.workerSync({ status: { main: { state: "live", kbps: 4500 } } });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
});
test.afterEach(async () => { await S.setConfig({ pepe_embed: null }, "test"); R._reset(); });

test("default: pepe_embed is null - Pepe's stage is his own stream, even while Twitch is live", async () => {
  assert.equal(S.DEFAULTS.pepe_embed, null);
  assert.equal(S.config().pepe_embed, null);
  assert.equal(S.pepeSource().mode, "stream");
  assert.equal(S.pepeSource().twitch.live, false);
  await twitchRelayLive();
  const src = S.pepeSource();
  assert.equal(src.mode, "stream", "Twitch going live changes nothing");
  assert.deepEqual(src.twitch, { login: "publicaccess_ttv", url: "https://www.twitch.tv/publicaccess_ttv", live: true }, "info only");
  assert.deepEqual(S.pepePlayer({ active: true, whep: WHEP }, src), { kind: "hls", hls: HLS, whep: WHEP }, "HLS + ⚡");
  assert.deepEqual(S.pepePlayer({ active: true }, src), { kind: "hls", hls: HLS, whep: null }, "HLS without WHIP");
});

test("admin chooses a Twitch embed: channel name, 'twitch' (the configured channel) or a link", async () => {
  await S.setConfig({ pepe_embed: "twitch" }, "test");
  assert.deepEqual(S.config().pepe_embed, { p: "twitch", t: "channel", id: "publicaccess_ttv" });
  process.env.PEPE_TWITCH_CHANNEL = "Some_Chan";
  try {
    assert.equal(S.pepeTwitchChannel(), "some_chan");
    await S.setConfig({ pepe_embed: "twitch" }, "test");
    assert.deepEqual(S.config().pepe_embed, { p: "twitch", t: "channel", id: "some_chan" });
    process.env.PEPE_TWITCH_CHANNEL = "bad name!";
    assert.equal(S.pepeTwitchChannel(), "publicaccess_ttv", "a bad env value falls back");
  } finally { delete process.env.PEPE_TWITCH_CHANNEL; }
  await S.setConfig({ pepe_embed: "OtherChannel" }, "test");
  assert.deepEqual(S.config().pepe_embed, { p: "twitch", t: "channel", id: "otherchannel" }, "a bare channel name");
  await S.setConfig({ pepe_embed: "https://www.twitch.tv/publicaccess_ttv" }, "test");
  const src = S.pepeSource();
  assert.equal(src.mode, "embed");
  assert.deepEqual(src.embed, { p: "twitch", t: "channel", id: "publicaccess_ttv" });
  assert.equal(src.label, "Twitch: publicaccess_ttv");
  assert.equal(src.url, "https://www.twitch.tv/publicaccess_ttv");
  assert.deepEqual(S.pepePlayer({ active: true, whep: WHEP }, src), { kind: "embed", embed: { p: "twitch", t: "channel", id: "publicaccess_ttv" } });
  // persisted like every stage setting
  const { getQuery } = require(path.join(repo, "dbUtils"));
  const row = (await getQuery("SELECT value FROM stage_config WHERE key = 'pepe_embed'"))[0];
  assert.deepEqual(JSON.parse(row.value), { p: "twitch", t: "channel", id: "publicaccess_ttv" });
  // back to Pepe's stream
  await S.setConfig({ pepe_embed: "pepe" }, "test");
  assert.equal(S.config().pepe_embed, null);
  assert.equal(S.pepeSource().mode, "stream");
});

test("admin chooses a YouTube embed: the same accepted forms as streamer slots", async () => {
  const cases = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", { p: "youtube", t: "video", id: "dQw4w9WgXcQ" }, "YouTube video"],
    ["https://youtu.be/dQw4w9WgXcQ", { p: "youtube", t: "video", id: "dQw4w9WgXcQ" }, "YouTube video"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", { p: "youtube", t: "live", id: "dQw4w9WgXcQ" }, "YouTube live"],
    ["youtube.com/channel/UCabcdefghijklmnopqrstuv/live", { p: "youtube", t: "channel", id: "UCabcdefghijklmnopqrstuv" }, "YouTube live channel"],
  ];
  for (const [link, embed, label] of cases) {
    await S.setConfig({ pepe_embed: link }, "test");
    const src = S.pepeSource();
    assert.deepEqual(src.embed, embed, link);
    assert.equal(src.label, label, link);
    assert.deepEqual(S.pepePlayer({ active: true }, src), { kind: "embed", embed }, link);
  }
  assert.equal(S.pepeSource().url, "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live");
  // the page builds the official player only, from {p,t,id}
  const ctx = { location: { hostname: "publicaccess.tv" }, document: {}, Math, JSON, String };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8"), ctx);
  assert.match(ctx.PATVStage.embedUrl({ p: "youtube", t: "live", id: "dQw4w9WgXcQ" }), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
});

test("bad links are refused (400) and leave the source alone", async () => {
  await S.setConfig({ pepe_embed: "https://youtu.be/dQw4w9WgXcQ" }, "test");
  for (const bad of ["https://evil.example/x", "https://www.youtube.com/@pepe", "https://www.twitch.tv/somechan/clip/abc", "javascript:alert(1)",
                     { p: "youtube", t: "video", id: "<script>" }, "a b"]) {
    await assert.rejects(S.setConfig({ pepe_embed: bad }, "test"), (e) => e.status === 400 && e.refuse === true, JSON.stringify(bad));
  }
  assert.deepEqual(S.config().pepe_embed, { p: "youtube", t: "video", id: "dQw4w9WgXcQ" }, "unchanged");
  // saving other settings keeps it
  await S.setConfig({ queue_max: 9 }, "test");
  assert.deepEqual(S.config().pepe_embed, { p: "youtube", t: "video", id: "dQw4w9WgXcQ" });
  for (const back of ["", "hls", "stream", null]) {
    await S.setConfig({ pepe_embed: "twitch" }, "test");
    await S.setConfig({ pepe_embed: back }, "test");
    assert.equal(S.config().pepe_embed, null, JSON.stringify(back));
  }
});

test("live detection ignores Twitch: off air on his HLS = off air, whatever Twitch or the embed does", async () => {
  await twitchRelayLive();
  assert.deepEqual(S.pepePlayer({ active: false }, S.pepeSource()), { kind: "off" });
  await S.setConfig({ pepe_embed: "twitch" }, "test");
  assert.deepEqual(S.pepePlayer({ active: false }, S.pepeSource()), { kind: "off" }, "even with the Twitch embed chosen");
  const B = require(path.join(repo, "bridge"));
  fs.mkdirSync(HLS_DIR, { recursive: true });
  const waitFor = async (pred) => { for (let i = 0; i < 80 && !pred(); i++) await new Promise((r) => setTimeout(r, 100)); return pred(); };
  assert.ok(await waitFor(() => B.stage().active === false), "no HLS playlist -> off air");
  const st = B.stage();
  assert.equal(st.pepe_src.mode, "embed");
  assert.equal(st.pepe_src.twitch.live, true, "Twitch is live...");
  assert.equal(st.active, false, "...but Pepe's stage is off air");
  // restream: the relay to Twitch is still keyed off Pepe's own stream (mainLive), not the other way round
  assert.equal(R.mainLive(), false);
  // no Twitch live detection left in the code paths
  const room = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  assert.doesNotMatch(room, /Twitch\.Player|twitchLive|twitchHost/);
  const home = fs.readFileSync(path.join(repo, "views", "home.ejs"), "utf8");
  assert.doesNotMatch(home, /player\.twitch\.tv\/js\/embed|twitchHost|id="twitch"/);
  for (const v of ["home.ejs", "room.ejs"]) {
    const src = fs.readFileSync(path.join(repo, "views", v), "utf8");
    assert.ok(src.includes("pepeSrc: <%- JSON.stringify(st.pepe_src || null).replace(/</g, '\\\\u003c') %>"), v + " passes st.pepe_src (escaped)");
    assert.match(src, /stage-room\.js\?v=7/, v + " cache-buster");
  }
});

// ── the page: stage-room.js in a VM ──
function page(api) {
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  const P = { sets: [], stops: 0, air: [], api, twitchPlayers: 0 };
  const el = () => { const e = { innerHTML: "", children: [], classList: { add: () => { e.hidden = true; }, remove: () => { e.hidden = false; }, toggle: () => {} },
    appendChild: (c) => e.children.push(c), setAttribute: () => {}, addEventListener: (t, f) => { e.on = f; } }; return e; };
  P.embedHost = el(); P.tabs = el();
  const ctx = { PATVStage: { player: () => ({ start: () => {}, stop: () => P.stops++, setSrc: (u, w) => P.sets.push([u, w]), running: () => false }) },
                addEventListener: () => {}, document: { readyState: "complete", visibilityState: "visible", createElement: () => ({ setAttribute: () => {} }) },
                location: { hostname: "publicaccess.tv" }, setInterval: () => 1, clearInterval: () => {},
                Twitch: { Player: function () { P.twitchPlayers++; } },
                fetch: () => Promise.resolve({ json: () => Promise.resolve(P.api), status: 200 }), Math, Date, JSON, String, Array, Number, encodeURIComponent, decodeURIComponent };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  P.ctx = ctx;
  return P;
}
const iframeSrc = (P) => (P.embedHost.children.at(-1) || {}).src || null;

test("page: Twitch live + default settings -> the player is still Pepe's HLS / WHEP, with a subtle Watch on Twitch link", async () => {
  await twitchRelayLive();
  const pepe_src = S.pepeSource();
  const P = page({ active: true, slots: [], pepe_here: true, whep: WHEP, pepe_src });
  const sw = P.ctx.PATVStage.switcher({ api: "/api/stage", tabs: P.tabs, embedHost: P.embedHost, slots: [], pepeOn: true, pepeHere: true, pepeWhep: WHEP,
                                        pepeSrc: pepe_src, watch: false, onAir: (on, sub) => P.air.push([on, sub]) });
  assert.deepEqual(P.sets.at(-1), [HLS, WHEP], "HLS + ⚡");
  assert.equal(iframeSrc(P), null, "no Twitch iframe");
  assert.equal(P.twitchPlayers, 0, "no Twitch player for live detection");
  assert.deepEqual(P.air.at(-1), [true, null]);
  assert.match(P.tabs.innerHTML, /href="https:\/\/www\.twitch\.tv\/publicaccess_ttv" target="_blank" rel="noopener noreferrer"[^>]*>🟣 Watch on Twitch/);
  await sw.poll();
  assert.deepEqual(P.sets.at(-1), [HLS, WHEP], "still HLS after a poll");
  assert.equal(sw.selection().stream, "pepe");
  assert.equal(sw.selection().capture, true, "snaps / clips on his stream");
  // Twitch relay down: the link goes, nothing else changes
  P.api = { ...P.api, pepe_src: { ...pepe_src, twitch: { ...pepe_src.twitch, live: false } } };
  await sw.poll();
  assert.doesNotMatch(P.tabs.innerHTML, /Watch on Twitch/);
  assert.deepEqual(P.sets.at(-1), [HLS, WHEP]);
});

test("page: the admin-chosen Twitch / YouTube embed shows while HIS stream is on air; snaps / clips + ON AIR still follow his stream", async () => {
  await S.setConfig({ pepe_embed: "twitch" }, "test");
  const pepe_src = S.pepeSource();
  const P = page({ active: true, slots: [], pepe_here: true, pepe_src });
  const sw = P.ctx.PATVStage.switcher({ api: "/api/stage", tabs: P.tabs, embedHost: P.embedHost, slots: [], pepeOn: true, pepeHere: true,
                                        pepeSrc: pepe_src, watch: false, onAir: (on, sub) => P.air.push([on, sub]) });
  assert.match(iframeSrc(P), /^https:\/\/player\.twitch\.tv\/\?channel=publicaccess_ttv&parent=publicaccess\.tv&/);
  assert.equal(P.sets.length, 0, "the HLS player isn't started");
  assert.deepEqual(P.air.at(-1), [true, "via Twitch: publicaccess_ttv"]);
  assert.deepEqual({ ...sw.selection() }, { stream: "pepe", label: "Pepe's stream", embed: false, capture: true, nsfw: false }, "snaps / clips: his HLS (server side)");
  // the viewer picks his own stream (this page only)
  assert.match(P.tabs.innerHTML, /data-pepe-src="own"/);
  P.tabs.on({ target: { closest: () => ({ hasAttribute: (a) => a === "data-pepe-src", getAttribute: () => "own" }) } });
  assert.deepEqual(P.sets.at(-1), [HLS, null], "HLS again");
  assert.match(P.tabs.innerHTML, /data-pepe-src="embed"[^>]*>Back to Twitch: publicaccess_ttv/);
  // his stream drops: off air, embed gone (Twitch doesn't keep it on air)
  P.api = { active: false, slots: [], pepe_here: true, pepe_src };
  await sw.poll();
  assert.equal(P.air.at(-1)[0], false, "off air");
  assert.equal(P.embedHost.innerHTML, "");
  // admin switches to YouTube: the page follows on the next poll (and the viewer's own-stream pick resets)
  await S.setConfig({ pepe_embed: "https://www.youtube.com/live/dQw4w9WgXcQ" }, "test");
  P.api = { active: true, slots: [], pepe_here: true, pepe_src: S.pepeSource() };
  await sw.poll();
  assert.match(iframeSrc(P), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.deepEqual(P.air.at(-1), [true, "via YouTube live"]);
  // ...and back to Pepe's stream
  await S.setConfig({ pepe_embed: "pepe" }, "test");
  P.api = { active: true, slots: [], pepe_here: true, pepe_src: S.pepeSource() };
  await sw.poll();
  assert.deepEqual(P.sets.at(-1), [HLS, null]);
  assert.equal(P.embedHost.innerHTML, "");
  // junk from the server never becomes an iframe
  P.api = { active: true, slots: [], pepe_here: true, pepe_src: { mode: "embed", embed: { p: "twitch", t: "channel", id: "x\"><script>" } } };
  await sw.poll();
  assert.deepEqual(P.sets.at(-1), [HLS, null]);
});

test("/stage/admin: the source card (default, Twitch embed button, link form, Back to Pepe's stream) + cache-buster", async () => {
  const ejs = require("ejs");
  const file = path.join(repo, "views", "stageAdmin.ejs");
  const tpl = fs.readFileSync(file, "utf8");
  assert.match(tpl, /stage-admin\.js\?v=3/);
  const render = (pepe_src) => ejs.render(tpl.replace(/<%- include\([^%]*%>/g, ""), {
    user: "admin", isAdmin: true, state: { config: S.config(), open: [], upcoming: [], log: [], bans: [], events: [], rtmp_app: "stage -> live", relays: 0, pepe_src } }, { filename: file });
  const def = render(S.pepeSource());
  assert.match(def, /Showing <b>Pepe's stream \(HLS \+ ⚡\)<\/b> - the default\./);
  assert.match(def, /data-ps="pepe" disabled>↩ Back to Pepe's stream/);
  assert.match(def, /data-ps="twitch">🟣 Twitch embed \(twitch\.tv\/publicaccess_ttv\)/);
  assert.match(def, /<form id="psForm"[^]*name="pepe_embed"/);
  await S.setConfig({ pepe_embed: "https://youtu.be/dQw4w9WgXcQ" }, "test");
  const yt = render(S.pepeSource());
  assert.match(yt, /Showing an embed: <b>YouTube video<\/b> · <a href="https:\/\/youtu\.be\/dQw4w9WgXcQ"/);
  assert.match(yt, /data-ps="pepe" >↩ Back to Pepe's stream/);
  assert.equal(S.adminState ? (await S.adminState()).pepe_src.mode : "embed", "embed", "adminState carries pepe_src");
  const js = fs.readFileSync(path.join(repo, "public", "js", "stage-admin.js"), "utf8");
  assert.match(js, /post\('\/api\/stage\/admin\/config', \{ pepe_embed: v \}\)/);
});
