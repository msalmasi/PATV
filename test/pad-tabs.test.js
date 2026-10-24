// Offline tests for the tabbed pad page (1.99dx): which tab opens first (public/js/pad-tabs.js + bridge.js
// padTabsFor), the "N new" feed badge count, the page markup (story strip on top, sticky tabs, hidden-not-removed
// panels, the merged Stage card, the Live tab's latest-posts card, About), and the roster's ⋯ moderation menu:
// gated on Pepe's caps for the viewer (room-mod.js menuItems) end to end with the server's own refusals.
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-tabs.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padtabs-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const ejs = require("ejs");
const { runQuery } = require(path.join(repo, "dbUtils"));
const T = require(path.join(repo, "public", "js", "pad-tabs.js"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const pm = require(path.join(repo, "padmod"));

// room-mod.js is a browser file: run it in a sandbox with just enough of `window`
function loadRoomMod() {
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8"), { window: win });
  return win.PATVRoom;
}
const RM0 = loadRoomMod();
// (plain arrays out of the sandbox, for deepEqual)
const RM = { _modMenuItems: (...a) => JSON.parse(JSON.stringify(RM0._modMenuItems(...a))) };

// ── the default tab ──
test("default tab: Live when the Camfrog room is active, else Feed; non-Camfrog pads always Feed", () => {
  const tabs = ["live", "feed", "about"];
  assert.equal(T.defaultTab({ tabs, platform: "camfrog", active: true }), "live");
  assert.equal(T.defaultTab({ tabs, platform: "camfrog", active: false }), "feed");
  assert.equal(T.defaultTab({ tabs, platform: "site", active: true }), "feed", "a site pad with its stage on air still opens on Feed");
  assert.equal(T.defaultTab({ tabs, platform: "profile", active: true }), "feed");
  assert.equal(T.defaultTab({ tabs: ["live", "about"], platform: "camfrog", active: false }), "live", "no feed (it failed to load): the first tab");
});

test("pickTab: an explicit request beats the remembered tab, which beats the smart default; unknown tabs are ignored", () => {
  const tabs = ["live", "feed", "about"];
  assert.equal(T.pickTab({ tabs, platform: "camfrog", active: true, requested: "feed", stored: "about" }), "feed");
  assert.equal(T.pickTab({ tabs, platform: "camfrog", active: true, requested: null, stored: "about" }), "live", "1.99eb: About is never a remembered tab");
  assert.equal(T.pickTab({ tabs, platform: "camfrog", active: true, requested: "schedule!", stored: "nope" }), "live");
  assert.equal(T.pickTab({ tabs: ["live", "about"], platform: "camfrog", active: false, requested: "feed", stored: null }), "live");
});

// ── 1.99eb: "Open pad" on a live pad landed on About (a remembered "about" beat the smart default) ──
test("remembered tab: only Live / Feed are remembered; About never is", () => {
  const now = 1_800_000_000_000;
  assert.equal(T.storedValue("about", now), null);
  assert.equal(T.storedValue("feed", now), "feed@" + now);
  assert.equal(T.storedValue("live", now), "live@" + now);
  assert.equal(T.parseStored("about"), null);
  assert.equal(T.parseStored("about@" + now), null);
  assert.deepEqual(T.parseStored("feed@" + now), { tab: "feed", at: now });
  assert.deepEqual(T.parseStored("feed"), { tab: "feed", at: 0 }, "a pre-1.99eb bare value has no time");
  assert.equal(T.parseStored("bogus"), null);
  assert.equal(T.parseStored(null), null);
});

test("Open pad / a pad-name link (no ?tab / #hash) on a live room opens Live, whatever was last remembered", () => {
  const tabs = ["live", "feed", "about"], now = 1_800_000_000_000;
  const open = (stored, active = true) => T.pickTab({ tabs, platform: "camfrog", active, requested: T.requestedTab("", ""), stored, now });
  assert.equal(open(null), "live");
  assert.equal(open("about"), "live", "an old stored About is ignored");
  assert.equal(open("about@" + now), "live");
  assert.equal(open("live@" + (now - 864e5)), "live");
  assert.equal(open("feed"), "live", "a pre-1.99eb Feed (no time) never beats Live");
  assert.equal(open("feed@" + (now - 31 * 60e3)), "live", "Feed picked over 30 min ago: Live wins");
  assert.equal(open("feed@" + (now - T.FEED_STICKY_MS)), "live", "the window is exclusive");
  assert.equal(open("feed@" + (now - 5 * 60e3)), "feed", "Feed picked 5 min ago sticks");
  assert.equal(open("feed@" + (now + 60e3)), "live", "a time in the future (clock skew) doesn't stick");
  assert.equal(T.FEED_STICKY_MS, 30 * 60 * 1000);
  // not live: the remembered Live / Feed still applies (any age); About still never does
  assert.equal(open("live@1", false), "live");
  assert.equal(open("feed@1", false), "feed");
  assert.equal(open("about", false), "feed");
  // an explicit ?tab=about / #about still opens About
  assert.equal(T.pickTab({ tabs, platform: "camfrog", active: true, requested: T.requestedTab("?tab=about", ""), stored: "feed@" + now, now }), "about");
  assert.equal(T.pickTab({ tabs, platform: "camfrog", active: true, requested: T.requestedTab("", "#about"), stored: null, now }), "about");
});

test("the server default for a live pad is Live (the guide's Open pad link carries no tab)", () => {
  const t = bridge.padTabsFor({ platform: "camfrog", live: true, feed: true, pepeHere: true, pepeOn: false, slots: [], query: "/p/pepelab",
    members: [{ login: "pepe", self: true }, { login: "bob" }] });
  assert.equal(t.requested, null);
  assert.equal(t.initial, "live");
  const views = path.join(repo, "views");
  for (const f of ["rooms.ejs", "home.ejs"]) {
    const src = fs.readFileSync(path.join(views, f), "utf8");
    assert.ok(!/href="\/p\/[^"]*(#about|tab=about)/i.test(src), f + ": no pad link points at About");
  }
});

test("requestedTab: ?tab= and #hash deep links (aliases), feed sorts / pages mean Feed; #rules means About (1.99ec)", () => {
  assert.equal(T.requestedTab("?tab=feed", ""), "feed");
  assert.equal(T.requestedTab("?x=1&tab=About", ""), "about");
  assert.equal(T.requestedTab("?tab=stage", ""), "live");
  assert.equal(T.requestedTab("?tab=schedule", ""), "live", "the schedule lives in the Stage card");
  assert.equal(T.requestedTab("", "#feed"), "feed");
  assert.equal(T.requestedTab("", "#rules"), "about", "1.99ec: the rules live in About");
  assert.equal(T.requestedTab("?tab=rules", ""), "about");
  assert.equal(T.requestedTab("", "#live"), "live");
  assert.equal(T.requestedTab("?sort=top&t=week", ""), "feed");
  assert.equal(T.requestedTab("?fp=2", ""), "feed");
  assert.equal(T.requestedTab("", ""), null);
  assert.equal(T.requestedTab("?tab=bogus", "#nothing"), null);
});

test("1.99wk: an old #owner link (the removed Owner tab) -> the header's owner-panel link when the page has one", () => {
  const doc = (href) => ({ querySelector: (sel) => (sel === "a.po-cta[href]" && href ? { getAttribute: () => href } : null) });
  assert.equal(T.ownerPanelFor("#owner", doc("/p/x/owner")), "/p/x/owner");
  assert.equal(T.ownerPanelFor("#Owner", doc("/p/x/owner")), "/p/x/owner");
  assert.equal(T.ownerPanelFor("#owner", doc(null)), null, "no owner button (not a manager): stay on the pad page");
  assert.equal(T.ownerPanelFor("#feed", doc("/p/x/owner")), null);
  assert.equal(T.ownerPanelFor("", doc("/p/x/owner")), null);
  assert.equal(T.requestedTab("?tab=owner", "#owner"), null, "owner is not a tab any more");
});

test("1.99wk: exactly ONE owner-panel link in the header + tab bar for a manager, none for anyone else; ⚙ is the settings hub", async () => {
  const PT = { tabs: ["live", "feed", "about"], initial: "live", active: true, camfrog: true, posts: [] };
  const top = (html) => html.slice(html.indexOf('<section class="hero'), html.indexOf('</nav>', html.indexOf('id="padTabs"')) + 6);
  const ownerLinks = (html) => (top(html).match(/href="\/p\/plant_based_chatting\/owner"/g) || []).length;
  for (const [who, extra] of [["the owner", { user: "pb" }], ["staff", { user: "admin1" }]]) {
    const html = await renderRoom(Object.assign({ manage: true, padTabs: PT }, extra));
    assert.equal(ownerLinks(html), 1, who + ": one owner-panel link");
    const tabs = html.slice(html.indexOf('id="padTabs"'), html.indexOf('</nav>', html.indexOf('id="padTabs"')));
    assert.doesNotMatch(tabs, /ptab-owner|\/owner"/, who + ": no Owner tab");
    assert.deepEqual((tabs.match(/data-tab="(\w+)"/g) || []).map((x) => x.slice(10, -1)), ["live", "feed", "about"]);
    assert.match(top(html), /<a class="ibtn ps-link" href="\/p\/plant_based_chatting\/settings" title="Pad settings: [^"]*"[^>]*>⚙<span class="ps-lbl" aria-hidden="true">Settings<\/span>/,
      who + ": the ⚙ is the settings hub (a different page), labelled");
  }
  assert.match(await renderRoom({ manage: true, padTabs: PT, user: "pb" }), /👑 <span class="po-lbl">Manage your pad<\/span>/);
  const nope = await renderRoom({ manage: false, padTabs: PT, user: "someone" });
  assert.equal(ownerLinks(nope), 0, "a non-manager: no owner-panel link");
  assert.doesNotMatch(top(nope), /ps-link|po-cta/);
});

test("padTabsFor (server): active = people in the room besides Pepe, or the stage on air", () => {
  const base = { platform: "camfrog", live: true, feed: true, pepeHere: true, pepeOn: false, slots: [], query: "/p/x" };
  let t = bridge.padTabsFor(Object.assign({}, base, { members: [{ login: "pepe", self: true }] }));
  assert.deepEqual(t.tabs, ["live", "feed", "about"]);
  assert.equal(t.active, false, "only Pepe in the room"); assert.equal(t.initial, "feed");
  t = bridge.padTabsFor(Object.assign({}, base, { members: [{ login: "pepe", self: true }, { login: "bob" }] }));
  assert.equal(t.active, true); assert.equal(t.initial, "live");
  t = bridge.padTabsFor(Object.assign({}, base, { members: null, count: 1 }));
  assert.equal(t.active, false, "signed-out view: the count minus Pepe");
  t = bridge.padTabsFor(Object.assign({}, base, { members: [], pepeOn: true }));
  assert.equal(t.active, true, "Pepe's stream on air in this room");
  t = bridge.padTabsFor(Object.assign({}, base, { members: [], slots: [{ id: 1 }], live: false }));
  assert.equal(t.active, true, "a user slot on the stage");
  t = bridge.padTabsFor(Object.assign({}, base, { platform: "site", members: [{ login: "a" }], slots: [{ id: 1 }] }));
  assert.equal(t.camfrog, false); assert.equal(t.initial, "feed", "site pads open on Feed");
  t = bridge.padTabsFor(Object.assign({}, base, { members: [{ login: "bob" }], query: "/p/x?tab=about" }));
  assert.equal(t.initial, "about", "?tab= on the server too");
  t = bridge.padTabsFor(Object.assign({}, base, { feed: false, members: [] }));
  assert.deepEqual(t.tabs, ["live", "about"], "no feed tab without a feed");
});

test("S1 V2: ?line=<seq> opens Live only on a pad whose Live tab holds the chat hub's widget (lineLive); ?tab= / #hash still win", () => {
  for (const [q, ok] of [["?line=42", true], ["?x=1&line=9007199254740991", true], ["?line=7#c", true], ["?line=7&tab=feed", true],
                         ["?line=0", false], ["?line=-1", false], ["?line=abc", false], ["?line=4x", false], ["?line=", false],
                         ["?headline=4", false], ["?online=4", false], ["", false], [null, false],
                         // the server's rule (chatwidget.lineOf): one line param, decoded, a positive SAFE integer
                         ["?line=9007199254740992", false], ["?line=9999999999999999", false], ["?line=1&line=2", false], ["?line=1&line=", false],
                         ["?line", false], ["?line=%34%32", true], ["?lin%65=5", true], ["?line[]=4", false], ["?line=%zz", false]]) {
    assert.equal(T.lineRequested(q), ok, "lineRequested " + JSON.stringify(q));
  }
  assert.equal(T.requestedTab("?line=42", ""), null, "requestedTab itself is unchanged: a ?line= alone asks for nothing");
  const site = { platform: "site", live: false, feed: true, pepeHere: false, pepeOn: false, slots: [], members: [] };
  let t = bridge.padTabsFor(Object.assign({}, site, { query: "/p/x?line=42" }));
  assert.equal(t.initial, "feed", "no widget on the Live tab: a ?line= changes nothing (every v1 pad)");
  assert.equal(t.lineLive, false);
  t = bridge.padTabsFor(Object.assign({}, site, { query: "/p/x?line=42", lineLive: true }));
  assert.equal(t.initial, "live", "the hub's widget on Live: the line's tab");
  assert.equal(t.requested, "live"); assert.equal(t.lineLive, true);
  assert.equal(bridge.padTabsFor(Object.assign({}, site, { query: "/p/x", lineLive: true })).initial, "feed", "no ?line=: the smart default");
  assert.equal(bridge.padTabsFor(Object.assign({}, site, { query: "/p/x?line=42&tab=about", lineLive: true })).initial, "about", "?tab= wins");
  assert.equal(bridge.padTabsFor(Object.assign({}, site, { query: "/p/x?line=nope", lineLive: true })).initial, "feed");
  assert.equal(bridge.padTabsFor(Object.assign({}, site, { query: "/p/x?line=9007199254740993", lineLive: true })).initial, "feed", "a line the widget isn't handed: as before");
  assert.equal(bridge.padTabsFor(Object.assign({}, site, { query: "/p/x?line=4&line=5", lineLive: true })).initial, "feed");
});

test("the Feed badge counts posts newer than the last look (first visit: the last 3 days)", () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const posts = [{ created: now - 1000 }, { created: now - 3600e3 }, { created: now - 5 * 86400e3 }];
  assert.equal(T.newCount(posts, now - 2000, now), 1);
  assert.equal(T.newCount(posts, now - 2 * 3600e3, now), 2);
  assert.equal(T.newCount(posts, now, now), 0);
  assert.equal(T.newCount(posts, null, now), 2, "first visit");
  assert.equal(T.newCount([], null, now), 0);
});

test("pad-tabs.js keeps storage in try/catch, hides panels instead of removing them, and never builds HTML", () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "pad-tabs.js"), "utf8");
  assert.match(js, /try \{\s*if \(val === undefined\) return root\.localStorage/);
  assert.match(js, /p\.hidden = !on/);
  assert.doesNotMatch(js, /innerHTML|\.remove\(\)|removeChild/);
});

// ── the page ──
const latest = [{ id: "p1", created: Date.now() - 60e3, title: "Hello <b>pad</b>", text: "", author: "Bob", nsfw: false },
                { id: "p2", created: Date.now() - 120e3, title: "", text: "spicy", author: "Al", nsfw: true }];
const renderRoom = (extra) => ejs.renderFile(path.join(repo, "views", "room.ejs"), {
  user: "u", signedIn: true, linked: true, room: { name: "Houseplants", slug: "plant_based_chatting", count: 2, live: true, topic: "", platform: "camfrog",
    description: "Plants and chat", owner: "pb", ownerUser: "pb", camfrogName: "Plant Based Chatting" },
  initial: { room: {}, members: [], mic: [], feed: [], cursor: 0 }, onStage: false, stage: {}, latest, ...extra });

test("page: tab bar, panels hidden (not removed), the Live tab's latest-posts card, About, cache-busted scripts", async () => {
  const html = await renderRoom({ padTabs: { tabs: ["live", "about"], initial: "about", active: true, camfrog: true, posts: [] } });
  assert.match(html, /<nav class="ptabs" id="padTabs" role="tablist"/);
  assert.match(html, /id="padTab-live"[^>]*aria-controls="padPanel-live" aria-selected="false" tabindex="-1"/);
  assert.match(html, /id="padTab-about"[^>]*aria-selected="true" tabindex="0"/);
  assert.match(html, /<section class="ppanel" id="padPanel-live" role="tabpanel" aria-labelledby="padTab-live" hidden>/);
  assert.match(html, /id="padPanel-about" role="tabpanel" aria-labelledby="padTab-about">/);
  // the live machinery is all still in the (hidden) Live panel
  const livePanel = html.slice(html.indexOf('id="padPanel-live"'), html.indexOf('id="padPanel-about"'));
  for (const id of ["rmStage", "rmFeed", "rmCompose", "rmMod", "rmMic", "rmPeople", "rdj"]) assert.ok(livePanel.includes('id="' + id + '"'), id + " in the Live panel");
  assert.match(livePanel, /<span class="ht">📝 Latest posts<\/span>/, "1.99ec: a short one-line title");
  assert.match(livePanel, /href="\/feed\/p\/p1">Hello &lt;b&gt;pad&lt;\/b&gt;<\/a>/, "escaped");
  assert.match(livePanel, /🔞 NSFW post/); assert.doesNotMatch(livePanel, /spicy/, "no NSFW text in the teaser");
  assert.match(livePanel, /data-pad-tab="feed">Open feed ›/);
  assert.doesNotMatch(livePanel, /id="joinH"/, "Join the Camfrog room moved to About");
  const about = html.slice(html.indexOf('id="padPanel-about"'));
  assert.match(about, /Join the Camfrog room/); assert.match(about, /Plant Based Chatting/); assert.match(about, /👑 pb/);
  assert.match(html, /pad-tabs\.js\?v=\d+/); assert.match(html, /room-mod\.js\?v=\d+/); assert.match(html, /room-mod\.css\?v=\d+/); assert.match(html, /pad-tip\.js\?v=1/);
  assert.match(html, /collapsible: true/, "the Manage card collapses on the pad page");
  assert.match(html, /PATVPadTabs\.init\(\{"slug":"plant_based_chatting","platform":"camfrog","active":true/);
});

test("page: site pads label the first tab Stage; the story strip (end of Live, 1.99za) only when there are captures", async () => {
  const site = await renderRoom({ room: { name: "Lounge", slug: "lounge", count: 0, live: false, topic: "", platform: "site", siteOnly: true, bridged: false },
    padTabs: { tabs: ["live", "about"], initial: "about", active: false, camfrog: false, posts: [] } });
  assert.match(site, /id="padTab-live"[^>]*>\s*<span class="pdot" aria-hidden="true" hidden><\/span>Stage<\/button>/);
  assert.doesNotMatch(site, /class="card rm-story"/, "no captures: no strip");
  assert.doesNotMatch(site, /Join the Camfrog room/);
});

test("1.99za compact header: identity (avatar + name + badges, the chat-room pill), actions (Follow, ⚙, ⋯); the descriptive bits in About, the topic in the chat card", async () => {
  const own = await renderRoom({ manage: true, pepeHere: true, roomAnalytics: "/p/plant_based_chatting/analytics", schedule: { pending: 2, live: [], queue: [], upcoming: [] },
    room: { name: "Houseplants", slug: "plant_based_chatting", count: 2, live: true, topic: "plants  AND chat", platform: "camfrog", adult: true,
      description: "Plants and chat", owner: "pb", ownerUser: "pb", camfrogName: "Plant Based Chatting" } });
  const hero = own.slice(own.indexOf('<section class="hero'), own.indexOf("</section>", own.indexOf('<section class="hero')));
  assert.match(hero, /<section class="hero hero-c" id="rmHero" aria-labelledby="rmTitle">/);
  assert.doesNotMatch(hero, /class="chip|class="meta"/, "no mixed chip row in the header");
  assert.doesNotMatch(hero, /in the Camfrog room|Pepe is here|Camfrog room:/, "live status / room info not in the header");
  // 1.99za: no description, p/slug, platform / owner tags or topic in the header any more - they're in About / the chat card
  assert.doesNotMatch(hero, /class="desc"|class="padref"|class="hd-tags"|Camfrog Pad|Pad owner|id="rmTopic"/);
  const idZone = hero.slice(hero.indexOf('class="hd-id"'), hero.indexOf('class="hd-acts"'));
  assert.match(idZone, /<h1 id="rmTitle"><span class="hd-nm"><span class="rm-nm" data-fit-name title="Houseplants">Houseplants<\/span><\/span><\/h1>/);
  assert.match(idZone, /<div class="hd-st">\s*<span class="live chat" id="rmLive"[^>]*>[\s\S]*?<\/span><\/span>\s*<span class="htag adult18"/, "the chat-room pill, then 18+");
  assert.match(idZone, /<a class="hd-about" href="\?tab=about#about" data-pad-tab="about" data-open="about">ℹ️ About<\/a>/);
  const acts = hero.slice(hero.indexOf('class="hd-acts"'));
  assert.match(acts, /class="ibtn ps-link"[^>]*>⚙<span class="ps-lbl" aria-hidden="true">Settings<\/span><span class="ps-q" aria-hidden="true">2<\/span>/, "approvals badge on ⚙");
  const menu = acts.slice(acts.indexOf('class="hd-menu"'));
  assert.match(menu, /href="\/p\/plant_based_chatting\/analytics">📈 Pad analytics/);
  assert.match(menu, /data-copy-link="\/p\/plant_based_chatting">🔗 Copy link/);
  const live = own.slice(own.indexOf('id="padPanel-live"'), own.indexOf('id="padPanel-about"'));
  assert.match(live.slice(0, 900), /<p class="lstat" id="rmLiveStat"><span id="rmStDot" aria-hidden="true">🟢<\/span>\s*<span><b id="rmCount">2<\/b> in <b>Plant Based Chatting<\/b><\/span>[\s\S]*🐸 Pepe is here<\/span><\/p>/, "status line at the top of Live");
  assert.doesNotMatch(live, /Live from the pad's Camfrog room/, "the live-view note moved to About");
  const chat = live.slice(live.indexOf('id="rmChat"'), live.indexOf('id="rmFeed"'));
  assert.match(chat, /<div class="topic" id="rmTopic" data-desc="Plants and chat"><\/div>/, "a tagline that repeats the description is not shown");
  const about = own.slice(own.indexOf('id="padPanel-about"'));
  const card = about.slice(about.indexOf('id="about"'), about.indexOf("</section>", about.indexOf('id="about"')));
  assert.match(card, /<div class="desc">Plants and chat<\/div>/);
  assert.match(card, /<dt>Address<\/dt><dd><span class="padref">p\/plant_based_chatting<\/span><\/dd>/);
  assert.match(card, /🐸 Camfrog Pad/); assert.match(card, /👑 pb/);
  assert.match(card, /<dt>Who can see it<\/dt><dd><span class="ab-tags"><span class="htag">👥 Members<\/span><span class="htag adult18"/);
  assert.match(card, /<dt>Camfrog room<\/dt><dd>Plant Based Chatting<\/dd>/);
  assert.match(card, /<p class="ab-note" role="note">📡 <b>Live from the pad's Camfrog room/);
  assert.match(about, /📈 Analytics[\s\S]*See full analytics ›/, "1.99el: About's Analytics card");
  // a different tagline shows; the public gets no ⚙
  const pub = await renderRoom({ room: { name: "Houseplants", slug: "plant_based_chatting", count: 2, live: false, topic: "Grow stuff", platform: "camfrog", description: "Plants and chat" } });
  assert.match(pub, /<div class="topic" id="rmTopic" data-desc="Plants and chat">Grow stuff<\/div>/);
  assert.doesNotMatch(pub, /class="ibtn ps-link"/);
  assert.match(pub, /id="rmStDot" aria-hidden="true">⚪/);
  assert.match(pub, /data-copy-link=/, "everyone gets ⋯ (Copy link)");
  // site pads: no status line, no chat-room pill; the platform badge is in About
  const site = await renderRoom({ room: { name: "Lounge", slug: "lounge", count: 0, live: false, topic: "", platform: "site", siteOnly: true, bridged: false } });
  assert.doesNotMatch(site, /id="rmLiveStat"|id="rmLive"/);
  assert.match(site.slice(site.indexOf('id="padPanel-about"')), /🌐 Site Pad/);
  // a link banner (no uploaded look) is the header strip, not a 200px picture above it
  const bn = await renderRoom({ room: { name: "B", slug: "b", count: 0, live: false, topic: "", platform: "camfrog", banner: "https://example.com/b.png" } });
  assert.match(bn, /<section class="hero hero-c has-bn" id="rmHero"[^>]*>\s*<div class="hero-bn" aria-hidden="true"><img src="https:\/\/example.com\/b.png" alt="" decoding="async" loading="lazy" referrerpolicy="no-referrer"><\/div>/);
  assert.doesNotMatch(bn, /class="banner-img"/);
});

test("people list: the name stays the profile link; ⋯ for mods and (1.99fu) every signed-in viewer, next to the cam icon, opening the menu", async () => {
  const html = await renderRoom({});
  const js = html.slice(html.indexOf("function renderRoom(d)"), html.indexOf("function listNote"));
  assert.match(html, /function wantsMore\(u\) \{ return !!\(roomMod && \(roomMod\.active\(\) \|\| signedIn\) && u && !u\.self && !u\.anon && u\.login\); \}/);
  assert.match(html, /roomMod\.menu\(u, mg, \{ cam: canCam/);
  assert.match(html, /collapsible: true, signed: true/, "the menu knows the viewer is signed in");
  // a signed-out visitor on a Public pad watches the room (liveOpen) without a ⋯
  const out = await renderRoom({ signedIn: false, user: null, linked: false, liveOpen: true, access: { level: "public" } });
  assert.match(out, /collapsible: true, signed: false/);
  assert.match(out, /Sign in<\/a> and link your chat account to join in\./, "the compose box asks a visitor to sign in");
  assert.match(out, /🌐 Public/);
  assert.doesNotMatch(await renderRoom({ signedIn: false, user: null, linked: false }), /id="rmFeed"/, "Members pad, signed out: still the sign-in teaser");
  assert.doesNotMatch(js, /roomMod\.open\(who\)/, "a click on the row no longer opens the dialog");
  assert.ok(js.indexOf("ic.appendChild(cam)") < js.indexOf("ic.appendChild(moreBtn(") && js.indexOf("ic.appendChild(moreBtn(") < js.indexOf("ic.appendChild(m)"), "📷 ⋯ 🎙️");
  // 1.99fu: the mic list gets the same ⋯ (after the talking bars)
  assert.match(js, /h\.appendChild\(eq\);\s*\/\/ 1\.99fu[^\n]*\n\s*if \(wantsMore\(u\)\) h\.appendChild\(moreBtn\(u, !!\(r\.cams && u\.on_cam\), true\)\);/);
  assert.match(js, /n\.href = '\/u\/' \+ encodeURIComponent\(u\.patv\.username\) \+ '\/profile'|name\(u\)/);
});

// ── the ⋯ menu's gating ──
test("menuItems: nothing without caps; exactly Pepe's listed actions; never on yourself / Pepe / anonymous", () => {
  const bob = { login: "bob", display: "Bob", patv: { username: "bobby" } };
  assert.deepEqual(RM._modMenuItems(null, bob, {}), [], "no caps (not a mod here): no menu at all");
  assert.deepEqual(RM._modMenuItems({ actions: ["kick"], on: true }, { anon: true }, {}), []);
  assert.deepEqual(RM._modMenuItems({ actions: ["kick"], on: true }, { login: "pepe", self: true }, {}), []);
  const staff = { actions: ["djban", "djunban", "casinoban", "nuke"], on: true, login: "stevie" };
  const ids = (xs) => xs.map((x) => x.id);
  assert.deepEqual(ids(RM._modMenuItems(staff, bob, { cam: true, inRoom: true })), ["profile", "cam", "djban", "djunban", "casinoban", "more"],
    "profile + cam, then only the listed actions it knows (no kick, no 'nuke'), in group order (Pepe's order within a group)");
  const it = RM._modMenuItems(staff, bob, {}).find((x) => x.id === "djban");
  assert.equal(it.danger, true, "destructive: gets the confirm step");
  assert.equal(RM._modMenuItems(staff, bob, {}).find((x) => x.id === "djunban").danger, false);
  assert.equal(RM._modMenuItems(staff, bob, {}).find((x) => x.id === "profile").href, "/u/bobby");
  assert.ok(RM._modMenuItems(Object.assign({}, staff, { on: false }), bob, {}).filter((x) => x.kind === "act").every((x) => x.disabled), "web moderation off: disabled");
  // 1.99os: yourself - the actions too (destructive ones keep the confirm step), but not lifting your own penalty
  // unless you're a Pepe admin
  const meItems = RM._modMenuItems(staff, { login: "Stevie" }, { cam: true, inRoom: true });
  assert.deepEqual(ids(meItems), ["cam", "djban", "casinoban", "more"], "yourself (staff): actions, minus djunban");
  assert.ok(meItems.filter((x) => x.kind === "act").every((x) => x.self && x.danger), "self items flagged; each asks first");
  const boss = { actions: Object.keys(pm.ACTIONS).filter((a) => a !== "topic"), on: true, login: "foamy1111", admin: true };
  const bossSelf = RM._modMenuItems(boss, { login: "Foamy1111", display: "plantbaked" }, { inRoom: true }).filter((x) => x.kind === "act").map((x) => x.id);
  for (const a of ["kick", "ban", "punish", "unpunish", "blockmic", "unblockmic", "timeout", "fine", "casinoban", "casinounban", "djban", "djunban", "strike", "strike_appeal"]) {
    assert.ok(bossSelf.includes(a), "a Pepe admin gets " + a + " on themselves");
  }
  assert.ok(!bossSelf.includes("unban"), "still no unban for someone in the room");
  for (const a of ["kick", "ban", "punish", "blockmic", "timeout", "fine", "casinoban", "djban", "strike_appeal"]) {
    assert.match(String(RM0._modSelfQ(a)), /yourself|your own/, a + ": the confirm question is about you");
  }
  // 1.99pg: room roles - a "Room role" group for Pepe owners/admins only, each one confirmed, on yourself too;
  // never on a Pepe owner's row unless you're one
  const ROLES = ["role_admin", "role_mod", "role_friend", "role_unrole"];
  const roleIds = (c, u) => RM._modMenuItems(c, u, { inRoom: true }).filter((x) => x.kind === "act" && x.id.startsWith("role_"));
  const padmin = { actions: Object.keys(pm.ACTIONS).filter((a) => a !== "topic"), on: true, login: "bossadmin", admin: true, owners: ["theowner"] };
  assert.deepEqual(roleIds(padmin, { login: "bob" }).map((x) => x.id).sort(), ROLES.slice().sort(), "a Pepe admin: the four (in Pepe's order)");
  assert.ok(roleIds(padmin, { login: "bob" }).every((x) => x.danger && x.group === "role"), "every role change asks first");
  assert.deepEqual(roleIds(padmin, { login: "BossAdmin" }).map((x) => x.id).sort(), ROLES.slice().sort(), "on yourself too");
  assert.ok(roleIds(padmin, { login: "BossAdmin" }).every((x) => x.self), "...flagged as yourself (the confirm says so)");
  assert.deepEqual(roleIds(padmin, { login: "TheOwner" }), [], "not on a Pepe owner's row");
  assert.deepEqual(roleIds(Object.assign({}, padmin, { owners: undefined, login: "theowner" }), { login: "otherowner" }).length, 4, "an owner (no owners list): everyone");
  const staffAll = { actions: ROLES.concat(["djban"]), on: true, login: "stevie" };
  assert.deepEqual(roleIds(staffAll, { login: "bob" }), [], "no caps.admin: no role actions even if listed");
  for (const a of ROLES) assert.match(String(RM0._modSelfQ(a)), /yourself|your own/, a + ": self confirm");
  assert.deepEqual(RM._modMenuItems(padmin, { login: "bob" }, {}).filter((x) => x.kind === "act").map((x) => x.group).filter((g, i, s) => s.indexOf(g) === i),
    ["room", "role", "voice", "pat", "strikes"], "group order: Room, Room role, Voice, PAT, strikes");
  const all = { actions: Object.keys(pm.ACTIONS), on: true, login: "boss" };
  const acts = RM._modMenuItems(all, { login: "bob" }, { inRoom: true }).filter((x) => x.kind === "act").map((x) => x.id);
  assert.ok(!acts.includes("unban"), "unban is pointless for someone in the room");
  assert.ok(!acts.includes("topic"), "topic isn't a per-user action");
  for (const a of acts) assert.ok(Object.prototype.hasOwnProperty.call(pm.ACTIONS, a), a + " is an action the server knows");
});

test("end to end: the menu a viewer gets comes from THEIR live-view caps, and the server refuses anything else", async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  for (const [id, name, cf, cls] of [["uS", "stevie", "stevie", "pleb"], ["uN", "alice", "alice", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, cf]);
  }
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u, class: req.get("x-test-class") || undefined } : null; next(); });
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  const server = app.listen(0);
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    await fetch(base + "/api/bridge/sync", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "bot-token", events: [], rooms: [{ room: { id: "Tabs.Room", name: "TabsRoom" }, topic: "t", members: [{ login: "bob", display: "Bob" }], count: 2,
        relay: true, mod: { stevie: { actions: ["djban", "djunban"], on: true, roles: ["staff"] } } }] }) });
    const live = async (u) => (await fetch(base + "/api/rooms/tabsroom/live", { headers: { "x-test-user": u } })).json();
    const bob = { login: "bob", display: "Bob" };
    assert.deepEqual(RM._modMenuItems((await live("uN")).mod, bob, { inRoom: true }), [], "a site Admin who isn't a room mod: no ⋯ menu");
    const items = RM._modMenuItems((await live("uS")).mod, bob, { inRoom: true }).filter((x) => x.kind === "act").map((x) => x.id);
    assert.deepEqual(items, ["djban", "djunban"]);
    const H = (u) => ({ "content-type": "application/json", "x-requested-with": "fetch", "x-test-user": u });
    relay._hits.clear();
    let r = await fetch(base + "/api/rooms/tabsroom/mod", { method: "POST", headers: H("uS"), body: JSON.stringify({ action: "kick", target: "bob" }) });
    assert.equal(r.status, 403, "an action not in the menu is refused by the server too");
    r = await fetch(base + "/api/rooms/tabsroom/mod", { method: "POST", headers: H("uN"), body: JSON.stringify({ action: "djban", target: "bob" }) });
    assert.equal(r.status, 403, "no caps: refused");
    relay._hits.clear();
    r = await fetch(base + "/api/rooms/tabsroom/mod", { method: "POST", headers: H("uS"), body: JSON.stringify({ action: "djban", target: "bob" }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).line, "!djban bob");
    // 1.99wk: the removed "Owner" tab - an old ?tab=owner link goes to the owner panel for whoever can manage the pad,
    // anyone else lands on the pad page (no tab)
    const go = async (q, h) => fetch(base + "/p/tabsroom" + q, { redirect: "manual", headers: h || {} });
    r = await go("?tab=owner", { "x-test-user": "uN", "x-test-class": "Admin" });
    assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/p/tabsroom/owner");
    r = await go("?tab=Owner&x=1", { "x-test-user": "uN", "x-test-class": "Admin" });
    assert.equal(r.headers.get("location"), "/p/tabsroom/owner", "case-insensitive");
    r = await go("?tab=owner", { "x-test-user": "uS" });
    assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/p/tabsroom", "a non-manager: the pad page");
    r = await go("?tab=owner");
    assert.equal(r.headers.get("location"), "/p/tabsroom", "signed out: the pad page");
  } finally { server.close(); }
});

test("room-mod.js: the menu shares run() and the confirm step with the dialog, and stays textContent-only", () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8");
  assert.equal((js.match(/function confirmForm\(/g) || []).length, 1);
  assert.ok((js.match(/confirmForm\(/g) || []).length >= 3, "used by the dialog and the popover");
  assert.match(js, /e\.key === 'Escape'/); assert.match(js, /pointerdown/);
  assert.match(js, /localStorage\.getItem\('patvModOpen'\)/);
  assert.doesNotMatch(js, /innerHTML/);
  const css = fs.readFileSync(path.join(repo, "public", "css", "room-mod.css"), "utf8");
  assert.match(css, /@media \(max-width: 520px\) \{\s*\/\* a bottom sheet on phones \*\/\s*\.pm-pop \{ position: fixed;/);
});
