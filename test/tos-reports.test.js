// Offline tests for 1.99cc: abuse metadata on posts / comments (contentaudit.js: capture, admin-only access,
// no leakage, retention), the Terms of Service gate + acceptance (terms.js), and reports v2 (feedstore.js:
// the modal's reasons, rate limits, the urgent CSAM path, owner vs admin queues, admin outcomes, user reports).
//   NODE_PATH=G:/PATV/node_modules node --test test/tos-reports.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tos-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

// Everything printed while these tests run, to prove no IP / user agent / language ever reaches a log line.
const LOGGED = [];
for (const k of ["log", "error", "warn", "info"]) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { LOGGED.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); orig(...a); };
}

const express = require("express");
const cookieParser = require("cookie-parser");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const audit = require(path.join(repo, "contentaudit"));
const terms = require(path.join(repo, "terms"));

const ROOM = "plant_based_chatting";
const IP = "203.0.113.77", IP2 = "198.51.100.23", UA = "SentinelUA/9.9 (leakcheck)", LANG = "xx-SENTINEL,en;q=0.5", DEV = "ab".repeat(16), DEV2 = "cd".repeat(16);
const SECRETS = [IP, IP2, "SentinelUA", "xx-SENTINEL", DEV, DEV2];
let base, server, U = {};
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, discordId, level, created_at, casino_banned, email)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, ?, ?, ?, 0, ?)`,
                 [id, name, name, extra.class || "pleb", extra.camfrog || null, extra.discord || null, extra.level || 0, extra.created || "2026-01-01 00:00:00", name + "@example.com"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT UNIQUE, xp INTEGER DEFAULT 0,
                  avatar TEXT, emailVerificationToken TEXT, tokenExpires DATETIME, isEmailVerified INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.admin2 = await mkUser("boss2", { class: "Admin" });
  U.staff = await mkUser("helper", { class: "Staff", camfrog: "helpercf" });
  U.alice = await mkUser("alice", { camfrog: "alicecf", discord: "123" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.carol = await mkUser("carol", { camfrog: "carolcf" });
  U.dave = await mkUser("dave", { camfrog: "davecf" });
  U.erin = await mkUser("erin", { camfrog: "erincf" });
  U.fresh = await mkUser("fresh", { camfrog: "freshcf" });
  await rooms.init();
  await rooms.setOwner(ROOM, "plantowner", "test");
  await store.init();
  await terms.init();
  await audit.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  // 1.99cf: the gate is an admin switch (default off) that can't go on while the pages have [[placeholders]].
  // These tests run with it ON, as if the pages were finished; "Terms switch" below covers off + the refusal.
  assert.equal(store.config().terms_enforced, false, "default off");
  assert.equal(terms.enforced(), false);
  terms._setPlaceholders([]);
  await store.setConfig({ terms_enforced: true }, "test");
  assert.equal(terms.enforced(), true);
  // everyone but "fresh" has accepted the current Terms (fresh is the existing user who'll be asked)
  for (const u of users.values()) if (u.username !== "fresh") await terms.accept(u.userId);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  terms.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

// a browser behind Cloudflare: real IP, UA, language, country, device cookie
const NET = (ip = IP, dev = DEV) => ({ "cf-connecting-ip": ip, "user-agent": UA, "accept-language": LANG, "cf-ipcountry": "NZ", cookie: "patv_dev=" + dev });
const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
// 1.99ci: every post lives in exactly one community - tests post to the PATV Lounge unless they pick one
// (community / rooms set), or send noCommunity: true to test the refusal.
const LOUNGE = "patv:lounge";
const withCommunity = (url, body) => (url === "/api/feed/posts" && body && typeof body === "object" && body.community === undefined && !body.rooms && !body.noCommunity
  ? { ...body, community: LOUNGE } : body);
async function call(method, url, u, body, extra) {
  body = withCommunity(url, body);
  const r = await fetch(base + url, { method, headers: H(u, extra), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const post = (url, u, body, extra) => call("POST", url, u, body, extra);
const get = (url, u, extra) => call("GET", url, u, undefined, extra);
const noSecrets = (s, where) => { for (const x of SECRETS) assert.ok(!String(s).includes(x), `${where} leaks ${x}`); };
async function mkPost(u, body = {}, net = NET()) {
  const r = await post("/api/feed/posts", u, { body: "hello", ...body }, net);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d.id;
}
const inbox = async (u, like) => getQuery("SELECT * FROM inbox WHERE user_id = ? AND title LIKE ?", [u.userId, like]);

// ───────────────────────────── capture ─────────────────────────────
test("capture: create + edit of posts and comments each write one admin-only record (IP, UA, language, country, age, linked, hashed device)", async () => {
  const id = await mkPost(U.alice, { body: "audited post" });
  let rows = await getQuery("SELECT * FROM content_audit WHERE target_id = ?", [id]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.kind, "post"); assert.equal(r.event, "create"); assert.equal(r.user_id, U.alice.userId);
  assert.equal(r.ip, IP); assert.equal(r.ua, UA); assert.equal(r.lang, LANG); assert.equal(r.country, "NZ"); assert.equal(r.via, "cf");
  assert.ok(r.acct_age_s > 86400 * 100, "account age at the time");
  assert.deepEqual(JSON.parse(r.linked), { camfrog: true, discord: true, twitch: false });
  assert.match(r.ip_hash, /^[0-9a-f]{32}$/); assert.ok(!r.ip_hash.includes(IP));
  assert.match(r.session_hash, /^[0-9a-f]{32}$/); assert.notEqual(r.session_hash, DEV);
  assert.equal((await post(`/api/feed/posts/${id}/edit`, U.alice, { body: "edited" }, NET(IP2))).status, 200);
  rows = await getQuery("SELECT event, ip FROM content_audit WHERE target_id = ? ORDER BY id", [id]);
  assert.deepEqual(rows.map((x) => x.event), ["create", "edit"]);
  assert.equal(rows[1].ip, IP2);
  const c = await post(`/api/feed/posts/${id}/comments`, U.bob, { body: "a comment" }, NET());
  assert.equal(c.status, 200);
  assert.equal((await post(`/api/feed/comments/${c.d.id}/edit`, U.bob, { body: "edited comment" }, NET())).status, 200);
  const cr = await getQuery("SELECT kind, event, post_id FROM content_audit WHERE target_id = ? ORDER BY id", [c.d.id]);
  assert.deepEqual(cr.map((x) => x.kind + ":" + x.event), ["comment:create", "comment:edit"]);
  assert.equal(cr[0].post_id, id);
  // a bad country header is dropped, IPv6 networks hash by /64
  assert.equal(audit.netOf("2001:db8:aa:bb:1:2:3:4"), "2001:db8:aa:bb::/64");
  const id2 = await mkPost(U.alice, {}, { ...NET(), "cf-ipcountry": "<script>" });
  assert.equal((await getQuery("SELECT country FROM content_audit WHERE target_id = ?", [id2]))[0].country, null);
});

// ───────────────────────────── admin-only access ─────────────────────────────
test("details: site Admins only (anon 401, member / room owner / Staff 403), needs the fetch header, and every admin view is logged", async () => {
  const id = await mkPost(U.alice, { body: "in the room", rooms: [ROOM] });
  const before = (await getQuery("SELECT COUNT(*) AS n FROM content_audit_views"))[0].n;
  assert.equal((await get(`/api/feed/admin/details?post=${id}`, null)).status, 401);
  for (const u of [U.bob, U.owner, U.staff, U.alice]) {
    const r = await get(`/api/feed/admin/details?post=${id}`, u);
    assert.equal(r.status, 403, u.username);
    noSecrets(r.text, "denied response");
  }
  const noHdr = await fetch(`${base}/api/feed/admin/details?post=${id}`, { headers: { "x-test-user": U.admin.userId } });
  assert.equal(noHdr.status, 403, "a cross-site <img> can't trigger (or log) a view");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM content_audit_views"))[0].n, before, "refused attempts read and log nothing");
  const ok = await get(`/api/feed/admin/details?post=${id}`, U.admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.d.details.records[0].ip, IP);
  assert.equal(ok.d.details.records[0].ua, UA);
  assert.equal(ok.d.details.subject.username, "alice");
  const log = await getQuery("SELECT * FROM content_audit_views ORDER BY id DESC LIMIT 1");
  assert.equal(log[0].admin_id, U.admin.userId); assert.equal(log[0].target_kind, "post"); assert.equal(log[0].target_id, id); assert.equal(log[0].subject_id, U.alice.userId);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM content_audit_views"))[0].n, before + 1);
  // unknown target: a plain 404 with no data
  const nf = await get("/api/feed/admin/details?post=zzzzzzzzzzzz", U.admin);
  assert.equal(nf.status, 404);
  // user details
  const ud = await get(`/api/feed/admin/details?user=${U.alice.userId}`, U.admin);
  assert.equal(ud.status, 200);
  assert.ok(ud.d.details.records.length >= 1);
});

test("details: other accounts on the same network / browser in the last 90 days, plus the user's posting and report history", async () => {
  const mine = await mkPost(U.dave, { body: "dave's" }, NET("192.0.2.50", "ef".repeat(16)));
  await mkPost(U.erin, { body: "erin's" }, NET("192.0.2.50", "01".repeat(16)));         // same network
  await mkPost(U.carol, { body: "carol's" }, NET("192.0.2.99", "ef".repeat(16)));        // same browser
  const d = (await get(`/api/feed/admin/details?post=${mine}`, U.admin)).d.details;
  assert.deepEqual(d.sameIp.map((x) => x.username), ["erin"]);
  assert.deepEqual(d.sameDevice.map((x) => x.username), ["carol"]);
  assert.ok(d.history.totals.posts >= 1);
  assert.ok(d.history.posts.some((p) => p.id === mine));
  // older than 90 days doesn't count as "same network"
  await runQuery("UPDATE content_audit SET at = ? WHERE user_id = ?", [Date.now() - 100 * 86400e3, U.erin.userId]);
  const d2 = (await get(`/api/feed/admin/details?post=${mine}`, U.admin)).d.details;
  assert.deepEqual(d2.sameIp, []);
});

// ───────────────────────────── no leakage ─────────────────────────────
test("no leakage: pages, JSON APIs, the owner's queue, profiles and logs never carry the IP / UA / language / device", async () => {
  const id = await mkPost(U.alice, { body: "leak check", rooms: [ROOM] });
  const cm = await post(`/api/feed/posts/${id}/comments`, U.bob, { body: "leak comment" }, NET());
  noSecrets(JSON.stringify(cm.d), "comment API");
  const rep = await post(`/api/feed/posts/${id}/report`, U.carol, { reason: "spam", note: "spammy" }, NET());
  noSecrets(rep.text, "report API");
  for (const u of [null, U.bob, U.owner, U.staff, U.admin]) {
    for (const url of ["/feed", `/feed/p/${id}`, `/feed?room=${ROOM}`, "/api/feed/report-reasons", "/terms", "/privacy"]) {
      const r = await get(url, u);
      assert.ok(r.status === 200, `${url} as ${u ? u.username : "anon"}: ${r.status}`);
      noSecrets(r.text, `${url} as ${u ? u.username : "anon"}`);
    }
  }
  // the admin pages themselves don't print it either (only the logged details API does)
  for (const url of ["/feed/admin", `/rooms/${ROOM}/feed/mod`]) noSecrets((await get(url, U.admin)).text, url + " (admin)");
  const own = await get(`/rooms/${ROOM}/feed/mod`, U.owner);
  assert.equal(own.status, 200);
  noSecrets(own.text, "owner queue");
  // the data helpers other pages use
  noSecrets(JSON.stringify(await store.list({ viewer: U.admin })), "store.list");
  noSecrets(JSON.stringify(await store.get(id, U.admin, { detail: true })), "store.get");
  noSecrets(JSON.stringify(await store.reports()), "store.reports");
  noSecrets(JSON.stringify(await store.roomReports(ROOM)), "store.roomReports");
  noSecrets(JSON.stringify(await web.profileSocial({ userId: U.alice.userId, username: "alice" }, U.admin)), "profileSocial");
  noSecrets(JSON.stringify(await web.roomFeed(ROOM, U.owner, {})), "roomFeed");
  // nothing printed so far in this whole file (create, edit, comment, report, details, errors) mentions them
  noSecrets(LOGGED.join("\n"), "console output");
});

test("room owners: author's account age + linked status in their queue, never network data", async () => {
  const id = await mkPost(U.alice, { body: "owner sees age", rooms: [ROOM] });
  await post(`/api/feed/posts/${id}/report`, U.dave, { reason: "harassment" });
  const g = (await store.roomReports(ROOM)).find((x) => x.postId === id);
  assert.ok(g.authorInfo);
  assert.deepEqual(Object.keys(g.authorInfo).sort(), ["ageDays", "linked"]);
  assert.ok(g.authorInfo.ageDays > 100);
  assert.deepEqual(g.authorInfo.linked, { camfrog: true, discord: true, twitch: false });
  const page = (await get(`/rooms/${ROOM}/feed/mod`, U.owner)).text;
  assert.match(page, /months old/);
  assert.doesNotMatch(page, /View details/, "no admin details button for owners");
});

// ───────────────────────────── retention ─────────────────────────────
test("retention: raw IP + UA nulled after 90 days (hash kept), rows deleted after 365, the view log after 2 years", async () => {
  const now = Date.now();
  const ins = (at, tid) => runQuery(`INSERT INTO content_audit (kind, target_id, user_id, event, at, ip, ua, ip_hash, lang, country, session_hash)
                                     VALUES ('post', ?, 'u_alice', 'create', ?, '192.0.2.1', 'OldUA', 'hhhh', 'en', 'GB', 'ssss')`, [tid, at]);
  await ins(now - 10 * 86400e3, "ret_recent");
  await ins(now - 91 * 86400e3, "ret_91");
  await ins(now - 366 * 86400e3, "ret_366");
  await runQuery("INSERT INTO content_audit_views (at, admin_id, target_kind, target_id) VALUES (?, 'u_boss', 'post', 'old')", [now - 731 * 86400e3]);
  const r = await audit.sweep(now);
  assert.ok(r.rawNulled >= 1 && r.deleted >= 1 && r.viewsDeleted >= 1);
  const row = async (t) => (await getQuery("SELECT * FROM content_audit WHERE target_id = ?", [t]))[0];
  assert.equal((await row("ret_recent")).ip, "192.0.2.1");
  const old = await row("ret_91");
  assert.equal(old.ip, null); assert.equal(old.ua, null); assert.ok(old.raw_purged_at);
  assert.equal(old.ip_hash, "hhhh", "the hash stays for longer matching"); assert.equal(old.country, "GB");
  assert.equal(await row("ret_366"), undefined);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM content_audit_views WHERE target_id = 'old'"))[0].n, 0);
  assert.deepEqual(await audit.sweep(now), { rawNulled: 0, deleted: 0, viewsDeleted: 0 }, "idempotent");
});

// ───────────────────────────── Terms ─────────────────────────────
test("Terms: an existing user is asked once (428 code terms), acceptance is recorded with the version and time, then posting just works", async () => {
  assert.equal(await terms.needs(U.fresh.userId), true);
  const comp = await web.composerFor({ ...(await store.account(U.fresh.userId)) }, null);
  assert.equal(comp.terms.needed, true);
  const html = (await get("/feed", U.fresh)).text;
  assert.match(html, /name="acceptTerms"/, "the composer shows the one-time tick box");
  const r = await post("/api/feed/posts", U.fresh, { body: "first post after the change" }, NET());
  assert.equal(r.status, 428);
  assert.equal(r.d.code, "terms");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_posts WHERE body = 'first post after the change'"))[0].n, 0);
  const t0 = Date.now();
  const ok = await post("/api/feed/posts", U.fresh, { body: "first post after the change", acceptTerms: true }, NET());
  assert.equal(ok.status, 200);
  const a = await terms.accepted(U.fresh.userId);
  assert.equal(a.version, terms.VERSION);
  assert.ok(a.at >= t0 && a.at <= Date.now());
  assert.equal((await post("/api/feed/posts", U.fresh, { body: "second" }, NET())).status, 200, "never asked again");
  assert.doesNotMatch((await get("/feed", U.fresh)).text, /name="acceptTerms"/);
  assert.match((await get("/feed", U.fresh)).text, /By posting you agree to the/);
  // comments are gated the same way
  await runQuery("UPDATE users SET terms_accepted_version = NULL, terms_accepted_at = NULL WHERE userId = ?", [U.fresh.userId]);
  const pid = await mkPost(U.alice);
  assert.equal((await post(`/api/feed/posts/${pid}/comments`, U.fresh, { body: "hi" })).status, 428);
  assert.equal((await post(`/api/feed/posts/${pid}/comments`, U.fresh, { body: "hi", acceptTerms: true })).status, 200);
  // the accept endpoint (same-site fetch only)
  await runQuery("UPDATE users SET terms_accepted_version = 'old' WHERE userId = ?", [U.fresh.userId]);
  assert.equal((await fetch(base + "/api/terms/accept", { method: "POST", headers: { "x-test-user": U.fresh.userId } })).status, 403);
  assert.equal((await post("/api/terms/accept", null, {})).status, 401);
  assert.equal((await post("/api/terms/accept", U.fresh, {})).status, 200);
  assert.equal((await terms.accepted(U.fresh.userId)).version, terms.VERSION);
});

test("Terms: sign-up through the form records acceptance; the form and the pages say so", async () => {
  const { registerUser } = require(path.join(repo, "user.controller"));
  const flashes = [];
  let redirected = null;
  const req = { body: { username: "newperson", email: "newperson@example.com", password: "a-long-password-1", confirm_password: "a-long-password-1" },
                get: (h) => (h === "host" ? "test" : h === "cf-connecting-ip" ? "192.0.2.200" : undefined), cookies: {}, secure: true, socket: {},
                flash: (k, v) => flashes.push([k, v]) };
  const res = { cookie: () => {}, redirect: (u) => { redirected = u; }, status: () => res, send: () => {} };
  await registerUser(req, res);
  assert.ok(redirected, JSON.stringify(flashes));
  const row = (await getQuery("SELECT terms_accepted_version AS v, terms_accepted_at AS at FROM users WHERE username = 'newperson'"))[0];
  assert.equal(row.v, terms.VERSION);
  assert.ok(row.at > 0);
  const reg = fs.readFileSync(path.join(repo, "views", "register.ejs"), "utf8");
  assert.match(reg, /agree to the <a href="\/terms"/);
  const t = await get("/terms", null);
  assert.equal(t.status, 200);
  assert.match(t.text, new RegExp("Last updated " + terms.UPDATED));
  assert.match(t.text, /\[\[CONTACT EMAIL\]\]/);
  assert.match(t.text, /no cash value/);
  assert.match(t.text, /18 years old/);
  const p = await get("/privacy", null);
  assert.match(p.text, /Last updated/);
  assert.match(p.text, /90 days/);
  assert.match(p.text, /transcribed/);
  assert.match(p.text, /patv_dev/);
  assert.match(t.text, /id="siteFootTpl"/, "footer links on every layout page");
  assert.match(t.text, /href="\/privacy">Privacy Policy/);
  assert.doesNotMatch(t.text, /class="draft"/, "no Draft banner while enforced");
});

// 1.99cf: the switch. Off (the default): no acceptance anywhere, the pages say Draft. On: as above. Turning it on
// is refused while the pages still have [[placeholders]], and /feed/admin lists them.
const renderView = (view, locals) => new Promise((ok, bad) => {
  require("ejs").renderFile(path.join(repo, "views", view + ".ejs"), locals, {}, (e, html) => (e ? bad(e) : ok(html)));
});
test("Terms switch: off = posting + commenting work with no acceptance, no 428, no 'By posting you agree', sign-up records nothing, pages say Draft", async () => {
  await store.setConfig({ terms_enforced: false }, "test");
  try {
    assert.equal(terms.enforced(), false);
    await runQuery("UPDATE users SET terms_accepted_version = NULL, terms_accepted_at = NULL WHERE userId = ?", [U.fresh.userId]);
    assert.equal(await terms.needs(U.fresh.userId), false);
    const html = (await get("/feed", U.fresh)).text;
    assert.doesNotMatch(html, /name="acceptTerms"/);
    assert.doesNotMatch(html, /By posting you agree/);
    const r = await post("/api/feed/posts", U.fresh, { body: "posting while the terms are a draft" }, NET());
    assert.equal(r.status, 200, JSON.stringify(r.d));
    const c = await post(`/api/feed/posts/${r.d.id}/comments`, U.fresh, { body: "a comment, no terms asked" });
    assert.equal(c.status, 200, JSON.stringify(c.d));
    assert.doesNotMatch((await get("/feed/p/" + r.d.id, U.fresh)).text, /by commenting you agree/);
    assert.equal((await terms.accepted(U.fresh.userId)).version, null, "nothing recorded");
    // sign-up: the form has no agreement line and nothing is recorded
    const { registerUser } = require(path.join(repo, "user.controller"));
    let redirected = null;
    const req = { body: { username: "draftperson", email: "draftperson@example.com", password: "a-long-password-1", confirm_password: "a-long-password-1" },
                  get: (h) => (h === "host" ? "test" : h === "cf-connecting-ip" ? "192.0.2.201" : undefined), cookies: {}, secure: true, socket: {}, flash: () => {} };
    const res = { cookie: () => {}, redirect: (u) => { redirected = u; }, status: () => res, send: () => {} };
    await registerUser(req, res);
    assert.ok(redirected);
    assert.equal((await getQuery("SELECT terms_accepted_version AS v FROM users WHERE username = 'draftperson'"))[0].v, null);
    const regLocals = { user: null, errors: [], success: [], form: {}, next: "" };
    assert.doesNotMatch(await renderView("register", { ...regLocals, termsEnforced: false }), /class="au-terms"|By posting you agree/);
    assert.doesNotMatch(await renderView("register", regLocals), /class="au-terms"/, "missing local = off");
    assert.match(await renderView("register", { ...regLocals, termsEnforced: true }), /class="au-terms"[^]*By posting you agree to the Terms/);
    // the pages stay up, with a Draft banner; the footer links stay
    const t = await get("/terms", null), p = await get("/privacy", null);
    assert.equal(t.status, 200); assert.equal(p.status, 200);
    assert.match(t.text, /class="draft"[^>]*><b>Draft<\/b>/);
    assert.match(p.text, /class="draft"[^>]*><b>Draft<\/b>/);
    assert.match(t.text, /href="\/privacy">Privacy Policy/);
  } finally {
    await store.setConfig({ terms_enforced: true }, "test");
  }
  // back on: the same user is asked again (current behaviour)
  assert.equal(await terms.needs(U.fresh.userId), true);
  assert.equal((await post("/api/feed/posts", U.fresh, { body: "asked again" }, NET())).status, 428);
  await terms.accept(U.fresh.userId);
});

test("Terms switch: can't be turned on while [[placeholders]] remain in /terms or /privacy; /feed/admin lists them", async () => {
  await store.setConfig({ terms_enforced: false }, "test");
  terms._setPlaceholders(null);                     // the real pages (still the template)
  try {
    const ph = terms.placeholders();
    assert.ok(ph.length > 5, "the template's markers are found");
    assert.ok(ph.some((x) => x.page === "terms" && x.text === "CONTACT EMAIL"));
    assert.ok(ph.some((x) => x.page === "privacy" && x.text === "PRIVACY CONTACT EMAIL"));
    assert.ok(!ph.some((x) => /^PLACEHOLDER$|' \+ s \+ '/.test(x.text)), "the helper and the file comment aren't counted");
    // the API (Admins) refuses with the list; nothing changes
    const r = await post("/api/feed/admin/config", U.admin, { terms_enforced: true });
    assert.equal(r.status, 409, JSON.stringify(r.d));
    assert.match(r.d.error, /placeholder/);
    assert.match(r.d.error, /OPERATOR LEGAL NAME/);
    assert.equal(store.config().terms_enforced, false);
    assert.equal(terms.enforced(), false);
    await assert.rejects(store.setConfig({ terms_enforced: true }, "test"), /placeholder/);
    // other settings still save while it stays off
    assert.equal((await post("/api/feed/admin/config", U.admin, { terms_enforced: false, mention_gap_min: 16 })).status, 200);
    assert.equal(store.config().mention_gap_min, 16);
    // the admin page: the switch (disabled) and every remaining marker
    const a = (await get("/feed/admin", U.admin)).text;
    assert.match(a, /name="terms_enforced" disabled/);
    assert.match(a, /\[\[OPERATOR LEGAL NAME\]\]/);
    assert.match(a, /\[\[PRIVACY CONTACT EMAIL\]\]/);
    assert.match(a, new RegExp("<b>" + ph.length + "</b> \\[\\[placeholder\\]\\]s left"));
    // even if the setting were on (stored before the markers came back), it isn't in force with markers left
    terms.setEnforced(true);
    assert.equal(terms.enforced(), false);
    // once the pages are finished the switch goes on
    terms._setPlaceholders([]);
    assert.equal((await post("/api/feed/admin/config", U.admin, { terms_enforced: true })).status, 200);
    assert.equal(terms.enforced(), true);
    assert.doesNotMatch((await get("/feed/admin", U.admin)).text, /name="terms_enforced"[^>]*disabled/);
    // Staff can't flip it (Admins only, like every feed setting)
    assert.equal((await post("/api/feed/admin/config", U.staff, { terms_enforced: false })).status, 403);
  } finally {
    terms._setPlaceholders([]);
    await store.setConfig({ terms_enforced: true, mention_gap_min: 15 }, "test");
  }
});

// ───────────────────────────── reports ─────────────────────────────
test("report reasons: the modal's list (CSAM urgent; legal ones admin-only); unknown reasons become other; own content refused", async () => {
  const r = await get("/api/feed/report-reasons", null);
  assert.equal(r.status, 200);
  const keys = r.d.post.map((x) => x.key);
  for (const k of ["spam", "harassment", "hate", "csam", "ncii", "violence", "impersonation", "copyright", "other"]) assert.ok(keys.includes(k), k);
  assert.equal(r.d.post.find((x) => x.key === "csam").urgent, true);
  assert.equal(r.d.post.find((x) => x.key === "ncii").adminOnly, true);
  assert.equal(r.d.post.find((x) => x.key === "spam").adminOnly, false);
  assert.ok(r.d.user.some((x) => x.key === "impersonation"));
  const id = await mkPost(U.alice);
  assert.equal((await post(`/api/feed/posts/${id}/report`, U.alice, { reason: "spam" })).status, 400);
  assert.equal((await post(`/api/feed/posts/${id}/report`, U.bob, { reason: "made-up" })).status, 200);
  assert.equal((await getQuery("SELECT reason FROM feed_reports WHERE post_id = ? AND reporter_id = ?", [id, U.bob.userId]))[0].reason, "other");
  assert.equal((await post(`/api/feed/posts/${id}/report`, null, { reason: "spam" })).status, 401);
});

test("CSAM: one report hides the post at once, pings every admin urgently, never reaches the room owner; admin dismiss restores it and tells the reporter", async () => {
  const id = await mkPost(U.alice, { body: "csam test", rooms: [ROOM] });
  await post(`/api/feed/posts/${id}/report`, U.dave, { reason: "spam" });         // an ordinary report first (owner sees it)
  assert.ok((await store.roomReports(ROOM)).some((g) => g.postId === id));
  const r = await post(`/api/feed/posts/${id}/report`, U.carol, { reason: "csam", note: "please look" });
  assert.equal(r.status, 200);
  assert.equal(r.d.urgent, true);
  assert.ok((await store.getRow(id)).hidden_at, "hidden after ONE report");
  for (const a of [U.admin, U.admin2]) assert.equal((await inbox(a, "URGENT%")).length >= 1, true, a.username + " got the urgent notice");
  assert.equal((await inbox(U.owner, "URGENT%")).length, 0);
  assert.ok(!(await store.roomReports(ROOM)).some((g) => g.postId === id), "the whole post leaves the owner's queue");
  assert.equal((await get(`/feed/p/${id}`, U.bob)).status, 404);
  assert.equal((await get(`/feed/p/${id}`, U.owner)).status, 404);
  assert.equal((await get(`/feed/p/${id}`, null)).status, 404);
  assert.equal((await get(`/feed/p/${id}`, U.admin)).status, 200);
  const q = await store.reports();
  assert.equal(q[0].post.id, id, "urgent first in the admin queue");
  assert.equal(q[0].urgent, true);
  assert.match((await get("/feed/admin", U.admin)).text, /URGENT/);
  // dismissed (a false alarm): visible again, reports closed, reporters told
  const d = await post("/api/feed/admin/report-action", U.admin, { post: id, action: "dismiss" });
  assert.equal(d.status, 200, JSON.stringify(d.d));
  assert.equal((await store.getRow(id)).hidden_at, null);
  assert.equal((await inbox(U.carol, "Update on your report")).length, 1);
  assert.equal((await inbox(U.dave, "Update on your report")).length, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_reports WHERE post_id = ? AND resolved_at IS NULL", [id]))[0].n, 0);
});

test("CSAM on a comment: the comment is hidden for everyone but admins; remove closes it", async () => {
  const id = await mkPost(U.alice, { body: "comment csam" });
  const c = (await post(`/api/feed/posts/${id}/comments`, U.bob, { body: "bad comment" })).d.id;
  assert.equal((await post(`/api/feed/posts/${id}/report`, U.carol, { reason: "csam", comment: c })).d.urgent, true);
  const forBob = await store.comments(id, U.erin);
  assert.ok(!JSON.stringify(forBob).includes("bad comment"));
  const forAdmin = await store.comments(id, U.admin);
  assert.ok(forAdmin.some((x) => x.id === c && x.hidden && x.body === "bad comment"));
  assert.doesNotMatch((await get(`/feed/p/${id}`, U.erin)).text, /bad comment/);
  const rm = await post("/api/feed/admin/report-action", U.admin, { post: id, comment: c, action: "remove", notify: false });
  assert.equal(rm.status, 200);
  assert.ok((await getQuery("SELECT deleted_at FROM feed_comments WHERE id = ?", [c]))[0].deleted_at);
  assert.equal((await getQuery("SELECT action FROM feed_reports WHERE comment_id = ?", [c]))[0].action, "removed");
  assert.equal((await inbox(U.carol, "Update on your report")).length, 1, "notify off: still only the earlier notice");
});

test("owner vs admin queues: legal / safety categories are admin-only; ordinary ones go to both", async () => {
  const id = await mkPost(U.alice, { body: "queue split", rooms: [ROOM] });
  await post(`/api/feed/posts/${id}/report`, U.bob, { reason: "copyright" });
  await post(`/api/feed/posts/${id}/report`, U.carol, { reason: "ncii" });
  assert.ok(!(await store.roomReports(ROOM)).some((g) => g.postId === id), "only admin-only reasons so far: nothing for the owner");
  await post(`/api/feed/posts/${id}/report`, U.dave, { reason: "harassment" });
  const g = (await store.roomReports(ROOM)).find((x) => x.postId === id);
  assert.deepEqual(Object.keys(g.reasons), ["Harassment or bullying"]);
  assert.equal(g.count, 1);
  const a = (await store.reports()).find((x) => x.post.id === id);
  assert.deepEqual(a.reports.map((r) => r.reason).sort(), ["copyright", "harassment", "ncii"]);
  const ownerPage = (await get(`/rooms/${ROOM}/feed/mod`, U.owner)).text;
  assert.doesNotMatch(ownerPage, /Copyright infringement|Non-consensual/);
  assert.equal((await get("/feed/admin", U.owner)).status, 403);
  assert.equal((await post("/api/feed/admin/report-action", U.owner, { post: id, action: "dismiss" })).status, 403);
  assert.equal((await post("/api/feed/admin/report-action", U.bob, { post: id, action: "remove" })).status, 403);
});

test("admin outcomes: remove + ban (feed ban, reporters told), bad-faith dismissals pause a reporter (urgent ones still go through, unhidden)", async () => {
  const id = await mkPost(U.erin, { body: "ban me" });
  await post(`/api/feed/posts/${id}/report`, U.bob, { reason: "spam" });
  const b = await post("/api/feed/admin/report-action", U.admin, { post: id, action: "ban", days: 3, reason: "spam" });
  assert.equal(b.status, 200);
  assert.ok((await store.getRow(id)).deleted_at);
  const ban = (await getQuery("SELECT * FROM feed_bans WHERE user_id = ? AND room_id = ''", [U.erin.userId]))[0];
  assert.ok(ban && ban.until > Date.now());
  assert.match((await inbox(U.bob, "Update on your report"))[0].body, /removed/);
  await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.erin.userId]);
  // three bad-faith reports by fresh -> paused
  await terms.accept(U.fresh.userId);
  for (let i = 0; i < 3; i++) {
    store._gaps.clear();
    const p = await mkPost(U.alice, { body: "fine post " + i });
    assert.equal((await post(`/api/feed/posts/${p}/report`, U.fresh, { reason: "hate" })).status, 200);
    assert.equal((await post("/api/feed/admin/report-action", U.admin, { post: p, action: "false" })).status, 200);
  }
  store._gaps.clear();
  const p2 = await mkPost(U.alice, { body: "another" });
  const paused = await post(`/api/feed/posts/${p2}/report`, U.fresh, { reason: "spam" });
  assert.equal(paused.status, 403);
  assert.match(paused.d.error, /paused/);
  store._gaps.clear();
  const urgent = await post(`/api/feed/posts/${p2}/report`, U.fresh, { reason: "csam" });
  assert.equal(urgent.status, 200, "an urgent report always gets through");
  assert.equal((await store.getRow(p2)).hidden_at, null, "but a paused reporter can't hide content with it");
  assert.ok((await inbox(U.admin, "URGENT%")).some((n) => /NOT hidden/.test(n.body)));
});

test("report rate limits: per hour (lower for new accounts) and per day, posts + comments + users together", async () => {
  await store.setConfig({ reports_per_hour: 3, new_account_reports_per_hour: 1 }, "test");
  try {
    const rep = await mkUser("ratereporter", { camfrog: "ratecf" });
    await terms.accept(rep.userId);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await mkPost(U.alice, { body: "rl " + i }));
    for (let i = 0; i < 3; i++) { store._gaps.clear(); assert.equal((await post(`/api/feed/posts/${ids[i]}/report`, rep, { reason: "spam" })).status, 200); }
    store._gaps.clear();
    const r = await post(`/api/feed/posts/${ids[3]}/report`, rep, { reason: "spam" });
    assert.equal(r.status, 429);
    store._gaps.clear();
    assert.equal((await post("/api/users/alice/report", rep, { reason: "spam" })).status, 429, "user reports count too");
    // the 3-second burst gap
    const n = await mkUser("newacct", { created: new Date().toISOString().replace("T", " ").slice(0, 19) });
    await terms.accept(n.userId);
    assert.equal((await post(`/api/feed/posts/${ids[0]}/report`, n, { reason: "spam" })).status, 200);
    assert.equal((await post(`/api/feed/posts/${ids[1]}/report`, n, { reason: "spam" })).status, 429, "burst gap");
    store._gaps.clear();
    assert.equal((await post(`/api/feed/posts/${ids[1]}/report`, n, { reason: "spam" })).status, 429, "new accounts: 1 an hour here");
  } finally {
    await store.setConfig({ reports_per_hour: 20, new_account_reports_per_hour: 5 }, "test");
  }
});

test("report user: from a profile; not yourself; once while open; admins get it in their queue and can ban; reporters told", async () => {
  store._gaps.clear();
  assert.equal((await post("/api/users/carol/report", U.carol, { reason: "spam" })).status, 400);
  assert.equal((await post("/api/users/nobody-here/report", U.bob, { reason: "spam" })).status, 404);
  const r = await post("/api/users/carol/report", U.bob, { reason: "impersonation", note: "pretends to be staff" });
  assert.equal(r.status, 200);
  store._gaps.clear();
  assert.equal((await post("/api/users/carol/report", U.bob, { reason: "spam" })).d.already, true);
  const q = await store.userReports();
  const g = q.find((x) => x.username === "carol");
  assert.equal(g.reports[0].label, "Impersonation");
  assert.match((await get("/feed/admin", U.admin)).text, /Reported users/);
  assert.equal((await post("/api/feed/admin/user-report-action", U.owner, { userId: U.carol.userId, action: "ban" })).status, 403);
  assert.equal((await post("/api/feed/admin/user-report-action", U.admin, { userId: U.carol.userId, action: "ban", days: 1 })).status, 200);
  assert.ok((await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ?", [U.carol.userId])).length);
  assert.ok((await inbox(U.bob, "Update on your report")).some((n) => /account you reported/.test(n.body)));
  await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.carol.userId]);
  // the profile button markup
  const ejs = require("ejs");
  const html = await ejs.renderFile(path.join(repo, "views", "partials", "profile-follow.ejs"),
    { social: { counts: { followers: 0, following: 0 }, self: false, following: false, signed: true }, usernameProfile: "carol", previewing: false });
  assert.match(html, /data-safety="report-user" data-user="carol"/);
});

test("menus: Report on posts + comments for members, Details (admin) only for Admins", async () => {
  const id = await mkPost(U.alice, { body: "menus" });
  await post(`/api/feed/posts/${id}/comments`, U.bob, { body: "menu comment" });
  const asErin = (await get(`/feed/p/${id}`, U.erin)).text;
  assert.match(asErin, /data-act="report"/); assert.match(asErin, /data-act="creport"/);
  assert.doesNotMatch(asErin, /Details \(admin\)/);
  assert.doesNotMatch((await get(`/feed/p/${id}`, U.staff)).text, /Details \(admin\)/);
  const asAdmin = (await get(`/feed/p/${id}`, U.admin)).text;
  assert.match(asAdmin, /data-act="details"/); assert.match(asAdmin, /data-act="cdetails"/);
  assert.match(asErin, /feed-safety\.js/);
});
