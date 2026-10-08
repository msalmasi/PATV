// 1.99ec: the pad Feed tab + composer + create-post page.
//   - the Feed tab's "N new" badge (public/js/pad-tabs.js): count pill + dot while another tab shows, a first visit
//     counts the last 3 days, opening the Feed clears it for next time (and flashes what was new)
//   - the Feed tab is one column (no Rules / blurb side cards); the Rules chip and #rules go to About
//   - the composer folds into a "✏️ Create post" bar on pad pages, /feed and profiles; open on /submit
//   - /submit and /p/<pad>/submit (signed-out redirect, pad preselect, unknown pad, ?pad=), the navbar "✏️ Post"
//   - the Live tab's side-card headers, the Manage card's one-row header, the story viewer's footer button
//   NODE_PATH=G:/PATV/node_modules node --test test/feed-compose.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feed-compose-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const ejs = require("ejs");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const pads = require(path.join(repo, "pads"));
const T = require(path.join(repo, "public", "js", "pad-tabs.js"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM_B = "plant_based_chatting";
let base, server, U = {};
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", name + "cf"]);
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
  U.owner = await mkUser("plantowner");
  U.alice = await mkUser("alice");
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  pads.register(app);
  web.register(app, { addUser, isBotToken: (x) => x === "bot" });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (x) => x === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

async function get(url, u) {
  const r = await fetch(base + url, { headers: u ? { "x-test-user": u.userId } : {}, redirect: "manual" });
  return { status: r.status, text: await r.text(), location: r.headers.get("location") };
}
const padSlug = () => rooms.getCached(ROOM_B).slug;
// the composer's form tag
const formTag = (html) => { const i = html.indexOf('id="fcForm"'); return i < 0 ? "" : html.slice(html.lastIndexOf("<form", i), html.indexOf(">", i) + 1); };

// ───────────────────────── the badge (pad-tabs.js) ─────────────────────────
test("badge helpers: newIds follows newCount; '10+ new' only when every known post is new and there are more", () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const posts = [{ id: "a", created: now - 1000 }, { id: "b", created: now - 3600e3 }, { id: "c", created: now - 5 * 86400e3 }];
  assert.deepEqual(T.newIds(posts, now - 2000, now), ["a"]);
  assert.deepEqual(T.newIds(posts, null, now), ["a", "b"], "first visit: the last 3 days");
  assert.equal(T.newIds(posts, null, now).length, T.newCount(posts, null, now));
  assert.equal(T.badgeText(0, 3, false), "");
  assert.equal(T.badgeText(2, 3, true), "2 new");
  assert.equal(T.badgeText(10, 10, true), "10+ new");
  assert.equal(T.badgeText(10, 10, false), "10 new");
});

// a tiny DOM: enough of document / window for PATVPadTabs.init
function fakePage({ search = "", hash = "", storage = {} } = {}) {
  const els = {};
  const mk = (id, attrs = {}) => {
    const e = { id, hidden: false, tabIndex: 0, textContent: "", attrs: Object.assign({}, attrs), cls: new Set(), listeners: {},
      getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, focus() {}, scrollIntoView() {}, querySelector() { return null; }, contains() { return false; },
      classList: null };
    e.classList = { add: (...c) => c.forEach((x) => e.cls.add(x)), remove: (...c) => c.forEach((x) => e.cls.delete(x)), contains: (c) => e.cls.has(c), toggle: (c, on) => (on ? e.cls.add(c) : e.cls.delete(c)) };
    els[id] = e;
    return e;
  };
  const btns = ["live", "feed", "about"].map((t) => mk("padTab-" + t, { "data-tab": t, "aria-controls": "padPanel-" + t, role: "tab" }));
  ["live", "feed", "about"].forEach((t) => mk("padPanel-" + t));
  mk("padFeedNew"); els.padFeedNew.hidden = true;
  mk("padFeedDot"); els.padFeedDot.hidden = true;
  const bar = mk("padTabs");
  bar.querySelectorAll = () => btns;
  bar.querySelector = (sel) => btns.find((b) => sel.includes('"' + b.attrs["data-tab"] + '"')) || null;
  const timers = [];
  const ls = { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } };
  const doc = { getElementById: (id) => els[id] || null, addEventListener() {}, dispatchEvent() {} };
  const win = { document: doc, localStorage: ls, location: { search, hash, href: "http://x/p/pad" + search + hash }, history: null, addEventListener() {},
                CustomEvent: function () {} };
  global.CustomEvent = function () {};
  const realSet = global.setTimeout;
  return { els, storage, win, timers, realSet };
}
// pad-tabs.js reads its window at load: run a fresh copy against the fake page
function loadTabs(win) {
  const src = fs.readFileSync(path.join(repo, "public", "js", "pad-tabs.js"), "utf8");
  const sandbox = { window: win, globalThis: win, module: undefined, setTimeout: () => 0, clearTimeout: () => {}, URL, CustomEvent: function () {} };
  require("vm").runInNewContext(src.replace("typeof window !== 'undefined' ? window : globalThis", "window"), sandbox);
  return win.PATVPadTabs;
}

test("badge: a first visit on the Live tab shows the count pill AND the dot; opening the Feed clears it for next time", () => {
  const now = Date.now();
  const posts = [{ id: "a", created: now - 60e3 }, { id: "b", created: now - 3600e3 }, { id: "old", created: now - 9 * 86400e3 }];
  const P = fakePage();
  const tabs = loadTabs(P.win).init({ slug: "pad", platform: "camfrog", active: true, posts, more: false });
  assert.equal(tabs.current(), "live");
  assert.equal(P.els.padFeedNew.hidden, false, "pill visible");
  assert.equal(P.els.padFeedNew.textContent, "2 new");
  assert.equal(P.els.padFeedDot.hidden, false, "dot visible while Live shows");
  assert.match(P.els["padTab-feed"].attrs["aria-label"], /Feed, 2 new posts/);
  assert.equal(P.storage["patvPadFeedSeen:pad"], undefined, "not seen yet");
  tabs.show("feed", {});
  assert.ok(Number(P.storage["patvPadFeedSeen:pad"]) >= now, "seen stored when the Feed shows");
  assert.equal(P.els.padFeedDot.hidden, true, "no dot on the open Feed tab");
  assert.ok(P.els.padFeedNew.cls.has("is-flash") && P.els.padFeedNew.textContent === "2 new", "the pill stays a moment, flashed");
  tabs.show("live", {});
  assert.equal(P.els.padFeedNew.hidden, true, "back on Live: nothing new any more");
  // the next visit: nothing new
  const P2 = fakePage({ storage: P.storage });
  loadTabs(P2.win).init({ slug: "pad", platform: "camfrog", active: true, posts, more: false });
  assert.equal(P2.els.padFeedNew.hidden, true); assert.equal(P2.els.padFeedDot.hidden, true);
});

test("badge: when the Feed opens by default (quiet room) the new posts are still shown once, then cleared", () => {
  const now = Date.now();
  const P = fakePage();
  const tabs = loadTabs(P.win).init({ slug: "q", platform: "camfrog", active: false, posts: [{ id: "a", created: now - 1000 }], more: false });
  assert.equal(tabs.current(), "feed");
  assert.equal(P.els.padFeedNew.hidden, false); assert.equal(P.els.padFeedNew.textContent, "1 new");
  assert.ok(P.els.padFeedNew.cls.has("is-flash"));
  assert.ok(P.storage["patvPadFeedSeen:q"], "cleared for next time");
  assert.equal(P.els.padFeedDot.hidden, true);
});

test("#rules opens About (the rules live there now)", () => {
  const P = fakePage({ hash: "#rules" });
  const tabs = loadTabs(P.win).init({ slug: "r", platform: "camfrog", active: true, posts: [], more: false });
  assert.equal(tabs.current(), "about");
});

// ───────────────────────── the pad page ─────────────────────────
test("pad page: Feed tab is one column (no side cards), Rules chip -> About, badge + dot markup, collapsed composer, navbar Post preselects the pad", async () => {
  const s = padSlug();
  const r = await get("/p/" + s, U.alice);
  assert.equal(r.status, 200);
  const html = r.text;
  const feedPanel = html.slice(html.indexOf('id="padPanel-feed"'), html.indexOf('id="padPanel-about"'));
  assert.match(feedPanel, /<div class="fcol">/);
  assert.match(html, /\.rm \.fcol \{ width: 100%; min-width: 0; \}/, "1.99ef: the Feed card is full width (lines up with the header / tab bar), no 760px cap");
  assert.doesNotMatch(feedPanel, /class="fside|<aside|About this pad ›|A pad on Public Access TV/, "no side column");
  assert.doesNotMatch(feedPanel, /class="rf-rules"/, "no Rules card in the Feed");
  assert.match(html, /<a role="menuitem" href="\?tab=about#rules" data-pad-tab="about" data-open="rules">📜 Rules<\/a>/, "Rules: the header's ⋯ menu -> About");
  const about = html.slice(html.indexOf('id="padPanel-about"'));
  assert.match(about, /<details class="rf-rules" id="rules" open>/, "the #rules anchor is in About");
  assert.equal((html.match(/id="rules"/g) || []).length, 1, "one #rules anchor");
  assert.match(html, /<span class="pnewdot" id="padFeedDot" aria-hidden="true" hidden><\/span>Feed <span class="pnew" id="padFeedNew" hidden><\/span>/);
  assert.match(html, /pad-tabs\.js\?v=4/);
  // the composer: folded into its bar, the pad named
  assert.match(feedPanel, /id="fcBar"/);
  assert.match(feedPanel, new RegExp("Post something to p/" + s + "…"));
  for (const k of ["text", "image", "link"]) assert.match(feedPanel, new RegExp('data-fc-open="' + k + '"'));
  assert.match(formTag(feedPanel), / hidden /, "the full form starts hidden");
  assert.match(feedPanel, /id="fcMin"/, "and can be folded back");
  // the composer's rules line switches to About on this page
  assert.match(feedPanel, new RegExp('href="/p/' + s + '\\?tab=about#rules" target="_blank" rel="noopener" data-pad-tab="about" data-open="rules"'));
  // the navbar
  assert.match(html, new RegExp('<a href="/p/' + s + '/submit" class="nav-post" title="Create a post in p/' + s + '">'));
  assert.ok(html.indexOf('class="nav-post"') < html.indexOf('class="nav-golive"'), "Post sits before Go live");
  assert.match(html, /feed\.css\?v=17/); assert.match(html, /feed-composer\.js\?v=13/); assert.match(html, /stories\.js\?v=7/);
});

test("pad page signed out: a sign-in bar instead of the composer; About's analytics link is a button", async () => {
  const r = await get("/p/" + padSlug());
  assert.match(r.text, /<a class="fc-bar fc-bar-out" href="\/login\?next=/);
  assert.doesNotMatch(r.text, /id="fcForm"/);
  const html = await ejs.renderFile(path.join(repo, "views", "room.ejs"), {
    user: null, signedIn: false, linked: false, room: { name: "P", slug: "p", count: 0, live: false, topic: "", platform: "camfrog", description: "", camfrogName: "P" },
    initial: null, padTabs: { tabs: ["live", "about"], initial: "about", active: false, camfrog: true, posts: [] }, latest: [], stage: {}, roomStage: null, schedule: null,
    manage: false, feed: null, embeds: require(path.join(repo, "stageembed")), host: "x", roomAnalytics: "/p/p/analytics", escapeFn: (s) => String(s) });
  // 1.99el: Analytics is its own About card (was a details-list row); signed out = the sign-in prompt + the button
  assert.doesNotMatch(html, /<dt>Analytics<\/dt>/);
  assert.match(html, /🔒 Pad analytics are for signed-in members[\s\S]*<a class="ab-btn" href="\/p\/p\/analytics">See full analytics ›<\/a>/);
});

// ───────────────────────── /feed and the profile Posts tab ─────────────────────────
test("/feed: the composer is collapsed too ('Create a post…', no pad picked); the navbar Post goes to /submit", async () => {
  const r = await get("/feed", U.alice);
  assert.equal(r.status, 200);
  assert.match(r.text, /id="fcBar"/);
  assert.match(r.text, /<span class="fc-bar-ph">Create a post…<\/span>/);
  assert.match(formTag(r.text), / hidden /);
  assert.match(r.text, /<a href="\/submit" class="nav-post" title="Create a post">/);
});

test("profile Posts composer partial: collapsed, 'Post something to your profile…'", async () => {
  const viewer = await store.account(U.alice.userId);
  const composer = await web.composerFor({ ...viewer, display: viewer.username }, "profile");
  const html = await ejs.renderFile(path.join(repo, "views", "partials", "feed-composer.ejs"), { composer, next: "/u/alice/posts", fx: web.fx });
  assert.match(html, /Post something to your profile…/);
  assert.match(formTag(html), / hidden /);
  const open = await ejs.renderFile(path.join(repo, "views", "partials", "feed-composer.ejs"), { composer, next: "/submit", fx: web.fx, expanded: true });
  assert.doesNotMatch(open, /id="fcBar"|id="fcMin"/);
  assert.doesNotMatch(formTag(open), / hidden /);
  assert.match(formTag(open), /data-expanded="1"/);
});

// ───────────────────────── /submit ─────────────────────────
test("/submit: signed out -> login with next=; signed in -> the open composer with a pad picker, nothing picked", async () => {
  let r = await get("/submit");
  assert.equal(r.status, 302); assert.equal(r.location, "/login?next=%2Fsubmit");
  r = await get("/submit", U.alice);
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Create a post<\/title>/);
  assert.match(r.text, /<h1>✏️ Create a post<\/h1>/);
  assert.doesNotMatch(r.text, /id="fcBar"/, "no bar: the form is open");
  assert.match(formTag(r.text), /data-expanded="1"/); assert.doesNotMatch(formTag(r.text), / hidden /);
  assert.match(r.text, /class="fc-comm" data-empty/, "no pad preselected");
  assert.match(r.text, /name="community" value="plant_based_chatting"/, "the pad picker lists the pads");
  assert.match(r.text, /feed-composer\.js\?v=13/);
});

test("/p/<pad>/submit preselects that pad; signed out -> login next=; unknown pad 404; /submit?pad= -> /p/<pad>/submit", async () => {
  const s = padSlug();
  let r = await get("/p/" + s + "/submit");
  assert.equal(r.status, 302); assert.equal(r.location, "/login?next=" + encodeURIComponent("/p/" + s + "/submit"));
  r = await get("/p/" + s + "/submit", U.alice);
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp("<title>Create a post in p/" + s + "</title>"));
  assert.match(r.text, /name="community" value="plant_based_chatting"[^>]* checked>/, "the pad is picked");
  assert.match(formTag(r.text), /data-home="plant_based_chatting"/);
  assert.match(r.text, new RegExp('<a href="/p/' + s + '/submit" class="nav-post"'), "the navbar stays on this pad");
  r = await get("/p/no-such-pad-zz/submit", U.alice);
  assert.equal(r.status, 404); assert.match(r.text, /No such pad/);
  r = await get("/p/no-such-pad-zz/submit");
  assert.equal(r.status, 404, "unknown pad: 404 before any sign-in");
  r = await get("/submit?pad=" + s, U.alice);
  assert.equal(r.status, 302); assert.equal(r.location, "/p/" + s + "/submit");
  r = await get("/submit?pad=" + encodeURIComponent('"><x'), U.alice);
  assert.equal(r.status, 302); assert.ok(!/[<>"]/.test(r.location), "escaped");
});

test("posting from /submit opens the new post (the composer's existing rule: off a pad / profile page -> d.url)", () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "feed-composer.js"), "utf8");
  assert.match(js, /else if \(\/\^\\\/p\\\/\[\^\/\]\+\\\/\?\$\/\.test\(u\.pathname\)\)/, "only /p/<slug> itself stays on the pad");
  assert.match(js, /else location\.href = d\.url;/);
  // the bar: opens in place with the clicked kind; a restored draft opens it; Hide folds it (the draft is saved first)
  assert.match(js, /function expand\(kind\)/);
  assert.match(js, /if \(pic\) pic\.click\(\);/);
  assert.match(js, /setOpen\(true\);\s+\/\/ 1\.99ec: a draft opens the folded form/);
  assert.match(js, /saveNow\(\);\s+setOpen\(false\);/);
});

// ───────────────────────── Live tab polish, story viewer ─────────────────────────
test("Live side cards: one-line titles; Manage card header is title · chip · toggle in one row; roster buttons are fixed squares", async () => {
  const lat = fs.readFileSync(path.join(repo, "views", "partials", "pad-latest.ejs"), "utf8");
  assert.match(lat, /<span class="ht">📝 Latest posts<\/span><small><a href="\?tab=feed" data-pad-tab="feed">Open feed ›<\/a><\/small>/);
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /<h2 id="pplH"><span class="ht">In the Camfrog room<\/span>/);
  assert.match(room, /\.rm \.side \.card > h2 > \.ht \{ white-space: nowrap;/);
  assert.match(room, /\.rm \.people \.ic > \* \{ display: inline-grid; place-items: center; width: 26px; height: 26px;/);
  const mod = fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8");
  assert.match(mod, /var hr = el\('span', 'pm-hr'\); h\.appendChild\(hr\);/);
  assert.match(mod, /hr\.appendChild\(tog\);/);
  const css = fs.readFileSync(path.join(repo, "public", "css", "room-mod.css"), "utf8");
  assert.match(css, /\.pm \.pm-hr \{ display: inline-flex; align-items: center; gap: 5px; flex: none; margin-left: auto; flex-wrap: nowrap; \}/);
});

test("story viewer: the footer button says what it opens", () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "stories.js"), "utf8");
  assert.doesNotMatch(js, /'Capture page'/);
  assert.match(js, /var noun = it\.kind === 'clip' \? 'clip' : it\.kind === 'photo' \? 'snap' : '';/);
  assert.match(js, /noun \? 'Open ' \+ noun \+ ' ›' : 'Open ›'/);
  assert.match(js, /'s page to share or download'/);
});
