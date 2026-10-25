// S1 F13 (C8-v1-signout-sweep, the owner's answer of 2026-10-25): a sign-out leaves no chat lines behind in this browser
// (chatsweep.js, views/partials/chat-sweep.ejs, docs/chat-tickets.md "S1: the sign-out sweep").
//   * every response that ends the login (loginCookie.clearLogin) also sets the patv_chat_sweep marker - Sign out, Your
//     devices (this device, everywhere), a revoked session seen by sessions.gate, a deleted account seen by refreshLogin -
//     not HttpOnly, Secure, Lax, path /, 90 days; its value is the signed-out account's hub account id, else "1"; a sign-in
//     never sets it;
//   * a request carrying it gets res.locals.chatSweep, and layout.ejs prints the static sweep script on a SIGNED-OUT page only
//     (the landing pages / and /login included);
//   * the script (run here in a vm against a fake IndexedDB) deletes exactly the platform's account databases
//     `patv-chat:<lower-case uuid>` - never patv-device or any other name - then the marker; a failed / unfinished delete
//     keeps the marker; no databases(): the one database the marker names; nothing escapes;
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

const UA = "0b5c7a52-3f1e-4c2a-9d8e-1a2b3c4d5e6f";   // account ids that are UUIDs: the hub account id is the same (lower case)
const UB = "7e6f5d4c-3b2a-4190-8f7e-6d5c4b3a2918";
const UC = "1f2e3d4c-5b6a-4798-a1b2-c3d4e5f60718";
const UD = "2a3b4c5d-6e7f-4a1b-8c2d-3e4f5a6b7c8d";
const NS = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
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
  assert.equal(marker(r)[0].v, UA, "the request's own session: its hub account id");
  assert.deepEqual(marker(r)[0].o, { httpOnly: false, secure: true, sameSite: "Lax", path: "/", maxAge: 90 * 24 * 3600 * 1000 });
  assert.equal(r.locals.chatSweep, true, "this very response's page sweeps too");
  assert.equal(CS.COOKIE, "patv_chat_sweep");
});

test("the marker's value: the caller's account first, then the session, then req.user; the hub account id or 1, never anything else", () => {
  const v = (req, uid) => { const r = fakeRes(req); LC.clearLogin(r, uid); return marker(r)[0].v; };
  assert.equal(v({ loginSession: { userId: UA } }, UB), UB, "an explicit account (sessions.gate, refreshLogin) wins");
  assert.equal(v({ user: { userId: UC } }), UC, "req.user (account deletion, Your devices)");
  assert.equal(v({ loginSession: { userId: UA }, user: { userId: UC } }), UA, "the live session before req.user");
  assert.equal(v({}), "1", "nobody known (a sign-out without a session)");
  assert.equal(v(undefined), "1");
  assert.equal(v({ loginSession: { userId: UA.toUpperCase() } }), UA, "chatticket.subjectOf lower-cases");
  // a legacy id: its hub account id needs CHAT_GENESIS_NS (chatticket.subjectOf)
  assert.equal(v({ loginSession: { userId: "ann" } }), "1", "a legacy id without the namespace: no hub account");
  process.env.CHAT_GENESIS_NS = NS;
  try {
    const sub = require(path.join(repo, "chatticket")).subjectOf("ann");
    assert.match(sub, CS.SUBJECT_RE);
    assert.equal(v({ loginSession: { userId: "ann" } }), sub, "uuidv5(id, CHAT_GENESIS_NS), as the ticket's sub");
  } finally { delete process.env.CHAT_GENESIS_NS; }
  assert.equal(CS.valueFor("'; alert(1); //"), "1");
  // never throws: a response without cookie() (a fake in another test) is left alone
  assert.doesNotThrow(() => CS.mark({}, UA));
  assert.doesNotThrow(() => CS.mark(null, UA));
  const boom = fakeRes();
  boom.cookie = () => { throw new Error("headers already sent"); };
  const err = console.error; const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try { assert.doesNotThrow(() => LC.clearLogin(boom, UA)); } finally { console.error = err; }
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(UA), "the log line names no account");
});

test("the locals middleware: a request carrying the marker gets chatSweep; none without", () => {
  const run = (cookies) => { const res = { locals: {} }; let n = 0; CS.locals({ cookies }, res, () => n++); assert.equal(n, 1); return res.locals.chatSweep; };
  assert.equal(run({ patv_chat_sweep: "1" }), true);
  assert.equal(run({ patv_chat_sweep: UA }), true);
  assert.equal(run({}), undefined);
  assert.equal(run(undefined), undefined);
  assert.equal(run({ patv_chat_sweep: "" }), undefined);
});

// ── route level: the real sessions.gate, sessions.register (Your devices) and refreshLogin; /logout as index.js has it ──
let base, server;
const setCookies = (r) => (typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""]);
const markerOf = (r) => { for (const c of setCookies(r)) { const m = /^patv_chat_sweep=([^;]*)(.*)$/.exec(c); if (m) return { v: decodeURIComponent(m[1]), attrs: m[2] }; } return null; };
const jwtOf = (r) => { for (const c of setCookies(r)) { const m = /^jwt=([^;]*)/.exec(c); if (m) return m[1]; } return null; };
const req = (method, p, jwtCookie, extra = {}, body) => fetch(base + p, { method, redirect: "manual",
  headers: Object.assign({ cookie: jwtCookie ? "jwt=" + jwtCookie : "", origin: base, "content-type": "application/json", "x-requested-with": "fetch" }, extra),
  body: body === undefined ? undefined : JSON.stringify(body) });
async function signIn(id) {
  const r = await fetch(base + "/test-signin", { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" },
    body: JSON.stringify({ id }) });
  assert.equal(markerOf(r), null, "a sign-in never sets the marker");
  return jwtOf(r);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, email TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  auto_source TEXT, archived_at INTEGER, password_set INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT, role TEXT)");
  for (const [id, name] of [[UA, "ann"], [UB, "bob"], [UC, "cat"], [UD, "dan"]]) {
    await runQuery("INSERT INTO users (userId, username, email, password) VALUES (?, ?, ?, 'x')", [id, name, name + "@example.com"]);
  }
  await S.init();
  const app = express();
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
  S.register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("Sign out (POST /logout): the login is cleared and the marker names the signed-out account; its attributes", async () => {
  const c = await signIn(UA);
  const r = await req("POST", "/logout", c);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/", "lands on the homepage, a signed-out layout page");
  assert.equal(jwtOf(r), "", "the login cookie is cleared");
  const m = markerOf(r);
  assert.equal(m.v, UA);
  assert.match(m.attrs, /;\s*Max-Age=7776000/i);
  assert.match(m.attrs, /;\s*Path=\//i);
  assert.match(m.attrs, /;\s*Secure/i);
  assert.match(m.attrs, /;\s*SameSite=Lax/i);
  assert.doesNotMatch(m.attrs, /HttpOnly/i, "the page's script deletes it");
  // the landing page's request carries it: chatSweep, signed out
  const land = await (await req("GET", "/probe", null, { cookie: "patv_chat_sweep=" + UA })).json();
  assert.deepEqual(land, { user: null, chatSweep: true });
  assert.deepEqual(await (await req("GET", "/probe", null)).json(), { user: null, chatSweep: false }, "no marker, no sweep");
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
  assert.equal(markerOf(r3).v, UB, "this device signed out: the client goes to /login, which sweeps");
  const c = await signIn(UB);
  const r4 = await req("POST", "/api/account/sessions/revoke-all", c, {}, {});
  assert.equal((await r4.json()).signedOut, true);
  assert.equal(markerOf(r4).v, UB);
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
  assert.equal(markerOf(r).v, UC, "the cookie's account (the gate passes decoded.userId)");
});

test("refreshLogin: an account that no longer exists is signed out with the marker", async () => {
  const c = await signIn(UD);
  await runQuery("DELETE FROM users WHERE userId = ?", [UD]);
  const r = await req("GET", "/probe", c);
  assert.equal((await r.json()).user, null);
  assert.equal(markerOf(r).v, UD);
});

// ── the page: layout.ejs prints the static script on a signed-out page that has chatSweep, and nowhere else ──
const page = (view, locals) => ejs.renderFile(path.join(repo, "views", view), locals);
const hasSweep = (html) => html.includes("patv_chat_sweep=([^;]*)");

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
  assert.ok(hasSweep(await page("layout.ejs", { title: "x", chatSweep: true })), "a page that passes no user is signed out");
  // printed once, exactly the partial's script
  const html = await page("layout.ejs", { title: "x", user: null, chatSweep: true });
  assert.equal(html.split("patv_chat_sweep=([^;]*)").length, 2);
  assert.ok(html.includes(SCRIPT), "the partial's script, byte for byte");
});

test("the partial is static: one script, nothing printed from the request", () => {
  assert.ok(SCRIPT && SCRIPT.length > 100);
  assert.equal(PARTIAL.split("<script>").length, 2, "one script");
  assert.doesNotMatch(PARTIAL, /<%[=-]/, "no output tags (only the <%# comment)");
  assert.doesNotMatch(SCRIPT, /=>|\blet\b|\bconst\b|`/, "ES5: runs on any browser the site supports");
  assert.ok(Buffer.byteLength(PARTIAL.replace(/<%#[\s\S]*?%>\s*/, "")) < 1600, "small (bytes on the one page after a sign-out)");
  vm.createScript(SCRIPT);   // parses
});

// ── the script, in a vm against a fake IndexedDB ──
// behaviour per database name: "ok" (default), "error", "blocked" (success after `later`), "throw" (deleteDatabase throws)
function harness({ cookie = "", names = [], how = {}, databases = "yes", idb = true, cookieThrows = false } = {}) {
  const st = { deleted: [], cookieSets: [], listed: 0, pending: [] };
  let jar = cookie;
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
      const fire = (k) => { if (typeof r[k] === "function") r[k]({ target: r }); };
      if (how[n] === "blocked") st.pending.push(() => fire("onsuccess"));
      else setImmediate(() => fire(how[n] === "error" ? "onerror" : "onsuccess"));
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
  for (const cookie of ["", "a=b", "xpatv_chat_sweep=1", "patv_chat_sweepx=1"]) {
    const st = await harness({ cookie, names: [acct(UA)] }).run();
    assert.equal(st.listed, 0, cookie);
    assert.deepEqual(st.deleted, []);
    assert.deepEqual(st.cookieSets, []);
  }
});

test("the script: deletes exactly patv-chat:<lower-case uuid> - never patv-device or another name - then the marker", async () => {
  const names = [acct(UA), "patv-device", acct(UB), "patv-chat:not-an-account", acct(UA.toUpperCase()), acct(UA) + "x", "x" + acct(UA),
                 "patv-chat:", "patv-chatlog", "other", acct(UC) + ":media"];
  for (const cookie of ["patv_chat_sweep=1", "a=b; patv_chat_sweep=1; c=d", "patv_chat_sweep=" + UD]) {
    const st = await harness({ cookie, names }).run();
    assert.equal(st.listed, 1);
    assert.deepEqual(st.deleted, [acct(UA), acct(UB)], cookie + ": the account databases only (the platform's rule)");
    assert.deepEqual(st.cookieSets, [CLEAR], "then the marker goes");
  }
  // nothing to delete: the marker goes at once
  const none = await harness({ cookie: "patv_chat_sweep=1", names: ["patv-device"] }).run();
  assert.deepEqual(none.deleted, []);
  assert.deepEqual(none.cookieSets, [CLEAR]);
  const empty = await harness({ cookie: "patv_chat_sweep=1", names: [] }).run();
  assert.deepEqual(empty.cookieSets, [CLEAR]);
});

test("the script: a failed, thrown or unfinished delete keeps the marker (the next signed-out page tries again); a blocked one clears after", async () => {
  const err = await harness({ cookie: "patv_chat_sweep=1", names: [acct(UA), acct(UB)], how: { [acct(UB)]: "error" } }).run();
  assert.deepEqual(err.deleted, [acct(UA), acct(UB)], "the others are still deleted");
  assert.deepEqual(err.cookieSets, [], "kept");
  const thr = await harness({ cookie: "patv_chat_sweep=1", names: [acct(UA), acct(UB)], how: { [acct(UA)]: "throw" } }).run();
  assert.deepEqual(thr.deleted, [acct(UB)]);
  assert.deepEqual(thr.cookieSets, [], "kept, and nothing escaped");
  // blocked (another tab's widget still had it open): success comes when it lets go - only then the marker goes
  const bl = harness({ cookie: "patv_chat_sweep=1", names: [acct(UA), acct(UB)], how: { [acct(UA)]: "blocked" } });
  await bl.run();
  assert.deepEqual(bl.cookieSets, [], "still waiting");
  bl.pending.forEach((f) => f());
  assert.deepEqual(bl.cookieSets, [CLEAR]);
  // never finished (the page left): no clear
  const nf = harness({ cookie: "patv_chat_sweep=1", names: [acct(UA)], how: { [acct(UA)]: "blocked" } });
  await nf.run();
  assert.deepEqual(nf.cookieSets, []);
});

test("the script: no indexedDB.databases() (Firefox before 126) - the one database the marker names; a value that isn't a uuid names none", async () => {
  const named = await harness({ cookie: "patv_chat_sweep=" + UA, databases: "no" }).run();
  assert.deepEqual(named.deleted, [acct(UA)]);
  assert.deepEqual(named.cookieSets, [CLEAR]);
  for (const v of ["1", "", "'-alert(1)-'", UA.toUpperCase(), "../" + UA, UA + "x", encodeURIComponent("patv-device")]) {
    const st = await harness({ cookie: "patv_chat_sweep=" + v, databases: "no" }).run();
    assert.deepEqual(st.deleted, [], JSON.stringify(v));
    assert.deepEqual(st.cookieSets, [CLEAR], "nothing this browser can find: the marker goes");
  }
  // databases() refused: the named one if any, else the marker stays for the next page
  const rej = await harness({ cookie: "patv_chat_sweep=" + UB, databases: "reject" }).run();
  assert.deepEqual(rej.deleted, [acct(UB)]);
  assert.deepEqual(rej.cookieSets, [CLEAR]);
  const rej1 = await harness({ cookie: "patv_chat_sweep=1", databases: "reject" }).run();
  assert.deepEqual(rej1.deleted, []);
  assert.deepEqual(rej1.cookieSets, [], "kept: the next signed-out page tries again");
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
  assert.ok(SCRIPT.includes("'" + CS.UUID_SRC + "'"), "the script's uuid is chatsweep's");
  assert.ok(SCRIPT.includes("new RegExp('^patv-chat:' + U + '$')"));
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
  assert.match(rd("middleware", "loginCookie.js"), /require\("\.\.\/chatsweep"\)\.mark\(res, userId\);/);
  // the gate passes the cookie's account (it set no req.loginSession)
  assert.match(rd("sessions.js"), /clearLogin\(res, decoded\.userId\)/);
});
