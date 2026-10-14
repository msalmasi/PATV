// 1.99xt: Top Pads rows (and the /p cards) never lose the pad's name to its badge chips ("Did we fix this issue with
// flairs in the Top Pads section? I still see it." - a Prime Time Plus pad with 4 chips showed avatar + chips, no name,
// the last chip cut off and the 👥 / 🎙 counts crammed against the frame).
//   * padcosmetics.fx(): badgesMini (Top Pads) and badgesFit (/p cards) are one-line [data-fit] rows
//   * public/js/pad-chipfit.js: the name keeps >= 8ch, the chips get the rest: the first that fit + "+N" (the rest in
//     its title), none when not even "+N" fits; run here against a tiny fake DOM with fixed widths
//   * the CSS: no-JS fallback (wrap + clip, chips shrink first), the framed row's padding, counts / 🎧 flex: none
//   NODE_PATH=G:/PATV/node_modules node --test test/toppads-layout.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

// ── a tiny fake DOM: just what pad-chipfit.js touches, with fixed widths ──
class CL {
  constructor(el) { this.el = el; this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  contains(c) { return this.s.has(c); }
  toggle(c, on) { if (on === undefined) on = !this.s.has(c); if (on) this.s.add(c); else this.s.delete(c); return on; }
}
class El {
  constructor(tag, o = {}) {
    this.tagName = tag; this.classList = new CL(this); this.children = []; this.parentElement = null; this.attrs = {};
    this.w = o.w || 0; this.cw = o.cw; this.sw = o.sw; this.gap = o.gap || 0; this.fs = o.fs || 13.5; this._text = o.text || ""; this.title = o.title || "";
    (o.cls || "").split(" ").filter(Boolean).forEach((c) => this.classList.add(c));
  }
  set className(v) { this.classList = new CL(this); v.split(" ").filter(Boolean).forEach((c) => this.classList.add(c)); }
  get isConnected() { return true; }
  get childNodes() { return this.children; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  getAttribute(n) { return n === "title" ? this.title || null : this.attrs[n] || null; }
  setAttribute(n, v) { this.attrs[n] = v; }
  get clientWidth() { return this.cw; }
  get scrollWidth() { return this.sw != null ? this.sw : this.w; }
  getBoundingClientRect() {
    if (this.classList.contains("pfx-more")) return { width: 10 + 7 * this._text.length };   // "+3" -> 24px
    return { width: this.w };
  }
  querySelector(sel) {
    if (sel === ".pfx-more") return this.children.find((c) => c.classList.contains("pfx-more")) || null;
    if (sel.startsWith(":scope >")) return this.children.find((c) => c.classList.contains("nt") || c.classList.contains("t")) || null;
    return null;
  }
  closest() { return this.parentElement && this.parentElement.parentElement; }
}
function runFit(box) {
  const all = [];
  const walk = (e) => { if (e.classList && e.classList.contains("pfx-bs") && e.attrs["data-fit"] != null) all.push(e); (e.children || []).forEach(walk); };
  walk(box.parentElement || box);
  let raf = null;
  const ctx = {
    document: { readyState: "complete", querySelectorAll: () => all, addEventListener() {}, createElement: (t) => new El(t), fonts: null },
    window: { addEventListener() {} },
    getComputedStyle: (e) => ({ columnGap: String(e.gap || 0) + "px", display: e.classList.contains("pfx-off") || e.classList.contains("pfx-none") ? "none" : "inline-flex",
      position: e.classList.contains("pfx-sr") ? "absolute" : "static", marginLeft: "0px", marginRight: "0px", fontSize: e.fs + "px" }),
    requestAnimationFrame: (f) => { raf = f; },
    ResizeObserver: undefined, WeakSet,
  };
  ctx.window = Object.assign(ctx.window, {});
  vm.createContext(ctx);
  vm.runInContext(rd("public", "js", "pad-chipfit.js"), ctx);
  if (raf) raf();
  return ctx;
}
// a Top Pads name box: avatar 20, name, the chips (24px each, 4px gaps), 6px gaps in the box
function row(boxW, nameW, chips, extra = []) {
  const li = new El("li"), box = li.appendChild(new El("span", { cls: "n", cw: boxW, gap: 6 }));
  box.appendChild(new El("span", { cls: "pad-av tp-av", w: 20 }));
  const nt = box.appendChild(new El("span", { cls: "nt", w: Math.min(nameW, boxW), sw: nameW, fs: 13.5 }));
  const bs = box.appendChild(new El("span", { cls: "pfx-bs mini", gap: 4 }));
  bs.setAttribute("data-fit", "");
  chips.forEach((t) => bs.appendChild(new El("span", { cls: "pfx-b mini", w: 24, title: t })));
  extra.forEach((w) => box.appendChild(new El("span", { cls: "bm", w })));
  return { li, box, nt, bs };
}
const visible = (bs) => bs.children.filter((c) => !c.classList.contains("pfx-off") && !c.classList.contains("pfx-more")).map((c) => c.title);
const more = (bs) => bs.children.find((c) => c.classList.contains("pfx-more") && !c.classList.contains("pfx-off"));
const CH = 13.5 * 0.56;   // the script's ch estimate

test("chipfit: everything fits -> every chip, no +N", () => {
  const r = row(300, 60, ["Prime Time Plus", "Headliner"]);
  runFit(r.box);
  assert.deepEqual(visible(r.bs), ["Prime Time Plus", "Headliner"]);
  assert.equal(more(r.bs), undefined);
  assert.ok(r.bs.classList.contains("pfx-fitted"));
});

test("chipfit: the user's row (4 chips, ~147px name box at the 300px side column) keeps >= 8ch of the name, first chip + '+3' with the rest in its title", () => {
  const r = row(147, 120, ["Prime Time Plus", "Headliner", "Red Carpet", "On Air"]);
  runFit(r.box);
  const m = more(r.bs);
  assert.ok(m, "a +N chip");
  const shown = visible(r.bs);
  assert.equal(m.textContent.split(" ")[0], "+" + (4 - shown.length));
  assert.equal(m.title, ["Prime Time Plus", "Headliner", "Red Carpet", "On Air"].slice(shown.length).join(" · "));
  assert.match(m.textContent, /Red Carpet · On Air/, "screen readers hear the hidden ones");
  assert.deepEqual(shown, ["Prime Time Plus"], "the tier chip stays first");
  // what's left for the name after the avatar, the gaps and the chips
  const chipsW = shown.length * 24 + shown.length * 4 + (10 + 7 * m._text.length);
  assert.ok(147 - 20 - 2 * 6 - chipsW >= 8 * CH - 0.5, "the name keeps >= 8ch");
});

test("chipfit: phone-narrow box -> only '+N'; tighter still -> the chips hide and the name has the row", () => {
  const r = row(110, 200, ["A", "B", "C", "D"]);
  runFit(r.box);
  assert.deepEqual(visible(r.bs), []);
  assert.equal(more(r.bs)._text, "+4");
  const t = row(80, 200, ["A", "B", "C", "D"]);
  runFit(t.box);
  assert.ok(t.bs.classList.contains("pfx-none"));
});

test("chipfit: a short name needs no 8ch floor; other fixed items (🚀, 18+) are counted", () => {
  const r = row(150, 30, ["A", "B", "C", "D"]);   // 150 - 20 - 18 gaps(4 kids... 3 gaps) - 30 = 82 -> 2 chips + "+2"
  runFit(r.box);
  assert.deepEqual(visible(r.bs), ["A", "B"]);
  const b = row(150, 30, ["A", "B", "C", "D"], [40]);
  runFit(b.box);
  assert.ok(visible(b.bs).length < 2, "the 🚀 badge takes its room first");
  // refit is idempotent (resize ticks): a second run gives the same answer, one +N chip
  runFit(r.box);
  assert.deepEqual(visible(r.bs), ["A", "B"]);
  assert.equal(r.bs.children.filter((c) => c.classList.contains("pfx-more")).length, 1);
});

test("chipfit: full pills (/p cards) - the +N title lists their words, not the icons", () => {
  const r = row(150, 30, []);
  ["Headliner", "Red Carpet", "On Air", "Est. 2026"].forEach((t) => {
    const c = r.bs.appendChild(new El("span", { cls: "pfx-b", w: 60 }));
    const ic = c.appendChild(new El("span", { text: "*" })); ic.setAttribute("aria-hidden", "true");
    c.appendChild(new El("span", { text: t }));
  });
  runFit(r.box);
  const m = more(r.bs);
  assert.ok(m);
  assert.doesNotMatch(m.title, /\*/);
  assert.match(m.title, /On Air · Est\. 2026$/);
});

test("padcosmetics.fx(): badgesMini / badgesFit are one-line [data-fit] rows; badges (pad header) untouched", () => {
  const src = rd("padcosmetics.js");
  assert.match(src, /out\.badgesMini = `<span class="pfx-bs mini" data-fit>/);
  assert.match(src, /out\.badgesFit = `<span class="pfx-bs" data-fit>/);
  assert.match(src, /out\.badges = `<span class="pfx-bs">/);
});

test("views: Top Pads + /p cards use the fitting rows, name in the title, the script + bumped padfx.css everywhere", () => {
  const home = rd("views", "home.ejs"), rooms = rd("views", "rooms.ejs");
  assert.match(home, /<span class="nt[^"]*" title="<%= r\.name %>"><%= r\.name %><\/span><%- fx_ \? fx_\.badgesMini : '' %>/);
  assert.match(rd("views", "partials", "pad-dir-card.ejs"), /title="<%= r\.title %>"><%= r\.title %><\/span><%- fx_ \? fx_\.badgesFit : '' %>/);   // 1.99za: the /p card partial
  for (const v of [home, rooms]) assert.match(v, /<script src="\/public\/js\/pad-chipfit\.js\?v=2" defer><\/script>/);
  for (const f of ["home", "rooms", "room", "cosmetics", "padSettings", "premium"]) {
    const s = rd("views", f + ".ejs");
    assert.doesNotMatch(s, /padfx\.css\?v=4/, f);
    assert.match(s, /padfx\.css\?v=5/, f);
  }
  // the counts and 🎧 never shrink; a framed (featured) row keeps its content off the frame; no old flex:none chips
  assert.match(home, /\.hm \.rooms-mini \.v \{ display: inline-flex; flex: none;/);
  assert.match(home, /\.hm \.tp-ls \{ flex: none;/);
  assert.match(home, /\.hm \.tp \.rooms-mini a\.pfx \{[^}]*padding-inline: 6px;/);
  assert.doesNotMatch(home, /\.n \.pfx-bs \{ flex: none; \}/);
  assert.doesNotMatch(rooms, /\.ch-name \.pfx-bs \{ flex: 0 1 auto; flex-wrap: nowrap;/);
});

test("padfx.css: [data-fit] fallback wraps + clips (whole chips drop), chips shrink before the name, JS states", () => {
  const css = rd("public", "css", "padfx.css");
  assert.match(css, /\.pfx-bs\[data-fit\] \{ flex: 0 8 auto; min-width: 0; flex-wrap: wrap; overflow: hidden; max-height: 22px; \}/);
  assert.match(css, /\.pfx-bs\[data-fit\]\.pfx-fitted \{ flex: 0 0 auto; flex-wrap: nowrap; \}/);
  assert.match(css, /\.pfx-bs\[data-fit\]\.pfx-none, \.pfx-bs\[data-fit\] > \.pfx-off \{ display: none !important; \}/);
});
