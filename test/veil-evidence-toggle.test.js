// wave 2 integrate, review fix MC-1 (wave 2's J-18 "Show real names" toggle x WP-5's "Save as evidence" button, views/room.ejs):
// the toggle's batch treated every enabled .veil-reveal in the feed as a Reveal still waiting - the evidence button wears that class
// for its look but carries no cursor (data-reveal). So while the toggle was on, every chat line sent an empty POST
// /api/chatlog/reveal {c: [], toggle: true} and disabled the evidence button while it ran; in a minute already over the reveal limit
// (seethrough.js limited(): w.n > 300 even for n = 0) that empty batch got a 429 and the bar flipped to "Show real names" with an
// error while the server's toggle and the stage (PATVReveal) stayed on.
// This runs the page's own Reveal / toggle code (the bytes of room.ejs from stPost to the end of the toggle's block) in a tiny DOM
// with a server stub that follows seethrough.js's toggle path.
//   node --test test/veil-evidence-toggle.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8").replace(/\r\n/g, "\n");

/** room.ejs's Reveal click handler + J-18 toggle block, exactly as the page runs it */
function extract() {
  const a = SRC.indexOf("    function stPost(");
  const endMark = "      if (pending().length) { draw(); soon(); }\n    })();";
  const b = SRC.indexOf(endMark, a);
  assert.ok(a > 0 && b > a, "room.ejs: the Reveal / toggle block");
  const code = SRC.slice(a, b + endMark.length);
  assert.ok(code.includes("function applyReveal(") && code.includes("function batch()") && code.includes("new MutationObserver("), "the whole block");
  return code;
}

// ── a tiny DOM: what the block touches (closest, replaceWith, insertBefore, querySelectorAll with .class[attr]:not([attr])) ──
function makeDom() {
  const observers = [];
  function notify(node) {
    for (const o of observers) {
      let n = node, inside = false;
      while (n) { if (n === o.target) { inside = true; break; } n = n.parentNode; }
      if (inside && !o.queued) { o.queued = true; queueMicrotask(() => { o.queued = false; o.cb([]); }); }
    }
  }
  class Node0 {
    constructor() { this.parentNode = null; this.children = []; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
    replaceWith(n) {
      const p = this.parentNode;
      if (!p) return;
      if (n.parentNode) n.parentNode.removeChild(n);
      p.children[p.children.indexOf(this)] = n; n.parentNode = p; this.parentNode = null; notify(p);
    }
  }
  class Txt extends Node0 { constructor(t) { super(); this.nodeType = 3; this.data = String(t); } get textContent() { return this.data; } }
  class El extends Node0 {
    constructor(tag) { super(); this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.attrs = {}; this.className = ""; this.listeners = {}; this.title = ""; this.type = ""; }
    get classList() {
      const s = this;
      return { contains: (c) => s.className.split(/\s+/).includes(c), add: (c) => { if (!s.classList.contains(c)) s.className = (s.className + " " + c).trim(); },
               remove: (c) => { s.className = s.className.split(/\s+/).filter((x) => x && x !== c).join(" "); } };
    }
    get disabled() { return "disabled" in this.attrs; }
    set disabled(v) { if (v) this.attrs.disabled = ""; else delete this.attrs.disabled; }
    set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; if (String(v)) this.appendChild(new Txt(v)); }
    get textContent() { return this.children.map((c) => c.textContent).join(""); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    hasAttribute(k) { return k in this.attrs; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); notify(this); return c; }
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      if (!ref) return this.appendChild(c);
      c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); notify(this); return c;
    }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; notify(this); return c; }
    matches(sel) { return sel.split(",").some((p) => matchOne(this, p.trim())); }
    closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  /** a compound selector: [tag] (.class | [attr] | :not([attr]))* */
  function matchOne(n, p) {
    const re = /^([a-z]+)?((?:\.[\w-]+|\[[\w-]+\]|:not\(\[[\w-]+\]\))*)$/i;
    const m = re.exec(p);
    if (!m) throw new Error("tiny DOM: selector not supported: " + p);
    if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
    const parts = m[2].match(/\.[\w-]+|\[[\w-]+\]|:not\(\[[\w-]+\]\)/g) || [];
    return parts.every((x) => (x[0] === "." ? n.classList.contains(x.slice(1)) : x[0] === "[" ? n.hasAttribute(x.slice(1, -1)) : !n.hasAttribute(x.slice(6, -2))));
  }
  const document = { createElement: (t) => new El(t), createTextNode: (t) => new Txt(t) };
  return { document, El, Txt, observers };
}

/** The pad page with one live veiled 🎙 line offering Reveal (rv: 1), the block running, the toggle ON on the server. */
function page() {
  const dom = makeDom();
  const { document, El, Txt, observers } = dom;
  const root = new El("div"), feedEl = new El("div"), scrollEl = new El("div");
  root.appendChild(scrollEl); scrollEl.appendChild(feedEl);
  const line = (text, rv) => {
    const n = new El("div"); n.className = "line";
    if (rv) {
      const r = new El("span"); r.className = "redact"; n.appendChild(r);
      const b = new El("button"); b.className = "veil-reveal"; b.setAttribute("data-reveal", String(rv)); b.textContent = "Reveal"; n.appendChild(b);
    } else n.appendChild(new Txt(text));
    return n;
  };
  feedEl.appendChild(line(null, 101));
  // seethrough.js's toggle path: limited(uid, cs.length) adds to the minute's count and refuses at > 300 (even for an empty batch)
  const server = { win: 0, toggleOn: true, posts: [] };
  const fetchStub = async (url, opts) => {
    const body = JSON.parse(opts.body);
    server.posts.push({ url, body });
    const reply = (status, d) => ({ ok: status === 200, status, json: async () => d });
    if (url === "/api/chatlog/reveal") {
      const cs = Array.isArray(body.c) ? body.c : [body.c];
      server.win += cs.length;
      if (server.win > 300) return reply(429, { ok: false, error: "Too many reveals - wait a minute." });
      if (body.toggle === true) {
        if (!server.toggleOn) return reply(409, { ok: false, error: "Show real names is off - turn it on first." });
        return reply(200, { ok: true, items: cs.filter((c) => c === 101).map((c) => ({ c, login: "hankhidden", display: "Hank", ev: 1 })), refused: [] });
      }
    }
    return reply(200, { ok: true, on: true });
  };
  const stage = { state: null };
  const ctx = { document, fetch: fetchStub, console, JSON, Number, Array, String, Error, Promise,
                MutationObserver: class { constructor(cb) { this.cb = cb; } observe(t) { observers.push({ target: t, cb: this.cb, queued: false }); } },
                setTimeout: (f) => setTimeout(f, 2), clearTimeout };
  ctx.window = ctx;
  ctx.window.PATVReveal = { setState: (v) => { stage.state = v; }, on: () => {}, onOffer: () => {} };
  ctx.window.PATVPadEvidence = { open: () => {} };
  ctx.feedEl = feedEl; ctx.scrollEl = scrollEl; ctx.dockMode = false;   // (1.99ajq dockpol: the legacy view's banner; the Dock's switch is test/pad-dock-pol.test.js)
  vm.createContext(ctx);
  const prelude = "var _t = function (k, d, v) { return String(d).replace(/\\{!?(\\w+)\\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };\n" +
    "var slug = 'p1';\n" +
    "function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }\n";
  vm.runInContext(prelude + extract(), ctx, { filename: "room.ejs (Reveal / J-18 toggle)" });
  return { root, feedEl, line, server, stage };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("review fix MC-1: 'Save as evidence' is no Reveal waiting - no empty toggle batch per chat line, never disabled by one, and a busy minute can't flip the bar", async () => {
  const P = page();
  await wait(60);
  const evb = P.feedEl.querySelector(".ev-save");
  assert.ok(P.feedEl.querySelector(".line.revealed"), "the toggle's first batch revealed the line");
  assert.ok(evb, "and offered 'Save as evidence' (ev: 1)");
  const empties = () => P.server.posts.filter((p) => p.url === "/api/chatlog/reveal" && p.body.toggle === true && Array.isArray(p.body.c) && p.body.c.length === 0).length;
  let sawDisabled = false;
  for (let i = 1; i <= 5; i++) {
    P.feedEl.appendChild(P.line("plain chat line " + i));
    for (let k = 0; k < 15; k++) { await wait(2); if (evb.disabled) sawDisabled = true; }
  }
  assert.equal(empties(), 0, "no empty POST /api/chatlog/reveal {c: [], toggle: true}: " + JSON.stringify(P.server.posts.map((p) => p.body)));
  assert.equal(P.server.posts.filter((p) => p.url === "/api/chatlog/reveal").length, 1, "only the batch that had a Reveal to send");
  assert.equal(sawDisabled, false, "the evidence button is never disabled by a toggle batch");
  // a minute already over the reveal limit (other reveals, stage tiles): a plain chat line sends nothing, so the bar stays on
  P.server.win = 301;
  P.feedEl.appendChild(P.line("a plain line in a busy minute"));
  await wait(60);
  const bar = P.root.querySelector(".veil-banner");
  assert.ok(bar && bar.textContent.includes("Hide again"), "the bar still says the toggle is on: " + (bar && bar.textContent));
  assert.ok(!bar.textContent.includes("Couldn’t reveal it"), "no error chip");
  assert.equal(P.stage.state, true, "the stage's state matches the bar");
  // a real Reveal that arrives later still goes in the next batch
  P.server.win = 0;
  P.feedEl.appendChild(P.line(null, 101));
  await wait(60);
  const last = P.server.posts[P.server.posts.length - 1];
  assert.deepEqual(last.body, { room: "p1", c: [101], toggle: true }, "a new Reveal is still batched");
});
