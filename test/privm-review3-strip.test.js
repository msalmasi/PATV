// 1.99aid (privacy controls, round 3 - the final verify's F2; G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner Q4: every cam
// feature works for an incognito person's cam under its frog name): the viewer's "📌 Pin to strip" on a frog-name cam. pad-livecam.js
// used to drop the strip for a veiled entry (strip: null) - now the popover offers the pin, the strip keeps the cam by its OPAQUE id
// under the frog name (asks / beats / stops by {id}, remembered as {id, display}, restored by {id}) and never a login; a named cam is
// as before. Both scripts run in a sandbox with a fake DOM.
//   node --test test/privm-review3-strip.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const FROG = { anon: true, veil: "incognito", id: "v-abcdefABCDEF", alias: "Soggy Bullfrog", on_cam: true };
const INFO = { on: true, slots: { used: 0, max: 4 }, watching: [] };

function sandbox(store = {}) {
  const posts = [];
  const mk = (tag) => ({
    tag, children: [], attrs: {}, listeners: {}, style: {}, textContent: "", disabled: false, hidden: false,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); return this._s.has(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return null; },
    addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }, play() { return Promise.resolve(); } });
  const ctx = { document: { createElement: mk }, console, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
                localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
                // (a start answers a ticket - the tile then waits on its connection - anything else Pepe's "not now")
                fetch: (u, o) => { posts.push([u, o && o.body != null ? JSON.parse(o.body) : null]); return Promise.resolve({ json: () => Promise.resolve(/\/livecam$/.test(u) ? { ok: true, whep: "/whep/x" } : { ok: false, code: "nopepe" }) }); },
                RTCPeerConnection: function () {}, PATVRtc: { watch: () => new Promise(() => {}) }, confirm: () => true };
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.removeEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-camstrip.js"), "utf8"), ctx);
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-livecam.js"), "utf8"), ctx);
  const find = (el, pred) => { if (pred(el)) return el; for (const c of el.children || []) { const x = find(c, pred); if (x) return x; } return null; };
  const texts = (el) => [el.textContent || "", ...Object.values(el.attrs || {}).map(String), ...(el.children || []).flatMap(texts)];
  return { ctx, posts, mk, find, texts, store };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test("F2: a frog-name cam's popover offers 📌 Pin to strip; the strip asks, beats and stops by its opaque id under the frog name", async () => {
  const { ctx, posts, mk, find, texts, store } = sandbox();
  const host = mk("section");
  const strip = ctx.PATVCamStrip.init(host, "pad", {});
  strip.update(INFO);
  const box = mk("div");
  let pinned = 0;
  ctx.PATVLiveCam.row(box, "pad", FROG, INFO, { strip, onPin: () => { pinned++; } });
  const pin = find(box, (e) => e.tag === "button" && /Pin to strip/.test(e.textContent));
  assert.ok(pin, "the popover offers the pin for a frog-name cam (it used to drop the strip)");
  assert.match(pin.title || "", /Soggy Bullfrog/, "titled by the frog name");
  pin.listeners.click[0]();
  await flush();
  assert.equal(pinned, 1, "the popover closes");
  assert.equal(strip.has(FROG.id), true, "the strip holds it by its id");
  assert.deepEqual(posts.filter((p) => /\/livecam$/.test(p[0])).map((p) => p[1]), [{ id: FROG.id }], "asked for by {id} only");
  const tileText = texts(host).join(" | ");
  assert.ok(tileText.includes("Soggy Bullfrog"), "the tile shows the frog name: " + tileText);
  const saved = JSON.parse(store["patv.camstrip.pad"]);
  assert.deepEqual(saved, [{ id: FROG.id, display: "Soggy Bullfrog" }], "remembered by its id and frog name - never a login");
  // a second popover of the same cam: "📌 In the strip" (one player per cam)
  const box2 = mk("div");
  ctx.PATVLiveCam.row(box2, "pad", FROG, INFO, { strip });
  assert.ok(find(box2, (e) => e.tag === "button" && /In the strip/.test(e.textContent)), "already in the strip");
  // ✕ on the tile stops it by its id
  const x = find(host, (e) => e.tag === "button" && e.textContent === "✕");
  x.listeners.click[0]();
  await flush();
  assert.deepEqual(posts.filter((p) => /\/livecam\/stop$/.test(p[0])).map((p) => p[1]), [{ id: FROG.id }], "stopped by {id}");
  for (const [u, b] of posts) assert.equal(JSON.stringify(b).includes("login"), false, "no request names a login: " + u);
});

test("F2: a remembered frog-name cam comes back by its id; a named cam is pinned, asked and remembered by its login as before", async () => {
  const { ctx, posts, mk, store } = sandbox({ "patv.camstrip.pad": JSON.stringify([{ id: FROG.id, display: "Soggy Bullfrog" }, { login: "Alice", display: "Alice" }, { id: "not-an-id" }]) });
  const strip = ctx.PATVCamStrip.init(mk("section"), "pad", {});
  strip.update(INFO);
  await flush();
  assert.equal(strip.count(), 2, "the frog cam and the named one come back (a bad entry is dropped)");
  assert.deepEqual(posts.filter((p) => /\/livecam$/.test(p[0])).map((p) => p[1]), [{ id: FROG.id }, { login: "alice" }]);
  assert.equal(strip.has(FROG.id), true);
  assert.equal(strip.has("v-ABCDEFabcdef"), false, "ids are case-sensitive");
  assert.equal(strip.has("ALICE"), true, "logins aren't");
  // a named cam's pin from the popover: by its login (unchanged)
  const s2 = sandbox();
  const strip2 = s2.ctx.PATVCamStrip.init(s2.mk("section"), "pad", {});
  strip2.update(INFO);
  const box = s2.mk("div");
  s2.ctx.PATVLiveCam.row(box, "pad", { login: "bobcf", display: "Bob", on_cam: true }, INFO, { strip: strip2 });
  s2.find(box, (e) => e.tag === "button" && /Pin to strip/.test(e.textContent)).listeners.click[0]();
  await flush();
  assert.deepEqual(s2.posts.filter((p) => /\/livecam$/.test(p[0])).map((p) => p[1]), [{ login: "bobcf" }]);
  assert.deepEqual(JSON.parse(s2.store["patv.camstrip.pad"]), [{ login: "bobcf", display: "Bob" }]);
  assert.ok(store);
});

test("F2: the stale 'no strip pin, no stage slot' rule is gone from pad-livecam.js, and the room page loads the new scripts", () => {
  const plc = fs.readFileSync(path.join(repo, "public", "js", "pad-livecam.js"), "utf8");
  assert.doesNotMatch(plc, /strip: null/, "no veiled cam loses the strip");
  assert.doesNotMatch(plc, /no strip pin, no stage slot/, "the stale comment is fixed");
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /pad-livecam\.js\?v=1[2-9]/);
  const part = fs.readFileSync(path.join(repo, "views", "partials", "cam-strip.ejs"), "utf8");
  assert.match(part, /pad-camstrip\.js\?v=[3-9]/);
});
