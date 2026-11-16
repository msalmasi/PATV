// Offline tests for 1.99anv's 🚪 Guest access (guestaccess.js, /admin/users#guests):
//   * defaults: every section ON - deploying changes nothing (no rows, every page and API answers as before)
//   * each section OFF: a signed-out visitor's page is the "Sign in to see <Section>" page (200), its guest-readable JSON GET APIs
//     401 {error: "sign_in"}, its share-card images 404; a signed-in member and a bot credential are never stopped
//   * the never-gate list stays public with EVERY section off (a representative of each kind)
//   * the gate page: Sign in back to the page, "Got an invite?" while invite-only / "Sign up" while open; no-store, noindex, the
//     generic share card
//   * the navbar (top bar, More, ☰), the footer and the homepage hide off sections for guests and keep them for members
//   * the feed's live link cards (embedcards.js) of an off section are null for guests
//   * admin: capability, same-origin, validation, the audit rows {section, from, to}, the stale-card check, the 30 s reload
//   NODE_PATH=G:/PATV/node_modules TZ=UTC node --test test/guestaccess.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guestaccess-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token-for-tests-0001";

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const GA = require(path.join(repo, "guestaccess"));
const INV = require(path.join(repo, "invites"));

let base, server, clockAt = Date.UTC(2026, 10, 14, 18, 0, 0);
GA._setClock(() => clockAt);
const SECRET = process.env.SECRET_KEY;
const cookieOf = (u) => "jwt=" + jwt.sign({ userId: u.userId, username: u.username, class: u.class }, SECRET);
const USERS = { adm: { userId: "u_adm", username: "boss", class: "Admin" }, stf: { userId: "u_stf", username: "staffer", class: "Staff" },
                mem: { userId: "u_mem", username: "member", class: "pleb" } };
async function go(p, { as = null, method = "GET", headers = {}, body } = {}) {
  const h = { ...headers };
  if (as) h.cookie = cookieOf(USERS[as]);
  if (body !== undefined) { h["content-type"] = "application/json"; }
  const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = method === "HEAD" ? "" : await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* html */ }
  return { status: r.status, text, json, headers: r.headers };
}
const adminPost = (body, as = "adm", extra = {}) => go("/api/admin/guest-access", { as, method: "POST", body, headers: { "x-requested-with": "fetch", ...extra } });
const setAll = async (on) => {
  const r = await adminPost({ changes: Object.fromEntries(GA.KEYS.map((k) => [k, on])) });
  assert.equal(r.status, 200, r.text);
};
const setOne = async (k, on) => { const r = await adminPost({ changes: { [k]: on } }); assert.equal(r.status, 200, r.text); };
const real = (r) => !!(r.json && r.json.real);

// a representative page / API / share card per section (a real route of each - the report's route map has them all)
const REP = {
  pads: { pages: ["/p", "/p/somepad", "/p/somepad/settings", "/pads/new", "/stage", "/stage/book", "/rooms/somepad"],
          apis: ["/api/pads/onair", "/api/rooms/somepad/live", "/api/rooms/somepad/history", "/api/rooms/somepad/stage", "/p/somepad/audio", "/rooms/somepad/audio",
                 "/api/stage?room=somepad", "/api/feed/communities"] },
  feed: { pages: ["/feed", "/feed/p/abc", "/submit", "/p/somepad/posts/abc", "/hop"], apis: ["/api/feed/communities", "/api/hop"], og: ["/og/post/abc.png"] },
  plex: { pages: ["/plex", "/requests", "/plex/manage"], apis: ["/api/plex/library/recent", "/api/requests/mine"] },
  creators: { pages: ["/creators", "/creators/bob", "/creator"], apis: [] },
  members: { pages: ["/u/bob", "/u/bob/overview", "/u/bob/tip"], apis: ["/api/u/bob/profile", "/api/stories/person/bob"], og: ["/og/profile/bob.png"] },
  wheel: { pages: ["/u/bob/wheel"], apis: [] },
  markets: { pages: ["/markets", "/markets/5"], apis: [], og: ["/og/market/5.png"] },
  wagers: { pages: ["/wagers"], apis: [] },
  gtf: { pages: ["/gtf", "/gtf/leaderboards", "/gtf/gangs", "/gtf/heist", "/pondlife"], apis: ["/api/gtf/board", "/api/gangs"] },
  lotto: { pages: ["/lotto", "/lotto/fair/3"], apis: ["/api/lotto/state", "/api/lotto/fair/3"], og: ["/og/lotto.png"] },
  bingo: { pages: ["/bingo"], apis: ["/api/bingo/state"] },
  casino: { pages: ["/casino", "/casino/holdem", "/casino/blackjack/t/1", "/tables", "/poker", "/blackjack", "/bj"], apis: ["/api/casino/lobby", "/api/casino/t/1", "/api/tables/state"] },
  bounties: { pages: ["/bounties", "/bounties/3"], apis: [], og: ["/og/bounty/3.png"] },
  polls: { pages: ["/polls", "/polls/p_1"], apis: [] },
  raffles: { pages: ["/raffles", "/raffles/7"], apis: ["/api/raffles/7/fair"] },
  economy: { pages: ["/wallet", "/staking", "/history"], apis: [] },
  howpat: { pages: ["/economy"], apis: ["/api/burns"] },
  rankings: { pages: ["/rankings", "/supply"], apis: [] },
  achievements: { pages: ["/achievements"], apis: ["/api/achievements/progress"] },
  shop: { pages: ["/shop", "/shop/item/x1", "/shop/seller/bob"], apis: [] },
  premium: { pages: ["/premium"], apis: ["/api/premium/state"] },
  cosmetics: { pages: ["/cosmetics", "/stickers"], apis: ["/api/stickers"] },
  sounds: { pages: ["/soundboards", "/voices", "/voices/clone"], apis: ["/api/soundboards", "/api/voices"] },
  help: { pages: ["/help", "/help/formatting", "/commands"], apis: ["/api/help/data"] },
  search: { pages: ["/search"], apis: ["/api/search"] },
};

// never gated, whatever the switches say - one or more of each kind
const NEVER = [
  "/", "/about", "/info",
  "/login", "/register", "/signup?invite=ABCD", "/forgot-password", "/reset-password/tok123", "/verify-email?token=x", "/auth/twitch", "/auth/google/callback",
  "/auth/sso/new", "/claim/tok", "/signin?t=x", "/confirm-age", "/resolve-twitch-conflict",
  "/terms", "/privacy", "/tos", "/privacy-policy", "/guidelines", "/padiquette", "/takedown", "/rules", "/creators/terms", "/creators/terms/",
  "/robots.txt", "/healthz", "/sw.js", "/favicon.ico", "/public/css/ds.css", "/media/f/abc.png", "/og/page.png", "/.well-known/patv-jwks.json",
  "/language", "/i18n/de.json", "/lang/de",
  "/api/gtf/bot/board", "/api/feed/aigen/bot/state", "/api/premium/stripe/webhook", "/internal/hub/x",
  "/g/wheel", "/api/g/wheel/last.json", "/api/g/achievement-feed", "/events?type=spin&identifier=watch", "/onair/show", "/onair/player",
  "/gtf/heist/overlay", "/api/gtf/heist/live", "/p/somepad/chatlog/dl/tok",
  "/api/stage", "/api/stage/hls-auth", "/api/stage/whip-auth", "/api/stories",
  "/api/prizes", "/api/achievements", "/api/stats/supply", "/api/leaderboard", "/api/rankings/top", "/api/jackpot", "/api/pokernow/games",
  "/api/cosmetics/catalog", "/api/u/bob/avatar", "/api/u/bob/balance", "/api/users/twitch/123",
  "/admin", "/admin/users", "/pads/admin", "/rooms/admin", "/stage/admin", "/feed/admin", "/shop/admin", "/api/admin/members", "/api/pads/admin/config",
  "/api/feed/admin/details", "/api/casino/admin/mtt", "/api/casino/sizing.js", "/api/casino/rlwheel.js", "/sb/audio/x.mp3",
  "/settings/account", "/support",
];

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT, email TEXT, camfrogUsername TEXT,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  for (const u of Object.values(USERS)) await runQuery("INSERT INTO users (userId, username, password, class) VALUES (?, ?, 'x', ?)", [u.userId, u.username, u.class]);
  await INV.init();
  await GA.init();
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://site.test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  app.use(GA.middleware);
  const addUser = (req, res, next) => {
    req.user = null;
    try { if (req.cookies.jwt) req.user = jwt.verify(req.cookies.jwt, SECRET); } catch (e) { req.user = null; }
    next();
  };
  GA.register(app, { addUser });
  require(path.join(repo, "embedcards")).register(app, { addUser });
  // the site layout as a page renders it (its navbar + footer), for the navbar tests
  app.get("/__layout", addUser, (req, res) => res.render("layout", { title: "T", user: req.user ? req.user.username : null }));
  // every other route: the "real" route (what a visitor gets when nothing gates them)
  app.all("*", (req, res) => res.status(200).json({ real: true, path: req.path }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("defaults: every section is on - no rows, nothing gated, nothing hidden", async () => {
  assert.deepEqual((await getQuery("SELECT * FROM guest_access")), []);
  assert.ok(Object.values(GA.settings()).every((v) => v === true));
  assert.deepEqual(Object.keys(REP).sort(), [...GA.KEYS].sort(), "every section has a representative here");
  for (const [k, r] of Object.entries(REP)) {
    for (const p of [...r.pages, ...r.apis, ...(r.og || [])]) assert.ok(real(await go(p)), k + " " + p);
  }
  const h = GA.viewHelpers({ cookies: {} });
  assert.equal(h.guestHides("/markets"), false);
  assert.equal(h.guestOff("markets"), false);
});

test("each section off: guests get the sign-in page / 401 / 404; members and bots are never stopped", async () => {
  for (const [k, r] of Object.entries(REP)) {
    await setOne(k, false);
    for (const p of r.pages) {
      const g = await go(p);
      assert.equal(g.status, 200, k + " " + p);
      assert.ok(!real(g), k + " " + p + " gated");
      assert.match(g.text, /id="guestGate"/, k + " " + p);
      assert.match(g.text, new RegExp('data-section="' + k + '"'), k + " " + p);
      assert.match(g.headers.get("cache-control") || "", /no-store/);
      assert.ok(real(await go(p, { as: "mem" })), k + " " + p + " member");
      assert.ok(real(await go(p, { headers: { "x-bot-token": process.env.TWITCH_BOT_TOKEN } })), k + " " + p + " bot");
    }
    for (const p of r.apis) {
      const g = await go(p);
      assert.equal(g.status, 401, k + " " + p);
      assert.equal(g.json.ok, false); assert.equal(g.json.error, "sign_in"); assert.equal(g.json.section, k);
      assert.match(g.json.message, /^Sign in to see /);
      assert.match(g.json.signin, /^\/login\?next=/);
      assert.ok(real(await go(p, { as: "mem" })), k + " " + p + " member");
      assert.ok(real(await go(p, { headers: { authorization: "Bearer " + process.env.TWITCH_BOT_TOKEN } })), k + " " + p + " bot");
    }
    for (const p of r.og || []) {
      const g = await go(p);
      assert.equal(g.status, 404, k + " " + p);
      assert.equal(g.text, "");
      assert.ok(real(await go(p, { as: "mem" })), k + " " + p + " member");
    }
    // the other sections are untouched
    const other = Object.keys(REP).find((x) => x !== k && !["pads", "feed", "members"].includes(x));
    assert.ok(real(await go(REP[other].pages[0])), "with " + k + " off, " + other + " stays open");
    await setOne(k, true);
    for (const p of r.pages) assert.ok(real(await go(p)), k + " " + p + " back on");
  }
});

test("a path that's in two sections is gated when either is off (a pad's posts: Pads + Feed)", async () => {
  await setOne("feed", false);
  assert.ok(!real(await go("/p/somepad/posts/abc")));
  assert.ok(real(await go("/p/somepad")), "the pad page itself is Pads only");
  await setOne("feed", true);
  await setOne("members", false);
  assert.ok(!real(await go("/u/bob/posts/abc")));
  assert.ok(real(await go("/u/bob/wheel")), "the wheel page is the Wheel's, not the profile's");
  await setOne("members", true);
});

test("Express's spellings are gated too: any case, a trailing slash, a query string, HEAD; a guest's POST isn't (the route decides)", async () => {
  await setOne("markets", false);
  for (const p of ["/MARKETS", "/Markets/5", "/markets/", "/markets?sort=new"]) assert.ok(!real(await go(p)), p);
  const h = await go("/markets", { method: "HEAD" });
  assert.equal(h.status, 200);
  assert.match(h.headers.get("content-type") || "", /html/);
  assert.ok(real(await go("/markets/5/bet", { method: "POST", body: {} })), "POST passes to the route");
  await setOne("markets", true);
});

test("the never-gate list stays public with EVERY section off", async () => {
  await setAll(false);
  try {
    for (const p of NEVER) {
      const r = await go(p);
      assert.ok(real(r), p + " -> " + r.status + " " + r.text.slice(0, 80));
    }
    // the casino tables' chat frame: ?embed=1 framed by this site; the same address typed in (top level) is the pad's chat window
    const frame = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" };
    assert.ok(real(await go("/p/somepad/chat?embed=1", { headers: frame })), "the framed chat");
    assert.ok(!real(await go("/p/somepad/chat?embed=1")), "?embed=1 at the top level");
    assert.ok(!real(await go("/p/somepad/chat?embed=1", { headers: { "sec-fetch-dest": "document", "sec-fetch-site": "none" } })));
    assert.ok(!real(await go("/p/somepad/chat?embed=1", { headers: { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" } })), "framed by another site");
    assert.deepEqual(GA.sectionsOf("/p/x/chat", { framedChat: true }), []);
    assert.ok(GA.sectionsOf("/p/x/chat").length, "the chat window itself is the pad's");
  } finally { await setAll(true); }
});

test("Pads off: every pad's live room, history, audio and stage are Pads APIs - but not the pads the homepage shows, nor the casino chat frame's own", async () => {
  await setOne("pads", false);
  try {
    const PAD_READS = ["/api/rooms/otherpad/live", "/api/rooms/otherpad/history", "/api/rooms/otherpad/history/state", "/api/rooms/otherpad/stage",
                       "/api/rooms/otherpad/cfstickers", "/p/otherpad/audio", "/rooms/otherpad/audio", "/api/stage?room=otherpad"];
    for (const p of PAD_READS) {
      const g = await go(p);
      assert.equal(g.status, 401, p); assert.equal(g.json.error, "sign_in"); assert.equal(g.json.section, "pads");
      assert.ok(real(await go(p, { as: "mem" })), p + " member");
    }
    assert.ok(real(await go("/api/stage")), "no pad named: the homepage's front pad stage");
    // the guest-usable POSTs that read a pad are gated with them; the rest pass to their routes (the bots' own POSTs among them)
    for (const p of ["/api/rooms/otherpad/audio/rtc", "/api/rooms/otherpad/search", "/api/rooms/otherpad/history/check"]) {
      const g = await go(p, { method: "POST", body: {} });
      assert.equal(g.status, 401, "POST " + p); assert.equal(g.json.error, "sign_in");
      assert.ok(real(await go(p, { method: "POST", body: {}, as: "mem" })), "POST " + p + " member");
    }
    for (const p of ["/api/rooms/boost", "/api/rooms/owners", "/api/rooms/otherpad/challenge/payout", "/api/rooms/otherpad/say"]) {
      assert.ok(real(await go(p, { method: "POST", body: {} })), "POST " + p + " passes to the route");
    }
    // the pads the homepage showed a guest (home.js noteHome): their reads stay open - by slug or id, any case - the pad page itself doesn't
    GA.noteHome([{ id: "Front.Room", slug: "frontpad" }, null, { id: "Panel.Room", slug: "panelpad" }]);
    for (const p of ["/api/rooms/frontpad/live", "/api/rooms/FrontPad/history", "/api/rooms/front.room/live", "/p/frontpad/audio", "/api/stage?room=frontpad",
                     "/api/rooms/panelpad/live", "/rooms/panelpad/audio"]) assert.ok(real(await go(p)), "homepage pad: " + p);
    assert.ok(real(await go("/api/rooms/frontpad/audio/rtc", { method: "POST", body: {} })), "the homepage's 🎧 WebRTC ticket");
    assert.ok(!real(await go("/p/frontpad")), "the front pad's own page is still the Pads gate");
    assert.equal((await go("/api/rooms/otherpad/live")).status, 401, "another pad stays closed");
    // the house room / the front pick rooms.js holds: open without a note
    const rooms = require(path.join(repo, "rooms"));
    assert.ok(real(await go("/api/rooms/" + encodeURIComponent(rooms.HOUSE_ROOM) + "/live")), "the house room");
    // a note lasts 6 h (a homepage that's open longer keeps re-noting it through its own reloads)
    clockAt += 6 * 3600e3 + 1000;
    assert.equal((await go("/api/rooms/frontpad/live")).status, 401, "an old note");
    // the casino tables' 💬 Chat frame: that frame's own requests (Referer = the framed chat of the SAME pad, same-origin)
    const frame = (ref, site = "same-origin") => ({ referer: ref, "sec-fetch-site": site });
    for (const p of ["/api/rooms/otherpad/live", "/api/rooms/otherpad/history", "/p/otherpad/audio", "/api/stage?room=otherpad"]) {
      assert.ok(real(await go(p, { headers: frame(base + "/p/otherpad/chat?embed=1") })), "framed chat: " + p);
      assert.ok(real(await go(p, { headers: frame(base + "/p/OtherPad/chat?embed=1#listen") })), "framed chat (any case): " + p);
    }
    assert.ok(real(await go("/api/rooms/otherpad/audio/rtc", { method: "POST", body: {}, headers: frame(base + "/p/otherpad/chat?embed=1") })), "framed chat: rtc");
    for (const [why, h] of [["another pad's frame", frame(base + "/p/elsewhere/chat?embed=1")], ["the chat window, not the frame", frame(base + "/p/otherpad/chat")],
                            ["the pad page", frame(base + "/p/otherpad")], ["cross-site", frame(base + "/p/otherpad/chat?embed=1", "cross-site")],
                            ["another host", frame("http://evil.test/p/otherpad/chat?embed=1")], ["no referer", { "sec-fetch-site": "same-origin" }]]) {
      assert.equal((await go("/api/rooms/otherpad/live", { headers: h })).status, 401, why);
    }
    // Pads on: nothing of this applies
    await setOne("pads", true);
    for (const p of PAD_READS) assert.ok(real(await go(p)), "on: " + p);
    assert.ok(real(await go("/api/rooms/otherpad/search", { method: "POST", body: {} })));
  } finally { await setAll(true); GA._home.clear(); }
});

test("the Creator Terms stay public with Creators off (/terms points to them); the creators pages don't", async () => {
  await setOne("creators", false);
  try {
    for (const p of ["/creators/terms", "/creators/terms/", "/CREATORS/TERMS"]) assert.ok(real(await go(p)), p);
    for (const p of ["/creators", "/creators/bob", "/creator"]) assert.ok(!real(await go(p)), p);
    assert.match(fs.readFileSync(path.join(repo, "views", "terms.ejs"), "utf8"), /href="\/creators\/terms"/, "the link the rule exists for");
  } finally { await setOne("creators", true); }
});

test("search: posts / pads / people are left out for guests while Feed / Pads / Member profiles is off (searchHidden)", async () => {
  const guest = { cookies: {}, query: {}, get: () => "" }, member = { cookies: {}, user: { userId: "u_mem" } };
  assert.deepEqual(GA.searchHidden(guest), []);
  await adminPost({ changes: { feed: false } });
  assert.deepEqual(GA.searchHidden(guest), ["posts"]);
  await adminPost({ changes: { pads: false, members: false } });
  assert.deepEqual(GA.searchHidden(guest), ["posts", "pads", "people"]);
  assert.deepEqual(GA.searchHidden(member), [], "members get everything");
  assert.deepEqual(GA.searchHidden({ cookies: {}, query: {}, get: (h) => (h === "x-bot-token" ? process.env.TWITCH_BOT_TOKEN : "") }), [], "a bot too");
  await setAll(true);
  assert.deepEqual(GA.searchHidden(guest), []);
});

test("the admin card names the sections as the navbar does (PepeFrog commands, How PAT works under Info & links)", async () => {
  const v = (await go("/api/admin/guest-access", { as: "adm" })).json;
  const sec = (k) => v.sections.find((s) => s.key === k).groups.map((g) => g.key);
  assert.deepEqual(sec("info"), ["rankings", "help", "howpat", "search"], "the navbar's Info & links order");
  assert.ok(!sec("you").includes("rankings") && !sec("you").includes("howpat"));
  assert.deepEqual(sec("you"), ["economy", "achievements"]);
  const label = (k) => v.sections.flatMap((s) => s.groups).find((g) => g.key === k).label;
  assert.match(label("help"), /PepeFrog commands/);
  assert.match(label("howpat"), /How PAT works/);
  assert.match(label("economy"), /Wallet & stashes, Staking & vaults, PAT history/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["guest.s.help"], "PepeFrog commands");
  assert.equal(en["guest.s.howpat"], "How PAT works");
});

test("the gate page: Sign in back to the page; Got an invite? while invite-only, Sign up while open; only the section's name", async () => {
  await setOne("shop", false);
  let g = await go("/shop/item/x1?ref=home");
  assert.match(g.text, /<h1 id="ggH">Sign in to see the Prize shop<\/h1>/);
  assert.match(g.text, /href="\/login\?next=%2Fshop%2Fitem%2Fx1%3Fref%3Dhome"/);
  assert.match(g.text, /href="\/register\?next=%2Fshop%2Fitem%2Fx1%3Fref%3Dhome">Sign up</);
  assert.doesNotMatch(g.text, /Got an invite\?/);
  assert.match(g.text, /<meta property="og:title" content="Sign in to see the Prize shop">/);
  assert.match(g.text, /<meta property="og:image" content="http:\/\/site\.test\/og\/page\.png">/, "the generic card");
  assert.match(g.headers.get("x-robots-tag") || "", /noindex/);
  assert.doesNotMatch(g.text, /"real"/);
  // invite-only
  await runQuery("INSERT INTO invite_settings (k, v, updated) VALUES ('signups', '\"invite\"', 1) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
  await INV._reload();
  g = await go("/shop");
  assert.match(g.text, /🎟️<\/span>Got an invite\?<\/a>/);
  assert.match(g.text, /Sign-ups are invite-only right now/);
  assert.doesNotMatch(g.text, />Sign up</);
  await runQuery("DELETE FROM invite_settings WHERE k = 'signups'");
  await INV._reload();
  // the navbar on the gate page hides the shop too
  assert.doesNotMatch(g.text.slice(g.text.indexOf('<nav class="navbar">'), g.text.indexOf("</nav>")), /href="\/shop"/);
  await setOne("shop", true);
});

const navOf = (html) => html.slice(html.indexOf('<nav class="navbar">'), html.indexOf("</nav>", html.indexOf('<nav class="navbar">')));
const footOf = (html) => html.slice(html.indexOf('<template id="siteFootTpl">'), html.indexOf("</template>"));
test("navbar (top bar, More, ☰) + footer: off sections are hidden for guests and kept for members", async () => {
  const off = ["markets", "shop", "search", "wheel", "help", "plex", "achievements", "economy", "howpat", "casino", "pads", "feed"];
  let html = (await go("/__layout")).text;
  for (const h of ["/markets", "/shop", "/search", "/help", "/plex", "/achievements", "/economy", "/p", "/feed", "/stage", "/submit"]) {
    assert.ok(navOf(html).includes('href="' + h + '"') || footOf(html).includes('href="' + h + '"'), "on: " + h + " is linked");
  }
  assert.match(navOf(html), /class="nav-search"/);
  assert.match(navOf(html), /title="Wheel"/);
  await adminPost({ changes: Object.fromEntries(off.map((k) => [k, false])) });
  html = (await go("/__layout")).text;
  const nav = navOf(html), foot = footOf(html);
  for (const h of ["/markets", "/shop", "/help", "/plex", "/achievements", "/economy", "/p", "/feed", "/stage", "/submit", "/casino/holdem", "/poker", "/blackjack", "/casino/blackjack"]) {
    assert.ok(!nav.includes('href="' + h + '"'), "nav hides " + h);
    assert.ok(!foot.includes('href="' + h + '"'), "footer hides " + h);
  }
  assert.doesNotMatch(nav, /action="\/search"|href="\/search"/, "no search box / button / menu search");
  assert.doesNotMatch(nav, /title="Wheel"/, "the Wheel (its signed-out link is /login)");
  assert.match(nav, /href="\/wagers"/, "a section that's on stays");
  assert.match(nav, /href="\/gtf"/);
  assert.match(nav, /class="nav-signin"/, "Sign In stays");
  assert.match(foot, /href="\/terms"/, "the legal links stay");
  // a member sees everything
  html = (await go("/__layout", { as: "mem" })).text;
  for (const h of ["/markets", "/shop", "/help", "/p", "/feed", "/stage"]) assert.ok(navOf(html).includes('href="' + h + '"') || footOf(html).includes('href="' + h + '"'), "member: " + h);
  assert.match(navOf(html), /class="nav-search"/);
  assert.match(navOf(html), /title="Wheel"/);
  await setAll(true);
});

test("homepage: the tiles, the now card, Hot on PATV, Top Pads, the wheel box and Top frogs follow the switches for guests", async () => {
  const BM = require(path.join(repo, "boostmark"));
  const UL = require(path.join(repo, "userlinks"));
  const render = (locals) => ejs.renderFile(path.join(repo, "views", "home.ejs"), Object.assign({
    username: null, me: null, mine: null, rooms: [], room: null, roomLive: null, stage: { active: false }, top: [{ username: "topfrog", level: 9, points_balance: 5 }],
    tops: [{ id: "B", slug: "b", name: "Bee", count: 12, micCount: 2, boost: 0 }],
    S: { lotto: { jackpot: 1000, open: true }, closing: [{ id: 5, q: "Will it rain?", closes: 9e9 }], topBounties: [{ id: 3, task: "Sing", pot: 10 }], markets: 1, bounties: 1, members: 10 },
    story: { rooms: [], caps: [], room: null, signed: false }, hot: { posts: [], signed: false }, fx: {}, roomOnStage: false, stageAdmin: null,
    frontInfo: { id: "B", slug: "b", title: "Bee", pinned: false, owner: null, boost: 0 }, pepeHere: true, featuredPrice: 0,
    slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "", boostMark: BM.boostMark, ul: UL,
  }, locals));
  const guest = { cookies: {} }, member = { cookies: {}, user: { userId: "u_mem" } };
  let html = await render(GA.viewHelpers(guest));
  for (const h of ['href="/markets"', 'href="/lotto"', 'href="/markets/5"', 'href="/bounties/3"', 'id="hhH"', 'id="tpH"', 'id="wheelBox"', 'id="tfH"', 'href="/rankings"', 'id="stageShow"']) assert.ok(html.includes(h), "on: " + h);
  await adminPost({ changes: { markets: false, lotto: false, bounties: false, feed: false, pads: false, wheel: false, members: false, rankings: false } });
  html = await render(GA.viewHelpers(guest));
  for (const h of ['href="/markets"', 'href="/lotto"', 'href="/markets/5"', 'href="/bounties/3"', 'id="hhH"', 'id="tpH"', 'id="wheelBox"', 'id="tfH"', 'href="/rankings"',
                   'id="stageShow"', 'href="/p"', 'href="/stage', 'href="/p/b"']) assert.ok(!html.includes(h), "guest hides " + h);
  assert.match(html, /🤝/, "an open section's tile stays (Wagers)");
  assert.match(html, /home\.now|class="card now"/);
  html = await render(GA.viewHelpers(member));
  for (const h of ['href="/markets"', 'href="/markets/5"', 'id="tpH"', 'id="wheelBox"', 'id="tfH"']) assert.ok(html.includes(h), "member keeps " + h);
  await setAll(true);
});

test("the feed's live link cards: an off section's items are null for guests, kept for members", async () => {
  await runQuery("CREATE TABLE IF NOT EXISTS markets (id INTEGER PRIMARY KEY, data TEXT, updated INTEGER, pad TEXT)");
  await runQuery("INSERT OR REPLACE INTO markets (id, data, updated, pad) VALUES (5, ?, 1, NULL)",
                 [JSON.stringify({ id: 5, question: "Will it rain?", status: "open", options: [{ name: "Yes", pool: 0 }, { name: "No", pool: 0 }], bets: [] })]);
  const before = await go("/api/embeds?refs=M5");
  assert.equal(before.status, 200);
  const shows = !!(before.json.items && before.json.items.M5);
  assert.ok(shows, "the market card shows while Markets is on (" + JSON.stringify(before.json).slice(0, 200) + ")");
  await setOne("markets", false);
  const g = await go("/api/embeds?refs=M5,BT3");
  assert.equal(g.status, 200, "the endpoint itself stays (other sections' cards)");
  assert.equal(g.json.items.M5, null);
  assert.ok("BT3" in g.json.items);
  const m = await go("/api/embeds?refs=M5", { as: "mem" });
  assert.equal(!!m.json.items.M5, shows, "a member gets what they got before");
  assert.equal(GA.hiddenFor({ cookies: {}, query: {}, get: () => "" }, "markets"), true);
  assert.equal(GA.hiddenFor({ cookies: {}, user: { userId: "x" } }, "markets"), false);
  await setOne("markets", true);
});

test("admin: capability, same-origin, validation, audit {section, from, to}, the stale-card check", async () => {
  assert.equal((await go("/api/admin/guest-access")).status, 401);
  assert.equal((await go("/api/admin/guest-access", { as: "mem" })).status, 403);
  assert.equal((await go("/api/admin/guest-access", { as: "stf" })).status, 403, "Staff don't hold auth.guest_access by default");
  const v = await go("/api/admin/guest-access", { as: "adm" });
  assert.equal(v.status, 200);
  assert.deepEqual(v.json.sections.map((s) => s.key), ["watch", "play", "you", "shop", "info"]);
  assert.equal(v.json.sections.flatMap((s) => s.groups).length, GA.KEYS.length);
  assert.ok(v.json.sections[0].groups[0].label && v.json.sections[0].groups[0].covers);
  assert.equal(v.json.mode, "open");
  // POST rules
  assert.equal((await go("/api/admin/guest-access", { as: "adm", method: "POST", body: { changes: { shop: false } } })).status, 403, "no X-Requested-With");
  assert.equal((await adminPost({ changes: { shop: false } }, "adm", { origin: "https://evil.example" })).status, 403, "another site");
  assert.equal((await adminPost({ changes: { shop: false } }, "mem")).status, 403);
  assert.equal((await adminPost({ changes: { nope: false } })).status, 400);
  assert.equal((await adminPost({ changes: { shop: "maybe" } })).status, 400);
  assert.equal((await adminPost({ changes: {} })).status, 400);
  assert.equal((await adminPost({ changes: [] })).status, 400);
  assert.equal(GA.isOn("shop"), true, "nothing saved by a refused request");
  const before = (await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'guest_access'"))[0].n;
  const r = await adminPost({ changes: { shop: false, casino: false, wagers: true }, reason: "  sweeps\tlaw check  ", expect: { shop: true, casino: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.changed.sort(), ["casino", "shop"], "wagers was already on - no change, no row");
  const rows = await getQuery("SELECT * FROM admin_audit WHERE action = 'guest_access' ORDER BY id DESC LIMIT 2");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'guest_access'"))[0].n, before + 2);
  for (const row of rows) {
    const d = JSON.parse(row.detail);
    assert.ok(["shop", "casino"].includes(d.section));
    assert.equal(d.from, true); assert.equal(d.to, false);
    assert.equal(row.admin_id, "u_adm");
    assert.equal(row.reason, "sweeps law check");
  }
  const saved = await getQuery("SELECT k, guest_open, updated FROM guest_access WHERE k IN ('shop', 'casino') ORDER BY k");
  assert.deepEqual(saved.map((x) => [x.k, x.guest_open, x.updated]), [["casino", 0, clockAt], ["shop", 0, clockAt]]);
  // a stale card: it loaded shop ON, someone turned it off since
  const stale = await adminPost({ changes: { shop: true }, expect: { shop: true } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "E_STALE");
  assert.equal(GA.isOn("shop"), false, "nothing saved");
  const log = (await go("/api/admin/guest-access", { as: "adm" })).json.audit;
  assert.ok(log.some((a) => a.detail && a.detail.section === "shop" && a.detail.to === false));
  await setAll(true);
});

test("settings come from memory with a 30 s re-read: another process's change lands, no restart", async () => {
  assert.equal(GA.isOn("bingo"), true);
  await runQuery("INSERT INTO guest_access (k, guest_open, updated) VALUES ('bingo', 0, 1) ON CONFLICT(k) DO UPDATE SET guest_open = 0");
  assert.ok(real(await go("/bingo")), "not yet re-read");
  clockAt += GA.RELOAD_MS + 1000;
  await go("/healthz");                                   // any request starts the re-read
  for (let i = 0; i < 50 && GA.isOn("bingo"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(GA.isOn("bingo"), false);
  assert.ok(!real(await go("/bingo")));
  await setOne("bingo", true);
  assert.ok(real(await go("/bingo")), "this process's own change is immediate");
});

test("the admin card + nav link: only for someone who holds auth.guest_access; the card's script writes no HTML", async () => {
  const SP = require(path.join(repo, "siteperms"));
  const render = (cls) => ejs.renderFile(path.join(repo, "views", "admin", "users.ejs"),
    { title: "T", user: "x", section: "users", isAdmin: cls === "Admin", me: { userId: "x", class: cls }, errors: [], success: [],
      can: (k, u) => SP.can(u !== undefined ? u : { class: cls }, k) });
  const a = await render("Admin");
  assert.match(a, /id="guests"/);
  assert.match(a, /admin-guests\.js/);
  assert.match(a, /href="#guests">Guest access</);
  const s = await render("Staff");
  assert.doesNotMatch(s, /id="guests"/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "admin-guests.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML/);
  // every section has its label, what it covers and a translated name for the gate page
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const g of GA.GROUPS) {
    assert.ok(g.label && g.covers, g.key);
    assert.ok(en["guest.s." + g.key], "guest.s." + g.key);
    assert.ok(["watch", "play", "you", "shop", "info"].includes(g.sec));
  }
});

test("index.js wiring: the middleware runs after the language middleware and before every route module", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const mw = src.indexOf("app.use(guestAccess.middleware)");
  assert.ok(mw > 0);
  assert.ok(src.indexOf("app.use(i18n.middleware(cookieUserId))") < mw, "after i18n (the page is translated)");
  assert.ok(src.indexOf("app.use(loginSessions.gate)") < mw, "after the sessions gate (a revoked login is signed out)");
  assert.ok(src.indexOf("app.use(botkeys.middleware)") < mw, "after the bot keys (a key caller passes)");
  for (const r of ['require("./home").register', 'app.use("/public"', 'require("./markets").register', 'shop.register(app', 'require("./casino/routes").register']) {
    assert.ok(src.indexOf(r) > mw, r + " comes after the gate");
  }
  assert.match(src, /guestAccess\.register\(app, \{ addUser \}\)/);
  // the profile's Posts tab follows Feed & Hop for guests (and in the owner's visitor preview)
  assert.match(src, /guestOff: preview \? !guestAccess\.isOn\("feed"\) : guestAccess\.hiddenFor\(req, "feed"\)/);
  // the homepage notes the pads it shows a guest (their reads stay open while Pads is off)
  assert.match(fs.readFileSync(path.join(repo, "home.js"), "utf8"), /if \(!viewer\) \{ try \{ require\("\.\/guestaccess"\)\.noteHome\(\[\{ id: front\.id, slug: frontInfo && frontInfo\.slug \}, room && \{ id: room\.id, slug: room\.slug \}\]\)/);
});
