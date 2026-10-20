// Offline tests for the shared clip confirm card (clipmodal site): public/js/clip-confirm.js is the one card both the pad's
// 🔊 mic clip and its ✂️ chat clip use (public/js/chat-clip.js). Runs the page scripts in a small stub DOM (below):
//   - the 🔊 mic flow is unchanged: every state's markup and the request sequence match a golden recorded from the
//     pre-refactor chat-clip.js (test/fixtures/clip-mic-golden.json) apart from the deltas listed at DELTAS / A11Y (the card is
//     a named region with real headings, its status is read out by a live region next to it, Cancel while asking, Close when
//     Pepe takes a while) - regenerate ONLY from that code: CLIP_GOLDEN=write node --test test/clip-confirm.test.js
//   - both cards share one skeleton (head, body, action row primary-then-secondary, status line, the live region, the done card)
//   - the chat flow: "Clip N lines" asks the server for a preview (POST {cs, preview: true}), shows it with the feed's quote
//     markup ("someone" lines anonymised, no names / avatars; 8 lines + "+ N more"), where it goes and who can see it, the
//     title, the price on the button; Post sends the unchanged request, then the mic's done card (or "sent" while a pad's
//     approval queue holds it); Cancel / Discard / Esc / Enter, Try again, focus in / back, picking from the keyboard
//   - one card at a time; late answers never write into a newer card
//   NODE_PATH=G:/PATV/node_modules node --test test/clip-confirm.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const GOLDEN = path.join(__dirname, "fixtures", "clip-mic-golden.json");
const WRITE = process.env.CLIP_GOLDEN === "write";

// ── a small DOM: elements, text, reflected attributes, a selector engine, events (bubbling), focus, MutationObserver ──
function makeDom() {
  const clock = { now: 1760000000000 };
  const timers = new Map();
  let tid = 0;
  const reqs = [];
  let route = () => null;
  const doc = { nodeType: 9, listeners: {}, _ae: null };

  const parentEl = (n) => (n.parentNode && n.parentNode.nodeType === 1 ? n.parentNode : null);
  const isConn = (n) => { for (let x = n; x; x = x.parentNode) if (x === doc.body) return true; return false; };
  const shown = (n) => { for (let x = n; x; x = x.parentNode) if (x.nodeType === 1 && x.hidden) return false; return isConn(n); };

  class Txt {
    constructor(s) { this.nodeType = 3; this.data = String(s); this.parentNode = null; }
    get textContent() { return this.data; }
    get isConnected() { return isConn(this); }
  }
  class ClassList {
    constructor(e) { this.e = e; }
    _get() { return String(this.e.attrs.class || "").split(/\s+/).filter(Boolean); }
    _set(a) { this.e.attrs.class = a.join(" "); }
    add(...c) { const a = this._get(); c.forEach((x) => { if (!a.includes(x)) a.push(x); }); this._set(a); }
    remove(...c) { this._set(this._get().filter((x) => !c.includes(x))); }
    contains(c) { return this._get().includes(c); }
    toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); return !!on; }
  }
  class El {
    constructor(tag) {
      this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.childNodes = []; this.parentNode = null; this.attrs = {};
      this.listeners = {}; this.style = {}; this.classList = new ClassList(this); this._mos = []; this.value = ""; this.checked = false;
    }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    get className() { return this.attrs.class || ""; }
    set className(v) { this.attrs.class = String(v); }
    get isConnected() { return isConn(this); }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
    set textContent(v) { this.childNodes.slice().forEach((c) => this.removeChild(c)); if (v != null && String(v) !== "") this.appendChild(new Txt(v)); }
    get firstChild() { return this.childNodes[0] || null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    _notify(rec) { this._mos.forEach((mo) => mo._push(rec)); }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      this.childNodes.push(c); c.parentNode = this; this._notify({ addedNodes: [c], removedNodes: [] }); return c;
    }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      if (c.parentNode) c.parentNode.removeChild(c);
      this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); c.parentNode = this; this._notify({ addedNodes: [c], removedNodes: [] }); return c;
    }
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; this._notify({ addedNodes: [], removedNodes: [c] }); }
      return c;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    matches(sel) { return parseSel(sel).some((cx) => matchCx(this, cx)); }
    closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (x.matches(sel)) return x; return null; }
    querySelectorAll(sel) {
      const cxs = parseSel(sel), out = [];
      const walk = (n) => { n.children.forEach((c) => { if (cxs.some((cx) => matchCx(c, cx))) out.push(c); walk(c); }); };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    focusable() {
      if (!shown(this) || this.disabled) return false;
      return ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(this.tagName) || (this.tagName === "A" && this.hasAttribute("href")) || this.hasAttribute("tabindex");
    }
    focus() {
      if (!this.focusable()) return;
      const prev = doc.activeElement;
      if (prev === this) return;
      doc._ae = this;
      if (prev && prev !== doc.body) dispatch(prev, "focusout", { relatedTarget: this });
      dispatch(this, "focusin", { relatedTarget: prev });
    }
    blur() { if (doc.activeElement === this) { doc._ae = null; dispatch(this, "focusout", {}); } }
    click() { if (this.disabled) return; dispatch(this, "click", {}); }
    scrollIntoView() {}
    pause() { this.paused = true; }
  }
  const REFLECT = { id: "id", type: "type", title: "title", href: "href", src: "src", placeholder: "placeholder", preload: "preload",
                    min: "min", max: "max", step: "step", maxLength: "maxlength", htmlFor: "for", dateTime: "datetime", tabIndex: "tabindex" };
  for (const [p, a] of Object.entries(REFLECT)) {
    Object.defineProperty(El.prototype, p, { get() { return this.getAttribute(a) == null ? (p === "tabIndex" ? -1 : "") : this.getAttribute(a); },
                                             set(v) { this.setAttribute(a, v); }, configurable: true });
  }
  for (const b of ["disabled", "hidden", "controls"]) {
    Object.defineProperty(El.prototype, b, { get() { return this.hasAttribute(b); }, set(v) { if (v) this.setAttribute(b, ""); else this.removeAttribute(b); }, configurable: true });
  }

  // selectors: compound (tag, #id, .class, [attr], [attr="v"], :not(x)) joined by descendant / child combinators, comma lists
  const cache = new Map();
  function splitTop(s, ch) {
    const out = []; let depth = 0, q = null, cur = "";
    for (const c of s) {
      if (q) { if (c === q) q = null; cur += c; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "[" || c === "(") depth++;
      if (c === "]" || c === ")") depth--;
      if (c === ch && !depth) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }
  function parseComp(s) {
    const c = { tag: null, id: null, cls: [], attrs: [], not: [] };
    let m = /^([a-zA-Z*][\w-]*)/.exec(s);
    if (m) { c.tag = m[1] === "*" ? null : m[1].toUpperCase(); s = s.slice(m[0].length); }
    while (s) {
      if ((m = /^#([\w-]+)/.exec(s))) c.id = m[1];
      else if ((m = /^\.([\w-]+)/.exec(s))) c.cls.push(m[1]);
      else if ((m = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(s))) c.attrs.push([m[1], m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]]);
      else if ((m = /^:not\(([^)]*)\)/.exec(s))) c.not.push(parseSel(m[1]));
      else throw new Error("stub DOM: unsupported selector part " + s);
      s = s.slice(m[0].length);
    }
    return c;
  }
  function parseSel(sel) {
    if (cache.has(sel)) return cache.get(sel);
    const cxs = splitTop(sel, ",").map((part) => {
      const comps = [], combs = [];
      const toks = part.trim().replace(/\s*>\s*/g, " > ").split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/).filter(Boolean);
      let comb = " ";
      for (const t of toks) { if (t === ">") { comb = ">"; continue; } if (comps.length) combs.push(comb); comps.push(parseComp(t)); comb = " "; }
      return { comps, combs };
    });
    cache.set(sel, cxs);
    return cxs;
  }
  function matchComp(e, c) {
    if (e.nodeType !== 1) return false;
    if (c.tag && e.tagName !== c.tag) return false;
    if (c.id && e.getAttribute("id") !== c.id) return false;
    for (const k of c.cls) if (!e.classList.contains(k)) return false;
    for (const [a, v] of c.attrs) { const got = e.getAttribute(a); if (got == null || (v != null && got !== v)) return false; }
    for (const n of c.not) if (n.some((cx) => matchCx(e, cx))) return false;
    return true;
  }
  function matchCx(e, { comps, combs }) {
    const m = (x, i) => {
      if (!matchComp(x, comps[i])) return false;
      if (i === 0) return true;
      if (combs[i - 1] === ">") { const p = parentEl(x); return !!p && m(p, i - 1); }
      for (let p = parentEl(x); p; p = parentEl(p)) if (m(p, i - 1)) return true;
      return false;
    };
    return m(e, comps.length - 1);
  }

  function dispatch(target, type, init) {
    const ev = Object.assign({ type, target, bubbles: !["focus", "blur", "pointerenter", "pointerleave"].includes(type), defaultPrevented: false, _stop: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; }, stopImmediatePropagation() { this._stop = true; } }, init || {});
    const pathOf = []; for (let n = target; n; n = n.parentNode) pathOf.push(n);
    if (isConn(target)) pathOf.push(doc);
    for (const n of pathOf) {
      ev.currentTarget = n;
      for (const fn of (n.listeners[type] || []).slice()) fn.call(n, ev);
      if (ev._stop || !ev.bubbles) break;
    }
    return ev;
  }

  class MO {
    constructor(cb) { this.cb = cb; this.recs = []; this.queued = false; }
    observe(t) { t._mos.push(this); }
    disconnect() {}
    _push(r) { this.recs.push(r); if (!this.queued) { this.queued = true; queueMicrotask(() => { this.queued = false; const r2 = this.recs.splice(0); if (r2.length) this.cb(r2, this); }); } }
  }

  doc.body = new El("body");
  doc.createElement = (t) => new El(t);
  doc.createTextNode = (s) => new Txt(s);
  doc.addEventListener = (t, fn) => { (doc.listeners[t] = doc.listeners[t] || []).push(fn); };
  doc.removeEventListener = () => {};
  Object.defineProperty(doc, "activeElement", { get() { const a = doc._ae; return a && a.isConnected && shown(a) && !a.disabled ? a : doc.body; } });

  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const ctx = {
    console, Math, JSON, Number, String, Array, Object, Promise, Error, Map, Set, encodeURIComponent, isFinite, parseInt, parseFloat,
    document: doc, navigator: { userAgent: "test" }, Date: FakeDate, MutationObserver: MO,
    setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { id, at: clock.now + (Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: (url, o) => {
      o = o || {};
      const req = { method: o.method || "GET", url: String(url), body: o.body == null ? undefined : JSON.parse(o.body),
                    xrw: !!(o.headers && o.headers["X-Requested-With"]) };
      reqs.push(req);
      const r = route(req) || { status: 404, json: { ok: false, error: "no route for " + req.method + " " + req.url } };
      if (r.hang) return new Promise(() => {});
      // a deferred answer (a Promise of {status, json}): the test decides when it arrives (late-reply guards)
      if (typeof r.then === "function") return r.then((x) => ({ ok: x.status < 400, status: x.status, json: () => Promise.resolve(x.json) }));
      return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.json) });
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  const flush = () => new Promise((r) => setImmediate(r));
  async function advance(ms) {
    const end = clock.now + ms;
    for (;;) {
      const next = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      timers.delete(next.id);
      clock.now = next.at;
      next.fn();
      await flush(); await flush();
    }
    clock.now = end;
    await flush(); await flush();
  }
  return { ctx, doc, El, Txt, clock, reqs, flush, advance, dispatch, setRoute: (fn) => { route = fn; }, parseSel };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function serialize(n) {
  if (!n) return "";
  if (n.nodeType === 3) return esc(n.data);
  const at = Object.keys(n.attrs).sort().map((k) => {
    const v = k === "class" ? n.attrs[k].split(/\s+/).filter(Boolean).sort().join(" ") : n.attrs[k];
    return v === "" ? " " + k : ` ${k}="${esc(v)}"`;
  }).join("");
  const props = (n.tagName === "INPUT" ? (n.value !== "" ? ` .value="${esc(n.value)}"` : "") + (n.checked ? " .checked" : "") : "") +
                (Object.keys(n.style).length ? ` .style="${Object.keys(n.style).sort().map((k) => k + ":" + n.style[k]).join(";")}"` : "");
  return `<${n.tagName.toLowerCase()}${at}${props}>${n.childNodes.map(serialize).join("")}</${n.tagName.toLowerCase()}>`;
}

/** The pad page's bits: #rmFeed (role=log) and #rmClip, with chat-clip.js (and clip-confirm.js when it exists) loaded. */
function loadPage({ linked = true, withConfirm = true, spy = null } = {}) {
  const D = makeDom();
  if (withConfirm && fs.existsSync(path.join(repo, "public/js/clip-confirm.js"))) {
    vm.runInContext(fs.readFileSync(path.join(repo, "public/js/clip-confirm.js"), "utf8"), D.ctx, { filename: "clip-confirm.js" });
    if (spy) { const real = D.ctx.window.PATVClipConfirm.create; D.ctx.window.PATVClipConfirm.create = (h, o) => { spy.push(o.cls); return real(h, o); }; }
  }
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/chat-clip.js"), "utf8"), D.ctx, { filename: "chat-clip.js" });
  const feed = D.doc.createElement("div"); feed.setAttribute("id", "rmFeed"); feed.setAttribute("role", "log");
  const host = D.doc.createElement("div"); host.setAttribute("id", "rmClip");
  const compose = D.doc.createElement("textarea");
  D.doc.body.appendChild(feed); D.doc.body.appendChild(host); D.doc.body.appendChild(compose);
  const api = D.ctx.window.PATVChatClip.init({ feed, host, slug: "room-x", linked });
  let c = 0;
  // a line as room.ejs item() builds it (the attributes chat-clip.js reads)
  function line(k, name, text, o = {}) {
    const row = D.doc.createElement("div");
    row.className = "line" + (k === "tx" ? " tx" : "") + (o.pepe ? " pepe" : "");
    row.setAttribute("data-c", String(o.c || ++c));
    row.setAttribute("data-k", k); row.setAttribute("data-name", name); row.setAttribute("data-text", text);
    if (k === "tx") row.setAttribute("data-tx", o.tx || "tx-" + String(c).padStart(16, "0"));
    const av = D.doc.createElement("span"); av.className = "av"; row.appendChild(av);
    const body = D.doc.createElement("div"); body.className = "body";
    const nm = D.doc.createElement("b"); nm.textContent = name; body.appendChild(nm);
    body.appendChild(D.doc.createTextNode(k === "tx" ? "\u201c" + text + "\u201d" : text));
    row.appendChild(body);
    feed.appendChild(row);
    return row;
  }
  return Object.assign(D, { feed, host, compose, api, line });
}
const key = (D, target, k, extra) => D.dispatch(target, "keydown", Object.assign({ key: k }, extra || {}));

// ── the 🔊 mic flow: the same scenarios against the golden ──
const READY = (save, extra) => Object.assign({ ok: true, id: "m1", state: "ready", status: "", secs: 6.4, text: "hello there, this is the mic",
  login: "carolcf", audio: "/api/rooms/room-x/micclip/m1/audio", until: 0, save }, extra || {});

async function micScenarios(opts) {
  const out = {};
  async function run(name, fn) {
    const P = loadPage(opts);
    const frames = [];
    let seen = 0;
    const frame = (label, node) => {
      const mc = node || P.host.querySelector(".mc-panel");
      frames.push({ label, dom: serialize(mc), reqs: P.reqs.slice(seen).map((r) => `${r.method} ${r.url}${r.body === undefined ? "" : " " + JSON.stringify(r.body)}`) });
      seen = P.reqs.length;
    };
    P.api.update({ room: { live: true, transcripts: true, clip: true } });
    await P.flush();
    const row = P.line("tx", "carol", "hello there, this is the mic", { tx: "tx-aaaaaaaaaaaaaaaa" });
    P.line("msg", "bob", "plain chat line");
    await P.flush();
    await fn(P, frame, row);
    out[name] = frames;
  }
  const btnOf = (row) => row.querySelector(".mc-btn");
  const open = async (P, row) => { const b = btnOf(row); b.focus(); b.click(); };

  await run("post with a price, trim, done card, auto-close", async (P, frame, row) => {
    frame("decorated");
    frame("the 🎙 line", row);
    assert.ok(btnOf(row), "🔊 Clip on the 🎙 line");
    assert.equal(P.feed.querySelectorAll(".mc-btn").length, 1, "only 🎙 lines");
    let polls = 0, saves = 0;
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
      if (r.method === "GET" && r.url === "/api/rooms/room-x/micclip/m1") return { status: 200, json: ++polls < 2 ? { ok: true, id: "m1", state: "pending" } : READY({ cost: 500, id: null }) };
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip/m1/save") return { status: 200, json: { ok: true } };
      if (r.method === "GET" && r.url === "/api/rooms/room-x/micclip/m1/save") return { status: 200, json: ++saves < 2 ? { ok: true, status: "pending" } : { ok: true, status: "done", url: "/p/room-x/posts/abc12345" } };
      return null;
    });
    await open(P, row);
    frame("asking");
    await P.flush();
    frame("asked");
    await P.advance(1200);
    frame("still pending");
    await P.advance(1200);
    frame("ready");
    const [A, B] = P.host.querySelectorAll('.mc-panel input[type="range"]');
    B.value = "4"; P.dispatch(B, "input");
    A.value = "3.5"; P.dispatch(A, "input");
    frame("trimmed");
    P.host.querySelector(".mc-panel .cc-btn.primary").click();
    frame("posting");
    await P.flush();
    await P.advance(1200);
    frame("save pending");
    await P.advance(2000);
    frame("done");
    await P.advance(6000);
    frame("done, half way");
    await P.advance(6200);
    frame("closed");
  });

  await run("free, then Discard", async (P, frame, row) => {
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
      if (r.method === "GET" && r.url === "/api/rooms/room-x/micclip/m1") return { status: 200, json: READY({ cost: 0, id: null }, { text: "" }) };
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip/m1/discard") return { status: 200, json: { ok: true } };
      return null;
    });
    await open(P, row); await P.flush(); await P.advance(1200);
    frame("ready free, no transcript");
    const discard = [...P.host.querySelectorAll(".mc-panel .cc-btn")].find((b) => b.textContent === "Discard");
    discard.click();
    await P.flush();
    frame("discarded");
  });

  await run("can't post here", async (P, frame, row) => {
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
      if (r.method === "GET") return { status: 200, json: READY(null) };
      return null;
    });
    await open(P, row); await P.flush(); await P.advance(1200);
    frame("ready, can't post");
  });

  await run("post refused, then Pepe fails the save, then retry", async (P, frame, row) => {
    let n = 0;
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
      if (r.method === "GET" && r.url === "/api/rooms/room-x/micclip/m1") return { status: 200, json: READY({ cost: 1500, id: null }) };
      if (r.method === "POST" && r.url.endsWith("/save")) return ++n === 1 ? { status: 402, json: { ok: false, error: "You need 1,500 PAT." } } : { status: 200, json: { ok: true } };
      if (r.method === "GET" && r.url.endsWith("/save")) return { status: 200, json: { ok: true, status: "failed", message: "Pepe couldn't cut it." } };
      return null;
    });
    await open(P, row); await P.flush(); await P.advance(1200);
    P.host.querySelector(".mc-panel .cc-btn.primary").click();
    await P.flush();
    frame("save refused");
    P.host.querySelector(".mc-panel .cc-btn.primary").click();
    await P.flush();
    await P.advance(1200);
    frame("save failed");
  });

  await run("Pepe is slow to cut it", async (P, frame, row) => {
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
      if (r.method === "GET" && r.url === "/api/rooms/room-x/micclip/m1") return { status: 200, json: READY({ cost: 10, id: null }) };
      if (r.method === "POST" && r.url.endsWith("/save")) return { status: 200, json: { ok: true } };
      if (r.method === "GET" && r.url.endsWith("/save")) return { status: 200, json: { ok: true, status: "pending" } };
      return null;
    });
    await open(P, row); await P.flush(); await P.advance(1200);
    P.host.querySelector(".mc-panel .cc-btn.primary").click();
    await P.flush();
    await P.advance(1200 + 60 * 2000);
    frame("taking a while");
    await P.advance(10000);
    frame("still");
  });

  await run("refused request, Close", async (P, frame, row) => {
    P.setRoute((r) => (r.method === "POST" ? { status: 403, json: { ok: false, error: "They're private." } } : null));
    await open(P, row); await P.flush();
    frame("refused");
    [...P.host.querySelectorAll(".mc-panel .cc-btn")].find((b) => b.textContent === "Close").click();
    frame("closed");
  });

  await run("two open previews: the list, discard both, asks again", async (P, frame, row) => {
    let asks = 0;
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") {
        return ++asks === 1 ? { status: 429, json: { ok: false, code: "E_CLIPS_OPEN", error: "Post or discard the clips you have first.",
          open: [{ id: "o1", room: "room-x", state: "ready", login: "bob", secs: 4.4, until: P.clock.now + 90000 },
                 { id: "o2", room: "other room", state: "pending", login: null, until: P.clock.now + 30000 }] } }
          : { status: 200, json: { ok: true, id: "m2" } };
      }
      if (r.method === "POST" && /\/micclip\/o[12]\/discard$/.test(r.url)) return { status: 200, json: { ok: true } };
      if (r.method === "GET") return { status: 200, json: { ok: true, id: "m2", state: "pending" } };
      return null;
    });
    await open(P, row); await P.flush();
    frame("open list");
    let ds = [...P.host.querySelectorAll(".mc-open .cc-btn")];
    ds[0].click(); await P.flush();
    frame("one discarded");
    ds = [...P.host.querySelectorAll(".mc-open .cc-btn")];
    ds[0].click(); await P.flush();
    frame("asked again");
  });

  await run("Pepe never answers", async (P, frame, row) => {
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m3" } };
      if (r.method === "GET") return { status: 200, json: { ok: true, id: "m3", state: "pending" } };
      if (r.method === "POST" && r.url.endsWith("/discard")) return { status: 200, json: { ok: true } };
      return null;
    });
    await open(P, row); await P.flush();
    await P.advance(1200 * 51);
    frame("gave up");
  });

  await run("Pepe couldn't clip / the poll fails", async (P, frame, row) => {
    let n = 0;
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m" + (++n) } };
      if (r.method === "GET" && r.url.endsWith("/m1")) return { status: 200, json: { ok: true, id: "m1", state: "failed", status: "Pepe couldn't clip that." } };
      if (r.method === "GET" && r.url.endsWith("/m2")) return { status: 500, json: { ok: false, error: "HTTP 500" } };
      return null;
    });
    await open(P, row); await P.flush(); await P.advance(1200);
    frame("failed");
    await open(P, row); await P.flush(); await P.advance(1200);
    frame("poll error");
  });

  await run("a second 🔊 Clip replaces an open preview (and discards it)", async (P, frame, row) => {
    const row2 = P.line("tx", "dave", "second mic-up", { tx: "tx-bbbbbbbbbbbbbbbb" });
    await P.flush();
    let n = 0;
    P.setRoute((r) => {
      if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m" + (++n) } };
      if (r.method === "GET") return { status: 200, json: READY({ cost: 500, id: null }, { id: r.url.split("/").pop() }) };
      if (r.method === "POST" && r.url.endsWith("/discard")) return { status: 200, json: { ok: true } };
      return null;
    });
    await open(P, row); await P.flush(); await P.advance(1200);
    frame("first ready");
    await open(P, row2); await P.flush();
    frame("second asking");
    await P.advance(1200);
    frame("second ready");
  });
  return out;
}

// The deltas from the pre-refactor markup the golden allows, each on purpose (and checked on its own below):
//   - accessibility attributes: the card is a named region (role=region, tabindex=-1 so focus can land in it while it loads),
//     its headings are headings (role=heading aria-level=3 tabindex=-1); the visible status line / done box no longer carry
//     role=status aria-live (inserted with their text they were often not read): a live region next to the card says it all
//   - the loading state ("Asking Pepe…") has a Cancel button (Esc): the old card had no way out for up to ~60 s
//   - "Pepe is taking a while" gets a Close (Esc): the old card left both buttons off with no way to put it away
const A11Y = / (?:tabindex="-1"|role="(?:region|heading|status)"|aria-level="3"|aria-live="polite")/g;
const CANCEL = '<button class="cc-btn" type="button">Cancel</button>';
const CLOSE = '<button class="cc-btn" type="button">Close</button>';
const DELTAS = { "Pepe is slow to cut it": { "taking a while": (d) => d.replace(new RegExp(CLOSE + "</div>$"), "</div>"), still: (d) => d.replace(new RegExp(CLOSE + "</div>$"), "</div>") } };
const normWant = (frames) => frames.map((f) => Object.assign({}, f, { dom: f.dom.replace(A11Y, "") }));
const normGot = (name, frames) => frames.map((f) => {
  let dom = f.dom.replace(A11Y, "").split(CANCEL).join("");
  const fix = DELTAS[name] && DELTAS[name][f.label];
  if (fix) { assert.ok(dom.endsWith(CLOSE + "</div>"), name + " / " + f.label + ": the Close it gains"); dom = fix(dom); }
  return Object.assign({}, f, { dom });
});

test("🔊 mic clip: every state's markup and requests are unchanged (golden from the pre-refactor chat-clip.js)", async () => {
  const got = await micScenarios({});
  if (WRITE) {
    fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
    return;
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(Object.keys(got), Object.keys(want));
  for (const k of Object.keys(want)) assert.deepEqual(normGot(k, got[k]), normWant(want[k]), k);
  // the allowed deltas are really there (not just tolerated)
  const asking = got["post with a price, trim, done card, auto-close"].find((f) => f.label === "asking").dom;
  assert.match(asking, /^<div aria-label="Mic clip" class="cc-panel mc-panel" role="region" tabindex="-1"><div class="cc-msg">🔊 Asking Pepe for that mic-up…<\/div><button class="cc-btn" type="button">Cancel<\/button><\/div>$/);
  const ready = got["post with a price, trim, done card, auto-close"].find((f) => f.label === "ready").dom;
  assert.match(ready, /<b aria-level="3" role="heading" tabindex="-1">🔊 Mic clip<\/b>/);
  assert.doesNotMatch(ready, /role="status"|aria-live/, "the visible status line isn't the live region any more");
  const done = got["post with a price, trim, done card, auto-close"].find((f) => f.label === "done").dom;
  assert.match(done, /<div class="mc-done-box"><div aria-level="3" class="mc-done-h" role="heading" tabindex="-1">✅ Clip posted to the pad<\/div>/);
});

// ── the ✂️ chat flow: the same card ──
const PV_LINES = [
  { name: "Alice A", text: "hello room", mic: false, pepe: false, me: false },
  { name: "someone", text: "hey someone, how is it going", mic: false, pepe: false, me: false },
  { name: "carol", text: "i am talking on the mic", mic: true, pepe: false, me: true },
  { name: "bob", text: "that was funny", mic: false, pepe: false, me: false },
];
const WHERE = { pad: "Room X", who: "all", pending: false };
const PREVIEW = (cs, extra) => Object.assign({ ok: true, preview: true, lines: cs.map((c) => PV_LINES[(c - 1) % PV_LINES.length]),
  speakers: new Set(cs.map((c) => PV_LINES[(c - 1) % PV_LINES.length].name)).size, save: { cost: 250 }, why: null, where: WHERE }, extra || {});
const POSTED = { ok: true, post: { id: "abc12345", url: "/p/room-x/posts/abc12345" }, lines: 3, profile: null, price: 250, cut: 100, pending: false };
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

async function chatPage(route, opts) {
  const P = loadPage(opts);
  P.api.update({ room: { live: true, transcripts: true, clip: true } });
  // the live chat shows the real names; the server's preview decides what the quote shows ("shy" went private: "someone")
  const rows = [P.line("msg", "Alice CF", "hello room"), P.line("msg", "shy", "hey alice, how is it going"),
                P.line("tx", "carol", "i am talking on the mic"), P.line("msg", "bob", "that was funny")];
  await P.flush();
  P.setRoute(route || ((r) => (r.method === "POST" && r.url === "/api/rooms/room-x/quote" ? { status: 200, json: r.body.preview ? PREVIEW(r.body.cs) : POSTED } : null)));
  return Object.assign(P, { rows, tog: P.host.querySelector(".cc-toggle"), go: P.host.querySelector(".cc-go"), card: P.host.querySelector(".qc-panel"),
                            mc: P.host.querySelector(".mc-panel"), pick: (r) => P.dispatch(r, "click", {}) });
}
async function openChat(P, rows) {
  P.tog.click();
  rows.forEach((i) => P.pick(P.rows[i]));
  P.go.focus(); P.go.click();
  await P.flush();
}
const btnText = (card, t) => [...card.querySelectorAll("button")].find((b) => b.textContent === t);
// the card's live region: always rendered, right after the card
const srOf = (card) => { const k = card.parentNode.children; return k[k.indexOf(card) + 1]; };
// the card's skeleton: [tag.classes[role][tabindex]] of its children, the head and the action row
function skeleton(card) {
  const d = (n) => n.tagName.toLowerCase() + "." + n.className.split(/\s+/).filter(Boolean).sort().join(".") + (n.getAttribute("role") ? "[" + n.getAttribute("role") + "]" : "") +
                   (n.getAttribute("tabindex") ? "[tabindex=" + n.getAttribute("tabindex") + "]" : "");
  const kids = card.children, sr = srOf(card);
  return { panel: card.classList.contains("cc-panel"), region: card.getAttribute("role"), head: kids[0].children.map(d), hint: kids[0].children[1].textContent.replace(/ · .*$/, " · …"),
           actions: kids[kids.length - 2].children.map(d), secondary: kids[kids.length - 2].children[1].textContent, status: d(kids[kids.length - 1]),
           live: [sr.className, sr.getAttribute("role"), sr.getAttribute("aria-live")] };
}
// canonical markup (attributes and classes sorted) of the feed's own render, to compare with the stub DOM's
function canon(html) {
  return html.replace(/>\s*\n\s*</g, "><").trim().replace(/<(\/?)([a-z0-9]+)([^>]*)>/g, (m, close, tag, rest) => {
    if (close) return "</" + tag + ">";
    const at = [...rest.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((x) => [x[1], x[2] == null ? "" : x[2]])
      .map(([k, v]) => [k, k === "class" ? v.split(/\s+/).filter(Boolean).sort().join(" ") : v]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return "<" + tag + at.map(([k, v]) => (v === "" ? " " + k : ` ${k}="${v}"`)).join("") + ">";
  });
}
async function feedFigure(lines, speakers) {
  const ejs = require("ejs");
  const html = await ejs.renderFile(path.join(repo, "views/partials/feed-post-content.ejs"),
    { q: { quote: { lines, speakers, source: "web" }, images: [], video: [], audio: [], ai: [] }, fx: {}, embeds: {}, host: "x", detail_: false, signed: true, url_: "/p/x" });
  return canon(html.slice(html.indexOf("<figure"), html.indexOf("</figure>") + 9));
}
const doneBox = (s) => { s = s.replace(A11Y, ""); return s.slice(s.indexOf('<div class="mc-done-box"'), s.lastIndexOf("</div>")); };

test("✂️ chat clip: Clip N lines -> the server's preview in the mic's card (what, where, who can see it) -> Post -> the mic's done card", async () => {
  const P = await chatPage();
  assert.equal(P.go.hidden, true, "no Clip button until picking");
  P.tog.click();
  assert.equal(P.tog.textContent, "✕ Cancel clip", "while picking, the toggle says what pressing it does");
  assert.equal(P.tog.hasAttribute("aria-pressed"), false, "a label that changes is not also a pressed state");
  assert.equal(P.go.hidden, true, "…and until a line is picked");
  assert.match(P.host.querySelector(".cc-bar .cc-hint").textContent, /^Tap a line, then tap another/);
  P.pick(P.rows[0]); P.pick(P.rows[2]);
  assert.deepEqual(P.api._picked().map((r) => r.getAttribute("data-c")), ["1", "2", "3"], "a range, as before");
  assert.equal(P.go.hidden, false);
  assert.equal(P.go.textContent, "Clip 3 lines");
  assert.equal(P.card.hidden, true, "nothing opens while picking");
  assert.equal(P.reqs.length, 0);
  P.go.focus(); P.go.click();
  // loading: the mic's "asking" state - the status line + Cancel
  assert.equal(serialize(P.card), '<div aria-label="Chat clip" class="cc-panel qc-panel" role="region" tabindex="-1"><div class="cc-msg">Building your clip…</div><button class="cc-btn" type="button">Cancel</button></div>');
  assert.equal(P.doc.activeElement, P.card, "focus moved into the card before its button hid itself");
  assert.equal(srOf(P.card).textContent, "Building your clip…", "read out by the card's live region");
  assert.equal(P.go.hidden, true, "the card is the next step");
  assert.deepEqual(P.reqs.map((r) => [r.method, r.url, r.body, r.xrw]), [["POST", "/api/rooms/room-x/quote", { cs: [1, 2, 3], preview: true }, true]]);
  await P.flush();
  const head = P.card.children[0];
  assert.equal(head.children[0].textContent, "✂️ Chat clip", "the same ✂️ as its button");
  assert.equal(head.children[0].getAttribute("role"), "heading");
  assert.equal(head.children[0].getAttribute("aria-level"), "3");
  assert.equal(head.children[1].textContent, "a free preview, only for you · 3 lines");
  assert.equal(P.doc.activeElement, head.children[0], "focus moves to the card's heading");
  // the preview is the server's lines in the feed's own quote markup
  const fig = P.card.querySelector("figure.fq");
  assert.equal(serialize(fig), '<figure aria-label="Quote from the pad\'s chat room" class="fq"><blockquote class="fq-lines">' +
    '<p class="fq-l"><span class="fq-n">&lt;Alice A&gt;</span> <span class="fq-t">hello room</span></p>' +
    '<p class="anon fq-l"><span class="fq-n">&lt;someone&gt;</span> <span class="fq-t">hey someone, how is it going</span></p>' +
    '<p class="fq-l me mic"><span class="fq-n">&lt;carol&gt;</span> <span aria-label="on the mic" class="fq-mic" title="Said on the mic (auto-transcribed)">🎙</span> <span class="fq-t">i am talking on the mic</span></p>' +
    '</blockquote><figcaption class="fq-cap">💬 3 people · 3 lines</figcaption></figure>');
  assert.equal(serialize(fig), await feedFigure(PV_LINES.slice(0, 3), 3), "exactly the feed's quote card");
  assert.equal(P.card.querySelectorAll(".av, img, .flair").length, 0, "no avatars or looks");
  assert.doesNotMatch(P.card.textContent, /\bshy\b/, "the live chat's name of someone private never reaches the preview");
  // where it goes and who can read it
  assert.equal(P.card.querySelector(".cc-where").textContent, "Goes on the Room X feed · anyone can see it");
  const prim = P.card.querySelector(".cc-btn.primary");
  assert.equal(prim.textContent, "Post to the pad — 250 PAT", "the price on the button, like the mic's");
  assert.equal(prim.disabled, false);
  const note = "Add a title if you like, then post it. Anyone quoted can show their lines as “someone”.";
  assert.equal(P.card.querySelector(".cc-msg").textContent, note);
  assert.equal(srOf(P.card).textContent, note, "the rule is read out (the heading took focus)");
  // the title shows in the preview as the post will carry it
  const title = P.card.querySelector('input[type="text"]'), prof = P.card.querySelector('input[type="checkbox"]');
  const ptitle = P.card.querySelector(".cc-ptitle");
  assert.equal(ptitle.hidden, true, "no title, no title line");
  assert.equal(title.placeholder, "Title (optional)");
  assert.equal(title.getAttribute("aria-label"), "Clip title (optional)");
  assert.equal(title.maxLength, "140");
  title.focus(); title.value = "  the start "; P.dispatch(title, "input"); prof.checked = true;
  assert.equal(ptitle.textContent, "the start");
  assert.equal(ptitle.hidden, false);
  key(P, prof, "Enter");
  assert.equal(P.reqs.length, 1, "Enter on the checkbox doesn't post");
  key(P, title, "Enter");
  assert.deepEqual(P.reqs[1].body, { cs: [1, 2, 3], title: "the start", profile: true }, "the unchanged Post request (no preview flag)");
  assert.equal(prim.disabled, true); assert.equal(btnText(P.card, "Discard").disabled, true);
  assert.equal(P.card.querySelector(".cc-msg").textContent, "Posting…");
  key(P, title, "Enter");
  assert.equal(P.reqs.length, 2, "posted once");
  await P.flush();
  // the mic's done card, the same markup
  const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"))["post with a price, trim, done card, auto-close"].find((f) => f.label === "done").dom;
  assert.equal(doneBox(serialize(P.card)), doneBox(golden));
  assert.ok(P.card.classList.contains("mc-done"));
  assert.equal(P.doc.activeElement, P.card.querySelector(".mc-done-h"), "posted from the keyboard: focus follows to the done card");
  assert.equal(P.tog.textContent, "✂️ Clip chat", "picking ends");
  assert.equal(P.feed.classList.contains("cc-on"), false);
  assert.equal(P.feed.querySelectorAll(".cc-sel").length, 0);
  await P.advance(30000);
  assert.equal(P.card.hidden, false, "it waits for a keyboard user (focus in it holds it)");
  key(P, P.doc.activeElement, "Escape");
  assert.equal(P.card.hidden, true, "Esc closes the done card");
  assert.equal(P.doc.activeElement, P.tog, "focus back to ✂️ Clip chat (the Clip button left with picking)");
});

test("both clips are the one shared card: same skeleton, same head / buttons / status line / live region", async () => {
  const made = [];
  const P = await chatPage((r) => {
    if (r.url === "/api/rooms/room-x/quote") return { status: 200, json: PREVIEW(r.body.cs) };
    if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
    if (r.method === "GET") return { status: 200, json: READY({ cost: 500, id: null }) };
    return null;
  }, { spy: made });
  assert.deepEqual(made, ["qc-panel", "mc-panel"], "both cards come from PATVClipConfirm.create");
  const mic = P.rows[2].querySelector(".mc-btn");
  mic.focus(); mic.click(); await P.flush(); await P.advance(1200);
  const a = skeleton(P.mc);
  await openChat(P, [0, 1]);
  const b = skeleton(P.card);
  assert.deepEqual(a, b);
  assert.equal(a.region, "region");
  assert.deepEqual(a.head, ["b.[heading][tabindex=-1]", "span.cc-hint"]);
  assert.equal(a.hint, "a free preview, only for you · …");
  assert.deepEqual(a.actions, ["button.cc-btn.primary", "button.cc-btn"], "primary first, then Discard");
  assert.equal(a.secondary, "Discard");
  assert.equal(a.status, "div.cc-msg");
  assert.deepEqual(a.live, ["cc-sr sr-only", "status", "polite"]);
  // the order of the parts: head, what will be posted (+ where it goes), actions, status
  assert.deepEqual(P.card.children.map((n) => n.className), ["cc-row", "cc-prev", "cc-where", "cc-row", "cc-row", "cc-msg"]);
});

test("✂️ the card follows the picks: preview again after a pause, Post waits for it, focus and title stay; at most 20", async () => {
  const P = await chatPage();
  await openChat(P, [0, 1]);
  const title = P.card.querySelector('input[type="text"]');
  title.focus(); title.value = "keep me";
  P.pick(P.rows[3]);
  const prim = P.card.querySelector(".cc-btn.primary");
  assert.equal(prim.disabled, true, "Post waits for the new preview");
  assert.equal(P.card.querySelector(".cc-msg").textContent, "Updating the preview…");
  key(P, title, "Enter");
  assert.equal(P.reqs.length, 1, "nothing posted from a stale preview");
  await P.advance(399);
  assert.equal(P.reqs.length, 1, "after a pause");
  P.pick(P.rows[2]);                                                    // a burst of picks = one request
  await P.advance(399);
  assert.equal(P.reqs.length, 1);
  await P.advance(1);
  assert.deepEqual(P.reqs[1].body, { cs: [1, 2, 3, 4], preview: true });
  assert.equal(P.card.querySelector(".fq-cap").textContent, "💬 4 people · 4 lines");
  assert.equal(P.card.querySelector(".cc-hint").textContent, "a free preview, only for you · 4 lines");
  assert.equal(prim.disabled, false);
  assert.equal(title.value, "keep me", "the title survives");
  assert.equal(P.card.querySelector(".cc-ptitle").textContent, "keep me", "…and stays in the preview");
  assert.equal(P.doc.activeElement, title, "focus stays where it was");
  key(P, title, "Enter");
  assert.deepEqual(P.reqs[2].body, { cs: [1, 2, 3, 4], title: "keep me", profile: false });
  // over the limit: the Clip button says so
  const Q = await chatPage();
  for (let i = 0; i < 18; i++) Q.line("msg", "x" + i, "line " + i);
  await Q.flush();
  Q.tog.click(); Q.pick(Q.rows[0]); Q.pick(Q.feed.children[Q.feed.children.length - 1]);
  assert.equal(Q.api._picked().length, 22);
  assert.equal(Q.go.disabled, true);
  assert.equal(Q.host.querySelector(".cc-bar .cc-hint").textContent, "A clip is at most 20 lines — drop some.");
  Q.go.click();
  assert.equal(Q.reqs.length, 0);
});

test("✂️ Discard / Esc throw the clip away; Cancel / Esc while it loads keep the picks; dropping every line closes it", async () => {
  let P = await chatPage();
  await openChat(P, [0, 1]);
  btnText(P.card, "Discard").focus();
  btnText(P.card, "Discard").click();
  assert.equal(P.card.hidden, true);
  assert.equal(P.feed.querySelectorAll(".cc-sel").length, 0);
  assert.equal(P.tog.textContent, "✂️ Clip chat", "picking ends");
  assert.equal(P.doc.activeElement, P.tog);
  assert.equal(P.reqs.length, 1, "nothing to tell the server");
  P = await chatPage();
  await openChat(P, [0, 1]);
  const title = P.card.querySelector('input[type="text"]');
  title.focus();
  const ev = key(P, title, "Escape");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(P.card.hidden, true, "Esc = Discard");
  assert.equal(P.doc.activeElement, P.tog);
  // while it loads: Esc (focus is in the card) = Cancel - the picks stay, focus back to the Clip button
  const slow = deferred();
  P = await chatPage((r) => (r.url === "/api/rooms/room-x/quote" ? slow.p : null));
  P.tog.click(); P.pick(P.rows[0]); P.pick(P.rows[1]);
  P.go.focus(); P.go.click();
  assert.equal(P.doc.activeElement, P.card);
  key(P, P.card, "Escape");
  assert.equal(P.card.hidden, true, "Esc while loading = Cancel");
  assert.equal(P.go.hidden, false);
  assert.equal(P.doc.activeElement, P.go, "focus back to the Clip button");
  assert.equal(P.api._picked().length, 2, "the picks stay");
  slow.resolve({ status: 200, json: PREVIEW([1, 2]) });
  await P.flush(); await P.flush();
  assert.equal(P.card.hidden, true, "a preview that answers after Cancel opens nothing");
  P = await chatPage();
  await openChat(P, [0]);
  P.pick(P.rows[0]);
  assert.equal(P.card.hidden, true, "no line left: the card goes");
  assert.equal(P.go.hidden, true);
  assert.equal(P.tog.textContent, "✕ Cancel clip", "still picking");
});

test("✂️ refusals look like the mic's: status + Close; can't-post says why; a failed Post can be tried again; CL3's not_quotable", async () => {
  let P = await chatPage((r) => (r.url === "/api/rooms/room-x/quote" ? { status: 401, json: { ok: false, error: "Sign in to quote." } } : null));
  await openChat(P, [0]);
  assert.equal(serialize(P.card), '<div aria-label="Chat clip" class="cc-panel qc-panel" role="region" tabindex="-1"><div class="bad cc-msg">Sign in to quote.</div><button class="cc-btn" type="button">Close</button></div>');
  assert.equal(srOf(P.card).textContent, "Sign in to quote.");
  const micRefused = JSON.parse(fs.readFileSync(GOLDEN, "utf8"))["refused request, Close"][0].dom.replace(A11Y, "");
  assert.equal(serialize(P.card).replace(A11Y, "").replace("Chat clip", "").replace("qc-panel", "").replace("Sign in to quote.", ""),
               micRefused.replace("Mic clip", "").replace("mc-panel", "").replace("They're private.", ""), "the mic's refusal markup");
  const close = btnText(P.card, "Close");
  close.focus();
  key(P, close, "Escape");
  assert.equal(P.card.hidden, true);
  assert.equal(P.doc.activeElement, P.go, "back to the Clip button (still picking)");
  assert.equal(P.go.hidden, false);
  // can't post: the server's reason; the button doesn't blame "here" for a balance or an opt-out
  P = await chatPage((r) => (r.url === "/api/rooms/room-x/quote" ? { status: 200, json: PREVIEW(r.body.cs, { save: null, why: "carol has opted out of being quoted." }) } : null));
  await openChat(P, [2]);
  const prim = P.card.querySelector(".cc-btn.primary");
  assert.equal(prim.textContent, "Can't post");
  assert.equal(prim.disabled, true);
  assert.equal(P.card.querySelector(".cc-msg").textContent, "carol has opted out of being quoted.");
  // Post refused (not enough PAT): shown, both buttons back
  let n = 0;
  P = await chatPage((r) => (r.url !== "/api/rooms/room-x/quote" ? null : r.body.preview ? { status: 200, json: PREVIEW(r.body.cs) }
    : ++n === 1 ? { status: 402, json: { ok: false, error: "A quote costs 250 PAT - you have 100." } } : { status: 200, json: POSTED }));
  await openChat(P, [0, 1]);
  P.card.querySelector(".cc-btn.primary").click();
  await P.flush();
  const msg = P.card.querySelector(".cc-msg");
  assert.equal(msg.textContent, "A quote costs 250 PAT - you have 100.");
  assert.ok(msg.classList.contains("bad"));
  assert.equal(P.card.querySelector(".cc-btn.primary").disabled, false);
  assert.equal(btnText(P.card, "Discard").disabled, false);
  P.card.querySelector(".cc-btn.primary").click();
  await P.flush();
  assert.ok(P.card.querySelector(".mc-done-box"), "posted on the second try");
  assert.equal(P.doc.activeElement === P.card.querySelector(".mc-done-h"), false, "posted with the pointer: focus isn't moved");
  // a profile crosspost that failed is said on the done card
  P = await chatPage((r) => (r.url !== "/api/rooms/room-x/quote" ? null : { status: 200, json: r.body.preview ? PREVIEW(r.body.cs) : Object.assign({}, POSTED, { profile: { error: "Your profile is private." } }) }));
  await openChat(P, [0]);
  P.card.querySelector(".cc-btn.primary").click();
  await P.flush();
  assert.equal(P.card.querySelector(".mc-done-box .cc-msg").textContent, "It isn't on your profile: Your profile is private.");
  // cl-site's CL3: lines outside your view get one coded refusal - said in your language, on the preview and on Post
  const NQ = { status: 403, json: { ok: false, code: "not_quotable", error: "Those lines can't be quoted." } };
  P = await chatPage((r) => (r.url === "/api/rooms/room-x/quote" ? NQ : null));
  await openChat(P, [0]);
  assert.equal(P.card.querySelector(".cc-msg").textContent, "Those lines can’t be quoted.");
  n = 0;
  P = await chatPage((r) => (r.url !== "/api/rooms/room-x/quote" ? null : r.body.preview ? { status: 200, json: PREVIEW(r.body.cs) } : NQ));
  await openChat(P, [0]);
  P.card.querySelector(".cc-btn.primary").click();
  await P.flush();
  assert.equal(P.card.querySelector(".cc-msg").textContent, "Those lines can’t be quoted.");
});

test("✂️ a later preview that fails says so and offers Try again (no retry loop); the same lines again don't re-ask on their own", async () => {
  let n = 0;
  const P = await chatPage((r) => {
    if (r.url !== "/api/rooms/room-x/quote") return null;
    if (!r.body.preview) return { status: 200, json: POSTED };
    n++;
    return n === 2 ? { status: 429, json: { ok: false, error: "Slow down — too many previews. Try again in a minute." } } : { status: 200, json: PREVIEW(r.body.cs) };
  });
  await openChat(P, [0]);
  P.pick(P.rows[1]);
  await P.advance(400);
  const prim = P.card.querySelector(".cc-btn.primary");
  assert.equal(P.card.querySelector(".cc-msg").textContent, "Slow down — too many previews. Try again in a minute.");
  assert.ok(P.card.querySelector(".cc-msg").classList.contains("bad"));
  assert.equal(prim.textContent, "Try again");
  assert.equal(prim.disabled, false, "not a dead end: only Discard used to be left, and it threw the picks away");
  const before = P.reqs.length;
  P.line("msg", "dave", "a new line arrives");
  await P.flush(); await P.advance(5000);
  assert.equal(P.reqs.length, before, "no automatic retry on every new chat line");
  prim.click();
  assert.equal(P.card.querySelector(".cc-msg").textContent, "Updating the preview…");
  await P.flush();
  assert.deepEqual(P.reqs[P.reqs.length - 1].body, { cs: [1, 2], preview: true });
  assert.equal(prim.textContent, "Post to the pad — 250 PAT");
  assert.equal(P.card.querySelector(".fq-cap").textContent, "💬 2 people · 2 lines");
  prim.click(); await P.flush();
  assert.deepEqual(P.reqs[P.reqs.length - 1].body, { cs: [1, 2], title: "", profile: false });
});

test("✂️ more than 8 lines: the feed card's first 8 + '+ N more lines', which shows the rest here; pending approval is said", async () => {
  const P = await chatPage((r) => (r.url !== "/api/rooms/room-x/quote" ? null
    : { status: 200, json: r.body.preview ? PREVIEW(r.body.cs, { where: { pad: "Room X", who: "approved", pending: true } }) : Object.assign({}, POSTED, { pending: true }) }));
  for (let i = 0; i < 6; i++) P.line("msg", "x" + i, "line " + i);
  await P.flush();
  P.tog.click(); P.pick(P.rows[0]); P.pick(P.feed.children[9]);
  P.go.focus(); P.go.click(); await P.flush();
  const fig = P.card.querySelector("figure.fq");
  assert.equal(fig.querySelectorAll(".fq-l").length, 8, "the feed shows 8");
  const more = fig.querySelector(".fq-more .cc-more");
  assert.equal(more.textContent, "+ 2 more lines");
  assert.equal(fig.querySelector(".fq-cap").textContent, "💬 4 people · 10 lines");
  const lines10 = Array.from({ length: 10 }, (_, i) => PV_LINES[i % 4]);
  assert.equal(serialize(fig).replace('<button class="cc-more" type="button">', '<a href="/p/x">').replace("</button></p>", "</a></p>"), await feedFigure(lines10, 4),
               "the feed card's markup (its link to the post is a button that shows the rest here)");
  more.focus(); more.click();
  assert.equal(P.card.querySelectorAll("figure.fq .fq-l").length, 10);
  assert.equal(P.card.querySelector(".fq-more"), null);
  assert.equal(P.doc.activeElement, P.card.querySelectorAll(".fq-l")[8], "focus on the first line it showed");
  assert.equal(P.card.querySelector(".cc-where").textContent, "Goes on the Room X feed · only the pad's approved members can see it · the pad owner approves it first");
  P.card.querySelector(".cc-btn.primary").click(); await P.flush();
  assert.equal(P.card.querySelector(".mc-done-h").textContent, "✅ Clip sent — it shows once the pad owner approves it", "not 'posted' while it waits for approval");
  // the 18+ wording
  const Q = await chatPage((r) => (r.url === "/api/rooms/room-x/quote" ? { status: 200, json: PREVIEW(r.body.cs, { where: { pad: "Late Room", who: "adult", pending: false } }) } : null));
  await openChat(Q, [0]);
  assert.equal(Q.card.querySelector(".cc-where").textContent, "Goes on the Late Room feed · only signed-in people who confirmed they're 18+ can see it");
});

test("✂️ picking from the keyboard: one tab stop, ↑ ↓ Home End, Space picks, Shift+Space takes a range, Esc cancels", async () => {
  const P = await chatPage();
  // turned on with the pointer: focus stays put
  P.tog.focus(); P.tog.click();
  assert.equal(P.doc.activeElement, P.tog);
  P.tog.click();
  // turned on from the keyboard (a click with detail 0): straight to the newest line
  P.dispatch(P.tog, "click", { detail: 0 });
  const [r0, r1, r2, r3] = P.rows;
  assert.equal(P.doc.activeElement, r3, "the newest line");
  assert.deepEqual(P.rows.map((r) => [r.getAttribute("role"), r.getAttribute("aria-checked"), r.getAttribute("tabindex")]),
    [["checkbox", "false", "-1"], ["checkbox", "false", "-1"], ["checkbox", "false", "-1"], ["checkbox", "false", "0"]], "lines are checkboxes, one in the tab order");
  const keysHint = P.host.querySelector("#" + r0.getAttribute("aria-describedby"));
  assert.match(keysHint.textContent, /arrows move between lines, Space picks one/);
  assert.ok(keysHint.classList.contains("sr-only"));
  key(P, r3, "ArrowUp");
  assert.equal(P.doc.activeElement, r2);
  assert.deepEqual([r2.getAttribute("tabindex"), r3.getAttribute("tabindex")], ["0", "-1"], "roving");
  let ev = key(P, r2, " ");
  assert.equal(ev.defaultPrevented, true, "Space doesn't scroll the chat");
  assert.equal(r2.getAttribute("aria-checked"), "true");
  assert.equal(P.go.textContent, "Clip 1 line");
  key(P, r2, "Home");
  assert.equal(P.doc.activeElement, r0);
  key(P, r0, " ", { shiftKey: true });
  assert.deepEqual(P.api._picked(), [r0, r1, r2], "Shift+Space: everything from the first pick");
  assert.deepEqual(P.rows.map((r) => r.getAttribute("aria-checked")), ["true", "true", "true", "false"]);
  key(P, r0, "Enter");
  assert.deepEqual(P.api._picked(), [r1, r2], "Enter toggles too");
  key(P, r0, "End");
  assert.equal(P.doc.activeElement, r3);
  key(P, r3, "ArrowDown");
  assert.equal(P.doc.activeElement, r3, "the last line stays");
  // a line arriving while picking is a checkbox too, outside the tab order
  const r4 = P.line("msg", "eve", "late line"); await P.flush();
  assert.deepEqual([r4.getAttribute("role"), r4.getAttribute("tabindex")], ["checkbox", "-1"]);
  // a click moves the keyboard's place to that line
  P.pick(r0);
  assert.equal(r0.getAttribute("tabindex"), "0");
  // Esc on a line cancels picking: picks gone, lines plain again, focus on ✂️ Clip chat
  r0.focus();
  ev = key(P, r0, "Escape");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(P.feed.classList.contains("cc-on"), false);
  assert.equal(P.api._picked().length, 0);
  assert.deepEqual(P.rows.map((r) => [r.hasAttribute("role"), r.hasAttribute("aria-checked"), r.hasAttribute("tabindex")]), Array(4).fill([false, false, false]));
  assert.equal(P.doc.activeElement, P.tog);
  // keyboard all the way: pick, Clip N lines, the card
  P.dispatch(P.tog, "click", { detail: 0 });
  key(P, P.doc.activeElement, " ");
  P.go.focus(); P.dispatch(P.go, "click", { detail: 0 }); await P.flush();
  assert.equal(P.doc.activeElement, P.card.querySelector('[role="heading"]'));
});

test("one card at a time: opening the chat clip discards an open mic clip (as its Esc would)", async () => {
  const P = await chatPage((r) => {
    if (r.url === "/api/rooms/room-x/quote") return { status: 200, json: PREVIEW(r.body.cs) };
    if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
    if (r.method === "POST" && r.url.endsWith("/discard")) return { status: 200, json: { ok: true } };
    if (r.method === "GET") return { status: 200, json: READY({ cost: 500, id: null }) };
    return null;
  });
  const mic = P.rows[2].querySelector(".mc-btn");
  mic.focus(); mic.click(); await P.flush(); await P.advance(1200);
  assert.equal(P.mc.hidden, false);
  await openChat(P, [0]);
  assert.equal(P.mc.hidden, true, "the mic card went");
  assert.ok(P.reqs.some((r) => r.method === "POST" && r.url === "/api/rooms/room-x/micclip/m1/discard"), "its preview withdrawn, like Discard");
  assert.equal(P.card.hidden, false);
  assert.equal(P.doc.activeElement, P.card.querySelector('[role="heading"]'), "focus is in the new card");
});

test("🔊 mic card keyboard and focus: Cancel / Esc while asking, heading on ready, Esc = Discard, focus back; the done card waits for keyboard users", async () => {
  const P = await chatPage((r) => {
    if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
    if (r.method === "GET" && r.url === "/api/rooms/room-x/micclip/m1") return { status: 200, json: READY({ cost: 500, id: null }) };
    if (r.method === "POST" && r.url.endsWith("/discard")) return { status: 200, json: { ok: true } };
    if (r.method === "POST" && r.url.endsWith("/save")) return { status: 200, json: { ok: true } };
    if (r.method === "GET" && r.url.endsWith("/save")) return { status: 200, json: { ok: true, status: "done", url: "/p/room-x/posts/abc12345" } };
    return null;
  });
  const mc = P.mc, btn = P.rows[2].querySelector(".mc-btn");
  assert.equal(mc.getAttribute("role"), "region");
  assert.equal(mc.getAttribute("aria-label"), "Mic clip");
  // asking: focus follows into the card; Esc = Cancel, which withdraws the request (as Discard does)
  btn.focus(); btn.click();
  assert.equal(P.doc.activeElement, mc);
  assert.equal(srOf(mc).textContent, "🔊 Asking Pepe for that mic-up…");
  await P.flush();
  let ev = key(P, mc, "Escape");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(mc.hidden, true, "Esc while asking = Cancel");
  assert.equal(P.reqs[P.reqs.length - 1].url, "/api/rooms/room-x/micclip/m1/discard");
  assert.equal(P.doc.activeElement, btn, "focus back to 🔊 Clip");
  assert.equal(srOf(mc).textContent, "", "the live region empties with the card");
  // ready: the heading; Esc = Discard
  btn.focus(); btn.click(); await P.flush(); await P.advance(1200);
  assert.equal(P.doc.activeElement, mc.querySelector(".cc-row b"), "focus moves to the heading");
  ev = key(P, P.doc.activeElement, "Escape");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(mc.hidden, true, "Esc = Discard");
  assert.equal(P.reqs[P.reqs.length - 1].url, "/api/rooms/room-x/micclip/m1/discard");
  assert.equal(P.doc.activeElement, btn, "focus back to 🔊 Clip");
  // you moved on (typing in the chat box) before Pepe answered: focus stays there, the card is read out instead
  btn.focus(); btn.click(); await P.flush();
  P.compose.focus();
  await P.advance(1200);
  assert.equal(mc.hidden, false);
  assert.equal(P.doc.activeElement, P.compose, "no focus stealing");
  assert.match(srOf(mc).textContent, /^🔊 Mic clip · Trim it, then post it/);
  key(P, P.compose, "Escape");
  assert.equal(mc.hidden, false, "Esc outside the card does nothing to it");
  // posted with the pointer: focus isn't moved, it closes itself after 12 s (as before)
  mc.querySelector(".cc-btn.primary").click(); await P.flush(); await P.advance(1200);
  assert.ok(mc.querySelector(".mc-done-box"));
  assert.equal(P.doc.activeElement, P.compose);
  assert.equal(srOf(mc).textContent, "✅ Clip posted to the pad", "the done card is read out");
  await P.advance(11000);
  assert.equal(mc.hidden, false);
  await P.advance(1200);
  assert.equal(mc.hidden, true, "closed itself");
  assert.equal(P.doc.activeElement, P.compose, "…without moving focus");
  // posted from the keyboard (Enter / Space on Post: detail 0): focus to the done card, which then waits
  btn.focus(); btn.click(); await P.flush(); await P.advance(1200);
  const post = mc.querySelector(".cc-btn.primary");
  post.focus(); P.dispatch(post, "click", { detail: 0 }); await P.flush(); await P.advance(1200);
  assert.equal(P.doc.activeElement, mc.querySelector(".mc-done-h"));
  await P.advance(30000);
  assert.equal(mc.hidden, false, "held while focus is in it");
  // focus leaves: the countdown runs again
  P.compose.focus();
  await P.advance(12500);
  assert.equal(mc.hidden, true, "closes once you've moved on");
  assert.equal(P.doc.activeElement, P.compose);
  // focusing its buttons holds it open, as before; Esc = Close
  btn.focus(); btn.click(); await P.flush(); await P.advance(1200);
  mc.querySelector(".cc-btn.primary").click(); await P.flush(); await P.advance(1200);
  mc.querySelector(".mc-done-box .cc-btn:not(.primary)").focus();
  await P.advance(30000);
  assert.equal(mc.hidden, false, "held while a button has focus");
  key(P, P.doc.activeElement, "Escape");
  assert.equal(mc.hidden, true, "Esc = Close");
  assert.equal(P.doc.activeElement, btn);
});

test("🔊 'Pepe is taking a while' can be put away (Close / Esc, the post untouched); focus falls back to ✂️ when 🔊 Clip is gone", async () => {
  const P = await chatPage((r) => {
    if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: "m1" } };
    if (r.method === "GET" && r.url === "/api/rooms/room-x/micclip/m1") return { status: 200, json: READY({ cost: 10, id: null }) };
    if (r.method === "POST" && r.url.endsWith("/save")) return { status: 200, json: { ok: true } };
    if (r.method === "GET" && r.url.endsWith("/save")) return { status: 200, json: { ok: true, status: "pending" } };
    if (r.method === "POST" && r.url.endsWith("/discard")) return { status: 200, json: { ok: true } };
    return null;
  });
  const mc = P.mc, btn = P.rows[2].querySelector(".mc-btn");
  btn.focus(); btn.click(); await P.flush(); await P.advance(1200);
  mc.querySelector(".cc-btn.primary").click(); await P.flush();
  await P.advance(1200 + 60 * 2000);
  assert.equal(mc.querySelector(".cc-msg").textContent, "Pepe is taking a while — check the pad's feed in a minute.");
  const close = btnText(mc, "Close");
  assert.ok(close, "a way out");
  close.focus();
  key(P, close, "Escape");
  assert.equal(mc.hidden, true);
  assert.equal(P.reqs.some((r) => r.url.endsWith("/discard")), false, "a posted clip is never discarded");
  assert.equal(P.doc.activeElement, btn);
  // the 🔊 Clip it came from scrolled out of the chat: focus goes to ✂️ Clip chat
  btn.focus(); btn.click(); await P.flush(); await P.advance(1200);
  P.feed.removeChild(P.rows[2]);
  key(P, P.doc.activeElement, "Escape");
  assert.equal(mc.hidden, true);
  assert.equal(P.doc.activeElement, P.tog, "fallback");
});

test("late answers never write into a newer card (chat previews, the mic's save and poll)", async () => {
  // a preview for picks you've since changed: only the newest one shows
  const first = deferred();
  let n = 0;
  let P = await chatPage((r) => (r.url !== "/api/rooms/room-x/quote" ? null : ++n === 1 ? first.p : { status: 200, json: PREVIEW(r.body.cs) }));
  P.tog.click(); P.pick(P.rows[0]);
  P.go.focus(); P.go.click();
  P.pick(P.rows[1]);
  await P.advance(400);
  assert.equal(P.card.querySelector(".fq-cap").textContent, "💬 2 people · 2 lines");
  first.resolve({ status: 200, json: PREVIEW([1]) });
  await P.flush(); await P.flush();
  assert.equal(P.card.querySelector(".fq-cap").textContent, "💬 2 people · 2 lines", "the older answer is dropped");
  P.card.querySelector(".cc-btn.primary").click(); await P.flush();
  assert.deepEqual(P.reqs[P.reqs.length - 1].body, { cs: [1, 2], title: "", profile: false }, "Post sends what's shown");
  // a failed preview after Discard: nothing shows up
  const late = deferred();
  P = await chatPage((r) => (r.url === "/api/rooms/room-x/quote" ? late.p : null));
  P.tog.click(); P.pick(P.rows[0]); P.go.focus(); P.go.click();
  btnText(P.card, "Cancel").click();
  late.resolve({ status: 500, json: { ok: false, error: "boom" } });
  await P.flush(); await P.flush();
  assert.equal(P.card.hidden, true);
  assert.equal(P.card.textContent, "");
  // the mic: a save answer for a clip you've replaced doesn't mark or poll the new one
  const save = deferred();
  P = await chatPage((r) => {
    if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: r.body.tx === "tx-bbbbbbbbbbbbbbbb" ? "m2" : "m1" } };
    if (r.method === "GET" && /\/micclip\/m[12]$/.test(r.url)) return { status: 200, json: READY({ cost: 10, id: null }, { id: r.url.slice(-2) }) };
    if (r.method === "POST" && r.url.endsWith("/m1/save")) return save.p;
    if (r.method === "POST" && r.url.endsWith("/discard")) return { status: 200, json: { ok: true } };
    return null;
  });
  const row2 = P.line("tx", "dave", "second mic-up", { tx: "tx-bbbbbbbbbbbbbbbb" });
  await P.flush();
  const b1 = P.rows[2].querySelector(".mc-btn"), b2 = row2.querySelector(".mc-btn");
  b1.click(); await P.flush(); await P.advance(1200);
  P.mc.querySelector(".cc-btn.primary").click(); await P.flush();
  b2.click(); await P.flush(); await P.advance(1200);
  assert.equal(P.reqs.some((r) => r.url.endsWith("/m1/discard")), false, "a clip being saved isn't discarded");
  const before = serialize(P.mc), reqs = P.reqs.length;
  save.resolve({ status: 200, json: { ok: true } });
  await P.flush(); await P.advance(5000);
  assert.equal(serialize(P.mc), before, "the new card is untouched");
  assert.equal(P.reqs.slice(reqs).some((r) => r.url.includes("/m1/save")), false, "no poll for the old clip");
  assert.equal(P.mc.querySelector(".cc-btn.primary").disabled, false, "the new clip can still be posted");
  btnText(P.mc, "Discard").click(); await P.flush();
  assert.equal(P.reqs[P.reqs.length - 1].url, "/api/rooms/room-x/micclip/m2/discard", "…or discarded: the old answer didn't mark it posted");
  // the mic: a poll that fails after you replaced the clip doesn't put its error on the new card
  const poll = deferred();
  P = await chatPage((r) => {
    if (r.method === "POST" && r.url === "/api/rooms/room-x/micclip") return { status: 200, json: { ok: true, id: r.body.tx === "tx-bbbbbbbbbbbbbbbb" ? "m2" : "m1" } };
    if (r.method === "GET" && r.url.endsWith("/micclip/m1")) return poll.p;
    if (r.method === "GET" && r.url.endsWith("/micclip/m2")) return { status: 200, json: { ok: true, id: "m2", state: "pending" } };
    if (r.method === "POST" && r.url.endsWith("/discard")) return { status: 200, json: { ok: true } };
    return null;
  });
  const row3 = P.line("tx", "dave", "second mic-up", { tx: "tx-bbbbbbbbbbbbbbbb" });
  await P.flush();
  P.rows[2].querySelector(".mc-btn").click(); await P.flush(); await P.advance(1200);
  row3.querySelector(".mc-btn").click(); await P.flush();
  poll.resolve({ status: 500, json: { ok: false, error: "HTTP 500" } });
  await P.flush(); await P.flush();
  assert.equal(P.mc.querySelector(".cc-msg").textContent, "🔊 Asking Pepe for that mic-up…");
  assert.equal(P.mc.querySelector(".cc-msg.bad"), null, "no stale error");
  assert.equal(btnText(P.mc, "Close"), undefined);
});

test("strings: every clip string comes from en.json; a translated page gets them through window.__t", () => {
  const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8"));
  const src = fs.readFileSync(path.join(repo, "public/js/chat-clip.js"), "utf8") + fs.readFileSync(path.join(repo, "public/js/clip-confirm.js"), "utf8");
  const keys = [...src.matchAll(/_t\(\s*'(js\.[a-z0-9_.]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 50);
  for (const k of keys) assert.ok(k in EN, k + " in en.json");
  // the English default in the code is the en.json text (singular / plural forms for the counted ones)
  for (const m of src.matchAll(/_t\(\s*'(js\.[a-z0-9_.]+)',\s*'((?:[^'\\]|\\.)*)'/g)) {
    const want = EN[m[1]], d = m[2].replace(/\\'/g, "'");
    if (typeof want === "string") assert.equal(d, want, m[1]);
  }
  const P = makeDom();
  P.ctx.window.__t = (k) => "«" + k + "»";
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/clip-confirm.js"), "utf8"), P.ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/chat-clip.js"), "utf8"), P.ctx);
  const feed = P.doc.createElement("div"), host = P.doc.createElement("div");
  P.doc.body.appendChild(feed); P.doc.body.appendChild(host);
  P.ctx.window.PATVChatClip.init({ feed, host, slug: "x", linked: true });
  assert.equal(host.querySelector(".cc-toggle").textContent, "«js.pad.cc.chat_btn»");
  assert.equal(host.querySelector(".mc-panel").getAttribute("aria-label"), "«js.pad.cc.mic_aria»");
});
