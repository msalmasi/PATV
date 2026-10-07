// Offline tests for 1.99du: the profile page as a header + tabs.
//   - Posts is the default tab (and first in the default layout); ?tab= opens another; an unknown tab falls back
//   - the owner gets the composer at the top of Posts ("Post to your profile", "Your profile" picked); visitors don't
//   - privacy: a section hidden in profilelayout drops its tab for visitors (and its data isn't rendered); the owner
//     sees it greyed; the layout order is the tab order
//   - the GTF avatar is a portrait in the header + a popover (configured: wardrobe rows with rarity colours, the
//     heist role, the actions; unconfigured: says so with a "Change look" CTA) - no big GTF card on the page
//   - the "More" menu holds tip jar / PAT history / achievements / cosmetics / log out; Edit profile + Wallet stay out
//   - the stat strip (PAT, Level + XP bar, Badges) replaces the stat tiles and the Level card
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
    social, previewVisitor: false, avatarActs: owner ? (opts.acts || []) : [], avatarMsg: "", tipJarNew: owner ? 3 : 0,
    ogBase: "http://test", ogPath: "/u/alice/profile",
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
  assert.match(actions, /⋯ More <span class="tj-new"[^>]*>3<\/span>/, "new tips show on the More button");
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
  assert.match(actions, /💸 Tip/);
  assert.match(actions, /Achievements/);
  assert.doesNotMatch(actions, /Edit profile|Wallet|Log out|Cosmetics|PAT history|tip jar/);
  assert.doesNotMatch(html, /New avatar…|Your recent requests/);
});

test("?tab= opens that tab (deep link); an unknown one falls back to Posts; links are /profile?tab=", async () => {
  const html = await render("visitor", { tab: "overview" });
  assert.equal(selected(html), "overview");
  assert.ok(panelOpen(html, "overview"));
  assert.match(html, /id="tab-posts" aria-labelledby="tb-posts" data-panel="posts" hidden>/);
  assert.match(html, /href="\/u\/alice\/profile\?tab=overview"/);
  assert.match(html, /href="\/u\/alice\/profile\?" data-tab="posts"/);
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
  assert.match(pop, /name="back" value="\/u\/alice\/profile\?gtf=1"/, "the regen comes back with the popover open");
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
  assert.match(pop, /class="btn primary" href="\/cosmetics\?tab=mine#tabs">🎨 Change look/);
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
