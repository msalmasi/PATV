// 1.99ui: one username length limit (usernamerules.USERNAME_MAX = 48) for what the site RECOGNISES and what anyone can CHOOSE.
// Prod's longest username is 46 characters; the old 40-character pattern hid it from the @mention dropdown, from
// @mentions (no link, no notice) and from u/<name> refs. New names were capped at 24 (sign-up / rename / SSO) or not at all
// (Pepe's automatic "CF..." accounts); they are now all capped at 48.
//   * @mentions: a 46- and a 48-character name match (with trailing punctuation), a 49-character one never does (not even
//     its first 48 characters); emails, URLs and "@" inside a word still never match
//   * u/<name> refs, profile scopes (Hop, the gallery, the feed's seen state)
//   * suggest returns the 46-character name; a mention of it notifies
//   * sign-up and the Edit-profile rename refuse 49 characters and accept 48; the client copies of the limit agree
//   * S1 F13 (chatsweep.js): the rename, and a password change that signs this device out, set the chat sweep's marker
//   NODE_PATH=G:/PATV/node_modules node --test test/username-limit.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "username-limit-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const UR = require(path.join(repo, "usernamerules"));
const guard = require(path.join(repo, "middleware", "authGuard"));
const FM = require(path.join(repo, "feedmentions"));
const pads = require(path.join(repo, "pads"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const MN = require(path.join(repo, "mentions"));
require(path.join(repo, "terms"))._setRequired(false);

const L46 = "Whereismymoneyfortrainingurbotandsellingmydata";       // prod's longest (Camfrog login tricon)
const L48 = "Long_name.with-dots" + "x".repeat(29);
const L49 = "y".repeat(49);
const ROOM = "plant_based_chatting";
const U = {};

async function mkUser(id, name, display = name) {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, level, created_at)
                  VALUES (?, ?, ?, 'x', 'pleb', 0, 5, '2026-01-01 00:00:00')`, [id, name, display]);
  return { userId: id, username: name, displayname: display, class: "pleb" };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, emailVerificationToken TEXT,
                  tokenExpires DATETIME, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  U.owner = await mkUser("u_owner", "plantowner");
  U.long = await mkUser("u_long", L46, "tricon");
  U.l48 = await mkUser("u_l48", L48);
  U.bob = await mkUser("u_bob", "bob");
  await rooms.init();
  await rooms.setOwner(ROOM, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  await MN.init();
  pads._setNames(new Map([U.owner, U.long, U.l48, U.bob].map((u) => [u.username.toLowerCase(), u.username])));
});

test("the limit is 48, in one place; the patterns are built from it", () => {
  assert.equal(UR.USERNAME_MAX, 48);
  assert.equal(L46.length, 46); assert.equal(L48.length, 48); assert.equal(L49.length, 49);
  const full = new RegExp("^" + UR.NAME_SRC + "$");
  assert.ok(full.test(L46) && full.test(L48) && !full.test(L49));
  assert.ok(UR.NEW_USERNAME_RE.test(L48) && !UR.NEW_USERNAME_RE.test(L49) && !UR.NEW_USERNAME_RE.test("ab"));
});

test("@mentions: 46 and 48 characters match (trailing punctuation left out); 49 never does, not even its first 48", () => {
  assert.deepEqual(FM.names(`hi @${L46}, and @${L48}.`), [L46.toLowerCase(), L48.toLowerCase()]);
  assert.deepEqual(FM.names(`(@${L46})`), [L46.toLowerCase()]);
  assert.deepEqual(FM.names(`@${L46}! @${L46}?`), [L46.toLowerCase()], "distinct");
  assert.deepEqual(FM.names(`@${L49}`), []);
  assert.deepEqual(FM.names(`@${L49}.`), []);
  assert.deepEqual(FM.names(`@${L49}-x`), []);
  assert.deepEqual(FM.names(`@${L46}abc`), [], "46 + three more letters is a 49-character name");
  // the boundaries are unchanged: emails, URLs and @ inside a word never match
  assert.deepEqual(FM.names(`${L46}@example.com`), []);
  assert.deepEqual(FM.names(`mail x@${L46}.com`), []);
  assert.deepEqual(FM.names(`https://example.com/@${L46}`), []);
  assert.deepEqual(FM.names(`word@${L46}`), []);
  assert.deepEqual(FM.names(`a+@${L46}`), []);
  assert.deepEqual(FM.names("hi @Bob and @alice, @bob again; mail me at x@bob.com"), ["bob", "alice"], "the old cases still hold");
  // rendering: the known long name links, the 49-character one stays text
  const h = FM.inlineRefs(`hey @${L46}, @${L49}`);
  assert.ok(h.includes(`<a class="user-ref mention" href="/u/${L46}">@${L46}</a>,`), h);
  assert.ok(h.includes(` @${L49}`) && !h.includes(`>@${L49}`), h);
});

test("u/<name> refs and profile scopes take names up to 48", () => {
  const h = pads.userRefs(`see u/${L46}. and u/${L48} but not u/${L49}`);
  assert.ok(h.includes(`>u/${L46}</a>.`), h);
  assert.ok(h.includes(`>u/${L48}</a>`), h);
  assert.ok(h.includes(` u/${L49}`) && !h.includes(`>u/${L49}`), h);
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  for (const f of ["hop.js", "feedgallery.js", "feedseen.js"]) {
    assert.match(src(f), /usernamerules/, `${f} uses the shared limit`);
    assert.doesNotMatch(src(f), /\{1,40\}\)?(\(\?:\\\/profile\))?\)?\$/, `${f} has no 40-character username pattern left`);
  }
});

test("suggest returns the 46-character name; a mention of it notifies", async () => {
  let people = await FM.suggest("Whereis", U.bob);
  assert.deepEqual(people.map((p) => p.username), [L46]);
  assert.equal(people[0].display, "tricon");
  people = await FM.suggest("@" + L46, U.bob);
  assert.deepEqual(people.map((p) => p.username), [L46], "the whole name typed");
  people = await FM.suggest("Long_name", U.bob);
  assert.deepEqual(people.map((p) => p.username), [L48]);
  const P = await store.create(U.bob.userId, { community: ROOM, title: "hello", body: `hey @${L46}!` });
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'mention'", [U.long.userId]);
  assert.equal(n.length, 1, "the long name was told");
  assert.ok(n[0].link.includes(P.id));
});

test("checkUsername: 48 accepted, 49 refused with the 3-48 message", () => {
  assert.equal(guard.checkUsername("a" + "b".repeat(46) + "c"), null);
  assert.match(guard.checkUsername("a".repeat(49)), /3-48 characters/);
  assert.match(guard.checkUsername("ab"), /3-48 characters/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["auth.err.username_chars", "js.auth.username_chars", "auth.register.username_hint"]) assert.match(en[k], /3-48/, k);
});

function fakeReq(body, ip, user) {
  const flashes = [];
  const req = { body, user, flashes, get: (h) => (h === "host" ? "test" : h === "cf-connecting-ip" ? ip : undefined), cookies: {}, secure: true, socket: {},
                flash: (k, v) => flashes.push([k, v]) };
  return req;
}
function fakeRes() {
  const res = { redirected: null, cookies: [], cleared: [], locals: {}, redirect: (u) => { res.redirected = u; }, status: () => res, send: () => {} };
  res.cookie = (n, v, o) => { res.cookies.push({ n, v, o }); };
  res.clearCookie = (n) => { res.cleared.push(n); };
  return res;
}
// S1 F13 (chatsweep.js): a route that signs this browser out also sets the chat sweep's marker (always "1")
const sweepMarker = (res) => res.cookies.filter((c) => c.n === "patv_chat_sweep").map((c) => c.v);

test("sign-up refuses 49 characters and accepts 48", async () => {
  const { registerUser } = require(path.join(repo, "user.controller"));
  const n49 = "Signup" + "z".repeat(43), n48 = "Signup" + "z".repeat(42);
  let req = fakeReq({ username: n49, email: "s49@example.com", password: "a-long-password-1", confirm_password: "a-long-password-1" }, "192.0.2.10");
  let res = fakeRes();
  await registerUser(req, res);
  assert.match(res.redirected, /^\/register/);
  assert.ok(req.flashes.some(([k, v]) => k === "error" && /3-48 characters/.test(v)), JSON.stringify(req.flashes));
  assert.equal((await getQuery("SELECT 1 FROM users WHERE username = ?", [n49])).length, 0);
  req = fakeReq({ username: n48, email: "s48@example.com", password: "a-long-password-1", confirm_password: "a-long-password-1" }, "192.0.2.11");
  res = fakeRes();
  await registerUser(req, res);
  assert.equal((await getQuery("SELECT 1 FROM users WHERE username = ?", [n48])).length, 1, JSON.stringify(req.flashes));
});

test("rename (Edit profile) refuses 49 characters and accepts 48", async () => {
  const { updateUsername } = require(path.join(repo, "user.controller"));
  await mkUser("u_ren", "renameme");
  const me = { userId: "u_ren", username: "renameme", class: "pleb" };
  let req = fakeReq({ username: "R".repeat(49) }, "192.0.2.12", me);
  let res = fakeRes();
  await updateUsername(req, res);
  assert.ok(req.flashes.some(([k, v]) => k === "error" && /3-48 characters/.test(v)), JSON.stringify(req.flashes));
  assert.equal((await getQuery("SELECT username FROM users WHERE userId = 'u_ren'"))[0].username, "renameme");
  assert.deepEqual(sweepMarker(res), [], "a refused rename signs nobody out");
  const n48 = "R" + "e".repeat(47);
  req = fakeReq({ username: n48 }, "192.0.2.12", me);
  res = fakeRes();
  await updateUsername(req, res);
  for (let i = 0; i < 50 && !res.redirected; i++) await new Promise((r) => setTimeout(r, 20));   // its db.get callback
  assert.equal(res.redirected, "/login", JSON.stringify(req.flashes));
  assert.equal((await getQuery("SELECT username FROM users WHERE userId = 'u_ren'"))[0].username, n48);
  // the rename signs this device out (it signs in again with the new name): the login goes, the chat sweep's marker is set
  assert.deepEqual(res.cleared, ["jwt"]);
  assert.deepEqual(sweepMarker(res), ["1"], "S1 F13: /login sweeps the chat databases");
});

test("S1 F13: a password change that signs this device out sets the chat sweep's marker; one that keeps it signed in doesn't", async () => {
  const { updatePassword } = require(path.join(repo, "user.controller"));
  await mkUser("u_pw", "pwchanger");
  const me = { userId: "u_pw", username: "pwchanger", class: "pleb" };
  // no server-side session on this device (an old cookie) + "Sign out my other devices": this device is signed out too
  let req = fakeReq({ password: "a-new-long-password-1" }, "192.0.2.13", me);
  let res = fakeRes();
  await updatePassword(req, res);
  assert.equal(res.redirected, "/login");
  assert.deepEqual(res.cleared, ["jwt"]);
  assert.deepEqual(sweepMarker(res), ["1"]);
  // this device's session stays: nothing is cleared, no marker
  req = Object.assign(fakeReq({ password: "a-newer-long-password-2" }, "192.0.2.13", me), { loginSession: { id: "s-here", userId: "u_pw" } });
  res = fakeRes();
  await updatePassword(req, res);
  assert.notEqual(res.redirected, "/login");
  assert.deepEqual(res.cleared, []);
  assert.deepEqual(sweepMarker(res), []);
});

test("derived names (Twitch / Discord / Plex / SSO) are cut to 48; Pepe's rename and CF accounts use the same rule", () => {
  const UC = require(path.join(repo, "user.controller"));
  assert.equal(UC.normaliseUsername("a".repeat(60)), "a".repeat(48));
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const rename = idx.slice(idx.indexOf('app.post("/api/users/camfrog/rename"'), idx.indexOf('app.post("/api/users/camfrog/rename"') + 800);
  assert.match(rename, /usernamerules"\)\.NEW_USERNAME_RE\.test\(name\)/);
  const reg = idx.slice(idx.indexOf("app.post('/api/users/camfrog/register'"), idx.indexOf("app.post('/api/users/camfrog/register'") + 900);
  assert.match(reg, /usernamerules"\)\.NEW_USERNAME_RE\.test\(username\)/);
  assert.doesNotMatch(idx, /\{3,24\}/);
});

test("the client-side copies of the limit agree with usernamerules.USERNAME_MAX", () => {
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  const max = String(UR.USERNAME_MAX);
  for (const f of ["views/register.ejs", "views/plexSso.ejs", "views/ssoNew.ejs"]) assert.match(src(f), new RegExp(`name="username"[^]{0,300}?maxlength="${max}"`), f);
  assert.match(src("views/settingsAccount.ejs"), new RegExp(`id="username" name="username"[^]{0,80}?maxlength="${max}"`));
  assert.ok(src("views/partials/auth-js.ejs").includes(`[A-Za-z0-9_.-]{3,${max}}$/`));
  assert.match(src("public/js/mention-complete.js"), new RegExp(`var USERNAME_MAX = ${max};`));
});
