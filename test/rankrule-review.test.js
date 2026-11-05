// rankrule review fixes (the owner, 2026-11-05: "Rank rule - refuse actions on equal or higher-ranked staff."): the paths the two
// reviews found around the rule, and the legitimate actions it had started to refuse.
//   B1   the image-safety REVIEW of a stage cover's check (fn / ok on a flagged one = take down + strike, fp = put up) asks the rule
//        before the mark is written; the take-down of one cover also takes every other account's copy of the picture down - those too
//   B2   taking a pad away from its owner (/api/rooms/admin/owner, Staff) asks the rule about the current owner
//   B3   a frog-name (incognito) ban is stored and answered as ever, but bites only while its maker outranks the person behind it
//   B3b  the Lift of a frog-name ban is never your own
//   B5   a users read that fails refuses (500, nothing written) - it was "no such account, go on"
//   R1   a member's block from commenting on THEIR OWN profile works on PATV staff again (their space, not a staff power)
//   R2   PAT out of your own pad (padvault fine / transfer) is no sanction on anyone
//   also creator refunds / clawbacks / dispute refunds and taking XP away (sanctions the build left out), the routes' own answers for
//   the chat tool and the pad vault, an Admin's account deletion by the owner really scheduled, and allowed cases left unpinned
//   TZ=UTC node --test test/rankrule-review.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rankrule-review-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });

// (B5: a read of ONE account's users row fails - patched before any module takes getQuery)
const DB = require(path.join(repo, "dbUtils"));
const realGet = DB.getQuery;
let FAIL_ROW = null;
DB.getQuery = function (sql, args) {
  if (FAIL_ROW && /SELECT userId, username, class, camfrogUsername FROM users WHERE userId = \?/.test(String(sql)) && args && String(args[0]) === FAIL_ROW) {
    return Promise.reject(Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" }));
  }
  return realGet.apply(this, arguments);
};
const { runQuery, getQuery } = DB;

const express = require("express");
const rooms = require(path.join(repo, "rooms"));
const PB = require(path.join(repo, "padbans"));
const BB = require(path.join(repo, "bridgeblocks"));
const SP = require(path.join(repo, "siteperms"));
const SR = require(path.join(repo, "staffrank"));
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
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class, points_balance, level) VALUES (?, ?, ?, 'x', ?, ?, 1000, 5)", [id, name, name, cf, cls]);
    U[key] = { userId: id, username: name, class: cls, camfrogUsername: cf };
  };
  await mk("owner", "own-0001", "theowner", "Admin", "ownercf");
  await mk("admin", "adm-0001", "adminone", "Admin", "admincf");
  await mk("admin2", "adm-0002", "admintwo", "Admin", "admin2cf");
  await mk("admin3", "adm-0003", "adminthree", "Admin");
  await mk("staff", "stf-0001", "staffer", "Staff", "staffcf");
  await mk("staff2", "stf-0002", "stafftwo", "Staff");
  await mk("asst", "ast-0001", "helper", "Assistant");
  await mk("member", "mem-0001", "member", "pleb", "membercf");
  await mk("member2", "mem-0002", "membertwo", "pleb");
  await mk("member3", "mem-0003", "memberthree", "pleb");
  await mk("padowner", "pad-0001", "padowner", "pleb", "padownercf");
  await require(path.join(repo, "staffroles")).init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('ownercf', 'owner', 1)");
  await SP.init();
  await rooms.init();
  await rooms.addRoom(PAD, "Rank Room", "test");
  await rooms.setOwner(PAD, "padowner", "test");
  SLUG = (await rooms.get(PAD)).slug || PAD;
  await BB.init(); await PB.init();
  for (const m of ["feedstore", "mainstage", "stagecover", "imagesafety", "creators", "padfines", "accountdelete", "chatlog", "chatlogmod"]) await require(path.join(repo, m)).init();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.t = (k) => EN[k] || k; next(); });
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? U[u] || null : null; next(); };
  const isBotToken = (t) => t === "bot-token";
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: () => false });
  PB.register(app, { addUser });
  BB.register(app, { addUser, isBotToken });
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken });
  require(path.join(repo, "mainstage")).register(app, { addUser, isBotToken: () => false, noTimers: true });
  require(path.join(repo, "stagecover")).register(app, { addUser, noTimers: true });
  require(path.join(repo, "imagesafety")).register(app, { addUser, isBotToken: () => false, noTimers: true });
  require(path.join(repo, "creatorsweb")).register(app, { addUser, isBotToken: () => false });
  require(path.join(repo, "padfines")).register(app, { addUser, isBotToken: () => false });
  require(path.join(repo, "adminxp")).register(app, { addUser });
  require(path.join(repo, "accountdelete")).register(app, { addUser, isBotToken: () => false });
  require(path.join(repo, "chatlogmod")).register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
test.beforeEach(() => { PB._reset(); FAIL_ROW = null; });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base, referer: base + "/admin" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) }));
const one = async (sql, args = []) => (await getQuery(sql, args))[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);
const refused = (r, why, msg) => {
  assert.equal(r.status, why === "self" ? 400 : 403, (msg || "") + " " + JSON.stringify(r.d));
  assert.equal(r.d.error, why === "self" ? SELF : RANK, msg);
  assert.equal(r.d.code, why === "self" ? "self" : "staff_rank", msg);
};
const okay = (r, msg) => assert.ok(r.status === 200 && r.d.ok !== false, (msg || "") + " " + r.status + " " + JSON.stringify(r.d));
const isRank = (e) => e instanceof SR.StaffRankError && e.code === "staff_rank";
const clear = async (...tables) => { for (const t of tables) await runQuery("DELETE FROM " + t).catch(() => {}); };
const pic = (k) => "ab" + String(k).replace(/[^a-z0-9]/g, "").padEnd(30, "0").slice(0, 30) + ".webp";
/** an uploaded cover that passed (or was held by) its check: -> the check's log id */
async function cover(k, { hash = "h-" + k, state = "ok", flagged = 0 } = {}) {
  const l = await runQuery(`INSERT INTO image_safety_log (at, surface, user_id, mode, action, flagged) VALUES (?, 'stage_cover', ?, 'enforce', ?, ?)`,
    [Date.now(), U[k].userId, flagged ? "hold" : "allow", flagged]);
  await runQuery("INSERT OR REPLACE INTO stage_covers (user_id, kind, upload, upload_state, upload_log, upload_hash) VALUES (?, 'upload', ?, ?, ?, ?)",
    [U[k].userId, pic(k + hash), state, l.id, hash]);
  return l.id;
}
const coverOf = (k) => one("SELECT upload, upload_state, strikes FROM stage_covers WHERE user_id = ?", [U[k].userId]);

// ── B1: the image-safety review of a stage cover's check ──
test("B1: /api/admin/imagesafety/review/:id on a stage cover asks the rule before the mark is written (fn / ok-on-flagged = take down, fp = a lift)", async () => {
  const a2 = await cover("admin2"), ow = await cover("owner"), st = await cover("staff");
  for (const [id, k] of [[a2, "admin2"], [ow, "owner"]]) {
    refused(await post("/api/admin/imagesafety/review/" + id, "admin", { mark: "fn", note: "x" }), "rank", "Admin -> " + k);
    assert.equal((await one("SELECT review FROM image_safety_log WHERE id = ?", [id])).review, null, "no mark written");
    const c = await coverOf(k);
    assert.equal(c.upload_state, "ok", k + "'s cover still up"); assert.ok(!Number(c.strikes), "no strike");
  }
  okay(await post("/api/admin/imagesafety/review/" + a2, "admin", { mark: "ok" }), "'ok' on a check that didn't flag it changes nothing - a mark, no sanction");
  okay(await post("/api/admin/imagesafety/review/" + st, "admin", { mark: "fn" }), "Admin -> Staff");
  assert.equal((await coverOf("staff")).upload, null);
  okay(await post("/api/admin/imagesafety/review/" + a2, "owner", { mark: "fn" }), "the owner -> an Admin");
  assert.equal((await coverOf("admin2")).upload, null);
  // "ok" on a FLAGGED check takes it down too
  const fl = await cover("owner", { hash: "h-owner-2", flagged: 1, state: "held" });
  refused(await post("/api/admin/imagesafety/review/" + fl, "admin", { mark: "ok" }), "rank", "'ok' on a flagged check = a take-down");
  // fp on a held cover: a lift - never your own, never refused for rank
  const mine = await cover("admin", { hash: "h-admin-held", flagged: 1, state: "held" });
  refused(await post("/api/admin/imagesafety/review/" + mine, "admin", { mark: "fp" }), "self", "putting your own held cover up");
  assert.equal((await coverOf("admin")).upload_state, "held");
  okay(await post("/api/admin/imagesafety/review/" + fl, "admin", { mark: "fp" }), "putting the owner's held cover up (a lift)");
  assert.equal((await coverOf("owner")).upload_state, "ok");
  await clear("stage_covers", "image_safety_log", "stage_cover_blocks", "stage_cover_checks");
});

test("B1: a review of an OLD check (the picture no longer up) - its hold + strike + the picture block ask the rule too", async () => {
  const l = await runQuery(`INSERT INTO image_safety_log (at, surface, user_id, mode, action, flagged) VALUES (?, 'stage_cover', ?, 'enforce', 'allow', 0)`, [Date.now(), U.admin2.userId]);
  await runQuery("INSERT INTO stage_cover_checks (log_id, hash, at) VALUES (?, 'h-old-1', ?)", [l.id, Date.now()]);
  refused(await post("/api/admin/imagesafety/review/" + l.id, "admin", { mark: "fn" }), "rank", "Admin -> Admin's old check");
  assert.equal(await n("SELECT COUNT(*) AS n FROM stage_cover_blocks WHERE hash = 'h-old-1'"), 0, "picture not blocked");
  okay(await post("/api/admin/imagesafety/review/" + l.id, "owner", { mark: "fn" }), "the owner");
  assert.equal(await n("SELECT COUNT(*) AS n FROM stage_cover_blocks WHERE hash = 'h-old-1'"), 1);
  await clear("stage_covers", "image_safety_log", "stage_cover_blocks", "stage_cover_checks");
});

test("B1: a take-down takes every other account's copy of the picture down - never PATV staff of your rank or above (your own copy: fine)", async () => {
  await cover("member", { hash: "h-shared" }); await cover("owner", { hash: "h-shared" });
  refused(await post("/api/admin/stage-cover/remove", "admin", { user_id: U.member.userId }), "rank", "the owner's copy would come down");
  assert.ok((await coverOf("member")).upload); assert.ok((await coverOf("owner")).upload);
  okay(await post("/api/admin/stage-cover/remove", "owner", { user_id: U.member.userId }), "the owner (their own copy comes down with it)");
  assert.equal((await coverOf("member")).upload, null); assert.equal((await coverOf("owner")).upload, null);
  await cover("member3", { hash: "h-shared-2" }); await cover("admin", { hash: "h-shared-2" });
  okay(await post("/api/admin/stage-cover/remove", "admin", { user_id: U.member3.userId }), "an Admin whose own cover is a copy");
  await clear("stage_covers", "image_safety_log", "stage_cover_blocks", "stage_cover_checks");
});

// ── B2: pad ownership ──
test("B2: /api/rooms/admin/owner - taking a pad away from PATV staff of your rank or above is refused (to someone, the house or nobody)", async () => {
  await rooms.addRoom("Own.Room", "The owner's", "test"); await rooms.setOwner("Own.Room", "theowner", "test");
  await rooms.addRoom("Adm2.Room", "Admin Two's", "test"); await rooms.setOwner("Adm2.Room", "admintwo", "test");
  await rooms.addRoom("Adm1.Room", "Admin One's", "test"); await rooms.setOwner("Adm1.Room", "adminone", "test");
  await rooms.addRoom("Mem.Room", "A member's", "test"); await rooms.setOwner("Mem.Room", "member", "test");
  await rooms.addRoom("Free.Room", "Nobody's", "test");
  const ownerOf = async (id) => { const r = await rooms.get(id); return r && r.owner ? String(r.owner.userId) : null; };
  refused(await post("/api/rooms/admin/owner", "staff", { room: "Own.Room", owner: "staffer" }), "rank", "Staff takes the owner's pad");
  refused(await post("/api/rooms/admin/owner", "admin", { room: "Adm2.Room", owner: "none" }), "rank", "Admin -> none");
  refused(await post("/api/rooms/admin/owner", "admin", { room: "Adm2.Room", owner: "house" }), "rank", "Admin -> the house");
  assert.equal(await ownerOf("Own.Room"), U.owner.userId); assert.equal(await ownerOf("Adm2.Room"), U.admin2.userId);
  okay(await post("/api/rooms/admin/owner", "admin", { room: "Adm2.Room", owner: "admintwo" }), "naming the same owner again changes nothing");
  okay(await post("/api/rooms/admin/owner", "admin", { room: "Adm1.Room", owner: "membertwo" }), "giving your own pad away");
  okay(await post("/api/rooms/admin/owner", "staff", { room: "Mem.Room", owner: "memberthree" }), "Staff -> a member's pad");
  okay(await post("/api/rooms/admin/owner", "staff", { room: "Free.Room", owner: "adminone" }), "an unowned pad to an Admin");
  okay(await post("/api/rooms/admin/owner", "owner", { room: "Adm2.Room", owner: "none" }), "the owner -> an Admin's pad");
  assert.equal(await ownerOf("Adm2.Room"), null);
});

// ── B3 / B3b: frog-name bans ──
const meRow = async (k) => one("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [U[k].userId]);
const live = (login) => ({ id: PAD, members: [{ anon: true, id: "v-rr000001", alias: "Soggy Bullfrog", _vz: { login } }], mic: [] });
const veilBan = async (by, login, scope = "pad") => PB.ban(await meRow(by), { id: PAD }, live(login), { ref: { k: "veil", id: "v-rr000001" }, scope, dur: "perm", reason: "rr" });

test("B3: a frog-name ban is answered and listed as ever, but never bites PATV staff of its maker's rank or above", async () => {
  const before = await n("SELECT COUNT(*) AS n FROM veil_bans");
  // the same answer, a stored + listed row - and no effect on the Admin
  const a = await veilBan("padowner", "admincf");
  assert.equal(a.ok, true);
  assert.equal(await n("SELECT COUNT(*) AS n FROM veil_bans"), before + 1, "stored (the pad's list shows it like any other)");
  assert.equal(await PB.veilActive(PAD, U.admin.userId), null, "a pad owner's incognito ban never stops an Admin");
  assert.equal((await veilBan("staff", "ownercf", "site")).ok, true);
  assert.equal(await PB.veilActive("Any.Other.Pad", U.owner.userId), null, "Staff's site-wide one never stops the owner");
  assert.equal((await veilBan("admin", "admin2cf")).ok, true);
  assert.equal(await PB.veilActive(PAD, U.admin2.userId), null, "an Admin's never stops another Admin");
  // ... and it bites whoever the maker outranks
  assert.equal((await veilBan("padowner", "membercf")).ok, true);
  assert.ok(await PB.veilActive(PAD, U.member.userId), "a pad owner -> a member: bites");
  assert.equal((await veilBan("admin", "staffcf")).ok, true);
  assert.ok(await PB.veilActive(PAD, U.staff.userId), "an Admin -> Staff: bites");
  assert.equal((await veilBan("owner", "admincf")).ok, true);
  assert.ok(await PB.veilActive(PAD, U.admin.userId), "the owner -> an Admin: bites (the pad owner's row above it still doesn't)");
  // a row made before the rule by someone below the person: no bite either
  await runQuery(`INSERT INTO veil_bans (room_id, scope, user_id, login, label, until, reason, by_id, by_name, created) VALUES ('', 'site', ?, 'staff2', 'Old Frog', NULL, 'old', ?, 'helper', ?)`,
                 [U.staff2.userId, U.asst.userId, Date.now()]);
  assert.equal(await PB.veilActive(PAD, U.staff2.userId), null);
  await clear("veil_bans");
});

test("B3b: the Lift of a frog-name ban (entry veil:<id>) is never your own", async () => {
  const r0 = await runQuery(`INSERT INTO veil_bans (room_id, scope, user_id, login, label, until, reason, by_id, by_name, created) VALUES ('', 'site', ?, 'staffcf', 'Soggy Bullfrog', NULL, 'owner said', ?, 'theowner', ?)`,
    [U.staff.userId, U.owner.userId, Date.now()]);
  refused(await post(`/api/rooms/${SLUG}/unban`, "staff", { entry: "veil:" + r0.id }), "self", "lifting your own incognito ban");
  assert.equal(await n("SELECT COUNT(*) AS n FROM veil_bans WHERE id = ?", [r0.id]), 1, "still there");
  // by your linked login alone (no account on the row)
  const r1 = await runQuery(`INSERT INTO veil_bans (room_id, scope, user_id, login, label, until, reason, by_id, by_name, created) VALUES ('', 'site', NULL, 'staffcf', 'Wet Toad', NULL, 'x', ?, 'theowner', ?)`,
    [U.owner.userId, Date.now()]);
  refused(await post(`/api/rooms/${SLUG}/unban`, "staff", { entry: "veil:" + r1.id }), "self", "by your login");
  okay(await post(`/api/rooms/${SLUG}/unban`, "staff2", { entry: "veil:" + r0.id }), "another moderator lifts it");
  assert.equal(await n("SELECT COUNT(*) AS n FROM veil_bans WHERE id = ?", [r0.id]), 0);
  await clear("veil_bans");
});

// ── B5: a failed read refuses ──
test("B5: a users read that fails never lets a sanction through (500, nothing written)", async () => {
  await cover("admin2", { hash: "h-b5" });
  FAIL_ROW = U.admin2.userId;
  await assert.rejects(SR.check(U.admin, U.admin2.userId), /SQLITE_BUSY/, "check() throws - it was null (go on)");
  const r = await post("/api/admin/stage-cover/remove", "admin", { user_id: U.admin2.userId });
  assert.equal(r.status, 500, JSON.stringify(r.d));
  const b = await post("/api/admin/bridge/blocks", "admin", { op: "block", room: "", target: "u:" + U.admin2.userId, hours: "1", reason: "x" });
  assert.equal(b.status, 500, JSON.stringify(b.d));
  FAIL_ROW = null;
  assert.ok((await coverOf("admin2")).upload, "cover still up");
  assert.equal(await n("SELECT COUNT(*) AS n FROM bridge_blocks WHERE user_id = ?", [U.admin2.userId]), 0);
  await clear("stage_covers", "image_safety_log");
});

// ── R1 / R2: legitimate actions that had started to be refused ──
test("R1: a member blocks PATV staff from commenting on their OWN profile (Profile feed settings); staff managing someone else's profile still can't", async () => {
  const slug = (await rooms.ensureProfile(U.member2.userId)).slug;
  okay(await post("/api/feed/ban", "member2", { user: "@helper", room: slug, days: 0, reason: "blocked from commenting on a profile" }), "member -> an Assistant, own profile");
  okay(await post("/api/feed/ban", "member2", { user: "@adminone", room: slug, days: 0 }), "member -> an Admin, own profile");
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_bans WHERE room_id = ?", ["user:" + U.member2.userId]), 2);
  const self = await post("/api/feed/ban", "member2", { user: "@membertwo", room: slug });
  assert.equal(self.status, 400, "yourself: still no");
  refused(await post("/api/feed/ban", "staff", { user: "@adminone", room: slug }), "rank", "Staff managing a member's profile -> an Admin");
  // a pad that isn't your profile: the ban sheet's rule (unchanged)
  refused(await post("/api/feed/ban", "padowner", { user: "@helper", room: SLUG }), "rank", "a pad owner -> an Assistant on their pad");
  await clear("feed_bans");
});

test("R2: PAT out of your own pad (padvault fine / transfer) is no sanction; another Admin's pad still refused - the route's own answer", async () => {
  const PF = require(path.join(repo, "padfines"));
  if (!(await rooms.get("Own.Room"))) { await rooms.addRoom("Own.Room", "The owner's", "test"); }
  await rooms.setOwner("Own.Room", "theowner", "test");
  await rooms.addRoom("Adm1b.Room", "Admin One's B", "test"); await rooms.setOwner("Adm1b.Room", "adminone", "test");
  await rooms.addRoom("Adm2b.Room", "Admin Two's B", "test"); await rooms.setOwner("Adm2b.Room", "admintwo", "test");
  assert.ok((await PF.request(U.owner, { op: "transfer", from: "Own.Room", to: PAD, amount: 5, reason: "move my pad's PAT" })).key, "the owner, own pad");
  assert.ok((await PF.request(U.admin, { op: "fine", from: "Adm1b.Room", amount: 5, reason: "my own pad" })).key, "an Admin, own pad");
  await assert.rejects(PF.request(U.admin, { op: "fine", from: "Adm2b.Room", amount: 5, reason: "spam" }), isRank);
  // the route: its refusal in the shared words + code (the step-up stubbed)
  const ES = require(path.join(repo, "econstore"));
  const realStep = ES.stepUp;
  ES.stepUp = async () => {};
  try {
    refused(await post("/api/admin/padvault/move", "admin", { op: "fine", from: "Adm2b.Room", amount: 5, reason: "spam" }), "rank", "the route");
    okay(await post("/api/admin/padvault/move", "admin", { op: "fine", from: "Adm1b.Room", amount: 5, reason: "my own pad" }), "the route, own pad");
  } finally { ES.stepUp = realStep; }
});

// ── creators' money: refunds / clawbacks / disputes ──
test("creator refunds, clawbacks and dispute refunds take a creator's earnings - never from PATV staff of your rank or above (your own: yes); a deny is never your own", async () => {
  const T = Date.now();
  // (a fan who isn't the creator's own account: nothing is clawed from a creator unless the two are linked - the platform absorbs it)
  const led = async (creator, state, ref) => (await runQuery(`INSERT INTO creator_ledger (ref, kind, fan_id, creator_id, amount, creator_share, cut, state, release_at, created, linked)
                                                               VALUES (?, 'ppv', ?, ?, 100, 80, 20, ?, ?, ?, 0)`, [ref, U.member2.userId, U[creator].userId, state, T, T])).id;
  const stateOf = async (id) => (await one("SELECT state FROM creator_ledger WHERE id = ?", [id])).state;
  const rel = await led("admin2", "released", "rr-1"), held = await led("admin2", "held", "rr-2"), memRel = await led("member", "released", "rr-3"), ownRel = await led("admin2", "released", "rr-4");
  refused(await post("/api/admin/creators/ledger/" + rel, "staff", { action: "clawback", note: "x" }), "rank", "Staff claws back from an Admin");
  refused(await post("/api/admin/creators/ledger/" + rel, "admin", { action: "clawback", note: "x" }), "rank", "Admin -> Admin");
  refused(await post("/api/admin/creators/ledger/" + held, "staff", { action: "refund", note: "x" }), "rank", "Staff refunds an Admin's held sale");
  assert.equal(await stateOf(rel), "released"); assert.equal(await stateOf(held), "held");
  const d = await runQuery("INSERT INTO creator_disputes (ledger_id, fan_id, creator_id, reason, created) VALUES (?, ?, ?, 'not delivered', ?)", [held, U.member2.userId, U.admin2.userId, T]);
  refused(await post("/api/admin/creators/disputes/" + d.id, "staff", { action: "refund" }), "rank", "a dispute refund");
  refused(await post("/api/admin/creators/disputes/" + d.id, "admin2", { action: "deny" }), "self", "denying a dispute on your own sale");
  assert.equal((await one("SELECT status FROM creator_disputes WHERE id = ?", [d.id])).status, "open");
  okay(await post("/api/admin/creators/disputes/" + d.id, "staff", { action: "deny", note: "fine" }), "a deny on someone above you (in their favour)");
  okay(await post("/api/admin/creators/ledger/" + rel, "owner", { action: "clawback", note: "chargeback" }), "the owner -> an Admin");
  assert.equal(await stateOf(rel), "clawed");
  okay(await post("/api/admin/creators/ledger/" + memRel, "staff", { action: "clawback", note: "chargeback" }), "Staff -> a member");
  okay(await post("/api/admin/creators/ledger/" + ownRel, "admin2", { action: "clawback", note: "my buyer" }), "your own sale");
  await clear("creator_ledger", "creator_disputes");
});

// ── XP ──
test("taking XP away (/api/admin/update-level) is never done to PATV staff of your rank or above - preview included; a raise / your own: as before", async () => {
  const lv = async (k) => (await one("SELECT level, xp FROM users WHERE userId = ?", [U[k].userId]));
  const b0 = await lv("admin2");
  refused(await post("/api/admin/update-level", "admin", { username: "admintwo", mode: "set_level", amount: 1 }), "rank", "the preview");
  refused(await post("/api/admin/update-level", "admin", { username: "admintwo", mode: "add", amount: -10, confirm: true }), "rank", "Admin -> Admin");
  refused(await post("/api/admin/update-level", "admin", { username: "theowner", mode: "set_level", amount: 1, confirm: true }), "rank", "Admin -> the owner");
  assert.deepEqual(await lv("admin2"), b0, "unchanged");
  okay(await post("/api/admin/update-level", "owner", { username: "admintwo", mode: "set_level", amount: 2, confirm: true }), "the owner -> an Admin");
  assert.equal((await lv("admin2")).level, 2);
  okay(await post("/api/admin/update-level", "admin", { username: "admintwo", mode: "add", amount: 10, confirm: true }), "a raise (like a comp)");
  okay(await post("/api/admin/update-level", "admin", { username: "adminone", mode: "set_level", amount: 1, confirm: true }), "your own");
  okay(await post("/api/admin/update-level", "admin", { username: "staffer", mode: "set_level", amount: 1, confirm: true }), "Admin -> Staff");
});

// ── the tests the review found too thin ──
test("account deletion: the owner really schedules an Admin's deletion (not just past the rank check)", async () => {
  const SA = require(path.join(repo, "staleaccounts"));
  const realHolds = SA.holdsFor;
  SA.holdsFor = async () => [];         // (the test database has no stale-account tables)
  try {
    refused(await post(`/api/admin/users/${U.admin3.userId}/delete`, "admin", { reason: "asked", confirm: "adminthree" }), "rank");
    assert.equal(await n("SELECT COUNT(*) AS n FROM account_deletions"), 0);
    const r = await post(`/api/admin/users/${U.admin3.userId}/delete`, "owner", { reason: "asked", confirm: "adminthree" });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.equal(await n("SELECT COUNT(*) AS n FROM account_deletions WHERE user_id = ? AND state = 'scheduled'", [U.admin3.userId]), 1, "scheduled");
  } finally { SA.holdsFor = realHolds; await clear("account_deletions"); }
});

test("the per-login chat tool's route answers a refusal in the shared words + code", async () => {
  refused(await post("/api/admin/chatlog/who", "staff", { key: "@adminone", action: "hide_all", why: "a privacy request" }), "rank", "hide every line of an Admin's");
  refused(await post("/api/admin/chatlog/who", "staff", { key: "@staffer", action: "purge_all", why: "a privacy request" }), "self");
  okay(await post("/api/admin/chatlog/who", "staff", { key: "@adminone", action: "look", why: "a privacy request" }), "a look");
});

test("allowed cases: a pad owner's cut + ban of a member's slot; a cut alone of an Admin's slot; a pad owner's pad-scope ban of a member on the ban sheet", async () => {
  const slot = (id, k) => runQuery(`INSERT INTO stage_slots (id, room_id, userId, username, displayname, status, created, max_minutes, price_per_min, held, stream, publishing, settled, kind, mode, source)
                  VALUES (?, ?, ?, ?, ?, 'active', ?, 30, 0, 0, ?, 0, 0, 'slot', 'stream', 'rtmp')`, [id, PAD, U[k].userId, U[k].username, U[k].username, Date.now(), "st-" + id]);
  await slot("rr-p1", "member");
  okay(await post("/api/stage/slots/rr-p1/cut", "padowner", { ban: true, reason: "x" }), "pad owner cut + ban of a member");
  assert.equal(await n("SELECT COUNT(*) AS n FROM stage_room_bans WHERE userId = ?", [U.member.userId]), 1);
  await slot("rr-p3", "admin2");
  okay(await post("/api/stage/admin/cut", "staff", { id: "rr-p3" }), "a cut without a ban: programming");
  assert.notEqual((await one("SELECT status FROM stage_slots WHERE id = 'rr-p3'")).status, "active");
  okay(await post(`/api/rooms/${SLUG}/ban`, "padowner", { ref: { k: "acct", v: "u:" + U.member3.userId }, scope: "pad", dur: "1h", reason: "x" }), "ban sheet, pad scope");
  assert.equal(await n("SELECT COUNT(*) AS n FROM feed_bans WHERE user_id = ? AND room_id = ?", [U.member3.userId, PAD]), 1);
  await clear("stage_slots", "stage_room_bans", "stage_events", "feed_bans", "bridge_blocks");
});
