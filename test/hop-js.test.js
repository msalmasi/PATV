"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
function boot(page = true) {
  const events = {}, calls = [], nodes = [];
  function el() {
    const classes = new Set();
    const e = { listeners: {}, children: [], attrs: {}, style: {}, connected: true,
      classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x),
        toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } },
      appendChild(x) { this.children.push(x); }, setAttribute(k,v) { this.attrs[k]=v; },
      getAttribute(k) { return this.attrs[k]; }, addEventListener(k,f) { this.listeners[k]=f; },
      querySelectorAll() { return []; }, focus() {}, remove() { this.connected=false; } };
    nodes.push(e); return e;
  }
  const init = { textContent: JSON.stringify({ items: [], back: "/p/flowers", base: "/p/flowers/hop" }) };
  const document = { documentElement: el(), body: el(), readyState: "complete", referrer: "https://example.test/feed",
    createElement: el, getElementById: id => page && id === "hopInit" ? init : null,
    querySelector() { return null; }, addEventListener() {}, removeEventListener() {}, contains: e => e.connected };
  const window = { addEventListener: (k,f) => events[k]=f };
  const history = { length: 3, state: null, back() { calls.push("back"); }, pushState(s) { this.state=s; calls.push("push"); } };
  const location = { origin: "https://example.test", replace: url => calls.push(url) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../public/js/hop.js"),"utf8"), {
    window, document, history, location, URL, IntersectionObserver: class { disconnect() {} },
    localStorage: { getItem() { return null; } }
  });
  return { window, document, events, calls };
}
test("page close replaces its return URL even with same-site referrer and forward history", () => {
  const b=boot();
  b.window.patvHop._state().x.listeners.click();
  assert.deepEqual(b.calls,["/p/flowers"]);
  assert.ok(b.window.patvHop._state().root.connected,"viewer stays visible until navigation");
  assert.ok(b.document.documentElement.classList.contains("hop-js"));
});
test("overlay close goes back through its own pushed entry, then removes only the viewer", () => {
  const b=boot(false);
  b.window.patvHop.open({ items: [] });
  b.window.patvHop._state().x.listeners.click();
  assert.deepEqual(b.calls,["push","back"]);
  b.events.popstate({state:null});
  assert.equal(b.window.patvHop._state(),null);
});
test("bfcache restoration keeps a live page viewer or rebuilds a missing one", () => {
  const b=boot(), first=b.window.patvHop._state();
  b.events.pageshow({persisted:true});
  assert.equal(b.window.patvHop._state(),first);
  first.root.remove();
  b.events.pageshow({persisted:true});
  assert.notEqual(b.window.patvHop._state(),first);
  b.window.patvHop._state().x.listeners.click();
  assert.deepEqual(b.calls,["/p/flowers"]);
});
test("page close with no return URL defaults to the feed", () => {
  const b=boot(false); b.window.patvHop.open({ mode:"page",items:[] });
  b.window.patvHop._state().x.listeners.click(); assert.deepEqual(b.calls,["/feed"]);
});

test("Hop footer keeps cosmetic names legible, clipped and motion-aware", () => {
  const css=fs.readFileSync(path.join(__dirname,"../public/css/hop.css"),"utf8");
  assert.match(css,/\.hop-by \.cx-name \{[^}]*text-shadow: none;[^}]*drop-shadow[^}]*font-weight: 700/);
  assert.match(css,/@keyframes cx-shift/);
  assert.match(css,/@media \(prefers-reduced-motion: reduce\) \{ \.hop-by \.cx-name \{ animation: none !important/);
  assert.match(css,/\.hop-by \{[^}]*white-space: nowrap;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/);
  assert.match(css,/\.hop-av \{[^}]*width: 18px;[^}]*height: 18px;[^}]*vertical-align:/);
  const boot=fs.readFileSync(path.join(__dirname,"../views/partials/hop-boot.ejs"),"utf8");
  assert.match(boot,/hop\.css\?v=5/); assert.match(boot,/hop\.js\?v=6/);
});
