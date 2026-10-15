// Offline tests for the 1.99za layout pass: the pad page puts the chat first (compact header, slim Stage / Go live,
// (1.99zv: the cam strip above the chat, under the stage) room audio under the chat heading, then On the mic -> In the chatroom -> latest posts -> Manage
// room), the nav's "My pads" (owned + followed) and the /p "Following" section.
//   node --test test/pad-layout-order.test.js      (needs the repo's node_modules)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padlayout-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const ejs = require("ejs");
const jwt = require("jsonwebtoken");
const { runQuery } = require(path.join(repo, "dbUtils"));
const follows = require(path.join(repo, "follows"));
const rooms = require(path.join(repo, "rooms"));
const padowner = require(path.join(repo, "padowner"));
const bridge = require(path.join(repo, "bridge"));

const ROOM = { name: "Houseplants", slug: "plant_based_chatting", count: 2, live: true, topic: "Grow stuff", platform: "camfrog",
               description: "Plants and chat", owner: "pb", ownerUser: "pb", camfrogName: "Plant Based Chatting" };
const latest = [{ id: "p1", created: Date.now() - 60e3, title: "Hello pad", text: "", author: "Bob", nsfw: false }];
const renderRoom = (extra) => ejs.renderFile(path.join(repo, "views", "room.ejs"), Object.assign({
  user: "u", signedIn: true, linked: true, room: ROOM, initial: { room: {}, members: [], mic: [], feed: [], cursor: 0 }, onStage: false, stage: {}, latest,
  padTabs: { tabs: ["live", "about"], initial: "live", active: true, camfrog: true, posts: [] },
}, extra)).then((h) => h.replace(/\r\n/g, "\n"));
const at = (html, needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, "rendered: " + needle); return i; };

test("Live tab order: chat (room audio under its heading) -> On the mic -> In the chatroom -> latest posts -> Manage room -> story", async () => {
  const html = await renderRoom({});
  const live = html.slice(html.indexOf('id="padPanel-live"'), html.indexOf('id="padPanel-about"'));
  const order = ['id="rmChat"', 'id="rmAudioBox"', 'id="rmFeed"', 'id="rmCompose"', 'id="rmMicCard"', 'id="rmPplCard"', "📝 Latest posts", 'id="rmMod"'];
  const pos = order.map((n) => at(live, n));
  for (let i = 1; i < pos.length; i++) assert.ok(pos[i - 1] < pos[i], order[i - 1] + " before " + order[i]);
  // the audio player sits in the chat card, right under the heading (not under On the mic any more)
  const chat = live.slice(at(live, 'id="rmChat"'), at(live, 'id="rmFeed"'));
  assert.match(chat, /<h2 id="chatH">[\s\S]*<div class="topic" id="rmTopic"[^>]*>Grow stuff<\/div>[\s\S]*<div class="rm-audio" id="rmAudioBox"><\/div>/);
  const mic = live.slice(at(live, 'id="rmMicCard"'), at(live, 'id="rmPplCard"'));
  assert.doesNotMatch(mic, /rmAudioBox/);
  assert.equal((html.match(/id="rmAudioBox"/g) || []).length, 1, "one audio box");
  // the chat column and the side column: chat left, mic / people / posts / manage right
  assert.match(live, /<div class="grid rm-live">\s*<div class="rm-main">\s*<section class="card rm-chat" id="rmChat"/);
  assert.match(live, /<\/section>\s*<\/div>\s*<aside class="side">\s*<section class="card rm-mic" id="rmMicCard"/);
  // 1.99zv: the cam strip (hidden until a cam is pinned) sits ABOVE the chat, under the stage / Go live cards
  assert.ok(at(live, 'id="rmGoLive"') < at(live, 'id="rmStrip"') && at(live, 'id="rmStrip"') < at(live, 'id="rmChat"'), "go live -> strip -> chat");
  assert.match(live, /<section class="card cam-strip" id="rmStrip"[^>]*hidden><\/section>/);
  // the stage + go-live cards come before the chat, the header carries no description
  assert.ok(at(live, 'id="rmStage"') < at(live, 'id="rmGoLive"') && at(live, 'id="rmGoLive"') < at(live, 'id="rmChat"'));
});

test("the cam strip insertion point sits above the chat, under the stage / Go live cards (source)", () => {
  const src = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  const golive = src.indexOf('id="rmGoLive"'), slot = src.indexOf("include('partials/cam-strip'"), grid = src.indexOf('<div class="grid rm-live">'), chat = src.indexOf('id="rmChat"');
  assert.ok(golive > 0 && slot > golive && grid > slot && chat > grid, "go live -> strip -> chat grid");
  assert.equal(src.split("include('partials/cam-strip'").length, 2, "one insertion point");
  // compact on phones: zero height while empty, one short swipe row with tiles
  const part = fs.readFileSync(path.join(repo, "views", "partials", "cam-strip.ejs"), "utf8");
  assert.match(part, /\.cam-strip\[hidden\] \{ display: none; \}/);
  assert.match(part, /@media \(max-width: 700px\)[\s\S]*scroll-snap-type: x mandatory/);
});

test("story strip: at the end of the Live tab when there are captures, never above the tabs", async () => {
  const feed = { caps: [{ id: "c1", kind: "snap", url: "/x.webp", ts: Date.now(), by: "bob" }], storyRooms: [], room: "R", viewer: null, follow: null, rules: null, mod: {} };
  let html;
  try { html = await renderRoom({ feed }); } catch (e) { html = null; }
  const src = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.ok(src.indexOf('class="card rm-story"') > src.indexOf('id="rmMod"'), "after Manage room in the source");
  assert.ok(src.indexOf('class="card rm-story"') < src.indexOf('id="padPanel-feed"'), "inside the Live panel");
  assert.ok(src.indexOf('class="card rm-story"') > src.indexOf('id="padTabs"'), "not above the tab bar");
  if (html) assert.ok(!html.includes('rm-story') || html.indexOf('rm-story') > html.indexOf('id="padTabs"'));
});

test("slim Go live + hidden off-air Stage: CSS only, so the 30 s schedule refresh opens / slims the card by itself", async () => {
  const html = await renderRoom({});
  const SL = ".rm .golive-card:not(:has(.srow, .upnext li, .plexq:not([hidden])))";
  assert.ok(html.includes(SL + " { padding: 8px 12px; }"));
  assert.ok(html.includes(SL + " .rs { display: none; }"), "On now / Coming up / Queue hide while all empty");
  assert.ok(html.includes(SL + " .gl-h { position: absolute;"), "the heading stays for screen readers");
  assert.ok(html.includes(".rm .stage.is-off:not(:has(.stabs > *)) { display: none; }"));
  assert.match(html, /<span class="l-full">🎥 Go live here<\/span><span class="l-short">🎥 Go live<\/span>/);
  assert.match(html, /@media \(max-width: 520px\) \{[\s\S]*?\.sact \.l-short \{ display: inline; \}/);
  assert.match(html, /@media \(max-width: 860px\) \{ \.rm \.feed \{ height: 50vh; min-height: 260px; \} \}/, "a shorter chat on phones so the compose box fits");
});

test("follows.followedPadIds + the navPads middleware: newest follow first, signed-in page views only", async () => {
  await follows.init();
  const t0 = Date.now();
  for (const [i, id] of ["A.Room", "B.Room", "C.Room"].entries()) {
    await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'room', ?, ?)", ["u1", id, t0 + i]);
  }
  await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'user', ?, ?)", ["u1", "u2", t0]);
  assert.deepEqual(await follows.followedPadIds("u1"), ["C.Room", "B.Room", "A.Room"]);
  assert.deepEqual(await follows.followedPadIds(null), []);
  const run = (req) => new Promise((done) => { const res = { locals: {} }; follows.navPads(req, res, () => done(res.locals)); });
  const cookie = { jwt: jwt.sign({ userId: "u1" }, "test-secret") };
  assert.deepEqual((await run({ method: "GET", path: "/p", cookies: cookie })).followedPadIds, ["C.Room", "B.Room", "A.Room"]);
  assert.equal((await run({ method: "GET", path: "/api/x", cookies: cookie })).followedPadIds, undefined, "not for API calls");
  assert.equal((await run({ method: "GET", path: "/p", cookies: {} })).followedPadIds, undefined, "not signed out");
});

test("padowner.navPads: owned + followed once each, live first, then yours, then followed (newest first); capped", () => {
  const reg = [
    { id: "Mine.B", slug: "mine-b", title: "Bee", owner: { username: "Me" } },
    { id: "Mine.A", slug: "mine-a", title: "Ay", owner: { username: "me" } },
    { id: "F.1", slug: "f-1", title: "Fol One", owner: { username: "x" } },
    { id: "F.2", slug: "f-2", title: "Fol Two", owner: { username: "x" } },
  ];
  const keep = { list: rooms.listCached, get: rooms.getCached, live: bridge.isLiveShown };
  rooms.listCached = () => reg;
  rooms.getCached = (id) => reg.find((r) => r.id === id) || (id === "Prof" ? { id, slug: "prof", title: "P", profile: true } : null);
  bridge._rooms.set("F.2", { id: "F.2" });
  bridge.isLiveShown = (R) => R.id === "F.2";
  try {
    const n = padowner.navPads("me", ["F.1", "Mine.A", "Gone", "Prof", "F.2"]);
    assert.deepEqual(n.items.map((p) => p.slug), ["f-2", "mine-a", "mine-b", "f-1"], "live first; yours A-Z; then followed newest-first; no dupes / missing / profile pads");
    assert.deepEqual(n.items.map((p) => p.href), ["/p/f-2", "/p/mine-a", "/p/mine-b", "/p/f-1"], "every entry opens the pad");
    assert.deepEqual(n.items.map((p) => p.owner), [null, "/p/mine-a/owner", "/p/mine-b/owner", null]);
    assert.deepEqual(n.items.map((p) => p.live), [true, false, false, false]);
    assert.equal(n.more, false);
    const capped = padowner.navPads("me", ["F.1", "F.2"], 2);
    assert.equal(capped.items.length, 2); assert.equal(capped.more, true); assert.equal(capped.total, 4);
    assert.deepEqual(padowner.navPads("", ["F.1"]).items, []);
  } finally {
    rooms.listCached = keep.list; rooms.getCached = keep.get; bridge.isLiveShown = keep.live; bridge._rooms.delete("F.2");
  }
});

test("/p: a Following section on top for signed-in viewers; followed pads are not repeated in the grid", async () => {
  const row = (id, title, extra = {}) => Object.assign({ id, slug: id.toLowerCase(), title, owner: null, ownerUser: null, house: false, bridged: false, live: false, count: 0,
    micCount: 0, topic: "", description: "", slot_count: 1, now: [], next: [], pepe_here: false, platform: "site", site_only: true, boost_pat: 0, access: "members" }, extra);
  const rows = [row("Aa", "Alpha"), row("Bb", "Bravo"), row("Cc", "Charlie")];
  const render = (locals) => ejs.renderFile(path.join(repo, "views", "rooms.ejs"), Object.assign({
    user: "u", signedIn: true, staff: false, owned: [], pepe: { active: false }, ul: (n) => String(n == null ? "" : n), rows }, locals));
  let html = await render({ followRows: [rows[1]] });
  const fol = html.slice(at(html, 'id="following"'), html.indexOf("</section>", html.indexOf('id="following"')));
  assert.match(fol, /⭐ Following/); assert.match(fol, /1 pad you follow/);
  assert.match(fol, /href="\/p\/bb"/); assert.doesNotMatch(fol, /href="\/p\/aa"|href="\/p\/cc"/);
  assert.ok(at(html, 'id="following"') < at(html, '<section class="cta"'), "Following is the first thing under the title");
  const grid = html.slice(at(html, 'id="chH"'), html.indexOf("</section>", html.indexOf('id="chH"')));
  assert.match(grid, /More pads/); assert.match(grid, /2 pads/);
  assert.match(grid, /href="\/p\/aa"/); assert.match(grid, /href="\/p\/cc"/); assert.doesNotMatch(grid, /href="\/p\/bb"/, "not twice");
  // nothing followed yet: a hint, the grid is just "Pads"
  html = await render({ followRows: [] });
  assert.match(html, /id="following"[\s\S]*?You don't follow any pads yet/);
  assert.match(html, /<h2 id="chH">Pads <small>/);
  // signed out: no section
  html = await render({ signedIn: false, user: null });
  assert.doesNotMatch(html, /id="following"/);
});

// ── 1.99aae: the launchpad card at the end of Live; follower counts on the /p cards and in the header ──
test("launchpad: the card is the last thing in the Live tab (after Manage room and the story strip), not above the tabs", async () => {
  const html = await renderRoom({});
  const live = html.slice(html.indexOf('id="padPanel-live"'), html.indexOf('id="padPanel-about"'));
  assert.ok(at(html, 'id="padLaunch"') > at(html, 'id="padTabs"'), "below the tab bar");
  assert.ok(at(live, 'id="padLaunch"') > at(live, 'id="rmMod"'), "after Manage room");
  assert.match(live, /<section class="card pad-launch" id="padLaunch" data-slug="plant_based_chatting" aria-label="[^"]+" hidden><\/section>\s*<\/section>\s*(<section class="ppanel|$)/, "the panel's last element");
  const src = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.ok(src.indexOf('id="padLaunch"') > src.indexOf('class="card rm-story"'), "after the story strip too");
  assert.equal((src.match(/id="padLaunch"/g) || []).length, 1);
  assert.match(html, /pad-launch\.js\?v=\d+/, "its script still loads");
});

test("follows.roomFollowerCounts: one GROUP BY for every pad, cached, dropped on a follow", async () => {
  await follows.init();
  await runQuery("DELETE FROM follows WHERE target_kind = 'room'");
  for (const [u, r] of [["a", "R.1"], ["b", "R.1"], ["c", "R.1"], ["a", "R.2"]]) {
    await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'room', ?, ?)", [u, r, Date.now()]);
  }
  const m1 = await follows.roomFollowerCounts();
  assert.equal(m1.get("R.1"), 3); assert.equal(m1.get("R.2"), 1); assert.equal(m1.get("R.3"), undefined);
  // cached: a row added behind its back doesn't show until the cache drops (a follow() drops it)
  await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES ('d', 'room', 'R.2', 1)");
  assert.equal((await follows.roomFollowerCounts()).get("R.2"), 1, "served from the cache");
  const src = fs.readFileSync(path.join(repo, "follows.js"), "utf8");
  assert.match(src, /if \(kind === "room"\) dropRoomCounts\(\);/, "a follow / unfollow drops the cache");
  assert.match(fs.readFileSync(path.join(repo, "roomsweb.js"), "utf8"), /roomFollowerCounts\(\)[\s\S]{0,2500}followers: fcount\.get\(id\) \|\| 0/, "guideRows: one aggregate, a Map lookup per row");
});

test("/p cards show the follower count in 1.2k form (exact number in the tooltip), Following and More pads alike", async () => {
  const row = (id, title, followers) => ({ id, slug: id.toLowerCase(), title, owner: null, ownerUser: null, house: false, bridged: false, live: false, count: 0, micCount: 0,
    topic: "", description: "", slot_count: 1, now: [], next: [], pepe_here: false, platform: "site", site_only: true, boost_pat: 0, access: "members", followers });
  const rows = [row("Aa", "Alpha", 1234), row("Bb", "Bravo", 1), row("Cc", "Charlie", 0)];
  const html = await ejs.renderFile(path.join(repo, "views", "rooms.ejs"), { user: "u", signedIn: true, staff: false, owned: [], pepe: { active: false }, ul: (n) => n, rows, followRows: [rows[0]] });
  const fol = html.slice(at(html, 'id="following"'), html.indexOf("</section>", html.indexOf('id="following"')));
  assert.match(fol, /<span class="fol-n" title="1,234 people follow this pad"><b>1\.2k<\/b> followers<\/span>/);
  assert.match(html, /<span class="fol-n" title="1 person follows this pad"><b>1<\/b> follower<\/span>/);
  assert.match(html, /<span class="fol-n" title="0 people follow this pad"><b>0<\/b> followers<\/span>/);
  // the real formatter when the app provides it
  const bm = require(path.join(repo, "boostmark"));
  const html2 = await ejs.renderFile(path.join(repo, "views", "rooms.ejs"), { user: "u", signedIn: true, staff: false, owned: [], pepe: { active: false }, ul: (n) => n, rows, followRows: [], fmtCount: bm.fmtPat });
  assert.match(html2, /<b>1\.2k<\/b> followers/);
});

test("pad header: the follower count in 1.2k form, the exact number in the tooltip, a count chip by Follow on phones", async () => {
  const feed = { room: "R.1", follow: { following: false, followers: 15320 }, viewer: null, mod: {}, caps: [], storyRooms: [], rules: null, queue: 0, sort: "new", top: "", tag: "",
    flairOn: null, page: 1, more: false, posts: [], gallery: false, popularTags: [], postFlairs: [], flair: null, composer: null };
  const html = await renderRoom({ feed, fx: require(path.join(repo, "feedweb")).fx, embeds: require(path.join(repo, "stageembed")), host: "x" });
  const hero = html.slice(html.indexOf('<section class="hero'), html.indexOf("</section>", html.indexOf('<section class="hero')));
  assert.match(hero, /<span class="hd-fc" title="15,320 people follow this pad"><b data-compact="1" data-follower-count-kind="room" data-follower-count-id="R\.1">15\.3k<\/b> followers<\/span>/);
  assert.match(hero, /<span class="hd-fcs" title="15,320 people follow this pad" aria-label="15,320 people follow this pad"><b data-compact="1"[^>]*>15\.3k<\/b><\/span>/);
  assert.match(html, /\.rm \.hd-fcs \{ display: none; \}/);
  assert.match(html, /@media \(max-width: 640px\) \{[\s\S]*?\.rm \.hero-c \.hd-fcs \{ display: inline-flex;/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "follow.js"), "utf8");
  assert.match(js, /x\.hasAttribute\('data-compact'\) \? compact\(d\.followers\)/, "a follow repaints the compact counts");
  const vm = require("vm"), box = { window: {}, document: { addEventListener() {} } };
  vm.runInNewContext(js.replace("if (window.__patvFollow) return;", "window.__compact = compact; return;"), box);
  const c = box.window.__compact;
  assert.deepEqual([0, 999, 1000, 1234, 15320, 125000, 1250000].map(c), ["0", "999", "1k", "1.2k", "15.3k", "125k", "1.3M"]);
});
