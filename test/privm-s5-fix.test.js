// 1.99?? (privacy controls S5 fix): pad-livecam.js's row() asked for a NAMED cam with an undefined body (`var ref = veiled ? {id} : ref`
// - the hoisted var itself), so ▶ Live, its beat / stop / ask and "🎬 Put on stage" posted {} for everyone on cam by name ("They aren't
// on cam."), whatever the incog_cams switch said. Run in a sandbox with a fake DOM: a named cam posts {login}, a veiled one {id}.
//   node --test test/privm-s5-fix.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");

function sandbox() {
  const posts = [];
  const mk = (tag) => {
    const e = { tag, children: [], attrs: {}, listeners: {}, style: {}, textContent: "", disabled: false,
                classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); return this._s.has(c); }, contains(c) { return this._s.has(c); } },
                appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); },
                remove() {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelector() { return null; },
                addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }, play() { return Promise.resolve(); } };
    return e;
  };
  const ctx = { document: { createElement: mk }, console, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
                fetch: (u, o) => { posts.push([u, o && o.body != null ? JSON.parse(o.body) : null]); return Promise.resolve({ json: () => Promise.resolve({ ok: false, code: "nopepe" }) }); },
                RTCPeerConnection: function () {}, PATVRtc: { watch: () => new Promise(() => {}) }, confirm: () => true };
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.removeEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-livecam.js"), "utf8"), ctx);
  const find = (el, pred) => { if (pred(el)) return el; for (const c of el.children || []) { const x = find(c, pred); if (x) return x; } return null; };
  return { ctx, posts, mk, find };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test("a NAMED cam's ▶ Live posts {login} (and so does its stage button) - not an empty body", async () => {
  const { ctx, posts, mk, find } = sandbox();
  const box = mk("div");
  ctx.PATVLiveCam.row(box, "pad", { login: "alicecf", display: "Alice", on_cam: true }, { on: true, slots: { used: 0, max: 1 }, watching: [] }, { stage: { slug: "pad" } });
  const live = find(box, (e) => e.tag === "button" && e.textContent === "▶ Live");
  assert.ok(live, "the ▶ Live button");
  live.listeners.click[0]();
  await flush();
  assert.deepEqual(posts[0], ["/api/rooms/pad/livecam", { login: "alicecf" }]);
  const st = find(box, (e) => e.tag === "button" && /Put on stage/.test(e.textContent));
  st.listeners.click[0]();
  await flush();
  assert.deepEqual(posts[1], ["/api/rooms/pad/stage/cam", { login: "alicecf" }]);
});

test("a veiled (incognito) cam is still asked for by its opaque id only", async () => {
  const { ctx, posts, mk, find } = sandbox();
  const box = mk("div");
  ctx.PATVLiveCam.row(box, "pad", { anon: true, veil: "incognito", id: "v-abcdefABCDEF", alias: "Soggy Bullfrog", on_cam: true },
                      { on: true, slots: { used: 0, max: 1 }, watching: [] }, {});
  find(box, (e) => e.tag === "button" && e.textContent === "▶ Live").listeners.click[0]();
  await flush();
  assert.deepEqual(posts[0], ["/api/rooms/pad/livecam", { id: "v-abcdefABCDEF" }]);
});
