// 1.99ack site: the website's capability registry (siteperms.js / siteperms-core.js) and release 2 of /admin/roles.
//   * the registry: can / canId / minClass / atLeast, exact class names only, unknown keys throw here (deny in production)
//   * the golden default matrix: every capability's default minimum class and lock, equal to the 2026-10-18 audit table
//     with the owner's decisions (a: economic configs Admin-only + locked; b: Assistants review banners / soundboards / pad
//     connections and reach just those admin pages; c: likeness view = Staff, the 🛠️ Admin link for admin.area)
//   * a representative route per group enforcing through the registry (an override moves access)
//   * the Website permissions section: edit rules by Pepe role (owners anything, admins never a row an owner set, locked rows
//     never, nothing below Assistant), audit, CSRF, no innerHTML
//   node --test test/siteperms.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siteperms-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SP = require(path.join(repo, "siteperms"));
const CORE = require(path.join(repo, "siteperms-core"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);

// ── the audit table (2026-10-18) + the owner's decisions: key -> [default minimum class, locked?] ──
const GOLDEN = {
  "admin.area": ["staff", false], "admin.sensitive_overview": ["admin", true],
  "roles.assign": ["admin", true], "roles.class_list": ["admin", true], "keys.view": ["admin", true], "keys.manage": ["admin", true],
  "users.xp": ["admin", false], "users.welcome_stale": ["admin", true],
  "accounts.security": ["admin", true], "accounts.delete_other": ["admin", true], "accounts.sessions_revoke": ["admin", true],
  "auth.signin_methods": ["admin", true], "profile.see_private": ["admin", true], "history.lookup": ["staff", true],
  "econ.grant_pat": ["admin", true], "econ.house_adjust": ["admin", true], "econ.codes_manage": ["admin", true], "econ.codes_view": ["admin", true],
  "econ.pepe_econ_cmds": ["admin", true], "econ.burn": ["admin", true], "econ.padvault_move": ["admin", true],
  "econ.telemetry_policy": ["admin", true], "econ.vwm_view": ["staff", false], "econ.backend_cutover": ["admin", true],
  "econ.boost_challenge_cosmetic_cfg": ["admin", true], "premium.admin": ["admin", true], "comps.manage": ["admin", true],
  "crypto.admin": ["admin", true], "donations.admin": ["admin", true], "escrow.override": ["admin", true],
  "games.config": ["admin", true], "markets.auto": ["admin", false], "raffles.admin": ["admin", true], "raffles.house": ["admin", true], "oracle.admin": ["admin", true],
  "casino.admin": ["admin", true], "quotes.free": ["admin", false], "launchpad.admin": ["admin", false], "launchpad.metrics": ["staff", false],
  "pads.manage_any": ["staff", false], "pads.pepe_ctl_any": ["staff", true], "pads.registry_admin": ["staff", false], "pads.royalties_config": ["admin", true],
  "pads.vault_rate": ["admin", true], "pads.config_view": ["staff", false], "pads.config": ["admin", true],
  "pads.approved_inside": ["staff", true], "pads.create_free": ["staff", false], "pads.connect_review": ["assistant", false],
  "pads.send_pepe": ["admin", true], "bridge.blocks_global": ["admin", false], "bridge.cmdlog": ["admin", false],
  "feed.admin_page": ["staff", false], "feed.moderate": ["staff", false], "feed.see_hidden": ["staff", true],
  "feed.tags_remove_any": ["staff", false], "feed.limits_exempt": ["staff", false], "feed.config": ["admin", false],
  "feed.automod_global": ["admin", false], "feed.filter_admin": ["admin", false], "feed.pepe_admin": ["admin", false],
  "feed.admin_lock": ["admin", true], "feed.abuse_details": ["admin", true], "feed.automod_csam_reverse": ["staff", true],
  "takedown.handle": ["staff", true], "imagesafety.admin": ["admin", true],
  "dm.limits_exempt": ["staff", false], "dm.report_review": ["admin", true],
  "creators.admin": ["staff", true], "creators.config_explicit": ["admin", false], "creators.pad_flags_any": ["staff", false],
  "banner.review": ["assistant", false], "banner.config": ["admin", true], "shop.admin": ["staff", true],
  "shopart.view": ["staff", false], "shopart.admin": ["admin", false], "badges.manage": ["staff", false],
  "media.admin": ["admin", false], "media.manage_requests": ["admin", false], "media.library_free": ["admin", false],
  "stage.admin": ["staff", false], "stage.approval_bypass": ["staff", false], "onair.operate": ["staff", false], "onair.config": ["admin", false],
  "onair.live_page": ["staff", true], "onair.direct_media": ["staff", true],   // 1.99acw: locked "exposure" (owner decision 2026-10-18)
  "restream.staff": ["staff", false], "restream.main": ["admin", true], "livecam.admin": ["admin", true], "livecam.end_any": ["staff", false],
  "camclip.override": ["admin", false], "ghost.mode": ["staff", true],
  "soundboards.moderate": ["assistant", false], "soundboards.config": ["admin", true], "voices.view": ["staff", false], "voices.manage": ["admin", true],
  "voiceclone.view": ["staff", true], "voiceclone.decide": ["admin", true], "likeness.view": ["staff", false], "likeness.manage": ["admin", true],
  "pepe.control": ["admin", true], "pepe.rooms_commands_audio": ["admin", true], "pepe.modlog": ["admin", true], "ops.action_ttl": ["admin", true],
  "push.admin": ["admin", false], "help.admin": ["admin", false], "i18n.admin": ["admin", false],
};

const users = new Map();
const U = {};
async function mkUser(key, name, cls, camfrog) {
  const id = "u_" + key;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at, points_balance)
                  VALUES (?, ?, ?, 'x', ?, ?, 0, '2026-01-01 00:00:00', 100000)`, [id, name, name, cls, camfrog || null]);
  U[key] = { userId: id, username: name, class: cls, camfrogUsername: camfrog || null };
  users.set(id, U[key]);
  return U[key];
}
let base, server;
const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, extra) {
  const r = await fetch(base + url, { method, headers: H(u, extra), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, location: r.headers.get("location") };
}
const site = (u, key, value, extra) => call("POST", "/api/admin/roles/site", u, { key, value }, extra);
// an owner's editor object (pepeperms.editorOf) for setting overrides directly
const owner = async () => require(path.join(repo, "pepeperms")).editorOf(U.own.userId);
async function withMin(key, cls, fn) {
  await SP.setMin(await owner(), key, cls);
  try { await fn(); } finally { await SP.setMin(await owner(), key, "default"); }
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT, twitchLogin TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  await mkUser("own", "boss", "Admin", "bossfrog");
  await mkUser("adm", "admin2", "Admin", "plainadmin");
  await mkUser("nolink", "adminnolink", "Admin", null);
  await mkUser("stf", "staffer", "Staff", "staffer_cf");
  await mkUser("ast", "helper", "Assistant", "helper_cf");
  await mkUser("mem", "member", "pleb", null);
  await mkUser("ast2", "helper2", "Assistant", null);   // nothing linked: the new-account rules apply
  await mkUser("padowner", "padowner", "pleb", "ownercf");
  await require(path.join(repo, "adminaudit")).init();
  await SP.init();
  await require(path.join(repo, "staffroles")).botSync({ roles: { bossfrog: ["owner", 1], plainadmin: ["admin", 1], staffer_cf: ["staff", 1], helper_cf: ["assistant", 1] } });
  await rooms.init();
  await require(path.join(repo, "padaccess")).init();
  await require(path.join(repo, "feedstore")).init();
  await require(path.join(repo, "funding")).init();
  await require(path.join(repo, "likeness")).init();
  await require(path.join(repo, "soundboards")).init();
  await require(path.join(repo, "voicestore")).init();
  await require(path.join(repo, "banner")).init();
  await require(path.join(repo, "bridge")).load();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  const bot = { isBotToken: (t) => t === "bot" };
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "adminweb")).register(app, { addUser });
  require(path.join(repo, "adminxp")).register(app, { addUser });
  require(path.join(repo, "staffroles")).register(app, { ...bot, noTimers: true });
  require(path.join(repo, "adminroles")).register(app, { addUser });
  require(path.join(repo, "padconnect")).register(app, { addUser, ...bot, noTimers: true });
  require(path.join(repo, "roomsweb")).register(app, { addUser, ...bot });
  require(path.join(repo, "feedweb")).register(app, { addUser, ...bot });
  require(path.join(repo, "banner")).register(app, { addUser, noTimers: true });
  require(path.join(repo, "soundboards")).register(app, { addUser, ...bot });
  require(path.join(repo, "likeness")).register(app, { addUser, ...bot });
  require(path.join(repo, "premium")).register(app, { addUser });
  require(path.join(repo, "padcosmetics")).register(app, { addUser });
  require(path.join(repo, "pvpcfg")).register(app, { addUser, ...bot });
  require(path.join(repo, "vwm")).register(app, { addUser, ...bot });
  require(path.join(repo, "pepemodlog")).register(app, { addUser, ...bot, bySlug: (s) => rooms.bySlug(s) });
  require(path.join(repo, "help")).register(app, { addUser, ...bot });
  require(path.join(repo, "onair")).register(app, { addUser, ...bot });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

// ── the registry ──
test("registry: exact class names, the ladder Assistant < Staff < Admin, nothing for members or other classes", () => {
  for (const [cls, want] of [["Admin", [1, 1, 1]], ["Staff", [0, 1, 1]], ["Assistant", [0, 0, 1]], ["pleb", [0, 0, 0]], ["Banned", [0, 0, 0]],
                             ["Bot", [0, 0, 0]], ["admin", [0, 0, 0]], ["Moderator", [0, 0, 0]], [null, [0, 0, 0]]]) {
    const u = cls == null ? null : { class: cls };
    assert.deepEqual(["users.xp", "admin.area", "banner.review"].map((k) => +SP.can(u, k)), want, String(cls));
  }
  assert.equal(SP.can("Staff", "admin.area"), true, "a class name works too");
  assert.equal(SP.can({ cls: "Admin" }, "admin.area"), true, "and .cls");
  assert.equal(SP.can(undefined, "admin.area"), false);
  assert.equal(SP.minClass("banner.review"), "assistant");
  assert.equal(SP.atLeast({ class: "Staff" }, "staff"), true);
  assert.equal(SP.atLeast({ class: "Assistant" }, "staff"), false);
  assert.equal(SP.atLeast({ class: "Admin" }, "pleb"), false, "atLeast knows only the three classes");
});

test("registry: an unknown key is a typo - it throws under the test runner and is denied (and logged) in production", async () => {
  assert.throws(() => SP.can({ class: "Admin" }, "admin.areaa"), /unknown capability "admin.areaa"/);
  assert.throws(() => SP.minClass("nope"), /unknown capability/);
  await assert.rejects(SP.canId(U.own.userId, "nope.nope"), /unknown capability/);
  const saved = process.env.NODE_TEST_CONTEXT;
  const err = console.error;
  const logged = [];
  try {
    delete process.env.NODE_TEST_CONTEXT;
    delete process.env.SITEPERMS_STRICT;
    console.error = (m) => logged.push(String(m));
    assert.equal(SP.can({ class: "Admin" }, "prod.typo"), false, "denied in production");
    assert.equal(SP.can({ class: "Admin" }, "prod.typo"), false);
    const view = CORE.viewCan({ me: { class: "Admin" } });
    assert.equal(view("prod.typo2"), false, "the views' fallback too");
  } finally { process.env.NODE_TEST_CONTEXT = saved; console.error = err; }
  assert.equal(logged.filter((m) => m.includes("prod.typo\"")).length, 1, "logged once");
});

test("registry: canId reads the account's class; a missing account holds nothing", async () => {
  assert.equal(await SP.canId(U.stf.userId, "admin.area"), true);
  assert.equal(await SP.canId(U.ast.userId, "admin.area"), false);
  assert.equal(await SP.canId(U.ast.userId, "banner.review"), true);
  assert.equal(await SP.canId("u_nobody", "banner.review"), false);
  assert.equal(await SP.canId(null, "banner.review"), false);
});

test("golden: every capability's default minimum class and lock equal the audit table (+ the owner's 2026-10-18 decisions)", () => {
  const keys = SP.CAPS.map((c) => c[0]);
  assert.equal(new Set(keys).size, keys.length, "no duplicate keys");
  assert.deepEqual([...keys].sort(), Object.keys(GOLDEN).sort(), "the registry has exactly the audited capabilities");
  for (const [k, [def, locked]] of Object.entries(GOLDEN)) {
    const cap = SP.BY_KEY[k];
    assert.equal(cap.def, def, k + " default");
    assert.equal(!!cap.locked, locked, k + " locked");
    assert.equal(SP.minClass(k), def, k + " in force with no overrides");
    assert.ok(CORE.GROUPS.includes(cap.group), k + " group");
    if (cap.locked) assert.ok(CORE.LOCKS.includes(cap.locked), k + " lock reason");
  }
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8"));
  for (const k of keys) assert.ok(en["siteperm.k." + k], "label for " + k);
  for (const g of CORE.GROUPS) assert.ok(en["siteperm.g." + g], "group label " + g);
  for (const r of CORE.LOCKS) assert.ok(en["siteperm.lock." + r], "lock reason " + r);
});

test("decisions: (a) economic configs Admin-only and locked, (b) Assistants review, (c) likeness view = Staff", () => {
  for (const k of ["premium.admin", "econ.boost_challenge_cosmetic_cfg", "pads.royalties_config", "pads.vault_rate"]) {
    assert.equal(SP.can({ class: "Staff" }, k), false, k + ": not Staff any more");
    assert.equal(SP.can({ class: "Admin" }, k), true, k);
    assert.equal(SP.BY_KEY[k].locked, "points", k + " locked");
  }
  for (const k of ["banner.review", "soundboards.moderate", "pads.connect_review"]) assert.equal(SP.can({ class: "Assistant" }, k), true, k);
  for (const k of ["banner.config", "soundboards.config", "pads.registry_admin", "admin.area"]) assert.equal(SP.can({ class: "Assistant" }, k), false, k);
  assert.equal(SP.can({ class: "Staff" }, "likeness.view"), true);
  assert.equal(SP.can({ class: "Moderator" }, "likeness.view"), false, "the old Moderator class is gone");
  assert.equal(SP.can({ class: "Staff" }, "likeness.manage"), false);
  // the naming traps
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "search.js"), "utf8"), /isStaff/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "padflair.js"), "utf8"), /isStaff/);
  assert.match(fs.readFileSync(path.join(repo, "creators.js"), "utf8"), /async function adminIds\(\)/);
  assert.match(fs.readFileSync(path.join(repo, "storealerts.js"), "utf8"), /const shopStaff = \(u\) => SP\.can\(u, "shop\.admin"\)/);
});

// ── decision (a): routes ──
test("(a) premium admin, boosts / challenge / pad cosmetics pricing, owner royalties: Staff refused, Admins in", async () => {
  for (const url of ["/api/premium/admin", "/api/boost/admin", "/api/challenge/admin", "/api/pad-cosmetics/admin"]) {
    assert.equal((await call("GET", url, U.stf)).status, 403, url + " (Staff)");
    assert.equal((await call("GET", url, U.own)).status, 200, url + " (Admin)");
  }
  assert.equal((await call("POST", "/api/premium/admin", U.stf, {})).status, 403);
  let r = await call("POST", "/api/rooms/admin/royalties", U.stf, { enabled: false });
  assert.equal(r.status, 403, "royalties config: Staff refused");
  r = await call("POST", "/api/rooms/admin/royalties", U.own, {});
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal((await call("POST", "/api/rooms/front/config", U.stf, {})).status !== 403, true, "the rest of /pads/admin stays Staff");
  // the page: Staff see the royalties read-only and no boosts switch
  r = await call("GET", "/pads/admin", U.stf);
  assert.equal(r.status, 200);
  assert.match(r.text, /id="royalties"/);
  assert.doesNotMatch(r.text, /Save royalties/);
  assert.doesNotMatch(r.text, /id="boostCfg"/);
  r = await call("GET", "/pads/admin", U.own);
  assert.match(r.text, /Save royalties/);
  assert.match(r.text, /id="boostCfg"/);
});

test("(a) a pad's vault payout rate: its owner (weekly) or an Admin (any pad, any time) - not Staff managing the pad", async () => {
  await rooms.addRoom("Vault.Room", "Vault Room", "test");
  await rooms.setOwner("Vault.Room", "padowner", "test");
  const RV = require(path.join(repo, "roomvaults"));
  await RV.init();
  assert.equal(await rooms.canManage(U.stf, "Vault.Room"), true, "Staff still manage the pad");
  await assert.rejects(RV.setRate("Vault.Room", U.stf, 5), (e) => e.status === 403);
  const a = await RV.setRate("Vault.Room", U.padowner, 5);
  assert.equal(a.rate, 5);
  await assert.rejects(RV.setRate("Vault.Room", U.padowner, 6), (e) => e.status === 429, "the owner: once a week");
  const b = await RV.setRate("Vault.Room", U.own, 7);
  assert.equal(b.rate, 7, "an Admin: any time");
  const c = await RV.card("Vault.Room", U.stf, { canManage: true });
  assert.equal(c.can_set_rate, false, "Staff's card has no rate control");
  assert.equal((await RV.card("Vault.Room", U.own, { canManage: true })).can_set_rate, true);
  assert.equal((await RV.card("Vault.Room", U.own, { canManage: true })).rate_locked_until, null);
});

// ── decision (b): Assistants ──
test("(b) Assistants: banner review, soundboard moderation, pad connection requests - and only those admin pages", async () => {
  let r = await call("GET", "/admin/banner", U.ast);
  assert.equal(r.status, 200, "the banner queue");
  assert.match(r.text, /href="\/admin\/banner"/);
  assert.match(r.text, /href="\/admin\/soundboards"/);
  assert.match(r.text, /href="\/pads\/admin"/);
  for (const not of ["/admin/economy", "/admin/users", "/admin/games", "/admin/roles", "/feed/admin", "/stage/admin"]) {
    assert.ok(!r.text.includes(`href="${not}"`), "the nav hides " + not);
  }
  assert.match(r.text, /<span class="adm-role">Assistant<\/span>/);
  assert.match(r.text, /<a href="\/admin\/banner" class="nav-link adminLink" title/, "the 🛠️ Admin link goes to their first page");
  assert.equal((await call("POST", "/api/banner/admin/decide", U.ast, { id: "nope", approve: true })).status, 404, "past the gate");
  assert.equal((await call("POST", "/api/banner/admin/config", U.ast, {})).status, 403, "settings stay Admin-only");
  assert.equal((await call("GET", "/api/soundboards/admin", U.ast)).status, 200);
  assert.equal((await call("GET", "/api/soundboards/admin", U.mem)).status, 403);
  r = await call("GET", "/admin/soundboards", U.ast);
  assert.equal(r.status, 200);
  assert.match(r.text, /data-sa="reports"/);
  assert.doesNotMatch(r.text, /data-sa="voices"|data-sa="likeness"|data-sa-cfg="sb"/, "only the clips");
  assert.equal((await call("GET", "/api/pads/connections", U.ast)).status, 200);
  assert.equal((await call("GET", "/api/pads/connections", U.mem)).status, 403);
  r = await call("GET", "/pads/admin", U.ast);
  assert.equal(r.status, 200);
  assert.match(r.text, /id="padconn"/);
  assert.doesNotMatch(r.text, /id="owners"|id="royalties"|id="front"/, "nothing else of /pads/admin");
  assert.equal((await call("POST", "/api/rooms/front", U.ast, { room: "auto" })).status, 403);
  // the rest of the admin area sends them to their own page; members to sign in
  r = await call("GET", "/admin", U.ast);
  assert.equal(r.status, 302);
  assert.equal(r.location, "/admin/banner");
  assert.equal((await call("GET", "/admin/system", U.ast)).location, "/admin/banner");
  assert.equal((await call("GET", "/admin", U.mem)).location, "/login");
});

// ── decision (c) ──
test("(c) likeness: Staff see it, Admins change it; the 🛠️ Admin link shows for admin.area (Staff), not for members", async () => {
  assert.equal((await call("GET", "/api/likeness/admin", U.stf)).status, 200);
  assert.equal((await call("GET", "/api/likeness/admin", U.ast)).status, 403);
  assert.equal((await call("POST", "/api/likeness/admin", U.stf, { release: true })).status, 403);
  let r = await call("GET", "/admin/system", U.stf);
  assert.equal(r.status, 200);
  assert.match(r.text, /<a href="\/admin" class="nav-link adminLink" title/, "Staff: shown");
  r = await call("GET", "/p", U.mem);
  if (r.status === 200) assert.match(r.text, /class="nav-link adminLink" hidden/, "members: hidden");
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "views/layout.ejs"), "utf8"), /data\.class === "Admin"/, "no client-side class check");
});

// ── a representative route per group: an override moves access ──
test("overrides move access, route by route (one per group)", async () => {
  // admin area: Assistants get the whole area
  await withMin("admin.area", "assistant", async () => {
    assert.equal((await call("GET", "/admin/system", U.ast)).status, 200);
  });
  assert.equal((await call("GET", "/admin/system", U.ast)).status, 302);
  // accounts: XP
  assert.equal((await call("POST", "/api/admin/update-level", U.stf, {})).status, 403);
  await withMin("users.xp", "staff", async () => {
    assert.equal((await call("POST", "/api/admin/update-level", U.stf, {})).status, 400, "past the gate (no username)");
  });
  // economy: verified watch-minutes
  assert.equal((await call("GET", "/api/admin/econ/vwm", U.ast)).status, 403);
  await withMin("econ.vwm_view", "assistant", async () => {
    assert.notEqual((await call("GET", "/api/admin/econ/vwm", U.ast)).status, 403);
  });
  // games: the PvP knobs are games.config - locked "points" (1.99acl), so no override moves them; quotes.free does move
  assert.equal((await call("GET", "/api/admin/pvp-cfg", U.stf)).status, 403);
  await assert.rejects(SP.setMin(await owner(), "games.config", "staff"), (e) => e.code === "locked");
  assert.equal((await call("GET", "/api/admin/pvp-cfg", U.stf)).status, 403);
  assert.equal(SP.can(U.stf, "quotes.free"), false);
  await withMin("quotes.free", "staff", async () => { assert.equal(SP.can(U.stf, "quotes.free"), true); });
  // pads: the connection queue raised to Staff shuts Assistants out
  await withMin("pads.connect_review", "staff", async () => {
    assert.equal((await call("GET", "/api/pads/connections", U.ast)).status, 403);
    assert.equal((await call("GET", "/api/pads/connections", U.stf)).status, 200);
  });
  // feed: moderating a post
  assert.equal((await call("POST", "/api/feed/posts/nope/admin", U.ast, { hidden: true })).status, 403);
  await withMin("feed.moderate", "assistant", async () => {
    assert.equal((await call("POST", "/api/feed/posts/nope/admin", U.ast, { hidden: true })).status, 404, "past the gate (no such post)");
  });
  // messages: picture rules
  const DM = require(path.join(repo, "dmmedia"));
  assert.ok(await DM.pictureRefusal({ ...U.ast2, level: 0 }), "an Assistant follows the picture rules");
  await withMin("dm.limits_exempt", "assistant", async () => {
    assert.equal(await DM.pictureRefusal({ ...U.ast2, level: 0 }), null);
  });
  // creators / banner: the review queue raised to Staff shuts Assistants out (banner.config is locked "points" since 1.99acl)
  assert.equal((await call("POST", "/api/banner/admin/decide", U.ast, { id: "nope", approve: true })).status, 404);
  await withMin("banner.review", "staff", async () => {
    assert.equal((await call("POST", "/api/banner/admin/decide", U.ast, { id: "nope", approve: true })).status, 403);
  });
  // media: play from library
  const MC = require(path.join(repo, "mediaconf"));
  assert.equal(MC.libraryAllowed(U.stf), false);
  await withMin("media.library_free", "staff", async () => { assert.equal(MC.libraryAllowed(U.stf), true); });
  // stage: on-air
  assert.equal((await call("GET", "/api/stage/admin/onair", U.ast)).status, 403);
  await withMin("onair.operate", "assistant", async () => {
    assert.notEqual((await call("GET", "/api/stage/admin/onair", U.ast)).status, 403);
  });
  // sound: likeness view raised back to Admins
  await withMin("likeness.view", "admin", async () => {
    assert.equal((await call("GET", "/api/likeness/admin", U.stf)).status, 403);
  });
  // pepe: every key is locked (1.99acl: the mod log "privacy") - Staff stay out whatever an owner tries
  assert.equal((await call("GET", "/api/admin/pepe/modlog", U.stf)).status, 403);
  await assert.rejects(SP.setMin(await owner(), "pepe.modlog", "staff"), (e) => e.code === "locked");
  assert.equal((await call("GET", "/api/admin/pepe/modlog", U.stf)).status, 403);
  // site tools: help questions
  assert.equal((await call("GET", "/admin/help", U.stf)).status, 403);
  await withMin("help.admin", "staff", async () => {
    assert.notEqual((await call("GET", "/admin/help", U.stf)).status, 403);
  });
  assert.deepEqual((await getQuery("SELECT key FROM site_perms WHERE min_class IS NOT NULL")).map((r) => r.key), [], "all back to default");
});

// ── /admin/roles: the Website permissions section ──
test("the section: grouped rows with the ✅/❌ ladder, 🔒 locked rows with their reason, read-only for non-editors", async () => {
  const r = await call("GET", "/admin/roles", U.own);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /data-placeholder="release-2"/);
  for (const g of CORE.GROUPS) assert.match(r.text, new RegExp(`id="arWebG-${g}"`), g);
  assert.match(r.text, /<select id="arSite-banner\.review" data-site-perm="banner\.review">/);
  assert.match(r.text, /<select id="arSite-premium\.admin" data-site-perm="premium\.admin" disabled>/, "locked: disabled");
  assert.match(r.text, /data-site-locked="points">🔒 Creates or moves PAT\./);
  assert.match(r.text, /data-site-locked="escalation"/);
  const row = r.text.slice(r.text.indexOf('data-site-key="admin.area"'), r.text.indexOf("</tr>", r.text.indexOf('data-site-key="admin.area"')));
  assert.deepEqual([...row.matchAll(/(✅|❌)/g)].map((m) => m[1]), ["✅", "✅", "❌"], "admin.area: Admin ✅ Staff ✅ Assistant ❌");
  const j = await call("GET", "/api/admin/roles", U.own);
  assert.equal(j.d.site.canEdit, true);
  assert.equal(j.d.site.groups.flatMap((g) => g.rows).length, SP.CAPS.length);
  // Staff can't open it at all; an Admin without a Pepe role looks read-only
  assert.equal((await call("GET", "/admin/roles", U.stf)).location, "/admin");
  assert.equal((await call("GET", "/admin/roles", U.ast)).location, "/admin/banner");
  const ro = await call("GET", "/admin/roles", U.nolink);
  assert.match(ro.text, /id="arWebReadOnly"/);
  assert.match(ro.text, /<select id="arSite-banner\.review" data-site-perm="banner\.review" disabled>/);
});

test("edit rules: owners anything editable, admins never a row an owner set, locked rows never, nothing below Assistant; audited", async () => {
  // an owner moves help.admin to Staff
  let r = await site(U.own, "help.admin", "staff");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(SP.minClass("help.admin"), "staff");
  assert.equal(SP.can(U.stf, "help.admin"), true);
  let a = await getQuery("SELECT * FROM admin_audit WHERE action = 'site_perm' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(a[0].detail), { key: "help.admin", from: null, to: "staff", editor_role: "owner" });
  assert.equal(a[0].admin_name, "boss");
  // an admin can't touch it now (nor reset it)
  for (const v of ["admin", "assistant", "default"]) {
    r = await site(U.adm, "help.admin", v);
    assert.equal(r.status, 403, v);
    assert.equal(r.d.code, "owner_only");
  }
  let page = await call("GET", "/admin/roles", U.adm);
  assert.match(page.text, /<select id="arSite-help\.admin" data-site-perm="help\.admin" disabled>/, "greyed for the admin");
  // an admin changes an admin-reachable row; the owner can change it after
  r = await site(U.adm, "i18n.admin", "staff");
  assert.equal(r.status, 200);
  assert.equal((await getQuery("SELECT by_level, by FROM site_perms WHERE key = 'i18n.admin'"))[0].by_level, 80);
  r = await site(U.adm, "i18n.admin", "assistant");
  assert.equal(r.status, 200, "an admin may change what an admin set");
  r = await site(U.own, "i18n.admin", "default");
  assert.equal(r.status, 200);
  assert.equal(SP.minClass("i18n.admin"), "admin");
  // 1.99acl: an owner's RESET is the owners' too - an admin can't undo it straight away
  for (const v of ["staff", "assistant", "admin"]) {
    r = await site(U.adm, "i18n.admin", v);
    assert.equal(r.status, 403, v);
    assert.equal(r.d.code, "owner_only", v);
  }
  assert.equal(SP.minClass("i18n.admin"), "admin");
  assert.equal((await getQuery("SELECT by_level FROM site_perms WHERE key = 'i18n.admin'"))[0].by_level, 100, "the owner's row is untouched");
  page = await call("GET", "/admin/roles", U.adm);
  assert.match(page.text, /<select id="arSite-i18n\.admin" data-site-perm="i18n\.admin" disabled>/, "greyed for the admin after an owner's reset");
  // locked rows never move, for anyone
  for (const k of ["premium.admin", "roles.assign", "ghost.mode", "takedown.handle", "feed.admin_lock"]) {
    r = await site(U.own, k, "assistant");
    assert.equal(r.status, 403, k);
    assert.equal(r.d.code, "locked", k);
    assert.equal(SP.minClass(k), GOLDEN[k][0], k + " unchanged");
  }
  // nothing below Assistant, junk refused
  for (const v of ["pleb", "member", "everyone", "nobody", "Admin ", 3]) {
    r = await site(U.own, "quotes.free", v);
    assert.equal(r.status, 400, String(v));
  }
  r = await site(U.own, "no.such.key", "staff");
  assert.equal(r.status, 400);
  // who may edit at all
  r = await site(U.stf, "quotes.free", "staff");
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "admin_only", "Staff: not even the page");
  r = await site(U.nolink, "quotes.free", "staff");
  assert.equal(r.d.code, "not_pepe_admin", "an Admin without a Pepe role");
  assert.equal((await site(null, "quotes.free", "staff")).status, 401);
  // an override of a locked key smuggled into the table never applies
  await runQuery("INSERT OR REPLACE INTO site_perms (key, min_class, ts, by, by_level) VALUES ('econ.grant_pat', 'assistant', 1, 'x', 100)");
  await runQuery("INSERT OR REPLACE INTO site_perms (key, min_class, ts, by, by_level) VALUES ('zz.gone', 'assistant', 1, 'x', 100)");
  await runQuery("INSERT OR REPLACE INTO site_perms (key, min_class, ts, by, by_level) VALUES ('quotes.free', 'pleb', 1, 'x', 100)");
  await SP.reload();
  assert.equal(SP.can(U.ast, "econ.grant_pat"), false);
  assert.equal(SP.minClass("quotes.free"), "admin", "a junk value is ignored");
  await runQuery("DELETE FROM site_perms WHERE key IN ('econ.grant_pat', 'zz.gone', 'quotes.free')");
  await SP.reload();
  // reset: the row stays (who reset it), the default applies
  r = await site(U.own, "help.admin", "default");
  assert.equal(r.status, 200);
  assert.equal(SP.minClass("help.admin"), "admin");
  const row = (await getQuery("SELECT * FROM site_perms WHERE key = 'help.admin'"))[0];
  assert.equal(row.min_class, null);
  assert.equal(row.by, "web:boss");
  r = await site(U.own, "help.admin", "default");
  assert.equal(r.d.unchanged, true);
  page = await call("GET", "/admin/roles", U.own);
  assert.match(page.text, /Set by 🌐 boss/);
});

test("CSRF: a change needs X-Requested-With: fetch from this origin", async () => {
  let r = await site(U.own, "quotes.free", "staff", { "x-requested-with": "" });
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "cross_site");
  r = await site(U.own, "quotes.free", "staff", { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  r = await fetch(base + "/api/admin/roles/site", { method: "POST", headers: { "x-test-user": U.own.userId, "content-type": "application/json", "x-requested-with": "fetch" },
                                                    body: JSON.stringify({ key: "quotes.free", value: "staff" }) });
  assert.equal(r.status, 403, "no origin / referer");
  assert.equal(SP.minClass("quotes.free"), "admin");
});

test("the page script builds no HTML; the section prints raw only translated strings", () => {
  const js = fs.readFileSync(path.join(repo, "public/js/admin-roles.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /post\('\/api\/admin\/roles\/site', \{ key: el\.getAttribute\('data-site-perm'\), value: el\.value \}\)/);
  assert.match(js, /post\('\/api\/admin\/roles\/site', \{ key: key, value: 'default' \}\)/);
  const ejs = fs.readFileSync(path.join(repo, "views/admin/roles.ejs"), "utf8");
  const sec = ejs.slice(ejs.indexOf('id="website"'), ejs.indexOf('id="chat"'));
  assert.ok(sec.length > 500);
  assert.doesNotMatch(sec.replace(/<%-\s*t\(/g, ""), /<%-/, "raw output only for t()");
  const core = fs.readFileSync(path.join(repo, "siteperms-core.js"), "utf8");
  assert.doesNotMatch(core, /<%|%>/, "the core can be included by a view");
});

// ── 1.99acl: review fixes ──
const PROTO = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
               "toLocaleString", "__defineGetter__", "__lookupGetter__", "prototype"];
const dbu = require(path.join(repo, "dbUtils"));
const quiet = async (fn) => { const err = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = err; } };

test("1.99acl: locks - the owner's decisions (points Admin-only, security never lowerable) with their reasons", async () => {
  const want = {
    "history.lookup": ["staff", "privacy"], "feed.see_hidden": ["staff", "safety"], "pads.approved_inside": ["staff", "privacy"],
    "econ.codes_view": ["admin", "points"], "creators.admin": ["staff", "points"], "raffles.admin": ["admin", "points"],
    "oracle.admin": ["admin", "points"], "shop.admin": ["staff", "points"], "admin.sensitive_overview": ["admin", "privacy"],
    "voiceclone.view": ["staff", "consent"], "voiceclone.decide": ["admin", "consent"], "ops.action_ttl": ["admin", "ops"],
    "pepe.modlog": ["admin", "privacy"], "pads.config": ["admin", "points"], "games.config": ["admin", "points"],
    "banner.config": ["admin", "points"], "voices.manage": ["admin", "points"], "likeness.manage": ["admin", "points"],
    "soundboards.config": ["admin", "points"], "pads.pepe_ctl_any": ["staff", "ops"],
  };
  for (const [k, [def, why]] of Object.entries(want)) {
    assert.equal(SP.BY_KEY[k].def, def, k);
    assert.equal(SP.BY_KEY[k].locked, why, k);
    const r = await site(U.own, k, def === "admin" ? "staff" : "assistant");
    assert.equal(r.status, 403, k);
    assert.equal(r.d.code, "locked", k);
    assert.equal(SP.minClass(k), def, k + " unchanged");
  }
  assert.equal(SP.BY_KEY["pads.manage_any"].locked, null, "pads.manage_any stays editable");
  assert.equal(SP.can(U.stf, "econ.codes_view"), false, "the one behaviour change: Staff no longer list redemption codes");
  assert.equal(SP.can(U.own, "econ.codes_view"), true);
  const page = await call("GET", "/admin/roles", U.own);
  assert.match(page.text, /data-site-key="pads\.pepe_ctl_any"/);
  assert.match(page.text, /data-site-locked="consent">🔒 Consent - a member's cam or their cloned voice/);
});

test("1.99acl: prototype names are never a class or a key - refused cleanly, never stored", async () => {
  const before = (await getQuery("SELECT key, min_class, ts, by_level FROM site_perms ORDER BY key"));
  for (const p of PROTO) {
    for (const lvl of [100, 80]) {
      assert.match(SP.editWhy(lvl, "quotes.free", p), /Pick Admin, Staff or Assistant/, p + " as a value");
      assert.equal(SP.editWhy(lvl, p, "staff"), "No such permission.", p + " as a key");
      assert.equal(SP.editWhy(lvl, p, null), "No such permission.", p + " as a key (reset)");
    }
    let r = await site(U.own, "quotes.free", p);
    assert.equal(r.status, 400, p + " value: " + r.text);
    assert.equal(r.d.code, "invalid");
    r = await site(U.own, p, "staff");
    assert.equal(r.status, 400, p + " key: " + r.text);
    assert.equal(r.d.code, "invalid");
    r = await site(U.adm, p, "default");
    assert.equal(r.status, 400, p + " key, admin: " + r.text);
    await assert.rejects(SP.setMin(await owner(), "admin.area", p), (e) => e.status === 400 && e.code === "invalid");
    assert.throws(() => SP.can(U.own, p), /unknown capability/, p);
    assert.throws(() => SP.minClass(p), /unknown capability/, p);
    assert.equal(SP.atLeast(U.own, p), false, p);
    assert.equal(CORE.capOf(p), null, p);
    assert.equal(CORE.rankOf(p), 0, p);
    assert.equal(CORE.minOf(JSON.parse(JSON.stringify({ "quotes.free": p })), "quotes.free"), "admin", p + " in an override map");
  }
  for (const body of [{ key: { a: 1 }, value: "staff" }, { key: ["quotes.free"], value: "staff" }, { key: "quotes.free", value: { a: 1 } }]) {
    const r = await call("POST", "/api/admin/roles/site", U.own, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const own = JSON.parse('{"__proto__": "assistant", "constructor": "assistant"}');
  assert.equal(CORE.check(own, { class: "Assistant" }, "users.xp"), false, "an own __proto__ key in an override map moves nothing");
  assert.deepEqual(await getQuery("SELECT key, min_class, ts, by_level FROM site_perms ORDER BY key"), before, "nothing stored");
  assert.equal(SP.can(U.own, "admin.area"), true, "Admins still in");
});

test("1.99acl: a bad row in the table (prototype value or key) is ignored on reload - nobody is locked out", async () => {
  const rows = [["admin.area", "constructor"], ["markets.auto", "__proto__"], ["quotes.free", "toString"], ["users.xp", "valueOf"],
                ["constructor", "staff"], ["__proto__", "assistant"], ["toString", "assistant"], ["hasOwnProperty", "staff"]];
  try {
    for (const [k, v] of rows) await runQuery("INSERT OR REPLACE INTO site_perms (key, min_class, ts, by, by_level) VALUES (?, ?, 1, 'x', 100)", [k, v]);
    await SP.reload();
    assert.equal(SP.can(U.own, "admin.area"), true, "Admins keep the admin area");
    assert.equal(SP.can(U.stf, "admin.area"), true, "and Staff (the default)");
    assert.equal(SP.minClass("admin.area"), "staff");
    assert.equal(SP.minClass("markets.auto"), "admin");
    assert.equal(SP.minClass("quotes.free"), "admin");
    assert.equal(SP.can(U.own, "users.xp"), true);
    const v = await SP.view(await owner());
    assert.equal(v.groups.flatMap((g) => g.rows).length, SP.CAPS.length);
    assert.equal((await call("GET", "/admin/roles", U.own)).status, 200);
  } finally {
    await runQuery(`DELETE FROM site_perms WHERE key IN (${rows.map(() => "?").join(",")})`, rows.map((r) => r[0]));
    await SP.reload();
  }
});

test("1.99acl: an owner's reset protects the row from admins (whatever its value), owners still change it", async () => {
  let r = await site(U.own, "launchpad.admin", "staff");
  assert.equal(r.status, 200);
  r = await site(U.own, "launchpad.admin", "default");         // the owner's reset: the row stays (who reset it)
  assert.equal(r.status, 200);
  const row = (await getQuery("SELECT min_class, by_level FROM site_perms WHERE key = 'launchpad.admin'"))[0];
  assert.deepEqual({ ...row }, { min_class: null, by_level: 100 });
  r = await site(U.adm, "launchpad.admin", "staff");
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "owner_only");
  assert.equal(SP.minClass("launchpad.admin"), "admin");
  const v = await SP.view(await require(path.join(repo, "pepeperms")).editorOf(U.adm.userId));
  const vr = v.groups.flatMap((g) => g.rows).find((x) => x.key === "launchpad.admin");
  assert.equal(vr.ownerSet, true);
  assert.equal(vr.editable, false);
  r = await site(U.own, "launchpad.admin", "staff");
  assert.equal(r.status, 200, "an owner may");
  r = await site(U.own, "launchpad.admin", "default");
  assert.equal(r.status, 200);
});

test("1.99acl: another process's owner write - setMin reads the row from the database, and the write itself never replaces it", async () => {
  // (1) the owner's row is in the table but not in this process's cache
  await runQuery("DELETE FROM site_perms WHERE key = 'markets.auto'");
  await SP.reload();
  await runQuery("INSERT INTO site_perms (key, min_class, ts, by, by_level) VALUES ('markets.auto', 'staff', ?, 'web:boss', 100)", [Date.now()]);
  let r = await site(U.adm, "markets.auto", "assistant");
  assert.equal(r.status, 403, JSON.stringify(r.d));
  assert.equal(r.d.code, "owner_only");
  let row = (await getQuery("SELECT min_class, by_level FROM site_perms WHERE key = 'markets.auto'"))[0];
  assert.deepEqual({ ...row }, { min_class: "staff", by_level: 100 }, "untouched");
  // (2) the owner writes between setMin's read and its write: the conditional upsert refuses
  await runQuery("DELETE FROM site_perms WHERE key = 'markets.auto'");
  await SP.reload();
  const orig = dbu.getQuery;
  dbu.getQuery = async (sql, params) => {
    if (/SELECT min_class, ts, by_level FROM site_perms WHERE key = \?/.test(sql)) {
      const out = await orig(sql, params);   // read: no row yet ...
      await orig("SELECT 1");
      await runQuery("INSERT INTO site_perms (key, min_class, ts, by, by_level) VALUES ('markets.auto', 'staff', ?, 'web:boss', 100)", [Date.now()]);
      return out;                            // ... and the owner's row lands right after it
    }
    return orig(sql, params);
  };
  try {
    r = await site(U.adm, "markets.auto", "assistant");
  } finally { dbu.getQuery = orig; }
  assert.equal(r.status, 403, JSON.stringify(r.d));
  assert.equal(r.d.code, "owner_only");
  row = (await getQuery("SELECT min_class, by_level, by FROM site_perms WHERE key = 'markets.auto'"))[0];
  assert.deepEqual({ ...row }, { min_class: "staff", by_level: 100, by: "web:boss" }, "the owner's row survived");
  assert.equal(SP.minClass("markets.auto"), "staff", "and the cache has it");
  // an owner's own write still replaces it
  r = await site(U.own, "markets.auto", "default");
  assert.equal(r.status, 200);
  assert.equal(SP.minClass("markets.auto"), "admin");
  assert.equal(await SP.view(null).then(() => true), true);
});

test("1.99acl: a failed load at start is retried by the minute timer; the 5 s poll picks up other processes' edits", async () => {
  const orig = dbu.getQuery;
  let fail = true, siteReads = 0;
  dbu.getQuery = (sql, params) => {
    if (/FROM site_perms/.test(sql)) { siteReads++; if (fail) return Promise.reject(new Error("SQLITE_BUSY: boom")); }
    return orig(sql, params);
  };
  try {
    await runQuery("INSERT OR REPLACE INTO site_perms (key, min_class, ts, by, by_level) VALUES ('quotes.free', 'staff', ?, 'web:boss', 100)", [Date.now()]);
    SP._reset();
    await quiet(() => SP.tick());                          // the boot load fails ...
    assert.equal(SP.minClass("quotes.free"), "admin", "nothing loaded");
    await quiet(() => SP.tick());                          // ... and fails again
    fail = false;
    await SP.tick();                                       // ... then works: init, not a reload that never comes
    assert.equal(SP.minClass("quotes.free"), "staff", "loaded on the retry");
    // the poll: a cheap query, a reload only when the table moved
    siteReads = 0;
    await SP.poll();
    assert.equal(siteReads, 1, "nothing changed: one max(ts) query");
    await runQuery("UPDATE site_perms SET min_class = 'assistant', ts = ts + 5 WHERE key = 'quotes.free'");
    await SP.poll();
    assert.equal(SP.minClass("quotes.free"), "assistant", "another process's edit, picked up");
    await runQuery("DELETE FROM site_perms WHERE key = 'quotes.free'");
    await SP.poll();
    assert.equal(SP.minClass("quotes.free"), "admin", "a deleted row too (the count moved)");
  } finally {
    dbu.getQuery = orig;
    await runQuery("DELETE FROM site_perms WHERE key = 'quotes.free'");
    await SP.init();
    await SP.reload();
  }
  const src = fs.readFileSync(path.join(repo, "siteperms.js"), "utf8");
  assert.match(src, /setInterval\(tick, 60e3\)/);
  assert.match(src, /\(ready \? reload\(\) : init\(\)\)\.catch/);
});

test("1.99acl: /admin/bridge - each section on its own key (command log, relay blocks, moderation history)", async () => {
  const ids = (t) => ({ cmd: /id="cmdRows"/.test(t), blk: /id="blkRows"/.test(t), ml: /id="mlRows"/.test(t), script: /<script>\s*\(function/.test(t) });
  let r = await call("GET", "/admin/bridge", U.own);
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.text), { cmd: true, blk: true, ml: true, script: true }, "an Admin: all three");
  r = await call("GET", "/admin/bridge", U.stf);
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r.text), { cmd: false, blk: false, ml: false, script: false }, "Staff by default: none");
  await withMin("bridge.blocks_global", "staff", async () => {
    assert.deepEqual(ids((await call("GET", "/admin/bridge", U.stf)).text), { cmd: false, blk: true, ml: false, script: true }, "blocks only");
  });
  await withMin("bridge.cmdlog", "staff", async () => {
    assert.deepEqual(ids((await call("GET", "/admin/bridge", U.stf)).text), { cmd: true, blk: false, ml: false, script: true }, "the command log only");
  });
  const ejs = fs.readFileSync(path.join(repo, "views/admin/bridge.ejs"), "utf8");
  assert.match(ejs, /blkOk = _can\('bridge\.blocks_global'\)/);
  assert.match(ejs, /mlOk = _can\('pepe\.modlog'\)/);
  assert.match(ejs, /getElementById\('cmdForm'\)[^\n]*\n\s*if \(!f\) return;/, "each script part runs only with its section");
});

test("1.99acl: a hidden post's own page follows feed.see_hidden (not feed.moderate)", async () => {
  const store = require(path.join(repo, "feedstore"));
  const p = await store.create(U.own.userId, { title: "Hidden for the test", body: "x", community: "u/" + U.own.username });
  await store.adminSet(U.own, p.id, { hidden: true });
  const open = async (u) => (await call("GET", "/feed/p/" + p.id, u)).status;
  assert.equal(await open(U.mem), 404, "a member: not found");
  assert.notEqual(await open(U.stf), 404, "Staff (feed.see_hidden)");
  await withMin("feed.moderate", "admin", async () => {
    assert.notEqual(await open(U.stf), 404, "still seen with the action menu raised to Admins");
  });
  await withMin("feed.moderate", "assistant", async () => {
    assert.equal(await open(U.ast), 404, "moderating doesn't show hidden posts to Assistants");
  });
});

test("1.99acl: redemption codes are Admin-only on /admin/economy; Pepe in / out of any pad's room is pads.pepe_ctl_any", async () => {
  let r = await call("GET", "/admin/economy", U.stf);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /id="redemptionCodesList"|id="redemption-codes"/, "Staff: no codes");
  assert.doesNotMatch(r.text, /href="\/admin\/economy#codes"/, "nor the nav link");
  r = await call("GET", "/admin/economy", U.own);
  assert.match(r.text, /id="redemptionCodesList"/);
  assert.match(r.text, /id="redemption-codes"/);
  // the room control: its own key (locked "ops", Staff); lowering pads.manage_any doesn't hand it out
  await rooms.addRoom("Ctl.Room", "Ctl Room", "test").catch(() => {});
  const slug = (await rooms.get("Ctl.Room")).slug;
  const src = fs.readFileSync(path.join(repo, "padowner.js"), "utf8");
  const ctl = src.slice(src.indexOf('"/api/rooms/:slug/owner/pepe-room"'), src.indexOf('kind: "room.ctl"'));
  assert.match(ctl, /SP\.can\(req\.user, "pads\.pepe_ctl_any"\)/);
  assert.doesNotMatch(ctl, /can\(req\.user, "pads\.manage_any"\)/);
  const ctlCall = (u) => call("POST", "/api/rooms/" + encodeURIComponent(slug) + "/owner/pepe-room", u, { verb: "join" });
  await withMin("pads.manage_any", "assistant", async () => {
    assert.equal(await rooms.canManage(U.ast, "Ctl.Room"), true, "an Assistant manages the pad now");
    const r2 = await ctlCall(U.ast);
    assert.equal(r2.status, 403, JSON.stringify(r2.d));
    assert.match(r2.d.error, /Prime Time Plus/, "but moves Pepe only like an owner (a Plus pad)");
  });
  assert.equal(SP.can(U.stf, "pads.pepe_ctl_any"), true, "Staff: unchanged");
  const r3 = await ctlCall(U.stf);
  assert.notEqual(r3.status, 403, "Staff: any pad, no Plus needed - " + JSON.stringify(r3.d));
});

test("1.99acw: direct pictures / live pages on Pepe's stream are locked at Staff (exposure) - never lowered, whatever moves onair.operate", async () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8"));
  assert.ok(en["siteperm.lock.exposure"], "the lock reason has a label");
  for (const k of ["onair.live_page", "onair.direct_media"]) {
    assert.equal(SP.BY_KEY[k].locked, "exposure", k);
    for (const v of ["assistant", "admin"]) {
      await assert.rejects(SP.setMin(await owner(), k, v), (e) => e.code === "locked", k + " -> " + v);
      const r = await site(U.own, k, v);
      assert.equal(r.status, 403, k);
      assert.equal(r.d.code, "locked", k);
    }
    assert.equal(SP.minClass(k), "staff", k + " unchanged");
    assert.equal(SP.can(U.stf, k), true, "Staff hold " + k);
    assert.equal(SP.can(U.own, k), true, "Admins too");
    assert.equal(SP.can(U.ast, k), false, "never an Assistant");
  }
  // onair.operate lowered to Assistants: they reach the on-air panel, but the two locked ones don't follow
  await withMin("onair.operate", "assistant", async () => {
    assert.equal(SP.can(U.ast, "onair.operate"), true);
    assert.equal(SP.can(U.ast, "onair.live_page"), false);
    assert.equal(SP.can(U.ast, "onair.direct_media"), false);
  });
});
