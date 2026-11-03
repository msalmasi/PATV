// 1.99?? cliplink (cliplink.js): a pad's "Clips from the website need a linked Camfrog name" switch, and what it does.
//   * the setting: ON by default, the pad's owner / site staff / admins only (members can't), validation, same-origin writes, the
//     rate limit, a room event; only Camfrog pads; it renders on the Camfrog room tab; the owner reference names its route
//   * the handshake: an older Pepe (no clipacct_cap) -> today's LINK answer everywhere; the sync answer lists the pads that are off
//   * 🔊 mic clips: an account with NO linked Camfrog name gets LINK while the switch is on; off (and a capable Pepe) it may ask, its
//     job goes out with clip_acct: 1 and no Camfrog name - only while the switch is still off at hand-out (else failed with LINK);
//     its Post queues micclip.save with no Camfrog name, and the claim marks it clip_acct: 1 only while the switch is off; a linked
//     account is exactly as before (no flag)
//   * the pad post: credited to the account Pepe acted as ("u:<userId>" + its username, the id checked), no Camfrog login recorded;
//     the capture names it by id (media.js by_uid -> by_user_id), which is what lets the account post it (storykeep.isCapturer)
//   * 🎬 cam clips: the popover's 🎬 Clip greys with LINK unless the switch is off; the request / save carry the account the same way
//   NODE_PATH=G:/PATV/node_modules node --test test/cliplink.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cliplink-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.MICCLIP_DIR = path.join(tmp, "micclip");
process.env.CAMCLIP_DIR = path.join(tmp, "camclip");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const micclip = require(path.join(repo, "micclip"));
const camclip = require(path.join(repo, "camclip"));
const CLK = require(path.join(repo, "cliplink"));
const AC = require(path.join(repo, "actorcap"));
const PO = require(path.join(repo, "padowner"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const ROOM = { id: "Clip.Room", name: "Clip Room" };
const SLUG = "clip-room";
const NOLINK_ID = "3f2c9a1e-7b6d-4c1a-9e2f-0a1b2c3d4e5f";
const OTHER_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const TX = "tx-" + "a".repeat(16);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(400, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(200)]);
const LINK = "Link your Camfrog name first: type !verify in a Camfrog room with Pepe.";
let base, server, seq = 0;
const U = {};
const users = new Map();
const ev = (type, data, ts) => ({ op: "event", id: "cl-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const u = (login, extra) => Object.assign({ id: login, login, display: login }, extra || {});
async function mkUser(name, extra = {}) {
  const id = extra.id || "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null]);
  const x = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, x);
  return x;
}
const H = (x, more) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, x ? { "x-test-user": x.userId } : {}, more || {});
async function call(method, url, x, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(x), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const post = (url, x, body, headers) => call("POST", url, x, body, headers);
const get = (url, x) => call("GET", url, x);
const sync = (body) => post("/api/bridge/sync", null, Object.assign({ password: "bot" }, body));
const snapRoom = () => ({ room: ROOM, topic: "t", count: 4, clip: true, cams: true,
  members: [u("owncf"), u("bobcf"), u("carolcf"), u("subjcf", { on_cam: true })] });
const S = `/api/rooms/${SLUG}/clip-settings`;
const setLink = async (need) => { CLK._reset(); const r = await post(S, U.admin, { need_link: need }); assert.equal(r.status, 200, r.text); return r; };
const micJobs = () => relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "micclip");

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", { camfrog: "owncf" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.nolink = await mkUser("nolink", { id: NOLINK_ID, display: "No Link" });
  U.other = await mkUser("other", { id: OTHER_ID });
  U.staff = await mkUser("helper", { class: "Staff" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  await require(path.join(repo, "funding")).init().catch(() => {});
  await rooms.init();
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await require(path.join(repo, "pepefeed")).ensureAccount().catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  app.use(express.json({ limit: "9mb" }));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const isBotToken = (t) => t === "bot";
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken });
  bridge.register(app, { addUser, isBotToken });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  require(path.join(repo, "actions")).register(app, { addUser, isBotToken });
  require(path.join(repo, "media")).register(app, { addUser, isBotToken, noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  const r = await sync({ rooms: [snapRoom()], events: [ev("x.pepe.transcript", { id: TX, user: u("carolcf"), text: "i am talking on the mic" }, Date.now() - 30e3)] });
  assert.equal(r.status, 200, r.text);
  await rooms.setOwner(ROOM.id, "own", "test");
  await CLK.init();
  micclip._setDeps({ makePoster: async () => true });
  camclip._setDeps({ snapSwitch: () => true, clipSwitch: () => true, privateLogins: async () => new Set(), camRefusal: async () => null,
                     ghostCapture: async () => {}, noteViewers: () => {}, isGhost: () => false });
})();
const ready = async () => { await setup; CLK._reset(); relay._hits.clear(); micclip._clips.clear(); camclip._clips.clear(); };

test("the setting: ON by default; the owner, staff and admins change it, members can't; validation, same-origin, a room event", async () => {
  await ready();
  assert.equal((await get(S, null)).status, 401);
  const m = await get(S, U.bob);
  assert.deepEqual([m.status, m.d.code], [403, "not_owner"], "a member can't");
  const g = await get(S, U.own);
  assert.equal(g.status, 200, g.text);
  assert.equal(g.d.need_link, true, "ON by default - every pad as before");
  assert.equal(CLK.needLink(ROOM.id), true);
  assert.equal((await post(S, U.own, { need_link: false }, { "content-type": "application/json", "x-test-user": U.own.userId })).d.code, "security",
               "a write needs X-Requested-With (no cross-site form)");
  assert.equal((await post(S, U.own, { need_link: "off" })).d.code, "bad_value");
  assert.equal((await post(S, U.bob, { need_link: false })).status, 403);
  let r = await post(S, U.own, { need_link: false });
  assert.deepEqual([r.status, r.d.need_link], [200, false], r.text);
  assert.equal(CLK.needLink(ROOM.id), false);
  assert.deepEqual(CLK.openRooms(), [ROOM.id]);
  const evs = await getQuery("SELECT actor, detail FROM room_events WHERE room_id = ? AND what = 'clips.link' ORDER BY ts", [ROOM.id]);
  assert.deepEqual(evs[evs.length - 1], { actor: "own", detail: "clips by any signed-in PATV account" });
  r = await post(S, U.staff, { need_link: true });
  assert.deepEqual([r.status, r.d.need_link], [200, true], "site staff can");
  r = await post(S, U.admin, { need_link: false });
  assert.deepEqual([r.status, r.d.need_link], [200, false], "admins can");
  assert.equal((await getQuery("SELECT need_link FROM pad_clip_cfg WHERE room_id = ?", [ROOM.id]))[0].need_link, 0, "stored");
  // the owner's limit (staff exempt)
  CLK._reset();
  for (let i = 0; i < 20; i++) assert.equal((await post(S, U.own, { need_link: i % 2 === 0 })).status, 200);
  assert.equal((await post(S, U.own, { need_link: true })).d.code, "rate");
  await assert.rejects(CLK.save(U.admin, { id: "patv:sitepad" }, { need_link: false }), (e) => e.code === "not_camfrog", "a site pad has no bridge clips");
  await setLink(true);
});

test("it renders on the Camfrog room tab, loads its script, and the owner reference names its route", async () => {
  await ready();
  const r = await call("GET", `/p/${SLUG}/settings?tab=camfrog`, U.own, undefined, { "x-test-user": U.own.userId });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  for (const want of ['id="padClipSet"', 'id="pclLink"', "/public/js/pad-clip-settings.js?v=1", en["pad.settings.clips.link_label"], en["pad.settings.clips.rules"]]) {
    assert.ok(r.text.includes(want), want);
  }
  assert.match(r.text, /id="pclLink"[^>]*checked/, "ON by default");
  assert.ok(r.text.includes(en["pad.settings.clips.waiting"]), "an older Pepe: the card says the website still asks for a link");
  const cap = PO.WEB_CAPS.find((c) => c.id === "web_clip_link");
  assert.deepEqual(cap, { id: "web_clip_link", area: "room", route: "POST /api/rooms/:slug/clip-settings", where: "/p/{slug}/settings?tab=camfrog" });
  assert.ok(en["owner.cap.web_clip_link.title"] && en["owner.cap.web_clip_link.howto"]);
  // every js.pad.clipset.* default the script uses is the en.json text
  const js = fs.readFileSync(path.join(repo, "public", "js", "pad-clip-settings.js"), "utf8");
  const used = [...js.matchAll(/_t\('(js\.pad\.clipset\.[a-z_]+)', '((?:[^'\\]|\\.)*)'/g)];
  assert.ok(used.length >= 10);
  for (const [, k, d] of used) assert.equal(en[k], d.replace(/\\'/g, "'"), k);
});

test("the handshake: an older Pepe keeps today's LINK answer; Pepe's clipacct_cap opens it; the sync answer lists the pads that are off", async () => {
  await ready();
  await setLink(false);
  AC._setClip(0);
  let r = await post(`/api/rooms/${SLUG}/micclip`, U.nolink, { tx: TX });
  assert.deepEqual([r.status, r.d.error], [403, LINK], "the switch is off but Pepe can't: LINK");
  assert.equal(CLK.accountOk(ROOM.id), false);
  const s = await sync({ rooms: [snapRoom()], events: [], clipacct_cap: 1 });
  assert.equal(AC.clipOn(), true, "Pepe said clipacct_cap: 1");
  assert.deepEqual(s.d.clip_acct_rooms, [ROOM.id], "the sync answer lists the pads whose switch is off");
  assert.equal(CLK.accountOk(ROOM.id), true);
  await setLink(true);
  assert.deepEqual((await sync({ rooms: [snapRoom()], events: [], clipacct_cap: 1 })).d.clip_acct_rooms, [], "switched back on: off the list");
});

test("🔊 mic clips: an unlinked account may ask only while the switch is off; its job carries clip_acct: 1 only while it still is", async () => {
  await ready();
  AC._setClip(Date.now());
  await setLink(true);
  let r = await post(`/api/rooms/${SLUG}/micclip`, U.nolink, { tx: TX });
  assert.deepEqual([r.status, r.d.error], [403, LINK], "switch ON: today's answer");
  await setLink(false);
  r = await post(`/api/rooms/${SLUG}/micclip`, U.nolink, { tx: TX });
  assert.equal(r.status, 200, r.text);
  const b = await post(`/api/rooms/${SLUG}/micclip`, U.bob, { tx: TX });
  assert.equal(b.status, 200, b.text);
  const jobs = micJobs();
  const j = jobs.find((x) => x.id === r.d.id), jb = jobs.find((x) => x.id === b.d.id);
  assert.ok(j && j.clip_acct === 1 && j.camfrog === "" && j.user_id === NOLINK_ID && j.user === "nolink" && j.actor && j.actor.login === null && j.target === "carolcf",
            "the account's job: clip_acct 1, no Camfrog name, the account as actor - " + JSON.stringify(j));
  assert.ok(jb && !("clip_acct" in jb) && jb.camfrog === "bobcf", "a linked account's job is exactly as before");
  // an old job: the owner switched it back ON before Pepe took it - failed with LINK, never handed out
  micclip._clips.clear(); relay._hits.clear();
  const o = await post(`/api/rooms/${SLUG}/micclip`, U.other, { tx: TX });
  assert.equal(o.status, 200, o.text);
  await setLink(true);
  assert.ok(!micJobs().some((x) => x.id === o.d.id), "not handed out once the pad needs a link again");
  const v = await get(`/api/rooms/${SLUG}/micclip/${o.d.id}`, U.other);
  assert.deepEqual([v.d.state, v.d.status], ["failed", LINK], "the page shows the LINK answer");
});

test("🔊 Post: the unlinked account's micclip.save carries no Camfrog name; the claim marks it clip_acct: 1 only while the switch is off", async () => {
  await ready();
  AC._setClip(Date.now());
  await setLink(false);
  const r = await post(`/api/rooms/${SLUG}/micclip`, U.nolink, { tx: TX });
  assert.equal(r.status, 200, r.text);
  micJobs();
  assert.equal((await post("/api/bridge/micclip", null, { password: "bot", id: r.d.id, state: "ok", target: "carolcf", secs: 6, text: "i am talking on the mic",
    data: M4A.toString("base64"), save: "on", viewer_ok: true, cost: 500 })).status, 200);
  assert.deepEqual((await get(`/api/rooms/${SLUG}/micclip/${r.d.id}`, U.nolink)).d.save, { cost: 500, id: null }, "Pepe's price for the account, shown before paying");
  const s = await post(`/api/rooms/${SLUG}/micclip/${r.d.id}/save`, U.nolink, { start: 0, end: 6000 });
  assert.equal(s.status, 200, s.text);
  const row = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [s.d.id]))[0];
  assert.deepEqual([row.kind, row.camfrog, row.user_id, row.username], ["micclip.save", null, NOLINK_ID, "nolink"]);
  const claim = async (cap = 1) => {
    await runQuery("UPDATE pepe_actions SET status = 'pending', claimed = NULL WHERE id = ?", [s.d.id]);
    const c = await post("/api/actions/claim", null, { password: "bot", actor_cap: 1, clipacct_cap: cap });
    return (c.d.actions || []).find((a) => a.id === s.d.id);
  };
  let a = await claim();
  assert.ok(a && a.clip_acct === 1 && a.camfrog === null && a.actor.userId === NOLINK_ID && a.actor.login === null, "claimed with clip_acct: 1 - " + JSON.stringify(a));
  await setLink(true);
  a = await claim();
  assert.ok(a && !("clip_acct" in a), "the switch back on: no flag (Pepe refuses it as before)");
  AC._setClip(0);
  await setLink(false);
  await runQuery("UPDATE pepe_actions SET status = 'pending', claimed = NULL WHERE id = ?", [s.d.id]);
  const c = await post("/api/actions/claim", null, { password: "bot", actor_cap: 1 });
  assert.ok(!("clip_acct" in ((c.d.actions || []).find((x) => x.id === s.d.id) || {})), "a Pepe that doesn't say clipacct_cap never gets the flag");
  // the save itself needs the switch off (and a capable Pepe), like the request
  AC._setClip(Date.now());
  await setLink(true);
  micclip._clips.get(r.d.id).save = null;
  relay._hits.clear();
  const no = await post(`/api/rooms/${SLUG}/micclip/${r.d.id}/save`, U.nolink, { start: 0, end: 6000 });
  assert.deepEqual([no.status, no.d.error], [403, LINK]);
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE id = ?", [s.d.id]);
});

test("the pad post: credited to the account Pepe acted as (u:<userId> + its username, the id checked); the capture names it by id", async () => {
  await ready();
  const up = async (id, extra) => post("/api/media", null, Object.assign({ password: "bot", id, kind: "audio", ct: "audio/mp4", image: M4A.toString("base64"), secs: 6,
    subject: "carolcf", by: "\u{1f310} No Link", room: ROOM.id, subject_login: "carolcf", created: Date.now(), expires: Date.now() + 86400e3 }, extra));
  const mid = "cd".repeat(8);
  assert.equal((await up(mid, { by_uid: NOLINK_ID })).status, 200);
  const m = (await getQuery("SELECT by_user, by_login, by_user_id FROM media WHERE id = ?", [mid]))[0];
  assert.deepEqual(m, { by_user: "\u{1f310} No Link", by_login: null, by_user_id: NOLINK_ID }, "media.js keeps the account Pepe named (by_uid)");
  assert.equal((await post("/api/bridge/micclip/post", null, { password: "bot", media: mid, by: "u:" + OTHER_ID, user: "nolink", speakers: ["carolcf"], caption: "x" })).status, 409,
               "the account id must be the asking account's");
  const r = await post("/api/bridge/micclip/post", null, { password: "bot", media: mid, by: "u:" + NOLINK_ID, user: "nolink", speakers: ["carolcf"],
    caption: "i am talking on the mic", secs: 6 });
  assert.equal(r.status, 200, r.text);
  const p = await store.get(r.d.id, U.bob);
  assert.equal(p.author.username, "nolink", "credited to the PATV account");
  const fv = (await getQuery("SELECT by_login, logins FROM feed_voices WHERE post_id = ?", [r.d.id]))[0];
  assert.deepEqual([fv.by_login, fv.logins.trim()], ["", "carolcf"], "no Camfrog login is recorded for the clipper; the speaker can Remove me");
  // without the id on the capture the account isn't its capturer - the post is refused (why media.js keeps by_uid)
  const mid2 = "ce".repeat(8);
  assert.equal((await up(mid2, {})).status, 200);
  assert.equal((await post("/api/bridge/micclip/post", null, { password: "bot", media: mid2, by: "u:" + NOLINK_ID, user: "nolink", speakers: ["carolcf"], caption: "y" })).status, 403);
  // a Camfrog login's post is unchanged
  const mid3 = "cf".repeat(8);
  assert.equal((await up(mid3, { by: "bobcf", by_login: "bobcf", by_uid: NOLINK_ID })).status, 200);
  assert.equal((await getQuery("SELECT by_user_id FROM media WHERE id = ?", [mid3]))[0].by_user_id, null, "a capture with a Camfrog login never takes an account id");
  const rb = await post("/api/bridge/micclip/post", null, { password: "bot", media: mid3, by: "bobcf", user: "bob", speakers: ["carolcf"], caption: "z" });
  assert.equal(rb.status, 200, rb.text);
  assert.equal((await store.get(rb.d.id, U.bob)).author.username, "bob");
  assert.equal((await getQuery("SELECT by_login FROM feed_voices WHERE post_id = ?", [rb.d.id]))[0].by_login, "bobcf");
});

test("🎬 cam clips: 🎬 Clip greys with LINK unless the switch is off; the request and the save carry the account the same way", async () => {
  await ready();
  AC._setClip(Date.now());
  await setLink(true);
  const R = bridge.bySlug(SLUG);
  assert.equal((await camclip.clipInfo(R, NOLINK_ID, "subjcf")).off, LINK, "switch ON: greyed with LINK");
  let r = await post(`/api/rooms/${SLUG}/camclip`, U.nolink, { login: "subjcf", secs: 10 });
  assert.deepEqual([r.status, r.d.error], [403, LINK]);
  await setLink(false);
  assert.equal((await camclip.clipInfo(R, NOLINK_ID, "subjcf")).off, null, "switch OFF: the button works for an unlinked account");
  AC._setClip(0);
  assert.equal((await camclip.clipInfo(R, NOLINK_ID, "subjcf")).off, LINK, "an older Pepe: still LINK");
  AC._setClip(Date.now());
  r = await post(`/api/rooms/${SLUG}/camclip`, U.nolink, { login: "subjcf", secs: 10 });
  assert.equal(r.status, 200, r.text);
  const j = relay.takeJobs(new Set([ROOM.id])).find((x) => x.id === r.d.id);
  assert.ok(j && j.kind === "camclip" && j.clip_acct === 1 && j.camfrog === "" && j.user_id === NOLINK_ID, "the account's cam job: " + JSON.stringify(j));
  assert.equal((await post("/api/bridge/camclip", null, { password: "bot", id: r.d.id, state: "ok", data: MP4.toString("base64"), secs: 10,
    save: "on", viewer_ok: true, cost: 50000 })).status, 200);
  const s = await post(`/api/rooms/${SLUG}/camclip/${r.d.id}/save`, U.nolink, {});
  assert.equal(s.status, 200, s.text);
  const row = (await getQuery("SELECT kind, camfrog, args FROM pepe_actions WHERE id = ?", [s.d.id]))[0];
  assert.deepEqual([row.kind, row.camfrog, JSON.parse(row.args)], ["camclip.save", null, [ROOM.id, "subjcf", r.d.id]]);
  await runQuery("UPDATE pepe_actions SET status = 'pending', claimed = NULL WHERE id = ?", [s.d.id]);
  const a = ((await post("/api/actions/claim", null, { password: "bot", actor_cap: 1, clipacct_cap: 1 })).d.actions || []).find((x) => x.id === s.d.id);
  assert.ok(a && a.clip_acct === 1, "claimed with clip_acct: 1");
  // the switch back on: an old request is failed at hand-out, and saving is LINK again
  camclip._clips.clear(); relay._hits.clear();
  const o = await post(`/api/rooms/${SLUG}/camclip`, U.other, { login: "subjcf", secs: 10 });
  assert.equal(o.status, 200, o.text);
  await setLink(true);
  assert.ok(!relay.takeJobs(new Set([ROOM.id])).some((x) => x.id === o.d.id), "not handed out once the pad needs a link again");
  const v = await get(`/api/rooms/${SLUG}/camclip/${o.d.id}`, U.other);
  assert.deepEqual([v.d.state, v.d.status], ["failed", LINK]);
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE id = ?", [s.d.id]);
});

test("the pad page offers 🔊 Clip to an unlinked account only while the switch is off and Pepe can", async () => {
  await ready();
  const page = async (who) => (await call("GET", `/p/${SLUG}`, who, undefined, { "x-test-user": who.userId })).text;
  const linkedFlag = (html) => (/slug: slug, linked: (true|false) \}\) : null;/.exec(html) || [])[1];
  AC._setClip(Date.now());
  await setLink(true);
  assert.equal(linkedFlag(await page(U.nolink)), "false");
  await setLink(false);
  assert.equal(linkedFlag(await page(U.nolink)), "true");
  AC._setClip(0);
  assert.equal(linkedFlag(await page(U.nolink)), "false", "an older Pepe: no button");
  assert.equal(linkedFlag(await page(U.bob)), "true", "a linked account: as before");
  await setLink(true);
});

test("the setting moves with its pad (padrekey: a room_id column; the cache reloads)", async () => {
  await ready();
  const RK = require(path.join(repo, "padrekey"));
  assert.ok(!RK.ROOM_BOUND.has("pad_clip_cfg"), "the pad's setting, not the Camfrog room's");
  await runQuery("INSERT OR REPLACE INTO pad_clip_cfg (room_id, need_link, updated) VALUES ('patv:movepad', 0, 1)");
  await CLK.loadCache();
  assert.equal(CLK.needLink("patv:movepad"), false);
  await RK.rekey("patv:movepad", "Move.Room");
  await RK.reloadCaches();
  assert.deepEqual([CLK.needLink("patv:movepad"), CLK.needLink("Move.Room")], [true, false]);
  await runQuery("DELETE FROM pad_clip_cfg WHERE room_id = 'Move.Room'");
  await CLK.loadCache();
});
