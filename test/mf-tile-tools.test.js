// 1.99ain (owner 2026-11-03: "get the report and pin buttons to auto hide on the mic follows cams - they are very large and
// distracting"): the mic-stage tile's corner buttons (⚑ report, 📌 pin, ✕ / 📌✕, all .mf-x) are hidden and take no clicks until
// the tile is hovered or one of them has keyboard focus; on a touch screen a tap on the tile shows them for 4 s.
//   node --test test/mf-tile-tools.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

test("webrtc.css hides the corner buttons until hover, focus or a tap", () => {
  const css = read("public", "css", "webrtc.css");
  assert.match(css, /\.player \.mf-stage \.mf-tile \.mf-x \{ opacity: 0; pointer-events: none;/, "hidden and not clickable by default");
  for (const sel of [".mf-tile:hover .mf-x", ".mf-tile:focus-within .mf-x", ".mf-tile.mf-tools .mf-x"]) {
    assert.ok(css.includes(".player .mf-stage " + sel), "shown on " + sel);
  }
  assert.match(css, /\.mf-tile:focus-within \.mf-x,[\s\S]{0,80}\.mf-tile\.mf-tools \.mf-x \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.player \.mf-stage \.mf-tile \.mf-x \{ transition: none; \} \}/);
  // the [hidden] rule still wins: a button the page hides never shows on hover
  assert.ok(css.indexOf(".mf-tile .mf-x[hidden] { display: none; }") >= 0);
});

test("stage-mic.js: a touch tap on a tile shows its buttons for 4 s; a mouse click doesn't", () => {
  const src = read("public", "js", "stage-mic.js");
  const i = src.indexOf("var toolsT = 0;");
  assert.ok(i > 0, "the tap handler is there");
  const body = src.slice(i, src.indexOf("x.addEventListener('click'", i));
  // run the handler on a fake tile element with a fake clock
  const classes = new Set(), timers = [];
  let handler = null;
  const e = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
              addEventListener: (type, fn) => { if (type === "pointerup") handler = fn; } };
  vm.runInNewContext(body, { e, clearTimeout: () => {}, setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; } });
  assert.equal(typeof handler, "function");
  handler({ pointerType: "mouse" });
  assert.equal(classes.has("mf-tools"), false, "a mouse uses :hover instead");
  handler({ pointerType: "touch" });
  assert.equal(classes.has("mf-tools"), true, "a tap shows the buttons");
  assert.equal(timers.at(-1)[1], 4000);
  timers.at(-1)[0]();
  assert.equal(classes.has("mf-tools"), false, "and they hide again after 4 s");
});

test("the pages load the new stylesheet and script", () => {
  for (const v of ["home.ejs", "room.ejs", "stageBook.ejs"]) assert.ok(read("views", v).includes("/public/css/webrtc.css?v=9"), v + ": webrtc.css v9");
  assert.ok(read("views", "room.ejs").includes("/public/js/stage-mic.js?v=15"), "room.ejs: stage-mic.js v15");
});
