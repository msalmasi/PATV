"use strict";
// dock3 (owner 2026-11-05 item 4: "I can't full screen a stage chrome mobile from our overlay button. And our controls block the native player
// controls where the native full screen button is so I can't use that.") 1.99?? - the static half (the behaviour is in pad-dock-media2 /
// pad-dock-ui, the browsers' in the dock3 evidence kit): the stage fullscreen IN PLACE, the iPhone full-window mode and its ways out, the
// webkit-prefixed API of older iPads, Android's landscape turn, the touch fade, an embed's chat beside / under it, a phone on its side.
//   node --test test/dock3-fullscreen.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");

test("pad-dock.js: in place (no move of the stage), element fullscreen or the full-window mode, native player on an iPhone only for a loaded video", () => {
  const js = read("public", "js", "pad-dock.js");
  assert.match(js, /if \(n === stage\) \{ fullStage\(\); return; \}/, "the stage never goes through the moving host");
  assert.match(js, /stage\.classList\.add\('rmd-full'\); changed\(\);\n\s+enterFs\(stage\);/, "element fullscreen on #rmStage itself");
  assert.match(js, /if \(!fsApi\(\)\) \{ fake\(\); return; \}/, "no element fullscreen: the full-window mode");
  assert.match(js, /function \(\) \{ if \(current === my && !fsEl\(\)\) fake\(\); \}/, "a refused request: the full-window mode, never a dead button");
  assert.match(js, /typeof h\.webkitRequestFullscreen === 'function'/, "older iPads' prefixed API");
  assert.match(js, /on\(D, 'webkitfullscreenchange', fsGone\)/);
  assert.match(js, /v\.webkitSupportsFullscreen === false \|\| !\(v\.readyState >= 1\)\) return false;/, "iOS's player only for a loaded video (it refuses otherwise)");
  assert.match(js, /v\.addEventListener\('webkitbeginfullscreen', onBegin\);/, "a refusal that doesn't throw falls back too");
  assert.match(js, /st\.rmdFull = 1; W\.history\.pushState\(st, ''\);/, "a history entry: iOS's edge swipe leaves the mode, not the page");
  assert.match(js, /on\(W, 'popstate', function \(\) \{ if \(fakePop\) \{ fakePop--; return; \} if \(fakeOn\(\)\) \{ current\.popped = true; redock\(\); \} \}\);/);
  assert.match(js, /\} else if \(e\.key === 'Escape' && fakeOn\(\)\) \{/);
  assert.match(js, /so\.lock\('landscape'\)/, "Android: a wide picture turns the screen");
  assert.match(js, /W\.screen\.orientation\.unlock\(\)/);
  assert.match(js, /TOUCH_HIDE_MS = 4500, FADE_MS = 250/, "touch: the bar stays longer and takes taps until its fade has run");
  assert.match(js, /if \(old\.inPlace\) \{ stage\.classList\.remove\('rmd-full', 'rmd-chat-on'\);/, "leaving keeps the card where it is");
});

test("pad-dock.css: :fullscreen and the full-window rules, the trap-lifting attribute, an embed's chat out of its picture, a phone on its side", () => {
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /main\.rm\.rm-dock #rmStage\.rmd-full:fullscreen \{ inline-size: 100%; block-size: 100%; max-block-size: none;/);
  assert.match(css, /main\.rm\.rm-dock #rmStage\.rmd-full\.rmd-fakefull \{ position: fixed; inset: 0; z-index: var\(--ds-z-modal\);/);
  assert.match(css, /main\.rm\.rm-dock\[data-rmd-unc\], main\.rm\.rm-dock \[data-rmd-unc\] \{ container-type: normal !important;/);
  assert.match(css, /body\.rmd-fakefull-on \{ overflow: hidden; overscroll-behavior: none; \}/);
  assert.match(css, /main\.rm\.rm-dock #rmStage\.rmd-full\.rmd-embed\.rmd-chat-on > \.rmd-overlay \{ position: static; grid-area: 3 \/ 1;/, "portrait: the chat under the picture and its bar");
  assert.match(css, /@media \(orientation: landscape\) \{\n  main\.rm\.rm-dock #rmStage\.rmd-full\.rmd-embed\.rmd-chat-on \{ grid-template-columns: minmax\(0, 1fr\) min\(400px, 40%\);/, "wide: beside it");
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 500px\) and \(pointer: coarse\) \{\n  body\.pad-dock-live \{ block-size: auto; min-block-size: 0; \}/);
  assert.match(css, /body\.pad-dock-live main\.rm\.rm-dock #rmStage \{ block-size: calc\(100dvh - var\(--ds-sp-2\) - var\(--ds-sp-2\)\); max-block-size: none; min-block-size: 0; \}/);
});
