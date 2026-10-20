// Offline tests for 1.99vz: the /settings hub (settingshub.js, views/settingsHub.ejs).
//   - signed out -> /login?next=%2Fsettings; signed in -> 200 with every section, rows and cheap states
//   - every row's link resolves: its path matches a GET route the site registers (scanned from the source, matched with
//     Express's own path-to-regexp), and a #fragment names an id that a view really has - no 404s, no dead anchors
//   - the old addresses keep working (/settings/subscriptions 301s, /settings/likeness etc. still registered)
//   - each settings sub-page links back "← Settings"; the ☰ / More "You" section has Settings (signed in only)
//   NODE_PATH=G:/PATV/node_modules node --test test/settingshub.test.js
//   SETTINGS_SHOTS=<dir> also writes the rendered hub there (for screenshots)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "settingshub-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";

const express = require("express");
const ejs = require("ejs");
const pathToRegexp = require(require.resolve("path-to-regexp", { paths: [path.dirname(require.resolve("express"))] }));
const { runQuery } = require(path.join(repo, "dbUtils"));
const HUB = require(path.join(repo, "settingshub"));
const L = require(path.join(repo, "likeness"));
const EN = require(path.join(repo, "locales", "en.json"));

const users = new Map();
let base, server;
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', 'pleb', ?, ?)",
                 [id, name, name, o.bal == null ? 123456 : o.bal, o.camfrog || null]);
  const u = { userId: id, username: name, class: "pleb" };
  users.set(id, u);
  return u;
}
const U = {};
async function get(url, u) {
  const r = await fetch(base + url, { headers: u ? { "x-test-user": u.userId } : {}, redirect: "manual" });
  return { status: r.status, loc: r.headers.get("location"), text: await r.text() };
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT,
                  twitchId TEXT, discordId TEXT, email TEXT, avatar TEXT, password_set INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL)");
  await L.init();
  U.fan = await mkUser("fan", { camfrog: "FanCF" });
  U.plain = await mkUser("plain", { bal: 0 });
  await L.setPrefs(U.fan.userId, { [L.KINDS[0]]: false });
  const app = express();
  app.use((req, res, next) => { const h = req.get("x-test-user"); req.user = h ? users.get(h) || null : null; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.locals.myPads = (u) => (u === "fan" ? [{ slug: "fanpad", title: "Fan <Pad>", href: "/p/fanpad/owner" }] : []);
  app.locals.creatorNav = () => ({ on: true, creator: false });
  app.locals.supportOn = () => true;
  HUB.register(app, { addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

// ── every GET route the site registers, from the source (index.js + every module), as Express would match them ──
function siteRoutes() {
  const out = [];
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "test", "public", "views", "locales", "docs", "uploads", ".git", "data"].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else if (f.name.endsWith(".js")) files.push(p);
    }
  };
  walk(repo);
  const lit = /"((?:\/[^"]*)?)"|'((?:\/[^']*)?)'/g;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\b(?:app|router)\.(?:get|all)\(\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/g)) {
      for (const s of m[1].matchAll(lit)) { const r = s[1] || s[2]; if (r && r.startsWith("/")) out.push(r); }
    }
  }
  return out;
}
const ROUTES = siteRoutes().map((r) => ({ r, re: pathToRegexp(r, [], { end: true, strict: false, sensitive: false }) }));
const routed = (p) => ROUTES.some((x) => x.re.test(p));
const viewIds = (() => {
  const ids = new Set();
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.ejs$/.test(f.name)) for (const m of fs.readFileSync(p, "utf8").matchAll(/\bid="([A-Za-z][\w-]*)"/g)) ids.add(m[1]); } };
  walk(path.join(repo, "views"));
  return ids;
})();
const rows = (html) => [...html.matchAll(/<li data-entry="([^"]+)">\s*<a class="sh-row" href="([^"]+)"/g)].map((m) => ({ id: m[1], href: m[2].replace(/&amp;/g, "&").replace(/&#34;/g, '"') }));

test("signed out: /settings sends you to sign in and back", async () => {
  const r = await get("/settings");
  assert.equal(r.status, 302);
  assert.equal(r.loc, "/login?next=%2Fsettings");
});

test("signed in: every section, a row per page with title + description, and the cheap states", async () => {
  const r = await get("/settings", U.fan);
  assert.equal(r.status, 200);
  if (process.env.SETTINGS_SHOTS) fs.writeFileSync(path.join(process.env.SETTINGS_SHOTS, "settings-hub.html"), r.text);
  assert.match(r.text, /<title>Settings/);
  assert.match(r.text, /<h1 class="ds-h1">Settings<\/h1>/);
  for (const s of HUB.SECTIONS) {
    assert.match(r.text, new RegExp('<section class="ds-card lg sh-sec" id="' + s + '"'), s);
    assert.match(r.text, new RegExp('<a class="ds-tab" href="#' + s + '">' + EN["sethub.sec." + s].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "</a>"), "jump to " + s);
  }
  for (const k of ["account", "password", "chatsignin", "connections", "camfrog", "profile", "feed", "cosmetics", "stickers",
                   "messages", "mentions", "telegram", "likeness", "voice", "clone", "policy", "wallet", "subscriptions", "premium", "creators",
                   "support", "newpad", "ownerguide", "language", "timezone"]) {
    assert.match(r.text, new RegExp('data-entry="' + k + '"'), k + " row");
    assert.ok(r.text.includes(EN["sethub.e." + k]), k + " title");
  }
  assert.doesNotMatch(r.text, /sethub\./, "no untranslated keys");
  // states
  const n = L.KINDS.length;
  assert.match(r.text, new RegExp('data-entry="likeness">[^]*?data-state>' + (n - 1) + " of " + n + " on<"), "likeness count");
  assert.match(r.text, /data-entry="camfrog">[^]*?data-state>FanCF</);
  assert.match(r.text, /data-entry="telegram">[^]*?data-state>Not linked</);
  assert.match(r.text, /data-entry="wallet">[^]*?class="ds-tag gold" data-state>123,456 PAT</);
  assert.match(r.text, /data-entry="messages">[^]*?data-state>From everyone</);
  assert.match(r.text, /data-entry="account">[^]*?data-state>@fan</);
  // the pad name is escaped; its row goes to the owner panel
  assert.match(r.text, /data-entry="pad:fanpad">\s*<a class="sh-row" href="\/p\/fanpad\/owner">[^]*?<b>Fan &lt;Pad&gt;<\/b>/);
  // PAT is points: the section is "Wallet & subscriptions", never money
  assert.doesNotMatch(r.text, /money/i);
});

test("a member with no pads still gets Create a pad; creator links follow the flag", async () => {
  const r = await get("/settings", U.plain);
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /data-entry="pad:/);
  assert.match(r.text, /data-entry="newpad"/);
  assert.match(r.text, /data-entry="wallet">[^]*?data-state>0 PAT</);
});

test("every link on the hub resolves to a registered page, and every #fragment is a real id", async () => {
  assert.ok(routed("/settings"), "the hub itself is registered");
  for (const u of [U.fan, U.plain]) {
    const r = await get("/settings", u);
    const list = rows(r.text);
    assert.ok(list.length >= 25, "rows found: " + list.length);
    for (const { id, href } of list) {
      assert.ok(href.startsWith("/"), id + ": site-relative " + href);
      const [pathq, frag] = href.split("#");
      const p = decodeURIComponent(pathq.split("?")[0]);
      if (id.startsWith("pad:")) { assert.match(p, /^\/p\/[^/]+\/owner$/); assert.ok(routed("/p/x/owner")); continue; }
      assert.ok(routed(p), id + ": no GET route for " + p);
      if (frag) assert.ok(viewIds.has(frag), id + ": no element id=\"" + frag + "\" in any view (" + href + ")");
    }
    // the jump links
    for (const m of r.text.matchAll(/<a class="ds-tab" href="#([^"]+)"/g)) assert.match(r.text, new RegExp('id="' + m[1] + '"'));
  }
});

test("old addresses keep working", () => {
  for (const p of ["/settings/likeness", "/settings/mentions", "/settings/telegram", "/settings/subscriptions", "/subscriptions", "/language", "/u/x/edit", "/u/x/profile/edit", "/settings/account"]) {
    assert.ok(routed(p), p);
  }
  assert.match(fs.readFileSync(path.join(repo, "subscriptions.js"), "utf8"), /app\.get\("\/settings\/subscriptions"[^]*?redirect\(301, "\/subscriptions"/);
});

// ── one home per setting: Edit profile = how others see you; Settings -> Account = the account side ──
const view = (v) => fs.readFileSync(path.join(repo, "views", v + ".ejs"), "utf8");
const ACCOUNT_IDS = ["usernameForm", "emailForm", "connections", "camfrogDiv", "plexDiv", "googleDiv", "appleDiv", "telegramDiv", "cryptoDiv", "passwordForm", "security", "csToggle", "timezone", "tzSelect"];
const PROFILE_IDS = ["displaynameForm", "avatar", "uploadForm", "layout", "layoutForm"];

test("each setting has exactly one home: no control lives on both Edit profile and Settings -> Account", () => {
  const ed = view("editProfile"), ac = view("settingsAccount");
  for (const id of ACCOUNT_IDS) {
    assert.match(ac, new RegExp('id="' + id + '"'), "Settings -> Account has " + id);
    assert.doesNotMatch(ed, new RegExp('id="' + id + '"'), "Edit profile no longer has " + id);
  }
  for (const id of PROFILE_IDS) {
    assert.match(ed, new RegExp('id="' + id + '"'), "Edit profile has " + id);
    assert.doesNotMatch(ac, new RegExp('id="' + id + '"'), "Settings -> Account has no " + id);
  }
  // language has one home: /language (no picker on either page); likeness / voice only on their own pages
  for (const v of [ed, ac]) {
    assert.doesNotMatch(v, /id="langSelect"|\/api\/settings\/language/);
    assert.doesNotMatch(v, /id="privacy"/);
  }
  // the hub only links: no form controls of its own
  assert.doesNotMatch(view("settingsHub"), /<form|<input|<select/);
  // Edit profile points to Settings for the rest, and forwards the moved #fragments there
  assert.match(ed, /id="elsewhere"[^]*?href="\/settings\/account"/);
  assert.match(ed, /\^\(connections\|password\|security\|timezone\|camfrogDiv\|plexDiv\|googleDiv\|appleDiv\|telegramDiv\|cryptoDiv\)\$[^]*?'\/settings\/account#' \+ h/);
  // the profile's ⋯ menu: one Settings item instead of the settings shortcuts
  const pf = view("profile");
  assert.match(pf, /<a role="menuitem" href="\/settings">/);
  for (const h of ["/subscriptions", "/voices/mine", "/voices/clone", "/settings/likeness"]) assert.ok(!pf.includes('<a role="menuitem" href="' + h + '"'), "menu: no " + h);
});

test("the account forms and link flows come back to Settings -> Account", () => {
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8").replace(/\r\n/g, "\n");
  const uc = src("user.controller.js");
  assert.match(uc, /const ACCOUNT_PAGE = '\/settings\/account';/);
  for (const fn of ["updateUsername", "updateEmail", "updatePassword", "updateCamfrogUsername", "updateTwitchId", "updateDiscordId"]) {
    const body = uc.slice(uc.indexOf("async function " + fn + "("), uc.indexOf("\n};\n", uc.indexOf("async function " + fn + "(")));
    assert.ok(body.length > 0, fn);
    assert.doesNotMatch(body, /\/edit/, fn + " no longer goes back to Edit profile");
    assert.match(body, /ACCOUNT_PAGE/, fn);
  }
  // display name is presentation: it stays on Edit profile
  const dn = uc.slice(uc.indexOf("async function updateDisplayname("), uc.indexOf("async function updateEmail("));
  assert.match(dn, /\/edit`\)/);
  for (const f of ["googlesso.js", "plexsso.js", "ssolinks.js", "telegramsso.js", "plexmembers.js", "chatsignin.js"]) {
    assert.doesNotMatch(src(f), /\/edit#connections|\/edit#security|\/edit\?plex=/, f);
  }
  const idx = src("index.js");
  assert.match(idx, /app\.get\("\/settings\/account", addUser/);
  assert.match(idx, /req\.query\.plex[^\n]*\) return res\.redirect\("\/settings\/account\?plex="/);
});

test("Settings -> Account and Edit profile render (fake member)", async () => {
  const base_ = { username: "fan", displayname: "Fan", email: "f@example.test", camfrogUsername: "FanCF", twitchDisplayname: null, discordUsername: null,
                  errors: [], success: [], plex: null, plexLink: false, telegram: { linked: false, handle: null, signin: false }, google: null, cryptoW: null, plexPin: null };
  const ac = await ejs.renderFile(path.join(repo, "views", "settingsAccount.ejs"), Object.assign({ user: "fan" }, base_));
  assert.match(ac, /<h1 class="ds-h1">Account &amp; sign-in<\/h1>/);
  assert.match(ac, /<a class="ds-back" href="\/settings">← Settings<\/a>/);
  assert.match(ac, /action="\/api\/u\/fan\/update\/username"/);
  assert.match(ac, /action="\/api\/u\/fan\/update\/password"/);
  assert.match(ac, /id="csToggle"/);
  const ac2 = await ejs.renderFile(path.join(repo, "views", "settingsAccount.ejs"), Object.assign({ user: "fan" }, base_, { success: ["Verify ownership of \"FanCF\" to complete the link. !verify ab12"] }));
  assert.match(ac2, /class="verify-code">ab12</);
  const ed = await ejs.renderFile(path.join(repo, "views", "editProfile.ejs"), { username: "fan", displayname: "Fan", camfrogUsername: "FanCF", avatar: "", level: 3, classh: "pleb",
    profileCosmetics: null, layout: null, sections: [], subSections: {}, privPanels: [], errors: [], success: [] });
  assert.match(ed, /id="displaynameForm"/);
  assert.match(ed, /id="elsewhere"/);
  if (process.env.SETTINGS_SHOTS) { fs.writeFileSync(path.join(process.env.SETTINGS_SHOTS, "settings-account.html"), ac); fs.writeFileSync(path.join(process.env.SETTINGS_SHOTS, "edit-profile.html"), ed); }
});

test("each settings sub-page links back to /settings", () => {
  for (const v of ["likeness", "mentions", "telegram", "subscriptions", "editProfile", "language", "settingsAccount"]) {
    const src = fs.readFileSync(path.join(repo, "views", v + ".ejs"), "utf8");
    assert.match(src, /<a class="ds-back" href="\/settings">← <%- t\('(sethub|lk)\.back'\) %><\/a>/, v);
  }
  assert.equal(EN["sethub.back"], "Settings");
});

test("the menus' You section has Settings when signed in, and not signed out", async () => {
  const layout = path.join(repo, "views", "layout.ejs");
  const hrefs = (html) => [...html.matchAll(/<a href="([^"]*)" class="nav-link/g)].map((m) => m[1]);
  const signed = await ejs.renderFile(layout, { title: "T", ogPath: "/settings", user: "fan" });
  const out = await ejs.renderFile(layout, { title: "T", ogPath: "/settings" });
  assert.ok(hrefs(signed).includes("/settings"));
  assert.ok(!hrefs(out).includes("/settings"));
  assert.equal(EN["nav.settings"], "Settings");
});

test("/messages?settings=1 opens the Messages settings dialog (the hub's Messages row)", () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "messages.js"), "utf8");
  assert.match(js, /\[\?&\]settings=1\(&\|\$\)\/\.test\(location\.search\)\) \{[^]*?openDlg\(setDlg\)/);
});
