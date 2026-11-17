// test/fixtures/casino-dom.js - the casino pages' browser harness for vm tests (no jsdom): a small DOM built from the real views /
// partials, and page(markup, api, opts) that runs public/js/casino-ui.js on it. Moved here from test/casino-themes-ui.test.js
// (1.99aoj) so test/casino-lobby.test.js shares it. page() opts: sound (also casino-sound.js), pre (scripts evaluated
// before casino-ui.js, e.g. rlbets.js's source with module hidden), hash / search / pathname (location's at load). fetch answers by PATH (the
// query string is dropped: the lobby asks /api/casino/lobby?rl=1; an answer's __status is the response's status); every GET is
// recorded in gets, every POST in posts. The DOM keeps a focus (focus(), document.activeElement - the body once it's removed).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..", "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const partial = (name, locals) => ejs.render(rd("views", "partials", name + ".ejs"), locals, { filename: path.join(repo, "views", "partials", name + ".ejs") });

// ── a small DOM: elements, text, a template's content, compound selectors with descendant / child combinators, bubbling clicks ──
function miniDom() {
  const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "wbr"]);
  const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1))
    : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()]));
  const doc = { listeners: {}, hidden: false };
  // (1.99aoj review) the focus: document.activeElement is the element focus() was last called on while it is in the page,
  // else the body - as a browser does when the focused element is removed (a redraw's innerHTML)
  let focused = null;
  Object.defineProperty(doc, "activeElement", { get: () => (focused && doc.documentElement.contains(focused) ? focused : doc.body), enumerable: true });
  function text(s) { return { nodeType: 3, _t: s, parentNode: null, get textContent() { return this._t; }, set textContent(v) { this._t = String(v); },
                              cloneNode() { return text(this._t); }, remove() { if (this.parentNode) this.parentNode._drop(this); } }; }
  function el(tag) {
    const e = { nodeType: 1, tagName: tag.toUpperCase(), localName: tag.toLowerCase(), attrs: {}, childNodes: [], parentNode: null, listeners: {}, disabled: false,
      get children() { return this.childNodes.filter((c) => c.nodeType === 1); },
      get firstChild() { return this.childNodes[0] || null; },
      get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; },
      get id() { return this.attrs.id || ""; }, set id(v) { this.attrs.id = String(v); },
      get className() { return this.attrs.class || ""; }, set className(v) { this.attrs.class = String(v); },
      get hidden() { return "hidden" in this.attrs; }, set hidden(v) { if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; },
      get type() { return this.attrs.type || ""; }, set type(v) { this.attrs.type = String(v); },
      get title() { return this.attrs.title || ""; }, set title(v) { this.attrs.title = String(v); },
      get textContent() { return this.childNodes.map((c) => c.textContent).join(""); },
      set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (String(v)) this.appendChild(text(String(v))); },
      set innerHTML(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; for (const c of parse(String(v))) this.appendChild(c); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { if (c.parentNode) c.parentNode._drop(c); c.parentNode = this; this.childNodes.push(c); return c; },
      insertBefore(c, ref) { if (c.parentNode) c.parentNode._drop(c); const i = ref ? this.childNodes.indexOf(ref) : -1; c.parentNode = this;
                             if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; },
      _drop(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; },
      remove() { if (this.parentNode) this.parentNode._drop(this); },
      focus(o) { focused = this; this.focusOpts = o || null; }, blur() { if (focused === this) focused = null; },
      contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; },
      cloneNode(deep) { const c = el(this.localName); c.attrs = Object.assign({}, this.attrs); if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true)); return c; },
      addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }, removeEventListener() {},
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) { return select(this, sel); },
      closest(sel) { for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (matches(x, sel)) return x; return null; },
      matches(sel) { return matches(this, sel); },
    };
    e.classList = { contains: (c) => e.className.split(/\s+/).includes(c),
      add(...cs) { const s = e.className.split(/\s+/).filter(Boolean); for (const c of cs) if (!s.includes(c)) s.push(c); e.className = s.join(" "); },
      remove(...cs) { e.className = e.className.split(/\s+/).filter((c) => c && !cs.includes(c)).join(" "); },
      toggle(c, on) { const has = this.contains(c), w = on === undefined ? !has : !!on; if (w) this.add(c); else this.remove(c); return w; },
      [Symbol.iterator]() { return e.className.split(/\s+/).filter(Boolean)[Symbol.iterator](); } };
    e.dataset = new Proxy({}, { get: (o, k) => e.attrs["data-" + String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())],
                                set: (o, k, v) => { e.attrs["data-" + String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())] = String(v); return true; } });
    e.style = { setProperty() {}, removeProperty() {} };
    if (e.localName === "template") e.content = el("#fragment");
    return e;
  }
  function parse(html) {
    const root = el("#root");
    let cur = root;
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[0].startsWith("<!--")) continue;
      if (m[1]) { // close tag
        const name = m[1].toLowerCase();
        for (let x = cur; x && x !== root; x = x._up) if (x.localName === name) { cur = x._up; break; }
        continue;
      }
      if (m[2]) {
        const n = el(m[2]);
        for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) n.attrs[a[1]] = decode(a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : "");
        (cur.localName === "template" ? cur.content : cur).appendChild(n);
        if (!m[4] && !VOID.has(n.localName)) { n._up = cur; cur = n; }
        continue;
      }
      if (m[5] && m[5].trim()) (cur.localName === "template" ? cur.content : cur).appendChild(text(decode(m[5])));
    }
    const out = root.childNodes.slice();
    for (const c of out) c.parentNode = null;
    return out;
  }
  // selectors: compound parts (tag, #id, .class, [attr], [attr="v"], :scope) joined by " " or " > "
  function compound(e, p) {
    if (p === ":scope") return true;
    const m = /^([a-z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(p);
    if (!m) throw new Error("selector " + p);
    if (m[1] && m[1] !== "*" && e.localName !== m[1].toLowerCase()) return false;
    for (const t of m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || []) {
      if (t[0] === "#" && e.id !== t.slice(1)) return false;
      if (t[0] === "." && !e.classList.contains(t.slice(1))) return false;
      if (t[0] === "[") { const [, k, v] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(t); if (!(k in e.attrs) || (v !== undefined && e.attrs[k] !== v)) return false; }
    }
    return true;
  }
  const steps = (sel) => sel.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
  function matches(e, sel, scope) {
    return sel.split(",").some((one) => {
      const s = steps(one);
      const at = (node, i) => {
        if (!compound(node, s[i])) return false;
        if (s[i] === ":scope" && node !== scope) return false;
        if (i === 0) return true;
        if (s[i - 1] === ">") { const p = node.parentNode; return !!p && p.nodeType === 1 && at(p, i - 2); }
        for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) if (at(p, i - 1)) return true;
        return false;
      };
      return at(e, s.length - 1);
    });
  }
  function select(from, sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (matches(c, sel, from)) out.push(c); walk(c); } };
    walk(from);
    return out;
  }
  const html = el("html");
  html.attrs.lang = "en";
  const body = el("body");
  html.appendChild(body);
  Object.assign(doc, {
    documentElement: html, body,
    getElementById: (id) => select(html, "#" + id)[0] || null,
    querySelector: (s) => select(html, s)[0] || null,
    querySelectorAll: (s) => select(html, s),
    createElement: (t) => el(t),
    createTextNode: (s) => text(s),
    addEventListener: (k, fn) => { (doc.listeners[k] = doc.listeners[k] || []).push(fn); },
    removeEventListener() {},
  });
  /** a click on `node`: its listeners, then each ancestor's, then the document's */
  function click(node) {
    const ev = { type: "click", target: node, preventDefault() {}, stopPropagation() {} };
    for (let x = node; x; x = x.parentNode) for (const fn of (x.listeners && x.listeners.click) || []) fn(ev);
    for (const fn of doc.listeners.click || []) fn(ev);
  }
  return { doc, body, parse, click, el };
}

/** casino-ui.js (+ casino-sound.js) on a page built from `markup`; fetch answers from `api` (url -> JSON); posts are recorded */
function page(markup, api, opts) {
  opts = opts || {};
  const D = miniDom();
  for (const n of D.parse(markup)) D.body.appendChild(n);
  const posts = [], gets = [], replaced = [], location = { href: "", hash: opts.hash || "", pathname: opts.pathname || "/casino/blackjack", search: opts.search || "" };
  const history = { state: null, replaceState: (s, t, u) => { replaced.push(u); const h = String(u).indexOf("#"); location.hash = h >= 0 ? String(u).slice(h) : ""; } };
  const fetch = async (url, o) => {
    if (o && o.method === "POST") { const b = JSON.parse(o.body); posts.push({ url, body: b }); return { json: async () => (api.post ? api.post(url, b) : { ok: false }) }; }
    const key = String(url).split("?")[0];          // (1.99aoj: the lobby asks /api/casino/lobby?rl=1)
    gets.push(String(url));
    const j = typeof api[key] === "function" ? api[key]() : api[key];
    return { status: (j && j.__status) || 200, json: async () => j || {} };     // (an answer's __status: e.g. a closed table's 404)
  };
  const store = {}, timers = [];
  const window = { matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
  const ctx = { window, document: D.doc, fetch, location, history, console, setInterval: (fn) => timers.push(fn), clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
                crypto: { randomUUID: () => "00000000-0000-4000-8000-" + String(posts.length).padStart(12, "0") }, navigator: {}, Math, Date, JSON, Number, String, Array, Object, Set, Map, Promise };
  window.document = D.doc;
  window.fetch = fetch;
  window.location = location;
  window.crypto = ctx.crypto;
  vm.createContext(ctx);
  for (const k of Object.keys(window)) if (!(k in ctx)) ctx[k] = window[k];
  ctx.window = window;
  for (const [name, code] of opts.pre || []) vm.runInContext(code, ctx, { filename: name });
  vm.runInContext(rd("public", "js", "casino-ui.js"), ctx, { filename: "casino-ui.js" });
  if (opts.sound) vm.runInContext(rd("public", "js", "casino-sound.js"), ctx, { filename: "casino-sound.js" });
  // poll(): the lobby's 4 s refresh (startLobby's setInterval(lobby, ...)) once
  const poll = async () => { for (const fn of timers.filter((f) => f.name === "lobby")) await fn(); };
  return { D, CZ: window.CZ, window, posts, gets, replaced, location, poll, $: (id) => D.doc.getElementById(id) };
}
const flush = () => new Promise((r) => setImmediate(r));

module.exports = { repo, rd, partial, miniDom, page, flush };
