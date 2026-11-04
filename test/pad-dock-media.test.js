// 1.99ajc dockfu (Room Dock follow-ups D2 + D3, hand-off 18): the media mark, end to end through the real ingest and the viewer projection.
//   D3: a chat line is a Camfrog sticker / a GIF only with the mark the SERVER adds (it.md - bridge.js mediaMark) to a line that came
//       through a real media path: Pepe's room-sticker inject (his event says media: "cfsticker") or a relayed Room Dock pick whose own
//       say job carried that very token. The same words TYPED in Camfrog (or a job for other words, or a gone job, or an md an event
//       claims for itself) stay plain text. The mark is page data only: it is archived with the line, projected beside its words, and
//       dropped wherever the words are (a masked bar, a sealed / purged line).
//   D2: a veiled web sender's GIF (privacy wire v1 "someone", v2 incognito frog name) is marked like anyone's; a hidden (!bridge hide)
//       sender's line stays its bar - no words, no mark.
//   node --test test/pad-dock-media.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-dock-media-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "ab".repeat(32);
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.MICCLIP_DIR = path.join(tmp, "micclip");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const CL = require(path.join(repo, "chatlog"));
const PW = require(path.join(repo, "privwire"));
const gifs = require(path.join(repo, "gifs"));

const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Media.Room", name: "Media Room" }, SLUG = "media-room";
const real = (login, display, extra = {}) => Object.assign({ id: login.toLowerCase(), login, display: display || login }, extra);
const ALICE = real("alicecf", "Alice"), BOB = real("bobcf", "Bob");
const PEPE = { id: "pepebot", login: "pepebot", display: "Pepe", is_self: true };
const FR = "frankiefettuccine", HK = "hankhidden", INC = "inacognito";
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
const KINDED = () => ({ bridge_hidden_h: [hash(HK)], incog_hidden_h: [hash(FR)] });
let seq = 0, jseq = 0;
const ev = (type, data, ts = Date.now()) => ({ op: "event", id: "dm-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const sync1 = (events) => bridge.ingest({ events, rooms: [] });
const sync2 = (events, extra = {}) => bridge.ingest(Object.assign({ events, rooms: [] }, KINDED(), extra), { v2: true });
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
// a say job as sendSayLine leaves it (bridge-relay newJob): media = the validated pick, absent for ordinary words
function job(text, media) {
  const id = "w" + (0xabc000000000 + (++jseq)).toString(16).padStart(16, "0");
  relay._jobs.set(id, { id, kind: "say", roomId: ROOM.id, userId: "id-mem", username: "mem", camfrog: "memcf", display: "", text,
                        state: "sent", at: Date.now(), ...(media ? { media } : {}) });
  return id;
}
const feed = () => bridge.bySlug(SLUG).feed;
const line = (pred) => feed().filter(pred).at(-1);
let MEM;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('id-mem', 'mem', 'mem', 'x', 'pleb', 'memcf'),
                  ('id-adm', 'adm', 'adm', 'x', 'Admin', 'admcf')`);
  MEM = { userId: "id-mem", username: "mem", class: "pleb" };
  await rooms.init();
  await require(path.join(repo, "feedstore")).init();
  CL._setClock(() => Date.now() - 8 * 864e5);                // the archive notice 8 days ago, then the archive on
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: "id-adm", username: "adm" });
  await sync2([], { rooms: [{ room: ROOM, members: [ALICE, BOB, real(FR, "Frankie Fett", { priv: priv("incognito", FR), src: "list" }),
                                                     real(HK, "Hank Hide", { priv: priv("hidden", HK), src: "list" })], mic: [], count: 4, transcripts: true }] });
  await sync2([
    { op: "event", id: "dm-ph-1", ts: new Date(Date.now() - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(FR), scope: "incognito" } },
    { op: "event", id: "dm-ph-2", ts: new Date(Date.now() - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(HK), scope: "bridge" } }
  ]);
});
test.after(() => { relay._jobs.clear(); });

test("Pepe's room-sticker inject is a sticker; the same words typed in Camfrog, and any md an event claims, are not", async () => {
  await sync1([
    ev("message", { user: ALICE, text: "[cfsticker:7/8]", media: "cfsticker" }),
    ev("message", { user: BOB, text: "[cfsticker:7/9]" }),                                   // typed in the room
    ev("message", { user: BOB, text: "[cfsticker:7/10]", md: "cfsticker" }),                 // an event can't mark itself
    ev("message", { user: BOB, text: "[gif:typed_in_room]", media: "gif" }),                 // Pepe marks stickers only
    ev("message", { user: BOB, text: "[cfsticker:7/11] and words", media: "cfsticker" }),   // not exactly a token
    ev("message", { user: PEPE, text: "[cfsticker:7/12]", media: "cfsticker", self: true })  // Pepe's own line: never
  ]);
  assert.equal(line((it) => it.text === "[cfsticker:7/8]").md, "cfsticker");
  for (const t of ["[cfsticker:7/9]", "[cfsticker:7/10]", "[gif:typed_in_room]", "[cfsticker:7/11] and words", "[cfsticker:7/12]"]) {
    const it = line((x) => x.text === t); assert.ok(it, t); assert.equal(it.md, undefined, t);
  }
});

test("a relayed pick is media only when its own say job carried that very token", async () => {
  const gif = job("[gif:orchard_A1]", { type: "gif", id: "orchard_A1", title: "Orchard", page: "" });
  const stk = job("[cfsticker:7/20]", { type: "cfsticker", set: 7, id: 20 });
  const other = job("[gif:orchard_B2]", { type: "gif", id: "orchard_B2", title: "B", page: "" });
  const plain = job("[gif:orchard_C3]");                                                     // an ordinary say job (no media)
  const otherSticker = job("[cfsticker:7/9]", { type: "cfsticker", set: 7, id: 9 });
  const web = (text, jid) => ev("message", { user: PEPE, text: "🌐 Bob (web): " + text, self: true, web: { user: BOB, text, job: jid } });
  await sync1([web("[gif:orchard_A1]", gif), web("[cfsticker:7/20]", stk), web("[gif:orchard_D4]", other), web("[gif:orchard_C3]", plain),
               web("[cfsticker:7/21]", otherSticker), web("[gif:no_job]", "w" + "f".repeat(16))]);
  const webLine = (t) => { const it = line((x) => x.u && x.u.web && x.text === t); assert.ok(it, t); return it; };
  assert.equal(webLine("[gif:orchard_A1]").md, "gif");
  assert.equal(webLine("[cfsticker:7/20]").md, "cfsticker");
  for (const t of ["[gif:orchard_D4]", "[gif:orchard_C3]", "[cfsticker:7/21]"]) assert.equal(webLine(t).md, undefined, t + ": a job for other words / no media marks nothing");
  assert.equal(webLine("[gif:no_job]").md, undefined, "an unknown job marks nothing");
  assert.equal(webLine("[gif:orchard_A1]")._job, undefined, "(the job id itself stays server-only, as before)");
});

// 1.99ajf dockclean (owner point 21): a 🧸 PATV sticker sent from the Dock. Pepe posts its readable stand-in ("[sticker: Name]" -
// stickers.fallbackText), and the echo of THAT say job is marked md "sticker" + stk "<pack>/<id>"; the same words typed (or a job for
// other words) stay text. The renderer draws the site's own art; the reusable text (quotes, ✂️ Clip chat, downloads) is the stand-in.
test("dockclean: a PATV sticker's echo is marked by its own say job, drawn as the pack's art, and reads as its stand-in everywhere else", async () => {
  const alt = "[sticker: Who's talking?]";
  const mine = job(alt); relay._jobs.get(mine).stk = { pack: "miclife", id: "who", alt };
  const other = job("[sticker: Not this one]"); relay._jobs.get(other).stk = { pack: "miclife", id: "hi", alt: "[sticker: Hi]" };
  const web = (text, jid) => ev("message", { user: PEPE, text: "🌐 Bob (web): " + text, self: true, web: { user: BOB, text, job: jid } });
  await sync1([web(alt, mine), web("[sticker: Not this one]", other), ev("message", { user: ALICE, text: alt, md: "sticker", stk: "miclife/who" })]);
  const marked = line((x) => x.u && x.u.web && x.text === alt);
  assert.equal(marked.md, "sticker"); assert.equal(marked.stk, "miclife/who");
  const plain = line((x) => x.u && x.u.web && x.text === "[sticker: Not this one]"); assert.equal(plain.md, undefined); assert.equal(plain.stk, undefined);
  const typed = line((x) => x.u && !x.u.web && x.text === alt); assert.equal(typed.md, undefined, "typed words never mark themselves"); assert.equal(typed.stk, undefined);
  const C = require(path.join(repo, "public/js/chatlog-core"));
  assert.deepEqual({ ...C.mediaOf(marked) }, { type: "sticker", pack: "miclife", id: "who", alt: "Who's talking?" });
  assert.equal(C.mediaOf({ k: "msg", text: alt, md: "sticker", stk: "../x" }), null, "a bad key draws nothing");
  const html = String(C.renderItem(marked, { t: null, data: true }, C.htmlH));
  assert.match(html, /<img class="pstk" src="\/public\/stickers\/miclife\/who\.svg" alt="Who&#39;s talking\?"/);
  assert.match(html, /data-text="\[sticker: Who&#39;s talking\?\]"/, "quotes / ✂️ Clip chat read the stand-in");
  assert.ok(String(C.textItem(marked, {})).includes(alt), "the TXT download writes the stand-in");
  const bar = String(C.renderItem({ ...marked, mask: "m" }, { t: null, data: true }, C.htmlH)); assert.doesNotMatch(bar, /pstk|miclife/, "a bar draws no sticker");
  // the projection keeps the key only beside its mark
  const CV = require(path.join(repo, "chatlogview"));
  assert.ok(CV.OUT_KIND.msg.includes("stk"));
});

test("D2: a veiled sender's GIF / sticker is marked like anyone's (v1 someone, v2 incognito); a hidden sender's line stays a bar", async () => {
  const anonUser = () => ({ id: "anon-" + crypto.randomBytes(4).toString("hex"), display: "someone", anonymous: true });
  // privacy wire v1: an incognito sender's relayed line arrives anonymised ("someone") with its job
  const g1 = job("[gif:veiled_v1]", { type: "gif", id: "veiled_v1", title: "V1", page: "" });
  const au = anonUser();
  await sync1([ev("message", { user: au, text: "[gif:veiled_v1]", anon: { kind: "incognito", h: hash(INC) }, web: { user: au, job: g1 } })]);
  const v1 = line((it) => it.text === "[gif:veiled_v1]");
  assert.ok(v1 && v1.u.anon, "the v1 line stays someone"); assert.equal(v1.md, "gif");
  // privacy wire v2: incognito frog name - a relayed GIF and Pepe's room sticker (its twin keeps media); hidden - the bar
  const g2 = job("[gif:veiled_v2]", { type: "gif", id: "veiled_v2", title: "V2", page: "" });
  const g3 = job("[gif:hidden_v2]", { type: "gif", id: "hidden_v2", title: "V3", page: "" });
  await sync2([
    ev("message", { user: real(FR, "Frankie Fett"), text: "[gif:veiled_v2]", priv: priv("incognito", FR), web: { job: g2 } }),
    ev("message", { user: real(FR, "Frankie Fett"), text: "[cfsticker:7/8]", media: "cfsticker", priv: priv("incognito", FR) }),
    ev("message", { user: real(FR, "Frankie Fett"), text: "[cfsticker:7/13]", priv: priv("incognito", FR) }),     // typed, veiled
    ev("message", { user: real(HK, "Hank Hide"), priv: priv("hidden", HK, { words: "[gif:hidden_v2]" }), web: { job: g3 } })
  ]);
  const v2g = line((it) => it.text === "[gif:veiled_v2]"), v2s = line((it) => it.text === "[cfsticker:7/8]" && it.u && it.u.veil);
  assert.ok(v2g && v2g.u.veil === "incognito" && !v2g.u.web, "the frog-name line keeps its veil, no web mark"); assert.equal(v2g.md, "gif");
  assert.ok(v2s); assert.equal(v2s.md, "cfsticker");
  assert.equal(line((it) => it.text === "[cfsticker:7/13]").md, undefined, "a veiled sender's typed token stays text");
  const bar = line((it) => it.k === "msg" && it.mask && it.u && it.u.veil === "hidden");
  assert.ok(bar && bar.mask && bar.text === undefined, "the hidden sender's line is a bar"); assert.equal(bar.md, undefined);

  // the projection a viewer gets: the mark beside the words only; the veil exactly as before (no login, no web mark)
  const seen = [];
  const oldAttach = gifs.attach;
  gifs.attach = (o) => { seen.push(o); return o; };
  try {
    const R = bridge.bySlug(SLUG), d = await bridge.liveView(R, 0, MEM.userId, "memcf", "mem", true, { viewer: MEM });
    const out = (t) => d.feed.filter((it) => it.text === t).at(-1);
    assert.equal(out("[gif:veiled_v1]").md, "gif"); assert.deepEqual(out("[gif:veiled_v1]").u, { anon: true, display: "someone" });
    const fr = out("[gif:veiled_v2]");
    assert.equal(fr.md, "gif"); assert.equal(fr.u.veil, "incognito"); assert.ok(fr.u.alias);
    assert.equal(fr.u.login, undefined); assert.equal(fr.u.web, undefined);
    assert.equal(out("[cfsticker:7/9]").md, undefined);
    const hb = d.feed.find((it) => it.mask && it.u && it.u.veil === "hidden");
    assert.ok(hb); assert.equal(hb.md, undefined, "a bar never says it was a GIF"); assert.equal(hb.text, undefined);
    assert.doesNotMatch(JSON.stringify(d.feed), new RegExp(FR + "|" + HK + "|hidden_v2|" + hash(FR) + "|" + hash(HK)));
    assert.ok(seen.some((o) => o.md === "gif" && o.u && o.u.veil === "incognito"), "the GIF attachment sees the veiled marked line");
  } finally { gifs.attach = oldAttach; }
});

test("the mark is archived with the line and comes back in scrollback, never as text", async () => {
  await settle(200);
  const t = "[cfsticker:7/8]";
  const it = line((x) => x.text === t && x.md === "cfsticker" && x.u && !x.u.anon);
  const row = (await getQuery("SELECT d, text FROM chat_log WHERE c = ?", [it.c]))[0];
  assert.ok(row, "archived"); assert.equal(row.text, t, "the indexed text is the words (search finds them)");
  assert.equal(JSON.parse(row.d).md, "cfsticker");
  const typed = line((x) => x.text === "[cfsticker:7/9]");
  const trow = (await getQuery("SELECT d FROM chat_log WHERE c = ?", [typed.c]))[0];
  assert.equal(JSON.parse(trow.d).md, undefined);
  const stored = (await getQuery("SELECT data FROM bridge_feed WHERE c = ?", [it.c]))[0];
  assert.equal(JSON.parse(stored.data).md, "cfsticker", "the live feed keeps it across a restart");
});

// 1.99ajc dockfu: review (privacy) - the mark says what a line's words were (a sticker / a GIF). A purge takes the words (text NULL,
// d.u blanked, the 🎙 id); the archived row must not keep "this was a GIF" behind either, for a named or a veiled sender alike
test("a purged media line keeps no media mark in the archive", async () => {
  await settle(200);
  const CLM = require(path.join(repo, "chatlogmod"));
  const named = line((x) => x.text === "[gif:orchard_A1]" && x.md === "gif"), veiled = line((x) => x.text === "[gif:veiled_v1]" && x.md === "gif");
  assert.ok(named && veiled);
  const rowOf = async (c) => (await getQuery("SELECT l.*, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE l.c = ?", [c]))[0];
  for (const it of [named, veiled]) assert.equal(JSON.parse((await rowOf(it.c)).d).md, "gif", "(archived with its mark first)");
  const out = await CLM.purgeRows([await rowOf(named.c), await rowOf(veiled.c)], "staff:x", "test");
  assert.equal(out.purged, 2);
  for (const it of [named, veiled]) {
    const r = await rowOf(it.c);
    assert.equal(r.purged, 1); assert.equal(r.text, null);
    assert.equal(JSON.parse(r.d).md, undefined, "the purged row no longer says it was a GIF");
  }
});
