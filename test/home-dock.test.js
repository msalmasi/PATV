"use strict";
// 1.99ajh dockpop (owner P2: "a version of the new room dock for the main page that uses the same principles for preview mode"): the
// homepage's Room Dock (views/home.ejs homeDock_, public/js/home-dock.js, public/js/pad-dock.js 'preview' mode, public/css/home-dock.css).
//   * the gate: home.js padDockOn = paddock.viewerOn (off -> today's homepage, 'staff' -> staff only) + the panel's 18+ gate + not a hub pad
//   * Dock off: none of the Dock's markers, every legacy one (the byte-for-byte diff against the base is in the commit message)
//   * Dock on: ONE block (#hmDock: the stage card + the chat card), the front pad's identity and accent, the chatlog scope on the chat card
//     only, rmd-other when the chat's pad isn't the stage's, a composer only for linked viewers, the sign-in tease signed out
//   * home-dock.js: lines without Reveal (rv dropped), never pad=1 / pop / rpm, PATVHomeAudio is the Dock's player, a popped card stops
//     polling and starts fresh when the window closes
//   node --test test/home-dock.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");
const { Document, Event } = require("./fixtures/pad-dock/dom.cjs");
const F = require("./fixtures/pad-dock/room.cjs");

const repo = path.resolve(__dirname, "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");
const BM = require(path.join(repo, "boostmark"));
const UL = require(path.join(repo, "userlinks"));
function renderHome(locals = {}) {
  const room = { id: "Alpha", slug: "alpha", name: "Alpha Room", count: 4, micCount: 1, live: true, topic: "Tonight" };
  return ejs.renderFile(path.join(repo, "views", "home.ejs"), Object.assign({
    username: null, me: null, mine: null, S: {}, rooms: [room], room, roomLive: F.initial(), roomGate: "ok", stage: { active: true }, top: [], tops: [],
    story: { rooms: [], caps: [], room: null, signed: false }, hot: null, fx: {}, roomOnStage: true, stageAdmin: null,
    frontInfo: { id: "Alpha", slug: "alpha", title: "Alpha Room", pinned: false, owner: null, boost: 0 }, pepeHere: true,
    slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "", boostMark: BM.boostMark, ul: UL, nextUp: null,
  }, locals)).then((h) => h.replace(/\r\n/g, "\n"));
}
const ME = (linked) => ({ userId: "u1", username: "viewer", displayname: "Viewer", level: 3, xp: 10, points_balance: 100, camfrogUsername: linked ? "viewercf" : null, avatar: null, streak: null });
const DOCK = [/rmd-home/, /id="hmDock"/, /home-dock\.js/, /pad-dock\.js/, /dock-link\.js/, /home-dock\.css/];
const LEGACY = [/id="lrInit"/, /id="stTabs"/, /id="lrFeed"/, /id="stSlate"/, /id="stage"/, /class="card lr-card"/];

test("home.js: the Dock follows paddock.viewerOn (off = today's homepage, 'staff' = staff only) and the page gets the viewer tag", () => {
  const src = rd("home.js");
  assert.match(src, /const padDockOn_ = require\("\.\/paddock"\)\.viewerOn\(req\.user\), vt_ = me && padDockOn_ \? require\("\.\/roompm"\)\.tag\(me\.userId\) : null;/);
  assert.match(src, /padDockOn: padDockOn_,\s+vt: vt_,/, "review: the viewer tag only for the Room Dock");
  assert.match(src, /if \(vt_\) res\.set\("Cache-Control", "private"\);/, "and such a page is never kept by a shared cache");
  const ejsSrc = rd("views", "home.ejs");
  assert.match(ejsSrc, /const homeDock_ = !!locals\.padDockOn && roomGate_ === 'ok' && !hubChat_;/, "the 18+ gate and hub pads keep today's homepage");
  const PD = require(path.join(repo, "paddock")), SP = require(path.join(repo, "siteperms"));
  const orig = PD.current;
  // ('staff' mode: only pads.manage_any viewers - paddock.viewerOn, tested in test/paddock.test.js; here: the homepage asks it with the viewer)
  assert.ok(typeof PD.viewerOn === "function" && typeof SP.can === "function" && orig);
});

test("Dock off: none of the Dock's markers, every legacy one; Dock on: the reverse", async () => {
  for (const me of [null, ME(true), ME(false)]) {
    const off = await renderHome({ me, username: me && me.username, padDockOn: false });
    for (const re of DOCK) assert.doesNotMatch(off, re, "off: " + re);
    for (const re of LEGACY.slice(1)) assert.match(off, re, "off keeps " + re);
    if (me) assert.match(off, /id="lrInit"/);
    assert.match(off, /<main class="hm ds-page">/, "the legacy <main> exactly");
    const on = await renderHome({ me, username: me && me.username, padDockOn: true, vt: me ? "tag-1" : null });
    for (const re of DOCK) assert.match(on, re, "on: " + re);
    for (const re of LEGACY) assert.doesNotMatch(on, re, "on drops " + re);
  }
  // the 18+ gate on the panel's pad, a hub pad: today's homepage even with the Dock on
  const gated = await renderHome({ me: ME(true), username: "viewer", padDockOn: true, roomGate: "confirm" });
  for (const re of DOCK) assert.doesNotMatch(gated, re, "18+ gate: " + re);
  const hub = await renderHome({ me: ME(true), username: "viewer", padDockOn: true, chatWidget: { state: "mount", head: null } });
  assert.doesNotMatch(hub, /id="hmDock"/, "a chat-hub pad");
});

test("Dock on: ONE block - the stage card + the chat card; the chatlog scope on the card only; rmd-other when the pads differ", async () => {
  const h = await renderHome({ me: ME(true), username: "viewer", padDockOn: true, vt: "tag-1" });
  const main = /<main class="([^"]*)"/.exec(h)[1];
  assert.match(main, /^hm ds-page rm rm-dock rmd-home/);
  assert.doesNotMatch(main, /chatlog/, "never on <main>: the me card's .who keeps its own look");
  assert.match(h, /<section class="card rm-chat chatlog" id="rmChat"/);
  for (const id of ["hmDock", "rmStage", "rmTabs", "rmVideo", "rmStReconnect", "rmStUnmute", "rmEmbed", "rmCap", "rmChat", "chatH", "rmStatus", "rmTopic", "rmAudioBox", "rmScroll", "rmFeed", "rmJump", "rmCompose", "rmRelay", "rmPtt", "rmPplCard", "rmPeople", "rmPplN", "hmdInit", "hmdAbout"])
    assert.equal((h.match(new RegExp('id="' + id + '"', "g")) || []).length, 1, "one #" + id + " (" + (h.match(new RegExp('id="' + id + '"', "g")) || []).length + ")");
  assert.ok(h.indexOf('id="hmDock"') < h.indexOf('class="hmd-side" id="stageSide"'), "the side widgets are a row under it");
  for (const id of ["wheelBox", "spinButton", "stSpin", "spinStatus"]) assert.match(h, new RegExp('id="' + id + '"'), id + " keeps its id (coinop.js)");
  assert.ok(h.indexOf('src="/public/js/home-dock.js') < h.indexOf("1.99hm: 🎧 on Top Pads") || !/1.99hm: 🎧 on Top Pads/.test(h), "home-dock.js runs before the Top Pads 🎧 block");
  const other = await renderHome({ me: ME(true), username: "viewer", padDockOn: true, roomOnStage: false });
  assert.match(other, /<section class="card rm-chat chatlog rmd-other" id="rmChat"/);
  const init = JSON.parse(/<script id="hmdInit" type="application\/json">([\s\S]*?)<\/script>/.exec(h)[1].replace(/\\u003c/g, "<"));
  assert.equal(init.vt, "tag-1"); assert.equal(init.chat.slug, "alpha"); assert.equal(init.front.slug, "alpha"); assert.equal(init.linked, true);
  assert.equal(init.staff, null, "no staff links for a viewer");
  const staff = JSON.parse(/<script id="hmdInit" type="application\/json">([\s\S]*?)<\/script>/.exec(await renderHome({ me: ME(true), username: "viewer", padDockOn: true, stageAdmin: { front: "auto", admin: true }, staff: true }))[1]);
  assert.deepEqual(staff.staff, { front: "/pads/admin#front", pepe: "/admin/pepe#control" });
  assert.equal(staff.stage.manage, true);
  assert.doesNotMatch(h, /<p class="stage-admlink">/, "the old staff line is the stage ⋯'s now");
});

test("the composer only for linked viewers; signed out on a members pad: the sign-in tease; read-only otherwise", async () => {
  const linked = await renderHome({ me: ME(true), username: "viewer", padDockOn: true });
  assert.match(linked, /<div class="compose hide" id="rmCompose"><div id="rmRelay"><\/div><div id="rmPtt"><\/div><\/div>/);
  const unlinked = await renderHome({ me: ME(false), username: "viewer", padDockOn: true });
  assert.doesNotMatch(unlinked, /id="rmCompose"/); assert.match(unlinked, /id="rmFeed"/);
  const publicOut = await renderHome({ padDockOn: true });
  assert.doesNotMatch(publicOut, /id="rmCompose"/); assert.match(publicOut, /id="rmFeed"/, "a Public pad signed out: read-only");
  const membersOut = await renderHome({ padDockOn: true, roomLive: null });
  assert.doesNotMatch(membersOut, /id="rmFeed"|id="rmAudioBox"/);
  assert.match(membersOut, /class="tease rmd-tease"/); assert.match(membersOut, /href="\/login"/);
});

test("pad-dock.css: the pad accent maps onto the homepage's stage + chat (only when the chat's pad is the stage's) and the window's chat", () => {
  const css = rd("public", "css", "pad-dock.css");
  const m = /([^{}]+)\{\s*--ds-ac: var\(--pad-accent\);/.exec(css);
  assert.ok(m, "the one mapping rule");
  assert.ok(m[1].includes("main.rm.rm-dock.pad-acc.rmd-home :is(#rmStage, #rmChat:not(.rmd-other)),"));
  assert.ok(m[1].includes("main.rm.rm-dock.pad-acc.rmd-popout #rmChat,"));
  const hcss = rd("public", "css", "home-dock.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(hcss, /--ds-ac:/, "no second mapping");
  assert.doesNotMatch(hcss, /body\.pad-dock-live/, "the homepage scrolls normally");
});

// ── home-dock.js in a small DOM ──
function homePage(opts = {}) {
  const doc = new Document(), win = { document: doc, listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener() {}, navigator: { userAgent: "test" } };
  doc.defaultView = win;
  const mk = (tag, id, parent, cls) => { const n = doc.createElement(tag); if (id) n.id = id; if (cls) n.className = cls; (parent || doc.body).appendChild(n); return n; };
  const main = mk("main", null, doc.body, "hm ds-page rm rm-dock rmd-home");
  const dock = mk("section", "hmDock", main);
  const stage = mk("section", "rmStage", dock, "card stage is-on");
  for (const id of ["rmTabs", "rmVideo", "rmStReconnect", "rmStUnmute", "rmEmbed", "rmCap"]) mk("div", id, stage);
  const chat = mk("section", "rmChat", dock, "card rm-chat chatlog");
  mk("h2", "chatH", chat); mk("div", "rmTopic", chat); mk("div", "rmAudioBox", chat);
  const scroll = mk("div", "rmScroll", chat); const feed = mk("div", "rmFeed", scroll); mk("button", "rmJump", chat);
  if (opts.linked) { const c = mk("div", "rmCompose", chat, "compose hide"); mk("div", "rmRelay", c); mk("div", "rmPtt", c); }
  const ppl = mk("section", "rmPplCard", dock); mk("small", "rmPplN", ppl); mk("ul", "rmPeople", ppl);
  const initial = F.initial();
  if (opts.tops) { const side = mk("div", "stageSide", main), tp = mk("section", null, side, "box tp"), ol = mk("ol", null, tp, "rooms-mini");
    for (const slug of opts.tops) { const li = mk("li", null, ol), a = mk("a", null, li); a.setAttribute("href", "/p/" + slug); mk("span", null, a, "v"); const b = mk("button", null, li, "tp-ls"); b.setAttribute("data-listen", slug); } }
  const init = mk("script", "hmdInit", doc.body); init.textContent = JSON.stringify({ front: { id: "Alpha", slug: "alpha", title: "Alpha" }, chat: { id: "Alpha", slug: "alpha", name: "Alpha", onStage: true },
    initial: opts.tease ? null : initial, vt: "tag-1", signed: true, linked: !!opts.linked, user: "viewer", stage: { slots: [], pepeOn: true, pepeHere: true, manage: false }, goLive: "/stage?room=alpha", staff: null, nextUp: null });
  const calls = { urls: [], dock: null, audio: null, switcher: null, timers: [] };
  const audio = { update() {}, onChange() {}, pause() { calls.paused = (calls.paused || 0) + 1; return true; }, isPlaying: () => false, playingSlug: () => null };
  win.PATVStage = { capture: () => ({ update() {}, reload() {} }), switcher: (o) => { calls.switcher = o; return {}; } };
  win.PATVRoom = { audio: () => { calls.audio = audio; return audio; }, relay: () => ({ update() {}, anchor: () => null, refetch: () => 0, reset() {}, wantsMe: () => false, getInput: () => null }), ptt: () => ({ update() {} }) };
  win.PATVPadDock = { init: (o) => { calls.dock = o; return { update() {}, mic() {}, peopleDrawn() {}, retitle() {} }; } };
  const CL = fs.readFileSync(path.join(repo, "public", "js", "chatlog-core.js"), "utf8");
  const ctx = { window: win, self: win, document: doc, setTimeout: (f) => { calls.timers.push(f); return calls.timers.length; }, clearTimeout() {}, JSON, Date, Math,
    CustomEvent: Event, fetch: (url) => { calls.urls.push(String(url)); return new Promise(() => {}); } };
  win.fetch = ctx.fetch; win.CustomEvent = Event;
  vm.runInNewContext(CL, ctx);
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "home-dock.js"), "utf8"), ctx);
  return { doc, win, feed, calls, initial };
}
test("home-dock.js: the lines as the pad Dock draws them but never with Reveal; never pad=1 / pop / rpm; PATVHomeAudio is the Dock's player", async () => {
  const P = homePage({ linked: true });
  assert.ok(P.initial.feed.some((it) => it.rv === 1), "(the fixture has lines a revealer would get Reveal on)");
  assert.ok(P.feed.childNodes.length >= 6, "lines drawn");
  assert.equal(P.feed.querySelectorAll(".veil-reveal").length, 0, "no Reveal on the homepage, ever");
  assert.equal(P.feed.querySelectorAll("[data-reveal]").length, 0);
  assert.ok(P.feed.querySelectorAll(".redact").length >= 1, "a hidden line is still its masked bar");
  // (1.99?? dockpol (owner H6): a stable object that speaks to the booted block's player - a front-pad swap brings a new one)
  const ha = P.win.PATVHomeAudio; assert.ok(ha && typeof ha.listen === "function" && typeof ha.onChange === "function", "the Top Pads 🎧 play through the Dock's player");
  assert.equal(ha.isPlaying(), false); ha.pause(); assert.equal(P.calls.paused, 1, "it IS the Dock's player underneath");
  assert.equal(P.calls.dock.mode, "preview"); assert.equal(P.calls.dock.vt, "tag-1"); assert.equal(P.calls.dock.room, "Alpha");
  assert.equal(P.calls.dock.chatUrl, "/p/alpha/chat"); assert.equal(P.calls.dock.padHref, "/p/alpha");
  assert.equal(P.calls.switcher.api, "/api/stage"); assert.ok(P.calls.switcher.wrap === P.doc.getElementById("rmVideo"), "the pad Dock's stage ids");
  P.calls.timers.shift()();                                   // the first long-poll
  assert.equal(P.calls.urls.length, 1);
  const u = P.calls.urls[0];
  assert.match(u, /^\/api\/rooms\/alpha\/live\?after=\d+&wait=1/);
  assert.doesNotMatch(u, /pad=1|pop=1|rpm=/, "a homepage visitor is never on a pad's people list and never gets room PM rows");
});
test("home-dock.js: while the pad's chat is in its own window the card stops polling; when it closes, a fresh view at once", () => {
  const P = homePage({ linked: false });
  P.calls.dock.onPopped(true);
  const n = P.calls.urls.length;
  while (P.calls.timers.length) P.calls.timers.shift()();
  assert.equal(P.calls.urls.length, n, "no poll while popped");
  P.calls.dock.onPopped(false);
  assert.equal(P.calls.urls.length, n + 1, "polled at once");
  assert.match(P.calls.urls.at(-1), /after=0&wait=1/, "from a fresh view (cursor 0)");
});
// ── 1.99ajh dockpop review ──
// (1.99?? dockpol (owner H1, H3, H4): the slim Stories card first, then ONE grid - #hmDock + #stageSide (the coin-op strip and Top Pads beside
// the stage and chat) - then Your show, only signed in)
test("review: the Stories card, then the Dock grid (stage, chat, coin-op, Top Pads), then Your show signed in; Dock off keeps today's order", async () => {
  const story = { rooms: [], caps: [], room: null, signed: true, compose: true };
  const on = await renderHome({ me: ME(true), username: "viewer", padDockOn: true, story });
  assert.ok(on.indexOf('class="card hm-stories rmd-stories"') < on.indexOf('id="hmdGrid"'), "the stories first");
  assert.ok(on.indexOf('id="hmdGrid"') < on.indexOf('id="hmDock"') && on.indexOf('id="hmDock"') < on.indexOf('class="hmd-side" id="stageSide"'), "the Dock, then the side widgets, in one grid");
  assert.ok(on.indexOf('class="hmd-side" id="stageSide"') < on.indexOf('id="stageShow"'), "Your show after the grid");
  assert.equal((on.match(/class="card hm-stories/g) || []).length, 1, "one stories card");
  assert.match(on, /<h2 class="ss-h">Stories <small>last 24 h<\/small>|class="ss-h"[^>]*>Stories <small>last 24 h/, "a slim eyebrow heading");
  const out = await renderHome({ padDockOn: true, story: { rooms: [], caps: [], room: null, signed: false } });
  assert.doesNotMatch(out, /id="stageShow"/, "owner H3: no Your show card until signed in (the navbar has Go live)");
  const off = await renderHome({ me: ME(true), username: "viewer", padDockOn: false, story });
  assert.ok(off.indexOf('class="card hm-stories"') < off.indexOf('id="stageShow"') && off.indexOf('id="stageShow"') < off.indexOf('id="stage"'), "Dock off: stories, Your show, the stage");
  // a linked viewer's ℹ️ About this chat doesn't say "read-only" (they have a composer here)
  assert.match(on, /<template id="hmdAbout">[^<]*What you send here goes into the room as you/);
  assert.match(await renderHome({ me: ME(false), username: "viewer", padDockOn: true }), /<template id="hmdAbout">[^<]*read-only/);
});
test("review: the sign-in tease gets no ↗️; the chat's own pad in Top Pads keeps its rank and link, not its count, mic line or 🎧", () => {
  const P = homePage({ linked: true });
  assert.equal(P.calls.dock.chatUrl, "/p/alpha/chat");
  const T = homePage({ linked: false, tease: true });
  assert.equal(T.calls.dock.chatUrl, null, "no roomLive (the tease): no window to open");
  const R = homePage({ linked: true, tops: ["alpha", "beta"] });
  const rows = R.doc.querySelectorAll("#stageSide .tp li");
  assert.equal(rows[0].classList.contains("hmd-here"), true); assert.match(rows[0].textContent, /In the chat above/);
  assert.equal(rows[1].classList.contains("hmd-here"), false, "another pad's row is unchanged");
  const css = rd("public", "css", "home-dock.css");
  assert.match(css, /main\.hm\.rmd-home \.tp li\.hmd-here :is\(\.v, \.tp-ls, \.np\) \{ display: none; \}/);
});
