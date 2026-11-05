"use strict";
// dock3 (owner 2026-11-05 item 3: "add plex control to chat app") 1.99??: ⚡ Chat apps gets ONE 📼 Plex tile beside 🎧 DJ (pad-dock.js plexApp):
//   * shown while something from Plex plays on this pad's stage (#rmPlexQ), while this viewer may start a play here (o.plexPlay +
//     plex-play.js - the server's rule: Plex members, the override list, staff, the pad's settings), or while Pepe offers !plex here
//   * playing: its sheet IS the Plex queue & controls (the same node the Now playing card holds - its own buttons and server checks), with
//     ‹ Chat apps, ▶ Play from Plex… for whoever may start one, and the !plex command tiles (insert, never send)
//   * nothing playing: "Nothing from Plex…", Play from Plex… / the tiles as allowed; nobody allowed and nothing on: no tile at all
//   node --test test/dock3-plex-app.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { harness, Event } = require("./fixtures/pad-dock/dom.cjs");
const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");
const EN = JSON.parse(read("locales", "en.json"));

function plex(x) {
  const gl = x.make("section", "card golive-card", "rmGoLive", x.panel), px = x.make("div", "plexq", "rmPlexQ", gl); px.hidden = true;
  const now = x.make("div", "pq-now", null, px); x.make("b", null, null, now, "📼 The Night of the Hunter (1955)");
  const ctl = x.make("div", "pq-ctl", null, px); x.make("button", "sact", null, ctl, "⏸").setAttribute("data-q", "pause");
  const q = x.make("details", "pq-q", null, px); q.open = false; x.make("summary", null, null, q, "Up next (2)");
  return { px, q };
}
const stub = () => ({ build(host) { return host; }, mount() { return { info() {} }; } });
const appsSheet = (h) => { h.button("Chat apps").click(); return h.doc.querySelector(".rmd-layer"); };
const has = (root, name) => { try { return !!root.querySelectorAll("button").find((b) => b.getAttribute("aria-label") === name); } catch (e) { return false; } };

test("the 📼 Plex tile: beside 🎧 DJ under 'Music & video' while Plex is on here; none while nobody may start one, nothing plays and Pepe doesn't offer !plex", () => {
  const none = harness({ data: (d) => { d.room.cmds = { "!np": 0, "!find": 0 }; } });
  let a = appsSheet(none);
  assert.ok(has(a, "DJ")); assert.equal(has(a, "Plex"), false, "no Plex here: no tile"); assert.match(a.textContent, /Music/); assert.doesNotMatch(a.textContent, /Music & video/);
  const cmd = harness({ data: (d) => { d.room.cmds = { "!np": 0, "!plex": 0 }; } });
  a = appsSheet(cmd);
  assert.ok(has(a, "DJ") && has(a, "Plex"), "Pepe offers !plex: the tile");
  assert.match(a.textContent, /Music & video/);
  const tiles = a.querySelectorAll(".rmd-app").map((b) => b.getAttribute("aria-label"));
  assert.ok(tiles.indexOf("Plex") === tiles.indexOf("DJ") + 1, "right after 🎧 DJ");
  assert.match(a.querySelectorAll(".rmd-app").find((b) => b.getAttribute("aria-label") === "Plex").textContent, /📼Plexmovies & shows/);
  const play = harness({ win: (w) => { w.PATVPlexPlay = stub(); }, opts: { room: "Dock.Equipped", plexPlay: { free: true } }, data: (d) => { d.room.cmds = {}; } });
  assert.ok(has(appsSheet(play), "Plex"), "a viewer who may start a play: the tile (no DJ, no commands needed)");
  const noScript = harness({ opts: { room: "Dock.Equipped", plexPlay: { free: true } }, data: (d) => { d.room.cmds = {}; } });
  assert.equal(has(appsSheet(noScript), "Plex"), false, "plex-play.js not on the page: nothing to start");
});

test("playing: the tile opens the Plex queue & controls (the same node, its queue unfolded) + ‹ Chat apps, ▶ Play from Plex…, the !plex tiles; closing puts it back", () => {
  let P;
  const h = harness({ mo: true, setup: (x) => { P = plex(x); }, win: (w) => { w.PATVPlexPlay = stub(); }, opts: { room: "Dock.Equipped", plexPlay: { free: true } },
    data: (d) => { d.room.cmds = { "!plex": 0 }; } });
  P.px.hidden = false; h.mutate(P.px);
  const card = h.doc.getElementById("rmdNp");
  const a = appsSheet(h);
  assert.match(a.querySelectorAll(".rmd-app").find((b) => b.getAttribute("aria-label") === "Plex").textContent, /now playing, queue/);
  h.button("Plex", a).click();
  const sheet = h.doc.querySelector(".rmd-layer .ds-modal");
  assert.equal(sheet.getAttribute("aria-label"), "Plex queue & controls");
  assert.ok(sheet.contains(P.px), "the queue & controls node itself - its buttons, its checks");
  assert.equal(P.q.open, true, "the whole queue");
  assert.ok(sheet.querySelector(".rmd-sheet-back"), "‹ Chat apps");
  assert.ok(h.button("Play from Plex…", sheet), "▶ Play from Plex… for whoever may start one");
  for (const n of ["Find a title (!plex), free", "What’s playing (!plex np), free", "Queue it next (!plex queue), free"]) assert.ok(h.button(n, sheet), n);
  h.button("What’s playing (!plex np), free", sheet).click();
  assert.equal(h.input.value, "!plex np", "a tile inserts"); assert.equal(h.calls.send.length, 0, "never sends");
  assert.equal(P.px.closest("#rmdNp"), card, "the sheet closed: the node is back in the Now playing card");
  assert.equal(P.q.open, false, "folded again");
  // the queue tile leaves a space for the title
  h.button("Chat apps").click(); h.button("Plex", h.doc.querySelector(".rmd-layer")).click();
  h.button("Queue it next (!plex queue), free", h.doc.querySelector(".rmd-layer")).click();
  assert.equal(h.input.value, "!plex queue ");
});

test("nothing playing: the idle line, then Play from Plex… opens the shared flow; a viewer without the right gets only Pepe's !plex tiles; ‹ Chat apps goes back", () => {
  const h = harness({ win: (w) => { w.PATVPlexPlay = stub(); }, opts: { room: "Dock.Equipped", plexPlay: { free: false, price_per_hour: 50000 } }, data: (d) => { d.room.cmds = { "!plex": 0 }; } });
  h.button("Plex", appsSheet(h)).click();
  let sheet = h.doc.querySelector(".rmd-layer .ds-modal");
  assert.equal(sheet.getAttribute("aria-label"), "Plex");
  assert.match(sheet.textContent, /Nothing from Plex on this pad’s stage right now/);
  h.button("Play from Plex…", sheet).click();
  sheet = h.doc.querySelector(".rmd-layer .ds-modal");
  assert.equal(sheet.getAttribute("aria-label"), "Play from Plex", "the flow /stage runs (plexSheet)");
  const v = harness({ data: (d) => { d.room.cmds = { "!plex": 0 }; } });
  h.doc.dispatchEvent(new Event("keydown", { key: "Escape" }));
  v.button("Plex", appsSheet(v)).click();
  sheet = v.doc.querySelector(".rmd-layer .ds-modal");
  assert.equal(sheet.querySelectorAll("button").some((b) => b.getAttribute("aria-label") === "Play from Plex…"), false, "no right to start one: no button (the server would refuse)");
  assert.ok(v.button("Find a title (!plex), free", sheet));
  v.button("Back to chat apps", sheet).click();
  assert.equal(v.doc.querySelector(".rmd-layer .ds-modal").getAttribute("aria-label"), "Chat apps", "back");
});

test("strings and look: every new key in en.json; the tile is the DJ tile's look (.rmd-app); the Play row's CSS", () => {
  for (const k of ["apps_media", "app_plex_tile", "app_plex_sub", "app_plex_sub_np", "plex_app_title", "plex_idle", "px_cmds", "px_find", "px_np", "px_queue"]) assert.ok(EN["js.pad.dock." + k], k);
  const css = read("public", "css", "pad-dock.css"), js = read("public", "js", "pad-dock.js");
  assert.match(css, /main\.rm\.rm-dock \.rmd-px-row > \.rmd-px-play \{ inline-size: 100%; justify-content: center; \}/);
  assert.match(js, /function plexOn\(\) \{ return npPlex\(\) \|\| canPlexPlay\(\) \|\| hasCmd\('!plex'\); \}/);
  assert.match(js, /function canPlexPlay\(\) \{ return !!\(o\.plexPlay && W\.PATVPlexPlay && mode === 'pad'\); \}/, "the same rule as the stage ⋯'s Play from Plex…");
});
