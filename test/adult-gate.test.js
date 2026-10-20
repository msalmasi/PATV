// adultgate site: the 18+ pad gate (adultgate.js - ONE owner switch on /pads/admin#adult, OFF by default) and the one-time
// age confirmation (/confirm-age, users.age_confirmed_at + age_confirmed_v).
//
// Three pads - a PUBLIC 18+ pad, a MEMBERS 18+ pad and a Public pad that isn't 18+ (the control) - each with a live Camfrog
// room (a chat line, a topic, people, the mic, a cam, the web relay on), a capture, analytics, a mic-challenge result and
// four posts (an ordinary one + the three kinds made FROM the live room: a chat quote, a mic clip, a capture kept as a
// post); seen by seven viewers: signed out, signed in without a confirmation, confirmed here, confirmed through PATV
// Creators (age_attest), confirmed through the voice-clone 18+ box, site staff, and the pads' owner. Through every gated
// surface, at route level: the pad page (live tail, topic, count, the live-room posts, the mic-challenge card),
// /api/rooms/<slug>/live, room audio (MP3 + WebRTC ticket), cam snapshots, the live-room APIs (quotes, mic clips, the DJ
// panel, the Pepe menu, relay lines, voice clips, mic challenges) in any letter case - behind padaccess's gate AND on
// their own -, Generate's "who's on cam", the homepage (live widget, 🎧 listen, now-playing, Top Pads counts),
// bridge.summary / the /p cards (mic names, topic, counts), story strips + /api/stories, person stories, capture pages and
// files, analytics, the feeds (/feed, the pad's, /p/<pad>/quotes, profiles, Hop, search ids, crossposts), post pages and
// their files, DM cards, follower and @mention notices, Pepe's DM claim and Telegram's whois. With the switch OFF
// everything is exactly what it was (the 18+ flag changes no byte of those answers, for every viewer); ON, the gate's
// states. Plus: open streams ending when it starts applying (MP3 listeners, the long-poll, WebRTC readers, live cams),
// failing closed when the switch can't be read, the Approved rule before the 18+ one, the switch (owner only, same-origin,
// audited, persisted), the confirmation flow (CSRF rules, idempotent, next paths, its version), Creators keeping its own
// confirmation, and merges / exports of the columns.
//   NODE_PATH=G:/PATV/node_modules node --test test/adult-gate.test.js      (temp DB, temp media dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adultgate-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
fs.mkdirSync(process.env.FEED_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
require(path.join(repo, "terms"))._setRequired(false);
const PA = require(path.join(repo, "padaccess"));
const AG = require(path.join(repo, "adultgate"));
const bridge = require(path.join(repo, "bridge"));
const stories = require(path.join(repo, "stories"));
const home = require(path.join(repo, "home"));

// ── the pads ──
const PADS = {
  pubx: { id: "pubx.Room", slug: "pubx-room", title: "Night Pond", level: "public", adult: true, chat: "CHAT-night-pond", topic: "TOPIC-night" },
  memx: { id: "memx.Room", slug: "memx-room", title: "Late Lounge", level: "members", adult: true, chat: "CHAT-late-lounge", topic: "TOPIC-late" },
  plain: { id: "plain.Room", slug: "plain-room", title: "Day Pond", level: "public", adult: false, chat: "CHAT-day-pond", topic: "TOPIC-day" },
};
const KEYS = Object.keys(PADS);
const CAPS = {};
const POSTS = {};                                 // k -> {normal, quote, voice, capture: {id, title}, file}
const LIVE_KINDS = ["quote", "voice", "capture"];
let XPOST = null;                                 // a crosspost of pubx's chat quote, in the plain pad

// ── the viewers ──
const VIEWERS = ["anon", "unconfirmed", "confirmed", "creator", "voice", "staff", "owner"];
const users = new Map();
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const who = (v) => (v === "anon" ? null : U[v]);
// what the gate should answer with the switch ON (OFF: "ok" for everyone)
const gateOf = (k, v) => (!PADS[k].adult ? "ok" : v === "anon" ? "signin" : v === "unconfirmed" ? "confirm" : "ok");
const levelFull = (k, v) => (PADS[k].level === "public" ? true : v !== "anon");
const fullOn = (k, v) => gateOf(k, v) === "ok" && levelFull(k, v);

let base, server, app;
const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, headers, at = base) {
  const r = await fetch(at + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, r };
}
const get = (url, u) => call("GET", url, u);
const post = (url, u, body, headers) => call("POST", url, u, body, headers);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "ag-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });
// the room snapshot Pepe syncs: cams, the web relay and the mic relay on; Alice on cam and on the mic
const snapOf = (P, extra = {}) => ({ room: { id: P.id, name: P.id }, topic: P.topic, count: 5, cams: true, relay: true, mic_relay: true, ...extra,
  members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, { id: "alicecf", login: "alicecf", display: "Alice", on_cam: true },
            { id: "strangercf", login: "strangercf", display: "Stranger" }],
  mic: [{ id: "alicecf", login: "alicecf", display: "Alice" }] });
async function setSwitch(on) {
  // the switch the way the card sets it (the owner, same-origin fetch) - every flip is an audited write
  const r = await post("/api/admin/adultgate", U.boss, { enabled: on, reason: "test" }, H(U.boss, { origin: base }));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.enabled, on);
  assert.equal(AG.enabled(), on);
}
// the /p page's cards (each one link) for a pad
function cardsOf(html, slug) {
  const out = [], needle = 'href="/p/' + slug + '"';
  for (let i = html.indexOf(needle); i >= 0; i = html.indexOf(needle, i + 1)) out.push(html.slice(i, html.indexOf("</a>", i)));
  return out;
}
const titlesIn = (text, k) => Object.fromEntries(["normal", ...LIVE_KINDS].map((kind) => [kind, text.includes(POSTS[k][kind].title)]));

let webp;
async function mkPosts(k) {
  const P = PADS[k];
  const out = {};
  const create = async (kind, input = {}, deps = {}) => {
    const title = kind.toUpperCase() + "-" + k;
    const made = await store.create(U.alice.userId, { title, body: input.body || "about " + title, community: P.id, announce: [], attachments: input.attachments },
                                    { free: true, onBehalf: true, ...deps });
    return { id: made.id, title };
  };
  out.normal = await create("normal");
  // a chat quote (quotes.js) - its lines are the room's
  out.quote = await create("quote", { body: "QLINE-" + k }, { liveRoom: P.id });
  await runQuery("INSERT INTO feed_quotes (post_id, room_id, source, lines, logins, removed, created_by, created) VALUES (?, ?, 'web', ?, ' alicecf ', '[]', ?, ?)",
                 [out.quote.id, P.id, JSON.stringify([{ name: "Alice", text: "QLINE-" + k, login: "alicecf", ts: 1 }]), U.alice.userId, Date.now()]);
  // a mic clip (micclip.js) - the room's voice
  out.voice = await create("voice", {}, { liveRoom: P.id });
  await runQuery("INSERT INTO feed_voices (post_id, room_id, media_id, logins, by_login, created) VALUES (?, ?, ?, ' alicecf ', 'alicecf', ?)",
                 [out.voice.id, P.id, CAPS[k], Date.now()]);
  // a capture kept as a post (storykeep.js) - its picture is a feed file
  const att = crypto.randomBytes(12).toString("hex");
  const file = crypto.randomBytes(16).toString("hex") + ".webp";
  fs.mkdirSync(path.join(process.env.FEED_DIR, file.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(process.env.FEED_DIR, file.slice(0, 2), file), webp);
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, w, h, bytes, state, created, size_declared, received)
                  VALUES (?, ?, 'image', 'image/webp', ?, 8, 8, ?, 'ready', ?, ?, ?)`, [att, U.alice.userId, file, webp.length, Date.now(), webp.length, webp.length]);
  out.capture = await create("capture", { attachments: [att] }, { liveRoom: P.id });
  await runQuery("INSERT INTO story_posts (capture_id, post_id, room_id, author_id, posted_by, kind, source, created) VALUES (?, ?, ?, ?, ?, 'photo', 'cam', ?)",
                 [CAPS[k], out.capture.id, P.id, U.alice.userId, U.alice.userId, Date.now()]);
  out.file = file;
  POSTS[k] = out;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  // confirmations given through the two older mechanisms (creators.js age_attest, voiceclone.js voice_consents.attested_18)
  await runQuery("CREATE TABLE IF NOT EXISTS age_attest (user_id TEXT PRIMARY KEY, version TEXT NOT NULL, at INTEGER NOT NULL)");
  await runQuery("CREATE TABLE IF NOT EXISTS voice_consents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, login TEXT, status TEXT, attested_18 INTEGER, created INTEGER)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  const sharp = require("sharp");
  const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#a00" } }).jpeg().toBuffer();
  webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#0a0" } }).webp().toBuffer();
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.staff = await mkUser("helper", { class: "Staff" });
  U.unconfirmed = await mkUser("newbie", { camfrog: "newbiecf" });
  U.confirmed = await mkUser("grownup", { camfrog: "grownupcf" });
  U.creator = await mkUser("fan18");
  U.voice = await mkUser("voicer", { camfrog: "voicercf" });
  U.fresh = await mkUser("freshface");
  U.boss = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.admin = await mkUser("plainadmin", { class: "Admin" });
  U.alice = await mkUser("alice", { camfrog: "alicecf" });       // on cam in every room: her person story has the captures
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('pepe-bot', 'pepe', 'Pepe', 'x', 'pepefrog')");
  await rooms.init();
  await store.init();
  await require(path.join(repo, "storykeep")).init();
  await require(path.join(repo, "follows")).init();
  await require(path.join(repo, "challengepay")).init();
  await PA.init();                                  // + adultgate.init: the age_confirmed_at / _v columns, the switch
  await runQuery("UPDATE users SET age_confirmed_at = ?, age_confirmed_v = '2026-10-19' WHERE userId = ?", [Date.UTC(2026, 9, 1), U.confirmed.userId]);
  await runQuery("INSERT INTO age_attest (user_id, version, at) VALUES (?, '2026-10-11', 1)", [U.creator.userId]);
  await runQuery("INSERT INTO voice_consents (user_id, login, status, attested_18, created) VALUES (?, 'voicercf', 'expired', 1, 1)", [U.voice.userId]);
  await AG.load();
  // the owner of every pad; boss is a Pepe owner (the switch is his)
  await require(path.join(repo, "staffroles")).init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('bossfrog', 'owner', 1)");
  for (const k of KEYS) {
    const P = PADS[k];
    await rooms.addRoom(P.id, P.title, "test");
    await rooms.setOwner(P.id, "padowner", "test");
    if (P.level !== "members") await PA.setLevel(U.owner, await rooms.get(P.id), P.level);
    if (P.adult) await rooms.setPage(P.id, { adult: true }, "test");
    // a capture (a clip with its poster)
    const cap = "ad0be" + String(KEYS.indexOf(k)).padStart(3, "0") + "a1b2c3d4";
    const t = Date.now() - 5 * 60e3;
    await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon)
                    VALUES (?, 'clip', 'video/mp4', ?, 10, 5, 'alicecf', 'pepefan', ?, ?, ?, 0, 0)`, [cap, cap + ".mp4", P.id, t, t + 24 * 3600e3]);
    fs.writeFileSync(path.join(process.env.MEDIA_DIR, cap + ".mp4"), jpg);
    fs.writeFileSync(path.join(process.env.MEDIA_DIR, cap + "_p.webp"), jpg);
    CAPS[k] = cap;
    // the live Camfrog room
    await bridge.ingest({ events: [ev({ id: P.id, name: P.id }, "message", { user: { id: "alicecf", login: "alicecf", display: "Alice" }, text: P.chat })], rooms: [snapOf(P)] });
    // a mic-challenge result (challengepay.js: who was on the room's mic)
    await runQuery("INSERT INTO challenge_runs (ref, room_id, ts, cat, mode, name, score) VALUES (?, ?, ?, 'sing', 'solo', ?, 8.5)", ["ref-" + k, P.id, Date.now(), "CHAL-" + k]);
    await mkPosts(k);
  }
  // a crosspost of the Public 18+ pad's chat quote, made in the plain pad
  XPOST = "XPostPubx0001";
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created, crosspost_of, home_pad, global) VALUES (?, ?, 'XPOST-plain', NULL, ?, ?, ?, 0)",
                 [XPOST, U.admin.userId, Date.now(), POSTS.pubx.quote.id, PADS.plain.id]);
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created) VALUES (?, ?, ?)", [XPOST, PADS.plain.id, Date.now()]);
  assert.ok(rooms.getCached(PADS.pubx.id).adult && rooms.getCached(PADS.memx.id).adult && !rooms.getCached(PADS.plain.id).adult);
  await rooms.setFront(PADS.pubx.id, "test");       // the homepage features the Public 18+ pad
  app = express();
  app.use((req, res, next) => (req.path === "/api/roomstats/sync" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  const isBotToken = (t) => t === "bot";
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; req.flash = () => []; next(); });
  require(path.join(repo, "cosmetics")).locals(app);            // the page helpers index.js installs (cosmeticName, ul, boostMark)
  require(path.join(repo, "userlinks")).install(app);
  require(path.join(repo, "boostmark")).install(app);
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  AG.register(app, { addUser });
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken });
  stories.register(app, { addUser });
  require(path.join(repo, "media")).register(app, { addUser, isBotToken, noTimers: true });
  require(path.join(repo, "mainstage")).register(app, { addUser, isBotToken, noTimers: true });
  require(path.join(repo, "roomstats")).register(app, { addUser, isBotToken });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  require(path.join(repo, "aigen")).register(app, { addUser, isBotToken, noTimers: true });
  bridge.register(app, { addUser, isBotToken });
  require(path.join(repo, "roomdj")).register(app, { addUser, isBotToken });
  home.register(app, { addUser, xpForNextLevel: () => 100 });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  // analytics for every pad (Pepe's sync)
  const day = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
  const days = {};
  for (let i = 0; i < 10; i++) days[day(i)] = { m: 100, s: 600, k: 7, u: 12, c: 9, n: 0 };
  const r = await fetch(base + "/api/roomstats/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    password: "bot", tz: "UTC", days: 90, rooms: KEYS.map((k) => ({ room: PADS[k].id, name: PADS[k].id, first: 1780000000, last: Math.floor(Date.now() / 1000) - 60,
      days, how: Array(168).fill(1), hows: Array(168).fill(1), size: { typical: 4, peak: 9, src: "roster" }, uniq: { d30: 5, d90: 9 },
      knowledge: { summary: "ANALYTICS-" + k + " talk", topics: [{ t: "topic" + k, w: 3 }], at: Math.floor(Date.now() / 1000) } })) }) });
  assert.equal(r.status, 200);
});
test.after(() => { if (server) server.close(); });

// CL3 (cl-site, rebased onto the 18+ gate): /live's chat-history block carries the clock - `now` and the time floors (each
// "now minus the pad's window") - and the signed join cursor `jc` its second, so two answers a moment apart differ there; which
// floors it carries, and that a cursor is there, still count. Its capability flags (HIST_CAN) are the one deliberate difference:
// chat history applies the 18+ rule WHATEVER the gate's switch says (adultgate.js's header; chatlog spec §3.2) - they are
// compared on their own (histCan) by the OFF test below.
const HIST_CAN = ["deep", "scroll", "search_ok", "find", "dl", "dl_full", "dl_signin", "signin"];
function liveStable(d) {
  if (!d || typeof d !== "object") return d;
  const out = { ...d };
  if (typeof out.jc === "string") out.jc = /^j1\./.test(out.jc) ? "j1" : out.jc;
  if (!out.history || typeof out.history !== "object") return out;
  const h = { ...out.history };
  delete h.now;
  if (h.floor && typeof h.floor === "object") h.floor = Object.keys(h.floor).sort();
  for (const k of HIST_CAN) delete h[k];
  out.history = h;
  return out;
}
function histCan(d) {
  if (!d || !d.history || typeof d.history !== "object") return null;
  const o = {};
  for (const k of HIST_CAN) if (k in d.history) o[k] = d.history[k];
  return o;
}

// what the gated surfaces answer one viewer about one pad (the volatile bits left out)
async function surfaces(k, u) {
  const P = PADS[k];
  const live = await get("/api/rooms/" + P.slug + "/live", u);
  const np = await get("/api/home/nowplaying?ids=" + encodeURIComponent(P.id), u);
  const sum = (await bridge.summary(!!u, u)).find((r) => r.id === P.id);
  const circle = (await stories.forViewer(u)).find((x) => x.id === P.id) || null;
  const media = [];
  for (const sub of ["", "/raw", "/poster"]) media.push((await get("/media/" + CAPS[k] + sub, u)).status);
  const chal = await get("/api/rooms/" + P.slug + "/challenges", u);
  const cams = u ? await get("/api/feed/aigen/cams?pad=" + encodeURIComponent(P.id), u) : null;
  const mixed = [];
  for (const [m, p, b] of [["POST", "/QUOTE", { cs: [] }], ["POST", "/MicClip", { tx: "x" }], ["GET", "/DJ"], ["POST", "/Pepe", { action: "look", target: "alicecf" }], ["GET", "/Challenges"]]) {
    const x = await call(m, "/api/rooms/" + P.slug + p, u, b);
    mixed.push([p, x.status, x.d && x.d.gate]);
  }
  const page = await get("/p/" + P.slug, u);
  const quotes = await get("/p/" + P.slug + "/quotes", u);
  const card = (await require(path.join(repo, "roomsweb")).guideRows(!!u, u)).rows.find((x) => x.id === P.id);
  const listed = (await store.list({ author: U.alice.userId, viewer: u, limit: 100 })).posts.map((p) => p.title).filter((t) => t.endsWith("-" + k)).sort();
  require(path.join(repo, "dmembeds"))._clear();
  return { live: { status: live.status, d: liveStable(live.d) }, histCan: histCan(live.d), np: np.d, sum: sum ? { mic: sum.mic, topic: sum.topic, count: sum.count, micCount: sum.micCount } : null,
           circle: circle ? JSON.parse(JSON.stringify(circle)) : null, media,
           audio: (await get("/p/" + P.slug + "/audio", u)).status, full: PA.full(u, P.id), gate: PA.adultGate(u, P.id),
           chal: { status: chal.status, d: chal.d }, cams: cams ? { status: cams.status, d: cams.d } : null, mixed,
           page: { status: page.status, titles: titlesIn(page.text, k), card: /data-adult-gate/.test(page.text), chal: page.text.includes('id="challenges"'),
                   count: page.text.includes('id="rmCount"') },
           quotes: { status: quotes.status, has: quotes.text.includes(POSTS[k].quote.title) },
           postPage: (await get("/feed/p/" + POSTS[k].quote.id, u)).status, file: (await get("/media/f/" + POSTS[k].file, u)).status,
           guide: { count: card.count, micCount: card.micCount, topic: card.topic }, listed,
           dm: (await require(path.join(repo, "dmembeds")).card(POSTS[k].quote.id)).unavailable,
           seen: await store.postSeenBy(u, await store.getRow(POSTS[k].quote.id)) };
}

// ─────────────────────────── OFF (the default) ───────────────────────────
test("OFF by default: no row, the gate answers ok for everyone, full() is exactly the access level", async () => {
  assert.equal(AG.enabled(), false);
  assert.equal(AG.unknown(), false, "the switch was read");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM adult_gate_cfg"))[0].n, 0, "nothing written until an owner flips it");
  for (const k of KEYS) {
    for (const v of VIEWERS) {
      assert.equal(PA.adultGate(who(v), PADS[k].id), "ok", `${k}/${v}`);
      assert.equal(PA.full(who(v), PADS[k].id), levelFull(k, v), `${k}/${v}: full() = the level only`);
    }
  }
  assert.deepEqual(AG.gatedRooms(null), [], "no pad is gated for anyone");
});

test("OFF: marking a pad 18+ changes no byte of what its surfaces answer - every viewer, every surface (live API, audio, posts, counts, APIs in any case)", async () => {
  for (const v of ["anon", "unconfirmed", "confirmed", "staff", "owner"]) {
    const on18 = await surfaces("pubx", who(v));
    await rooms.setPage(PADS.pubx.id, { adult: false }, "test");
    let off18;
    try { off18 = await surfaces("pubx", who(v)); } finally { await rooms.setPage(PADS.pubx.id, { adult: true }, "test"); }
    const { histCan: canOn, ...restOn } = on18, { histCan: canOff, ...restOff } = off18;
    assert.deepEqual(restOn, restOff, v + ": identical with and without the 18+ flag while the switch is off");
    // CL3: chat history (deep links, scrollback, search, downloads) on an 18+ pad needs a signed-in, age-confirmed viewer even
    // with the switch off (adultgate.confirmed - any mechanism); a viewer it lets in sees exactly what they see on a non-18+ pad
    assert.ok(canOn && canOff, v + ": the live answer has the chat-history block");
    const okAge = !!who(v) && (await AG.confirmed(who(v).userId));
    if (okAge || !who(v)) assert.deepEqual(canOn, canOff, v + ": chat history the same with and without the flag");
    else {
      assert.equal(canOn.deep, false, v + ": no history on the 18+ pad without the age confirmation");
      assert.equal(canOn.search_ok, false, v + ": no search either");
      assert.equal(canOn.dl, false, v + ": no download either");
      assert.equal(canOff.deep, true, v + ": the same pad without the flag: their history as before");
    }
    assert.equal(on18.live.status, 200, v + ": the Public pad's live room is open, as today");
    assert.ok(on18.live.d.feed.some((x) => x.text === PADS.pubx.chat));
    assert.equal(on18.sum.mic.length, 1, v + ": mic names, as today");
    assert.equal(on18.sum.count, 5, v + ": the headcount");
    assert.ok(on18.circle && on18.circle.items && on18.circle.items.length, v + ": story pictures, as today");
    assert.deepEqual(on18.media, [200, 200, 200]);
    assert.equal(on18.chal.status, 200); assert.equal(on18.chal.d.runs[0].name, "CHAL-pubx", v + ": mic-challenge results");
    if (on18.cams) { assert.equal(on18.cams.status, 200); assert.deepEqual(on18.cams.d.cams.map((c) => c.login), ["alicecf"], v + ": who's on cam"); }
    for (const [p, , g] of on18.mixed) assert.equal(g, undefined, v + " " + p + ": never the gate's answer");
    assert.deepEqual(on18.page.titles, { normal: true, quote: true, voice: true, capture: true }, v + ": every post on the pad page");
    assert.equal(on18.page.card, false); assert.equal(on18.page.chal, true); assert.equal(on18.page.count, true);
    assert.equal(on18.quotes.has, true);
    assert.equal(on18.postPage, 301, v + ": the quote's page (-> its canonical address)");
    assert.equal(on18.file, 200, v + ": the kept capture's file");
    assert.equal(on18.guide.count, 5);
    assert.deepEqual(on18.listed, ["CAPTURE-pubx", "NORMAL-pubx", "QUOTE-pubx", "VOICE-pubx"]);
    assert.equal(on18.dm, false, v + ": a DM card of it");
    assert.equal(on18.seen, true);
  }
});

test("OFF: the pages - pad page, homepage widget, analytics, the live-room APIs, sending into the room - look as they always did", async () => {
  for (const v of ["anon", "unconfirmed", "confirmed"]) {
    const u = who(v);
    for (const k of KEYS) {
      const P = PADS[k], fu = levelFull(k, v);
      const r = await get("/p/" + P.slug, u);
      assert.equal(r.status, 200);
      assert.doesNotMatch(r.text, /data-adult-gate/, `${k}/${v}: no 18+ card`);
      assert.equal(r.text.includes('id="rmFeed"'), fu, `${k}/${v}: the live chat panel`);
      assert.equal(r.text.includes(P.topic), fu, `${k}/${v}: topic`);
      assert.match(r.text, /id="rmCount"/, `${k}/${v}: the room's headcount`);
      assert.match(r.text, /id="challenges"/, `${k}/${v}: the mic-challenge card`);
      const an = await get("/p/" + P.slug + "/analytics", u);
      assert.equal(an.text.includes("ANALYTICS-" + k), fu, `${k}/${v}: analytics`);
      // the gate never answers for a live-room API (dj: roomdj's own sign-in rule; quote: quotes.js's own checks)
      for (const [m, p, b] of [["GET", "/dj"], ["POST", "/quote", { cs: [] }], ["POST", "/say", { text: "hello from " + v }], ["GET", "/challenges"]]) {
        const x = await call(m, "/api/rooms/" + P.slug + p, u, b);
        assert.equal(x.d && x.d.gate, undefined, `${k}/${v}: ${p} not gated`);
      }
      if (u) assert.equal((await post("/api/rooms/" + P.slug + "/say", u, { text: "hi " + k })).status, 200, `${k}/${v}: a relay line goes out, as today`);
    }
    const h = await get("/", u);
    assert.equal(h.status, 200);
    assert.doesNotMatch(h.text, /data-adult-gate/, v + ": no 18+ card on the homepage");
    assert.match(h.text, /id="lrInit"/, v + ": the live widget (the front pad is Public)");
    assert.ok(h.text.includes(PADS.pubx.chat), v + ": its chat line rendered in");
    const feed = await get("/feed", u);
    for (const k of KEYS) assert.deepEqual(titlesIn(feed.text, k), { normal: true, quote: true, voice: true, capture: true }, v + ": /feed " + k);
  }
});

// ─────────────────────────── the switch ───────────────────────────
test("the switch: on /pads/admin#adult, readable by pads admins, changed only by an owner, same-origin JSON, audited, persisted", async () => {
  // the card: staff see it read-only; the owner gets the form; the nav links to it
  let r = await get("/pads/admin", U.staff);
  assert.equal(r.status, 200);
  assert.match(r.text, /id="adult"/);
  assert.match(r.text, /owners change this/);
  assert.match(r.text, /<fieldset disabled/);
  assert.match(r.text, /href="#adult"/);
  assert.match(r.text, /Now: <b id="agNow">OFF<\/b>/);
  assert.doesNotMatch(r.text, /id="agLoadErr"/);
  r = await get("/pads/admin", U.boss);
  assert.match(r.text, /id="agForm"/);
  assert.doesNotMatch(r.text, /owners change this/);
  assert.match(r.text, /<button type="submit" class="btn primary">Save<\/button>/);
  // the API
  assert.equal((await get("/api/admin/adultgate", null)).status, 401);
  assert.equal((await get("/api/admin/adultgate", U.unconfirmed)).status, 403);
  r = await get("/api/admin/adultgate", U.staff);
  assert.equal(r.status, 200);
  assert.equal(r.d.enabled, false); assert.equal(r.d.can_edit, false); assert.equal(r.d.adult_pads, 2); assert.equal(r.d.loaded, true); assert.equal(r.d.load_error, null);
  assert.equal((await get("/api/admin/adultgate", U.boss)).d.can_edit, true);
  const ok = H(U.boss, { origin: base });
  assert.equal((await post("/api/admin/adultgate", U.staff, { enabled: true }, H(U.staff, { origin: base }))).status, 403, "staff: not an owner");
  assert.equal((await post("/api/admin/adultgate", U.admin, { enabled: true }, H(U.admin, { origin: base }))).status, 403, "an Admin without Pepe's owner role");
  assert.equal((await post("/api/admin/adultgate", U.boss, { enabled: true }, { "content-type": "application/json", "x-test-user": U.boss.userId, origin: base })).status, 403, "no X-Requested-With");
  assert.equal((await post("/api/admin/adultgate", U.boss, { enabled: true }, H(U.boss))).status, 403, "no Origin / Referer");
  assert.equal((await post("/api/admin/adultgate", U.boss, { enabled: true }, H(U.boss, { origin: "https://evil.example" }))).status, 403, "cross-site");
  assert.equal((await post("/api/admin/adultgate", U.boss, { enabled: "yes" }, ok)).status, 400, "a boolean only");
  assert.equal(AG.enabled(), false, "nothing changed");
  // on, then reloaded from the database: it stays on
  r = await post("/api/admin/adultgate", U.boss, { enabled: true, reason: "legal asked" }, ok);
  assert.equal(r.status, 200); assert.equal(r.d.enabled, true); assert.equal(r.d.by, "boss");
  const row = (await getQuery("SELECT value, by FROM adult_gate_cfg WHERE key = 'enabled'"))[0];
  assert.deepEqual({ ...row }, { value: "1", by: "boss" });
  const au = await getQuery("SELECT admin_id, admin_name, detail, reason FROM admin_audit WHERE action = 'adult-gate' ORDER BY id");
  assert.equal(au.length, 1);
  assert.equal(au[0].admin_id, U.boss.userId);
  assert.deepEqual(JSON.parse(au[0].detail), { from: false, to: true });
  assert.equal(au[0].reason, "legal asked");
  AG._reset();
  await AG.init();
  assert.equal(AG.enabled(), true, "persisted");
  assert.equal(AG.confirmedSync(U.confirmed.userId), true, "the confirmed accounts load again");
  // the same value again writes nothing
  await post("/api/admin/adultgate", U.boss, { enabled: true }, ok);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'adult-gate'"))[0].n, 1, "no change, no audit row");
  r = await get("/pads/admin", U.staff);
  assert.match(r.text, /Now: <b id="agNow">ON<\/b>/);
  assert.match(r.text, /legal asked/, "the change log");
  await setSwitch(false);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'adult-gate'"))[0].n, 2);
});

// ─────────────────────────── ON: the matrix ───────────────────────────
for (const k of KEYS) {
  for (const v of VIEWERS) {
    test(`ON: ${k} pad × ${v}`, async () => {
      await setSwitch(true);
      try {
        const P = PADS[k], u = who(v), g = gateOf(k, v), fu = fullOn(k, v), tag = `${k}/${v}`;
        const gated = g !== "ok";
        assert.equal(PA.adultGate(u, P.id), g, tag + " adultGate");
        assert.equal(PA.full(u, P.id), fu, tag + " full()");
        assert.equal(await PA.fullFor(u ? u.userId : null, P.id), fu, tag + " fullFor (WebRTC room audio, live cams)");
        assert.equal(await PA.adultGateFor(u ? u.userId : null, P.id), g, tag + " adultGateFor (open streams)");
        // the pad page
        let r = await get("/p/" + P.slug, u);
        const page = r.text;
        assert.equal(r.status, 200, tag + " the page itself stays");
        assert.ok(page.includes(P.title));
        if (gated) {
          assert.match(page, new RegExp(`data-adult-gate="${g}"`), tag + " the 18+ card");
          const conf = "/confirm-age?next=" + encodeURIComponent("/p/" + P.slug);
          assert.ok(page.includes('href="' + (g === "confirm" ? conf : "/login?next=" + encodeURIComponent(conf)) + '"'), tag + " its link (sign in leads on to the confirmation)");
          assert.ok(!page.includes(P.chat) && !page.includes(P.topic), tag + " no line, no topic");
          assert.ok(!page.includes('id="rmCount"') && !page.includes('id="rmFeed"') && !page.includes('id="rmInit"'), tag + " no headcount, no chat panel, no initial data");
          assert.ok(!page.includes("Stranger"), tag + " no names");
          assert.ok(!page.includes('id="challenges"') && !page.includes("pad-challenges.js"), tag + " no mic-challenge card");
          assert.match(r.r.headers.get("cache-control") || "", /no-store/);
        } else {
          assert.doesNotMatch(page, /data-adult-gate/, tag);
          assert.equal(page.includes('id="rmFeed"'), fu, tag + " chat panel");
          assert.equal(page.includes(P.topic), fu, tag + " topic");
          assert.ok(page.includes('id="challenges"'), tag + " the mic-challenge card");
        }
        // its posts: the ordinary one stays; the ones made from the live room follow the gate
        assert.deepEqual(titlesIn(page, k), { normal: true, quote: !gated, voice: !gated, capture: !gated }, tag + " the pad page's posts");
        r = await get("/p/" + P.slug + "/quotes", u);
        assert.equal(r.text.includes(POSTS[k].quote.title), !gated, tag + " /p/<pad>/quotes");
        r = await get("/feed/p/" + POSTS[k].quote.id, u);
        if (gated) {
          assert.equal(r.status, g === "signin" ? 401 : 403, tag + " the quote's page: the 18+ card");
          assert.match(r.text, new RegExp(`data-adult-gate="${g}"`));
          assert.ok(!r.text.includes(POSTS[k].quote.title) && !r.text.includes("QLINE-" + k) && !r.text.includes("Alice"), tag + " no title, line or name");
          assert.match(r.r.headers.get("cache-control") || "", /no-store/);
        } else assert.equal(r.status, 301, tag + " the quote's page");
        for (const kind of ["voice", "capture"]) assert.equal((await get("/feed/p/" + POSTS[k][kind].id, u)).status, gated ? (g === "signin" ? 401 : 403) : 301, tag + " " + kind + " page");
        r = await get("/media/f/" + POSTS[k].file, u);
        assert.equal(r.status, gated ? 404 : 200, tag + " the kept capture's file");
        if (P.adult && !gated) assert.match(r.r.headers.get("cache-control") || "", /private/, tag + " never cached in between while the gate applies");
        const listed = (await store.list({ author: U.alice.userId, viewer: u, limit: 100 })).posts.map((p) => p.title);
        for (const kind of LIVE_KINDS) assert.equal(listed.includes(POSTS[k][kind].title), !gated, tag + " profile list: " + kind);
        // the live API
        r = await get("/api/rooms/" + P.slug + "/live", u);
        if (gated) {
          assert.equal(r.status, g === "signin" ? 401 : 403, tag + " live API refused");
          assert.equal(r.d.gate, g); assert.equal(r.d.adult, true);
          const conf = "/confirm-age?next=" + encodeURIComponent("/p/" + P.slug);
          assert.equal(r.d[g === "confirm" ? "confirm" : "signin"], g === "confirm" ? conf : "/login?next=" + encodeURIComponent(conf));
          assert.ok(!r.text.includes(P.chat) && !r.text.includes("Alice") && !/count|members|feed/.test(Object.keys(r.d).join(",")), tag + " no lines, names or counts");
        } else if (fu) { assert.equal(r.status, 200, tag); assert.ok(r.d.feed.some((x) => x.text === P.chat)); }
        else assert.equal(r.status, u ? 403 : 401, tag + " the level's own refusal");
        // room audio: MP3 relay + the WebRTC ticket
        r = await get("/p/" + P.slug + "/audio", u);
        assert.equal(r.status, fu ? 404 : (u ? 403 : 401), tag + " audio (allowed: 404 = the relay is off here)");
        if (g === "confirm") assert.match(r.text, /Confirm you're 18 or older to listen/);
        r = await post("/api/rooms/" + P.slug + "/audio/rtc", u, {});
        if (gated) { assert.equal(r.status, g === "signin" ? 401 : 403); assert.equal(r.d.gate, g); }
        else assert.ok(r.status === 404 || (!u && !fu), tag + " rtc: allowed -> no-audio");
        // cams (bridge-relay padFull) and the live-room APIs behind padaccess's gate - in any letter case, sending included
        r = await get("/api/rooms/" + P.slug + "/snap/alicecf", u);
        if (gated) assert.equal(r.d.gate, g, tag + " snapshot");
        else assert.equal(r.d && r.d.gate, undefined, tag + " snapshot not gated");
        for (const [m, p, b] of [["POST", "/quote", { cs: [] }], ["POST", "/QUOTE", { cs: [] }], ["POST", "/micclip", { tx: "x" }], ["POST", "/MicClip", { tx: "x" }],
                                 ["GET", "/dj"], ["GET", "/DJ"], ["POST", "/pepe", { action: "look", target: "alicecf" }], ["POST", "/Pepe", { action: "look", target: "alicecf" }],
                                 ["GET", "/PEPE/job/nope"], ["GET", "/camclip/nope"], ["POST", "/say", { text: "hi" }], ["POST", "/SAY", { text: "!help" }],
                                 ["GET", "/Challenges"], ["GET", "/Live"]]) {
          r = await call(m, "/api/rooms/" + P.slug + p, u, b);
          if (gated) { assert.equal(r.status, g === "signin" ? 401 : 403, tag + " " + p); assert.equal(r.d.gate, g, tag + " " + p); }
          else assert.equal(r.d && r.d.gate, undefined, tag + " " + p + " not gated");
        }
        r = await fetch(base + "/api/rooms/" + P.slug + "/clip", { method: "POST", body: Buffer.alloc(600, 1),
          headers: Object.assign({ "content-type": "audio/webm", "x-clip-secs": "2" }, u ? { "x-test-user": u.userId } : {}) });
        const clip = await r.json().catch(() => ({}));
        if (gated) { assert.equal(r.status, g === "signin" ? 401 : 403, tag + " voice clip"); assert.equal(clip.gate, g); }
        else assert.equal(clip.gate, undefined, tag + " voice clip not gated");
        // mic-challenge results (who was on the room's mic)
        r = await get("/api/rooms/" + P.slug + "/challenges", u);
        if (gated) { assert.equal(r.status, g === "signin" ? 401 : 403, tag + " challenges"); assert.ok(!r.text.includes("CHAL-"), tag + " no names"); }
        else { assert.equal(r.status, 200); assert.equal(r.d.runs[0].name, "CHAL-" + k, tag + " challenges"); }
        // Generate's "📷 From a cam in this room" (aigen.js)
        if (u) {
          r = await get("/api/feed/aigen/cams?pad=" + encodeURIComponent(P.id), u);
          if (gated) { assert.equal(r.status, 403, tag + " cams"); assert.equal(r.d.gate, g); assert.ok(!r.text.includes("alicecf") && !r.text.includes("Alice"), tag + " no names"); }
          else { assert.equal(r.status, 200); assert.deepEqual(r.d.cams.map((c) => c.login), ["alicecf"], tag + " cams"); }
        }
        // analytics
        r = await get("/p/" + P.slug + "/analytics", u);
        assert.equal(r.text.includes("ANALYTICS-" + k), fu, tag + " analytics");
        // now playing, summary (mic names / topic for /p cards, /about, the homepage), the /p card's counts
        r = await get("/api/home/nowplaying?ids=" + encodeURIComponent(P.id), u);
        if (gated) assert.equal(r.d.np[P.id], null, tag + " no now-playing line");
        else assert.ok(r.d.np[P.id] === null || r.d.np[P.id].k, tag);
        const sum = (await bridge.summary(!!u, u)).find((x) => x.id === P.id);
        if (gated) { assert.deepEqual(sum.mic, [], tag + " no mic names"); assert.equal(sum.topic, "", tag + " no topic"); }
        else if (fu) assert.equal(sum.mic.length, 1, tag + " mic names");
        const card = (await require(path.join(repo, "roomsweb")).guideRows(!!u, u)).rows.find((x) => x.id === P.id);
        assert.equal(card.topic === P.topic, fu && !gated, tag + " /p card topic");
        assert.equal(card.count, gated ? null : 5, tag + " /p card headcount");
        assert.equal(card.micCount, gated ? null : 1, tag + " /p card mic count");
        r = await get("/p", u);
        assert.equal(r.status, 200);
        const cards = cardsOf(r.text, P.slug);
        assert.ok(cards.length > 0, tag + " the pad is on /p");
        if (gated) assert.ok(cards.every((c) => !c.includes("👥") && !c.includes("🎙 1") && !c.includes(P.topic)), tag + " /p: no headcount, mic count or topic on its card");
        else assert.ok(cards.some((c) => c.includes("👥 5")), tag + " /p: its headcount");
        // stories: the strip, /api/stories, a person's story
        const circle = (await stories.forViewer(u)).find((x) => x.id === P.id);
        if (gated) assert.equal(circle, undefined, tag + " no circle, no count");
        else { assert.ok(circle, tag + " circle"); assert.equal(Array.isArray(circle.items) && circle.items.length > 0, fu, tag + " pictures"); }
        if (u) {
          r = await get("/api/stories?room=" + encodeURIComponent(P.id), u);
          assert.equal(r.d.rooms.length > 0, !gated, tag + " /api/stories");
        }
        const US = require(path.join(repo, "userstories"));
        const caps = (await US.people(u, [U.alice.userId])).flatMap((x) => (x.items || []).map((i) => i.id));
        if (gated) assert.ok(!caps.includes(CAPS[k]), tag + " a person's story leaves the capture out");
        else if (u) assert.ok(caps.includes(CAPS[k]), tag + " a person's story has it");
        // capture page + files
        r = await get("/media/" + CAPS[k], u);
        if (gated) {
          assert.equal(r.status, g === "signin" ? 401 : 403, tag + " capture page");
          assert.match(r.text, new RegExp(`data-adult-gate="${g}"`));
          assert.ok(!r.text.includes("/media/" + CAPS[k] + "/raw") && !r.text.includes("alicecf"), tag + " no file, no names");
        } else assert.equal(r.status, 200, tag + " capture page");
        for (const sub of ["/raw", "/poster"]) assert.equal((await get("/media/" + CAPS[k] + sub, u)).status, gated ? 404 : 200, tag + " " + sub);
      } finally { await setSwitch(false); }
    });
  }
}

test("ON: the feeds - /feed, Hop, search hits, a crosspost in another pad, votes, DM cards - leave an 18+ pad's live-room posts out past its gate", async () => {
  const D = require(path.join(repo, "dmembeds"));
  const all = KEYS.flatMap((k) => ["normal", ...LIVE_KINDS].map((kind) => POSTS[k][kind].id)).concat([XPOST]);
  await setSwitch(true);
  try {
    for (const v of ["anon", "unconfirmed", "confirmed", "staff"]) {
      const u = who(v);
      const feed = await get("/feed", u);
      assert.equal(feed.status, 200);
      for (const k of KEYS) {
        const gated = gateOf(k, v) !== "ok";
        assert.deepEqual(titlesIn(feed.text, k), { normal: true, quote: !gated, voice: !gated, capture: !gated }, v + ": /feed " + k);
        const hop = (await store.list({ viewer: u, media: true, quotesToo: true, limit: 50, sfw: !u })).posts.map((p) => p.title);
        assert.equal(hop.includes(POSTS[k].quote.title), !gated, v + ": Hop " + k);
      }
      const hits = (await store.list({ viewer: u, ids: all, idsOnly: true, limit: 50 })).ids;
      const pubGated = gateOf("pubx", v) !== "ok";
      assert.equal(hits.includes(POSTS.pubx.quote.id), !pubGated, v + ": a search hit");
      assert.equal(hits.includes(POSTS.plain.quote.id), true, v + ": the plain pad's quote");
      // the crosspost lives in the plain pad but carries the 18+ pad's lines
      const plain = (await store.list({ room: PADS.plain.id, viewer: u, limit: 50 })).posts.map((p) => p.id);
      assert.equal(plain.includes(XPOST), !pubGated, v + ": the crosspost in the plain pad");
      const xp = await get("/feed/p/" + XPOST, u);
      assert.equal(xp.status, pubGated ? (u ? 403 : 401) : 301, v + ": the crosspost's page");
      assert.equal(await store.postSeenBy(u, await store.getRow(POSTS.pubx.voice.id)), !pubGated, v + ": postSeenBy");
      if (u && pubGated) await assert.rejects(store.vote(u, POSTS.pubx.quote.id, 1), /No such post/, v + ": no vote on it");
    }
    D._clear();
    assert.equal((await D.card(POSTS.pubx.quote.id)).unavailable, true, "a DM card of it: unavailable (a card is the same for everyone)");
    assert.equal((await D.card(POSTS.plain.quote.id)).unavailable, false);
  } finally { await setSwitch(false); D._clear(); }
  assert.equal((await D.card(POSTS.pubx.quote.id)).unavailable, false, "off again: the card is back");
});

test("ON: notices - a live-room post of an 18+ pad isn't announced (follower notice, @mention) to members its gate stops", async () => {
  const P = PADS.pubx;
  for (const u of [U.unconfirmed, U.confirmed]) {
    await runQuery("INSERT OR IGNORE INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'room', ?, 1)", [u.userId, P.id]);
    await runQuery("INSERT OR REPLACE INTO follow_prefs (user_id, notify_posts, updated) VALUES (?, 1, 1)", [u.userId]);
  }
  const inbox = async (u, kind) => (await getQuery("SELECT title, body FROM inbox WHERE user_id = ? AND kind = ?", [u.userId, kind]));
  await setSwitch(true);
  try {
    const made = await store.create(U.alice.userId, { title: "NOTICE-quote", body: "NOTICELINE @newbie @grownup", community: P.id, announce: [] },
                                    { free: true, onBehalf: true, liveRoom: P.id, awaitNotices: true });
    await runQuery("INSERT INTO feed_quotes (post_id, room_id, source, lines, logins, removed, created_by, created) VALUES (?, ?, 'chat', '[]', '', '[]', ?, ?)",
                   [made.id, P.id, U.alice.userId, Date.now()]);
    assert.equal((await inbox(U.unconfirmed, "follow")).length, 0, "no follower notice for the unconfirmed follower");
    assert.equal((await inbox(U.unconfirmed, "mention")).length, 0, "no @mention notice either");
    assert.equal((await inbox(U.confirmed, "follow")).length, 1, "the confirmed follower is told");
    assert.equal((await inbox(U.confirmed, "mention")).length, 1, "and mentioned");
  } finally { await setSwitch(false); }
  // off: both are told, as today
  await store.create(U.alice.userId, { title: "NOTICE-off", body: "OFFLINE @newbie", community: P.id, announce: [] }, { free: true, onBehalf: true, liveRoom: P.id, awaitNotices: true });
  assert.equal((await inbox(U.unconfirmed, "follow")).length, 1, "off: the follower notice");
  assert.equal((await inbox(U.unconfirmed, "mention")).length, 1, "off: the mention");
});

test("ON: the live-room handlers refuse on their own - no padaccess gate in front of them (slug lookups that differ can't slip past)", async () => {
  const app2 = express();
  app2.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  const isBotToken = (t) => t === "bot";
  const opts = { addUser, isBotToken, bySlug: bridge.bySlug, isLive: bridge.isLiveShown };
  require(path.join(repo, "quotes")).register(app2, opts);
  require(path.join(repo, "micclip")).register(app2, opts);
  require(path.join(repo, "padpepe")).register(app2, opts);
  require(path.join(repo, "bridge-relay")).register(app2, { ...opts, gated: () => false, liveIds: () => new Set() });
  require(path.join(repo, "challengepay")).register(app2, opts);
  require(path.join(repo, "roomdj")).register(app2, opts);
  const s2 = app2.listen(0);
  const b2 = "http://127.0.0.1:" + s2.address().port;
  await setSwitch(true);
  try {
    for (const [m, p, b] of [["POST", "/quote", { cs: [] }], ["POST", "/micclip", { tx: "tx-00000000" }], ["POST", "/pepe", { action: "look", target: "alicecf" }],
                             ["POST", "/say", { text: "hi" }], ["GET", "/challenges"], ["GET", "/dj"], ["POST", "/dj", { verb: "skip" }]]) {
      for (const slug of [PADS.pubx.slug, PADS.memx.slug]) {
        const r = await call(m, "/api/rooms/" + slug + p, U.unconfirmed, b, undefined, b2);
        assert.equal(r.status, 403, slug + p + ": " + r.text);
        assert.equal(r.d.gate, "confirm", slug + p);
      }
      const ok = await call(m, "/api/rooms/" + PADS.plain.slug + p, U.unconfirmed, b, undefined, b2);
      assert.equal(ok.d && ok.d.gate, undefined, "plain" + p);
    }
    // a quote's cursors are never looked at before the gate (the old "not in the feed" error listed which exist)
    const r = await call("POST", "/api/rooms/" + PADS.pubx.slug + "/quote", U.unconfirmed, { cs: [1, 2, 3] }, undefined, b2);
    assert.doesNotMatch(r.text, /feed/);
  } finally { await setSwitch(false); s2.close(); }
});

function openStream(url, u) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + url, { headers: u ? { "x-test-user": u.userId } : {} }, (res) => {
      const st = { status: res.statusCode, ended: false, req, res };
      res.on("data", () => {});
      res.on("end", () => { st.ended = true; });
      res.on("close", () => { st.ended = true; });
      resolve(st);
    });
    req.on("error", reject);
  });
}
test("ON (turned on while they're open): MP3 listeners, a waiting long-poll, WebRTC readers and live-cam viewers the gate stops are cut off", async () => {
  const P = PADS.pubx;
  await bridge.ingest({ rooms: [snapOf(P, { audio: true })] });
  const LC = require(path.join(repo, "livecam"));
  const RR = require(path.join(repo, "roomrtc"));
  const kicked = [];
  LC._setKick((id) => kicked.push(id));
  const sid = (n) => "00000000-0000-4000-8000-00000000000" + n;
  let anonAudio, okAudio;
  try {
    // OFF: everyone listens (a Public pad)
    anonAudio = await openStream("/p/" + P.slug + "/audio", null);
    okAudio = await openStream("/p/" + P.slug + "/audio", U.confirmed);
    assert.equal(anonAudio.status, 200); assert.equal(okAudio.status, 200);
    // a page waiting on the long-poll (signed out)
    const first = await get("/api/rooms/" + P.slug + "/live", null);
    assert.equal(first.status, 200);
    const waiting = get(`/api/rooms/${P.slug}/live?wait=1&after=${first.d.cursor}&v=${first.d.ver}`, null);
    // WebRTC readers MediaMTX lists for the room's path (the auth hook saw who each one is) + a live cam with two viewers
    RR._state.set(P.id, { wantUntil: 0, readers: 4, ready: true, seenAt: Date.now(), readerIds: [sid(1), sid(2), sid(3), sid(4)] });
    RR._readers.set(sid(1), { uid: null, roomId: P.id, at: Date.now() });
    RR._readers.set(sid(2), { uid: U.unconfirmed.userId, roomId: P.id, at: Date.now() });
    RR._readers.set(sid(3), { uid: U.confirmed.userId, roomId: P.id, at: Date.now() });     // sid(4): never seen by the hook
    const now = Date.now();
    LC._sessions.set("cam1", { key: "cam1", roomId: P.id, login: "alicecf", path: "x", ended: 0, wantUntil: now + 60e3, createdAt: now,
      viewers: new Map([[U.unconfirmed.userId, { since: now, beat: now, readers: new Set([sid(5)]) }], [U.confirmed.userId, { since: now, beat: now, readers: new Set([sid(6)]) }]]),
      stageViewers: new Map([[U.unconfirmed.userId, { since: now, beat: now, readers: new Set([sid(7)]) }]]) });
    await sleep(50);
    assert.equal(anonAudio.ended, false, "still streaming while off");
    await setSwitch(true);
    const lp = await waiting;
    assert.equal(lp.status, 401, "the waiting long-poll answers under the gate");
    assert.equal(lp.d.gate, "signin");
    assert.ok(!lp.text.includes(P.chat));
    for (let i = 0; i < 40 && !(anonAudio.ended && kicked.length >= 4); i++) await sleep(25);
    assert.equal(anonAudio.ended, true, "the signed-out MP3 listener is cut off");
    assert.equal(okAudio.ended, false, "the confirmed one keeps listening");
    assert.deepEqual(kicked.slice().sort(), [sid(1), sid(2), sid(4), sid(5), sid(7)].sort(), "WebRTC readers (signed out, unconfirmed, unknown) + the unconfirmed live-cam viewers are kicked");
    assert.ok(!LC._sessions.get("cam1").viewers.has(U.unconfirmed.userId) && LC._sessions.get("cam1").viewers.has(U.confirmed.userId));
    // the periodic re-check never kicks a confirmed reader, and leaves a reader the hook never saw alone
    kicked.length = 0;
    RR._state.get(P.id).readerIds = [sid(3), sid(8)];
    await RR.recheck("tick");
    assert.deepEqual(kicked, []);
    // a new MP3 request is refused
    assert.equal((await get("/p/" + P.slug + "/audio", null)).status, 401);
  } finally {
    try { okAudio && okAudio.req.destroy(); } catch (e) { /* closed */ }
    try { anonAudio && anonAudio.req.destroy(); } catch (e) { /* closed */ }
    await setSwitch(false);
    LC._sessions.delete("cam1"); RR._reset(); LC._setKick(() => {});
    await bridge.ingest({ rooms: [snapOf(P)] });
  }
});

test("ON: marking a pad 18+ (switch already on) cuts off its open MP3 listeners too", async () => {
  const P = PADS.plain;
  await bridge.ingest({ rooms: [snapOf(P, { audio: true })] });
  await setSwitch(true);
  let s;
  try {
    s = await openStream("/p/" + P.slug + "/audio", null);
    assert.equal(s.status, 200, "not 18+ yet");
    await rooms.setPage(P.id, { adult: true }, "test");
    for (let i = 0; i < 40 && !s.ended; i++) await sleep(25);
    assert.equal(s.ended, true);
  } finally {
    try { s && s.req.destroy(); } catch (e) { /* closed */ }
    await rooms.setPage(P.id, { adult: false }, "test");
    await setSwitch(false);
    await bridge.ingest({ rooms: [snapOf(P)] });
  }
});

test("fails CLOSED: while the switch can't be read, 18+ pads are gated as if it were on; the card says so; it recovers on its own", async () => {
  AG._reset();
  await runQuery("ALTER TABLE adult_gate_cfg RENAME TO adult_gate_cfg_hold");
  await runQuery("CREATE VIEW adult_gate_cfg AS SELECT 1 AS nope");
  try {
    await assert.rejects(AG.init(), "the load fails");
    assert.equal(AG.unknown(), true);
    assert.equal(PA.adultGate(null, PADS.pubx.id), "signin", "an 18+ pad: gated");
    assert.equal(PA.adultGate(U.unconfirmed, PADS.memx.id), "confirm");
    assert.equal(PA.adultGate(null, PADS.plain.id), "ok", "any other pad: as always");
    assert.equal(PA.full(null, PADS.pubx.id), false);
    const r = await get("/api/rooms/" + PADS.pubx.slug + "/live", null);
    assert.equal(r.status, 401); assert.equal(r.d.gate, "signin");
    assert.equal((await get("/api/rooms/" + PADS.plain.slug + "/live", null)).status, 200);
    const v = await AG.adminView(U.staff);
    assert.equal(v.loaded, false); assert.ok(v.load_error && /nope|value|no such column|already exists/i.test(v.load_error.message), JSON.stringify(v.load_error));
    assert.equal(v.can_edit, false, "no changes while it can't be read");
    assert.match((await get("/pads/admin", U.staff)).text, /id="agLoadErr"/, "the card says so");
  } finally {
    await runQuery("DROP VIEW adult_gate_cfg");
    await runQuery("ALTER TABLE adult_gate_cfg_hold RENAME TO adult_gate_cfg");
  }
  // a read retries it (throttled to once a second); here: the next init() call
  await AG.init();
  assert.equal(AG.unknown(), false);
  assert.equal(AG.enabled(), false, "off again, as stored");
  assert.equal(PA.adultGate(null, PADS.pubx.id), "ok");
});

test("a stage cam slot's name is blanked past the gate (padaccess.adultSlots); off: as is", async () => {
  const slots = [{ id: "s1", cam: true, room_id: PADS.pubx.id, display: "Alice", title: "📷 Alice" }, { id: "s2", room_id: PADS.pubx.id, display: "Streamer", title: "show" },
                 { id: "s3", cam: true, room_id: PADS.plain.id, display: "Bob", title: "📷 Bob" }];
  assert.deepEqual(PA.adultSlots(slots, null), slots, "off: untouched");
  await setSwitch(true);
  try {
    const out = PA.adultSlots(slots, null);
    assert.deepEqual([out[0].display, out[0].title], ["", null], "the 18+ pad's cam slot: no name");
    assert.deepEqual(out.slice(1), slots.slice(1), "a stream slot and another pad's cam: as is");
    assert.deepEqual(PA.adultSlots(slots, U.confirmed), slots, "confirmed: as is");
  } finally { await setSwitch(false); }
});

const roomOf = (P, audio) => snapOf(P, { audio });
test("ON: the homepage - the featured 18+ pad's widget is the 18+ card; 🎧 says why; now-playing and counts hidden; confirmed members get it all", async () => {
  await bridge.ingest({ rooms: [roomOf(PADS.pubx, true)] });      // its room audio on: the 🎧 button's reason is the gate's
  await setSwitch(true);
  try {
    for (const v of ["anon", "unconfirmed", "confirmed", "staff", "owner"]) {
      const u = who(v), g = gateOf("pubx", v);
      const h = await get("/", u);
      assert.equal(h.status, 200, v);
      const i = h.text.indexOf('data-listen="pubx-room"');
      assert.ok(i > 0, v + ": the 18+ pad is a Top Pad");
      const row = h.text.slice(h.text.lastIndexOf("<li>", i), h.text.indexOf("</li>", i));
      if (g === "ok") {
        assert.doesNotMatch(h.text, /data-adult-gate/, v);
        assert.match(h.text, /id="lrInit"/, v + ": the live widget");
        assert.ok(h.text.includes(PADS.pubx.chat), v + ": its chat line");
        assert.match(row, /👥/, v + ": its headcount");
      } else {
        assert.match(h.text, new RegExp(`data-adult-gate="${g}"`), v + ": the 18+ card in the widget");
        assert.doesNotMatch(h.text, /id="lrInit"/, v + ": no live data, no poll");
        assert.ok(!h.text.includes(PADS.pubx.chat) && !h.text.includes(PADS.pubx.topic), v + ": no line, no topic");
        const card = h.text.slice(h.text.indexOf('class="card lr-card"'), h.text.indexOf("</section>", h.text.indexOf('class="card lr-card"')));
        assert.ok(card.includes("data-adult-gate"), v + ": the card is in the widget");
        assert.ok(!/5/.test(card) && !card.includes("Alice") && !card.includes("Stranger"), v + ": no headcount, no names in it");
        assert.match(row, g === "confirm" ? /title="🔇 confirm you're 18 or older to listen" disabled/ : /title="🔇 sign in to listen" disabled/, v + ": the 🎧 reason");
        assert.match(row, /data-np="pubx\.Room" hidden/, v + ": no now-playing line");
        assert.doesNotMatch(row, /👥|🎙/, v + ": no headcount / mic count on its Top Pads row");
      }
    }
  } finally { await setSwitch(false); await bridge.ingest({ rooms: [roomOf(PADS.pubx, false)] }); }
});

test("ON: a tip made on an 18+ pad's page isn't announced in its room for a tipper its gate stops (bridge.tipAnnounce, through full())", async () => {
  await setSwitch(true);
  try {
    const a = await bridge.tipAnnounce({ slug: PADS.pubx.slug, senderId: U.unconfirmed.userId, recipient: "alice", amount: 5 });
    assert.deepEqual(a, { queued: false, why: "pad" });
    const b = await bridge.tipAnnounce({ slug: PADS.pubx.slug, senderId: U.confirmed.userId, recipient: "alice", amount: 5 });
    assert.deepEqual(b, { queued: true }, "a confirmed member's is");
  } finally { await setSwitch(false); }
});

// ─────────────────────────── Pepe's DM claim, Telegram ───────────────────────────
test("Pepe's DM claim and Telegram's whois name the 18+ pads a member may not get (switch on only; off: no new field)", async () => {
  const dm = require(path.join(repo, "messages"));
  const tg = require(path.join(repo, "telegram"));
  await dm.init(); await tg.init();
  let T = Date.now();
  dm._setClock(() => T);                             // messages' own rate limits: a minute between sends
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES (?, '424242', 1)", [U.unconfirmed.userId]);
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES (?, '434343', 1)", [U.confirmed.userId]);
  const claimFor = async (u, text) => {
    T += 60e3;
    await dm.send(u, { to: "pepe", body: text });
    const c = (await dm.pepeClaim()).find((x) => x.user.username === u.username);
    assert.ok(c, "claimed");
    await dm.pepeReply({ conversation: c.conversation, upto: c.upto, text: "" });
    return c.user;
  };
  let w = await tg.whois({ tg_id: "424242" });
  assert.ok(w.user && !("rooms_gated" in w.user), "off: whois as today");
  assert.ok(!("rooms_gated" in (await claimFor(U.unconfirmed, "what's up in the night pond?"))), "off: the claim as today");
  await setSwitch(true);
  try {
    w = await tg.whois({ tg_id: "424242" });
    assert.deepEqual(w.user.rooms_gated.slice().sort(), [PADS.memx.id, PADS.pubx.id].sort(), "Telegram: the 18+ pads Pepe leaves out of the live context");
    assert.ok(!("rooms_gated" in (await tg.whois({ tg_id: "434343" })).user), "a confirmed member: nothing left out");
    assert.deepEqual((await claimFor(U.unconfirmed, "and now?")).rooms_gated.slice().sort(), [PADS.memx.id, PADS.pubx.id].sort(), "the DM claim too");
    assert.ok(!("rooms_gated" in (await claimFor(U.confirmed, "hi pepe"))));
  } finally { await setSwitch(false); dm._setClock(() => Date.now()); }
});

// ─────────────────────────── the confirmation ───────────────────────────
test("/confirm-age: signed in only, a local next path, the CSRF rules, idempotent, its version kept; then the gate lets them in at once", async () => {
  await setSwitch(true);
  try {
    let r = await get("/confirm-age?next=%2Fp%2Fpubx-room", null);
    assert.equal(r.status, 302);
    assert.equal(r.r.headers.get("location"), "/login?next=" + encodeURIComponent("/confirm-age?next=" + encodeURIComponent("/p/pubx-room")));
    r = await get("/confirm-age?next=%2Fp%2Fpubx-room", U.fresh);
    assert.equal(r.status, 200);
    assert.match(r.text, /id="ageForm"/);
    assert.match(r.text, /data-next="\/p\/pubx-room"/);
    assert.match(r.text, /I am 18 years old or older/);
    assert.match(r.text, /age-confirm\.js/);
    assert.match(r.r.headers.get("cache-control"), /no-store/);
    for (const bad of ["//evil.example/x", "https://evil.example/", "/login?next=/x", "javascript:alert(1)"]) {
      r = await get("/confirm-age?next=" + encodeURIComponent(bad), U.fresh);
      assert.match(r.text, /data-next="\/"/, "next refused: " + bad);
    }
    assert.equal(PA.adultGate(U.fresh, PADS.pubx.id), "confirm");
    // the POST: signed in, X-Requested-With: fetch, same-site, JSON, the box ticked
    assert.equal((await post("/api/age/confirm", null, { yes: true })).status, 401);
    assert.equal((await post("/api/age/confirm", U.fresh, { yes: true }, { "content-type": "application/json", "x-test-user": U.fresh.userId })).status, 403, "no X-Requested-With");
    assert.equal((await post("/api/age/confirm", U.fresh, { yes: true }, H(U.fresh, { origin: "https://evil.example" }))).status, 403, "cross-site");
    r = await fetch(base + "/api/age/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "fetch", "x-test-user": U.fresh.userId }, body: "yes=1" });
    assert.equal(r.status, 415, "JSON only");
    r = await post("/api/age/confirm", U.fresh, {});
    assert.equal(r.status, 400, "the box not ticked"); assert.equal(r.d.code, "tick");
    assert.equal(r.d.error, JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"))["age.err_tick"], "its words from locales/en.json");
    assert.equal((await getQuery("SELECT age_confirmed_at FROM users WHERE userId = ?", [U.fresh.userId]))[0].age_confirmed_at, null, "nothing written yet");
    r = await post("/api/age/confirm", U.fresh, { yes: true }, H(U.fresh, { origin: base }));
    assert.equal(r.status, 200); assert.equal(r.d.already, false);
    const row = (await getQuery("SELECT age_confirmed_at AS at, age_confirmed_v AS v FROM users WHERE userId = ?", [U.fresh.userId]))[0];
    assert.equal(r.d.at, row.at); assert.ok(row.at > 0);
    assert.equal(row.v, AG.AGE_VERSION, "the wording's version is kept with it");
    r = await post("/api/age/confirm", U.fresh, { yes: true });
    assert.equal(r.d.already, true); assert.equal(r.d.at, row.at, "the first time is kept");
    assert.equal(PA.adultGate(U.fresh, PADS.pubx.id), "ok", "in at once");
    assert.equal((await get("/api/rooms/pubx-room/live", U.fresh)).status, 200);
    r = await get("/confirm-age?next=%2Fp%2Fpubx-room", U.fresh);
    assert.equal(r.status, 302); assert.equal(r.r.headers.get("location"), "/p/pubx-room", "confirmed: straight on");
    r = await get("/confirm-age?stay=1", U.fresh);
    assert.match(r.text, /You confirmed you&#39;re 18 or older on|You confirmed you're 18 or older on/);
    // async read for other features (CL3)
    assert.equal(await AG.confirmed(U.fresh.userId), true);
    assert.equal(await AG.confirmed(U.unconfirmed.userId), false);
    assert.equal(PA.adultGate(U.unconfirmed, PADS.pubx.id, { always: true }), "confirm");
  } finally { await setSwitch(false); }
  assert.equal(PA.adultGate(U.unconfirmed, PADS.pubx.id), "ok", "off again: ok");
  assert.equal(PA.adultGate(U.unconfirmed, PADS.pubx.id, { always: true }), "confirm", "{always: true} applies the rule whatever the switch says");
  assert.equal(PA.adultGate(null, PADS.pubx.id, { always: true }), "signin");
  assert.equal(PA.adultGate(null, PADS.plain.id, { always: true }), "ok", "not an 18+ pad");
  assert.equal(PA.adultGate(U.staff, PADS.pubx.id, { always: true }), "ok", "staff");
  assert.equal(PA.adultGate(U.owner, PADS.pubx.id, { always: true }), "ok", "the owner");
});

test("Creators keeps its own confirmation (attested() never reads /confirm-age); a Creators, creator-18+ or voice-clone confirmation counts for the gate", async () => {
  const CR = require(path.join(repo, "creators"));
  await CR.init();
  assert.equal(await AG.confirmed(U.fresh.userId), true, "confirmed on /confirm-age...");
  assert.equal(await CR.attested(U.fresh.userId), false, "...doesn't unlock R-rated creator posts (their own versioned wording)");
  assert.equal(await CR.attested(U.creator.userId), true);
  const late = await mkUser("latecomer");
  assert.equal(AG.confirmedSync(late.userId), false);
  await CR.attestAge(late, true);
  assert.equal(AG.confirmedSync(late.userId), true, "creators.attestAge tells the gate");
  assert.equal(await AG.confirmed(U.voice.userId), true, "the voice-clone 18+ box");
  assert.equal(await AG.confirmed(U.creator.userId), true, "the Creators confirmation");
  // a creator's own 18+ attestation (its "adult" box): their profile's, and a pad's given by that pad's owner
  const maker = await mkUser("r18maker"), padmom = await mkUser("padmom"), other = await mkUser("bystander");
  const T = Date.now();
  await runQuery("INSERT INTO creators (user_id, status, rating, r18_attest, created, updated) VALUES (?, 'active', 'r18', ?, ?, ?)",
                 [maker.userId, JSON.stringify({ v: "x", at: T, keys: ["adult"] }), T, T]);
  await rooms.addRoom("cpx.Room", "Creator Pad", "test");
  await rooms.setOwner("cpx.Room", "padmom", "test");
  await runQuery("INSERT INTO creator_pads (room_id, r18, allow_creators, r18_attest, set_by, updated) VALUES ('cpx.Room', 1, 0, ?, 'padmom', ?)", [JSON.stringify({ v: "x" }), T]);
  await rooms.addRoom("cpy.Room", "Another Pad", "test");
  await rooms.setOwner("cpy.Room", "bystander", "test");
  await runQuery("INSERT INTO creator_pads (room_id, r18, allow_creators, r18_attest, set_by, updated) VALUES ('cpy.Room', 1, 0, ?, 'plainadmin', ?)", [JSON.stringify({ v: "x" }), T]);
  await AG.load();
  assert.equal(AG.confirmedSync(maker.userId), true, "a creator's 18+ profile attestation");
  assert.equal(await AG.confirmed(maker.userId), true);
  assert.equal(AG.confirmedSync(padmom.userId), true, "a pad owner's own 18+ pad attestation");
  assert.equal(AG.confirmedSync(other.userId), false, "not one an admin gave for their pad");
});

test("account merge keeps the earliest confirmation (with its version); delete drops it from the gate; the export lists it", async () => {
  const AM = require(path.join(repo, "accountMerge"));
  const a = await mkUser("mergeto"), b = await mkUser("mergefrom"), c = await mkUser("mergeto2"), d = await mkUser("mergefrom2");
  await runQuery("UPDATE users SET age_confirmed_at = 5000, age_confirmed_v = 'v-old' WHERE userId = ?", [b.userId]);
  await AM.carryUserFields((await getQuery("SELECT * FROM users WHERE userId = ?", [b.userId]))[0], a.userId);
  assert.deepEqual({ ...(await getQuery("SELECT age_confirmed_at AS at, age_confirmed_v AS v FROM users WHERE userId = ?", [a.userId]))[0] }, { at: 5000, v: "v-old" },
                   "only the merged-in account had it");
  await runQuery("UPDATE users SET age_confirmed_at = 7000, age_confirmed_v = 'v7' WHERE userId = ?", [c.userId]);
  await runQuery("UPDATE users SET age_confirmed_at = 9000, age_confirmed_v = 'v9' WHERE userId = ?", [d.userId]);
  await AM.carryUserFields((await getQuery("SELECT * FROM users WHERE userId = ?", [d.userId]))[0], c.userId);
  assert.deepEqual({ ...(await getQuery("SELECT age_confirmed_at AS at, age_confirmed_v AS v FROM users WHERE userId = ?", [c.userId]))[0] }, { at: 7000, v: "v7" },
                   "the earlier one stays");
  await AM.afterMerge(a.userId, {});
  assert.equal(AG.confirmedSync(a.userId), true, "afterMerge reloads the gate");
  AG.drop(a.userId);
  assert.equal(AG.confirmedSync(a.userId), false);
  assert.ok(AM.classify("adult_gate_cfg", "by").deny, "the switch's actor name is classified for merges");
  assert.ok(require(path.join(repo, "accountdelete")).NAME_COLUMNS.includes("adult_gate_cfg.by"), "...and pseudonymised on deletion");
  const X = require(path.join(repo, "accountexport"));
  const out = await X.collect(U.confirmed.userId);
  assert.equal(out.account.age_confirmation.at, Date.UTC(2026, 9, 1));
  assert.equal(out.account.age_confirmation.version, "2026-10-19");
  const out2 = await X.collect(U.creator.userId);
  assert.equal(out2.account.age_confirmation.at, null);
  assert.equal(out2.account.age_confirmation.creators.version, "2026-10-11");
});

test("the copy: English strings in locales/en.json (server refusals included), the card and the page render without an i18n middleware", async () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["adultgate.h", "adultgate.signin_p", "adultgate.confirm_p", "adultgate.confirm_btn", "adultgate.listen_confirm", "adultgate.api_signin", "adultgate.api_confirm",
                   "adultgate.audio_signin", "adultgate.audio_confirm", "adultgate.back_feed", "age.h", "age.p", "age.p2", "age.ck", "age.go", "age.done_p", "age.og_desc",
                   "age.err_signin", "age.err_tick", "js.age.tick", "js.age.fail"]) assert.equal(typeof en[k], "string", k);
  assert.equal(AG.refusal("signin", "/p/x").error, en["adultgate.api_signin"], "English from en.json");
  assert.equal(AG.refusal("confirm", "/p/x", (k) => "«" + k + "»").error, "«adultgate.api_confirm»", "the request's language when it has one");
  const js = fs.readFileSync(path.join(repo, "public", "js", "age-confirm.js"), "utf8");
  assert.doesNotMatch(js, /j\.error/, "the page shows its own translated words, never the server's English");
  const ejs = require("ejs");
  const html = await ejs.renderFile(path.join(repo, "views", "partials", "adult-gate.ejs"), { gate: "confirm", next: "//evil.example" });
  assert.match(html, /href="\/confirm-age\?next=%2F"/, "a bad next path becomes /");
  assert.ok(html.includes(en["adultgate.confirm_btn"]) && html.includes(en["adultgate.confirm_p"]), "the English copy");
});

// ─────────────────────────── last: an Approved 18+ pad (added here so the counts above stay three pads) ───────────────────────────
test("Approved + 18+: the Approved rule comes first - an outsider gets the usual 404 (never the 18+ card); a member still needs the confirmation", async () => {
  const P = { id: "apx.Room", slug: "apx-room", title: "Back Room" };
  await rooms.addRoom(P.id, P.title, "test");
  await rooms.setOwner(P.id, "padowner", "test");
  const R = await rooms.get(P.id);
  await PA.setLevel(U.owner, R, "approved");
  await rooms.setPage(P.id, { adult: true }, "test");
  const cap = "ad0be9990a1b2c3d4";
  const t = Date.now() - 60e3;
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon)
                  VALUES (?, 'clip', 'video/mp4', ?, 10, 5, 'alicecf', 'pepefan', ?, ?, ?, 0, 0)`, [cap, cap + ".mp4", P.id, t, t + 24 * 3600e3]);
  fs.writeFileSync(path.join(process.env.MEDIA_DIR, cap + ".mp4"), webp);
  const q = await store.create(U.alice.userId, { title: "QUOTE-apx", body: "QLINE-apx", community: P.id, announce: [] }, { free: true, onBehalf: true, liveRoom: P.id });
  await runQuery("INSERT INTO feed_quotes (post_id, room_id, source, lines, logins, removed, created_by, created) VALUES (?, ?, 'web', '[]', '', '[]', ?, ?)", [q.id, P.id, U.alice.userId, Date.now()]);
  await setSwitch(true);
  try {
    for (const u of [null, U.unconfirmed]) {
      for (const sub of ["", "/raw", "/poster"]) assert.equal((await get("/media/" + cap + sub, u)).status, 404, (u ? "non-member" : "signed out") + " " + sub);
      const pg = await get("/feed/p/" + q.id, u);
      assert.equal(pg.status, 404, "the quote's page: 404 for an outsider");
      assert.doesNotMatch(pg.text, /data-adult-gate/);
    }
    await PA.request(U.unconfirmed, R, "let me in");
    await PA.decide(U.owner, R, U.unconfirmed.userId, true);
    const pg = await get("/media/" + cap, U.unconfirmed);
    assert.equal(pg.status, 403, "a member who hasn't confirmed: the 18+ card");
    assert.match(pg.text, /data-adult-gate="confirm"/);
    assert.equal((await get("/feed/p/" + q.id, U.unconfirmed)).status, 403);
    assert.equal((await get("/media/" + cap, U.owner)).status, 200, "the owner");
  } finally { await setSwitch(false); }
  assert.equal((await get("/media/" + cap, null)).status, 404, "off: the Approved rule alone, as today");
});
