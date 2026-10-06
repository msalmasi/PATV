// Offline tests for the admin area (1.99cv, adminweb.js + views/admin/* + the shell partials):
// every admin page renders inside the shell, the permission gates are exactly the old ones, the old URLs keep
// working, and every control from the old one-page /admin/panel is on its new section page.
//   NODE_PATH=G:/PATV/node_modules node --test test/admin-ui.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adminui-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const terms = require(path.join(repo, "terms"));
const audit = require(path.join(repo, "contentaudit"));

const users = new Map();
let base, server;
const U = {};
async function mkUser(name, cls) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, level, created_at, casino_banned, email)
                  VALUES (?, ?, ?, 'x', ?, 0, 0, '2026-01-01 00:00:00', 0, ?)`, [id, name, name, cls, name + "@example.com"]);
  const u = { userId: id, username: name, class: cls };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT UNIQUE, xp INTEGER DEFAULT 0,
                  avatar TEXT, emailVerificationToken TEXT, tokenExpires DATETIME, isEmailVerified INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  U.admin = await mkUser("boss", "Admin");
  U.staff = await mkUser("helper", "Staff");
  U.pleb = await mkUser("rando", "pleb");
  await rooms.init();
  await store.init();
  await terms.init();
  await audit.init();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });   // connect-flash stand-in
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const isBotToken = (t) => t === "bot";
  require(path.join(repo, "adminweb")).register(app, { addUser });
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken });
  require(path.join(repo, "pepecontrol")).register(app, { addUser, isBotToken });
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  require(path.join(repo, "mainstage")).register(app, { addUser, isBotToken, noTimers: true });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

const get = (url, who) => fetch(base + url, { redirect: "manual", headers: who ? { "x-test-user": who.userId } : {} });
async function page(url, who) {
  const r = await get(url, who);
  return { status: r.status, location: r.headers.get("location"), html: r.status === 200 ? await r.text() : "" };
}

const SECTIONS = ["/admin", "/admin/users", "/admin/economy", "/admin/games", "/admin/cosmetics", "/admin/bridge", "/admin/pepe", "/admin/system"];

test("gate: /admin and every section are Admin + Staff only (others go to /login, as /admin/panel did)", async () => {
  for (const url of SECTIONS) {
    for (const who of [null, U.pleb]) {
      const r = await page(url, who);
      assert.equal(r.status, 302, url + " for " + (who ? who.username : "anon"));
      assert.equal(r.location, "/login");
    }
    for (const who of [U.staff, U.admin]) {
      const r = await page(url, who);
      assert.equal(r.status, 200, url + " for " + who.username);
      assert.match(r.html, /class="adm-side"/, url + " renders in the shell");
      assert.match(r.html, /\/public\/css\/admin\.css\?v=1/);
      assert.match(r.html, /\/public\/js\/admin-shell\.js\?v=1/);
      assert.match(r.html, /aria-current="page"/, url + " marks its section");
    }
  }
});

test("old URLs: /admin/panel -> /admin (same gate first), aliases, /rooms/admin", async () => {
  let r = await page("/admin/panel", null);
  assert.equal(r.status, 302); assert.equal(r.location, "/login");
  r = await page("/admin/panel", U.pleb);
  assert.equal(r.status, 302); assert.equal(r.location, "/login");
  for (const who of [U.staff, U.admin]) {
    r = await page("/admin/panel", who);
    assert.equal(r.status, 302); assert.equal(r.location, "/admin");
  }
  for (const [from, to] of [["/admin/feed", "/feed/admin"], ["/admin/pads", "/pads/admin"], ["/admin/stage", "/stage/admin"], ["/admin/shop", "/shop/admin"], ["/rooms/admin", "/pads/admin"]]) {
    r = await page(from, U.admin);
    assert.ok(r.status === 301 || r.status === 302, from);
    assert.equal(r.location, to, from);
  }
  // the old one-page anchors are forwarded by the Overview
  r = await page("/admin", U.admin);
  for (const a of ["#welcome-admin", "#stale-admin"]) assert.ok(r.html.includes("'" + a + "': '/admin/users" + a + "'"), a);
});

test("feed / pads / stage admin keep their own gates and render inside the shell", async () => {
  let r = await page("/feed/admin", U.pleb);
  assert.equal(r.status, 403, "feed admin: non-staff still get 403");
  r = await page("/feed/admin", null);
  assert.equal(r.status, 403);
  for (const url of ["/pads/admin", "/stage/admin"]) {
    for (const who of [null, U.pleb]) { r = await page(url, who); assert.equal(r.status, 302, url); assert.equal(r.location, "/login"); }
  }
  for (const who of [U.staff, U.admin]) {
    r = await page("/feed/admin", who);
    assert.equal(r.status, 200);
    assert.match(r.html, /class="adm-side"/);
    for (const id of ["urgent", "users", "bans", "settings", "faCfg", "faBan"]) assert.ok(r.html.includes('id="' + id + '"'), "feed admin #" + id);
    assert.equal(r.html.includes('id="dms"'), who === U.admin, "reported DMs: admins only, as before");
    assert.equal(r.html.includes('id="audit"'), who === U.admin, "access log: admins only, as before");
    assert.equal(r.html.includes('href="#dms"'), who === U.admin, "the nav doesn't offer admin-only anchors to staff");
    r = await page("/pads/admin", who);
    assert.equal(r.status, 200);
    for (const id of ["front", "owners", "royalties", "frontForm", "fcForm", "addForm", "royForm"]) assert.ok(r.html.includes('id="' + id + '"'), "pads admin #" + id);
    r = await page("/stage/admin", who);
    assert.equal(r.status, 200);
    for (const id of ["open", "settings", "bans", "log", "events", "cutAll", "cfg", "banForm", "saState"]) assert.ok(r.html.includes('id="' + id + '"'), "stage admin #" + id);
  }
});

test("overview: tiles by role - admin-only data never reaches Staff", async () => {
  const a = await page("/admin", U.admin);
  for (const id of ["tilePepe", "tileReserve", "tileLoans", "tileReports", "tileStage", "tileStale", "alerts"]) assert.ok(a.html.includes('id="' + id + '"'), "admin sees " + id);
  const s = await page("/admin", U.staff);
  for (const id of ["tileReports", "tileStage", "alerts"]) assert.ok(s.html.includes('id="' + id + '"'), "staff sees " + id);
  for (const id of ["tilePepe", "tileReserve", "tileLoans", "tileStale"]) assert.ok(!s.html.includes('id="' + id + '"'), "staff doesn't see " + id);
  // the Pepe control panel (needs a fresh Admin class from the DB + the CSRF helper)
  assert.match((await page("/admin/pepe", U.admin)).html, /id="pepeCtl"/);
  assert.doesNotMatch((await page("/admin/pepe", U.staff)).html, /id="pepeCtl"/);
  assert.match((await page("/admin/bridge", U.admin)).html, /id="cmdRows"/);
  assert.doesNotMatch((await page("/admin/bridge", U.staff)).html, /id="cmdRows"/);
});

test("control inventory: every control of the old /admin/panel is on its section page, same endpoints", async () => {
  const where = {
    "/admin/users": ["classEditForm", "userClassUsername", "userClass", "classEditStatus", "classListForm", "classAction", "className", "classListStatus", "classList",
                     "xpTransferForm", "xpUsername", "xpAmount", "xpStatus", "welcome-admin", "welcome-config", "welcome-stats", "welcome-recent",
                     "stale-admin", "stale-dates", "stale-counts", "stale-vias"],
    "/admin/economy": ["pointsTransferForm", "pointsUsername", "pointsAmount", "transferStatus", "redemption-codes", "code", "points", "uses_allowed", "expiration_date",
                       "codeStatus", "redemptionCodesList"],
    "/admin/games": ["manualSpinForm", "spinUsername", "spin", "spinStatus", "jackpotForm", "jackpotAmount", "jackpotStatus"],
    "/admin/cosmetics": ["badges", "name", "description", "points", "icon", "requirement", "badgeStatus", "badgesList"],
  };
  for (const [url, ids] of Object.entries(where)) {
    const h = (await page(url, U.admin)).html;
    for (const id of ids) assert.ok(h.includes('id="' + id + '"'), url + " has #" + id);
  }
  // the welcome bonus form keeps every setting the API takes
  const users = (await page("/admin/users", U.admin)).html;
  for (const n of ["enabled", "amount", "min_level", "min_days", "min_age_hours", "ip_max", "ip_window_days", "expire_days", "connect_amount"]) assert.ok(users.includes('name="' + n + '"'), "welcome " + n);
  // the form actions the script rewrites, and every endpoint the old inline scripts called
  assert.ok(users.includes('action="/api/u/username/class/update"'));
  assert.ok((await page("/admin/economy", U.admin)).html.includes('action="/api/admin/transfer/username"'));
  const js = fs.readFileSync(path.join(repo, "public/js/admin-panel.js"), "utf8");
  for (const ep of ["/api/admin/welcome", "/api/admin/welcome/config", "/api/admin/welcome/pay", "/api/admin/stale", "/api/classes", "/api/classes/edit", "/api/admin/update-level",
                    "/api/admin/redemption-codes", "/api/badges", "/api/g/wheel/spin", "/api/g/wheel/jackpot"]) assert.ok(js.includes("'" + ep), "admin-panel.js calls " + ep);
  assert.ok(js.includes("additionalXp") && js.includes("uses_allowed") && js.includes("new FormData(badges)"), "same request bodies");
  assert.ok(!fs.existsSync(path.join(repo, "views/adminPanel.ejs")), "the old one-page view is gone (its route redirects)");
});

test("overview data: alerts, countdown, no crash on an empty database", async () => {
  const A = require(path.join(repo, "adminweb"));
  const o = await A.overview(U.admin);
  assert.equal(o.isAdmin, true);
  assert.ok(Array.isArray(o.alerts));
  assert.ok(o.alerts.some((a) => /Reserve balance never synced/.test(a.text)), "an unsynced Reserve is flagged");
  const s = await A.overview(U.staff);
  assert.equal(s.pepe, null); assert.equal(s.reserve, null); assert.equal(s.loans, null); assert.equal(s.stale, null);
  const d = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  assert.ok([3, 4].includes(A.daysUntil(d)));
  assert.equal(A.daysUntil("nonsense"), null);
});
