// Server-side sessions (sessions.js, 1.99wj): every sign-in is a row, the cookie's JWT carries its sid, a revoked / expired /
// unknown session is a signed-out request (within the 5 s cache across processes, at once in this one); "Your devices" lists
// and revokes; old cookies without a sid are converted on their next request (no mass logout) unless the account signed out
// everywhere since; a password change signs the other devices out (default on); a site-wide ban and an account merge revoke
// every session; a new device files a rate-limited inbox notice.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "sessions-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "sessions"));
const LC = require(path.join(repo, "middleware", "loginCookie"));

let base, server, t0 = Date.now(), clockAt = null;
S._setClock(() => (clockAt === null ? Date.now() : clockAt));

async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, email, password, class, camfrogUsername, points_balance) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                 [id, o.username || id, `${id}@example.com`, o.password || "x", o.class || "pleb", o.cf || null, o.bal || 0]);
}
const cookieOf = (r) => { const m = /(?:^|,\s*)jwt=([^;]*)/.exec(r.headers.get("set-cookie") || ""); return m ? m[1] : null; };
const cleared = (r) => /jwt=;/.test(r.headers.get("set-cookie") || "");
const get = (p, jwtCookie, extra = {}) => fetch(base + p, { redirect: "manual", headers: Object.assign({ cookie: jwtCookie ? "jwt=" + jwtCookie : "" }, extra) });
const post = (p, jwtCookie, body = {}, extra = {}) => fetch(base + p, { method: "POST", redirect: "manual",
  headers: Object.assign({ cookie: jwtCookie ? "jwt=" + jwtCookie : "", origin: base, "content-type": "application/json", "x-requested-with": "fetch" }, extra),
  body: JSON.stringify(body) });
const who = async (c) => (await (await get("/whoami", c)).json()).user;

// a sign-in through the real path (sessions.signIn): -> the cookie
async function signIn(id, method = "password", dev = null, opts = {}) {
  const r = await fetch(base + "/test-signin", { method: "POST", headers: { "content-type": "application/json", "user-agent": opts.ua || "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36",
    cookie: dev ? "patv_dev=" + dev : "" }, body: JSON.stringify({ id, method }) });
  return cookieOf(r);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, email TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  auto_source TEXT, archived_at INTEGER, password_set INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT, role TEXT)");
  for (const id of ["ann", "bob", "cat", "dan", "eve", "fay", "gus", "hal", "ivy"]) await user(id);
  await user("boss", { class: "Admin" });
  await S.init();
  const app = express();
  app.use(cookieParser());
  app.use(S.gate);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  // index.js addUser, condensed
  const addUser = async (req, res, next) => {
    req.user = null;
    const tok = req.cookies.jwt;
    if (tok) { try { req.user = await LC.refreshLogin(res, jwt.verify(tok, process.env.SECRET_KEY), getQuery); } catch (e) { req.user = null; } }
    next();
  };
  app.post("/test-signin", async (req, res) => {
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.body.id]))[0];
    await S.signIn(req, res, u, req.body.method);
    res.json({ ok: true });
  });
  app.get("/whoami", addUser, (req, res) => res.json({ user: req.user ? req.user.userId : null, sid: req.loginSession ? req.loginSession.id : null }));
  app.post("/logout", async (req, res) => {
    const s = req.loginSession;
    if (s) await S.revoke(s.userId, s.id, "signed out");
    LC.clearLogin(res);
    res.redirect("/");
  });
  // the real password form handler
  const uc = require(path.join(repo, "user.controller"));
  app.post("/pw", addUser, (req, res, next) => { req.flash = () => []; next(); }, uc.updatePassword);
  S.register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("sign in -> a session row (random sid, only its hash stored) and the cookie carries it; Your devices lists it", async () => {
  const c = await signIn("ann", "google", "a".repeat(32));
  const d = jwt.verify(c, process.env.SECRET_KEY);
  assert.match(d.sid, /^[A-Za-z0-9_-]{43}$/);
  const rows = await getQuery("SELECT * FROM sessions WHERE user_id = 'ann'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, S.sha(d.sid), "the PK is the SHA-256 of the sid");
  assert.ok(!JSON.stringify(rows).includes(d.sid), "the raw sid is never stored");
  assert.equal(rows[0].method, "google");
  assert.equal(rows[0].device, "Chrome on Windows");
  assert.ok(rows[0].expires - rows[0].created >= 89 * 86400000, "the 90-day policy");
  assert.equal(await who(c), "ann");
  const list = await (await get("/api/account/sessions", c)).json();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].current, true);
  assert.equal(list.sessions[0].method, "google");
});

test("revoke one device / everywhere else / everywhere: the cookie stops working at once", async () => {
  const a = await signIn("bob", "password", "b".repeat(32));
  const b = await signIn("bob", "plex", "c".repeat(32));
  const c = await signIn("bob", "telegram", "d".repeat(32));
  const ids = (await (await get("/api/account/sessions", a)).json()).sessions;
  assert.equal(ids.length, 3);
  const bId = S.sha(jwt.verify(b, process.env.SECRET_KEY).sid);
  // CSRF: a cross-site / non-fetch POST does nothing
  assert.equal((await post("/api/account/sessions/revoke", a, { id: bId }, { origin: "https://evil.example" })).status, 403);
  const r = await (await post("/api/account/sessions/revoke", a, { id: bId })).json();
  assert.equal(r.revoked, 1);
  assert.equal(await who(b), null, "the revoked device is signed out");
  const rb = await get("/whoami", b);
  assert.ok(cleared(rb), "and its cookie is cleared");
  assert.equal(await who(a), "bob");
  // someone else's session id can't be revoked from here
  const ann = (await getQuery("SELECT id FROM sessions WHERE user_id = 'ann'"))[0].id;
  assert.equal((await (await post("/api/account/sessions/revoke", a, { id: ann })).json()).revoked, 0);
  // everywhere else
  const o = await (await post("/api/account/sessions/revoke-others", a)).json();
  assert.equal(o.revoked, 1);
  assert.equal(await who(c), null);
  assert.equal(await who(a), "bob", "this device stays");
  // everywhere including here
  const all = await post("/api/account/sessions/revoke-all", a);
  assert.equal((await all.json()).signedOut, true);
  assert.ok(cleared(all));
  assert.equal(await who(a), null);
  // logout ends the session on the server (a copy of the cookie stops working)
  const d = await signIn("bob");
  await post("/logout", d);
  assert.equal(await who(d), null, "a copy of a signed-out cookie is dead");
});

test("revocation by another process lands within the 5 s cache", async () => {
  const c = await signIn("cat");
  assert.equal(await who(c), "cat");                                       // cached now
  clockAt = Date.now();
  await runQuery("UPDATE sessions SET revoked_at = ? WHERE user_id = 'cat'", [clockAt]);   // as another process would
  assert.equal(await who(c), "cat", "still cached for a moment");
  clockAt += S.CACHE_MS + 1;
  assert.equal(await who(c), null, "gone within seconds");
  clockAt = null;
});

test("expiry slides like the cookie did: last_seen pushes it out; an expired session is refused", async () => {
  const c = await signIn("dan");
  const id = S.sha(jwt.verify(c, process.env.SECRET_KEY).sid);
  clockAt = Date.now() + 10 * 60000;
  await who(c);
  await new Promise((r) => setTimeout(r, 50));
  const row = (await getQuery("SELECT last_seen, expires FROM sessions WHERE id = ?", [id]))[0];
  assert.equal(row.last_seen, clockAt, "last_seen written (throttled: at most every 5 minutes)");
  assert.equal(row.expires, clockAt + S.LOGIN_MS);
  await runQuery("UPDATE sessions SET expires = ? WHERE id = ?", [clockAt - 1, id]);
  clockAt += S.CACHE_MS + 1;
  assert.equal(await who(c), null);
  clockAt = null;
});

test("migration: an old cookie without a sid is converted on its next request (one row, even racing), then revocable", async () => {
  const iat = Math.floor((t0 - 30 * 86400000) / 1000);
  const old = jwt.sign({ userId: "eve", username: "eve", class: "pleb", iat }, process.env.SECRET_KEY, { expiresIn: "90d" });
  const [r1, r2] = await Promise.all([get("/whoami", old), get("/whoami", old)]);
  assert.equal((await r1.json()).user, "eve");
  assert.equal((await r2.json()).user, "eve");
  const rows = await getQuery("SELECT * FROM sessions WHERE user_id = 'eve'");
  assert.equal(rows.length, 1, "two racing requests make ONE session");
  assert.equal(rows[0].method, "legacy");
  assert.equal(rows[0].legacy_before, iat * 1000, "\"Unknown device, signed in before <date>\"");
  const fresh = cookieOf(r1);
  assert.ok(jwt.verify(fresh, process.env.SECRET_KEY).sid, "re-issued with a sid");
  assert.equal(await who(fresh), "eve");
  assert.equal(await who(old), "eve", "the old cookie maps to the same row");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'eve'"))[0].n, 1);
  // sign out everywhere: the converted row AND the old token die
  await post("/api/account/sessions/revoke-all", fresh);
  assert.equal(await who(fresh), null);
  assert.equal(await who(old), null);
  // an old cookie never seen since the switch-over, issued before "sign out everywhere": refused (the cutoff), no row made
  const older = jwt.sign({ userId: "eve", username: "eve", class: "pleb", iat: iat - 100 }, process.env.SECRET_KEY, { expiresIn: "90d" });
  assert.equal(await who(older), null);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'eve'"))[0].n, 1);
  // a converted session never counts as a fresh sign-in (account deletion re-authentication)
  assert.equal(await S.isFresh({ loginSession: { id: rows[0].id, userId: "eve" } }), false);
});

test("password change: the other devices are signed out by default, this one stays; unticked keeps them", async () => {
  const here = await signIn("fay");
  const other = await signIn("fay", "discord", "e".repeat(32));
  const form = (c, extra) => fetch(base + "/pw", { method: "POST", redirect: "manual", headers: { cookie: "jwt=" + c, origin: base, "content-type": "application/x-www-form-urlencoded" },
                                                   body: new URLSearchParams(Object.assign({ password: "a-new-password-1" }, extra)).toString() });
  let r = await form(here, { signout_others_field: "1" });              // the box unticked
  assert.equal(r.status, 302);
  assert.equal(await who(other), "fay", "unticked: other devices stay");
  r = await form(here, { signout_others_field: "1", signout_others: "on" });
  assert.equal(r.headers.get("location"), "/settings/account#password", "this device stays signed in");
  assert.equal(await who(here), "fay");
  assert.equal(await who(other), null, "the other device is out");
});

test("a site-wide ban (staff) signs the account out everywhere; a pad owner's ban doesn't", async () => {
  const c = await signIn("gus");
  const store = require(path.join(repo, "feedstore"));
  await require(path.join(repo, "rooms")).init();
  await store.init();
  await store.ban({ userId: "boss", username: "boss", class: "Admin" }, "gus", { reason: "spam" });
  assert.equal(await who(c), null);
  const n = (await getQuery("SELECT revoked_why FROM sessions WHERE user_id = 'gus'"))[0];
  assert.equal(n.revoked_why, "ban");
});

test("an admin can sign a member out everywhere (audited); members can't", async () => {
  const c = await signIn("hal");
  const admin = await signIn("boss");
  assert.equal((await post("/api/admin/users/hal/sessions/revoke", c)).status, 403);
  const r = await (await post("/api/admin/users/hal/sessions/revoke", admin, { reason: "compromised" })).json();
  assert.equal(r.revoked, 1);
  assert.equal(await who(c), null);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'sessions.revoke_all' AND target_id = 'hal'"))[0].n, 1);
});

test("an account merge revokes the merged-away account's sessions (and the merge rule for the table exists)", async () => {
  const AM = require(path.join(repo, "accountMerge"));
  assert.ok(AM.classify("sessions", "user_id") && AM.classify("sessions", "user_id").keep, "sessions.user_id is classified: never moved (the merge ends them)");
  assert.ok(AM.classify("session_cutoffs", "user_id"));
  const c = await signIn("ivy");
  await user("ivy2");
  const keep = await signIn("ivy2");
  await tx(async () => { await AM.moveUserRows("ivy", "ivy2"); await runQuery("DELETE FROM users WHERE userId = 'ivy'"); });   // as every merge does
  assert.equal(await who(c), null, "a cookie for the merged-away account is no login to anything");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'ivy'"))[0].n, 0, "nothing left on the old id");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'ivy2'"))[0].n, 1, "nothing moved onto the target");
  assert.equal(await who(keep), "ivy2");
  // an old sid-less cookie of the merged-away account can't be converted either
  const old = jwt.sign({ userId: "ivy", username: "ivy", class: "pleb", iat: Math.floor(t0 / 1000) - 60 }, process.env.SECRET_KEY);
  assert.equal(await who(old), null);
});

test("a new device files an inbox notice (not the same browser twice, not the first session, at most 3 an hour)", async () => {
  await user("jo");
  const notices = async () => (await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'jo' AND title = 'New sign-in on a new device'").catch(() => [{ n: 0 }]))[0].n;
  await signIn("jo", "password", "1".repeat(32));
  assert.equal(await notices(), 0, "the first session on record: nothing to compare with");
  await signIn("jo", "password", "1".repeat(32));
  assert.equal(await notices(), 0, "the same browser again");
  await signIn("jo", "google", "2".repeat(32));
  assert.equal(await notices(), 1, "a new browser");
  await signIn("jo", "chat", "3".repeat(32));
  assert.equal(await notices(), 1, "chat sign-ins file their own notice (chatsignin.js)");
  for (const d of ["4", "5", "6", "7"]) await signIn("jo", "plex", d.repeat(32));
  assert.equal(await notices(), 3, "rate-limited");
});

test("coarse device names, never the raw user agent", () => {
  assert.equal(S.describe("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"), "Safari on iOS");
  assert.equal(S.describe("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"), "Chrome on Android");
  assert.equal(S.describe("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox on macOS");
  assert.equal(S.describe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0"), "Edge on Windows");
  assert.equal(S.describe(""), "Unknown browser");
});

test("every sign-in path issues the cookie through sessions.signIn (no bare issueLogin left)", () => {
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  const uc = src("user.controller.js"), ix = src("index.js");
  assert.ok(!/issueLogin\(res/.test(uc), "user.controller: no bare issueLogin");
  assert.ok(!/issueLogin\(res/.test(ix), "index.js: no bare issueLogin");
  assert.match(uc, /sessions"\)\.signIn\(req, res, user/, "finishLogin -> sessions.signIn");
  assert.match(ix, /loginSessions\.signIn\(req, res, currentUser, "twitch"/);
  assert.match(ix, /loginSessions\.signIn\(req, res, currentUser, "discord"/);
  assert.match(ix, /app\.use\(cookieParser[^\n]*\r?\n(?:\/\/[^\n]*\r?\n)*const loginSessions = require\("\.\/sessions"\);\r?\napp\.use\(loginSessions\.gate\);/, "the gate sits right after cookie-parser");
});
