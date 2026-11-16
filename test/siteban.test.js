// 1.99aoi (siteban.js): a SITE ban - feed_bans with room_id '' whose until is NULL or in the future - locks the account out of
// PATV. The rule (a pad's ban doesn't count; a temporary ban ends on time, cached locks too; the Admin class and the owner are
// exempt), the sign-in refusal (sessions.signIn: code 'banned' with the end, no session row, no cookie, no deletion cancel - every
// method, the password form included), the session gate (a live cookie of an account banned since is a signed-out request on its
// NEXT request - its sessions end, an old sid-less cookie isn't converted - and works again only through a new sign-in once the
// ban is over), hlsauth's userIdOfToken, the page the refused cookie opens says why, and the wiring of every sign-in caller
// (they show the refusal as itself). Fake accounts only.
//   node --test test/siteban.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "siteban-test-")));
delete process.env.STAGING;
delete process.env.SENDGRID_API_KEY;
process.env.SECRET_KEY = "test-secret";
process.env.APP_SESSION_SECRET = "test-session-secret";
const express = require("express");
const session = require("express-session");
const flash = require("connect-flash");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SB = require(path.join(repo, "siteban"));
const S = require(path.join(repo, "sessions"));
const LC = require(path.join(repo, "middleware", "loginCookie"));
const UC = require(path.join(repo, "user.controller"));
require(path.join(repo, "terms"))._setRequired && require(path.join(repo, "terms"))._setRequired(false);

const DAY = 86400000;
const PASSWORD = "correct horse battery 9";
let clockAt = null;
const clock = () => (clockAt === null ? Date.now() : clockAt);
S._setClock(clock);
SB._setClock(clock);
let base, server;

async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, email, password, class, camfrogUsername, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                 [id, o.username || id, `${id}@example.com`, o.password || (await bcrypt.hash(PASSWORD, 4)), o.class || "pleb", o.cf || null, o.bal || 0]);
}
async function ban(id, { room = "", until = null, reason = "spamming the feed" } = {}) {
  await runQuery(`INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, ?, ?, 'staffer', ?, ?)
                  ON CONFLICT(user_id, room_id) DO UPDATE SET until = excluded.until, reason = excluded.reason`, [id, room, id, reason, clock(), until]);
}
const unban = (id, room = "") => runQuery("DELETE FROM feed_bans WHERE user_id = ? AND room_id = ?", [id, room]);

// a browser: keeps its cookies (the jwt one included), follows nothing
function browser() {
  const jar = new Map();
  async function go(method, p, body, { json = false, headers = {} } = {}) {
    const h = Object.assign({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), origin: base }, headers);
    let payload;
    if (json) { h["content-type"] = "application/json"; payload = JSON.stringify(body || {}); }
    else if (body) { h["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body).toString(); }
    const r = await fetch(base + p, { method, headers: h, body: payload, redirect: "manual" });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: r.status, location: r.headers.get("location") || "", text, json: j };
  }
  return {
    jar, go,
    get: (p, o) => go("GET", p, null, o),
    post: (p, b) => go("POST", p, b),
    who: async () => (await go("GET", "/whoami")).json.user,
    cookie: () => jar.get("jwt") || null,
    setCookie: (v) => jar.set("jwt", v),
  };
}
async function signIn(b, id, method = "password") {
  const r = await b.go("POST", "/test-signin", { id, method }, { json: true });
  return r.json;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, email TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  auto_source TEXT, archived_at INTEGER, password_set INTEGER, isEmailVerified INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT, role TEXT)");
  await S.init();
  const app = express();
  app.use(cookieParser());
  app.use(S.gate);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: process.env.APP_SESSION_SECRET, resave: true, saveUninitialized: true }));
  app.use(flash());
  app.use(SB.flashMiddleware);                                 // index.js: after the i18n middleware
  const addUser = async (req, res, next) => {
    req.user = null;
    const tok = req.cookies.jwt;
    if (tok) { try { req.user = await LC.refreshLogin(res, jwt.verify(tok, process.env.SECRET_KEY), getQuery); } catch (e) { req.user = null; } }
    next();
  };
  app.post("/test-signin", async (req, res) => {
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.body.id]))[0];
    try { await S.signIn(req, res, u, req.body.method); res.json({ ok: true }); }
    catch (e) { res.status(e.status || 500).json({ ok: false, code: e.code || null, error: e.message, until: e.until === undefined ? "absent" : e.until }); }
  });
  app.get("/whoami", addUser, (req, res) => res.json({ user: req.user ? req.user.userId : null, sid: req.loginSession ? req.loginSession.id : null }));
  app.get("/api/thing", addUser, (req, res) => res.json({ user: req.user ? req.user.userId : null }));
  // what a write route sees (the bounty form's /act, a feed post ...): no login once the account is banned
  app.post("/act", addUser, (req, res) => (req.user ? res.json({ ok: true, by: req.user.userId }) : res.redirect("/login")));
  app.get("/login", (req, res) => res.json({ errors: req.flash("error") }));
  app.post("/login", UC.loginUser);                              // the real password form
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("the rule: no feed_bans table yet -> nobody is banned (and nothing throws)", async () => {
  await user("early");
  assert.equal(await SB.activeBan("early"), null);
  assert.equal(await SB.lockOf("early", { fresh: true }), null);
  // now the real table (feedstore.js's DDL)
  await runQuery(`CREATE TABLE feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER,
                  PRIMARY KEY (user_id, room_id))`);
});

test("the rule: room '' only; for good, or until a time still ahead; a pad's ban or an ended one is no lock; Admins / the owner exempt, Staff not", async () => {
  for (const id of ["r_forever", "r_later", "r_ended", "r_pad", "r_admin", "r_staff", "r_clean"]) {
    await user(id, { class: id === "r_admin" ? "Admin" : id === "r_staff" ? "Staff" : "pleb" });
  }
  const t = Date.now();
  await ban("r_forever");
  await ban("r_later", { until: t + 3 * DAY });
  await ban("r_ended", { until: t - 1000 });
  await ban("r_pad", { room: "some-pad-id" });
  await ban("r_admin");
  await ban("r_staff");
  const lock = await SB.lockOf("r_forever", { fresh: true });
  assert.deepEqual({ kind: lock.kind, until: lock.until, reason: lock.reason }, { kind: "ban", until: null, reason: "spamming the feed" });
  assert.equal((await SB.lockOf("r_later", { fresh: true })).until, t + 3 * DAY);
  assert.equal(await SB.lockOf("r_ended", { fresh: true }), null, "an ended temporary ban is over - no manual step");
  assert.equal(await SB.lockOf("r_pad", { fresh: true }), null, "a pad's ban is not a site ban");
  assert.equal(await SB.lockOf("r_admin", { fresh: true }), null, "D1: an Admin is never locked out");
  assert.ok(await SB.lockOf("r_staff", { fresh: true }), "Staff can be (only a higher rank can ban them)");
  assert.equal(await SB.lockOf("r_clean", { fresh: true }), null);
  assert.equal(await SB.lockOf("no-such-account", { fresh: true }), null);
  assert.ok(await SB.activeBan("r_admin"), "activeBan itself is the bare rule (no exemption): telegram / invites / merges");
  // the same rule the Telegram bridge and the invites read
  assert.equal(await require(path.join(repo, "invites")).inviterBlock("r_forever"), "banned");
  assert.equal(await require(path.join(repo, "invites")).inviterBlock("r_pad"), null);
});

test("the cache: 5 s across processes, forget() at once in this one; a cached temporary ban still ends on time", async () => {
  await user("c_one");
  clockAt = Date.now();
  assert.equal(await SB.lockOf("c_one"), null);                       // cached: not banned
  await ban("c_one", { until: clockAt + 60000 });                     // as another process (a CLI tool) would
  assert.equal(await SB.lockOf("c_one"), null, "still cached for a moment");
  clockAt += SB.CACHE_MS + 1;
  assert.ok(await SB.lockOf("c_one"), "lands within seconds");
  clockAt += 60000;
  assert.equal(await SB.lockOf("c_one"), null, "the ban's end passed while it was cached: over at once");
  await ban("c_one");
  assert.equal(await SB.lockOf("c_one"), null, "cached");
  SB.forget("c_one");
  assert.ok(await SB.lockOf("c_one"), "forget(): the next read is fresh (feedstore.ban / unban, padbans.linked, a merge)");
  clockAt = null;
  SB._clear();
});

test("the message: plain text, the end in UTC when there is one, the reason (D4); a bot's answer carries every family's field", () => {
  assert.equal(SB.message({ kind: "ban", until: null, reason: null }), "This account is banned from PATV.");
  assert.equal(SB.message({ kind: "ban", until: Date.UTC(2026, 10, 23, 4, 52), reason: "spam & <scams>" }),
               "This account is banned from PATV until 2026-11-23 04:52 UTC. Reason: spam & <scams>", "raw text - the views escape it");
  const r = SB.botRefusal({ kind: "ban", until: 5 });
  assert.equal(r.ok, false); assert.equal(r.code, "banned");
  assert.ok(r.error && r.reply === r.error && r.msg === r.error);
  const e = SB.signInError({ kind: "ban", until: 7, reason: null });
  assert.equal(e.status, 403); assert.equal(e.code, "banned"); assert.equal(e.until, 7);
  assert.ok(SB.isRefusal(e) && SB.isRefusal({ code: "network" }) && !SB.isRefusal(new Error("x")));
});

test("sign-in: a banned account is refused before anything is issued - no session row, no cookie, its own pending deletion left alone", async () => {
  await user("s_ban");
  const until = Date.now() + 2 * DAY;
  await ban("s_ban", { until });
  await runQuery(`CREATE TABLE IF NOT EXISTS account_deletions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, state TEXT, requested_at INTEGER, execute_at INTEGER,
                  requested_by TEXT, reauth TEXT, reason TEXT, cancelled_at INTEGER, cancel_via TEXT)`).catch(() => {});
  await require(path.join(repo, "accountdelete")).init();
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at, requested_by, reauth) VALUES ('s_ban', 'scheduled', 1, ?, 'self', 'password')",
                 [Date.now() + 14 * DAY]);
  for (const method of ["password", "google", "apple", "plex", "telegram", "discord", "twitch", "chat", "claim"]) {
    const b = browser();
    const r = await signIn(b, "s_ban", method);
    assert.equal(r.ok, false, method);
    assert.equal(r.code, "banned", method);
    assert.equal(r.until, until, method + ": the end rides on the refusal");
    assert.match(r.error, /^This account is banned from PATV until \d{4}-\d\d-\d\d \d\d:\d\d UTC\. Reason: spamming the feed$/);
    assert.equal(b.cookie(), null, method + ": no login cookie");
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 's_ban'"))[0].n, 0, "no session row");
  assert.equal((await getQuery("SELECT state FROM account_deletions WHERE user_id = 's_ban'"))[0].state, "scheduled", "a refused sign-in cancels nothing");
});

test("the password form: a banned account with the right password sees the ban (not a session); a wrong password still says it doesn't match", async () => {
  await user("p_ban");
  await ban("p_ban");
  const b = browser();
  const r = await b.post("/login", { username: "p_ban", password: PASSWORD });
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login/);
  assert.equal(b.cookie(), null, "not signed in");
  assert.deepEqual((await b.get("/login")).json.errors, ["This account is banned from PATV. Reason: spamming the feed"]);
  const w = browser();
  await w.post("/login", { username: "p_ban", password: "not the password" });
  assert.match((await w.get("/login")).json.errors.join(" "), /don't match/, "the ban is never shown without the password");
  // the same account once the ban is lifted: straight in
  await unban("p_ban");
  SB.forget("p_ban");
  const ok = browser();
  const r2 = await ok.post("/login", { username: "p_ban", password: PASSWORD });
  assert.equal(r2.status, 302);
  assert.equal(await ok.who(), "p_ban");
});

test("a live session of an account banned since: signed out on its NEXT request (every page / API / write), its sessions end ('ban'), the page says why", async () => {
  await user("g_live");
  const a = browser(), b = browser();
  await signIn(a, "g_live", "google");
  await signIn(b, "g_live", "password");
  assert.equal(await a.who(), "g_live");
  assert.equal((await a.go("POST", "/act", { kind: "cmd", cmd: "bounty" }, { json: true })).json.by, "g_live", "a write works before");
  await ban("g_live");                                         // a raw row (padbans.linked / a merge / a CLI write no revoke)
  SB.forget("g_live");                                         // (another process: within siteban.CACHE_MS)
  const page = await a.get("/whoami");
  assert.equal(page.json.user, null, "signed out on the next request");
  assert.equal(a.cookie(), null, "the login cookie is cleared");
  const w = await b.go("POST", "/act", { kind: "cmd", cmd: "bounty" }, { json: true });
  assert.equal(w.status, 302, "a write (the bounty form's /act) sees no login");
  assert.equal(w.location, "/login");
  assert.equal((await b.get("/api/thing")).json.user, null);
  const rows = await getQuery("SELECT revoked_at, revoked_why FROM sessions WHERE user_id = 'g_live'");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.revoked_at && x.revoked_why === "ban"), "every session ended, why 'ban'");
  // the HTML page the refused cookie opened says why (the sign-in form shows the flash)
  const c = browser();
  await signIn(c, "g_live", "password").then((r) => assert.equal(r.code, "banned"));
  const d = browser();
  await unban("g_live"); SB.forget("g_live");
  await signIn(d, "g_live", "password");
  await ban("g_live"); SB.forget("g_live");
  await d.get("/whoami", { headers: { accept: "text/html" } });
  assert.deepEqual((await d.get("/login")).json.errors, ["This account is banned from PATV. Reason: spamming the feed"]);
});

test("a temporary ban: no way in while it runs; once its end passes, a new sign-in works (the old sessions stay ended)", async () => {
  await user("t_temp");
  const a = browser();
  await signIn(a, "t_temp");
  clockAt = Date.now();
  await ban("t_temp", { until: clockAt + 3600000 });
  SB.forget("t_temp");
  assert.equal(await a.who(), null);
  assert.equal((await signIn(browser(), "t_temp")).code, "banned");
  clockAt += 3600000 + 1;                                       // the end passes: no unban, no sweep
  const b = browser();
  assert.equal((await signIn(b, "t_temp")).ok, true, "signs in again by itself");
  assert.equal(await b.who(), "t_temp");
  assert.equal(await a.who(), null, "the session the ban ended stays ended");
  clockAt = null;
});

test("a non-banned account and an Admin with a stray ban are unaffected; a pad's ban signs nobody out", async () => {
  await user("n_ok");
  await user("n_pad");
  await user("n_admin", { class: "Admin" });
  await ban("n_pad", { room: "pad-1" });
  await ban("n_admin");
  for (const id of ["n_ok", "n_pad", "n_admin"]) {
    const b = browser();
    assert.equal((await signIn(b, id)).ok, true, id);
    assert.equal(await b.who(), id, id);
    SB.forget(id);
    assert.equal(await b.who(), id, id + " (fresh read)");
  }
});

test("an old sid-less cookie of a banned account is never converted - and the cutoff keeps it dead after the ban", async () => {
  await user("l_old");
  const iat = Math.floor(Date.now() / 1000) - 3600;
  const old = jwt.sign({ userId: "l_old", username: "l_old", class: "pleb", iat }, process.env.SECRET_KEY, { expiresIn: "90d" });
  await ban("l_old");
  SB.forget("l_old");
  const b = browser();
  b.setCookie(old);
  assert.equal(await b.who(), null);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'l_old'"))[0].n, 0, "no row made for it");
  await unban("l_old"); SB.forget("l_old");
  const c = browser();
  c.setCookie(old);
  assert.equal(await c.who(), null, "the cutoff written at the ban: the old cookie can't come back after it either");
});

test("hlsauth: userIdOfToken is null for a banned account's cookie", async () => {
  await user("h_hls");
  const b = browser();
  await signIn(b, "h_hls");
  const tok = decodeURIComponent(b.cookie());
  assert.equal(await S.userIdOfToken(tok), "h_hls");
  await ban("h_hls"); SB.forget("h_hls");
  assert.equal(await S.userIdOfToken(tok), null);
});

test("a staff site ban (feedstore.ban) and its lift: out at once, back in at once", async () => {
  await require(path.join(repo, "rooms")).init();
  const store = require(path.join(repo, "feedstore"));
  await store.init();
  await user("f_boss", { class: "Admin" });
  await user("f_target");
  const b = browser();
  await signIn(b, "f_target");
  assert.equal(await SB.lockOf("f_target"), null);                  // cached: not banned
  await store.ban({ userId: "f_boss", username: "f_boss", class: "Admin" }, "f_target", { reason: "spam", days: 7 });
  assert.equal(await b.who(), null);
  const r = await signIn(browser(), "f_target");
  assert.equal(r.code, "banned");
  assert.ok(r.until > Date.now() + 6 * DAY, "a 7-day ban says when it ends");
  await store.unban({ userId: "f_boss", username: "f_boss", class: "Admin" }, "f_target");
  assert.equal((await signIn(browser(), "f_target")).ok, true, "lifted: in again at once (no 5 s wait)");
});

test("wiring: every sign-in caller refuses before side effects and shows the refusal as itself", () => {
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  const uc = src("user.controller.js"), ix = src("index.js");
  // finishLogin asks first: nothing (the archived-account restore) runs for a banned account
  assert.match(uc, /async function finishLogin\([^)]*\) \{\r?\n\s*await require\("\.\/siteban"\)\.assertSignIn\(user, req\);[^\n]*\r?\n\s*await require\("\.\/staleaccounts"\)\.touch/);
  // the Twitch / Discord callbacks: the returning account and the email match are checked before anything is linked or restored
  for (const p of ["twitch", "discord"]) {
    const start = ix.indexOf(`app.get("/auth/${p}/callback"`);
    assert.ok(start > 0, p);
    const body = ix.slice(start, ix.indexOf("\n});", start));
    const checks = body.split("await siteBan.assertSignIn(").length - 1;
    assert.equal(checks, 2, `${p}: the returning account + the email match`);
    assert.ok(body.indexOf("siteBan.assertSignIn(currentUser, req)") < body.indexOf("stale.touch("), `${p}: before the restore`);
    assert.match(body, /oauthFail\(req, res, siteBan\.isRefusal\(error\) \? error\.message/, `${p}: the catch shows it`);
  }
  // the other callers: the refusal shown as itself (a network ban's too)
  for (const f of ["user.controller.js", "googlesso.js", "telegramsso.js", "applesso.js", "ssolinks.js", "chatsignin.js"]) {
    assert.match(src(f), /siteban"\)\.isRefusal\((e|err)\)/, f);
  }
  assert.equal(src("plexsso.js").split('require("./siteban").isRefusal(e)').length - 1, 2, "plexsso: the callback and the create page");
  assert.ok(!/e\.code === "network"|err\.code === "network"|error\.code === "network"/.test(uc + ix + src("googlesso.js") + src("telegramsso.js") + src("plexsso.js")),
            "no caller left that shows only the network ban");
  // sessions.signIn refuses first, before the netban check, the replaced-session revoke, create() and cancelOnSignIn
  const ss = src("sessions.js");
  const si = ss.slice(ss.indexOf("async function signIn("));
  assert.ok(si.indexOf("SB.signInError(lock, req)") < si.indexOf("NB.isOn()") && si.indexOf("SB.signInError(lock, req)") < si.indexOf("await create("));
  // index.js: the page a refused cookie opens says why (after the i18n middleware, so it is in the viewer's language)
  assert.match(ix, /app\.use\(i18n\.middleware\(cookieUserId\)\);\r?\n(?:\/\/[^\n]*\r?\n)*app\.use\(siteBan\.flashMiddleware\);/);
});

test("merges: a site-banned account (or one staff scheduled for deletion) is never merged into the signed-in one - the ban would follow it", async () => {
  const PMG = require(path.join(repo, "providermerge"));
  const L = { label: "Twitch", idCol: "twitchId", nameCol: "twitchDisplayname", otherIdCol: "discordId", otherNameCol: "discordUsername" };
  await user("m_to", { bal: 10 });
  await user("m_from", { bal: 500 });
  await runQuery("UPDATE users SET twitchId = 'tw-1' WHERE userId = 'm_from'");
  await ban("m_from");
  let r = await PMG.mergeProviderAccount({ provider: "twitch", L, fromId: "m_from", toId: "m_to", linkId: "tw-1", linkName: "x" });
  assert.deepEqual(r, { ok: false, code: "banned" });
  await unban("m_from");
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at, requested_by, reauth) VALUES ('m_from', 'scheduled', 1, ?, 'admin:someadmin', 'admin')",
                 [Date.now() + 14 * DAY]);
  r = await PMG.mergeProviderAccount({ provider: "twitch", L, fromId: "m_from", toId: "m_to", linkId: "tw-1", linkName: "x" });
  assert.deepEqual(r, { ok: false, code: "deleting" }, "a merge would escape staff's deletion");
  const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
  assert.deepEqual([await bal("m_from"), await bal("m_to")], [500, 10], "nothing moved");
  // the page says why (index.js mergeConflict), in en.json
  const en = require(path.join(repo, "locales", "en.json"));
  assert.ok(en["auth.merge.banned"] && en["auth.merge.deleting"]);
  assert.match(fs.readFileSync(path.join(repo, "index.js"), "utf8"), /banned: req\.t \? req\.t\("auth\.merge\.banned"\)/);
});

test("bots acting for the account: Pepe's / Discord's !tip from a banned sender moves nothing; receiving still works", async () => {
  const tips = require(path.join(repo, "tips"));
  await user("tip_ban", { bal: 1000 });
  await user("tip_ok", { bal: 1000 });
  await ban("tip_ban");
  SB.forget("tip_ban");
  const r = await tips.transferPat("tip_ban", "tip_ok", 100);
  assert.equal(r.ok, false); assert.equal(r.status, 403); assert.equal(r.code, "banned");
  const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
  assert.deepEqual([await bal("tip_ban"), await bal("tip_ok")], [1000, 1000], "nothing moved");
  const ok = await tips.transferPat("tip_ok", "tip_ban", 100);
  assert.equal(ok.ok, true, "a banned account can still be tipped (a credit acts for nobody)");
  // the wiring of the other bot routers (each refuses a locked account where it resolved it)
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  for (const [f, re] of [["casino/routes.js", /CASINO_OK\.has\(verb\)/], ["lotto/routes.js", /siteban"\)\.lockOf\(u\.userId\)/], ["stashes.js", /STASH_OK\.has\(op\)/],
                         ["raffles.js", /siteban"\)\.lockOf\(u\.userId\)/], ["creators.js", /siteban"\)\.lockOf\(me\.userId\)/], ["shop.js", /siteban"\)\.lockOf\(userId\)/],
                         ["index.js", /siteBan\.lockOf\(user\[0\]\.userId\)/], ["escrow/games.js", /windDownOk\(game, verb\)/], ["escrow/ledger.js", /"E_SITE_BANNED"/],
                         ["actions.js", /SB\.lockedRows\(found\)/], ["bounties.js", /SB\.lockedRows\(found/], ["chatsignin.js", /reason: "banned"/]]) {
    assert.match(src(f), re, f);
  }
});
