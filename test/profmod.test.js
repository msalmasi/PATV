// profmod (owner 2026-11-05: "Add admin moderation options to users menu from profile"): the profile's ⋯ More "Admin" group.
//   - who sees it (profilemod.forProfile): a signed-in viewer whose class holds an item's own capability (SP keys - an /admin/roles
//     override that lowers a key to Assistants shows that item to Assistants, nothing else); never on your own profile, a preview, Pepe /
//     a Bot account, or PATV staff of your rank or above (padbans.rankRefusal's rule); the viewer's class read fresh
//   - what it says: only what the same capability shows in /admin (an active site ban, a stage ban, creator status, global bridge
//     restrictions, an uploaded cover, open reports) - never a veil (incognito) ban
//   - the view: the items per role, the status lines, the scripts (the ⛔ ban sheet v4, profile-mod.js v1, the sheet look), Comp moves in
//   - the server re-checks: every item calls its EXISTING route, which refuses a viewer without the capability (and the site ban the
//     same rank / yourself); a site ban made from the profile pad is the same feed_bans row '' + audit as /feed/admin's; the ban preview
//     tells a staff viewer the site ban in force (the Lift sheet)
//   - the sheets: in-page (PATVSheet), never confirm(), textContent only; the ban sheet offers only the whole site on the profile
//   - review fixes: the app is built as index.js builds it (roomsweb's routes before padbans', forms parsed); 🎬 by account id + a typed
//     name's exact spelling first; the stage admin writes only as a same-site JSON request; no group on an archived account or your own
//     alt; the page is Cache-Control private when it carries the group; the sheets run in a small DOM - the bridge sheet adds only what
//     was ticked, a site ban in force is named and carried over, "already so" answers refresh, focus never lands on the page body
//   TZ=UTC node --test test/profmod.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "profmod-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PM = require(path.join(repo, "profilemod"));
const PB = require(path.join(repo, "padbans"));
const BB = require(path.join(repo, "bridgeblocks"));
const core = require(path.join(repo, "siteperms-core"));
const layout = require(path.join(repo, "profilelayout"));
require(path.join(repo, "terms"))._setRequired(false);

const U = {};
let base, server;
const SRC = (f) => fs.readFileSync(path.join(repo, f), "utf8");

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, discordUsername TEXT, twitchDisplayname TEXT,
                  level INTEGER DEFAULT 0, avatar TEXT, created_at TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER, xp INTEGER DEFAULT 0, email TEXT)`);
  const mk = async (key, id, name, cls = "pleb", cf = null) => {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?, 1000)", [id, name, name, cf, cls]);
    U[key] = { userId: id, username: name, class: cls, camfrogUsername: cf };
  };
  await mk("admin", "adm-0001", "adminone", "Admin");
  await mk("admin2", "adm-0002", "admintwo", "Admin");
  await mk("staff", "stf-0001", "staffer", "Staff", "staffcf");
  await mk("staff2", "stf-0002", "stafftwo", "Staff");
  await mk("asst", "ast-0001", "helper", "Assistant");
  await mk("plain", "pln-0001", "plainjoe");
  await mk("target", "tgt-0001", "target", "pleb", "targetcf");
  await mk("pepe", "pepe-bot", "Pepe", "Bot");
  // review fixes: a legacy pair of usernames that differ only in case (personref.js) - the OLDER row is an Admin; a deleted / merged
  // (archived) account; the Staff member's own alt (the same Camfrog login, another spelling)
  await mk("caseyAdmin", "csy-0002", "casey", "Admin");
  await mk("casey", "csy-0001", "Casey", "pleb");
  await mk("gone", "gon-0001", "goneuser", "pleb", "gonecf");
  await runQuery("UPDATE users SET archived_at = ? WHERE userId = 'gon-0001'", [Date.now() - 86400e3]);
  await mk("alt", "alt-0001", "stafferalt", "pleb", "StaffCF");
  await rooms.init();
  await BB.init(); await PB.init();
  await require(path.join(repo, "feedstore")).init();
  await require(path.join(repo, "mainstage")).init();
  await require(path.join(repo, "stagecover")).init();
  await require(path.join(repo, "creators")).init();
  await require(path.join(repo, "sessions")).init();
  const app = express();
  // (as index.js builds it: JSON + form bodies parsed globally, roomsweb.js's routes BEFORE bridge.js's padbans routes - they share
  // /api/rooms/:slug/ban|unban; review fix: the kit and this app had padbans alone, so a profile ban answered by roomsweb went unseen)
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? U[u] || null : null; next(); };
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: () => false });
  PB.register(app, { addUser });
  BB.register(app, { addUser, isBotToken: () => false });
  require(path.join(repo, "mainstage")).register(app, { addUser, isBotToken: () => false, noTimers: true });
  require(path.join(repo, "stagecover")).register(app, { addUser, noTimers: true });
  require(path.join(repo, "creatorsweb")).register(app, { addUser, isBotToken: () => false });
  require(path.join(repo, "sessions")).register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
test.beforeEach(() => PB._reset());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base, referer: base + "/u/target" }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) }));
const get = (p, u) => fetch(base + p, { headers: H(u) }).then(async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) }));
const items = (m) => (m ? Object.keys(m.may).filter((k) => m.may[k] && k !== "nets").sort() : null);

// ── who sees the group ──
test("forProfile: nobody without a capability; never yourself, a preview, Pepe / a Bot, or staff of your rank or above", async () => {
  const T = U.target;
  assert.equal(await PM.forProfile(null, T), null, "signed out");
  assert.equal(await PM.forProfile(U.plain, T), null, "a member");
  assert.equal(await PM.forProfile(U.asst, T), null, "Assistants hold none of these keys by default");
  assert.equal(await PM.forProfile(U.admin, U.admin), null, "your own profile");
  assert.equal(await PM.forProfile(U.admin, T, { preview: true }), null, "a visitor preview");
  assert.equal(await PM.forProfile(U.admin, U.pepe), null, "Pepe");
  // the rank rule (padbans.rankRefusal): a staff target only by a higher class
  assert.equal(await PM.forProfile(U.staff, U.staff2), null, "Staff on Staff");
  assert.equal(await PM.forProfile(U.staff, U.admin), null, "Staff on an Admin");
  assert.equal(await PM.forProfile(U.admin, U.admin2), null, "Admin on an Admin");
  assert.ok(await PM.forProfile(U.admin, U.staff), "an Admin on Staff");
  // (the viewer's class is read fresh - a stale session that still says Admin gets nothing once demoted)
  assert.equal(await PM.forProfile(Object.assign({}, U.plain, { class: "Admin" }), T), null, "a stale class claim");
  // defaults: Staff = site ban, stage, reports (feed.admin_page); Admin = all of them
  assert.deepEqual(items(await PM.forProfile(U.staff, T)), ["reports", "siteban", "stage"]);
  assert.deepEqual(items(await PM.forProfile(U.admin, T)), ["account", "bridge", "comp", "details", "reports", "signout", "siteban", "stage"]);
  // an /admin/roles override that lowers a key to Assistants shows that item - per key, never by class name
  const lowered = (u, k) => core.check({ "feed.moderate": "assistant", "feed.admin_page": "assistant" }, u, k);
  assert.deepEqual(items(await PM.forProfile(U.asst, T, { can: lowered })), ["reports", "siteban"]);
  assert.equal(await PM.forProfile(U.asst, U.staff, { can: lowered }), null, "...still never on someone above them");
  const m = await PM.forProfile(U.staff, T);
  assert.equal(m.slug, (await rooms.ensureProfile(T.userId)).slug, "the site ban goes through their profile pad");
  assert.deepEqual(m.ref, { k: "acct", v: "u:tgt-0001" }, "by account id (a rename can't retarget it)");
});

test("forProfile: the status it reports is the capability holder's own /admin view - never a veil (incognito) ban", async () => {
  const T = U.target, now = Date.now();
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, '', ?, 'spam', 'staffer', ?, ?)", [T.userId, T.username, now, now + 86400e3]);
  await runQuery("INSERT INTO stage_bans (userId, username, reason, by, at) VALUES (?, ?, 'loud', 'staffer', ?)", [T.userId, T.username, now]);
  await runQuery("INSERT INTO creators (user_id, status, rating, created, updated) VALUES (?, 'paused', 'sfw', ?, ?)", [T.userId, now, now]);
  await runQuery("INSERT INTO stage_covers (user_id, upload) VALUES (?, 'abc.webp')", [T.userId]).catch(async () => {
    await require(path.join(repo, "stagecover")).init();
    await runQuery("INSERT INTO stage_covers (user_id, upload) VALUES (?, 'abc.webp')", [T.userId]);
  });
  await BB.block({ roomId: "", target: { userId: T.userId, username: T.username }, feature: "voice", until: now + 3600e3, reason: "spam", by: { userId: U.admin.userId, name: "adminone", via: "admin" } });
  await runQuery("INSERT INTO user_reports (target_id, reporter_id, reason, note, created) VALUES (?, ?, 'spam', '', ?)", [T.userId, U.plain.userId, now]);
  await runQuery("INSERT INTO veil_bans (room_id, scope, user_id, login, label, until, reason, by_id, by_name, created) VALUES ('', 'site', ?, 'targetcf', 'Soggy Bullfrog', NULL, 'frog', ?, 'adminone', ?)",
    [T.userId, U.admin.userId, now]);
  try {
  const A = await PM.forProfile(U.admin, T);
  assert.equal(A.siteBan.reason, "spam"); assert.equal(A.siteBan.by, "staffer"); assert.ok(A.siteBan.until > now);
  assert.equal(A.stageBan.reason, "loud");
  assert.deepEqual(A.creator, { status: "paused" });
  assert.equal(A.cover, true);
  assert.deepEqual(A.bridge.features, ["voice"]);
  assert.equal(A.reports, 1);
  assert.deepEqual(items(A), ["account", "bridge", "comp", "cover", "creator", "details", "reports", "signout", "siteban", "stage"]);
  assert.doesNotMatch(JSON.stringify(A), /Soggy|frog|veil/i, "an incognito ban never shows on the named profile");
  // Staff: only what their keys show (no bridge / cover / details / sign-out), but the creator status (creators.admin is Staff)
  const S = await PM.forProfile(U.staff, T);
  assert.deepEqual(items(S), ["creator", "reports", "siteban", "stage"]);
  assert.equal(S.bridge, null); assert.equal(S.cover, false);
  } finally {
    // clean up for the next tests
    for (const q of ["DELETE FROM feed_bans", "DELETE FROM stage_bans", "DELETE FROM creators", "DELETE FROM stage_covers", "DELETE FROM bridge_blocks", "DELETE FROM user_reports", "DELETE FROM veil_bans"]) await runQuery(q);
  }
});

// ── the view ──
async function render(viewer, profileMod, extra = {}) {
  const L = layout.view({ order: layout.SECTION_IDS, hidden: [], priv: [] }, { owner: viewer && viewer.username === "target" });
  return ejs.renderFile(path.join(repo, "views", "profile.ejs"), {
    username: viewer ? viewer.username : null, usernameProfile: "target", displayname: "Target", classh: "pleb", level: 3, xp: 10, avatar: "/public/img/avatar.png",
    points_balance: 10, badges: [], xpForNextLevel: (lv) => 1000 * (lv + 1), canSeeHistory: false, heistSheet: null, gtf: { heistHelp: "/gtf", turfGuide: "/gtf", turfMap: "/gtf", gangs: "/gtf" },
    camfrog: "targetcf", gtfAvatar: { svg: null, items: [] }, analytics: null, layout: L, profileLayoutMod: layout, profileTab: "", profileVault: null, vaultView: false,
    social: null, previewVisitor: false, avatarActs: [], avatarMsg: "", tipJarNew: 0, ogBase: "http://test", ogPath: "/u/target",
    profileBlock: viewer ? { blocked: false } : null, viewerIsAdmin: !!(viewer && core.check(null, viewer, "comps.manage")), profileMod, ...extra,
  });
}
const menuOf = (html) => html.slice(html.indexOf('class="pf-menu"'), html.indexOf("</details>", html.indexOf('class="pf-menu"')));
const acts = (html) => [...menuOf(html).matchAll(/data-pfmod="(\w+)"/g)].map((m) => m[1]);

test("the view: an Admin group per role - the items its keys allow, status lines, the sheets' scripts; nothing for a member", async () => {
  const T = U.target, now = Date.now();
  // a member: no group, no moderation scripts
  const plain = await render(U.plain, await PM.forProfile(U.plain, T));
  assert.doesNotMatch(menuOf(plain), /pf-mod-gh|data-pfmod|data-safety="details"/);
  assert.doesNotMatch(plain, /profile-mod\.js|pad-ban-sheet\.js|feed-safety\.js/);
  assert.match(plain, /person-sheet\.css\?v=4/, "the 🚫 Block sheet as before");
  // Staff: ⛔ site ban + 🎬 stage, no admin-only items
  const sm = await PM.forProfile(U.staff, T);
  const st = await render(U.staff, sm);
  assert.deepEqual(acts(st), ["siteban", "stage"]);
  assert.match(menuOf(st), /class="pm-pop-gh pf-mod-gh" role="presentation" data-pfmod-cfg="[^"]+">Admin<\/div>/);
  assert.match(menuOf(st), /<button type="button" role="menuitem" class="pf-danger" data-pfmod="siteban">⛔ Site ban…<\/button>/);
  assert.doesNotMatch(menuOf(st), /data-safety="details"|\/admin\/accounts|\/admin\/comps|data-pfmod="(bridge|signout|cover)"/);
  assert.match(st, /<script src="\/public\/js\/pad-ban-sheet\.js\?v=4" defer><\/script><script src="\/public\/js\/profile-mod\.js\?v=1" defer><\/script>/);
  assert.match(st, /<link rel="stylesheet" href="\/public\/css\/person-sheet\.css\?v=4"><script src="\/public\/js\/block-sheet\.js\?v=3" defer>/);
  const cfg = JSON.parse(menuOf(st).match(/data-pfmod-cfg="([^"]+)"/)[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  assert.deepEqual(Object.keys(cfg).sort(), ["bridge", "creator", "id", "ref", "siteBan", "slug", "stageBan", "u", "who"]);
  assert.equal(cfg.who, "PATV account @target · Camfrog login targetcf");
  assert.equal(cfg.slug, sm.slug);
  // Admin, with things in force: status lines, Lift / unstage instead of a second stage ban, 🔍 details (feed-safety.js - no social block
  // on this page, so the group loads it; with one, the Report item already does - never twice), Open in Admin + Comp in the group
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, '', ?, '<b>spam</b>', 'staffer', ?, NULL)", [T.userId, T.username, now]);
  await runQuery("INSERT INTO stage_bans (userId, username, reason, by, at) VALUES (?, ?, 'loud', 'staffer', ?)", [T.userId, T.username, now]);
  await runQuery("INSERT INTO user_reports (target_id, reporter_id, reason, note, created) VALUES (?, ?, 'spam', '', ?)", [T.userId, U.plain.userId, now]);
  try {
  const am = await PM.forProfile(U.admin, T);
  const ad = await render(U.admin, am);
  assert.deepEqual(acts(ad), ["siteban", "lift", "bridge", "unstage", "signout"]);
  const menu = menuOf(ad);
  // what's in force: the second line of the item that changes it (a reason escaped)
  assert.match(menu, /class="pf-mod-2" data-pfmod="lift">↩️ Lift site ban…<small class="pf-mod-sub">until lifted · &lt;b&gt;spam&lt;\/b&gt;<\/small><\/button>/);
  assert.match(menu, /class="pf-mod-2" data-pfmod="unstage">↩️ Lift stage ban…<small class="pf-mod-sub">loud<\/small><\/button>/);
  assert.match(menu, /<button type="button" role="menuitem" data-pfmod="bridge">🌐 Web bridge, every room…<\/button>/, "nothing in force: one line");
  assert.match(menu, /data-safety="details" data-user-id="tgt-0001">🔍 Abuse details/);
  // review fixes: a site ban in force -> "Change site ban…" (a new one replaces it - the sheet says so); Open reports goes to THIS
  // person's reports on /feed/admin (their group's anchor), not the top of the list
  assert.match(menu, /class="pf-danger" data-pfmod="siteban">⛔ Change site ban…<\/button>/);
  assert.match(menu, /href="\/feed\/admin#rep-u-tgt-0001">⚑ Open reports<span class="pf-mod-n">1<\/span>/);
  assert.match(SRC("views/feedAdmin.ejs"), /<div class="fa-rep fa-tgt<%= g\.urgent \? ' urgent' : '' %>" id="rep-u-<%= g\.userId %>" data-uid=/);
  assert.match(menu, /href="\/admin\/accounts\?u=target">🗂️ Open in Admin/);
  assert.equal((menu.match(/\/admin\/comps\?user=target/g) || []).length, 1, "Comp once - inside the group");
  assert.ok(menu.indexOf("/admin/comps") > menu.indexOf("pf-mod-gh"));
  assert.match(ad, /<script src="\/public\/js\/feed-safety\.js\?v=4" defer><\/script>/);
  const soc = await require(path.join(repo, "feedweb")).profileSocial({ userId: T.userId, username: "target" }, U.admin, { show: true, query: {}, host: "test" });
  const withSoc = await render(U.admin, am, { social: soc });
  assert.equal((withSoc.match(/feed-safety\.js/g) || []).length, 1, "the Report item's copy only");
  // with the group the menu is a little wider (the second lines), never wider than a phone
  assert.match(ad, /\.pf \.pf-more:has\(\.pf-mod-gh\) \.pf-menu \{ min-width: 256px; max-width: min\(320px, calc\(100vw - 32px\)\); \}/);
  // phones (<= 520px): it hangs from the whole actions row - the right-anchored 220px menu would run off the left edge once wider
  const phone = ad.slice(ad.indexOf("@media (max-width: 520px)"));
  assert.match(phone, /\.pf \.actions:has\(\.pf-mod-gh\) \{ position: relative; \}\s*\.pf \.actions:has\(\.pf-mod-gh\) > \.pf-more \{ position: static; \}\s*\.pf \.pf-more:has\(\.pf-mod-gh\) \.pf-menu \{ inset-inline: 0; min-width: 0; max-width: none; \}/);
  // an Admin on their own profile / on someone of their rank: no group; Comp on your own profile stays where it was
  const self = await render(U.admin, await PM.forProfile(U.admin, U.admin), { usernameProfile: "adminone" });
  assert.doesNotMatch(menuOf(self), /pf-mod-gh|data-pfmod/);
  assert.equal(await PM.forProfile(U.admin, U.admin2), null);
  const peer = await render(U.admin, null);
  assert.doesNotMatch(menuOf(peer), /pf-mod-gh|data-pfmod/);
  assert.doesNotMatch(peer, /profile-mod\.js/);
  assert.match(menuOf(peer), /<hr><a role="menuitem" href="\/admin\/comps\?user=target">🎁 Comp…<\/a>/, "Comp outside a group, as before");
  } finally {
    for (const q of ["DELETE FROM feed_bans", "DELETE FROM stage_bans", "DELETE FROM user_reports"]) await runQuery(q);
  }
});

// ── the server re-checks: the existing routes ──
test("site ban from the profile: the existing ban route on their profile pad - staff only, never yourself or your rank; the same row + audit", async () => {
  const T = U.target, slug = (await rooms.ensureProfile(T.userId)).slug;
  const ref = { k: "acct", v: "u:" + T.userId };
  for (const who of ["plain", "asst"]) {
    const r = await post(`/api/rooms/${slug}/ban`, who, { ref, scope: "site", dur: "1d", reason: "spam" });
    assert.equal(r.status, 403, who + " " + JSON.stringify(r.d));
  }
  // the preview: the site scope among the ones allowed (the sheet keeps only it on a profile)
  let pv = await post(`/api/rooms/${slug}/ban/preview`, "staff", { ref, scope: "site" });
  assert.equal(pv.status, 200); assert.ok(pv.d.scopes.includes("site")); assert.equal(pv.d.current.site, null);
  assert.deepEqual(pv.d.who, { kind: "account", title: "PATV account @target", sub: "Camfrog login targetcf" });
  let r = await post(`/api/rooms/${slug}/ban`, "staff", { ref, scope: "site", dur: "1d", reason: "spam" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const row = (await getQuery("SELECT * FROM feed_bans WHERE user_id = ? AND room_id = ''", [T.userId]))[0];
  assert.ok(row && row.until > Date.now() && row.reason === "spam" && row.by === "staffer", "the site-wide row /feed/admin lists");
  const au = (await getQuery("SELECT * FROM admin_audit WHERE action = 'pad_ban' ORDER BY rowid DESC LIMIT 1"))[0];
  assert.ok(au && /"scope":"site"/.test(au.detail || au.details || JSON.stringify(au)), "audited as before: " + JSON.stringify(au));
  assert.equal((await PM.forProfile(U.staff, T)).siteBan.reason, "spam", "the menu says it after the reload");
  // the Lift sheet: the preview names the site ban in force for staff (never for a pad owner / room mod - w.site only)
  pv = await post(`/api/rooms/${slug}/ban/preview`, "staff", { ref });
  assert.equal(pv.d.current.site.reason, "spam"); assert.equal(pv.d.current.site.by, "staffer");
  r = await post(`/api/rooms/${slug}/unban`, "plain", { ref, scope: "site" });
  assert.equal(r.status, 403);
  r = await post(`/api/rooms/${slug}/unban`, "staff", { ref, scope: "site" });
  assert.equal(r.status, 200);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_bans WHERE user_id = ? AND room_id = ''", [T.userId]))[0].n, 0);
  // rank + self, as the route says them
  const s2 = (await rooms.ensureProfile(U.staff2.userId)).slug;
  r = await post(`/api/rooms/${s2}/ban`, "staff", { ref: { k: "acct", v: "u:" + U.staff2.userId }, scope: "site", dur: "1h", reason: "x" });
  assert.equal(r.status, 403); assert.match(r.d.error, /rank or above/);
  const s1 = (await rooms.ensureProfile(U.staff.userId)).slug;
  r = await post(`/api/rooms/${s1}/ban`, "staff", { ref: { k: "acct", v: "u:" + U.staff.userId }, scope: "site", dur: "1h", reason: "x" });
  assert.equal(r.status, 400); assert.equal(r.d.error, "That's you.");
});

test("the other items' routes refuse a viewer without their capability (and work for one who has it)", async () => {
  const T = U.target;
  // 🌐 web bridge, every room - bridge.blocks_global (Admin)
  assert.equal((await get("/api/admin/bridge/blocks?target=u:" + T.userId, "staff")).status, 403);
  let r = await post("/api/admin/bridge/blocks", "staff", { op: "block", room: "", target: "u:" + T.userId, features: ["voice"], hours: "24", reason: "x" });
  assert.equal(r.status, 403);
  r = await post("/api/admin/bridge/blocks", "admin", { op: "block", room: "", target: "u:" + T.userId, features: ["voice", "chat"], hours: "24", reason: "spam" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual((await get("/api/admin/bridge/blocks?target=u:" + T.userId, "admin")).d.blocks.filter((b) => b.global).map((b) => b.feature).sort(), ["chat", "voice"]);
  r = await post("/api/admin/bridge/blocks", "admin", { op: "unblock", room: "", target: "u:" + T.userId, features: ["chat", "voice"] });
  assert.equal(r.status, 200); assert.equal((await BB.forUser(T.userId)).length, 0);
  // 🎬 stage - stage.admin (Staff)
  assert.equal((await post("/api/stage/admin/ban", "plain", { username: "target", reason: "x" })).status, 403);
  assert.equal((await post("/api/stage/admin/ban", "asst", { username: "target", reason: "x" })).status, 403);
  r = await post("/api/stage/admin/ban", "staff", { username: "target", reason: "loud" });
  assert.equal(r.status, 200); assert.equal((await PM.forProfile(U.staff, T)).stageBan.reason, "loud");
  assert.equal((await post("/api/stage/admin/unban", "plain", { userId: T.userId })).status, 403);
  r = await post("/api/stage/admin/unban", "staff", { userId: T.userId });
  assert.deepEqual(r.d, { ok: true });
  assert.deepEqual((await post("/api/stage/admin/unban", "staff", { userId: T.userId })).d, { ok: false }, "nothing left to lift (the sheet says so)");
  // ⭐ creator status - creators.admin (Staff)
  await runQuery("INSERT INTO creators (user_id, status, rating, created, updated) VALUES (?, 'active', 'sfw', ?, ?)", [T.userId, Date.now(), Date.now()]);
  await require(path.join(repo, "creators")).init();
  assert.equal((await post(`/api/admin/creators/${T.userId}/status`, "plain", { action: "paused", note: "x" })).status, 403);
  r = await post(`/api/admin/creators/${T.userId}/status`, "staff", { action: "paused", note: "check your posts" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal((await getQuery("SELECT status FROM creators WHERE user_id = ?", [T.userId]))[0].status, "paused");
  await runQuery("DELETE FROM creators");
  // 🖼️ stage cover - imagesafety.admin (Admin)
  assert.equal((await post("/api/admin/stage-cover/remove", "staff", { user_id: T.userId })).status, 403);
  r = await post("/api/admin/stage-cover/remove", "admin", { user_id: T.userId });
  assert.equal(r.status, 404, "no cover: the route's own answer");
  // 🔐 sign out everywhere - accounts.sessions_revoke (Admin), the typed username + a reason
  assert.equal((await post(`/api/admin/users/${T.userId}/sessions/revoke`, "staff", { reason: "hacked", confirm: "target" })).status, 403);
  r = await post(`/api/admin/users/${T.userId}/sessions/revoke`, "admin", { reason: "hacked", confirm: "Target" });
  assert.equal(r.status, 400); assert.equal(r.d.code, "E_CONFIRM");
  r = await post(`/api/admin/users/${T.userId}/sessions/revoke`, "admin", { reason: "hacked", confirm: "target" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok((await getQuery("SELECT 1 FROM admin_audit WHERE action = 'sessions.revoke_all'")).length);
});

// ── review fixes: the server side ──
test("review fix (stage ban by account): the profile's 🎬 sends the account id; a typed name prefers its exact spelling - a case-only twin is never banned instead", async () => {
  const rows = async () => (await getQuery("SELECT userId FROM stage_bans ORDER BY userId")).map((r) => r.userId);
  try {
    // the profile: /u/Casey (the member) - the older row "casey" is an Admin; by account id the member is the one banned
    let r = await post("/api/stage/admin/ban", "staff", { userId: U.casey.userId, reason: "loud" });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.equal(r.d.username, "Casey");
    assert.deepEqual(await rows(), ["csy-0001"]);
    await runQuery("DELETE FROM stage_bans");
    // /stage/admin's typed name: the exact spelling wins over the older case-only twin (it was: the first row - the Admin)
    r = await post("/api/stage/admin/ban", "staff", { username: "Casey", reason: "loud" });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.equal(r.d.username, "Casey");
    assert.deepEqual(await rows(), ["csy-0001"]);
    // no such account id: the route's own 404, nothing written
    r = await post("/api/stage/admin/ban", "staff", { userId: "nope-0000", reason: "x" });
    assert.equal(r.status, 404);
    assert.deepEqual(await rows(), ["csy-0001"]);
  } finally { await runQuery("DELETE FROM stage_bans"); }
});

test("review fix (stage admin writes): ban / unban only as a same-site JSON request - a form post or another origin is refused, nothing written", async () => {
  const T = U.target;
  const form = (p, u, body, hdr) => fetch(base + p, { method: "POST", headers: Object.assign({ "content-type": "application/x-www-form-urlencoded", "x-test-user": u }, hdr || {}),
    body: new URLSearchParams(body).toString() }).then(async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) }));
  const n = async () => Number((await getQuery("SELECT COUNT(*) AS n FROM stage_bans WHERE userId = ?", [T.userId]))[0].n);
  try {
    // a form from a same-site host (staging / another *.publicaccess.tv - the Lax cookie still goes) and from this one
    assert.equal((await form("/api/stage/admin/ban", "staff", { username: "target", reason: "x" }, { origin: "https://other.publicaccess.tv" })).status, 403);
    assert.equal((await form("/api/stage/admin/ban", "staff", { username: "target", reason: "x" }, { origin: base })).status, 403);
    assert.equal(await n(), 0, "nothing written");
    // JSON from another origin
    const r = await fetch(base + "/api/stage/admin/ban", { method: "POST", headers: Object.assign(H("staff"), { origin: "https://other.publicaccess.tv", referer: "https://other.publicaccess.tv/" }), body: JSON.stringify({ username: "target", reason: "x" }) });
    assert.equal(r.status, 403);
    assert.equal(await n(), 0, "nothing written");
    // unban the same way
    await runQuery("INSERT INTO stage_bans (userId, username, reason, by, at) VALUES (?, ?, 'loud', 'staffer', ?)", [T.userId, T.username, Date.now()]);
    assert.equal((await form("/api/stage/admin/unban", "staff", { userId: T.userId }, { origin: "https://other.publicaccess.tv" })).status, 403);
    assert.equal(await n(), 1, "still banned");
    // the page's own fetch (same origin, JSON) still works - /stage/admin's post() and the profile's
    assert.deepEqual((await post("/api/stage/admin/unban", "staff", { userId: T.userId })).d, { ok: true });
    assert.match(SRC("public/js/stage-admin.js"), /headers: \{ 'Content-Type': 'application\/json' \}/, "/stage/admin posts JSON (same origin)");
  } finally { await runQuery("DELETE FROM stage_bans"); }
});

test("review fix: no Admin group on a deleted / merged (archived) account or on your own alt (the ban route's self rule - the same Camfrog login)", async () => {
  assert.equal(await PM.forProfile(U.admin, U.gone), null, "archived");
  assert.equal(await PM.forProfile(U.staff, U.alt), null, "the staffer's own alt (StaffCF = staffcf)");
  assert.ok(await PM.forProfile(U.admin, U.alt), "someone else's alt - shown");
  assert.ok(await PM.forProfile(U.staff, U.target), "another login - shown");
  // a target row whose class the caller passed stale: the users row decides (an Admin twin passed as a member gets nothing from Staff)
  assert.equal(await PM.forProfile(U.staff, Object.assign({}, U.caseyAdmin, { class: "pleb" })), null);
  // the profile route: a page that carries staff data is private, never stored by a cache
  const ix = SRC("index.js");
  assert.match(ix, /const profileMod = await require\("\.\/profilemod"\)\.forProfile\(req\.user, user, \{ preview \}\)/);
  assert.match(ix, /if \(profileMod\) res\.set\("Cache-Control", "private, no-store"\);/);
});

// ── the sheets in a small DOM (block-sheet.js's PATVSheet, pad-ban-sheet.js, profile-mod.js - fetch answered here) ──
function sheetDom(answer) {
  const vm = require("vm");
  const doc = { activeElement: null, _on: [] };
  const one = (n, part) => {
    const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)(:checked)?$/i.exec(part);
    if (!m) throw new Error("selector " + part);
    if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
    for (const c of m[2].match(/\.[\w-]+/g) || []) if (!String(n.className).split(/\s+/).includes(c.slice(1))) return false;
    for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
      const q = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a);
      const v = q[1] === "open" ? (n.open ? "" : null) : n.getAttribute(q[1]);
      if (v == null || (q[2] != null && v !== q[2])) return false;
    }
    return !m[4] || !!n.checked;
  };
  class El {
    constructor(tag) { Object.assign(this, { tagName: String(tag).toUpperCase(), children: [], parentNode: null, attrs: {}, className: "", _t: "", on: {}, disabled: false, checked: false,
      value: "", type: "", id: "", open: false, placeholder: "", style: {} }); }
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
    remove() { const p = this.parentNode; if (p) { p.children = p.children.filter((x) => x !== this); this.parentNode = null; } }
    get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this._t = String(v); for (const c of this.children) c.parentNode = null; this.children = []; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.body; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); if (k === "open") this.open = true; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.on[t] = this.on[t] || []).push(f); }
    focus() { doc.activeElement = this; }
    close() { this.open = false; }
    *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
    matches(sel) {
      const parts = sel.trim().split(/\s+/);
      if (!one(this, parts[parts.length - 1])) return false;
      let n = this.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) { while (n && !one(n, parts[i])) n = n.parentNode; if (!n) return false; n = n.parentNode; }
      return true;
    }
    querySelectorAll(sel) { return [...this.walk()].filter((n) => n.matches(sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { for (let n = this; n; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  }
  doc.body = new El("body");
  doc.createElement = (t) => new El(t);
  doc.querySelector = (s) => doc.body.querySelector(s);
  doc.querySelectorAll = (s) => doc.body.querySelectorAll(s);
  doc.addEventListener = (t, f, cap) => doc._on.push({ t, f, cap: !!cap });
  const calls = [], timers = [];
  let reloads = 0;
  const W = { location: { reload: () => { reloads++; } } };
  const fetchFn = (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : null;
    calls.push({ url, method: (o && o.method) || "GET", body, headers: (o && o.headers) || {} });
    const a = answer(url, body) || { status: 200, json: { ok: true } };
    if (a.offline) return Promise.reject(new Error("offline"));
    return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.json) });
  };
  const ctx = vm.createContext({ window: W, document: doc, fetch: fetchFn, setTimeout: (f, ms) => { timers.push(ms); return 0; }, console });
  for (const f of ["block-sheet.js", "pad-ban-sheet.js", "profile-mod.js"]) vm.runInContext(SRC("public/js/" + f), ctx, { filename: f });
  /** a click as the browser runs it: document capture listeners, then the target and its ancestors, then document bubble listeners */
  const click = (n) => {
    const ev = { target: n, type: "click", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const l of doc._on.filter((x) => x.t === "click" && x.cap)) l.f(ev);
    for (let p = n; p; p = p.parentNode) for (const f of (p.on.click || []).slice()) f(ev);
    for (const l of doc._on.filter((x) => x.t === "click" && !x.cap)) l.f(ev);
  };
  const settle = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
  const sheet = () => W.PATVSheet.current();
  const text = (n) => n.textContent;
  return { W, doc, El, calls, timers, reloads: () => reloads, click, settle, sheet, text };
}
const CFG = { u: "target", id: "tgt-0001", ref: { k: "acct", v: "u:tgt-0001" }, slug: "p-target", who: "PATV account @target", siteBan: null, stageBan: null, creator: null, bridge: null };

test("review fix (🌐 web bridge sheet): Save adds only what was newly ticked and lifts what was unticked - the ones already on keep their end and reason", async () => {
  const had = { global: true, feature: "voice", until: Date.now() + 864e5, reason: "ear-rape clips", by: "adminone" };
  const run = async (ticks, { reapply = false } = {}) => {
    const X = sheetDom((url, body) => (url.startsWith("/api/admin/bridge/blocks?") ? { status: 200, json: { ok: true, features: ["all", "chat", "voice"], blocks: [had] } } : { status: 200, json: { ok: true } }));
    X.W.PATVProfileMod._act.bridge(CFG, null);
    await X.settle();
    const S = X.sheet(), boxes = S.body.querySelectorAll("input").filter((i) => i.type === "checkbox" && i.value !== "reapply");
    for (const b of boxes) if (b.value in ticks) { b.checked = ticks[b.value]; for (const f of b.on.change || []) f({ target: b }); }
    const re = S.body.querySelectorAll("input").find((i) => i.value === "reapply");
    if (reapply) { assert.ok(re, "the re-apply box"); re.checked = true; for (const f of re.on.change || []) f({ target: re }); }
    const go = S.body.querySelector(".psh-row").children[0];
    return { X, S, go };
  };
  // tick chat (voice stays on): one block for chat only - voice keeps its own end and reason
  let { X, S, go } = await run({ chat: true });
  assert.equal(go.disabled, false); assert.match(go.className, /danger/);
  X.click(go); await X.settle();
  let w = X.calls.filter((c) => c.method === "POST");
  assert.deepEqual(w.map((c) => [c.body.op, c.body.features]), [["block", ["chat"]]]);
  assert.match(S.body.textContent, /Saved - restricted in every room\./);
  // untick voice only: a lift, no block (it was: voice re-sent... no - chat/voice both re-blocked with the sheet's 1 day and empty reason)
  ({ X, S, go } = await run({ voice: false }));
  assert.match(go.className, /\bgo\b/, "only lifting: the green button");
  X.click(go); await X.settle();
  w = X.calls.filter((c) => c.method === "POST");
  assert.deepEqual(w.map((c) => [c.body.op, c.body.features]), [["unblock", ["voice"]]]);
  assert.match(S.body.textContent, /Lifted in every room\./);
  // nothing changed: nothing to send
  ({ X, S, go } = await run({}));
  assert.equal(go.disabled, true);
  // the re-apply box: the ones already on take this length + reason too (the explicit way to change one)
  ({ X, S, go } = await run({ chat: true }, { reapply: true }));
  X.click(go); await X.settle();
  w = X.calls.filter((c) => c.method === "POST");
  assert.deepEqual(w.map((c) => [c.body.op, c.body.features.slice().sort()]), [["block", ["chat", "voice"]]]);
  // no restriction on yet: no re-apply box
  const Y = sheetDom((url) => (url.startsWith("/api/admin/bridge/blocks?") ? { status: 200, json: { ok: true, features: ["all", "chat"], blocks: [] } } : null));
  Y.W.PATVProfileMod._act.bridge(CFG, null); await Y.settle();
  assert.equal(Y.sheet().body.querySelectorAll("input").find((i) => i.value === "reapply"), undefined);
});

test("review fixes (profile sheets): 🎬 by account id; an answer that's already true is done (reload); a failure keeps focus in the sheet; no fake value in the sign-out box", async () => {
  // 🎬 ban: the account id, never the name
  let X = sheetDom(() => ({ status: 200, json: { ok: true, username: "target" } }));
  X.W.PATVProfileMod._act.stage(CFG, null);
  let S = X.sheet(), go = S.body.querySelector(".psh-row").children[0];
  X.click(go); await X.settle();
  assert.deepEqual(X.calls[0].body, { userId: "tgt-0001", reason: "" });
  assert.equal(X.calls[0].url, "/api/stage/admin/ban");
  // a 🎬 answer naming another account (an older server) is said, never "Banned from the stage."
  X = sheetDom(() => ({ status: 200, json: { ok: true, username: "TARGET" } }));
  X.W.PATVProfileMod._act.stage(CFG, null);
  S = X.sheet(); go = S.body.querySelector(".psh-row").children[0];
  X.click(go); await X.settle();
  assert.doesNotMatch(S.body.textContent, /Banned from the stage\./);
  assert.match(S.body.querySelector(".psh-out").className, /bad/);
  // ↩️ stage ban already lifted elsewhere: said as done, the page reloads (the stale item goes)
  X = sheetDom(() => ({ status: 200, json: { ok: false } }));
  X.W.PATVProfileMod._act.unstage(Object.assign({}, CFG, { stageBan: { reason: "loud", by: "staffer", at: Date.now() } }), null);
  S = X.sheet(); go = S.body.querySelector(".psh-row").children[0];
  X.click(go); await X.settle();
  let out = S.body.querySelector(".psh-out");
  assert.equal(out.textContent, "There's no stage ban on them any more.");
  assert.doesNotMatch(out.className, /bad/); assert.equal(go.disabled, true); assert.ok(X.timers.includes(900), "reload");
  // 🖼️ cover already gone (the route's 404 code 'gone'): the same
  X = sheetDom(() => ({ status: 404, json: { ok: false, error: "That cover is already gone.", code: "gone" } }));
  X.W.PATVProfileMod._act.cover(CFG, null);
  S = X.sheet(); go = S.body.querySelector(".psh-row").children[0];
  X.click(go); await X.settle();
  out = S.body.querySelector(".psh-out");
  assert.equal(out.textContent, "That cover is already gone.");
  assert.doesNotMatch(out.className, /bad/); assert.equal(go.disabled, true); assert.ok(X.timers.includes(900));
  // a real failure (500 / offline): the error in the sheet, the button back AND focused (it was: focus on the page body)
  for (const a of [{ status: 500, json: { ok: false, error: "Something went wrong." } }, { offline: true }]) {
    X = sheetDom(() => a);
    X.W.PATVProfileMod._act.cover(CFG, null);
    S = X.sheet(); go = S.body.querySelector(".psh-row").children[0];
    X.click(go); await X.settle();
    assert.match(S.body.querySelector(".psh-out").className, /bad/);
    assert.equal(go.disabled, false); assert.equal(X.doc.activeElement, go, "focus stays in the sheet");
    assert.ok(!X.timers.includes(900), "no reload");
  }
  // 🔐 the typed-username box starts empty-looking (no placeholder that reads as already typed)
  X = sheetDom(() => null);
  X.W.PATVProfileMod._act.signout(CFG, null);
  const typed = X.sheet().body.querySelectorAll("input")[1];
  assert.equal(typed.placeholder, "");
});

test("review fix (🔍 abuse details): the menu closes before the panel opens and focus goes to ⋯ More - so it comes back there when the panel closes", () => {
  const X = sheetDom(() => null);
  const det = X.doc.createElement("details"); det.open = true; det.className = "pf-more";
  const sum = X.doc.createElement("summary"); det.appendChild(sum);
  const menu = X.doc.createElement("div"); menu.className = "pf-menu"; det.appendChild(menu);
  const b = X.doc.createElement("button"); b.setAttribute("data-safety", "details"); menu.appendChild(b);
  X.doc.body.appendChild(det);
  b.focus();
  // feed-safety.js's own (bubbling) handler opens its modal <dialog>: the browser keeps what had focus then and returns focus to it
  let focusedAtOpen = null;
  X.doc.addEventListener("click", () => { focusedAtOpen = X.doc.activeElement; });
  X.click(b);
  assert.equal(det.open, false, "the menu closed");
  assert.equal(focusedAtOpen, sum, "⋯ More had focus when the panel opened (it was: the hidden menu item -> the page body)");
});

test("review fixes (⛔ ban sheet on a profile): a site ban in force is named and its length + reason carried over (a new ban replaces it); site-wide titles; a gone ban refreshes", async () => {
  const pv = (cur) => ({ ok: true, who: { kind: "account", title: "PATV account @target", sub: "Camfrog login targetcf" }, scopes: ["bridge", "pad", "site"], veil: false, nets: null, room: false,
    refusal: { bridge: "x.", pad: "y.", site: "You're banned from PATV until 2026-11-06 14:00 UTC." }, current: { pad: null, bridge: null, site: cur } });
  const open = async (cur, o = {}) => {
    const X = sheetDom((url) => (url.endsWith("/ban/preview") ? { status: 200, json: pv(cur) } : { status: 200, json: { ok: true } }));
    let done = 0;
    X.W.PATVBanSheet.open(Object.assign({ ref: CFG.ref, slug: CFG.slug, scope: "site", only: ["site"], name: "@target", onDone: () => { done++; } }, o));
    const title0 = X.sheet().h.textContent;
    await X.settle();
    return { X, S: X.sheet(), title0, done: () => done };
  };
  const radios = (S, name) => S.body.querySelectorAll("input").filter((i) => i.type === "radio" && i.name === S.id + name);
  // permanent, with a reason: named, Permanent picked, the reason carried over - Ban sends the same (it was: 1 day, no reason)
  let { X, S, title0 } = await open({ until: null, reason: "spam links", by: "staffer" });
  assert.equal(title0, "⛔ Site-wide ban", "the profile's sheet title while it checks (it was: ⛔ Website ban)");
  assert.match(S.body.textContent, /Already banned site-wide - until lifted · spam links · by staffer\. Banning again replaces it/);
  assert.equal(radios(S, "U").find((r) => r.checked).value, "perm");
  assert.equal(S.body.querySelectorAll("input").find((i) => i.type === "text").value, "spam links");
  X.click(S.body.querySelector(".psh-row").children[0]); await X.settle();
  const sent = X.calls.find((c) => c.url.endsWith("/ban"));
  assert.equal(sent.body.dur, "perm"); assert.equal(sent.body.reason, "spam links");
  // 6 days left: 7 days picked (never shortened to the 1-day default)
  ({ S } = await open({ until: Date.now() + 6 * 864e5, reason: "", by: "staffer" }));
  assert.equal(radios(S, "U").find((r) => r.checked).value, "7d");
  // none in force: as before (1 day, empty, no note)
  ({ S } = await open(null));
  assert.equal(radios(S, "U").find((r) => r.checked).value, "1d");
  assert.doesNotMatch(S.body.textContent, /Already banned/);
  // the chat's person menu (no `only`): unchanged - no note, 1 day, the Website ban title
  ({ S, title0 } = await open({ until: null, reason: "spam links", by: "staffer" }, { only: undefined, scope: "bridge" }));
  assert.equal(title0, "⛔ Website ban");
  assert.doesNotMatch(S.body.textContent, /Already banned/);
  assert.equal(radios(S, "U").find((r) => r.checked).value, "1d");
  // ↩️ Lift on a profile: says the site-wide ban; one already gone -> the page refreshes (onDone), so the stale item goes
  let r = await open({ until: null, reason: "spam links", by: "staffer" }, { lift: true });
  assert.equal(r.title0, "↩️ Lift the site-wide ban on @target?");
  r = await open(null, { lift: true });
  assert.match(r.S.body.textContent, /There's no site-wide ban on them any more\./);
  assert.equal(r.done(), 1);
  // the chat's Lift title as before
  r = await open(null, { lift: true, only: undefined, wban: { p: -1 } });
  assert.equal(r.title0, "↩️ Lift a website ban on @target?");
  assert.equal(r.done(), 0);
});

// ── the sheets ──
test("the sheets: in-page PATVSheet confirms with reasons, never confirm(), textContent only; the ban sheet keeps only the site scope", () => {
  const js = SRC("public/js/profile-mod.js");
  assert.doesNotMatch(js, /\bconfirm\(|\balert\(|\bprompt\(|innerHTML|insertAdjacentHTML/);
  assert.match(js, /W\.PATVBanSheet\.open\(\{ ref: c\.ref, slug: c\.slug, scope: 'site', only: \['site'\], lift: !!lift, name: '@' \+ c\.u, anchor: anchor, onDone: reload \}\)/);
  // each item calls its existing route
  for (const re of [/'\/api\/admin\/bridge\/blocks\?target=' \+ encodeURIComponent\(target\)/, /api\('\/api\/admin\/bridge\/blocks', \{ op: 'block', room: '', target: target, features: d\.add, hours: len\.value\(\), reason: why\.value\(\) \}\)/,
                    /api\('\/api\/stage\/admin\/ban', \{ userId: c\.id, reason: why\.value\(\) \}\)/, /api\('\/api\/stage\/admin\/unban', \{ userId: c\.id \}\)/,
                    /api\('\/api\/admin\/creators\/' \+ encodeURIComponent\(c\.id\) \+ '\/status', \{ action: pick, note: note\.value\(\) \}\)/,
                    /api\('\/api\/admin\/stage-cover\/remove', \{ user_id: c\.id \}\)/,
                    /api\('\/api\/admin\/users\/' \+ encodeURIComponent\(c\.id\) \+ '\/sessions\/revoke', \{ reason: why\.value\(\), confirm: typed\.input\.value\.trim\(\) \}\)/]) assert.match(js, re);
  // sign-out keeps the route's own confirmation: a reason (3+) and the username typed, the button off until both
  assert.match(js, /var okWhy = why\.value\(\)\.length >= 3, okName = typed\.input\.value\.trim\(\) === c\.u;/);
  assert.match(js, /B\.go\.disabled = !\(okWhy && okName\);/);
  // the menu closes before a sheet opens; the page reloads after a change so the menu says what's in force
  assert.match(js, /if \(det\) \{ det\.open = false; anchor = det\.querySelector\('summary'\) \|\| b; \}/);
  const bs = SRC("public/js/pad-ban-sheet.js");
  assert.match(bs, /var scopes = Array\.isArray\(o\.only\) \? pv\.scopes\.filter\(function \(sc\) \{ return o\.only\.indexOf\(sc\) >= 0; \}\) : pv\.scopes;/);
  assert.match(bs, /if \(only && want\('site'\) && cur\.site\) opts\.push\(\['site', cur\.site\]\);/);
  assert.match(bs, /scope === 'site' && !pv\.veil \? _t\('js\.ban\.done_site', 'Done - they\\'re banned site-wide and signed out\.'\)/);
  assert.equal((bs.match(/\bdone\(o, a\);/g) || []).length, 2, "after a ban and after a lift");
  assert.match(bs, /function done\(o, a\) \{ if \(typeof o\.onDone === 'function'\)/);
  // the chat's person menu is unchanged: no `only`, so every scope as before, and no site ban in its Lift
  assert.doesNotMatch(SRC("public/js/room-mod.js"), /only: \[/);
  assert.match(SRC("views/room.ejs"), /pad-ban-sheet\.js\?v=4/);
  // copy: en.json (en only)
  const en = JSON.parse(SRC("locales/en.json"));
  for (const k of ["profile.mod.heading", "profile.mod.siteban", "js.pfmod.signout_body", "js.ban.done_site", "js.ban.lift_site_body"]) assert.ok(en[k], k);
});
