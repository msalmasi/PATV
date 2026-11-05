// rankrule (the owner, 2026-11-05: "Rank rule - refuse actions on equal or higher-ranked staff."): every per-account staff SANCTION
// route on the website refuses PATV staff of the actor's rank or above (staffrank.js: Assistant < Staff < Admin < the owner) and the
// actor's own account / alt - before anything is written - in the same words, with code "staff_rank" / "self":
//   site / pad bans (the person menu's ban sheet, /api/feed/ban, the feed's report actions, the DM report action), network bans,
//   web bridge blocks (every room / one pad), the main stage ban (+ cut + ban), a pad's stage ban, creator pause / ban, the stage cover
//   take-down, sign out everywhere, account deletion, the name-clash rename, the per-login chat tool's hide / delete every line, pad
//   vault fines and transfers
// Lifts (unban, unblock, reinstate, put back up, cancel, un-hide, let through) are never refused for rank - only your own. The owner may
// act on an Admin (padbans refused that before). Pepe's bot-token routes keep Pepe's own ladder.
//   TZ=UTC node --test test/rankrule.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rankrule-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PB = require(path.join(repo, "padbans"));
const BB = require(path.join(repo, "bridgeblocks"));
const NB = require(path.join(repo, "netban"));
const SP = require(path.join(repo, "siteperms"));
const EN = require(path.join(repo, "locales", "en.json"));
require(path.join(repo, "terms"))._setRequired(false);

const RANK = EN["staffrank.refused"], SELF = EN["staffrank.self"];
const U = {};
const PAD = "Rank.Room";
let base, server, SLUG;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, discordUsername TEXT, twitchDisplayname TEXT,
                  level INTEGER DEFAULT 0, avatar TEXT, created_at TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER, xp INTEGER DEFAULT 0, email TEXT)`);
  const mk = async (key, id, name, cls = "pleb", cf = null) => {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?, 1000)", [id, name, name, cf, cls]);
    U[key] = { userId: id, username: name, class: cls, camfrogUsername: cf };
  };
  await mk("owner", "own-0001", "theowner", "Admin", "ownercf");
  await mk("owner2", "own-0002", "ownertwo", "Admin", "owner2cf");
  await mk("admin", "adm-0001", "adminone", "Admin", "admincf");
  await mk("admin2", "adm-0002", "admintwo", "Admin");
  await mk("staff", "stf-0001", "staffer", "Staff", "staffcf");
  await mk("staff2", "stf-0002", "stafftwo", "Staff");
  await mk("asst", "ast-0001", "helper", "Assistant");
  await mk("asst2", "ast-0002", "helpertwo", "Assistant");
  await mk("member", "mem-0001", "member", "pleb", "membercf");
  await mk("member2", "mem-0002", "membertwo", "pleb");
  await mk("alt", "alt-0001", "stafferalt", "pleb", "StaffCF");
  await mk("padowner", "pad-0001", "padowner", "pleb", "padownercf");
  await mk("pepe", "pepe-bot", "Pepe", "Bot");
  await require(path.join(repo, "staffroles")).init();
  for (const [login, role] of [["ownercf", "owner"], ["owner2cf", "owner"], ["admincf", "admin"], ["staffcf", "staff"]]) {
    await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES (?, ?, 1)", [login, role]);
  }
  await SP.init();
  await rooms.init();
  await rooms.addRoom(PAD, "Rank Room", "test");
  await rooms.setOwner(PAD, "padowner", "test");
  SLUG = (await rooms.get(PAD)).slug || PAD;
  await BB.init(); await PB.init(); await NB.init();
  for (const m of ["feedstore", "mainstage", "stagecover", "creators", "sessions", "messages", "accountdelete", "cfnames"]) await require(path.join(repo, m)).init();
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // (a German viewer for one check: the refusal is said through req.t)
  app.use((req, res, next) => { if (req.get("x-test-lang") === "xx") req.t = (k) => "[xx] " + (EN[k] || k); else req.t = (k) => EN[k] || k; next(); });
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? U[u] || null : null; next(); };
  const isBotToken = (t) => t === "bot-token";
  // (as index.js builds it: roomsweb's routes before bridge.js's padbans routes - they share /api/rooms/:slug/ban|unban)
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: () => false });
  PB.register(app, { addUser });
  BB.register(app, { addUser, isBotToken });
  NB.register(app, { addUser });
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken });
  require(path.join(repo, "messages")).register(app, { addUser, isBotToken });
  require(path.join(repo, "mainstage")).register(app, { addUser, isBotToken: () => false, noTimers: true });
  require(path.join(repo, "stagecover")).register(app, { addUser, noTimers: true });
  require(path.join(repo, "creatorsweb")).register(app, { addUser, isBotToken: () => false });
  require(path.join(repo, "sessions")).register(app, { addUser });
  require(path.join(repo, "accountdelete")).register(app, { addUser, isBotToken: () => false });
  require(path.join(repo, "cfnames")).register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
test.beforeEach(() => PB._reset());

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base, referer: base + "/admin" }, u ? { "x-test-user": u } : {}, extra);
const post = (p, u, body, extra) => fetch(base + p, { method: "POST", headers: H(u, extra), body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) }));
const n = async (sql, args = []) => Number((await getQuery(sql, args))[0].n);
/** a refusal: the status, the shared words, the code */
const refused = (r, why, msg) => {
  assert.equal(r.status, why === "self" ? 400 : 403, (msg || "") + " " + JSON.stringify(r.d));
  assert.equal(r.d.error, why === "self" ? SELF : RANK, msg);
  if (r.d.code !== undefined) assert.equal(r.d.code, why === "self" ? "self" : "staff_rank", msg);
};
const okay = (r, msg) => assert.ok(r.status === 200 && r.d.ok !== false, (msg || "") + " " + r.status + " " + JSON.stringify(r.d));
const profileSlug = async (k) => (await rooms.ensureProfile(U[k].userId)).slug;
const acct = (k) => ({ k: "acct", v: "u:" + U[k].userId });
const clear = async (...tables) => { for (const t of tables) await runQuery("DELETE FROM " + t).catch(() => {}); };

// ── site / pad bans ──
test("the ban sheet (/api/rooms/:slug/ban): the owner may ban an Admin site-wide (padbans refused it), never another owner; the shared words", async () => {
  let r = await post(`/api/rooms/${await profileSlug("admin")}/ban`, "owner", { ref: acct("admin"), scope: "site", dur: "1h", reason: "x" });
  okay(r, "owner -> Admin");
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_bans WHERE user_id = ? AND room_id = ''", [U.admin.userId]), 1);
  r = await post(`/api/rooms/${await profileSlug("owner2")}/ban`, "owner", { ref: acct("owner2"), scope: "site", dur: "1h", reason: "x" });
  refused(r, "rank", "owner -> owner");
  r = await post(`/api/rooms/${await profileSlug("owner")}/ban`, "admin2", { ref: acct("owner"), scope: "site", dur: "1h", reason: "x" });
  refused(r, "rank", "Admin -> owner");
  r = await post(`/api/rooms/${await profileSlug("admin2")}/ban`, "admin", { ref: acct("admin2"), scope: "site", dur: "1h", reason: "x" });
  refused(r, "rank", "Admin -> Admin");
  r = await post(`/api/rooms/${await profileSlug("admin2")}/ban`, "staff", { ref: acct("admin2"), scope: "site", dur: "1h", reason: "x" }, { "x-test-lang": "xx" });
  assert.equal(r.status, 403); assert.equal(r.d.error, "[xx] " + RANK, "said in the viewer's language"); assert.equal(r.d.code, "staff_rank");
  // lifts: never your own (the banned Admin can't lift their own site ban); never refused for rank - Staff may lift the Admin's
  r = await post(`/api/rooms/${await profileSlug("admin")}/unban`, "admin", { ref: acct("admin"), scope: "site" });
  refused(r, "self", "your own ban");
  r = await post(`/api/rooms/${await profileSlug("admin")}/unban`, "staff", { ref: acct("admin"), scope: "site" });
  okay(r, "a lift on someone above you");
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_bans WHERE user_id = ?", [U.admin.userId]), 0);
  await clear("feed_bans", "bridge_blocks");
});

test("/api/feed/ban (site / a pad) and /api/feed/unban: never staff of your rank or above, never yourself or your alt; nothing written", async () => {
  const rows = () => n("SELECT COUNT(*) AS n FROM feed_bans");
  for (const [who, target] of [["staff", "admin"], ["staff", "staff2"], ["admin", "admin2"], ["admin", "owner"], ["owner", "owner2"]]) {
    refused(await post("/api/feed/ban", who, { user: "u:" + U[target].userId, reason: "x" }), "rank", `${who} -> ${target}`);
  }
  refused(await post("/api/feed/ban", "staff", { user: "u:" + U.staff.userId }), "self", "yourself");
  refused(await post("/api/feed/ban", "staff", { user: "u:" + U.alt.userId }), "self", "your own alt (the same linked login)");
  assert.equal(await rows(), 0, "nothing written");
  okay(await post("/api/feed/ban", "staff", { user: "u:" + U.member.userId, reason: "spam" }), "Staff -> member");
  okay(await post("/api/feed/ban", "admin", { user: "u:" + U.staff2.userId, reason: "spam" }), "Admin -> Staff");
  okay(await post("/api/feed/ban", "owner", { user: "u:" + U.admin2.userId, reason: "spam" }), "owner -> Admin");
  // a pad's own ban (its owner, or staff through pads.manage_any): the same rule (the ban sheet's pad scope already had it)
  refused(await post("/api/feed/ban", "padowner", { user: "u:" + U.asst.userId, room: SLUG }), "rank", "a pad owner -> an Assistant");
  refused(await post("/api/feed/ban", "staff", { user: "u:" + U.admin.userId, room: SLUG }), "rank", "Staff managing a pad -> an Admin");
  okay(await post("/api/feed/ban", "padowner", { user: "u:" + U.member2.userId, room: SLUG }), "a pad owner -> a member");
  // lifts: never your own; a higher-ranked person's: yes
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, '', ?, 'x', 'theowner', ?, NULL)", [U.staff.userId, U.staff.username, Date.now()]);
  refused(await post("/api/feed/unban", "staff", { userId: U.staff.userId }), "self", "your own ban");
  okay(await post("/api/feed/unban", "staff", { userId: U.admin2.userId }), "Staff lifts an Admin's ban (made by the owner)");
  okay(await post("/api/feed/unban", "admin", { userId: U.staff.userId }));
  await clear("feed_bans");
});

test("the feed's report actions: 'ban' is refused BEFORE the post is removed or the reports resolved; dismiss / remove stay content actions", async () => {
  const now = Date.now();
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created) VALUES ('rkpost0001', ?, 't', 'admin post', ?), ('rkpost0002', ?, 't', 'member post', ?)", [U.admin.userId, now, U.member.userId, now]);
  await runQuery("INSERT INTO feed_reports (post_id, comment_id, reporter_id, reason, created) VALUES ('rkpost0001', NULL, ?, 'spam', ?), ('rkpost0002', NULL, ?, 'spam', ?)", [U.member2.userId, now, U.member2.userId, now]);
  let r = await post("/api/feed/admin/report-action", "staff", { post: "rkpost0001", action: "ban", reason: "x", notify: false });
  refused(r, "rank", "Staff bans an Admin from a report");
  const p = (await getQuery("SELECT deleted_at FROM feed_posts WHERE id = 'rkpost0001'"))[0];
  assert.equal(p.deleted_at, null, "the post stays (nothing changed)");
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_reports WHERE post_id = 'rkpost0001' AND resolved_at IS NULL"), 1, "the report stays open");
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_bans"), 0);
  okay(await post("/api/feed/admin/report-action", "staff", { post: "rkpost0002", action: "ban", reason: "x", notify: false }), "a member's post");
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_bans WHERE user_id = ?", [U.member.userId]), 1);
  // the account report queue
  await runQuery("INSERT INTO user_reports (target_id, reporter_id, reason, note, created) VALUES (?, ?, 'spam', '', ?), (?, ?, 'spam', '', ?)",
                 [U.admin.userId, U.member2.userId, now, U.staff2.userId, U.member2.userId, now]);
  r = await post("/api/feed/admin/user-report-action", "staff", { userId: U.admin.userId, action: "ban", notify: false });
  refused(r, "rank", "Staff bans an Admin from the account queue");
  assert.equal(await n("SELECT COUNT(*) AS n FROM user_reports WHERE target_id = ? AND resolved_at IS NULL", [U.admin.userId]), 1, "still open");
  okay(await post("/api/feed/admin/user-report-action", "staff", { userId: U.admin.userId, action: "dismiss", notify: false }), "dismiss: not a sanction");
  okay(await post("/api/feed/admin/user-report-action", "admin", { userId: U.staff2.userId, action: "ban", notify: false }), "Admin -> Staff");
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_bans WHERE user_id = ? AND room_id = ''", [U.staff2.userId]), 1);
  await clear("feed_bans", "feed_reports", "user_reports", "feed_posts");
});

test("the DM report action: 'ban' is refused before the message is deleted (Admins: dm.report_review); the owner may", async () => {
  const now = Date.now();
  await runQuery("INSERT INTO conversations (id, kind, created_by, created_at) VALUES ('cv-1', 'dm', ?, ?)", [U.admin2.userId, now]);
  await runQuery("INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (901, 'cv-1', ?, 'hello', ?)", [U.admin2.userId, now]);
  await runQuery("INSERT INTO dm_reports (message_id, conversation_id, sender_id, reporter_id, reason, created) VALUES (901, 'cv-1', ?, ?, 'spam', ?)", [U.admin2.userId, U.member.userId, now]);
  let r = await post("/api/messages/admin/report-action", "admin", { message: 901, action: "ban", notify: false });
  refused(r, "rank", "Admin -> Admin");
  assert.equal((await getQuery("SELECT deleted_at FROM messages WHERE id = 901"))[0].deleted_at, null, "the message stays");
  assert.equal(await n("SELECT COUNT(*) AS n FROM dm_reports WHERE resolved_at IS NULL"), 1);
  r = await post("/api/messages/admin/report-action", "owner", { message: 901, action: "ban", notify: false });
  okay(r, "owner -> Admin");
  assert.ok((await getQuery("SELECT deleted_at FROM messages WHERE id = 901"))[0].deleted_at);
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_bans WHERE user_id = ?", [U.admin2.userId]), 1);
  await clear("feed_bans", "dm_reports", "messages", "conversations");
});

// ── networks + the web bridge ──
test("network bans of an account: never an Admin by an Admin, never yourself; the owner may; 'let through' is a lift (never yourself)", async () => {
  NB._setOn(true);
  try {
    refused(await post("/api/admin/netbans", "admin", { op: "account", target: "u:" + U.admin2.userId, days: 1, reason: "x" }), "rank", "Admin -> Admin");
    refused(await post("/api/admin/netbans", "admin", { op: "account", target: "u:" + U.owner.userId, days: 1, reason: "x" }), "rank", "Admin -> owner");
    refused(await post("/api/admin/netbans", "admin", { op: "account", target: "u:" + U.admin.userId, days: 1, reason: "x" }), "self", "yourself");
    okay(await post("/api/admin/netbans", "owner", { op: "account", target: "u:" + U.admin.userId, days: 1, reason: "x" }), "owner -> Admin");
    okay(await post("/api/admin/netbans", "admin", { op: "account", target: "u:" + U.staff.userId, days: 1, reason: "x" }), "Admin -> Staff");
    assert.ok((await getQuery("SELECT 1 FROM admin_audit WHERE action = 'net_ban'")).length, "audited as before");
    refused(await post("/api/admin/netbans", "admin", { op: "exempt", target: "u:" + U.admin.userId, ids: [1], reason: "x" }), "self", "letting yourself through");
    okay(await post("/api/admin/netbans", "admin", { op: "exempt", target: "u:" + U.owner.userId, ids: [1], reason: "shared wifi" }), "a lift on someone above you");
    // lifting a ban made on an account's networks: never your own (the list's Lift, by ban ids)
    const id = (await runQuery("INSERT INTO net_bans (net_hash, scope, from_user, until, by_id, by_name, created) VALUES ('h-rank-1', 'site', ?, NULL, ?, 'theowner', ?)",
                               [U.admin.userId, U.owner.userId, Date.now()])).id;
    refused(await post("/api/admin/netbans", "admin", { op: "lift", ids: [id] }), "self", "lifting the ban on your own networks");
    assert.equal((await getQuery("SELECT lifted_at FROM net_bans WHERE id = ?", [id]))[0].lifted_at, null);
    okay(await post("/api/admin/netbans", "admin2", { op: "lift", ids: [id] }), "another Admin lifts it (a lift)");
    assert.ok((await getQuery("SELECT lifted_at FROM net_bans WHERE id = ?", [id]))[0].lifted_at);
  } finally { NB._setOn(false); }
});

test("web bridge blocks - every room (/api/admin/bridge/blocks) and one pad (/api/rooms/:slug/blocks); Pepe's bot route keeps his own rules", async () => {
  const blocks = (uid) => n("SELECT COUNT(*) AS n FROM bridge_blocks WHERE user_id = ?", [uid]);
  refused(await post("/api/admin/bridge/blocks", "admin", { op: "block", room: "", target: "u:" + U.admin2.userId, features: ["chat"], hours: "1", reason: "x" }), "rank", "Admin -> Admin");
  refused(await post("/api/admin/bridge/blocks", "admin", { op: "block", room: PAD, target: "u:" + U.owner.userId, hours: "1" }), "rank", "Admin -> owner, one room");
  refused(await post("/api/admin/bridge/blocks", "admin", { op: "block", room: "", target: "u:" + U.admin.userId, hours: "1" }), "self", "yourself");
  assert.equal(await blocks(U.admin2.userId) + await blocks(U.owner.userId) + await blocks(U.admin.userId), 0);
  okay(await post("/api/admin/bridge/blocks", "owner", { op: "block", room: "", target: "u:" + U.admin.userId, features: ["chat"], hours: "1", reason: "x" }), "owner -> Admin");
  okay(await post("/api/admin/bridge/blocks", "admin", { op: "block", room: "", target: "u:" + U.staff.userId, hours: "1", reason: "x" }), "Admin -> Staff");
  refused(await post("/api/admin/bridge/blocks", "admin", { op: "unblock", room: "", target: "u:" + U.admin.userId }), "self", "lifting your own");
  okay(await post("/api/admin/bridge/blocks", "admin2", { op: "unblock", room: "", target: "u:" + U.admin.userId }), "an Admin lifts another's (a lift)");
  assert.equal(await blocks(U.admin.userId), 0);
  // a pad's own page: its owner (a member) can't block PATV staff; Staff through pads.manage_any can't block an Admin
  refused(await post(`/api/rooms/${SLUG}/blocks`, "padowner", { op: "block", target: "u:" + U.asst.userId, hours: "1" }), "rank", "pad owner -> Assistant");
  refused(await post(`/api/rooms/${SLUG}/blocks`, "staff", { op: "block", target: "u:" + U.admin.userId, hours: "1" }), "rank", "Staff -> Admin on a pad");
  refused(await post(`/api/rooms/${SLUG}/blocks`, "padowner", { op: "block", target: "u:" + U.padowner.userId, hours: "1" }), "self");
  okay(await post(`/api/rooms/${SLUG}/blocks`, "padowner", { op: "block", target: "u:" + U.member.userId, hours: "1", reason: "x" }), "pad owner -> member");
  okay(await post(`/api/rooms/${SLUG}/blocks`, "padowner", { op: "unblock", target: "u:" + U.staff.userId }), "a lift");
  // Pepe's !bridge block (bot token): his own ladder decides (unchanged)
  const bot = await fetch(base + "/api/bridge/blocks", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", op: "block", room: PAD, target: "u:" + U.admin.userId, by: "ownercf" }) }).then((x) => x.json());
  assert.equal(bot.ok, true, JSON.stringify(bot));
  await clear("bridge_blocks");
});

// ── the stage ──
test("the main stage ban (/stage/admin, the profile's 🎬): Staff never on Staff / an Admin / yourself / your alt; the owner on an Admin", async () => {
  const bans = () => n("SELECT COUNT(*) AS n FROM stage_bans");
  refused(await post("/api/stage/admin/ban", "staff", { userId: U.admin.userId, reason: "x" }), "rank", "Staff -> Admin (by id)");
  refused(await post("/api/stage/admin/ban", "staff", { username: "stafftwo", reason: "x" }), "rank", "Staff -> Staff (a typed name)");
  refused(await post("/api/stage/admin/ban", "staff", { username: "staffer", reason: "x" }), "self");
  refused(await post("/api/stage/admin/ban", "staff", { userId: U.alt.userId, reason: "x" }), "self", "your own alt");
  refused(await post("/api/stage/admin/ban", "admin", { userId: U.owner.userId, reason: "x" }), "rank", "Admin -> owner");
  assert.equal(await bans(), 0);
  okay(await post("/api/stage/admin/ban", "admin", { userId: U.staff.userId, reason: "loud" }), "Admin -> Staff");
  okay(await post("/api/stage/admin/ban", "owner", { userId: U.admin.userId, reason: "loud" }), "owner -> Admin");
  refused(await post("/api/stage/admin/unban", "staff", { userId: U.staff.userId }), "self", "lifting your own");
  okay(await post("/api/stage/admin/unban", "staff", { userId: U.admin.userId }), "a lift on someone above you");
  // cut + ban: refused before the cut (a refused ban cuts nothing); a cut alone is programming
  const T = Date.now();
  await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held, stream, publishing, settled, kind, mode, source)
                  VALUES ('rk-1', ?, 'admintwo', 'admintwo', 'active', ?, 30, 0, 0, 'rk-stream-1', 0, 0, 'slot', 'stream', 'rtmp')`, [U.admin2.userId, T]);
  refused(await post("/api/stage/admin/cut", "staff", { id: "rk-1", ban: true, reason: "x" }), "rank", "Staff cut + ban of an Admin");
  assert.equal((await getQuery("SELECT status FROM stage_slots WHERE id = 'rk-1'"))[0].status, "active", "not cut");
  await clear("stage_bans", "stage_slots", "stage_events");
});

test("a pad's own stage ban (the room page's form, /api/rooms/:slug/ban {username}): its owner never on PATV staff", async () => {
  const bans = () => n("SELECT COUNT(*) AS n FROM stage_room_bans");
  refused(await post(`/api/rooms/${SLUG}/ban`, "padowner", { username: "helper", reason: "x" }), "rank", "pad owner -> Assistant");
  refused(await post(`/api/rooms/${SLUG}/ban`, "staff", { username: "adminone", reason: "x" }), "rank", "Staff managing the pad -> Admin");
  assert.equal(await bans(), 0);
  okay(await post(`/api/rooms/${SLUG}/ban`, "padowner", { username: "member", reason: "x" }), "pad owner -> member");
  okay(await post(`/api/rooms/${SLUG}/unban`, "padowner", { userId: U.member.userId }), "the lift");
  assert.equal(await bans(), 0);
});

// ── accounts ──
test("creator status: pause / ban / back to pending never on staff of your rank or above; never your own (approving yourself too); reinstate is a lift", async () => {
  const now = Date.now();
  for (const k of ["admin", "staff", "staff2", "member"]) await runQuery("INSERT INTO creators (user_id, status, rating, created, updated) VALUES (?, 'active', 'sfw', ?, ?)", [U[k].userId, now, now]);
  await require(path.join(repo, "creators")).init();
  const st = async (k) => (await getQuery("SELECT status FROM creators WHERE user_id = ?", [U[k].userId]))[0].status;
  refused(await post(`/api/admin/creators/${U.admin.userId}/status`, "staff", { action: "paused", note: "x" }), "rank", "Staff -> Admin");
  refused(await post(`/api/admin/creators/${U.staff2.userId}/status`, "staff", { action: "banned", note: "x" }), "rank", "Staff -> Staff");
  refused(await post(`/api/admin/creators/${U.staff2.userId}/status`, "staff", { action: "pending" }), "rank", "back to pending");
  refused(await post(`/api/admin/creators/${U.staff.userId}/status`, "staff", { action: "paused" }), "self");
  assert.equal(await st("admin"), "active"); assert.equal(await st("staff2"), "active");
  okay(await post(`/api/admin/creators/${U.staff.userId}/status`, "admin", { action: "paused", note: "check" }), "Admin -> Staff");
  okay(await post(`/api/admin/creators/${U.member.userId}/status`, "staff", { action: "paused", note: "check" }), "Staff -> member");
  refused(await post(`/api/admin/creators/${U.staff.userId}/status`, "staff", { action: "active" }), "self", "reinstating / approving yourself");
  okay(await post(`/api/admin/creators/${U.staff.userId}/status`, "staff2", { action: "active" }), "reinstate: a lift");
  assert.equal(await st("staff"), "active");
  await clear("creators");
});

test("the stage cover take-down: never an Admin's by an Admin, never your own; the owner may; 'put it up' is a lift (never your own)", async () => {
  for (const k of ["admin", "admin2", "staff"]) await runQuery("INSERT INTO stage_covers (user_id, upload) VALUES (?, 'pic.webp')", [U[k].userId]);
  const up = async (k) => (await getQuery("SELECT upload FROM stage_covers WHERE user_id = ?", [U[k].userId]))[0].upload;
  refused(await post("/api/admin/stage-cover/remove", "admin", { user_id: U.admin2.userId }), "rank", "Admin -> Admin");
  refused(await post("/api/admin/stage-cover/remove", "admin", { user_id: U.admin.userId }), "self");
  assert.equal(await up("admin2"), "pic.webp", "still up");
  okay(await post("/api/admin/stage-cover/remove", "owner", { user_id: U.admin2.userId }), "owner -> Admin");
  okay(await post("/api/admin/stage-cover/remove", "admin", { user_id: U.staff.userId }), "Admin -> Staff");
  assert.equal(await up("admin2"), null);
  await runQuery("UPDATE stage_covers SET upload = 'held.webp', upload_state = 'held' WHERE user_id = ?", [U.admin.userId]);
  refused(await post("/api/admin/stage-cover/release", "admin", { user_id: U.admin.userId }), "self", "putting your own held cover up");
  await clear("stage_covers");
});

test("sign out everywhere: never an Admin by an Admin, never yourself (Settings does that); the owner may", async () => {
  refused(await post(`/api/admin/users/${U.admin2.userId}/sessions/revoke`, "admin", { reason: "hacked", confirm: "admintwo" }), "rank", "Admin -> Admin");
  refused(await post(`/api/admin/users/${U.owner.userId}/sessions/revoke`, "admin", { reason: "hacked", confirm: "theowner" }), "rank", "Admin -> owner");
  refused(await post(`/api/admin/users/${U.admin.userId}/sessions/revoke`, "admin", { reason: "hacked", confirm: "adminone" }), "self");
  assert.equal(await n("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'sessions.revoke_all'"), 0, "nothing audited - nothing ran");
  okay(await post(`/api/admin/users/${U.admin2.userId}/sessions/revoke`, "owner", { reason: "hacked", confirm: "admintwo" }), "owner -> Admin");
  okay(await post(`/api/admin/users/${U.staff.userId}/sessions/revoke`, "admin", { reason: "hacked", confirm: "staffer" }), "Admin -> Staff");
});

test("deleting someone else's account: never an Admin by an Admin (the owner's to do), never yourself / your alt; cancelling is a lift (never your own)", async () => {
  const del = (who, k) => post(`/api/admin/users/${U[k].userId}/delete`, who, { reason: "asked", confirm: U[k].username });
  refused(await del("admin", "admin2"), "rank", "Admin -> Admin");
  refused(await del("admin", "owner"), "rank", "Admin -> owner");
  const self = await del("admin", "admin");
  assert.equal(self.status, 403); assert.equal(self.d.code, "E_SELF", "its own words, as before");
  assert.equal(await n("SELECT COUNT(*) AS n FROM account_deletions"), 0);
  const o = await del("owner", "admin2");
  assert.notEqual(o.d.code, "staff_rank", "the owner gets past the rank rule: " + JSON.stringify(o.d));
  // cancel: a deletion pending on your own account can't be cancelled by you here
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at, requested_by) VALUES (?, 'scheduled', ?, ?, 'admin:own-0001')", [U.admin.userId, Date.now(), Date.now() + 864e5])
    .catch(async () => runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at) VALUES (?, 'scheduled', ?, ?)", [U.admin.userId, Date.now(), Date.now() + 864e5]));
  const id = (await getQuery("SELECT id FROM account_deletions WHERE user_id = ? AND state = 'scheduled'", [U.admin.userId]))[0].id;
  refused(await post(`/api/admin/account-deletions/${id}/cancel`, "admin", { reason: "mine", confirm: "adminone" }), "self");
  okay(await post(`/api/admin/account-deletions/${id}/cancel`, "admin2", { reason: "asked", confirm: "adminone" }), "an Admin cancels another's (a lift)");
  await clear("account_deletions");
});

test("the name-clash rename: never an Admin by an Admin, never yourself; the owner may; 'it's OK' is a lift (never your own)", async () => {
  refused(await post("/api/admin/nameclash", "admin", { op: "rename", userId: U.admin2.userId, username: "admintwonew" }), "rank", "Admin -> Admin");
  refused(await post("/api/admin/nameclash", "admin", { op: "rename", userId: U.admin.userId, username: "adminonenew" }), "self");
  assert.equal((await getQuery("SELECT username FROM users WHERE userId = ?", [U.admin2.userId]))[0].username, "admintwo");
  const r = await post("/api/admin/nameclash", "owner", { op: "rename", userId: U.admin2.userId, username: "admintwonew" });
  okay(r, "owner -> Admin");
  await runQuery("UPDATE users SET username = 'admintwo' WHERE userId = ?", [U.admin2.userId]);
  refused(await post("/api/admin/nameclash", "admin", { op: "ok", userId: U.admin.userId, name: "adminone" }), "self", "marking your own clash OK");
  okay(await post("/api/admin/nameclash", "admin", { op: "ok", userId: U.owner.userId, name: "theowner" }), "a lift on someone above you");
});

test("the per-login chat tool: hide / delete every line never on staff of your rank or above or yourself; un-hide a lift; looks / holds aren't sanctions", async () => {
  const CL = require(path.join(repo, "chatlog"));
  await CL.init();
  const CLM = require(path.join(repo, "chatlogmod"));
  await CLM.init();
  const who = (u, key, action) => CLM.whoAction(U[u], key, { action, why: "a privacy request" });
  const isRank = (e) => e instanceof require(path.join(repo, "staffrank")).StaffRankError && e.code === "staff_rank" && e.message === RANK;
  const isSelf = (e) => e instanceof require(path.join(repo, "staffrank")).StaffRankError && e.code === "self";
  await assert.rejects(who("staff", "@adminone", "hide_all"), isRank);
  await assert.rejects(who("staff", "u:" + U.staff2.userId, "purge_all"), isRank);
  await assert.rejects(who("staff", "admincf", "purge_all"), isRank, "by the Admin's linked Camfrog login");
  await assert.rejects(who("staff", "@staffer", "hide_all"), isSelf);
  await assert.rejects(who("staff", "@staffer", "unhide_all"), isSelf, "un-hiding your own");
  assert.equal(await n("SELECT COUNT(*) AS n FROM chatlog_views WHERE kind = 'login_tool'"), 0, "refused before the audit row - nothing ran");
  assert.equal((await who("admin", "@staffer", "hide_all")).hidden, true, "Admin -> Staff");
  assert.ok((await who("staff", "@adminone", "look")).ok, "a look is not a sanction");
  assert.ok((await who("staff2", "@staffer", "unhide_all")).ok, "a lift");
  assert.ok((await who("staff", "membercf", "hide_all")).ok, "a member's login");
});

test("pad vault fines / transfers: never out of a pad owned by staff of your rank or above (your own pad: yes); the owner may", async () => {
  const PF = require(path.join(repo, "padfines"));
  await PF.init();
  await rooms.addRoom("Adm2.Room", "Admin Two's", "test"); await rooms.setOwner("Adm2.Room", "admintwo", "test");
  await rooms.addRoom("Adm1.Room", "Admin One's", "test"); await rooms.setOwner("Adm1.Room", "adminone", "test");
  const isRank = (e) => e && e.code === "staff_rank" && e.message === RANK;
  await assert.rejects(PF.request(U.admin, { op: "fine", from: "Adm2.Room", amount: 5, reason: "spam" }), isRank);
  await assert.rejects(PF.request(U.admin, { op: "transfer", from: "Adm2.Room", to: PAD, amount: 5, reason: "spam" }), isRank);
  assert.equal(await n("SELECT COUNT(*) AS n FROM pad_vault_admin_moves"), 0);
  // (review fix: PAT out of your OWN pad is no sanction on anyone - it was "That's you.")
  assert.ok((await PF.request(U.admin, { op: "fine", from: "Adm1.Room", amount: 5, reason: "my own pad" })).key, "an Admin, own pad");
  assert.ok((await PF.request(U.owner, { op: "fine", from: "Adm2.Room", amount: 5, reason: "spam" })).key, "owner -> an Admin's pad");
  assert.ok((await PF.request(U.admin, { op: "fine", from: PAD, amount: 5, reason: "spam" })).key, "a member's pad");
});

test("an Assistant holding a lowered key (an /admin/roles override): never on another Assistant or above; on a member yes", async () => {
  const keys = ["feed.moderate", "stage.admin", "bridge.blocks_global"];
  for (const k of keys) await runQuery("INSERT INTO site_perms (key, min_class, ts, by, by_level) VALUES (?, 'assistant', ?, 'test', 100)", [k, Date.now()]);
  await SP.reload();
  try {
    refused(await post("/api/feed/ban", "asst", { user: "u:" + U.asst2.userId }), "rank", "Assistant -> Assistant");
    refused(await post("/api/feed/ban", "asst", { user: "u:" + U.staff.userId }), "rank", "Assistant -> Staff");
    okay(await post("/api/feed/ban", "asst", { user: "u:" + U.member.userId }), "Assistant -> member");
    refused(await post("/api/stage/admin/ban", "asst", { userId: U.asst2.userId }), "rank");
    okay(await post("/api/stage/admin/ban", "asst", { userId: U.member.userId }));
    refused(await post("/api/admin/bridge/blocks", "asst", { op: "block", room: "", target: "u:" + U.asst2.userId, hours: "1" }), "rank");
    okay(await post("/api/admin/bridge/blocks", "asst", { op: "block", room: "", target: "u:" + U.member.userId, hours: "1", reason: "x" }));
    okay(await post("/api/feed/ban", "staff", { user: "u:" + U.asst.userId }), "Staff -> Assistant");
  } finally {
    await runQuery("DELETE FROM site_perms"); await SP.reload();
    await clear("feed_bans", "stage_bans", "bridge_blocks");
  }
});
