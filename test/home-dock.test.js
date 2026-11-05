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
  // (1.99ajq dockpol (owner H6): a stable object that speaks to the booted block's player - a front-pad swap brings a new one)
  const ha = P.win.PATVHomeAudio; assert.ok(ha && typeof ha.listen === "function" && typeof ha.onChange === "function", "the Top Pads 🎧 play through the Dock's player");
  assert.equal(ha.isPlaying(), false); ha.pause(); assert.equal(P.calls.paused, 1, "it IS the Dock's player underneath");
  assert.equal(P.calls.dock.mode, "preview"); assert.equal(P.calls.dock.vt, "tag-1"); assert.equal(P.calls.dock.room, "Alpha");
  assert.equal(P.calls.dock.chatUrl, "/p/alpha/chat"); assert.equal(P.calls.dock.padHref, "/p/alpha");
  // (dock3 review 1.99akf MF2: THIS block's pad by the homepage's rules - a front-page change no longer applies the new pad's stage to it)
  assert.equal(P.calls.switcher.api, "/api/stage?room=alpha&home=1"); assert.ok(P.calls.switcher.wrap === P.doc.getElementById("rmVideo"), "the pad Dock's stage ids");
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
// (1.99ajq dockpol (owner H1, H3, H4): the slim Stories card first, then ONE grid - #hmDock + #stageSide (the coin-op strip and Top Pads beside
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

// 1.99ajy dockmedia (owner item 3): the Dock's 🖥️ on the homepage fills the screen - the card's 16:9 / min(560px, …) cap, the 761-1023px 60svh cap
// and its border followed the stage into .rmd-fullscreen (the same <main>) and beat pad-dock.css's .rmd-full-media rule by load order
test("item 3: the homepage stage in fullscreen has no card cap - (1,4,1) beats the card's (1,3,1) rules; the off-air slim bar keeps aspect-ratio auto", () => {
  const css = rd("public", "css", "home-dock.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const fix = /main\.rm\.rm-dock\.rmd-home \.rmd-full-media #rmStage \{ aspect-ratio: auto; max-block-size: none; block-size: auto; border: 0; border-radius: 0; \}/;
  assert.match(css, fix);
  assert.ok(css.search(fix) > css.indexOf("main.rm.rm-dock.rmd-home #rmStage.is-off { aspect-ratio: auto; }"), "after the off-air rule");
  assert.match(css, /main\.rm\.rm-dock\.rmd-home #rmStage \{ block-size: auto; aspect-ratio: 16 \/ 9; max-block-size: min\(560px, calc\(100vh - 140px\)\);/, "the card rule as it was - never rescoped to #hmDock > #rmStage (2,3,1), which would beat the off-air bar");
  assert.match(rd("views", "home.ejs"), /home-dock\.css\?v=6/);   // (homegap: v5; dock3 review 1.99akf: v6)
});

// homegap (owner 2026-11-05, "the empty space here looks weird" - a blank under the coin-op strip beside Top Pads + the featured table): the
// call-to-action card (Your show signed in, the join pitch signed out) is the Dock grid's last cell (.hmd-cta); 1024px and wider it fills the
// stage column under the strip while the side column is much the taller (Top Pads with 3+ rows, or 2 + the featured table), on a 1fr row. What
// the side column holds is server-rendered (home-dock.js swaps #hmDock only), so the state is the grid's classes, not :has() chains
const HG_TOPS = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((n, i) => ({ id: n, slug: n.toLowerCase(), name: n + " Pad", count: 5 - i, micCount: i % 2 }));
const HG_FEAT = { featured: { id: "tbl-1", game: "Hold'em", seats: [1, 2, 3], room: null, href: "/casino/t/tbl-1" } };
const hgGrid = (h) => { const m = h.match(/<div class="hmd-grid( [^"]*)?" id="hmdGrid">/); assert.ok(m, "the Dock grid"); return { a: m.index, cls: (m[1] || "").trim(), side: h.indexOf('id="stageSide"', m.index) }; };
test("homegap: Your show / the join pitch are the Dock grid's last cell - one pitch signed out, today's order with the Dock off", async () => {
  const tops = HG_TOPS.slice(0, 3);
  const on = await renderHome({ me: ME(true), username: "viewer", padDockOn: true, tops });
  const g = hgGrid(on), show = on.indexOf('id="stageShow"'), meCard = on.indexOf('class="card me"');
  assert.equal(g.cls, "hmd-fill");
  assert.ok(g.a > 0 && g.side > g.a && show > g.side && meCard > show, "the grid, the side widgets, Your show, then the me card");
  assert.match(on, /<section class="card golive golive-wide hmd-cta" id="stageShow"/);
  assert.match(on.slice(show, meCard), /^[^]*?<\/section>\s*<\/div>\s*<!-- ───── you ───── -->/, "the grid closes right after the card");
  assert.doesNotMatch(on, /id="hmdPitch"|class="card pitch"/, "signed in: no pitch");
  const out = await renderHome({ padDockOn: true, tops });
  assert.equal((out.match(/class="card pitch/g) || []).length, 1, "signed out: ONE pitch");
  assert.match(out, /<section class="card pitch hmd-cta" id="hmdPitch">/, "the pitch is the grid's last cell");
  assert.ok(out.indexOf('id="hmdPitch"') > hgGrid(out).side, "after the side widgets");
  assert.match(out.slice(out.indexOf('id="hmdPitch"')), /^[^]*?<\/section>\s*<\/div>\s*<!-- ───── you ───── -->/, "inside the grid - its last cell");
  assert.doesNotMatch(out, /id="stageShow"/, "owner H3 still: no Your show signed out");
});
test("homegap: Dock off - no hmd- classes, today's cards: exactly one pitch signed out, Your show above the stage signed in", async () => {
  for (const [T, S] of [[0, {}], [2, {}], [5, HG_FEAT]]) {
    for (const me of [null, ME(true)]) {
      const off = await renderHome({ me, username: me && me.username, padDockOn: false, tops: HG_TOPS.slice(0, T), S });
      assert.doesNotMatch(off, /class="[^"]*\bhmd-/, "Dock off: no hmd- class anywhere (tops " + T + ")");
      assert.doesNotMatch(off, /id="hmdGrid"|id="hmdPitch"/);
      if (!me) assert.equal((off.match(/class="card pitch/g) || []).length, 1, "signed out: ONE pitch");
      if (!me) assert.match(off, /<section class="card pitch">/, "the pitch as it was");
      else assert.match(off, /<section class="card golive golive-wide" id="stageShow" aria-labelledby="gsH">/, "Your show as it was");
    }
  }
});
test("homegap: the grid's classes - Top Pads rows 0-5 x the featured table, signed in and out (the CSS's states, rendered by the server)", async () => {
  const want = {
    "0/0": "hmd-notops", "0/1": "hmd-notops hmd-feat",
    "1/0": "", "1/1": "hmd-pairs hmd-feat",
    "2/0": "", "2/1": "hmd-fill hmd-feat",
    "3/0": "hmd-fill", "3/1": "hmd-fill hmd-feat",
    "4/0": "hmd-fill", "4/1": "hmd-fill hmd-tall hmd-feat",
    "5/0": "hmd-fill hmd-tall", "5/1": "hmd-fill hmd-tall hmd-feat",
  };
  for (let T = 0; T <= 5; T++) for (const F of [0, 1]) for (const me of [null, ME(true)]) {
    const k = T + "/" + F, h = await renderHome({ me, username: me && me.username, padDockOn: true, tops: HG_TOPS.slice(0, T), S: F ? HG_FEAT : {} });
    const g = hgGrid(h);
    assert.equal(g.cls, want[k], "tops " + k + (me ? " signed in" : " signed out"));
    // the classes say what the side column renders: Top Pads' rows, the featured table
    const side = h.slice(g.side, h.indexOf("hmd-cta", g.side));
    assert.equal((side.match(/<li><a href="\/p\//g) || []).length, T, k + ": Top Pads rows");
    assert.equal(/<section class="box tp"/.test(side), T > 0, k + ": Top Pads");
    assert.equal(/<a class="box" href="\/casino\/t\/tbl-1">/.test(side), !!F, k + ": the featured table");
    assert.equal((h.match(/class="[^"]*\bhmd-cta\b/g) || []).length, 1, k + ": one call-to-action card");
  }
});
test("homegap: every catalog's Your show blurb starts with a <b> sentence (the tall card sets it on its own line)", () => {
  const dir = path.join(repo, "locales"), en = JSON.parse(rd("locales", "en.json"));
  const cats = fs.readdirSync(dir).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f));
  assert.ok(cats.length >= 23, "English + the 22 languages");
  for (const f of cats) {
    const b = JSON.parse(rd("locales", f))["home.show.blurb"] || en["home.show.blurb"];
    assert.match(b, /^<b>[^<]+<\/b>/, f);
  }
});
test("homegap: home-dock.css - the lower rows from custom properties, set by the grid's classes from 1024px; the card last and full width below", () => {
  const css = rd("public", "css", "home-dock.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /grid-template-rows: var\(--hmd-top-rows\) var\(--hmd-low-rows\); grid-template-areas: var\(--hmd-top\) var\(--hmd-low\);/);
  assert.match(css, /--hmd-top: "stage chat"; --hmd-top-rows: minmax\(420px, auto\); --hmd-low: "coin tops" "cta cta"; --hmd-low-rows: auto auto;/, "one Top Pads row: today's level strip + Top Pads, the card under them");
  assert.match(css, /main\.hm\.rmd-home \.hmd-grid > \.hmd-cta \{ grid-area: cta; align-self: stretch; min-inline-size: 0; margin: var\(--hmd-cta-mt, calc\(var\(--cardgap, var\(--ds-sp-4\)\) - var\(--ds-sp-2\)\)\) 0 0; \}/, "full width: the page's card gap above it, as before");
  const i = css.indexOf("@media (min-width: 1024px) {"), mq = css.slice(i, css.indexOf("\n}\n", i));
  assert.ok(i > 0 && mq.length > 0);
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid\.hmd-notops \{ --hmd-low: "coin coin" "cta cta"; \}/, "no Top Pads: the strip takes the width");
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid\.hmd-notops\.hmd-feat \{ --hmd-low: "coin feat" "cta cta"; \}/);
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid\.hmd-fill \{ --hmd-low: "coin tops" "cta tops"; --hmd-low-rows: auto 1fr; --hmd-cta-mt: 0px; \}/);
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid\.hmd-fill\.hmd-feat \{ --hmd-low: "coin tops" "cta tops" "cta feat"; --hmd-low-rows: auto 1fr auto; \}/);
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid\.hmd-pairs \{ --hmd-low: "coin tops" "cta feat"; --hmd-low-rows: auto auto; --hmd-cta-mt: 0px; \}/);
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid:is\(\.hmd-fill, \.hmd-pairs\) > \.hmd-cta \{/, "the panel look: fill and pairs");
  assert.match(mq, /\[dir="rtl"\] main\.hm\.rmd-home \.hmd-grid:is\(\.hmd-fill, \.hmd-pairs\) > \.hmd-cta \{ --hmd-cta-bx: 14%; --hmd-cta-gx: 90%; \}/, "right to left: the lights mirror");
  assert.match(mq, /--hmd-cta-bx: 86%; --hmd-cta-by: 55%;/);
  assert.match(mq, /radial-gradient\(34% 95% at var\(--hmd-cta-bx\) var\(--hmd-cta-by\)/);
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid\.hmd-tall > #stageShow p > b \{ display: block;/, "the tall card: the <b> sentence on its own line");
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid:is\(\.hmd-pairs, \.hmd-notops\) #stageSide > a\.box \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\); align-content: center;/, "the featured table stretched to a taller neighbour: 3 lines");
  // (the chat's own pad keeps its name, the note gives way - 1024px and wider, AFTER the note's base rule: the same specificity)
  const here = css.indexOf("@media (min-width: 1024px) {\n  main.hm.rmd-home .tp li.hmd-here .n { flex: 0 0 auto; max-inline-size: calc(100% - 8px); }\n  main.hm.rmd-home .tp li.hmd-here .hmd-here-t { flex: 1 1 0px; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; text-align: end; }\n}");
  assert.ok(here > 0 && here > css.indexOf("main.hm.rmd-home .tp li.hmd-here .hmd-here-t { flex: none;"), "the pad's name before the note (never a shrink share for the name)");
  // :has() only for what the page changes live - never for the server-rendered side column
  assert.doesNotMatch(css, /:has\(> \.hmd-cta\)|:has\(> \.tp|:has\(#stageSide > \.tp|\.rooms-mini > li:nth-child|\.rooms-mini > li \+ li/, "no :has() chains on Top Pads or the card");
  assert.equal((css.match(/:has\(/g) || []).length, (css.match(/:has\(([^()]*)\)/g) || []).length, "every :has() is a plain one");
  for (const m of css.matchAll(/:has\(([^()]*)\)/g))
    assert.ok(/^(#rmStage\.is-off|#rmChat|> \.rmd-tease|#stageSide > a\.box|#wheelBox)$/.test(m[1]), "a :has() for a live state (or the 761-1023px rules as they were, or no strip): " + m[1]);
  assert.deepEqual(mq.match(/:has\([^)]*\)/g), [":has(#wheelBox)", ":has(#wheelBox)", ":has(#wheelBox)", ":has(#wheelBox)", ":has(#rmStage.is-off)", ":has(> .rmd-tease)"], "from 1024px: only no strip and the off-air sign-in tease");
  assert.doesNotMatch(css, /grid-row-end: span 2/, "the old Top Pads span is the areas' now");
  for (const s of ['"stage stage" "coin coin" "chat chat" "tops feat" "cta cta"', '"stage stage" "coin coin" "chat chat" "tops tops" "cta cta"', '"stage" "coin" "chat" "tops" "feat" "cta"'])
    assert.ok(css.includes(s), "761-1023px / phones: the card is the last row - " + s);
  assert.doesNotMatch(css, /grid-template-areas: "stage stage" "chat chat" "coin tops" "coin feat"/, "off air / popped set only the top half");
  assert.match(rd("views", "home.ejs"), /home-dock\.css\?v=6/);   // (dock3 review 1.99akf: v6 - after homegap's v5)
});
// homegap review fixes: the strip fills the row it shares (Top Pads' two rows, one row and its 🎧 listen bar), never under 96px from 1024px;
// two rows alone no longer fill; the tall card's red light follows Go live under 1280px; the join pitch's buttons stack there; the featured
// table after Top Pads with the Dock on (focus order); no strip -> the card takes its place
test("homegap fix: the coin-op strip from 1024px - 96px at least, no cap (it fills the row it shares), after the strip's own 96px cap", () => {
  const css = rd("public", "css", "home-dock.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const cap = css.indexOf("main.hm.rmd-home #wheelBox .aw-coinop { display: grid;");
  const fill = css.indexOf("@media (min-width: 1024px) { main.hm.rmd-home #wheelBox .aw-coinop { min-block-size: 96px; max-block-size: none; } }");
  assert.ok(cap > 0 && /max-block-size: 96px/.test(css.slice(cap, css.indexOf("}", cap))), "the strip's base rule keeps its 96px cap (761-1023px / phones override it as before)");
  assert.ok(fill > cap, "the 1024px floor / no cap comes after the base rule - the same specificity");
  // below 1024px the strip's rules are untouched
  const mid = css.slice(css.indexOf("@media (min-width: 761px) and (max-width: 1023px) {"));
  assert.match(mid, /main\.hm\.rmd-home #wheelBox \.aw-coinop \{ grid-template-columns: auto minmax\(0, 1fr\) auto; grid-template-areas: "credit door btn" "status status tools"; max-block-size: none; row-gap: var\(--ds-sp-1\); \}/);
});
test("homegap fix: under 1280px the tall card's red light is on Go live (under the words, at the start); the join pitch's buttons stack", () => {
  const css = rd("public", "css", "home-dock.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const i = css.indexOf("@media (min-width: 1024px) and (max-width: 1279px) {"), mq = css.slice(i, css.indexOf("\n}\n", i));
  assert.ok(i > css.indexOf('[dir="rtl"] main.hm.rmd-home .hmd-grid:is(.hmd-fill, .hmd-pairs) > .hmd-cta {'), "after the lights' base + RTL rules");
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid\.hmd-tall > #stageShow \{ --hmd-cta-bx: 12%; --hmd-cta-by: 82%; \}/);
  assert.match(mq, /\[dir="rtl"\] main\.hm\.rmd-home \.hmd-grid\.hmd-tall > #stageShow \{ --hmd-cta-bx: 88%; \}/, "right to left the start is the right");
  assert.match(mq, /main\.hm\.rmd-home \.hmd-grid:is\(\.hmd-fill, \.hmd-pairs\) > #hmdPitch \.ds-actions \{ flex-direction: column; align-items: stretch; \}/);
  // (1280px and wider the tall card's buttons are at its end - the base light position, no override)
  const wide = css.slice(css.indexOf("@media (min-width: 1280px) {"));
  assert.doesNotMatch(wide.slice(0, wide.indexOf("\n}\n")), /--hmd-cta-bx/);
});
test("homegap fix: no coin-op strip from 1024px - the card takes its place (it is always rendered today)", () => {
  const css = rd("public", "css", "home-dock.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /main\.hm\.rmd-home \.hmd-grid:not\(:has\(#wheelBox\)\) \{ --hmd-low: "cta tops"; --hmd-low-rows: auto; --hmd-cta-mt: 0px; \}/);
  assert.match(css, /main\.hm\.rmd-home \.hmd-grid\.hmd-feat:not\(:has\(#wheelBox\)\) \{ --hmd-low: "cta tops" "cta feat"; --hmd-low-rows: 1fr auto; \}/);
  assert.match(css, /main\.hm\.rmd-home \.hmd-grid\.hmd-notops:not\(:has\(#wheelBox\)\) \{ --hmd-low: "cta cta"; \}/);
  assert.match(css, /main\.hm\.rmd-home \.hmd-grid\.hmd-notops\.hmd-feat:not\(:has\(#wheelBox\)\) \{ --hmd-low: "cta feat"; \}/);
  assert.match(rd("views", "home.ejs"), /<div class="aw aw-hm" id="wheelBox">/);
});
test("homegap fix: the featured table after Top Pads with the Dock on (Tab: strip, Top Pads, table, card); Dock off where it always was", async () => {
  for (const me of [null, ME(true)]) for (const T of [0, 1, 3, 5]) {
    const on = await renderHome({ me, username: me && me.username, padDockOn: true, tops: HG_TOPS.slice(0, T), S: HG_FEAT });
    const g = hgGrid(on), wheel = on.indexOf('id="wheelBox"', g.side), feat = on.indexOf('<a class="box" href="/casino/t/tbl-1">', g.side), cta = on.indexOf("hmd-cta", g.side);
    assert.equal((on.match(/<a class="box" href="\/casino\/t\/tbl-1">/g) || []).length, 1, "one featured table (tops " + T + ")");
    assert.ok(wheel > g.side && feat > wheel && cta > feat, "the strip, then the table, then the card (tops " + T + ")");
    if (T) assert.ok(feat > on.indexOf('<section class="box tp"', g.side) && feat > on.indexOf('id="tpAudioBox"', g.side), "after Top Pads (tops " + T + ")");
    assert.match(on.slice(feat, cta + 8), /^<a class="box"[^]*?<\/a>\s*<\/div>\s*<section class="card [^"]*hmd-cta"$/, "the side column's last cell, then the card (tops " + T + ")");
    const off = await renderHome({ me, username: me && me.username, padDockOn: false, tops: HG_TOPS.slice(0, T), S: HG_FEAT });
    const ofeat = off.indexOf('<a class="box" href="/casino/t/tbl-1">');
    assert.equal((off.match(/<a class="box" href="\/casino\/t\/tbl-1">/g) || []).length, 1, "Dock off: one featured table");
    if (T) assert.ok(ofeat < off.indexOf('<section class="box tp"'), "Dock off: before Top Pads, as it was");
  }
  const none = await renderHome({ me: ME(true), username: "viewer", padDockOn: true, tops: HG_TOPS.slice(0, 3) });
  assert.doesNotMatch(none, /<a class="box" href="\/casino/, "no table: none");
});
