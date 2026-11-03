"use strict";
// Invented data shared by the offline render tests and the local browser evidence.
// Call seed() only after changing into an isolated temporary directory.
const path = require("path");
const repo = path.resolve(__dirname, "../../..");
const ejs = require(path.join(repo, "node_modules/ejs"));
const NOW = Date.UTC(2026, 10, 3, 16, 42);
const CASES = { equipped: "Dock.Equipped", plus: "Dock.Plus", lapsed: "Dock.Lapsed", plain: "Dock.Plain", season: "Dock.Season" };
const flair = { name: "Constellation crew badge", emoji: "✨", color: "#d5a6f0", ink: "#172128" };
const PEOPLE = [
  { login: "aster_fable", display: "Aster Fable", on_mic: true, on_cam: true, patv: { username: "aster-fable", avatar: "/fixture/portrait.webp", style: "background:linear-gradient(90deg,#ff6ec7,#ffd54f,#66bb6a);background-size:200% auto;-webkit-background-clip:text;background-clip:text;color:transparent;animation:cx-shift 4s linear infinite", flair } },
  { login: "willow_fable", display: "Willow Fable", on_cam: true, patv: { username: "willow-fable", flair: { name: "Supporter", emoji: "💚", color: "#66bb6a", ink: "#111111" } } },
  { anon: true, veil: "incognito", alias: "Misty Froglet", hood: 2, cam: "opaque-cam-2", on_mic: true },
  { anon: true, veil: "hidden", alias: "Moonlit Bullfrog", hood: 4 },
  { login: "juniper_fable", display: "Juniper Fable", patv: { username: "juniper-fable", flair: { name: "Plus", emoji: "💎", color: "#b39ddb", ink: "#111111" } } },
  { login: "cedar_fable", display: "Cedar Fable", patv: { username: "cedar-fable", flair: { name: "Plex", emoji: "📼", color: "#e5a00d", ink: "#111111" } } }
];
function initial() {
  return {
    room: { name: "Night Orchard", slug: "night-orchard", live: true, topic: "A little music, a little conversation", count: PEOPLE.length,
      updated: NOW, listAt: NOW, listFresh: true, audio: true, relay: true, micRelay: true, cams: true, transcripts: true,
      cmds: { "!say": 100, "!duel": 0, "!bj": 0 }, mod: null, clip: null, pepe: null },
    members: PEOPLE.map(p => Object.assign({ src: "list" }, p)), mic: [PEOPLE[0], PEOPLE[2]], mine: [], cursor: 8, ver: 1, mver: 0,
    feed: [
      { k: "msg", c: 1, ts: NOW - 60000, u: PEOPLE[0], text: "The lights are up. What are we listening to tonight?" },
      { k: "msg", c: 2, ts: NOW - 55000, u: PEOPLE[1], text: "Something mellow for the night shift." },
      { k: "msg", c: 3, ts: NOW - 48000, u: PEOPLE[2], text: "A tune for the road." },
      { k: "msg", c: 4, ts: NOW - 42000, u: PEOPLE[3], mask: "m", rv: 1 },
      { k: "tx", c: 5, ts: NOW - 35000, at: NOW - 40000, u: PEOPLE[4], mask: "l", txh: 1, rv: 1 },
      { k: "msg", c: 6, ts: NOW - 28000, u: PEOPLE[5], text: "The next film starts in a few minutes." },
      { k: "tx", c: 7, ts: NOW - 22000, at: NOW - 30000, u: PEOPLE[0], id: "fixture-tx", text: "I have one more song before the film." },
      { k: "msg", c: 8, ts: NOW - 10000, u: { login: "pepe_fixture", display: "Pepe", self: true }, text: "Settle in. The evening is just getting started." }
    ], history: { chat_s: 86400, search: true, v: "fixture-v1", explain: "/privacy#chat-history" }
  };
}
function feed(room, signed) {
  return { room, viewer: signed ? { username: "viewer-fable" } : null, follow: { following: true, followers: 127 }, mod: {},
    caps: [], storyRooms: [], rules: null, queue: 0, sort: "new", top: "", tag: "", flairOn: null, page: 1,
    more: false, posts: [], gallery: false, popularTags: [], postFlairs: [], flair: null, composer: null };
}
function locals(extra = {}) {
  const signed = extra.signedIn !== false;
  const room = Object.assign({ id: CASES.equipped, slug: "night-orchard", name: "Night Orchard", count: PEOPLE.length,
    live: true, bridged: true, topic: "A little music, a little conversation", platform: "camfrog", description: "Music and conversation after dark.",
    owner: "owner-fable", ownerUser: "owner-fable", camfrogName: "Night Orchard" }, extra.room);
  const base = { user: signed ? "viewer-fable" : null, signedIn: signed, linked: signed, room, initial: initial(), onStage: false,
    stage: {}, roomStage: { slots: [], upcoming: [], queue: {}, open: 1, room: { slot_count: 1 } }, latest: [],
    padDockOn: true, liveOpen: true, pepeHere: true, manage: false,
    padTabs: { tabs: ["live", "feed", "about"], initial: "live", active: true, camfrog: true, posts: [] },
    feed: feed(room.id, signed), fx: require(path.join(repo, "feedweb")).fx, embeds: require(path.join(repo, "stageembed")), host: "fixture.invalid" };
  return Object.assign(base, extra, { room });
}
function render(extra) { return ejs.renderFile(path.join(repo, "views/room.ejs"), locals(extra)).then(h => h.replace(/\r\n/g, "\n")); }
function animatedGif() {
  const out = [], w = 16, h = 16, u16 = n => [n & 255, n >> 8];
  out.push(...Buffer.from("GIF89a"), ...u16(w), ...u16(h), 0xf6, 0, 0);
  for (let i = 0; i < 128; i++) out.push(i * 37 & 255, i * 91 & 255, i * 53 & 255);
  out.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  for (let f = 0; f < 2; f++) {
    out.push(0x21, 0xf9, 4, 0, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, ...u16(w), ...u16(h), 0, 7);
    const codes = [];
    for (let p = 0; p < w * h; p++) { if (p % 100 === 0) codes.push(128); codes.push(f * 13 + 5); }
    codes.push(129);
    for (let i = 0; i < codes.length; i += 255) { const part = codes.slice(i, i + 255); out.push(part.length, ...part); }
    out.push(0);
  }
  return Buffer.from([...out, 0x3b]);
}
async function seed() {
  const { runQuery } = require(path.join(repo, "dbUtils"));
  const rooms = require(path.join(repo, "rooms")), PL = require(path.join(repo, "padlook")), PC = require(path.join(repo, "padcosmetics")), PR = require(path.join(repo, "premium"));
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
    points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("INSERT OR IGNORE INTO users (userId,username,displayname,password,class) VALUES ('fixture-owner','owner-fable','Owner Fable','x','pleb')");
  await rooms.init(); await PL.init(); await PC.init(); await PR.init();
  PL._setClock(() => NOW); PR._setClock(() => NOW); PC._setClock(() => NOW);
  for (const id of Object.values(CASES)) { await rooms.addRoom(id, null, "fixture"); await rooms.setOwner(id, "owner-fable", "fixture"); }
  const sharp = require(path.join(repo, "node_modules/sharp"));
  const banner = await sharp(Buffer.from('<svg width="1600" height="500"><defs><linearGradient id="a"><stop stop-color="#26374e"/><stop offset="1" stop-color="#71334e"/></linearGradient></defs><rect width="1600" height="500" fill="url(#a)"/><circle cx="1220" cy="120" r="60" fill="#f7d4a0"/><path d="M0 460 Q400 160 800 400 T1600 350 V500 H0" fill="#172c2c"/></svg>')).png().toBuffer();
  for (const id of [CASES.equipped, CASES.plus, CASES.lapsed]) {
    await PL.setImage(id, "banner", banner, { actor: "fixture", bannerY: 20 });
    await PL.setImage(id, "avatar", await sharp({ create: { width: 64, height: 64, channels: 3, background: "#a86791" } }).png().toBuffer(), { actor: "fixture" });
    await PL.setStyle(id, { accent: "#ff6a9b", banner_y: 20 }, "fixture");
  }
  await runQuery("INSERT INTO pad_cosmetic_items (room_id,item_id,kind,state,price,ref,created) VALUES (?, 'pa_animated','pad_avatar','owned',0,'fixture-avatar',?)", [CASES.equipped,NOW]);
  await PL.setImage(CASES.equipped, "avatar_anim", animatedGif(), { actor: "fixture" });
  await PL.setCosmetics(CASES.equipped, { pad_frame: "pf_embers", pad_glow: "pg_gold", pad_avatar: "pa_animated", pad_badge: ["pb_est2026","pb_community","pb_talk"] }, "fixture");
  await PR.setComp("prime_plus", CASES.plus, true, "fixture", "local render test");
  await PL.setCosmetics(CASES.plus, { pad_frame: "pp_frame", pad_glow: "pp_glow", pad_badge: ["pb_est2026","pt_onair","pb_community","pt_premiere","pb_talk"] }, "fixture");
  await PR.setComp("prime_time", CASES.lapsed, true, "fixture", "local render test");
  await PL.setCosmetics(CASES.lapsed, { pad_frame: "pt_frame", pad_glow: "pt_glow", pad_badge: ["pb_est2026","pt_onair","pb_community","pt_premiere","pb_talk"] }, "fixture");
  await PR.setComp("prime_time", CASES.lapsed, false, "fixture", "ended");
  const helpers = { padLook: PL.look, padFx: PC.fx, padAv: PL.avatarHtml, premiumPadPerks: PR.padPerks, isPrimeTime: PR.isPrime };
  return { PL, PC, PR, rooms, runQuery, helpers };
}
module.exports = { repo, NOW, CASES, PEOPLE, initial, feed, locals, render, seed };
