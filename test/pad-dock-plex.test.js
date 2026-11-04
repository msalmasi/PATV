"use strict";
// 1.99?? casino2 (owner 2026-11-04: "Did we ever get the ability for users to start a Plex play from the room? And for staff to put it on
// Pepe's cam from the room?"): the Room Dock's 📼 Play from Plex… (pad-dock.js plexSheet + plex-play.js, the flow /stage runs), and the
// owner's "user submenu the user and avatar are not aligned" (the person menu's header).
//   * the item shows only when the pad page says so (bridge.js plexPlay = medialib.goLiveInfo show && ok) and plex-play.js is loaded
//   * it opens a Dock sheet with the shared flow for THIS pad (room id, the pad's title, your name for the balance); no 'book for later'
//     there (a link to /stage instead); staff who run Pepe's on-air get '📺 Also put it on Pepe's stream' (onair: true)
//   * staff keep ▶️ Play content here (onair-bar.js, proxied), only where Pepe's stream is the stage
//   * the person menu's header: the avatar spans two rows only when the login line is there
//   node --test test/pad-dock-plex.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { harness } = require("./fixtures/pad-dock/dom.cjs");
const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

function stub() {
  const s = { built: [], mounted: [], info: 0 };
  s.api = { build(host, o) { s.built.push(o); const f = host.ownerDocument.createElement("input"); f.setAttribute("type", "search"); host.appendChild(f); return host; },
    mount(host, o) { s.mounted.push(o); return { info() { s.info++; } }; } };
  return s;
}
const items = (h) => { try { h.button("Stage options"); } catch (e) { return []; } h.button("Stage options").click(); const m = h.doc.querySelector(".rmd-menu"); const out = m ? m.querySelectorAll("button,a").map((b) => b.getAttribute("aria-label") || b.textContent) : []; h.button("Stage options").click(); return out; };

test("📼 Play from Plex… shows only when the page offers it and plex-play.js is there", () => {
  const none = harness({ opts: { room: "Dock.Equipped" } });
  assert.equal(items(none).some((x) => /Play from Plex/.test(x)), false, "no plexPlay: no item");
  const s = stub();
  const noScript = harness({ opts: { room: "Dock.Equipped", plexPlay: { free: true } } });
  assert.equal(items(noScript).some((x) => /Play from Plex/.test(x)), false, "no PATVPlexPlay: no item");
  const yes = harness({ win: (w) => { w.PATVPlexPlay = s.api; }, opts: { room: "Dock.Equipped", plexPlay: { free: false, member: false, price_per_hour: 50000, quality: 1080, queue: true } } });
  assert.ok(items(yes).includes("Play from Plex…"));
  const win = harness({ win: (w) => { w.PATVPlexPlay = s.api; }, opts: { mode: "popout", room: "Dock.Equipped", vt: "t", plexPlay: { free: true } } });
  assert.equal(items(win).some((x) => /Play from Plex/.test(x)), false, "not in the chat window (it has no stage)");
});

test("it opens the shared flow in a Dock sheet for THIS pad - the price note, Book for later on /stage, the on-air option only for staff", () => {
  const s = stub();
  const h = harness({ win: (w) => { w.PATVPlexPlay = s.api; }, opts: { room: "Dock.Equipped", padTitle: "Night Orchard", plexPlay: { free: false, member: false, price_per_hour: 50000, quality: 1080, queue: true, onair: false } } });
  h.menuPick("Stage options", "Play from Plex…");
  const box = h.doc.querySelector(".rmd-layer [role=dialog]");
  assert.equal(box.getAttribute("aria-label"), "Play from Plex");
  assert.ok(box.querySelector(".rmd-plex"), "the flow's host");
  assert.equal(s.built[0].onair, false);
  // (review: the same words as the confirm - "taken now ... it all comes back" - not "held / refunded")
  assert.match(s.built[0].note, /50,000 PAT per started hour, taken when you start it - if it never gets on the stage, it all comes back\./);
  const o = s.mounted[0];
  assert.equal(o.inlineConfirm, true, "review: the Dock's price confirm is a row in the sheet, never the browser's dialog");
  assert.equal(o.roomId(), "Dock.Equipped"); assert.equal(o.roomTitle(), "Night Orchard"); assert.equal(o.me, "viewer-fable");
  assert.equal(o.later, false, "book for later stays on /stage"); assert.equal(o.perHour, 50000); assert.equal(o.queues, true); assert.equal(o.free, false);
  assert.equal(s.info, 1, "the streams / plays-left line is asked at once");
  assert.equal(box.querySelector(".rmd-plex-later").getAttribute("href"), "/stage?mode=plex");
  const s2 = stub();
  const st = harness({ win: (w) => { w.PATVPlexPlay = s2.api; }, opts: { room: "Dock.Equipped", plexPlay: { member: true, free: true, onair: true } } });
  st.menuPick("Stage options", "Play from Plex…");
  assert.equal(s2.built[0].onair, true, "staff with onair.operate: 📺 Also put it on Pepe's stream");
  assert.match(s2.built[0].note, /Plex members play free/);
});

test("the server side: bridge.js offers it by medialib.goLiveInfo (show && ok) for a signed-in viewer of the live room, the on-air option for staff off Pepe's pad", () => {
  const src = read("bridge.js");
  // review F9: only where the pad's stage can take a library slot (the main stage on, slots on the pad)
  assert.match(src, /const stageTakes = !!\(roomStage && roomStage\.enabled && roomStage\.room && Number\(roomStage\.room\.slot_count\) > 0\);/);
  assert.match(src, /if \(signedIn && liveOpen && adultGate === "ok" && stageTakes && require\("\.\/paddock"\)\.viewerOn\(req\.user\)\) \{/);
  assert.match(src, /const g = await require\("\.\/medialib"\)\.goLiveInfo\(req\.user\);\s*if \(g && g\.show && g\.ok\) plexPlay = /);
  assert.match(src, /onair: SP\.can\(req\.user, "onair\.operate"\) && !\(pepeIn\(R\.id\) && stage\(\)\.active\)/);
  const room = read("views", "room.ejs");
  assert.match(room, /<% if \(locals\.plexPlay && !chatOnly_\) \{ %><script src="\/public\/js\/plex-play\.js\?v=1"><\/script><% \} %>/);
  assert.match(room, /plexPlay: <%- !chatOnly_ && locals\.plexPlay \? JSON\.stringify\(locals\.plexPlay\)\.replace\(\/<\/g, '\\\\u003c'\) : 'null' %>/, "escaped for a script");
  // the flow: one copy (plex-play.js), the on-air call after a start, and its parts
  const flow = read("public", "js", "plex-play.js");
  assert.doesNotThrow(() => new vm.Script(flow));
  assert.match(flow, /body: JSON\.stringify\(\{ action: 'slot', slot_id: id \}\)/);
  assert.match(flow, /j\.code === 'not_live' && n < 15/, "a slot not live yet is asked again for about a minute");
  for (const k of ["info", "search", "results", "pick", "msg"]) assert.match(flow, new RegExp('data-px="' + k + '"'));
  // review: an inline confirm where asked (the Dock), confirm() on /stage; the on-air box goes into the pick above ▶ Play; done state
  assert.match(flow, /var ask = function \(msg, yesLabel, btn, yes\) \{\s*if \(!opts\.inlineConfirm\) \{ if \(confirm\(msg\)\) yes\(\); return; \}/);
  assert.equal((flow.match(/confirm\(/g) || []).length, 1, "the browser's confirm only behind ask()");
  assert.match(flow, /if \(row && row\.parentNode\) row\.parentNode\.insertBefore\(onairLbl, row\);/);
  assert.match(flow, /btn\.textContent = _t\('js\.plex\.started_btn', '✓ Started'\)/);
  assert.match(flow, /b\.classList\.toggle\('on', !!on\); b\.setAttribute\('aria-pressed', on \? 'true' : 'false'\);/);
  assert.match(read("public", "css", "pad-dock.css"), /\.rmd-layer \.ds-modal:has\(> \.rmd-plex\) > \.ds-modal-h \{ position: sticky; inset-block-start: calc\(-1 \* var\(--ds-sp-5\)\);[^}]*background: var\(--ds-surface-3\); \}/, "the sheet's title and ✕ stay in view (over the modal's top padding, opaque)");
  assert.match(read("public", "js", "stage-plex.js"), /window\.PATVPlexPlay\.mount\(panel, \{/);
  // staff: ▶️ Play content here stays the proxied on-air bar (where Pepe's stream is the stage: stage-room.js)
  assert.match(read("public", "js", "stage-room.js"), /if \(window\.PATVOnAirBar && pepeHere\) window\.PATVOnAirBar\.sync/);
  assert.match(read("public", "js", "onair-bar.js"), /\(C\.allow_library\s*\? '<form class="oap-plexq">/, "its 📼 Plex tab, or the reason when library plays are off");
});

test("the owner's 'the user and avatar are not aligned': the person menu's avatar spans two rows only with the login line", () => {
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /\.pm-pop\.rmd-pm \.pm-pop-n \.av \{ grid-column: 1; grid-row: 1; inline-size: 32px;/, "one row by default");
  assert.match(css, /\.pm-pop\.rmd-pm \.pm-pop-n:is\(\.two, :has\(> \.pm-login\)\) \.av \{ grid-row: 1 \/ span 2; \}/);
  assert.match(read("views", "room.ejs"), /title\.appendChild\(el\('small', 'pm-login', lg\)\); title\.classList\.add\('two'\);/);
  assert.match(read("public", "js", "casino-ui.js"), /sm\.textContent = u\.login; title\.appendChild\(sm\); title\.classList\.add\("two"\);/, "the casino tables' header too");
});
