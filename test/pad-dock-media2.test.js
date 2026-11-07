"use strict";
// 1.99ajy dockmedia (the owner's 2026-11-04 media points): the Room Dock's 🎶 Now playing card / bar (Pepe's DJ booth + the 📼 Plex player
// moved in), the stage's own media controls (no native player controls under the Dock's bar; a solid row under an embed), the players'
// nativeControls flag, room-dj.js's data-np / icon + words / cancelable Request, the homepage fullscreen and the Bounty's Reward.
//   node --test test/pad-dock-media2.test.js
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { harness, Event, Document } = require("./fixtures/pad-dock/dom.cjs");
const F = require("./fixtures/pad-dock/room.cjs");
const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const labels = (m) => m.querySelectorAll("[role]").filter((b) => /^menuitem/.test(b.getAttribute("role"))).map((b) => b.getAttribute("aria-label") || b.textContent.trim());
const idx = (n) => n.parentNode.childNodes.indexOf(n);

// ── the page's own nodes, as room.ejs / room-dj.ejs / pad-plexq.js draw them ──
function booth(x, log) {
  const rdj = x.make("section", "card rdj hide collapsed", "rdj"); x.panel.insertBefore(rdj, x.body);
  const h2 = x.make("h2", null, "rdjH", rdj); x.make("span", "pill", "rdjPill", h2, "Auto-DJ on");
  const tog = x.make("button", "tog", "rdjTog", h2, "Open booth ▾"); tog.addEventListener("click", () => { rdj.classList.toggle("collapsed"); log.push("tog"); });
  const mini = x.make("div", "mini", "rdjMini", rdj), mt = x.make("div", "mt", null, mini);
  x.make("b", null, "rdjMiniT", mt, "Lively Up Yourself"); x.make("span", null, "rdjMiniA", mt, "Bob Marley & The Wailers");
  const fill = x.make("div", "fill", "rdjMiniFill", x.make("div", "thin", "rdjMiniTrack", mt)); fill.style.width = "40%";
  const ctrls = x.make("div", "ctrls", "rdjMiniCtrls", mini), req = x.make("button", "b go", null, ctrls, "🔎 Request");
  // (room-dj.js: the Request asks first - a cancelled event means the Dock opens its own DJ sheet)
  req.addEventListener("click", () => { if (!rdj.dispatchEvent(new x.Event("patv:djrequest", { bubbles: true, cancelable: true }))) { log.push("asked"); return; } log.push("own"); rdj.classList.remove("collapsed"); });
  const full = x.make("div", "full", "rdjFull", rdj), find = x.make("input", null, "rdjFindQ", full); find.setAttribute("type", "text");
  return { rdj, tog, req, find };
}
function plex(x) {
  const gl = x.make("section", "card golive-card", "rmGoLive", x.panel), px = x.make("div", "plexq", "rmPlexQ", gl); px.hidden = true;
  const now = x.make("div", "pq-now", null, px); x.make("b", null, null, now, "📼 The Night of the Hunter (1955)");
  const bar = x.make("div", "pq-bar", null, px), sp = x.make("span", null, null, bar); sp.style.width = "33.00%";
  const ctl = x.make("div", "pq-ctl", null, px); x.make("button", "sact", null, ctl, "−30s").setAttribute("data-skip", "-30"); x.make("button", "sact", null, ctl, "⏸").setAttribute("data-q", "pause");
  const q = x.make("details", "pq-q", null, px); q.open = true; x.make("summary", null, null, q, "Up next (2)");
  return { gl, px, q };
}

test("item 1: 🎶 Now playing - the DJ booth shows in the people column only while a track plays or is paused; the people card stays after it", () => {
  const log = [];
  let B;
  const h = harness({ mo: true, setup: (x) => { B = booth(x, log); } });
  const card = h.doc.getElementById("rmdNp");
  assert.ok(card, "the card is built"); assert.equal(card.parentNode, h.side, "in the people column"); assert.equal(h.side.children[0], card, "first");
  assert.equal(card.getAttribute("aria-label"), "Now playing");
  assert.equal(B.rdj.closest("#rmdNp"), card, "the ORIGINAL booth moved in");
  assert.ok(idx(h.ppl) > idx(card), "the people card is still in the column, after it");
  assert.equal(card.hidden, true, "Pepe hasn't reported music: nothing shows");
  for (const [np, hide, want] of [["playing", false, true], ["paused", false, true], ["idle", false, false], ["offline", false, false], ["off", false, false], ["playing", true, false]]) {
    B.rdj.setAttribute("data-np", np); B.rdj.classList.toggle("hide", hide); h.mutate(B.rdj);
    assert.equal(!card.hidden, want, np + (hide ? " + .hide" : "")); assert.equal(!card.querySelector('[data-np="dj"]').hidden, want);
  }
  // the header mirrors the pill and opens the DJ sheet with the booth OPEN (its own ▾), closed again on the way out
  B.rdj.classList.remove("hide"); B.rdj.setAttribute("data-np", "playing"); h.mutate(B.rdj);
  const head = card.querySelector(".rmd-np-h");
  assert.equal(head.getAttribute("aria-label"), "DJ booth · Auto-DJ on"); assert.equal(head.getAttribute("aria-haspopup"), "dialog");
  head.click();
  let sheet = h.doc.querySelector(".rmd-layer");
  assert.ok(sheet && sheet.contains(B.rdj), "the booth is in the DJ sheet"); assert.equal(B.rdj.classList.contains("collapsed"), false, "opened by its own toggle");
  assert.equal(sheet.querySelector(".rmd-sheet-back"), null, "no ‹ Chat apps from here"); assert.equal(head.getAttribute("aria-expanded"), "true");
  h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  assert.equal(B.rdj.classList.contains("collapsed"), true, "collapsed again - patvDjOpen ends where it was"); assert.deepEqual(log, ["tog", "tog"]);
  assert.equal(B.rdj.closest("#rmdNp"), card, "back in the card"); assert.equal(head.getAttribute("aria-expanded"), "false");
});

test("item 1: the 📼 Plex block follows #rmPlexQ's hidden; Up next folds once in the card; its header opens Plex queue & controls with everything", () => {
  let P;
  const h = harness({ mo: true, setup: (x) => { P = plex(x); } });
  const card = h.doc.getElementById("rmdNp"), blk = card.querySelector('[data-np="plex"]');
  assert.equal(P.px.closest("#rmdNp"), card); assert.equal(card.hidden, true);
  P.px.hidden = false; h.mutate(P.px);
  assert.equal(card.hidden, false); assert.equal(blk.hidden, false);
  assert.equal(P.q.open, false, "Up next folded in the card");
  P.q.open = true; h.mutate(P.px); assert.equal(P.q.open, true, "once - the viewer's choice stays");
  P.q.open = false; h.mutate(P.px);
  blk.querySelector(".rmd-np-h").click();
  const sheet = h.doc.querySelector(".rmd-layer .ds-modal");
  assert.equal(sheet.getAttribute("aria-label"), "Plex queue & controls"); assert.ok(sheet.contains(P.px)); assert.equal(P.q.open, true, "the sheet shows the queue");
  h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  assert.equal(P.px.closest("#rmdNp"), card, "back in the card"); assert.equal(P.q.open, false, "folded again");
  P.px.hidden = true; h.mutate(P.px); assert.equal(card.hidden, true, "nothing plays: no card");
  // the stage ⋯ no longer lists it - the card / bar is its one place
  P.px.hidden = false; h.mutate(P.px);
  h.button("Stage options").click();
  assert.ok(!labels(h.doc.querySelector(".rmd-menu")).some((l) => /Plex/.test(l)), "no Plex queue & controls in the stage ⋯");
  assert.doesNotMatch(read("public", "js", "pad-dock.js"), /menuItem\(box, '📼', 'plex',/);   // (1.99ajw casino2's 📼 Play from Plex… stays - it starts a play)
});

test("item 1: the booth's 🔎 Request in the card is cancelled and opens the DJ sheet with the booth open, focus in its search", () => {
  const log = [];
  let B;
  const h = harness({ mo: true, setup: (x) => { B = booth(x, log); } });
  B.rdj.classList.remove("hide"); B.rdj.setAttribute("data-np", "playing"); h.mutate(B.rdj);
  B.req.click();
  assert.deepEqual(log, ["tog", "asked"], "the Dock took it: the booth opened by its toggle, not by room-dj.js");
  const sheet = h.doc.querySelector(".rmd-layer");
  assert.ok(sheet.contains(B.rdj)); h.tick();
  assert.equal(h.doc.activeElement, B.find, "the song search");
  h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  assert.equal(B.rdj.classList.contains("collapsed"), true); assert.equal(B.rdj.closest("#rmdNp") != null, true);
  // outside the Dock's card / sheet (the booth in the Apps › DJ sheet) the booth's own Request runs
  h.controller.update(Object.assign(F.initial(), { room: Object.assign(F.initial().room, { cmds: { "!np": 0 } }) }));
  h.button("Chat apps").click(); h.button("DJ", h.doc.querySelector(".rmd-layer")).click();
  B.req.click(); assert.equal(log[log.length - 1], "own");
});

test("item 1: under 1024px - the bar joins what plays; its sheet holds both blocks and gives them back; destroy() puts the nodes where the page drew them", () => {
  const log = [];
  let B, P;
  const h = harness({ mo: true, setup: (x) => { B = booth(x, log); P = plex(x); } });
  const bar = h.doc.querySelector(".rmd-npbar"), card = h.doc.getElementById("rmdNp");
  assert.ok(bar, "the bar is built"); assert.equal(bar.parentNode.className.includes("rm-main"), true); assert.equal(bar.parentNode.children[0], bar, "under the stage, above the chat");
  assert.equal(bar.hidden, true, "nothing plays");
  B.rdj.classList.remove("hide"); B.rdj.setAttribute("data-np", "paused"); P.px.hidden = false; h.mutate(B.rdj); h.mutate(P.px);
  assert.equal(bar.hidden, false);
  // (verify: both playing - "song · 📼 film", short enough for a phone to show the film too)
  assert.equal(bar.querySelector(".rmd-npbar-t").textContent, "Lively Up Yourself · 📼 The Night of the Hunter (1955)");
  assert.equal(bar.getAttribute("aria-label"), "Now playing: Lively Up Yourself · 📼 The Night of the Hunter (1955) - open the controls");
  assert.equal(bar.querySelector(".ds-ic").textContent, "🎶"); assert.equal(bar.querySelector(".rmd-npbar-p > i").style.width, "40%", "the DJ's progress first");
  bar.click();
  const sheet = h.doc.querySelector(".rmd-layer .ds-modal");
  assert.equal(sheet.getAttribute("aria-label"), "Now playing"); assert.ok(sheet.contains(B.rdj) && sheet.contains(P.px), "both blocks moved in");
  assert.equal(bar.getAttribute("aria-expanded"), "true");
  // a header in the sheet replaces it with its full sheet - focus comes back to the bar
  sheet.querySelector('[data-np="plex"] .rmd-np-h').click();
  assert.equal(h.doc.querySelector(".rmd-layer .ds-modal").getAttribute("aria-label"), "Plex queue & controls");
  assert.ok(card.contains(B.rdj), "the DJ block went home when the Now playing sheet closed");
  h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  assert.equal(h.doc.activeElement, bar); assert.ok(card.contains(P.px));
  // nothing plays any more while the sheet is open: it closes
  bar.click(); B.rdj.setAttribute("data-np", "idle"); P.px.hidden = true; h.mutate(B.rdj); h.mutate(P.px);
  assert.equal(h.doc.querySelector(".rmd-layer"), null); assert.equal(bar.hidden, true);
  h.controller.destroy();
  assert.equal(B.rdj.parentNode, h.panel, "the booth is back in the Live panel"); assert.ok(idx(B.rdj) < idx(h.panel.querySelector(".rm-live")), "before .rm-live");
  assert.equal(P.px.parentNode, P.gl, "the player is back in #rmGoLive");
  assert.equal(h.doc.getElementById("rmdNp"), null); assert.equal(h.doc.querySelector(".rmd-npbar"), null);
});

test("item 1: the homepage / the chat window build no Now playing; nothing new is fetched", () => {
  const p = harness({ opts: { mode: "preview" }, setup: (x) => { booth(x, []); } });
  assert.equal(p.doc.getElementById("rmdNp"), null); assert.equal(p.doc.querySelector(".rmd-npbar"), null);
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /main\.rm\.rm-dock \.rm-live > \.side > :not\(#rmPplCard, #rmdNp\) \{ display: none; \}/);
  assert.match(css, /main\.rm\.rm-dock \.rm-live > \.side > #rmdNp \{ display: grid;[^}]*max-block-size: calc\(100% - 208px\);[^}]*overflow-y: auto;/);
  assert.match(css, /\.side:has\(> #rmdNp:not\(\[hidden\]\)\) > #rmPplCard \{ flex: 1 1 0; min-block-size: 200px; \}/, "the people list shortens to make room - never under three rows");
  assert.match(css, /@media \(min-width: 1024px\) \{ main\.rm\.rm-dock \.rmd-npbar \{ display: none; \} \}/);
  assert.match(css, /#rmdNp #rmPlexQ :is\(\.pq-ctl \[data-skip\], \.pq-log, \.pq-q \.pq-li, \.pq-q > a\) \{ display: none; \}/, "the card's Plex essentials (the sheet has all)");
  assert.match(css, /main\.rm\.rm-dock \.rmd-layer \.rdj \.mini \{ grid-template-columns: 44px minmax\(0, 1fr\); \}/, "the DJ sheet's compact bar: controls on their own row");
});

test("item 1 (room.ejs): the 📼 player's rules are .plexq's own (card, sheets) and it is no live region; pad-plexq.js names its controls' scope", () => {
  const room = read("views", "room.ejs");
  assert.doesNotMatch(room, /\.golive-card \.plexq/, "no rule scoped to the Go live card");
  assert.match(room, /\.plexq \.pq-ctl \.sact \{ min-width: 44px; min-height: 40px; justify-content: center; \}/);
  assert.match(room, /<div class="plexq" id="rmPlexQ" data-room="<%= room\.slug %>" hidden><\/div>/, "no aria-live (its clock redraws every second)");
  assert.match(room, /pad-plexq\.js\?v=7/);   // (verify: v4 - focus kept across a redraw; upnext2: v6)
  assert.match(read("public", "js", "pad-plexq.js"), /aria-label="' \+ esc\(_t\('js\.plexq\.controls_all', 'Controls for everyone watching'\)\)/);
  assert.match(read("public", "js", "pad-plexq.js"), /<p class="pq-msg muted" role="status" aria-live="polite">/, "an action's answer is still said");
});

// ── item 2: the stage's media controls ──
function fakePlayer(log, extra = {}) {
  const hs = {}, lt = { edge: true, hs: [], isLive: () => extra.live !== false, atLiveEdge() { return this.edge; }, seekToLiveEdge() { log.push("seekToLiveEdge"); this.edge = true; }, on(e, f) { if (e === "liveedgechange") this.hs.push(f); } };
  const p = { st: { paused: false, muted: true, vol: 1, ctl: true }, on(e, f) { (hs[e] ||= []).push(f); }, fire(e) { (hs[e] || []).forEach((f) => f()); },
    paused() { return this.st.paused; }, play() { log.push("play"); this.st.paused = false; this.fire("play"); return Promise.resolve(); }, pause() { log.push("pause"); this.st.paused = true; this.fire("pause"); },
    muted(x) { if (x === undefined) return this.st.muted; log.push("muted:" + x); this.st.muted = !!x; this.fire("volumechange"); },
    volume(x) { if (x === undefined) return this.st.vol; log.push("volume:" + x); this.st.vol = x; this.fire("volumechange"); },
    controls(x) { if (x === undefined) return this.st.ctl; log.push("controls:" + x); this.st.ctl = !!x; }, liveTracker: lt, textTracks: () => extra.tracks || [] };
  return p;
}
function stageRig(opts = {}) {
  const log = [], ref = { view: "pepe" };
  let vj, un, emb;
  const h = harness({ mo: true, opts: { stage: { view: () => ref.view, selection: () => ({ stream: "pepe" }) } }, setup: (x) => {
    x.win.PATVStage = { setNativeControls: (on) => log.push("setNativeControls:" + on) };
    x.win.videojs = { getPlayer: (n) => n.player };
    if (opts.fine !== false) x.win.matchMedia = (q) => ({ matches: /pointer: fine/.test(q) });
    vj = x.make("div", "video-js", null, x.vid); vj.player = fakePlayer(log, opts);
    un = x.make("button", "unmute", "rmStUnmute", x.player); un.addEventListener("click", () => { log.push("unmute-layer"); vj.player.st.muted = false; un.classList.add("hide"); });
    emb = x.make("div", "embed hide", "rmEmbed", x.player);
  } });
  return { h, log, ref, vj, un, emb, box: () => h.stage.querySelector(".rmd-media"), btn: (l) => h.button(l, h.stage.querySelector(".rmd-ov-bot")) };
}
test("item 2: the Dock turns the native controls off (the flag, every new video.js player, the ⚡ video) and draws ⏯ / 🔉 / volume / LIVE for them", () => {
  const { h, log, vj, un, box, btn } = stageRig();
  assert.ok(log.includes("setNativeControls:false"), "the players are told before / while they run");
  assert.ok(log.includes("controls:false"), "a running player's own bar goes");
  const bot = h.stage.querySelector(".rmd-ov-bot");
  assert.equal(bot.children[0], box(), "[⏯][🔉][volume][LIVE] first, then the source chip");
  assert.equal(box().hidden, false);
  const play = btn("Pause"), snd = btn("Unmute the stage"), vol = box().querySelector("input"), live = box().querySelector(".rmd-media-live");
  assert.equal(play.querySelector(".ds-ic").textContent, "⏯️"); assert.equal(play.title, "Pause - just for you; the stage keeps going");
  assert.equal(snd.querySelector(".ds-ic").textContent, "🔇"); assert.equal(vol.getAttribute("type") || vol.type, "range"); assert.equal(vol.getAttribute("aria-label"), "Stage volume");
  assert.equal(live.getAttribute("aria-label"), "Playing live"); assert.equal(live.getAttribute("aria-disabled"), "true"); assert.equal(live.textContent, "LIVE");
  // 🔉 while the player's own tap-to-unmute layer is up: that button's own click (unmutes, plays, hides the layer)
  snd.click(); assert.deepEqual(log.filter((x) => /unmute|muted/.test(x)), ["unmute-layer"]);
  h.mutate(un); assert.equal(snd.getAttribute("aria-label"), "Mute the stage"); assert.equal(snd.querySelector(".ds-ic").textContent, "🔉");
  snd.click(); assert.ok(log.includes("muted:true")); assert.equal(snd.getAttribute("aria-label"), "Unmute the stage");
  play.click(); assert.ok(log.includes("pause")); assert.equal(play.getAttribute("aria-label"), "Play");
  play.click(); assert.equal(log.filter((x) => x === "play").length, 1);
  vol.value = "40"; vol.dispatchEvent(new Event("input", { bubbles: true }));
  assert.ok(log.includes("volume:0.4")); assert.ok(log.includes("muted:false"), "moving it above 0 unmutes"); assert.equal(vol.getAttribute("aria-valuetext"), "40%");
  // behind the live edge: Back to live
  vj.player.liveTracker.edge = false; vj.player.liveTracker.hs.forEach((f) => f());
  assert.equal(live.getAttribute("aria-label"), "Back to live"); assert.equal(live.hasAttribute("aria-disabled"), false);
  live.click(); assert.ok(log.includes("seekToLiveEdge")); assert.equal(live.getAttribute("aria-label"), "Playing live");
  // k / m while focus is on the stage (never in a field)
  const n0 = log.length; play.dispatchEvent(new Event("keydown", { key: "k", bubbles: true })); assert.equal(log[n0], "pause");
  vol.dispatchEvent(new Event("keydown", { key: "m", bubbles: true })); assert.equal(log.length, n0 + 1, "not from the volume slider");
  // a new video.js player (the stage switched streams): its controls go too
  const vj2 = h.make("div", "video-js", null, h.doc.getElementById("rmVideo")); vj2.player = fakePlayer(log); vj.remove();
  h.mutate(vj2); assert.equal(vj2.player.st.ctl, false, "controls(false) on the new one");
  // the mouse's double-click on the picture is the Dock's 🖥️
  h.stage.dispatchEvent(new Event("pointerdown", { bubbles: true, pointerType: "mouse" }));
  h.doc.getElementById("rmVideo").dispatchEvent(new Event("dblclick", { bubbles: true }));
  assert.ok(h.stage.classList.contains("rmd-full"), "fullscreen (dock3: in place)");
});
test("item 2: no media controls for an embed (a solid row instead), the mic stage, a cam slot, off air; the ⚡ <video> gets them; no slider without a fine pointer", () => {
  const { h, log, ref, vj, emb, box } = stageRig();
  emb.classList.remove("hide"); h.make("iframe", null, null, emb); h.mutate(emb);
  assert.equal(h.stage.classList.contains("rmd-embed"), true, "the overlay is a row under the iframe"); assert.equal(box().hidden, true, "the iframe has its own ⏯ / 🔉");
  emb.classList.add("hide"); emb.textContent = ""; h.mutate(emb); assert.equal(h.stage.classList.contains("rmd-embed"), false); assert.equal(box().hidden, false);
  ref.view = "mic"; h.stage.dispatchEvent(new Event("patv:stagechange", { detail: {} })); assert.equal(box().hidden, true, "the mic stage: its sound is the room audio bar");
  ref.view = "pepe"; const cam = h.make("div", "cam-stage", null, h.doc.getElementById("rmVideo")); h.mutate(cam); assert.equal(box().hidden, true, "a cam slot: muted by design");
  cam.remove(); h.stage.classList.replace ? h.stage.classList.replace("is-on", "is-off") : (h.stage.classList.remove("is-on"), h.stage.classList.add("is-off"));
  h.stage.dispatchEvent(new Event("patv:stagechange", { detail: null })); assert.equal(box().hidden, true, "off air");
  h.stage.classList.remove("is-off"); h.stage.classList.add("is-on");
  // the ⚡ low-latency <video> instead of video.js
  vj.remove(); const v = h.make("video", "rtc-video", null, h.doc.getElementById("rmVideo")); Object.assign(v, { paused: false, muted: true, volume: 1, controls: true, play() { log.push("rtc.play"); this.paused = false; return Promise.resolve(); }, pause() { log.push("rtc.pause"); this.paused = true; } });
  h.mutate(v); assert.equal(v.controls, false, "its native controls off"); assert.equal(box().hidden, false);
  h.button("Pause", h.stage).click(); assert.ok(log.includes("rtc.pause"));
  assert.equal(box().querySelector(".rmd-media-live").getAttribute("aria-label"), "Playing live", "WebRTC is always live");
  const coarse = stageRig({ fine: false });
  assert.equal(coarse.box().querySelector("input").hidden, true, "touch / iOS: no slider (the volume is the device's)");
});
test("item 2: one meaning per icon - ⏯ / 🔉 are the stage's, 🎶 Now playing; the CSS keeps the bars off the player's own controls", () => {
  const js = read("public", "js", "pad-dock.js");
  assert.match(js, /iconBtn\('⏯️', 'stage_play'/); assert.match(js, /iconBtn\('🔉', 'stage_mute'/);
  assert.match(js, /'⏯', '🔉', '🔇', '🎶'\]\)/, "DOCK_ICONS: a proxied item never borrows them");
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /main\.rm\.rm-dock #rmStage :is\(\.vjs-control-bar, \.vjs-big-play-button\) \{ display: none !important; \}/);
  assert.match(css, /main\.rm\.rm-dock #rmStage \{ container: rmd-stage \/ inline-size; \}/);
  assert.match(css, /@container rmd-stage \(max-width: 639px\) \{[^@]*\.rmd-media-play \{ position: absolute;[^}]*inline-size: 56px;/, "a phone's ⏯ is a round button in the picture");
  assert.match(css, /#rmStage\.rmd-unmute-up \.rmd-ov-bot \.rmd-media-play \{ display: none; \}/, "the first tap unmutes");
  assert.match(css, /main\.rm\.rm-dock #rmStage\.rmd-embed \{ grid-template-rows: minmax\(0, 1fr\) auto var\(--rmd-pin-row\); \}/);
  assert.match(css, /main\.rm\.rm-dock #rmStage\.rmd-embed \.rmd-ov \{ grid-area: 2 \/ 1;/, "the row under the iframe");
  assert.match(css, /main\.rm\.rm-dock #rmStage\.rmd-embed > #rmStrip \{ grid-area: 3 \/ 1; \}/);
});

// ── item 2: the players' nativeControls flag ──
function loadPlayer(flag) {
  const made = [], opts = [], players = [];
  const videojs = (el, o) => { opts.push(o); const p = { c: [], on() {}, src() {}, play() { return Promise.resolve(); }, controls(x) { p.c.push(x); }, dispose() {}, tech() { return null; } }; players.push(p); return p; };
  videojs.browser = {};
  const win = { videojs }; if (flag !== undefined) win.PATVStage = { nativeControls: flag };
  const ctx = { window: win, videojs, document: { createElement: (t) => { const e = { tag: t, attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } }; made.push(e); return e; } },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, Promise };
  vm.createContext(ctx); vm.runInContext(read("public", "js", "stage-player.js"), ctx);
  const wrap = { appendChild() {} };
  return { S: win.PATVStage, made, opts, players, make: () => win.PATVStage.player({ wrap, src: "https://x/a.m3u8" }) };
}
test("item 2: stage-player.js - no controls attribute and controls:false under the Dock's flag; on by default; setNativeControls tells running players", () => {
  const off = loadPlayer(false), p = off.make(); p.start();
  assert.equal("controls" in off.made[0].attrs, false); assert.equal(off.opts[0].controls, false);
  const on = loadPlayer(), q = on.make(); q.start();
  assert.equal(on.made[0].attrs.controls, ""); assert.equal(on.opts[0].controls, true, "/stage and a pad without the Dock keep them");
  on.S.setNativeControls(false); assert.deepEqual(on.players[0].c, [false]); assert.equal(on.S.nativeControls, false);
  q.stop(); on.S.setNativeControls(true); assert.deepEqual(on.players[0].c, [false], "a stopped player is left alone");
  q.start(); assert.equal(on.opts[1].controls, true);
});
test("item 2: stage-lowlat.js - the ⚡ <video> has no controls under the Dock's flag", async () => {
  const ctx = { window: { PATVStage: { nativeControls: false } }, Promise, String, Number };
  vm.createContext(ctx); vm.runInContext(read("public", "js", "stage-lowlat.js"), ctx);
  const el = (tag) => ({ tag, children: [], attrs: {}, listeners: {}, parentNode: null, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }, removeChild() {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener() {} });
  const wrapEl = el("div"); el("div").appendChild(wrapEl);
  const hls = { src: () => "a.m3u8", setSrc() {}, start() {}, stop() {}, state: () => null };
  const rtc = { play: () => new Promise(() => {}) };
  const p = ctx.window.PATVStage.rtcWrap(hls, { wrap: wrapEl }, { document: { createElement: el }, storage: { getItem: () => "1", setItem() {} }, rtc, MutationObserver: null,
    timers: { set: () => 1, clear() {}, now: () => 1 } });
  p.setSrc("a.m3u8", "https://x/whep/stage-1"); p.start();
  const v = wrapEl.children.find((c) => c.className === "rtc-video");
  assert.ok(v); assert.equal(v.controls, false);
  const src = read("public", "js", "stage-lowlat.js");
  assert.match(src, /video\.controls = !\(window\.PATVStage && window\.PATVStage\.nativeControls === false\);/);
});

// ── room-dj.js: data-np, the icon + words spans, Auto-DJ in the compact bar for DJ admins, the cancelable Request ──
function djPanel(o = {}) {
  const now = o.none ? null : { title: "Lively Up Yourself", artist: "Bob Marley & The Wailers", by: "user", who: "Aster Fable", playing: o.playing !== false, duration_ms: 310000, progress_ms: 73000 };
  return { active: o.active !== false, age: 0, room: { queue: true, play: true, pause: true, talk: true, patter: null, price: { queue: 2500, shoutout: 5000 } },
    state: { connected: o.connected !== false, now, queue: [], dj: { on: o.on !== false }, votes: { start: 4, stop: 2 }, maxPending: 2, shoutouts: [] },
    me: { linked: true, djAdmin: !!o.admin, musicAdmin: !!o.admin }, acts: [] };
}
function djRig() {
  const doc = new Document(), make = (tag, id, parent, text) => { const n = doc.createElement(tag); if (id) n.id = id; if (text) n.textContent = text; (parent || doc.body).appendChild(n); return n; };
  const box = make("section", "rdj"); box.className = "card rdj hide collapsed"; box.setAttribute("data-slug", "night-orchard"); box.setAttribute("data-linked", "1");
  make("button", "rdjTog", box);
  for (const id of ["rdjNow", "rdjBooth", "rdjPill", "rdjQueue", "rdjCtrls", "rdjReqBox", "rdjReqHint", "rdjVibeBox", "rdjVibeTitle", "rdjVibeVote", "rdjVibe", "rdjVibeHint", "rdjSoBox", "rdjSoHint",
    "rdjAdmin", "rdjAdminBtns", "rdjMine", "rdjMiniArt", "rdjMini", "rdjMiniT", "rdjMiniA", "rdjMiniTrack", "rdjMiniFill", "rdjMiniCtrls", "rdjFind", "rdjSo", "rdjSay", "rdjRes"]) make("div", id, box);
  make("input", "rdjFindQ", box); make("button", "rdjVibeSend", box, "🎧 Send ");
  let panel = djPanel();
  const win = { localStorage: { getItem: () => null, setItem() {} } };
  const ctx = { window: win, document: doc, localStorage: win.localStorage, CustomEvent: Event, Promise, JSON, Date, Math, Number, String,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(panel) }) };
  vm.createContext(ctx); vm.runInContext(read("public", "js", "room-dj.js"), ctx);
  return { doc, box, set: async (p) => { panel = p; doc.dispatchEvent(new Event("visibilitychange")); await flush(); } };
}
test("room-dj.js: data-np says what the booth shows (off / offline / idle / playing / paused)", async () => {
  const r = djRig(); await flush();
  assert.equal(r.box.getAttribute("data-np"), "playing");
  for (const [p, want] of [[djPanel({ playing: false }), "paused"], [djPanel({ none: true }), "idle"], [djPanel({ connected: false }), "offline"], [djPanel({ active: false }), "off"], [djPanel(), "playing"]]) {
    await r.set(p); assert.equal(r.box.getAttribute("data-np"), want, want);
  }
  assert.equal(r.box.classList.contains("hide"), false);
});
test("room-dj.js: each control is an icon span + a words span (the tooltip says the words first); 🙋 who asked; Auto-DJ / 🎲 only for DJ admins", async () => {
  const r = djRig(); await flush();
  const ctrls = () => r.doc.getElementById("rdjMiniCtrls").children;
  const skip = ctrls()[0];
  assert.equal(skip.querySelector(".ic").textContent, "⏭️"); assert.equal(skip.querySelector(".ic").getAttribute("aria-hidden"), "true");
  assert.equal(skip.querySelector(".w").textContent, "Vote skip"); assert.equal(skip.title, "Vote skip · Free · 2 votes skip it"); assert.equal(skip.textContent, "⏭️ Vote skip", "reads as before");
  assert.match(r.doc.getElementById("rdjMiniA").textContent, /Bob Marley & The Wailers · 🙋 Aster Fable/);
  const words = () => ctrls().map((b) => (b.querySelector(".w") || b).textContent);
  assert.deepEqual(words(), ["Vote skip", "Vote pause", "Request"], "no staff controls for a listener");
  await r.set(djPanel({ admin: true }));
  assert.deepEqual(words(), ["Skip", "Pause", "Request", "Pepe picks next", "Auto-DJ off"]);
  assert.deepEqual(ctrls().slice(3).map((b) => b.querySelector(".ic").textContent), ["🎲", "🛑"], "🎧 is the DJ booth itself");
  await r.set(djPanel({ admin: true, on: false }));
  assert.deepEqual(words().slice(-1), ["Auto-DJ on"]); assert.equal(ctrls().slice(-1)[0].querySelector(".ic").textContent, "🤖");
});
test("room-dj.js: the compact bar's 🔎 Request asks first (patv:djrequest, cancelable) - cancelled, the booth stays as it is", async () => {
  const r = djRig(); await flush();
  const req = () => r.doc.getElementById("rdjMiniCtrls").children.find((b) => /Request/.test(b.textContent));
  let n = 0; const stop = (e) => { n++; e.preventDefault(); };
  r.box.addEventListener("patv:djrequest", stop);
  req().click(); assert.equal(n, 1); assert.equal(r.box.classList.contains("collapsed"), true, "the Dock's - nothing opened here");
  r.box.removeEventListener("patv:djrequest", stop);
  req().click(); assert.equal(r.box.classList.contains("collapsed"), false, "anywhere else: the booth opens, as before");
});

// (item 3, the homepage's fullscreen: test/home-dock.test.js)

// ── item 4: a bounty's amount is its Reward ──
test("item 4: ＋ › Create › Bounty… - Reward in PAT (never Stake); the wager keeps Stake in PAT", () => {
  const h = harness({ data: (d) => { d.room.cmds = { "!bounty": 0, "!wager": 0 }; } });
  h.button("Add to the chat").click(); h.button("Bounty…", h.doc.querySelector(".rmd-menu")).click();
  const sheet = h.doc.querySelector(".rmd-layer");
  assert.match(sheet.textContent, /Reward in PAT/); assert.doesNotMatch(sheet.textContent, /Stake/);
  const amt = sheet.querySelectorAll("input")[1]; assert.equal(amt.getAttribute("aria-label"), "Reward in PAT");
  assert.equal(sheet.querySelector(".rmd-presets").getAttribute("aria-label"), "Reward");
  const ins = sheet.querySelectorAll("input"); ins[0].value = "someone sings it"; ins[1].value = "2m";
  ins[1].dispatchEvent(new Event("input")); sheet.querySelector("form").dispatchEvent(new Event("submit"));
  const go = sheet.querySelectorAll("button").find((b) => /Post bounty|Yes, post/.test(b.getAttribute("aria-label") || ""));
  assert.equal(go.getAttribute("aria-label"), "Yes, post 2,000,000 PAT", "a million or more asks once more - in its own words");
  assert.match(sheet.textContent, /press again/);
  h.button("Add to the chat").click();   // (the sheet's opener: this closes it)
  h.button("Add to the chat").click(); h.button("Wager…", h.doc.querySelector(".rmd-menu")).click();
  assert.match(h.doc.querySelector(".rmd-layer").textContent, /Stake in PAT/);
});

// ── 1.99ajy dockmedia verify: the review fixes ──
test("verify: the booth's answer line (#rdjSay) sits under its compact controls in the card, goes back into the full booth in the DJ sheet and on destroy()", () => {
  const log = [];
  let B, say;
  const h = harness({ mo: true, setup: (x) => { B = booth(x, log); say = x.make("div", "say", "rdjSay", B.rdj.querySelector("#rdjFull")); say.setAttribute("role", "status"); } });
  B.rdj.classList.remove("hide"); B.rdj.setAttribute("data-np", "playing"); h.mutate(B.rdj);
  const mini = h.doc.getElementById("rdjMini");
  assert.ok(say.parentNode === B.rdj && idx(say) === idx(mini) + 1, "right under the compact controls - its role=status with it");
  h.doc.getElementById("rmdNp").querySelector(".rmd-np-h").click();
  assert.ok(say.parentNode === h.doc.getElementById("rdjFull"), "the DJ sheet's full booth has it where the page drew it");
  h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  assert.ok(say.parentNode === B.rdj && idx(say) === idx(mini) + 1, "back under the controls in the card");
  h.controller.destroy();
  assert.ok(say.parentNode === h.doc.getElementById("rdjFull"), "destroy() puts it back");
});
test("verify: the DJ header opens the booth on its top (no song search focus, no phone keyboard); 🔎 Request still focuses it", () => {
  const log = [];
  let B;
  const h = harness({ mo: true, setup: (x) => { B = booth(x, log); } });
  B.rdj.classList.remove("hide"); B.rdj.setAttribute("data-np", "playing"); h.mutate(B.rdj);
  h.doc.dispatchEvent(new Event("pointerdown"));   // (a pointer opened it - a sheet would focus its main field)
  h.doc.getElementById("rmdNp").querySelector(".rmd-np-h").click(); h.tick();
  assert.notEqual(h.doc.activeElement, B.find, "not the search");
  assert.equal(h.doc.activeElement, h.doc.querySelector(".rmd-layer .ds-modal"), "the sheet itself");
  h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  h.doc.dispatchEvent(new Event("pointerdown")); B.req.click(); h.tick();
  assert.equal(h.doc.activeElement, B.find, "🔎 Request: the song search");
});
test("verify: headers say paused; both playing = the compact card (rmd-np-two); the bar names the film alone when only Plex plays", () => {
  const log = [];
  let B, P;
  const h = harness({ mo: true, setup: (x) => { B = booth(x, log); P = plex(x); } });
  const card = h.doc.getElementById("rmdNp"), bar = h.doc.querySelector(".rmd-npbar");
  B.rdj.classList.remove("hide"); B.rdj.setAttribute("data-np", "paused"); h.mutate(B.rdj);
  assert.equal(card.querySelector('[data-np="dj"] .rmd-np-h').getAttribute("aria-label"), "DJ booth · paused · Auto-DJ on");
  assert.equal(card.classList.contains("rmd-np-two"), false);
  assert.equal(bar.querySelector(".rmd-npbar-t").textContent, "Lively Up Yourself · Bob Marley & The Wailers", "the DJ alone: song · artist");
  const st = h.make("span", "muted pq-st", null, P.px.querySelector(".pq-now"), "· paused");
  P.px.hidden = false; h.mutate(P.px);
  assert.equal(card.classList.contains("rmd-np-two"), true, "both: the compact card");
  assert.equal(card.querySelector('[data-np="plex"] .rmd-np-h').getAttribute("aria-label"), "Plex · paused");
  B.rdj.setAttribute("data-np", "idle"); h.mutate(B.rdj);
  assert.equal(card.classList.contains("rmd-np-two"), false);
  assert.equal(bar.querySelector(".rmd-npbar-t").textContent, "The Night of the Hunter (1955)", "the film alone: the bar's 🎶 says what it is, no second 📼");
  st.remove(); h.mutate(P.px); assert.equal(card.querySelector('[data-np="plex"] .rmd-np-h').getAttribute("aria-label"), "Plex");
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /#rmdNp\.rmd-np-two #rmPlexQ \.pq-now :is\(\.pq-pos, \.pq-st, \.pq-by\) \{ display: none; \}/);
  assert.match(css, /#rmdNp\.rmd-np-more::after \{ content: ""; position: sticky;/, "a fade while the card has more below");
  assert.match(css, /\.rmd-layer #rmPlexQ \.pq-br \{ display: block; flex-basis: 100%; block-size: 0; \}/, "⏮ ⏸ ⏭ ⏹ together in the sheets");
});
test("verify: a paused stage keeps its bar and its ⏯ (rmd-paused); playing again, the bar hides on its timer", () => {
  const { h, vj, btn } = stageRig();
  btn("Pause").click();
  assert.equal(h.stage.classList.contains("rmd-paused"), true);
  for (let i = 0; i < 4; i++) h.tick();
  assert.equal(h.stage.classList.contains("rmd-controls-on"), true, "still up after the hide timer");
  btn("Play").click(); assert.equal(h.stage.classList.contains("rmd-paused"), false);
  h.tick(); assert.equal(h.stage.classList.contains("rmd-controls-on"), false, "the timer hides it again");
  assert.equal(vj.player.st.paused, false);
  assert.match(read("public", "css", "pad-dock.css"), /main\.rm\.rm-dock #rmStage\.rmd-paused \.rmd-ov-bot \.rmd-media-play \{ position: absolute;/, "the round ⏯ in the picture at any width");
});
test("dock3 item 4: iPhone (no element fullscreen) - a loaded video goes to iOS's own player in the tap; one that isn't, and every other kind, the full-window mode in place", async () => {
  const { h, log, vj, emb } = stageRig();
  const v = h.make("video", null, null, vj); v.readyState = 4; v.webkitEnterFullscreen = () => log.push("webkitEnterFullscreen");
  vj.player.el = () => vj;
  // (no element fullscreen at all, as on an iPhone; the documentElement's comes from the same prototype)
  const proto = Object.getPrototypeOf(h.stage), rf = proto.requestFullscreen; proto.requestFullscreen = undefined;
  try {
    h.button("Fullscreen", h.stage).click();
    assert.ok(log.includes("webkitEnterFullscreen"), "iOS's own player (native controls, its own ⛶)");
    assert.equal(h.stage.classList.contains("rmd-full"), false, "nothing of ours");
    // not loaded yet (iOS would refuse): the full-window mode
    v.readyState = 0; log.length = 0;
    h.button("Fullscreen", h.stage).click();
    assert.equal(log.includes("webkitEnterFullscreen"), false);
    assert.ok(h.stage.classList.contains("rmd-full") && h.stage.classList.contains("rmd-fakefull"), "the stage fixed over the page, in place");
    assert.ok(h.doc.body.classList.contains("rmd-fakefull-on"), "the page behind is locked");
    assert.ok(h.stage.closest("#padPanel-live") === h.panel, "nothing moved");
    assert.equal(h.button("Exit fullscreen", h.stage).getAttribute("aria-label"), "Exit fullscreen");
    h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
    assert.equal(h.stage.classList.contains("rmd-fakefull"), false, "Escape leaves it"); assert.equal(h.doc.body.classList.contains("rmd-fakefull-on"), false);
    // an embed: the full-window mode, the iframe never moves (it would reload)
    emb.classList.remove("hide"); const f = h.make("iframe", null, null, emb); h.mutate(emb);
    h.button("Fullscreen", h.stage).click();
    assert.ok(h.stage.classList.contains("rmd-fakefull")); assert.ok(f.parentNode === emb, "the iframe stays where it is");
    h.button("Exit fullscreen", h.stage).click(); assert.equal(h.stage.classList.contains("rmd-full"), false);
  } finally { proto.requestFullscreen = rf; }
  // with element fullscreen: the stage ITSELF, in place (Android, iPad, desktop)
  h.button("Fullscreen", h.stage).click(); await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.doc.fullscreenElement === h.stage, "the stage itself"); assert.ok(h.doc.querySelector(".rmd-fullscreen") === null, "no host");
  assert.equal(h.stage.classList.contains("rmd-fakefull"), false);
});
test("verify: the source chip reads 'name · source' (never 'Willow FableYouTube'); a narrow stage's ⋯ carries 📸 / 🎬 when the bar folds them", () => {
  const h = harness({ mo: true, setup: (x) => {
    const tabsN = x.doc.getElementById("rmTabs"); tabsN.children.forEach((c) => c.setAttribute("aria-selected", "false"));
    for (const [n, src, sel] of [["Willow Fable", "YouTube", true]]) {
      const b = x.make("button", "stab", null, tabsN); b.setAttribute("aria-selected", String(sel)); x.make("span", "n", null, b, n); if (src) x.make("span", "src", null, b, src);
    }
  } });
  const chip = h.stage.querySelector("button.rmd-src");
  assert.equal(chip.querySelector(".rmd-label").textContent, "Willow Fable · YouTube");
  assert.equal(chip.getAttribute("aria-label"), "Stage source: Willow Fable · YouTube");
  const snap = h.stage.querySelector(".rmd-cap-snap"); assert.ok(snap, "📸 carries its own class (pad-dock.css folds it under 480px)");
  snap.hidden = false; snap.getClientRects = () => [];   // (the container query hid it)
  h.button("Stage options").click();
  assert.ok(labels(h.doc.querySelector(".rmd-menu")).some((l) => /Snap/.test(l)), "📸 Snap in the stage ⋯");
  assert.match(read("public", "css", "pad-dock.css"), /@container rmd-stage \(max-width: 479px\) \{\s*main\.rm\.rm-dock #rmStage \.rmd-ov-bot > :is\(\.rmd-cap-snap, \.rmd-cap-clip\) \{ display: none; \}/);
});
test("verify: fullscreen with the chat shown - the chat ends above the stage's bar; one live dot", () => {
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /\.rmd-fullscreen:has\(> \.rmd-full-media > #rmStage\) > \.rmd-overlay \{ inset-block-end: calc\(var\(--ds-sp-2\) \+ 52px\); \}/);
  assert.match(css, /\.rmd-media:not\(\[hidden\]\):has\(> \.rmd-media-live:not\(\[hidden\]\)\) ~ \.rmd-src-host \.rmd-dot \{ display: none; \}/);
});
test("verify: pad-plexq.js / room-dj.js keep keyboard focus across their redraws (busy = aria-disabled, the same markup never rewritten)", async () => {
  const pq = read("public", "js", "pad-plexq.js");
  assert.match(pq, /if \(h === lastH && box\.firstChild\) \{ drawTimes\(\); return; \}/, "an unchanged poll writes nothing");
  assert.match(pq, /fk = focusKey\(\);\n    box\.innerHTML = h;/); assert.match(pq, /back\.focus\(\{ preventScroll: true \}\)/);
  assert.match(pq, /busy = true; lastH = '';\n    if \(btn\) btn\.setAttribute\('aria-disabled', 'true'\);/, "a pressed control keeps focus while it works");
  assert.match(pq, /data-q="stop"[^\n]*\n[^\n]*pq-br[^\n]*\n[^\n]*data-skip="-30"/, "⏮ ⏸ ⏭ ⏹, then the jumps");
  // room-dj.js, run: a focused control gets focus back after Pepe's next sync rebuilds the row (⏸ Pause -> ▶ Resume keeps the place)
  const r = djRig(); await flush();
  const row = () => r.doc.getElementById("rdjMiniCtrls");
  row().children[1].focus(); assert.equal(r.doc.activeElement.getAttribute("data-verb"), "pause");
  await r.set(djPanel({ playing: false }));
  assert.equal(r.doc.activeElement.parentNode, row(), "still in the row"); assert.equal(r.doc.activeElement.getAttribute("data-verb"), "resume", "the control in its place");
  row().children.find((b) => b.getAttribute("data-verb") === "request").focus();
  await r.set(djPanel());
  assert.equal(r.doc.activeElement.getAttribute("data-verb"), "request", "the same verb");
  assert.match(read("public", "js", "room-dj.js"), /if \(busy\) b\.setAttribute\('aria-disabled', 'true'\);/);
});
