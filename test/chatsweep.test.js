// S1 F13 (C8-v1-signout-sweep, the owner's answer of 2026-10-25): a sign-out leaves no chat lines behind in this browser
// (chatsweep.js, views/partials/chat-sweep.ejs, docs/chat-tickets.md "S1: the sign-out sweep").
//   * every response that ends the login (loginCookie.clearLogin) also sets the patv_chat_sweep marker - Sign out, Your
//     devices (this device, everywhere), a revoked session seen by sessions.gate, a deleted account seen by refreshLogin -
//     not HttpOnly, Secure, Lax, path /, 90 days; its value is always "1" (review 1: no account id in a cookie that can
//     outlive the sign-out); a sign-in never sets it. The rename and a password change: test/username-limit.test.js;
//     account deletion: test/account-delete.test.js;
//   * a request carrying it gets res.locals.chatSweep only with no live login (review 1: a marker that outlived a sweep and
//     a later sign-in stays quiet, even on a page that passes no user), and layout.ejs prints the static sweep script on a
//     SIGNED-OUT page only (the landing pages / and /login included);
//   * the script (run here in a vm against a fake IndexedDB) deletes exactly the platform's account databases
//     `patv-chat:<lower-case uuid>` - never patv-device or any other name - then the marker; a failed / blocked-and-unfinished
//     delete keeps the marker (onblocked is not "done"); no databases(): the marker goes; nothing escapes;
//   * the contract: the same rule as the platform's account.ts (PATV_HUB_DIR=<platform checkout> also compares the source).
//   node --test test/chatsweep.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "chatsweep-test-")));
delete process.env.STAGING;
delete process.env.CHAT_GENESIS_NS;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "sessions"));
const LC = require(path.join(repo, "middleware", "loginCookie"));
const CS = require(path.join(repo, "chatsweep"));

const UA = "0b5c7a52-3f1e-4c2a-9d8e-1a2b3c4d5e6f";   // account ids that are UUIDs (v1's are uuidv4): the hub account id is the same
const UB = "7e6f5d4c-3b2a-4190-8f7e-6d5c4b3a2918";
const UC = "1f2e3d4c-5b6a-4798-a1b2-c3d4e5f60718";
const UD = "2a3b4c5d-6e7f-4a1b-8c2d-3e4f5a6b7c8d";
const UE = "3b4c5d6e-7f8a-4b2c-9d3e-4f5a6b7c8d9e";
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const PARTIAL = rd("views", "partials", "chat-sweep.ejs");
const SCRIPT = (/<script>([\s\S]*?)<\/script>/.exec(PARTIAL) || [])[1];

// ── the marker (loginCookie.clearLogin -> chatsweep.mark) ──
function fakeRes(req) {
  const r = { req: req || {}, locals: {}, set: [], cleared: [] };
  r.cookie = (n, v, o) => { r.set.push({ n, v, o }); };
  r.clearCookie = (n, o) => { r.cleared.push({ n, o }); };
  return r;
}
const marker = (r) => r.set.filter((c) => c.n === "patv_chat_sweep");

test("clearLogin clears the login AND sets the marker: not HttpOnly, Secure, Lax, path /, 90 days; res.locals.chatSweep", () => {
  const r = fakeRes({ loginSession: { userId: UA, id: "x" } });
  LC.clearLogin(r);
  assert.deepEqual(r.cleared, [{ n: "jwt", o: { httpOnly: true, secure: true, sameSite: "Lax" } }], "the login cookie as before");
  assert.equal(marker(r).length, 1);
  assert.equal(marker(r)[0].v, "1");
  assert.deepEqual(marker(r)[0].o, { httpOnly: false, secure: true, sameSite: "Lax", path: "/", maxAge: 90 * 24 * 3600 * 1000 });
  assert.equal(r.locals.chatSweep, true, "this very response's page sweeps too");
  assert.equal(CS.COOKIE, "patv_chat_sweep");
  assert.equal(CS.VALUE, "1");
});

test("the marker's value is always 1 - never the account's id, whatever the request knows (review 1); mark never throws", () => {
  const v = (req, ...extra) => { const r = fakeRes(req); LC.clearLogin(r, ...extra); return marker(r).map((c) => c.v); };
  for (const req of [{ loginSession: { userId: UA } }, { user: { userId: UC } }, { loginSession: { userId: UA }, user: { userId: UC } }, {}, undefined,
                     { loginSession: { userId: "ann" } }]) {
    assert.deepEqual(v(req), ["1"], JSON.stringify(req));
  }
  assert.deepEqual(v({}, UB), ["1"], "an account passed in (as the gate once did) is ignored");
  const r = fakeRes({ loginSession: { userId: UA } });
  CS.mark(r, UB);
  assert.deepEqual(marker(r).map((c) => c.v), ["1"]);
  assert.doesNotMatch(rd("chatsweep.js"), /require\([^)]*chatticket|subjectOf\(/, "chatsweep has no way to name the account");
  // never throws: a response without cookie() (a fake in another test) is left alone
  assert.doesNotThrow(() => CS.mark({}));
  assert.doesNotThrow(() => CS.mark(null));
  const boom = fakeRes({ loginSession: { userId: UA } });
  boom.cookie = () => { throw new Error("headers already sent"); };
  const err = console.error; const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try { assert.doesNotThrow(() => LC.clearLogin(boom)); } finally { console.error = err; }
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(UA), "the log line names no account");
});

test("the locals middleware: the marker gives chatSweep only with no live login (review 1: the check doesn't fail open)", () => {
  const run = (req) => { const res = { locals: {} }; let n = 0; CS.locals(req, res, () => n++); assert.equal(n, 1); return res.locals.chatSweep; };
  const live = jwt.sign({ userId: UA, username: "ann", class: "pleb" }, process.env.SECRET_KEY, { expiresIn: "90d" });
  assert.equal(run({ cookies: { patv_chat_sweep: "1" } }), true, "signed out");
  assert.equal(run({ cookies: { patv_chat_sweep: UA } }), true, "any value (an old marker) is a marker");
  assert.equal(run({ cookies: {} }), undefined);
  assert.equal(run({ cookies: undefined }), undefined);
  assert.equal(run({ cookies: { patv_chat_sweep: "" } }), undefined);
  // a live login: never
  assert.equal(run({ cookies: { patv_chat_sweep: "1", jwt: live }, loginSession: { id: "s", userId: UA } }), undefined, "a live session");
  assert.equal(run({ cookies: { patv_chat_sweep: "1" }, loginSession: { id: "s", userId: UA } }), undefined, "a session, whatever the cookies say");
  assert.equal(run({ cookies: { patv_chat_sweep: "1", jwt: live } }), undefined,
    "a login cookie the readers accept without a session (the gate's own check failed: the cookie alone decides) - signed in");
  // a login cookie nobody accepts: signed out, the sweep runs
  assert.equal(run({ cookies: { patv_chat_sweep: "1", jwt: jwt.sign({ userId: UA }, "another-secret") } }), true, "tampered");
  assert.equal(run({ cookies: { patv_chat_sweep: "1", jwt: jwt.sign({ userId: UA, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.SECRET_KEY) } }), true, "expired");
  assert.equal(run({ cookies: { patv_chat_sweep: "1", jwt: jwt.sign({ username: "x" }, process.env.SECRET_KEY) } }), true, "no account in it (the gate ignores it)");
  assert.equal(run({ cookies: { patv_chat_sweep: "1", jwt: "junk" } }), true);
  const key = process.env.SECRET_KEY;
  delete process.env.SECRET_KEY;
  try { assert.equal(run({ cookies: { patv_chat_sweep: "1", jwt: live } }), true, "no SECRET_KEY: no reader accepts a login"); }
  finally { process.env.SECRET_KEY = key; }
  assert.equal(CS.liveLogin(null), false);
});

// ── route level: the real sessions.gate, sessions.register (Your devices) and refreshLogin; /logout as index.js has it ──
let base, server;
const setCookies = (r) => (typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""]);
const markerOf = (r) => { for (const c of setCookies(r)) { const m = /^patv_chat_sweep=([^;]*)(.*)$/.exec(c); if (m) return { v: decodeURIComponent(m[1]), attrs: m[2] }; } return null; };
const jwtOf = (r) => { for (const c of setCookies(r)) { const m = /^jwt=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
const cookieHeader = (jwtCookie, sweep) => [jwtCookie ? "jwt=" + jwtCookie : "", sweep ? "patv_chat_sweep=" + sweep : ""].filter(Boolean).join("; ");
const req = (method, p, jwtCookie, extra = {}, body) => fetch(base + p, { method, redirect: "manual",
  headers: Object.assign({ cookie: cookieHeader(jwtCookie), origin: base, "content-type": "application/json", "x-requested-with": "fetch" }, extra),
  body: body === undefined ? undefined : JSON.stringify(body) });
async function signIn(id) {
  const r = await fetch(base + "/test-signin", { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" },
    body: JSON.stringify({ id }) });
  assert.equal(markerOf(r), null, "a sign-in never sets the marker");
  return jwtOf(r);
}
const hasSweep = (html) => html.includes("patv_chat_sweep=[^;]/.test(document.cookie");

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, email TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  auto_source TEXT, archived_at INTEGER, password_set INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT, role TEXT)");
  for (const [id, name] of [[UA, "ann"], [UB, "bob"], [UC, "cat"], [UD, "dan"], [UE, "eve"]]) {
    await runQuery("INSERT INTO users (userId, username, email, password) VALUES (?, ?, ?, 'x')", [id, name, name + "@example.com"]);
  }
  await S.init();
  const app = express();
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use(cookieParser());
  app.use(S.gate);
  app.use(CS.locals);                                   // index.js: right after the gate
  app.use(express.json());
  const addUser = async (rq, res, next) => {            // index.js addUser, condensed
    rq.user = null;
    const tok = rq.cookies.jwt;
    if (tok) { try { rq.user = await LC.refreshLogin(res, jwt.verify(tok, process.env.SECRET_KEY), getQuery); } catch (e) { rq.user = null; } }
    next();
  };
  app.post("/test-signin", async (rq, res) => {
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [rq.body.id]))[0];
    await S.signIn(rq, res, u, "password");
    res.json({ ok: true });
  });
  app.post("/logout", async (rq, res) => {              // index.js's handler (its sameSite guard aside)
    const s = rq.loginSession;
    if (s && s.id) await S.revoke(s.userId, s.id, "signed out");
    LC.clearLogin(res);
    res.redirect("/");
  });
  app.get("/probe", addUser, (rq, res) => res.json({ user: rq.user ? rq.user.userId : null, chatSweep: !!res.locals.chatSweep }));
  // a layout page whose view forgets to pass `user` (review 1's latent case): the request-level check must hold on its own
  app.get("/no-user-page", addUser, (rq, res) => res.render("layout", { title: "x" }));
  S.register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("Sign out (POST /logout): the login is cleared and the marker (1) is set; its attributes; the landing page sweeps", async () => {
  const c = await signIn(UA);
  const r = await req("POST", "/logout", c);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/", "lands on the homepage, a signed-out layout page");
  assert.equal(jwtOf(r), "", "the login cookie is cleared");
  const m = markerOf(r);
  assert.equal(m.v, "1");
  assert.match(m.attrs, /;\s*Max-Age=7776000/i);
  assert.match(m.attrs, /;\s*Path=\//i);
  assert.match(m.attrs, /;\s*Secure/i);
  assert.match(m.attrs, /;\s*SameSite=Lax/i);
  assert.doesNotMatch(m.attrs, /HttpOnly/i, "the page's script deletes it");
  // the landing page's request carries it: chatSweep, signed out
  const land = await (await req("GET", "/probe", null, { cookie: cookieHeader(null, "1") })).json();
  assert.deepEqual(land, { user: null, chatSweep: true });
  assert.deepEqual(await (await req("GET", "/probe", null)).json(), { user: null, chatSweep: false }, "no marker, no sweep");
  // the old (revoked) login cookie replayed with the marker: the gate signs it out again - the page sweeps
  const replay = await req("GET", "/probe", c, { cookie: cookieHeader(c, "1") });
  assert.deepEqual(await replay.json(), { user: null, chatSweep: true });
});

test("a marker that outlived its sweep, then a sign-in: no signed-in page sweeps, not even one that passes no user (review 1)", async () => {
  const c = await signIn(UE);
  const p = await (await req("GET", "/probe", c, { cookie: cookieHeader(c, "1") })).json();
  assert.deepEqual(p, { user: UE, chatSweep: false }, "signed in with a marker left over: no chatSweep");
  const page = await (await req("GET", "/no-user-page", c, { cookie: cookieHeader(c, "1") })).text();
  assert.ok(page.includes("<head>") && !hasSweep(page), "a layout page without `user`, signed in: no script (it would take eve's database)");
  // signed out (the same browser after Sign out): the same page sweeps
  const out = await req("POST", "/logout", c, { cookie: cookieHeader(c, "1") });
  assert.equal(markerOf(out).v, "1");
  const after = await (await req("GET", "/no-user-page", null, { cookie: cookieHeader(null, "1") })).text();
  assert.ok(hasSweep(after));
});

test("Your devices: Sign out on this device and Sign out everywhere set it; signing out ANOTHER device doesn't (this one stays in)", async () => {
  const a = await signIn(UB);
  const b = await signIn(UB);
  const list = (await (await req("GET", "/api/account/sessions", a)).json()).sessions;
  const other = list.find((s) => !s.current), here = list.find((s) => s.current);
  const r1 = await req("POST", "/api/account/sessions/revoke", a, {}, { id: other.id });
  assert.equal((await r1.json()).signedOut, false);
  assert.equal(markerOf(r1), null, "this device is still signed in");
  const r2 = await req("POST", "/api/account/sessions/revoke-others", a, {}, {});
  assert.equal(markerOf(r2), null);
  const r3 = await req("POST", "/api/account/sessions/revoke", a, {}, { id: here.id });
  assert.equal((await r3.json()).signedOut, true);
  assert.equal(markerOf(r3).v, "1", "this device signed out: the client goes to /login, which sweeps");
  const c = await signIn(UB);
  const r4 = await req("POST", "/api/account/sessions/revoke-all", c, {}, {});
  assert.equal((await r4.json()).signedOut, true);
  assert.equal(markerOf(r4).v, "1");
  void b;
});

test("sessions.gate: a session revoked elsewhere is a signed-out request - that response carries the marker and its page sweeps", async () => {
  const mine = await signIn(UC);
  const elsewhere = await signIn(UC);
  const all = await req("POST", "/api/account/sessions/revoke-others", elsewhere, {}, {});
  assert.equal((await all.json()).ok, true);
  const r = await req("GET", "/probe", mine);
  const j = await r.json();
  assert.equal(j.user, null, "signed out");
  assert.equal(j.chatSweep, true, "this very page sweeps (clearLogin set res.locals.chatSweep)");
  assert.equal(jwtOf(r), "");
  assert.equal(markerOf(r).v, "1");
});

test("refreshLogin: an account that no longer exists is signed out with the marker", async () => {
  const c = await signIn(UD);
  await runQuery("DELETE FROM users WHERE userId = ?", [UD]);
  const r = await req("GET", "/probe", c);
  assert.equal((await r.json()).user, null);
  assert.equal(markerOf(r).v, "1");
});

// ── the page: layout.ejs prints the static script on a signed-out page that has chatSweep, and nowhere else ──
const page = (view, locals) => ejs.renderFile(path.join(repo, "views", view), locals);

test("layout.ejs: the sweep is in the head of a signed-out page with chatSweep - /login and the layout itself - never signed in", async () => {
  const login = (o) => page("login.ejs", Object.assign({ user: null, errors: [], success: [], next: "", form: {} }, o));
  const out = await login({ chatSweep: true });
  assert.ok(hasSweep(out), "the landing page after Your devices' sign-out");
  const head = out.slice(0, out.indexOf("</head>"));
  assert.ok(hasSweep(head), "in the head, before the page's own scripts");
  assert.ok(head.indexOf("patv_chat_sweep") < head.indexOf("localtime.js"), "first of the head's scripts");
  assert.ok(!hasSweep(await login({})), "no marker: nothing");
  assert.ok(!hasSweep(await login({ chatSweep: false })));
  assert.ok(!hasSweep(await page("layout.ejs", { title: "x", user: "bob", chatSweep: true })), "signed in: never (it would take bob's database)");
  assert.ok(hasSweep(await page("layout.ejs", { title: "x", user: null, chatSweep: true })));
  // the view's own check is the second one: chatSweep reaches a page only from a request with no live login (chatsweep.locals,
  // the route test above) or from the response that signs out (chatsweep.mark)
  assert.ok(hasSweep(await page("layout.ejs", { title: "x", chatSweep: true })), "a page that passes no user is signed out as far as the view knows");
  // printed once, exactly the partial's script
  const html = await page("layout.ejs", { title: "x", user: null, chatSweep: true });
  assert.equal(html.split("patv_chat_sweep=[^;]/.test(document.cookie").length, 2);
  assert.ok(html.includes(SCRIPT), "the partial's script, byte for byte");
});

test("the partial is static: one script, nothing printed from the request, the marker's value never read", () => {
  assert.ok(SCRIPT && SCRIPT.length > 100);
  assert.equal(PARTIAL.split("<script>").length, 2, "one script");
  assert.doesNotMatch(PARTIAL, /<%[=-]/, "no output tags (only the <%# comment)");
  assert.doesNotMatch(SCRIPT, /=>|\blet\b|\bconst\b|`/, "ES5: runs on any browser the site supports");
  assert.doesNotMatch(SCRIPT, /\.exec\(|m\[1\]|match\(/, "the value isn't read (always 1)");
  assert.ok(Buffer.byteLength(PARTIAL.replace(/<%#[\s\S]*?%>\s*/, "")) < 1400, "small (bytes on the one page after a sign-out)");
  vm.createScript(SCRIPT);   // parses
});

// ── the script, in a vm against a fake IndexedDB ──
// behaviour per database name: "ok" (default), "error", "blocked" (onblocked at once, success only when `pending` runs),
// "throw" (deleteDatabase throws)
function harness({ cookie = "", names = [], how = {}, databases = "yes", idb = true, cookieThrows = false } = {}) {
  const st = { deleted: [], cookieSets: [], listed: 0, pending: [], blockedFired: 0 };
  const jar = cookie;
  const document = {};
  Object.defineProperty(document, "cookie", {
    get() { if (cookieThrows) throw new Error("SecurityError"); return jar; },
    set(v) { st.cookieSets.push(v); },
  });
  const indexedDB = {
    deleteDatabase(n) {
      if (how[n] === "throw") throw new Error("SecurityError");
      st.deleted.push(n);
      const r = {};
      const fire = (k) => { if (typeof r[k] === "function") r[k]({ target: r, type: k.slice(2) }); };
      if (how[n] === "blocked") {
        // what a browser does when another tab holds the database open: "blocked" first, "success" once it lets go
        setImmediate(() => { st.blockedFired++; fire("onblocked"); });
        st.pending.push(() => fire("onsuccess"));
      } else setImmediate(() => fire(how[n] === "error" ? "onerror" : "onsuccess"));
      return r;
    },
  };
  if (databases === "yes") indexedDB.databases = () => { st.listed++; return Promise.resolve(names.map((name) => ({ name, version: 1 }))); };
  if (databases === "reject") indexedDB.databases = () => { st.listed++; return Promise.reject(new Error("no")); };
  const window = idb ? { indexedDB } : {};
  st.run = async () => {
    vm.runInNewContext(SCRIPT, { window, document });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    return st;
  };
  return st;
}
const CLEAR = "patv_chat_sweep=; Max-Age=0; Path=/; Secure; SameSite=Lax";
const acct = (u) => "patv-chat:" + u;

test("the script: no marker - nothing at all (a cached signed-out page replayed later changes nothing)", async () => {
  for (const cookie of ["", "a=b", "xpatv_chat_sweep=1", "patv_chat_sweepx=1", "patv_chat_sweep=", "a=b; patv_chat_sweep=; c=d"]) {
    const st = await harness({ cookie, names: [acct(UA)] }).run();
    assert.equal(st.listed, 0, cookie);
    assert.deepEqual(st.deleted, []);
    assert.deepEqual(st.cookieSets, []);
  }
});

test("the script: deletes exactly patv-chat:<lower-case uuid> - never patv-device or another name - then the marker", async () => {
  const names = [acct(UA), "patv-device", acct(UB), "patv-chat:not-an-account", acct(UA.toUpperCase()), acct(UA) + "x", "x" + acct(UA),
                 "patv-chat:", "patv-chatlog", "patv-prefs", "other", acct(UC) + ":media"];
  for (const cookie of ["patv_chat_sweep=1", "a=b; patv_chat_sweep=1; c=d", "patv_chat_sweep=" + UD]) {
    const st = await harness({ cookie, names }).run();
    assert.equal(st.listed, 1);
    assert.deepEqual(st.deleted, [acct(UA), acct(UB)], cookie + ": the account databases only (the platform's rule), whatever the value");
    assert.deepEqual(st.cookieSets, [CLEAR], "then the marker goes");
  }
  // nothing to delete: the marker goes at once
  const none = await harness({ cookie: "patv_chat_sweep=1", names: ["patv-device"] }).run();
  assert.deepEqual(none.deleted, []);
  assert.deepEqual(none.cookieSets, [CLEAR]);
  const empty = await harness({ cookie: "patv_chat_sweep=1", names: [] }).run();
  assert.deepEqual(empty.cookieSets, [CLEAR]);
});

test("the script: a failed, thrown or unfinished delete keeps the marker (the next signed-out page tries again); blocked is not done", async () => {
  const err = await harness({ cookie: "patv_chat_sweep=1", names: [acct(UA), acct(UB)], how: { [acct(UB)]: "error" } }).run();
  assert.deepEqual(err.deleted, [acct(UA), acct(UB)], "the others are still deleted");
  assert.deepEqual(err.cookieSets, [], "kept");
  const thr = await harness({ cookie: "patv_chat_sweep=1", names: [acct(UA), acct(UB)], how: { [acct(UA)]: "throw" } }).run();
  assert.deepEqual(thr.deleted, [acct(UB)]);
  assert.deepEqual(thr.cookieSets, [], "kept, and nothing escaped");
  // blocked (another tab's widget still had it open): "blocked" fires first and counts for nothing - the other database's
  // success must not clear the marker; only the blocked one's success, when the holder lets go, does
  const bl = harness({ cookie: "patv_chat_sweep=1", names: [acct(UA), acct(UB)], how: { [acct(UA)]: "blocked" } });
  await bl.run();
  assert.equal(bl.blockedFired, 1, "the blocked event was delivered");
  assert.deepEqual(bl.cookieSets, [], "still waiting");
  bl.pending.forEach((f) => f());
  assert.deepEqual(bl.cookieSets, [CLEAR], "once, after the blocked delete succeeded");
  // two blocked: neither clears it alone
  const two = harness({ cookie: "patv_chat_sweep=1", names: [acct(UA), acct(UB)], how: { [acct(UA)]: "blocked", [acct(UB)]: "blocked" } });
  await two.run();
  assert.equal(two.blockedFired, 2);
  two.pending[0]();
  assert.deepEqual(two.cookieSets, []);
  two.pending[1]();
  assert.deepEqual(two.cookieSets, [CLEAR]);
  // never finished (the page left): no clear
  const nf = harness({ cookie: "patv_chat_sweep=1", names: [acct(UA)], how: { [acct(UA)]: "blocked" } });
  await nf.run();
  assert.equal(nf.blockedFired, 1);
  assert.deepEqual(nf.cookieSets, []);
});

test("the script: no indexedDB.databases() (Firefox before 126) - nothing it can list, the marker goes (the value names nothing); refused - kept", async () => {
  for (const v of ["1", UA, "'-alert(1)-'", encodeURIComponent("patv-device")]) {
    const st = await harness({ cookie: "patv_chat_sweep=" + v, databases: "no" }).run();
    assert.deepEqual(st.deleted, [], JSON.stringify(v) + ": no database is named from the cookie");
    assert.deepEqual(st.cookieSets, [CLEAR]);
  }
  // databases() refused: the marker stays for the next signed-out page
  for (const v of ["1", UB]) {
    const rej = await harness({ cookie: "patv_chat_sweep=" + v, databases: "reject" }).run();
    assert.equal(rej.listed, 1);
    assert.deepEqual(rej.deleted, []);
    assert.deepEqual(rej.cookieSets, [], "kept: the next signed-out page tries again");
  }
});

test("the script: no IndexedDB at all - nothing to delete, the marker goes; an unreadable cookie jar - nothing escapes", async () => {
  const st = await harness({ cookie: "patv_chat_sweep=1", idb: false }).run();
  assert.deepEqual(st.cookieSets, [CLEAR]);
  const bad = harness({ cookie: "patv_chat_sweep=1", names: [acct(UA)], cookieThrows: true });
  await assert.doesNotReject(bad.run());
  assert.deepEqual(bad.deleted, []);
});

// ── the contract and the wiring ──
test("the rule is the platform's (account.ts): the same regex here and in the script; PATV_HUB_DIR compares the source", () => {
  assert.equal(CS.ACCOUNT_DB_PREFIX, "patv-chat:");
  assert.equal(CS.ACCOUNT_DB_RE.source, "^patv-chat:" + CS.UUID_SRC + "$");
  assert.ok(SCRIPT.includes("var ACCT = /" + CS.ACCOUNT_DB_RE.source + "/;"), "the script's rule is chatsweep's");
  assert.ok(CS.ACCOUNT_DB_RE.test(acct(UA)) && !CS.ACCOUNT_DB_RE.test("patv-device") && !CS.ACCOUNT_DB_RE.test(acct(UA.toUpperCase())));
  const hub = process.env.PATV_HUB_DIR;                  // optional: a platform checkout
  if (hub) {
    const src = fs.readFileSync(path.join(hub, "packages", "chat-core", "src", "storage", "account.ts"), "utf8");
    assert.match(src, /export const ACCOUNT_DB_PREFIX = 'patv-chat:';/);
    const m = /const UUID_RE = \/(.*)\/;/.exec(src);
    assert.ok(m, "account.ts UUID_RE");
    assert.equal(m[1], "^" + CS.UUID_SRC + "$", "the same uuid, lower case only");
    assert.match(src, /return `\$\{ACCOUNT_DB_PREFIX\}\$\{acct\}`;/, "accountDbName: prefix + id");
    const dev = fs.readFileSync(path.join(hub, "packages", "chat-core", "src", "storage", "device.ts"), "utf8");
    assert.match(dev, /export const DEVICE_DB = 'patv-device';/, "the device database the rule leaves alone");
    const prefs = fs.readFileSync(path.join(hub, "packages", "chat-core", "src", "client", "prefs.ts"), "utf8");
    assert.match(prefs, /export const PREFS_DB = 'patv-prefs';/, "the prefs database the rule leaves alone (docs: a residual)");
  }
});

test("the wiring: index.js mounts chatsweep.locals right after sessions.gate; /logout clears through clearLogin; clearLogin is the only jwt clear", () => {
  const idx = rd("index.js");
  const gate = idx.indexOf("app.use(loginSessions.gate);");
  const loc = idx.indexOf('app.use(require("./chatsweep").locals);');
  assert.ok(gate > 0 && loc > gate, "after the gate");
  assert.ok(!/app\.use\(/.test(idx.slice(gate + 30, loc)), "nothing between them");
  const lo = idx.slice(idx.indexOf('app.post("/logout"'), idx.indexOf('app.post("/logout"') + 600);
  assert.match(lo, /clearLogin\(res\);/);
  assert.match(lo, /res\.redirect\("\/"\);/);
  // every login clear goes through loginCookie.clearLogin (so through the marker)
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || ["node_modules", "public", "test", "camfrog-bot", "tools", "uploads", "data", "docs", "locales", "views"].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && /clearCookie\(\s*["']jwt["']/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(repo, p));
    }
  };
  walk(repo);
  assert.deepEqual(offenders.map((p) => p.replace(/\\/g, "/")), ["middleware/loginCookie.js"]);
  assert.match(rd("middleware", "loginCookie.js"), /require\("\.\.\/chatsweep"\)\.mark\(res\);/);
});
