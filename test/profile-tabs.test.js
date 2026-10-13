// Offline tests for 1.99du: the profile page as a header + tabs.
//   - Posts is the default tab (and first in the default layout); the path (1.99dv: /u/<name>/<tab>; was ?tab=) opens
//     another; an unknown tab falls back
//   - the owner gets the composer at the top of Posts ("Post to your profile", "Your profile" picked); visitors don't
//   - privacy: a section hidden in profilelayout drops its tab for visitors (and its data isn't rendered); the owner
//     sees it greyed; the layout order is the tab order
//   - the GTF avatar is a portrait in the header + a popover (configured: wardrobe rows with rarity colours, the
//     heist role, the actions; unconfigured: says so with a "Change look" CTA) - no big GTF card on the page
//   - the "More" menu holds tip jar / PAT history / achievements / cosmetics / log out; Edit profile + Wallet stay out
//   - the stat strip (PAT, Level + XP bar, Badges) replaces the stat tiles and the Level card
//   - 1.99vy: the 💰 profile vault is its own page (/u/<name>/vault): the main profile shows the feed first and only a
//     "💰 Vault" link in the tab bar; the subpage has the card (Donate for others, the owner's note for themselves);
//     ?tab=vault / the page with vaults off redirect (profilelayout.vaultRoute); an old #vault hash is sent on by
//     profile-tabs.js
//   - the legacy "something went wrong" action result reads as a (fixed) bug; a real reason is shown as sent
//   NODE_PATH=G:/PATV/node_modules node --test test/profile-tabs.test.js
//   PROFILE_SHOTS=<dir> also writes the rendered pages there (for screenshots)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "profiletabs-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

const express = require("express");
const ejs = require("ejs");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const follows = require(path.join(repo, "follows"));
const pads = require(path.join(repo, "pads"));
const layout = require(path.join(repo, "profilelayout"));
require(path.join(repo, "terms"))._setRequired(false);
require(path.join(repo, "public/js/avatar.js"));

let base, server;
const U = {};
const users = new Map();
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, ?, ?, 0)`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null, extra.level || 0, "2026-01-01 00:00:00"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.alice = await mkUser("alice", { camfrog: "alicecf", display: "Alice" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  await rooms.init();
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  pads.register(app);
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  follows.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  for (const body of [{ title: "Pixel frogs are back", body: "New heist season starts Friday — who's in my crew?", community: "u/alice" },
                      { title: "Mic night recap", body: "Thanks everyone for the vibes last night 🎤", community: "u/alice" }]) {
    const r = await fetch(base + "/api/feed/posts", { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-requested-with": "fetch", "x-test-user": U.alice.userId } });
    assert.equal(r.status, 200, await r.text());
  }
});
test.after(() => { server.close(); });

const ITEMS = [
  { slot: "Background", name: "Neon Docks", rarity: "rare", color: "#4fc3f7", emoji: "🌃", desc: "The docks at night" },
  { slot: "Hat", name: "Gold Crown", rarity: "legendary", color: "#ffb300", emoji: "👑", desc: "Heavy is the head" },
  { slot: "Frame", name: "Rope Frame", rarity: "common", color: "#9e9e9e", emoji: "🪢", desc: "" },
];

/** Render profile.ejs the way index.js does. who: "owner" | "visitor"; opts: { items, hidden, order, tab, svg, acts } */
async function render(who, opts = {}) {
  const viewerUser = who === "owner" ? U.alice : who === "visitor" ? U.bob : null;
  const owner = who === "owner";
  const L = layout.view({ order: opts.order || layout.SECTION_IDS, hidden: opts.hidden || [], priv: [] }, { owner });
  const social = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, viewerUser, { show: L.show("posts"), query: {}, host: "test" });
  const svg = opts.svg === false ? null : globalThis.pepeAvatarSVG(424242, 176, {});
  const locals = {
    username: viewerUser ? viewerUser.username : null, usernameProfile: "alice", displayname: "Alice", classh: "pleb",
    level: 14, xp: 5200, avatar: "/public/img/avatar.png", points_balance: 1234567,
    badges: [{ name: "First Words", description: "Say something", icon: "/public/img/avatar.png" },
             { name: "Night Owl", description: "Chat after 3am", icon: "/public/img/avatar.png" }],
    xpForNextLevel: (lv) => 1000 * (lv + 1), canSeeHistory: owner,
    heistSheet: opts.sheet === false ? null : { url: "https://pepe.publicaccess.tv/sheet/abc", cls: "Wheelman" },
    gtf: { heistHelp: "/gtf#heists", turfGuide: "/gtf#turf", turfMap: "/gtf#map", gangs: "/gtf#gangs" },
    camfrog: "alicecf", gtfAvatar: { svg, items: opts.items || [] },
    analytics: null, layout: L, profileLayoutMod: layout, profileTab: opts.tab || "",
    profileVault: opts.vault || null, vaultView: !!opts.vaultView,
    social, previewVisitor: !!opts.preview, avatarActs: owner ? (opts.acts || []) : [], avatarMsg: "", tipJarNew: owner ? 3 : 0,
    ogBase: "http://test", ogPath: "/u/alice",
  };
  return ejs.renderFile(path.join(repo, "views", "profile.ejs"), locals);
}
const shots = process.env.PROFILE_SHOTS;
function save(name, html) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, name + ".html"), html);
}
const tabsOf = (html) => [...html.matchAll(/role="tab" id="tb-(\w+)"/g)].map((m) => m[1]);
const selected = (html) => (html.match(/data-tab="(\w+)" aria-controls="tab-\w+"\s+aria-selected="true"/) || [])[1];
const panelOpen = (html, id) => new RegExp(`id="tab-${id}" aria-labelledby="tb-${id}" data-panel="${id}">`).test(html);

test("layout: Posts first by default; tabsFor follows the order, groups Overview, drops what may not be shown", () => {
  assert.equal(layout.SECTION_IDS[0], "posts");
  const has = { posts: true, stats: true, level: true, avatar: true, gtf: true, badges: true, analytics: true };
  const v = layout.view(layout.DEFAULT, {});
  assert.deepEqual(layout.tabsFor(v, has).map((t) => t.id), ["posts", "overview", "analytics"]);
  assert.deepEqual(layout.tabsFor(v, has).find((t) => t.id === "overview").sections, ["gtf", "badges"]);
  // the owner's order is the tab order (and the Overview card order)
  const v2 = layout.view({ order: ["analytics", "badges", "gtf", "posts"] }, {});
  assert.deepEqual(layout.tabsFor(v2, has).map((t) => t.id), ["analytics", "overview", "posts"]);
  assert.deepEqual(layout.tabsFor(v2, has).find((t) => t.id === "overview").sections, ["badges", "gtf"]);
  assert.equal(layout.pickTab(layout.tabsFor(v2, has), ""), "posts", "Posts is the default wherever it sits");
  assert.equal(layout.pickTab(layout.tabsFor(v2, has), "ANALYTICS"), "analytics");
  assert.equal(layout.pickTab(layout.tabsFor(v2, has), "nope"), "posts");
  // hidden: gone for visitors, greyed for the owner; no posts -> the first tab opens
  const vis = layout.view({ hidden: ["posts", "analytics"] }, {});
  assert.deepEqual(layout.tabsFor(vis, has).map((t) => t.id), ["overview"]);
  assert.equal(layout.pickTab(layout.tabsFor(vis, has), ""), "overview");
  const own = layout.tabsFor(layout.view({ hidden: ["posts"] }, { owner: true }), has);
  assert.equal(own.find((t) => t.id === "posts").hidden, true);
  assert.equal(own.find((t) => t.id === "overview").hidden, false);
  // a section with nothing to show doesn't make a tab
  assert.deepEqual(layout.tabsFor(v, Object.assign({}, has, { analytics: false })).map((t) => t.id), ["posts", "overview"]);
  assert.deepEqual(layout.tabsFor(layout.view({ order: [], hidden: [] }, {}), has).map((t) => t.id), ["posts", "overview", "analytics"], "a saved layout without the new order still works");
});

test("owner view: Posts tab open with the composer on top; More menu holds the moved actions; stat strip, no big cards", async () => {
  const html = await render("owner", { items: ITEMS });
  save("owner-configured", html);
  assert.deepEqual(tabsOf(html), ["posts", "overview"], "no analytics data -> no Analytics tab for this profile");
  assert.equal(selected(html), "posts");
  assert.ok(panelOpen(html, "posts"), "the Posts panel isn't hidden");
  assert.match(html, /id="tab-overview" aria-labelledby="tb-overview" data-panel="overview" hidden>/);
  // composer first in the Posts panel
  const postsPanel = html.slice(html.indexOf('id="tab-posts"'), html.indexOf('id="tab-overview"'));
  assert.match(postsPanel, /Post to your profile/);
  assert.match(postsPanel, /id="fcForm"/);
  assert.ok(postsPanel.indexOf("Post to your profile") < postsPanel.indexOf("Pixel frogs are back"), "the composer is above the posts");
  assert.match(postsPanel, /name="community" value="u\/alice"[^>]*checked>/, "Your profile is picked");
  // primary actions outside, the rest in More
  const actions = html.slice(html.indexOf('<div class="actions">'), html.indexOf("</details>", html.indexOf('<div class="actions">')));
  const outside = actions.slice(0, actions.indexOf("<details"));
  const menu = actions.slice(actions.indexOf('class="pf-menu"'));
  assert.match(outside, /Edit profile/);
  assert.match(outside, /href="\/wallet"/);
  for (const re of [/Your tip jar/, /href="\/history"/, /Achievements/, /Cosmetics/, /Log out/]) {
    assert.match(menu, re);
    assert.doesNotMatch(outside, re);
  }
  assert.match(actions, /⋯<\/span> More <span class="tj-new"[^>]*>3<\/span>/, "new tips show on the More button");
  assert.doesNotMatch(outside, /data-follow-kind|pf-msg/, "no Follow / Message on your own profile");
  assert.match(html, /<a class="ps fw" href="\/feed\/following" title="Your follow lists"><span class="k">Followers<\/span>/, "the owner's count opens their lists");
  // stat strip; the old stat tiles, Level card and GTF card are gone
  assert.match(html, /class="pf-strip"/);
  assert.match(html, /<span class="k">PAT<\/span><b class="gold">1,234,567<\/b>/);
  assert.match(html, /class="xb" role="progressbar"/);
  assert.doesNotMatch(html, /class="card lvl"|class="stats"|class="card avs"/);
});

test("visitor view: Tip + More (achievements), the feed with sorts, no composer, no owner actions", async () => {
  const html = await render("visitor", { items: ITEMS });
  save("visitor-configured", html);
  assert.equal(selected(html), "posts");
  assert.doesNotMatch(html, /Post to your profile|id="fcForm"/);
  assert.match(html, /Pixel frogs are back/);
  assert.match(html, /class="fd-sort|Sort alice|Sort Alice/);
  const actions = html.slice(html.indexOf('<div class="actions">'), html.indexOf("</details>", html.indexOf('<div class="actions">')));
  assert.match(actions, /💸<\/span> Tip/);
  assert.match(actions, /Achievements/);
  assert.doesNotMatch(actions, /Edit profile|Wallet|Log out|Cosmetics|PAT history|tip jar/);
  assert.doesNotMatch(html, /New avatar…|Your recent requests/);
  // 1.99ef zones: Follow + Message in the actions row, Report in More, the counts in the stat strip - none among the tags
  const outside = actions.slice(0, actions.indexOf("<details"));
  const menu = actions.slice(actions.indexOf('class="pf-menu"'));
  assert.match(outside, /data-follow-kind="user" data-follow-id="alice"/);
  assert.match(outside, /class="btn pf-msg" href="\/messages\?to=alice"/);
  assert.ok(outside.indexOf("data-follow-kind") < outside.indexOf("💸</span> Tip"), "Follow leads");
  assert.match(menu, /role="menuitem" class="pf-report" data-safety="report-user" data-user="alice"/);
  assert.doesNotMatch(outside, /report-user/);
  const strip = html.slice(html.indexOf('class="pf-strip"'), html.indexOf('<div class="actions">'));
  assert.match(strip, /<div class="ps fw"><span class="k">Followers<\/span>\s*<span class="fw-row"><b data-follower-count-kind="user" data-follower-count-id="alice">\d+<\/b><small>\d+ following<\/small>/);
  const who = html.slice(html.indexOf('<div class="who">'), html.indexOf('class="pf-strip"'));
  assert.doesNotMatch(who, /follower|data-follow-kind|pf-msg|report-user/, "identity zone: no counts / actions");
});

test("the tab path opens that tab (deep link); an unknown one falls back to Posts; links are /u/<name>/<tab> (1.99dv)", async () => {
  const html = await render("visitor", { tab: "overview" });
  assert.equal(selected(html), "overview");
  assert.ok(panelOpen(html, "overview"));
  assert.match(html, /id="tab-posts" aria-labelledby="tb-posts" data-panel="posts" hidden>/);
  assert.match(html, /href="\/u\/alice\/overview" data-tab="overview"/);
  assert.match(html, /href="\/u\/alice\/posts" data-tab="posts"/);
  assert.doesNotMatch(html, /\/u\/alice\/profile/, "no old profile addresses");
  assert.match(await render("owner", { tab: "analytics", preview: true }), /href="\/u\/alice\/overview\?preview=visitor"/, "previewing keeps ?preview=visitor on the tabs");
  assert.equal(selected(await render("visitor", { tab: "<script>" })), "posts");
});

test("privacy: hidden sections drop their tab (and content) for visitors; the owner sees them greyed", async () => {
  const hidden = ["posts", "badges"];
  const vis = await render("visitor", { hidden, items: ITEMS });
  assert.deepEqual(tabsOf(vis), ["overview"]);
  assert.equal(selected(vis), "overview", "no Posts tab -> the first one opens");
  assert.doesNotMatch(vis, /Pixel frogs are back|id="badges"|Night Owl/);
  const own = await render("owner", { hidden, items: ITEMS });
  assert.deepEqual(tabsOf(own), ["posts", "overview"]);
  assert.match(own, /class="pf-tab is-hidden" role="tab" id="tb-posts"/);
  assert.match(own, /data-sec="badges"><span class="pf-hid">/);
  // hiding the avatar removes the portrait, the chip and the popover for visitors
  const noAv = await render("visitor", { hidden: ["avatar"], items: ITEMS });
  assert.doesNotMatch(noAv, /id="gtfPop"|class="pf-gtfmini|class="chip gtfc"/);
  // hiding the stat strip / XP bar
  const noStats = await render("visitor", { hidden: ["stats", "level"] });
  assert.doesNotMatch(noStats, /1,234,567|class="xb"/);
  assert.match(noStats, /<span class="k">Level<\/span>/, "the level number itself stays (it was public before too)");
});

test("GTF popover: configured = wardrobe rows with rarity colours, the heist role, the actions", async () => {
  const html = await render("owner", { items: ITEMS, acts: [{ status: "failed", label: "New GTF avatar", message: "something went wrong" },
                                                            { status: "failed", label: "New GTF avatar", message: "a new avatar costs 20,000 PAT — insufficient PAT" }] });
  const pop = html.slice(html.indexOf('<div id="gtfPop"'));
  assert.match(pop, /popover/);
  assert.match(pop, /data-gtf-state="configured"/);
  assert.match(pop, /<li style="--rc:#ffb300"[^>]*><span class="gp-slot">Hat<\/span><span class="gp-name">👑 Gold Crown<\/span><span class="gp-rar">legendary<\/span>/);
  assert.match(pop, /class="gp-role"[^>]*>🥷 Wheelman/);
  assert.match(pop, /Change look/);
  assert.match(pop, /Heist sheet/);
  assert.match(pop, /New avatar…/);
  assert.match(pop, /name="back" value="\/u\/alice\?gtf=1"/, "the regen comes back with the popover open");
  // the legacy bare failure reads as a fixed bug; a real reason is shown as sent
  assert.match(pop, /Pepe hit a bug on his side \(since fixed\)/);
  assert.doesNotMatch(pop, />something went wrong</);
  assert.match(pop, /insufficient PAT/);
  // the header portrait: the best rarity colours its frame, it opens the popover
  assert.match(html, /class="pf-gtfmini" popovertarget="gtfPop" data-gtf-open\s+style="--rc:#ffb300"/);
  assert.match(html, /class="chip gtfc" popovertarget="gtfPop"[^>]*>🎮 GTF: Wheelman/);
  save("owner-popover", html);
});

test("GTF popover: unconfigured says so with a Change look CTA; no avatar at all says how to get one", async () => {
  const html = await render("owner", { items: [] });
  save("owner-unconfigured", html);
  const pop = html.slice(html.indexOf('<div id="gtfPop"'));
  assert.match(pop, /data-gtf-state="unconfigured"/);
  assert.match(pop, /not wearing anything from the GTF wardrobe yet/);
  assert.match(pop, /class="btn primary" href="\/cosmetics\?tab=mine#tabs"><span class="ds-ic" aria-hidden="true">🎨<\/span> Change look/);
  assert.doesNotMatch(pop, /class="gp-items"/);
  const vis = await render("visitor", { items: [] });
  save("visitor-unconfigured", vis);
  assert.match(vis.slice(vis.indexOf('<div id="gtfPop"')), /Not wearing anything from the GTF wardrobe yet[\s\S]*GTF wardrobe/);
  const none = await render("visitor", { items: [], svg: false });
  assert.match(none, /class="pf-gtfmini empty"/);
  assert.match(none, /No GTF avatar yet/);
});

test("the tab script is cache-busted", () => {
  const src = fs.readFileSync(path.join(repo, "views", "profile.ejs"), "utf8");
  assert.match(src, /\/public\/js\/profile-tabs\.js\?v=\d+/);
  assert.ok(fs.existsSync(path.join(repo, "public", "js", "profile-tabs.js")));
});

// ── 1.99vy: the profile vault's own page ──
const CARD = { live: true, recipe: { live: true }, cap: 50000000, balance: 1250000, inflow7: 40000, topup7: 12000, deposits7: 5000,
  deposit_min: 1000, week: { paid: 9000, stays: 1241000, owner: 4000, people: 5000 }, viewer: { balance: 80000 },
  donors: [{ who: "bob", anon: false, ts: 1760000000000, amount: 5000 }] };
const PV = (card) => ({ slug: "u-alice", card: card === undefined ? null : card });

test("vault: the main profile has no vault card - the feed comes first after the header; a 💰 Vault link sits in the tab bar", async () => {
  for (const who of ["owner", "visitor", "anon"]) {
    const html = await render(who, { vault: PV() });
    save("vault-main-" + who, html);
    assert.doesNotMatch(html, /class="card pv-card"|id="rvDonate"|pad-vault\.js/, who + ": no vault card on the profile");
    const hero = html.indexOf('<section class="card hero'), nav = html.indexOf('<nav class="pf-tabs"');
    assert.ok(hero > 0 && nav > hero, "the tab bar comes after the header");
    assert.ok(panelOpen(html, "posts"), who + ": Posts open");
    assert.ok(html.indexOf('id="tab-posts"') > nav && html.indexOf('id="tab-posts"') < html.indexOf('id="tab-overview"'), "the feed is the first panel");
    const between = html.slice(html.indexOf("</section>", hero), nav);
    assert.doesNotMatch(between, /<section class="card(?! pf-story)/, who + ": nothing big between the header and the feed");
    assert.match(html, /<a class="pf-tab pf-vault" href="\/u\/alice\/vault" data-vault-link title="The profile vault[^"]*"><span aria-hidden="true">💰<\/span>Vault<\/a>/, who);
    assert.deepEqual(tabsOf(html), ["posts", "overview"], "the vault link isn't a client-side tab");
  }
  assert.match(await render("owner", { vault: PV(), preview: true }), /href="\/u\/alice\/vault\?preview=visitor" data-vault-link/);
  assert.doesNotMatch(await render("visitor", {}), /data-vault-link|\/u\/alice\/vault/, "profile vaults off: no link");
});

test("vault: /u/<name>/vault shows the header, the tab bar (links back) and the vault card - Donate for others, a note for the owner", async () => {
  const vis = await render("visitor", { vault: PV(CARD), vaultView: true, tab: "vault" });
  save("vault-page-visitor", vis);
  assert.match(vis, /<title>[^<]*Alice(?:'|&#39;)s vault on Public Access/);
  assert.match(vis, /class="card pv-card" id="vault"/);
  assert.match(vis, /<form class="ds-form" id="rvDonate" data-slug="u-alice"/, "Donate works for others");
  assert.match(vis, /id="vault-donate"/);
  assert.match(vis, /\/public\/js\/pad-vault\.js\?v=\d+/);
  assert.match(vis, /1,250,000/);
  assert.match(vis, /<a class="pf-tab pf-vault" href="\/u\/alice\/vault" aria-current="page">/);
  assert.match(vis, /<a class="pf-tab" href="\/u\/alice\/posts">/, "Posts goes back to the profile");
  assert.match(vis, /<a class="pf-tab" href="\/u\/alice\/overview">/);
  assert.doesNotMatch(vis, /data-tab=|role="tabpanel"|Pixel frogs are back/, "no client tabs / feed on the vault page");
  const own = await render("owner", { vault: PV(CARD), vaultView: true, tab: "vault" });
  save("vault-page-owner", own);
  assert.match(own, /This is your vault - other people can donate to it/);
  assert.doesNotMatch(own, /id="rvDonate"/, "no donating to yourself");
  assert.match(own, /Your vault fills when other people spend on your profile/);
  assert.match(own, /href="\/u\/alice\/saved"/);
  const anon = await render("anon", { vault: PV(CARD), vaultView: true, tab: "vault" });
  assert.match(anon, /href="\/login\?next=%2Fu%2Falice%2Fvault%23vault-donate"/, "sign in comes back to the vault's Donate");
});

test("vault: routing - ?tab=vault and vaults off redirect; old #vault links are sent to the page", async () => {
  const R = layout.vaultRoute;
  assert.deepEqual(R({ tab: undefined, qtab: undefined, has: true, username: "alice" }), { vault: false });
  assert.deepEqual(R({ tab: "posts", qtab: "vault", has: true, username: "alice" }), { vault: false });
  assert.deepEqual(R({ tab: "vault", has: true, username: "alice" }), { vault: true });
  assert.deepEqual(R({ tab: "vault", has: false, username: "alice" }), { redirect: "/u/alice", status: 302 });
  assert.deepEqual(R({ tab: undefined, qtab: "Vault", has: true, username: "a b" }), { redirect: "/u/a%20b/vault", status: 301 });
  assert.deepEqual(R({ tab: undefined, qtab: "vault", has: true, username: "alice", preview: true }), { redirect: "/u/alice/vault?preview=visitor", status: 301 });
  assert.ok(require(path.join(repo, "index.js").replace("index.js", "profilelayout.js")).vaultRoute === R);
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(src, /:tab\(posts\|overview\|analytics\|plex\|vault\)/, "the route takes /vault");
  assert.match(src, /profileLayout\.vaultRoute\(/);
  // profile-tabs.js: #vault / #vault-donate on the profile -> /u/<name>/vault (keeping the Donate anchor); other hashes stay
  const vm = require("vm");
  const js = fs.readFileSync(path.join(repo, "public", "js", "profile-tabs.js"), "utf8");
  const run = (hash, withLink = true) => {
    let went = null;
    const link = { getAttribute: (k) => (k === "href" ? "/u/alice/vault" : null) };
    const root = { querySelector: (sel) => (sel === "[data-vault-link]" && withLink ? link : null), querySelectorAll: () => [] };
    const doc = { querySelector: (sel) => (sel === ".pf[data-profile]" ? root : null), querySelectorAll: () => [], getElementById: () => null, addEventListener() {} };
    const ctx = { document: doc, location: { hash, href: "/u/alice", replace: (u) => { went = u; } }, history: { replaceState() {} },
                  window: { addEventListener() {} }, setTimeout, HTMLElement: function () {} };
    ctx.window.document = doc;
    try { vm.runInNewContext(js, ctx); } catch (e) { if (went === null) throw e; }
    return went;
  };
  assert.equal(run("#vault"), "/u/alice/vault");
  assert.equal(run("#vault-donate"), "/u/alice/vault#vault-donate");
  assert.equal(run("#badges"), null);
  assert.equal(run("#vault", false), null, "profile vaults off: nothing to go to");
});
