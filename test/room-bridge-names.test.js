"use strict";
// 1.99?? dockclean (Room Dock clean-up, owner point 30): the composer's name autocomplete (room-bridge.js relay, opts.people) - after "@"
// or in a "!command " line's second word; Tab / Enter / a tap accepts, ↑ ↓ move, Esc closes; the "!" command list is unchanged. The page's
// candidate list (room.ejs acPeople) completes a named member to their login, a web user to their PATV name, an incognito person only to
// their frog name, and never offers a hidden (!bridge hide) person, "someone", Pepe or the viewer.
//   node --test test/room-bridge-names.test.js
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { Document, Event } = require("./fixtures/pad-dock/dom.cjs");
const repo = path.resolve(__dirname, "..");
function page(people) {
  const doc = new Document();
  const store = new Map();
  const ctx = { console, document: doc, navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0 },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }, crypto: require("crypto").webcrypto,
    setTimeout: (f) => { f(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    fetch: () => Promise.resolve({ status: 200, json: async () => ({ ok: true }) }), CustomEvent: Event, addEventListener() {}, removeEventListener() {} };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/room-bridge.js"), "utf8"), ctx);
  const host = doc.createElement("div"); doc.body.appendChild(host);
  const rel = ctx.PATVRoom.relay(host, "pad", { people: () => people, placeholder: "Message Night Orchard…" });
  rel.update({ room: { relay: true, cmds: { "!duel": 0, "!look": 50 } } });
  const inp = rel.getInput(), list = host.querySelector("ul");
  const type = (v) => { inp.value = v; inp.dispatchEvent(new Event("input")); };
  const key = (k, o = {}) => { const e = new Event("keydown", Object.assign({ key: k }, o)); inp.dispatchEvent(e); return e; };
  const rows = () => (list.classList.contains("hide") ? [] : list.children.map((li) => li.textContent));
  return { rel, inp, list, type, key, rows };
}
const PEOPLE = [{ value: "aster_fable", name: "Aster Fable", login: "aster_fable", tag: "" }, { value: "Misty Froglet", name: "Misty Froglet", login: "", tag: "incognito" },
  { value: "quill-fable", name: "quill-fable", login: "", tag: "🌐" }, { value: "astrid_cf", name: "Astrid", login: "astrid_cf", tag: "" }];

test("a command's second word completes to a login; Tab with one match completes in place", () => {
  const p = page(PEOPLE);
  assert.equal(p.inp.placeholder, "Message Night Orchard…", "the Dock's placeholder");
  p.type("!duel aster"); assert.deepEqual(p.rows(), ["Aster Fableaster_fable"]); assert.equal(p.inp.getAttribute("aria-expanded"), "true");
  const e = p.key("Tab"); assert.equal(e.defaultPrevented, true); assert.equal(p.inp.value, "!duel aster_fable "); assert.deepEqual(p.rows(), []);
  p.type("!duel "); assert.equal(p.rows().length, 4, "an empty second word offers everyone (max 8)");
  p.type("!duel tr"); assert.deepEqual(p.rows(), ["Astridastrid_cf"], "a match inside a word");
  p.type("!duel fa"); assert.deepEqual(p.rows(), ["Aster Fableaster_fable", "quill-fable🌐"], "a word start counts as a prefix");
  p.type("!duel ty"); assert.deepEqual(p.rows(), ["Misty Frogletincognito"]);
  p.type("!duel zz"); assert.deepEqual(p.rows(), []);
});
test("@ completes anywhere in the line; arrows + Enter accept; Escape closes; Enter alone still sends", () => {
  const p = page(PEOPLE);
  p.type("hello @mis"); assert.deepEqual(p.rows(), ["Misty Frogletincognito"]);
  assert.equal(p.key("Enter").defaultPrevented, false, "nothing highlighted: Enter is the form's");
  p.key("ArrowDown"); assert.ok(p.inp.getAttribute("aria-activedescendant")); p.key("Enter"); assert.equal(p.inp.value, "hello @Misty Froglet ");
  p.type("hi @q"); assert.deepEqual(p.rows(), ["quill-fable🌐"]); p.key("Escape"); assert.deepEqual(p.rows(), []);
});
test("the ! command list is unchanged, and a !commands line never opens names", () => {
  const p = page(PEOPLE);
  p.type("!d"); assert.deepEqual(p.rows(), ["!duelfree" === "" ? "" : p.rows()[0]]); assert.match(p.rows()[0], /^!duel/);
  p.type("!commands a"); assert.deepEqual(p.rows(), []);
});
test("the page's candidates keep the veils: frog names only for incognito people, never a hidden person, someone, Pepe or an account key", () => {
  const src = fs.readFileSync(path.join(repo, "views/room.ejs"), "utf8");
  const fn = src.slice(src.indexOf("function acPeople()"), src.indexOf("var relayHost = document.getElementById('rmRelay')"));
  assert.match(fn, /if \(!u \|\| u\.self \|\| u\.bot \|\| u\.me\) return;/);
  assert.match(fn, /var veil = u\.veil === 'incognito' && u\.anon && u\.alias \? 'incognito' : null;/);
  assert.match(fn, /if \(u\.anon && !veil\) return;/, "hidden (!bridge hide) and someone are never offered");
  assert.match(fn, /var value = veil \? String\(u\.alias\)/, "an incognito person completes to the frog name");
  assert.match(fn, /\/\^u:\/i\.test\(value\)/, "never an account key");
  assert.match(fn, /login: !veil && !u\.web && u\.login/, "the login sub-label only for named Camfrog members");
});
