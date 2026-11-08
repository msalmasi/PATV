// Story Studio: the real browser scripts in a VM. The shared fake DOM is copied from
// story-react-client.test.js; the editor adds recording canvases, local file decoding and the upload wire.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = (f) => fs.readFileSync(path.join(repo, "public", "js", f), "utf8");

// ── a small fake DOM ──
function parseList(sel) {                       // "a, b c" -> [[compound, compound], ...]
  const out = []; let cur = "", depth = 0, q = null;
  for (const ch of sel) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean).map(splitDesc);
}
function splitDesc(s) {
  const parts = []; let cur = "", depth = 0, q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}
function matchCompound(el, c) {
  if (!el || !el.attrs) return false;
  let rest = c;
  const tag = /^([a-zA-Z][\w-]*|\*)/.exec(rest);
  if (tag) { if (tag[1] !== "*" && el.localName !== tag[1].toLowerCase()) return false; rest = rest.slice(tag[0].length); }
  while (rest) {
    let m;
    if ((m = /^#([\w-]+)/.exec(rest))) { if (el.getAttribute("id") !== m[1]) return false; }
    else if ((m = /^\.([\w-]+)/.exec(rest))) { if (!el.classList.contains(m[1])) return false; }
    else if ((m = /^\[([\w-]+)(?:([\^$*]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/.exec(rest))) {
      const v = el.getAttribute(m[1]);
      if (v === null) return false;
      const want = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5];
      if (m[2] === "=" && v !== want) return false;
      if (m[2] === "^=" && !v.startsWith(want)) return false;
    } else if ((m = /^:not\(([^)]*)\)/.exec(rest))) { if (matchCompound(el, m[1])) return false; }
    else throw new Error("unsupported selector part: " + rest);
    rest = rest.slice(m[0].length);
  }
  return true;
}
function matches(el, sel) {
  return parseList(sel).some((parts) => {
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let n = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) { while (n && !matchCompound(n, parts[i])) n = n.parentNode; if (!n) return false; n = n.parentNode; }
    return true;
  });
}
class Ev {
  constructor(type, init) { Object.assign(this, init || {}); this.type = type; this.defaultPrevented = false; this._stop = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
}
class TextNode { constructor(t) { this.data = String(t); this.parentNode = null; } get textContent() { return this.data; } }
const BOOL = { disabled: "disabled", hidden: "hidden", noValidate: "novalidate" };
const STR = { id: "id", type: "type", href: "href", src: "src", alt: "alt", title: "title", autocomplete: "autocomplete", rows: "rows", maxLength: "maxlength", tabIndex: "tabindex" };
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.localName = String(tag).toLowerCase(); this.tagName = this.localName.toUpperCase();
    this.attrs = new Map(); this.childNodes = []; this.parentNode = null; this.listeners = []; this.value = "";
    const self = this;
    const st = {}; st.setProperty = (k, v) => { st[k] = v; }; st.removeProperty = (k) => { delete st[k]; }; this.style = st;
    this.classList = {
      contains: (c) => self.className.split(/\s+/).includes(c),
      add: (...cs) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); cs.forEach((c) => s.add(c)); self.className = [...s].join(" "); },
      remove: (...cs) => { self.className = self.className.split(/\s+/).filter((x) => x && !cs.includes(x)).join(" "); },
      toggle: (c, force) => { const on = force === undefined ? !self.classList.contains(c) : !!force; if (on) self.classList.add(c); else self.classList.remove(c); return on; },
    };
  }
  get className() { return this.attrs.get("class") || ""; }
  set className(v) { this.attrs.set("class", String(v)); }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v != null && v !== "") this.appendChild(new TextNode(v)); }
  set innerHTML(v) {                         // a tiny parser: enough for the viewer's own fixed markup (the sign-in prompt)
    this.textContent = ""; this._html = v;
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(String(v)))) {
      const top = stack[stack.length - 1];
      if (m[4]) { top.appendChild(new TextNode(m[4])); continue; }
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      const e = new El(this.ownerDocument, m[2]);
      for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) e.setAttribute(a[1], a[2]);
      top.appendChild(e);
      if (!/\/$/.test(m[3].trim()) && !/^(img|br|input)$/i.test(m[2])) stack.push(e);
    }
  }
  get innerHTML() { return this._html || ""; }
  get scrollHeight() { return 20; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { if (!ref) return this.appendChild(c); if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  replaceChild(n, old) { this.insertBefore(n, old); this.removeChild(old); return old; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(n) { if (this.parentNode) this.parentNode.replaceChild(n, this); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: opt === true || !!(opt && opt.capture) }); }
  removeEventListener(type, fn, opt) { const cap = opt === true || !!(opt && opt.capture); this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === cap)); }
  dispatchEvent(ev) { return dispatch(this, ev); }
  click() { return dispatch(this, new Ev("click", { bubbles: true, button: 0 })); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  matches(sel) { return matches(this, sel); }
  closest(sel) { let n = this; while (n && n instanceof El) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
  all() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return this.all().filter((e) => matches(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  get offsetParent() {
    if (!this.isConnected) return null;
    for (let n = this; n && n instanceof El; n = n.parentNode) if (n.hasAttribute("hidden") || n.classList.contains("hide")) return null;
    return this.ownerDocument.body;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 500, right: 300, bottom: 500 }; }
}
for (const [p, a] of Object.entries(BOOL)) Object.defineProperty(El.prototype, p, { get() { return this.hasAttribute(a); }, set(v) { if (v) this.setAttribute(a, ""); else this.removeAttribute(a); } });
for (const [p, a] of Object.entries(STR)) Object.defineProperty(El.prototype, p, { get() { return this.getAttribute(a) || ""; }, set(v) { this.setAttribute(a, v); } });
function dispatch(target, ev) {
  ev.target = target;
  const pathUp = []; for (let n = target; n; n = n.parentNode) pathUp.push(n);
  const doc = target.ownerDocument;
  if (target.isConnected) pathUp.push(doc);
  for (const n of pathUp.slice().reverse()) {                       // capture
    if (n === target) break;
    for (const l of (n.listeners || []).filter((x) => x.type === ev.type && x.capture)) { ev.currentTarget = n; l.fn.call(n, ev); if (ev._stop) return !ev.defaultPrevented; }
  }
  for (const n of pathUp) {                                         // target + bubble
    for (const l of (n.listeners || []).filter((x) => x.type === ev.type && (n === target || !x.capture))) { ev.currentTarget = n; l.fn.call(n, ev); }
    if (ev._stop || (n !== target && ev.bubbles === false)) break;
  }
  return !ev.defaultPrevented;
}
function makeDoc(me) {
  const doc = { listeners: [], readyState: "complete", hidden: false };
  doc.createElement = (t) => new El(doc, t);
  doc.createElementNS = (ns, t) => new El(doc, t);
  doc.createTextNode = (t) => new TextNode(t);
  doc.documentElement = new El(doc, "html");
  doc.head = doc.documentElement.appendChild(new El(doc, "head"));
  doc.body = doc.documentElement.appendChild(new El(doc, "body"));
  // like a browser: a focused element that is removed or disabled drops the focus to <body>
  let active = doc.body;
  Object.defineProperty(doc, "activeElement", { configurable: true, get() { return active && active.isConnected && !active.disabled ? active : doc.body; },
                                                set(v) { active = v; } });
  doc.querySelectorAll = (s) => [doc.documentElement].concat(doc.documentElement.all()).filter((e) => matches(e, s));
  doc.querySelector = (s) => doc.querySelectorAll(s)[0] || null;
  doc.getElementById = (id) => doc.querySelector("#" + id);
  doc.addEventListener = (type, fn, opt) => doc.listeners.push({ type, fn, capture: opt === true || !!(opt && opt.capture) });
  doc.removeEventListener = (type, fn, opt) => { const cap = opt === true || !!(opt && opt.capture); doc.listeners = doc.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === cap)); };
  doc.currentScript = null;
  doc._me = me;
  return doc;
}
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** A window running stories.js (+ post-tip.js), with fetch answered by `routes` (method + path -> {status, body}). */
function page({ routes = {}, me = "bob", withTip = true } = {}) {
  const doc = makeDoc(me);
  const calls = [];
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)) });
  const win = {
    document: doc, console, Promise, JSON, Math, Date, Object, Array, String, Number, Error, encodeURIComponent, isFinite, parseInt,
    setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() }, innerHeight: 800, location: { pathname: "/feed", search: "", href: "/feed" },
    localStorage: { _s: {}, getItem(k) { return this._s[k] === undefined ? null : this._s[k]; }, setItem(k, v) { this._s[k] = String(v); } },
    visualViewport: { height: 500, offsetTop: 0, ls: [], addEventListener(t, f) { this.ls.push(f); }, removeEventListener(t, f) { this.ls = this.ls.filter((x) => x !== f); } },
    Image: function () { return doc.createElement("img"); },
    confirm: () => true, crypto: { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2) },
    addEventListener: () => {},
    fetch: async (url, opt) => {
      const method = (opt && opt.method) || "GET";
      calls.push({ method, url, body: opt && opt.body ? JSON.parse(opt.body) : null });
      const h = routes[method + " " + String(url).split("?")[0]] || routes[method + " " + url];
      const r = typeof h === "function" ? h(url, opt) : h;
      return r ? resp(r.status || 200, r.body) : resp(404, { ok: false, error: "nope" });
    },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  if (withTip) { doc.currentScript = { getAttribute: (k) => (k === "data-me" ? me : null) }; vm.runInContext(SRC("post-tip.js"), ctx); }
  doc.currentScript = { getAttribute: (k) => (k === "data-me" ? me : null) };
  vm.runInContext(SRC("stories.js"), ctx);
  doc.currentScript = null;
  return { win, doc, calls };
}
const key = (el, k, extra) => el.dispatchEvent(new Ev("keydown", Object.assign({ key: k, bubbles: true }, extra || {})));
const keyActive = (P, k, extra) => key(P.doc.activeElement, k, extra);      // where a real key press goes: the focused element

const TARGETS = { ok: true, pads: [
  { id: 'u/pixelotter', title: 'Your profile', profile: true, label: 'u/pixelotter', look: { avatar: '/profile.webp', accent: null, ink: null } },
  { id: 'aurora.pad', title: 'Aurora Workshop', href: '/p/aurora-workshop', label: 'p/aurora-workshop', look: { avatar: '/aurora.webp', accent: '#26c6da', ink: '#000000' } },
  { id: 'plain.pad', title: 'Plain Pond', href: '/p/plain-pond', label: 'p/plain-pond', look: null }
], caps: { secs: 30, imageMb: 10, videoMb: 60, srcSecs: 180, srcVideoMb: 100, overlayMb: 2, textsMax: 3, textLen: 120, stickersMax: 10, mentionsMax: 5, studio: true }, as: 'Pixel Otter' };
function studioPage(options = {}) {
  const doc = makeDoc('pixelotter'), calls = [], draws = [], blobs = new Map(), revoked = [], uploaded = [], events = [];
  // ssfix2: timers the test lets run itself (options.hold: their delays), and the window's own listeners (blur/focus/pageshow/pagehide)
  const held = [], winListeners = [];
  let urlN = 0, uploadN = 0, context;
  doc.dispatchEvent = (ev) => { for (const l of doc.listeners.filter((x) => x.type === ev.type)) l.fn(ev); events.push(ev); return !ev.defaultPrevented; };
  doc.fonts = { load: async (...args) => { calls.push({ font: args }); } };
  const normalCreate = doc.createElement;
  doc.createElement = (tag) => {
    const node = normalCreate(tag); node.setPointerCapture = () => {};
    if (tag === 'canvas') {
      const stack = [], ctx = { font: '700 72px Ubuntu', fillStyle: '', save() { stack.push({ font: this.font, fillStyle: this.fillStyle }); }, restore() { Object.assign(this, stack.pop()); },
        clearRect(...a) { draws.push({ canvas: node, op: 'clear', args: a }); }, measureText(t) { return { width: Array.from(t).length * parseFloat(this.font.split(' ')[1]) * .55 }; },
        fillRect(...a) { draws.push({ canvas: node, op: 'rect', args: a }); }, fillText(...a) { draws.push({ canvas: node, op: 'text', args: a, font: this.font, direction: this.direction }); },
        strokeText(...a) { draws.push({ canvas: node, op: 'stroke', args: a }); }, drawImage(...a) { draws.push({ canvas: node, op: 'image', args: a }); },
        // storyux: layers are drawn at their centre, turned (a real 2D context's own transform calls)
        translate(...a) { draws.push({ canvas: node, op: 'translate', args: a }); }, rotate(...a) { draws.push({ canvas: node, op: 'rotate', args: a }); }
      }; node.getContext = () => ctx; node.toBlob = (cb, type) => cb(new Blob(['overlay'], { type }));
    }
    if (tag === 'img' || tag === 'video') {
      Object.defineProperty(node, 'src', { configurable: true, get: () => node.getAttribute('src'), set: (v) => {
        node.setAttribute('src', v); if (!String(v).startsWith('blob:')) return;
        const blob = blobs.get(v), isSource = node.classList.contains('sst-source');
        queueMicrotask(() => { if (isSource && options.decode === false) { node.dispatchEvent(new Ev('error')); return; }
          // storyprev: options.sourceVideo(node, src) loads the editor's <video> the way a test says (true = it did)
          if (isSource && tag === 'video' && options.sourceVideo && options.sourceVideo(node, String(v))) return;
          node.naturalWidth = options.width || 1080; node.naturalHeight = options.height || 1920; node.videoWidth = options.width || 1080; node.videoHeight = options.height || 1920;
          node.duration = options.duration || 42; node.currentTime = 0; node.paused = true;
          if (node.onload) node.onload(); node.dispatchEvent(new Ev(tag === 'video' ? 'loadedmetadata' : 'load')); void blob;
        });
      } }); node.play = () => { node.paused = false; return Promise.resolve(); }; node.pause = () => { node.paused = true; };
    }
    return node;
  };
  const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => body });
  const win = { document: doc, console, Promise, JSON, Math, Date, Object, Array, String, Number, Error, encodeURIComponent, isFinite, parseInt, Intl, Blob,
    getComputedStyle: () => ({ direction: 'ltr' }), innerHeight: 812,
    URL: { createObjectURL: (blob) => { const u = 'blob:local-' + ++urlN; blobs.set(u, blob); return u; }, revokeObjectURL: (u) => { revoked.push(u); blobs.delete(u); } },
    setTimeout: (fn, ms) => { if (ms === 9000) return 0; if (options.hold && options.hold.includes(ms)) { const h = { fn, ms }; held.push(h); return h; } return setImmediate(fn); },
    clearTimeout: (id) => { const i = held.indexOf(id); if (i >= 0) held.splice(i, 1); else if (!(id && id.fn)) clearImmediate(id); },
    requestAnimationFrame: (f) => setImmediate(f), cancelAnimationFrame: (id) => clearImmediate(id),
    addEventListener: (type, fn) => { winListeners.push({ type, fn }); }, removeEventListener: (type, fn) => { const i = winListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1); }, confirm: () => true,
    location: { reload() { throw new Error('must never reload'); }, pathname: options.pathname || '/feed', search: options.search || '', href: (options.pathname || '/feed') + (options.search || '') },
    // ssfix: the tab's session storage (shared between the "before" and "after" page of a reload) and how this page was loaded
    sessionStorage: options.sessionStorage,
    performance: options.navigation ? { getEntriesByType: (t) => t === 'navigation' ? [{ type: options.navigation }] : [] } : undefined,
    CustomEvent: class extends Ev { constructor(type, options) { super(type, options); } },
    Image: function () { return doc.createElement('img'); },
    DOMParser: class { parseFromString() { const root = { nodeName: 'svg', attrs: { viewBox: '0 0 24 24' }, setAttribute(k, v) { this.attrs[k] = v; } }; return { documentElement: root, querySelector: () => null }; } },
    XMLSerializer: class { serializeToString(xml) { return '<svg viewBox="0 0 24 24" width="' + xml.documentElement.attrs.width + '" height="' + xml.documentElement.attrs.height + '"></svg>'; } },
    fetch: async (url, opt = {}) => {
      const method = opt.method || 'GET', body = typeof opt.body === 'string' ? JSON.parse(opt.body) : opt.body;
      calls.push({ url, method, body, headers: opt.headers });
      if (options.fetch) { const answer = await options.fetch(url, opt, { calls, uploaded }); if (answer) return answer; }
      if (url.startsWith('/api/stories/targets')) return response(200, JSON.parse(JSON.stringify(options.targets || TARGETS)));
      if (url === '/api/stickers') return response(200, { packs: [{ id: 'frogs', name: 'Workshop Frogs', owned: true, stickers: [{ id: 'hello', name: 'Hello Frog', url: '/public/stickers/frogs/hello.svg' }] }, { id: 'locked', name: 'Locked', owned: false, stickers: [] }] });
      if (url.startsWith('/public/stickers/')) return response(200, '<svg viewBox="0 0 24 24"></svg>');
      if (url.startsWith('/api/mentions/suggest')) return response(200, { people: [{ username: 'mosswidget', display: 'Moss Widget' }] });
      if (url === '/api/feed/uploads') { const id = (++uploadN).toString(16).padStart(24, '0'); uploaded.push({ id, body }); return response(200, { ok: true, id, chunk: 4 }); }
      if (method === 'PUT') return response(200, { ok: true, received: Number(url.split('offset=')[1]) + opt.body.size });
      if (/\/finish$|\/discard$/.test(url)) return response(200, { ok: true });
      if (/^\/api\/feed\/uploads\//.test(url)) return response(200, { ok: true, state: 'ready' });
      if (url === '/api/stories/mine') return response(200, { ok: true, story: options.story || { id: 'new-story', scope: 'aurora.pad', href: '/media/new-story', circle: { id: 'aurora.pad', title: 'Aurora Workshop' }, item: { id: 'new-story', kind: 'photo', src: '/new.webp' } } });
      return response(404, { ok: false, error: 'missing test route' });
    }
  };
  // storyux verify: a phone's coarse pointer (finger-sized hit boxes), and a visual viewport (pinch-zoomed: scale > 1)
  if (options.coarse != null) win.matchMedia = (q) => ({ matches: /pointer:\s*coarse/.test(q) ? !!options.coarse : false, media: q });
  if (options.visualViewport) win.visualViewport = Object.assign({ ls: [], addEventListener(t, f) { this.ls.push(f); }, removeEventListener(t, f) { this.ls = this.ls.filter((x) => x !== f); } }, options.visualViewport);
  win.window = win; context = vm.createContext(win); vm.runInContext(SRC('story-studio.js'), context);
  const opener = doc.body.appendChild(doc.createElement('button')); opener.setAttribute('data-story-compose', ''); opener.setAttribute('data-pad', options.pad || 'aurora.pad'); opener.focus();
  return { win, doc, calls, draws, blobs, revoked, uploaded, events, opener, context, response, held, winListeners };
}
async function studioOpen(P) { P.opener.click(); await flush(); assert.ok(P.doc.querySelector('.sst')); return P.doc.querySelector('.sst'); }
async function studioPick(P, type = 'image/jpeg', size = 8) { const f = new Blob([new Uint8Array(size)], { type }); f.name = type.startsWith('video') ? 'workshop.mp4' : type === 'image/gif' ? 'workshop.gif' : 'workshop.jpg'; const n = P.doc.querySelector('[data-pick="gallery"]'); n.files = [f]; n.dispatchEvent(new Ev('change')); await flush(); return f; }
async function studioText(P, text = 'Hello, workshop!') { P.doc.querySelector('[data-tool="text"]').click(); const ta = P.doc.querySelector('.sst-text-input'); ta.value = text; ta.dispatchEvent(new Ev('input')); await flush(); return ta; }
function clickText(P, text) { const found = P.doc.querySelectorAll('button').find((n) => n.textContent === text); assert.ok(found, text); found.click(); return found; }

test('Studio: one listener, pad preselection, nested Escape, draft confirmation and focus return', async () => {
  const P = studioPage(); vm.runInContext(SRC('story-studio.js'), P.context);
  assert.equal(P.doc.listeners.filter((l) => l.type === 'click').length, 1);
  const root = await studioOpen(P); assert.equal(root.getAttribute('aria-modal'), 'true'); assert.ok(root.classList.contains('pad-acc'));
  assert.equal(root.style['--pad-accent'], '#26c6da'); assert.match(P.doc.querySelector('.sst-destination').textContent, /Aurora Workshop/);
  await studioPick(P); P.doc.querySelector('[data-tool="mention"]').click();
  const e = new Ev('keydown', { key: 'Escape', bubbles: true }); P.doc.activeElement.dispatchEvent(e); assert.ok(e.defaultPrevented); assert.ok(P.doc.querySelector('.sst')); assert.equal(P.doc.querySelector('.sst-sheet'), null);
  // storyux verify: a draft with edits asks quietly in the editor (never a browser dialog); Escape there keeps editing
  let confirms = 0; P.win.confirm = () => { confirms++; return false; };
  await studioText(P, 'Keep?'); key(P.doc.activeElement, 'Escape'); key(P.doc.activeElement, 'Escape');      // the sheet, then the selection
  key(P.doc.activeElement, 'Escape'); assert.ok(P.doc.querySelector('.sst')); assert.ok(P.doc.querySelector('.sst-ask'), 'asked');
  key(P.doc.activeElement, 'Escape'); assert.ok(P.doc.querySelector('.sst-ask') === null, 'kept'); assert.ok(P.doc.querySelector('.sst'));
  key(P.doc.activeElement, 'Escape'); P.doc.querySelector('.sst-ask .sst-ask-go').click(); await flush();
  assert.equal(P.doc.querySelector('.sst'), null); assert.equal(P.doc.activeElement, P.opener); assert.equal(P.revoked.length, 1); assert.equal(confirms, 0);
});

test('Studio: overlay sheets focus a visible control and return to their tool after Done or Escape', async () => {
  const P = studioPage(), root = await studioOpen(P); await studioPick(P);
  assert.doesNotMatch(P.doc.querySelector('.sst-preview').getAttribute('aria-label'), /\bbelow\b/i);
  const sticker = P.doc.querySelector('[data-tool="sticker"]'); sticker.focus(); sticker.click(); await flush();
  assert.equal(root.getAttribute('data-sheet'), 'sticker'); assert.ok(root.classList.contains('sst-has-sheet'));
  const done = P.doc.querySelector('.sst-sheet-head button'); assert.equal(P.doc.activeElement, done);
  done.click(); assert.equal(root.getAttribute('data-sheet'), null); assert.ok(!root.classList.contains('sst-has-sheet'));
  assert.equal(P.doc.querySelector('.sst-sheet'), null); assert.equal(P.doc.activeElement, sticker);

  sticker.click(); await flush(); assert.equal(P.doc.activeElement, P.doc.querySelector('.sst-sheet-head button'));
  keyActive(P, 'Escape'); assert.equal(P.doc.activeElement, sticker); assert.equal(root.getAttribute('data-sheet'), null);
  const text = P.doc.querySelector('[data-tool="text"]'); text.focus(); text.click();
  const words = P.doc.querySelector('.sst-text-input'); assert.equal(P.doc.activeElement, words); assert.equal(root.getAttribute('data-sheet'), 'text');
  words.value = 'Keep the story canvas in view'; words.dispatchEvent(new Ev('input')); await flush();
  keyActive(P, 'Escape'); assert.equal(P.doc.activeElement, text); assert.equal(root.getAttribute('data-sheet'), null);
  text.click(); assert.equal(P.doc.querySelector('.sst-text-input').value, '');
  assert.ok(P.doc.querySelector('.sst-sheet-body').textContent.includes('Keep the story canvas in view'));
});

test('Studio: mobile editing state follows replacement media and restores the draft after upload cancellation', async () => {
  let release;
  const P = studioPage({ fetch: (url, opt) => opt.method === 'PUT' ? new Promise(resolve => {
    release = () => resolve(P.response(200, { ok: true, received: Number(url.split('offset=')[1]) + opt.body.size }));
  }) : null });
  const root = await studioOpen(P);
  assert.ok(!root.classList.contains('sst-has-media')); assert.ok(!root.classList.contains('sst-video')); assert.ok(!root.classList.contains('sst-busy'));
  await studioPick(P); assert.ok(root.classList.contains('sst-has-media')); assert.ok(!root.classList.contains('sst-video'));
  await studioPick(P, 'video/mp4'); assert.ok(root.classList.contains('sst-video')); assert.equal(root.getAttribute('data-sheet'), 'trim');
  await studioPick(P); assert.ok(root.classList.contains('sst-has-media')); assert.ok(!root.classList.contains('sst-video')); assert.equal(root.getAttribute('data-sheet'), null);
  P.doc.querySelector('.sst-post').click(); await flush(15); assert.equal(typeof release, 'function');
  assert.ok(root.classList.contains('sst-busy')); assert.ok(!P.doc.querySelector('.sst-progress').hidden);
  assert.ok(P.doc.querySelector('[data-tool="text"]').disabled);
  clickText(P, 'Cancel'); await flush(); release(); await flush();
  assert.ok(!root.classList.contains('sst-busy')); assert.ok(root.classList.contains('sst-has-media'));
  assert.ok(P.doc.querySelector('.sst-progress').hidden); assert.ok(!P.doc.querySelector('[data-tool="text"]').disabled);
  assert.equal(P.calls.filter(c => c.url === '/api/stories/mine').length, 0); assert.ok(P.doc.querySelector('.sst-source'));
});

test('Studio: caps are checked before uploads; long video gets clamped trim and native capture remains local', async () => {
  const P = studioPage(); await studioOpen(P);
  const f = { type: 'video/mp4', name: 'large.mp4', size: 101 * 1024 * 1024 };
  const picker = P.doc.querySelector('[data-pick="gallery"]'); picker.files = [f]; picker.dispatchEvent(new Ev('change')); await flush();
  assert.match(P.doc.querySelector('.sst-status').textContent, /100 MB/); assert.equal(P.uploaded.length, 0);
  assert.equal(P.doc.querySelector('[data-pick="camera"]').getAttribute('capture'), 'environment');
  await studioPick(P, 'video/mp4'); assert.ok(P.doc.querySelector('.sst-trim-bar')); assert.match(P.doc.querySelector('.sst-trim-report').textContent, /0:00.*0:30.*30 s/);
  const end = P.doc.querySelector('.sst-trim-end'); end.value = 41; end.dispatchEvent(new Ev('input')); assert.equal(+end.value, 30);
  const start = P.doc.querySelector('.sst-trim-start'); start.value = 30; start.dispatchEvent(new Ev('input')); assert.equal(+start.value, 29);
  end.value = 28; end.dispatchEvent(new Ev('input')); assert.equal(+end.value, 30); assert.equal(P.uploaded.length, 0);
  P.doc.querySelector('.sst-post').click(); await flush(16); assert.deepEqual(P.uploaded[0].body.edit.trim, { start: 29, end: 30 });
});

test('Studio: undecodable files use the explicit legacy path, and GIFs never send edits', async () => {
  for (const gif of [false, true]) {
    const P = studioPage({ decode: gif ? true : false }); await studioOpen(P); await studioPick(P, gif ? 'image/gif' : 'image/jpeg');
    assert.ok(P.doc.querySelector('[data-tool="text"]').disabled);
    if (!gif) { assert.ok(P.doc.querySelector('.sst-post').disabled); clickText(P, 'Post it as it is'); }
    P.doc.querySelector('.sst-post').click(); await flush(16); assert.equal(P.uploaded.length, 1); assert.equal(P.uploaded[0].body.edit, undefined);
  }
});

test('Studio: the shared 1080×1920 overlay draws text/stickers but never mention chips; upload order and event avatar are authoritative', async () => {
  const serverCircle = { id: 'aurora.pad', title: 'Aurora Workshop' }, P = studioPage({ story: { scope: 'aurora.pad', circle: serverCircle, item: { id: 'new' }, href: '/media/new' } }); await studioOpen(P); await studioPick(P); await studioText(P, 'مرحبا 👩‍💻');
  P.doc.querySelector('[data-tool="sticker"]').click(); await flush(); P.doc.querySelector('.sst-sticker').click(); await flush(8);
  P.doc.querySelector('[data-tool="mention"]').click(); const search = P.doc.querySelector('[role="combobox"]'); search.value = '@mo'; search.dispatchEvent(new Ev('input')); await flush();
  assert.ok(P.doc.querySelector('.sst .ds-pop')); assert.equal(P.doc.querySelector('.sst-suggestions').parentNode.parentNode.parentNode.closest('.sst') !== null, true);
  const call = P.calls.find((c) => c.url === '/api/mentions/suggest?q=mo'); assert.equal(call.headers['X-Requested-With'], 'fetch'); key(search, 'ArrowDown'); key(search, 'Enter'); await flush();
  assert.equal(P.doc.querySelector('.sst-mention').textContent, '@mosswidget');
  P.doc.querySelector('.sst-post').click(); await flush(24); assert.equal(P.uploaded.length, 2); assert.equal(P.uploaded[0].body.purpose, 'story_ovl'); assert.equal(P.uploaded[1].body.purpose, 'story');
  const edit = P.uploaded[1].body.edit; assert.equal(edit.overlay, P.uploaded[0].id); assert.deepEqual(edit.text, ['مرحبا 👩‍💻']); assert.deepEqual(edit.stickers, [{ pack: 'frogs', sticker: 'hello' }]); assert.equal(edit.pad, 'aurora.pad'); assert.deepEqual(edit.crop, { x: 0, y: 0, w: 1, h: 1 });
  const mine = P.calls.find((c) => c.url === '/api/stories/mine'); assert.deepEqual(mine.body.mentions, [{ username: 'mosswidget', x: .5, y: .75 }]);
  const exports = P.draws.filter((r) => r.canvas.width === 1080 && r.canvas.height === 1920 && !r.canvas.className);
  assert.ok(exports.some((r) => r.op === 'text' && r.args[0] === 'مرحبا 👩‍💻' && r.direction === 'rtl'));
  const art = exports.find((r) => r.op === 'image'); assert.ok(art.args[0].src.startsWith('blob:')); assert.equal(art.args[3] % 24, 0); assert.equal(art.args[4] % 24, 0); assert.ok(!exports.some((r) => r.op === 'text' && r.args[0].includes('mosswidget')));
  const evt = P.events.find((e) => e.type === 'patv:story-posted'); assert.equal(evt.detail.circle.avatar, '/aurora.webp'); assert.equal(serverCircle.avatar, undefined); assert.notEqual(evt.detail.circle, serverCircle);
  const svgBlob = P.calls.filter((c) => c.url && c.url.startsWith('/public/stickers/')); assert.equal(svgBlob.length, 1); assert.ok(P.calls.some((c) => c.font));
});

test('Studio: an uncertain chunk is resent, processing failure keeps draft and replaces both uploads on Retry', async () => {
  let putFailed = false, failProcessing = true;
  const P = studioPage({ fetch: (url, opt, { uploaded }) => {
    if (opt.method === 'PUT' && !putFailed) { putFailed = true; throw new Error('network lost'); }
    if (opt.method !== 'POST' && /^\/api\/feed\/uploads\/[0-9a-f]+$/.test(url) && uploaded.length === 2 && failProcessing) return P.response(200, { ok: true, state: 'failed', error: 'Try that again.' });
  } }); await studioOpen(P); await studioPick(P); await studioText(P);
  P.doc.querySelector('.sst-post').click(); await flush(25); assert.equal(P.uploaded.length, 2); assert.equal(P.doc.querySelector('.sst-post').textContent, 'Retry'); assert.ok(P.doc.querySelector('.sst-source'));
  const puts = P.calls.filter((c) => c.method === 'PUT'); assert.equal(puts[0].url, puts[1].url); assert.ok(P.calls.filter((c) => /\/discard$/.test(c.url || '')).length >= 2);
  failProcessing = false; P.doc.querySelector('.sst-post').click(); await flush(25); assert.equal(P.uploaded.length, 4); assert.notEqual(P.uploaded[1].body.edit.overlay, P.uploaded[3].body.edit.overlay); assert.equal(P.doc.querySelector('.sst'), null);
});

test('Studio: a final-post refusal retries the ready attachment, while Cancel discards an overlay and pending source', async () => {
  let refuse = true;
  const P = studioPage({ fetch: (url) => url === '/api/stories/mine' && refuse ? P.response(403, { ok: false, error: 'Choose another pad.' }) : null });
  await studioOpen(P); await studioPick(P); P.doc.querySelector('.sst-post').click(); await flush(18); assert.equal(P.uploaded.length, 1); assert.equal(P.doc.querySelector('.sst-post').textContent, 'Retry');
  P.doc.querySelector('.sst-destination').click(); clickText(P, 'Plain Pond'); refuse = false; P.doc.querySelector('.sst-post').click(); await flush(18);
  assert.equal(P.uploaded.length, 1); assert.equal(P.calls.filter((c) => c.url === '/api/stories/mine')[1].body.pad, 'plain.pad');
  let release;
  const Q = studioPage({ fetch: (url, opt, { uploaded }) => uploaded.length === 2 && opt.method === 'PUT' ? new Promise((resolve) => { release = () => resolve(Q.response(200, { ok: true, received: 4 })); }) : null });
  await studioOpen(Q); await studioPick(Q); await studioText(Q); Q.doc.querySelector('.sst-post').click(); await flush(15); assert.equal(Q.uploaded.length, 2);
  clickText(Q, 'Cancel'); await flush(); release(); await flush(); assert.equal(Q.calls.filter((c) => /\/discard$/.test(c.url || '')).length, 2); assert.equal(Q.calls.filter((c) => c.url === '/api/stories/mine').length, 0); assert.ok(!Q.doc.querySelector('.sst-post').disabled);
});

test('Studio: destination accent is strict, profile avatar is round and event decoration follows returned scope', async () => {
  const bad = JSON.parse(JSON.stringify(TARGETS)); bad.pads[2].look = { avatar: '/plain.webp', accent: 'red;background:url(x)', ink: '#000000' };
  const P = studioPage({ targets: bad, story: { scope: 'plain.pad', circle: { id: 'plain.pad' }, item: { id: 'plain' }, href: '/media/plain' } }); const root = await studioOpen(P);
  P.doc.querySelector('.sst-destination').click(); clickText(P, 'Plain Pond'); assert.ok(!root.classList.contains('pad-acc')); assert.equal(root.style['--pad-accent'], undefined);
  P.doc.querySelector('.sst-destination').click(); clickText(P, 'Your profile'); assert.ok(P.doc.querySelector('.sst-avatar').classList.contains('sst-person')); assert.equal(P.doc.querySelector('.sst-rules a'), null);
  await studioPick(P); P.doc.querySelector('.sst-post').click(); await flush(18); const e = P.events.find((e) => e.type === 'patv:story-posted'); assert.equal(e.detail.circle.avatar, '/plain.webp');
});

test('Studio: crop keyboard geometry stays inside source and typing does not move it', async () => {
  const P = studioPage({ width: 1200, height: 1920 }); await studioOpen(P); await studioPick(P);
  const preview = P.doc.querySelector('.sst-preview'); key(preview, '+'); for (let i = 0; i < 120; i++) key(preview, 'ArrowRight', { shiftKey: true });
  await studioText(P, 'A'.repeat(119) + '🎉more'); assert.equal(Array.from(P.doc.querySelector('.sst-text-input').value).length, 120); key(P.doc.querySelector('.sst-text-input'), 'ArrowLeft');
  P.doc.querySelector('.sst-post').click(); await flush(24); const c = P.uploaded[1].body.edit.crop; assert.ok(c.x >= 0 && c.x + c.w <= 1); assert.ok(c.y >= 0 && c.y + c.h <= 1); assert.ok(c.w < .9); assert.equal(c.x, 0);
});

test('Studio: closing after final refusal discards the ready source, and a late allocation is discarded after Cancel', async () => {
  const P = studioPage({ fetch: (url) => url === '/api/stories/mine' ? P.response(403, { ok: false, error: 'Try another pad.' }) : null });
  await studioOpen(P); await studioPick(P); P.doc.querySelector('.sst-post').click(); await flush(18);
  key(P.doc.activeElement, 'Escape'); await flush(); assert.equal(P.doc.querySelector('.sst'), null);
  assert.ok(P.calls.some((c) => c.url === '/api/feed/uploads/' + P.uploaded[0].id + '/discard'));
  let release;
  const Q = studioPage({ fetch: (url) => url === '/api/feed/uploads' ? new Promise((resolve) => { release = () => resolve(Q.response(200, { ok: true, id: 'aaaaaaaaaaaaaaaaaaaaaaaa', chunk: 4 })); }) : null });
  await studioOpen(Q); await studioPick(Q); Q.doc.querySelector('.sst-post').click(); await flush(); clickText(Q, 'Cancel'); release(); await flush();
  assert.ok(Q.calls.some((c) => c.url === '/api/feed/uploads/aaaaaaaaaaaaaaaaaaaaaaaa/discard')); assert.equal(Q.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('Studio: final publication cannot be cancelled mid-commit and its success is always announced', async () => {
  let publish;
  const P = studioPage({ fetch: (url) => url === '/api/stories/mine' ? new Promise((resolve) => { publish = () => resolve(P.response(200, { ok: true, story: { scope: 'aurora.pad', circle: { id: 'aurora.pad' }, item: { id: 'posted' }, href: '/media/posted' } })); }) : null });
  await studioOpen(P); await studioPick(P); P.doc.querySelector('.sst-post').click(); await flush(18);
  const stop = P.doc.querySelector('.sst-progress button'); assert.ok(stop.disabled); const close = P.doc.querySelector('.sst-head button'); assert.ok(close.disabled);
  key(P.doc.activeElement, 'Escape'); assert.ok(P.doc.querySelector('.sst')); assert.equal(P.doc.querySelector('.sst-status').textContent, 'Posting…'); publish(); await flush();
  assert.equal(P.doc.querySelector('.sst'), null); assert.ok(P.events.some((e) => e.type === 'patv:story-posted')); assert.ok(P.doc.querySelector('.ds-toast'));
});

test('Studio: pending sticker decoding blocks Post and counts against the pack layer cap', async () => {
  let decode; const targets = JSON.parse(JSON.stringify(TARGETS)); targets.caps.stickersMax = 1;
  const P = studioPage({ targets, fetch: (url) => url.startsWith('/public/stickers/') ? new Promise((resolve) => { decode = () => resolve(P.response(200, '<svg viewBox="0 0 24 24"></svg>')); }) : null });
  await studioOpen(P); await studioPick(P); P.doc.querySelector('[data-tool="sticker"]').click(); await flush(); P.doc.querySelector('.sst-sticker').click(); await flush();
  assert.ok(P.doc.querySelector('.sst-post').disabled); P.doc.querySelector('[data-tool="sticker"]').click(); await flush(); P.doc.querySelector('.sst-sticker').click(); await flush();
  assert.equal(P.calls.filter((c) => c.url && c.url.startsWith('/public/stickers/')).length, 1); assert.match(P.doc.querySelector('.sst-status').textContent, /up to 1 stickers/);
  decode(); await flush(8); assert.ok(!P.doc.querySelector('.sst-post').disabled); P.doc.querySelector('.sst-post').click(); await flush(20); assert.equal(P.uploaded[1].body.edit.stickers.length, 1);
});

test('Studio: mention Escape closes list before sheet, profile circles retain server avatars and URLs are revoked on replace', async () => {
  const circle = { id: 'user:7', person: true, avatar: '/authoritative.webp' }, P = studioPage({ story: { circle, scope: 'user:7', item: { id: 'person-story' }, href: '/media/person-story' } });
  await studioOpen(P); await studioPick(P); await studioPick(P); assert.equal(P.revoked.length, 1);
  P.doc.querySelector('[data-tool="mention"]').click(); const f = P.doc.querySelector('[role="combobox"]'); f.value = '@mo'; f.dispatchEvent(new Ev('input')); await flush();
  key(f, 'Escape'); assert.ok(P.doc.querySelector('.sst-suggestions').hidden); assert.ok(P.doc.querySelector('.sst-sheet'));
  key(f, 'Escape'); assert.equal(P.doc.querySelector('.sst-sheet'), null); P.doc.querySelector('.sst-post').click(); await flush(18);
  const e = P.events.find((e) => e.type === 'patv:story-posted'); assert.equal(e.detail.circle, circle); assert.equal(e.detail.circle.avatar, '/authoritative.webp');
});

test('Studio: CSS uses scoped ds tokens, shared accent mapping and the server ink palette', () => {
  const css = fs.readFileSync(path.join(repo, 'public/css/story-studio.css'), 'utf8'), js = SRC('story-studio.js');
  assert.doesNotMatch(css, /#[a-f0-9]{3,8}\b|--ds-green|@import/i); assert.doesNotMatch(css, /(?:^|[;{])\s*(?:left|right|margin-left|margin-right|padding-left|padding-right)\s*:/m);
  assert.doesNotMatch(css, /z-index:\s*\d/); assert.doesNotMatch(css, /font-weight:\s*(?!400\b|500\b|700\b)\d+/); for (const m of css.matchAll(/border-radius:([^;}]+)/g)) assert.match(m[1].trim(), /^(?:var\(--ds-r-[\w-]+\)|50\s*%)$/);
  for (const n of css.matchAll(/font-size:\s*([\d.]+)px/g)) assert.ok(+n[1] >= 11);
  assert.match(css, /pointer:\s*coarse/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /background:\s*var\(--ds-media-bg\)/); assert.match(css, /background:\s*var\(--ds-media-chip\)/);
  const mapping = css.match(/\.sst\.pad-acc\s*\{([^}]+)\}/g); assert.equal(mapping.length, 1);
  const props = (s) => Object.fromEntries([...s.matchAll(/(--ds-(?:ac(?:-2|-bg|-line)?|on-ac|focus(?:-ring)?|glow)):\s*([^;]+);/g)].map((m) => [m[1], m[2].replace(/\s+/g, ' ')]));
  const dock = fs.readFileSync(path.join(repo, 'public/css/pad-dock.css'), 'utf8'); const dockRule = [...dock.matchAll(/\{([^{}]+)\}/g)].find((m) => Object.keys(props(m[1])).length === 8); assert.deepEqual(props(mapping[0]), props(dockRule[1]));
  // storyprev: the one localStorage use is reading the opt-in debug flag (patv.storydebug) - drafts never go there
  const debugFlag = "!!window.localStorage && window.localStorage.getItem('patv.storydebug') === '1'";
  assert.equal(js.split(debugFlag).length, 2, 'the debug flag is read once');
  assert.doesNotMatch(js.replace(debugFlag, ''), /localStorage|<svg|location\.reload|DESIGN STUDY|PATV STORY|Make a little scene|state=/);
  const paletteSource = fs.readFileSync(path.join(repo, 'padlook.js'), 'utf8').match(/const PALETTE = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
  const expected = paletteSource.match(/#[a-f0-9]{6}/g).concat(['#ffffff', '#000000']).sort();
  const actual = js.match(/var COLORS = \[([^\]]+)\]/)[1].match(/#[a-f0-9]{6}/g).sort(); assert.deepEqual(actual, expected);
});

test('Studio: animated WebP processing rejection offers a fresh no-edit post with incompatible layers cleared', async () => {
  let animated = true;
  const P = studioPage({ fetch: (url, opt, { uploaded }) => opt.method !== 'POST' && /^\/api\/feed\/uploads\/[0-9a-f]+$/.test(url) && uploaded.length === 2 && animated ? P.response(200, { ok: true, state: 'failed', error: "Animated pictures can't be edited yet - post it as it is." }) : null });
  await studioOpen(P); await studioPick(P, 'image/webp'); await studioText(P); P.doc.querySelector('.sst-post').click(); await flush(24);
  assert.ok(P.doc.querySelector('.sst-recovery')); clickText(P, 'Post it as it is'); assert.ok(P.doc.querySelector('[data-tool="text"]').disabled);
  animated = false; P.doc.querySelector('.sst-post').click(); await flush(20); assert.equal(P.uploaded.length, 3); assert.equal(P.uploaded[2].body.edit, undefined); assert.equal(P.uploaded[2].body.purpose, 'story');
});

test('Studio: unedited landscape mentions use the contained media rectangle and matching drag fractions', async () => {
  const P = studioPage({ width: 1920, height: 1080 }); await studioOpen(P); await studioPick(P, 'image/gif'); P.doc.querySelector('[data-tool="mention"]').click();
  const f = P.doc.querySelector('[role="combobox"]'); f.value = '@mo'; f.dispatchEvent(new Ev('input')); await flush(); key(f, 'ArrowDown'); key(f, 'Enter'); await flush();
  const handles = P.doc.querySelector('.sst-handles'); assert.equal(handles.style.inlineSize, '100%'); assert.equal(handles.style.blockSize, '31.640625%'); assert.equal(handles.style.insetBlockStart, '34.1796875%');
  handles.getBoundingClientRect = () => ({ width: 300, height: 168.75 }); const chip = P.doc.querySelector('.sst-mention');
  chip.dispatchEvent(new Ev('pointerdown', { pointerId: 1, clientX: 150, clientY: 100, button: 0 })); chip.dispatchEvent(new Ev('pointermove', { pointerId: 1, clientX: 180, clientY: 116.875 })); chip.dispatchEvent(new Ev('pointerup', { pointerId: 1 }));
  P.doc.querySelector('.sst-post').click(); await flush(20); const mine = P.calls.find((c) => c.url === '/api/stories/mine'); assert.equal(mine.body.mentions[0].x, .6); assert.equal(mine.body.mentions[0].y, .85); assert.equal(P.uploaded[0].body.edit, undefined);
});

test('Studio: extreme panoramas keep Fit and the source duration cap is exact', async () => {
  const P = studioPage({ width: 4000, height: 200 }); await studioOpen(P); await studioPick(P);
  const fill = P.doc.querySelector('[data-tool="layout"]'); assert.ok(fill.disabled); const preview = P.doc.querySelector('.sst-preview'); key(preview, '+');
  P.doc.querySelector('.sst-post').click(); await flush(20); assert.equal(P.uploaded[0].body.edit.fit, 'fit'); assert.equal(P.uploaded[0].body.edit.crop, undefined);
  const fr = P.uploaded[0].body.edit.frame; assert.ok(fr && fr.w < 1, 'zoomed inside Fit: a frame'); assert.ok(fr.x <= .5 && fr.x + fr.w >= .5);
  const Q = studioPage({ duration: 180.1 }); await studioOpen(Q); await studioPick(Q, 'video/mp4'); assert.ok(Q.doc.querySelector('.sst-post').disabled); assert.match(Q.doc.querySelector('.sst-status').textContent, /180 seconds/);
});

test('Studio: starting Post freezes an already-held layer pointer', async () => {
  let allocate;
  const P = studioPage({ fetch: (url) => url === '/api/feed/uploads' ? new Promise((resolve) => { allocate = () => resolve(P.response(200, { ok: true, id: 'bbbbbbbbbbbbbbbbbbbbbbbb', chunk: 4 })); }) : null });
  await studioOpen(P); await studioPick(P); await studioText(P); key(P.doc.activeElement, 'Escape');
  const layer = P.doc.querySelector('.sst-layer'); layer.dispatchEvent(new Ev('pointerdown', { pointerId: 3, clientX: 150, clientY: 150, button: 0 })); const before = layer.style.insetInlineStart;
  P.doc.querySelector('.sst-post').click(); await flush(); layer.dispatchEvent(new Ev('pointermove', { pointerId: 3, clientX: 250, clientY: 250 })); assert.equal(layer.style.insetInlineStart, before);
  clickText(P, 'Cancel'); allocate(); await flush();
});

// ── ssfix: "camera - picture taken, then nothing happens" (owner, iPhone Chrome = WebKit, 2026-11-07) ──
// iOS hands the page over to the camera; the tab can come back reloaded (the hidden page's process was reclaimed), or the
// hand-off can carry a file without a usable type. Every one of those used to end with the empty "Choose a picture or video"
// screen and no word about what went wrong.
function memoryStorage() { return { _s: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } }; }
function bytesFile(bytes, type, name) { const f = new Blob([new Uint8Array(bytes)], { type }); f.name = name; return f; }
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x18, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08];
const MOV_HEAD = [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0x00, 0x00, 0x00, 0x00, 0x71, 0x74, 0x20, 0x20];
async function cameraHandOff(P, files, event = 'change') { const n = P.doc.querySelector('[data-pick="camera"]'); n.files = files; n.dispatchEvent(new Ev(event)); await flush(10); }
function statusOf(P) { const s = P.doc.querySelector('.sst-status'); return { text: s.textContent, role: s.getAttribute('role'), error: s.classList.contains('sst-error') }; }
const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

test('Studio ssfix: a camera hand-off without a usable type is read by its first bytes and posts as what it is', async () => {
  for (const [type, name] of [['', 'image'], ['application/octet-stream', 'capture'], ['', '']]) {
    const P = studioPage(), root = await studioOpen(P);
    await cameraHandOff(P, [bytesFile(JPEG_HEAD, type, name)]);
    assert.ok(root.classList.contains('sst-has-media'), `type ${JSON.stringify(type)} name ${JSON.stringify(name)}: the picture is in the editor`);
    assert.equal(statusOf(P).error, false); assert.ok(P.doc.querySelector('.sst-source'));
    assert.equal(P.doc.querySelector('.sst-post').disabled, false);
    P.doc.querySelector('.sst-post').click(); await flush(20);
    assert.equal(P.uploaded[0].body.kind, 'image'); assert.equal(P.calls.filter((c) => c.url === '/api/stories/mine').length, 1);
  }
  const Q = studioPage(), root = await studioOpen(Q);
  await cameraHandOff(Q, [bytesFile(MOV_HEAD, '', 'capture')]);
  assert.ok(root.classList.contains('sst-video'), 'a QuickTime/MP4 signature is a video'); assert.equal(statusOf(Q).error, false);
});

test('Studio ssfix: an empty, missing or unusable camera hand-off says so - never the empty prompt again, never "too big"', async () => {
  const cases = [
    ['no file at all', []],
    ['an empty file', [bytesFile([], 'image/jpeg', 'image.jpg')]],
    ['an empty file with no type', [bytesFile([], '', 'image')]],
    ['not a picture or video', [bytesFile(Array.from(Buffer.from('%PDF-1.7\n%stuff')), '', 'document')]],
  ];
  for (const [label, files] of cases) {
    const P = studioPage(), root = await studioOpen(P);
    const prompt = P.doc.querySelector('.sst-empty p').textContent;
    await cameraHandOff(P, files);
    const st = statusOf(P);
    assert.equal(st.role, 'alert', label + ': announced as an error'); assert.ok(st.error, label + ': shown as an error');
    assert.ok(words(st.text).length > 0, label + ': has words');
    assert.notEqual(words(st.text), words(prompt), label + ': not just the empty prompt again');
    assert.doesNotMatch(st.text, /too big/i, label);
    assert.ok(!root.classList.contains('sst-has-media'), label + ': nothing half-picked');
    assert.equal(P.uploaded.length, 0);
  }
});

test('Studio ssfix: a tab reloaded while the camera was open reopens the studio where it was and says the picture did not arrive', async () => {
  const session = memoryStorage();
  const P = studioPage({ sessionStorage: session }); await studioOpen(P);
  P.doc.querySelector('.sst-destination').click(); clickText(P, 'Plain Pond');
  P.doc.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Story options').click();
  const check = P.doc.querySelector('.sst-sheet input[type="checkbox"]'); check.checked = true; check.dispatchEvent(new Ev('change')); clickText(P, 'Done');
  P.doc.querySelector('[data-picker="camera"]').click();
  assert.equal(Object.keys(session._s).length, 1, 'a small note in the tab session while the camera is open');
  assert.doesNotMatch(Object.values(session._s)[0], /blob:|data:/, 'never the media itself');
  // the tab comes back reloaded (iOS reclaimed the hidden page): the same script on a fresh page
  const Q = studioPage({ sessionStorage: session, navigation: 'reload' }); await flush(6);
  const root = Q.doc.querySelector('.sst'); assert.ok(root, 'the studio is open again');
  assert.match(Q.doc.querySelector('.sst-destination').textContent, /Plain Pond/);
  const st = statusOf(Q); assert.equal(st.role, 'alert'); assert.ok(st.error); assert.match(st.text, /reload/i); assert.match(st.text, /camera/i); assert.match(st.text, /Gallery/);
  Q.doc.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Story options').click();
  assert.equal(Q.doc.querySelector('.sst-sheet input[type="checkbox"]').checked, true, 'the NSFW choice is kept');
  assert.equal(Object.keys(session._s).length, 0, 'the note is used once');
  const R = studioPage({ sessionStorage: session, navigation: 'reload' }); await flush(6);
  assert.equal(R.doc.querySelector('.sst'), null, 'a second reload is a normal page');
  // the gallery picker gets its own words
  const G = studioPage({ sessionStorage: session }); await studioOpen(G); G.doc.querySelector('[data-picker="gallery"]').click();
  const H = studioPage({ sessionStorage: session }); await flush(6);
  assert.ok(H.doc.querySelector('.sst')); assert.match(statusOf(H).text, /reload/i); assert.doesNotMatch(statusOf(H).text, /camera/i);
});

test('Studio ssfix: the reload note is only for a picker that never answered, on this page, lately', async () => {
  const reopened = async (prepare, options = {}) => {
    const session = memoryStorage(), P = studioPage({ sessionStorage: session }); await studioOpen(P);
    P.doc.querySelector('[data-picker="camera"]').click(); await prepare(P, session);
    const Q = studioPage(Object.assign({ sessionStorage: session }, options)); await flush(6); return !!Q.doc.querySelector('.sst');
  };
  assert.equal(await reopened(async () => {}), true, 'control: an unanswered camera');
  assert.equal(await reopened(async (P) => { await cameraHandOff(P, [bytesFile(JPEG_HEAD, 'image/jpeg', 'image.jpg')]); }), false, 'the picture arrived');
  assert.equal(await reopened(async (P) => { await cameraHandOff(P, [], 'cancel'); }), false, 'the camera was cancelled');
  assert.equal(await reopened(async (P) => { key(P.doc.activeElement, 'Escape'); }), false, 'the studio was closed');
  assert.equal(await reopened(async (P, session) => { const k = Object.keys(session._s)[0], v = JSON.parse(session._s[k]); v.at -= 11 * 60e3; session._s[k] = JSON.stringify(v); }), false, 'an old note');
  assert.equal(await reopened(async () => {}, { pathname: '/p/another' }), false, 'another page');
  // ssfix2: WebKit (every iPhone browser) brings a page whose process was killed back with WebPageProxy::launchProcessForReload,
  // which loads the current history item as FrameLoadType::IndexedBackForward - so the page sees navigation type 'back_forward'
  assert.equal(await reopened(async () => {}, { navigation: 'back_forward' }), true, 'a killed page comes back as a back/forward load');
  assert.equal(await reopened(async (P, session) => { session._s[Object.keys(session._s)[0]] = '{not json'; }), false, 'a damaged note');
  // storage that throws (private mode, blocked site data) leaves the studio working
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const B = studioPage({ sessionStorage: blocked }); const root = await studioOpen(B); B.doc.querySelector('[data-picker="camera"]').click();
  await cameraHandOff(B, [bytesFile(JPEG_HEAD, 'image/jpeg', 'image.jpg')]); assert.ok(root.classList.contains('sst-has-media'));
});

test('Studio ssfix: the empty state centres its camera icon over the words, and a phone shows errors on an error plate', () => {
  const css = fs.readFileSync(path.join(repo, 'public/css/story-studio.css'), 'utf8');
  // .ds-ic is a fixed 1.25em box: as a grid item it sat at the start of the column the words make (80 px left at 390 px)
  const empty = css.match(/\.sst \.sst-empty \{([^}]*)\}/)[1];
  assert.match(empty, /justify-items:\s*center/);
  const phone = css.slice(css.indexOf('@media (max-width: 760px)'));
  assert.match(phone, /\.sst \.sst-status\.sst-error \{[^}]*background:\s*var\(--ds-danger-bg\)/);
});

// ── ssfix2 (review of ssfix): the picker can come back with no event at all; the note must live through the decode; a killed
// iPhone page comes back as back/forward; a picker with no 'cancel' event must not leave a note behind ──
function fireWin(P, type) { for (const l of P.winListeners.filter((x) => x.type === type)) l.fn(new Ev(type)); }
function setHidden(P, hidden) { P.doc.hidden = hidden; P.doc.visibilityState = hidden ? 'hidden' : 'visible'; P.doc.dispatchEvent(new Ev('visibilitychange')); }
async function later(P) { await flush(2); while (P.held.length) P.held.shift().fn(); await flush(10); }
const BACK_MS = 3000;
function noteCount(session) { return Object.keys(session._s).length; }

test('Studio ssfix2: a page killed while the camera was open comes back as back/forward (WebKit) and the studio still says so', async () => {
  const session = memoryStorage(), P = studioPage({ sessionStorage: session }); await studioOpen(P);
  P.doc.querySelector('.sst-destination').click(); clickText(P, 'Plain Pond');
  P.doc.querySelector('[data-picker="camera"]').click(); setHidden(P, true);           // the camera is in front; then iOS kills the page
  const Q = studioPage({ sessionStorage: session, navigation: 'back_forward' }); await flush(6);
  assert.ok(Q.doc.querySelector('.sst'), 'the studio is open again');
  assert.match(Q.doc.querySelector('.sst-destination').textContent, /Plain Pond/);
  const st = statusOf(Q); assert.equal(st.role, 'alert'); assert.match(st.text, /reload/i); assert.match(st.text, /camera/i);
  assert.equal(noteCount(session), 0, 'used once');
});

test('Studio ssfix2: a camera that comes back with no change and no cancel says so after a short wait', async () => {
  // the page went away for the camera (hidden), came back, and nothing arrived: the words appear only after the grace period
  const session = memoryStorage(), P = studioPage({ sessionStorage: session, hold: [BACK_MS] }), root = await studioOpen(P);
  P.doc.querySelector('[data-picker="camera"]').click(); setHidden(P, true); await flush();
  assert.equal(statusOf(P).error, false, 'nothing said while the camera is in front');
  setHidden(P, false); await flush();
  assert.equal(statusOf(P).error, false, 'not before the grace period: the file can still be on its way');
  await later(P);
  const st = statusOf(P); assert.equal(st.role, 'alert'); assert.ok(st.error); assert.match(st.text, /camera/i); assert.match(st.text, /Gallery/);
  assert.ok(!root.classList.contains('sst-has-media'));
  assert.equal(noteCount(session), 0, 'an answered return drops the note');
  const R = studioPage({ sessionStorage: session, navigation: 'reload' }); await flush(6);
  assert.equal(R.doc.querySelector('.sst'), null, 'a later reload is a normal page');
  // a picture that is late after all still opens, and the words go away
  await cameraHandOff(P, [bytesFile(JPEG_HEAD, 'image/jpeg', 'image.jpg')]);
  assert.ok(root.classList.contains('sst-has-media')); assert.equal(statusOf(P).error, false); assert.equal(statusOf(P).text, '');
  // the listeners leave with the studio
  key(P.doc.activeElement, 'Escape'); assert.equal(P.doc.querySelector('.sst'), null);
  assert.deepEqual(P.winListeners.filter((l) => /^(?:blur|focus|pageshow|pagehide)$/.test(l.type)), []);
  assert.deepEqual(P.doc.listeners.filter((l) => /^(?:visibilitychange|pointerdown)$/.test(l.type)), []);
});

test('Studio ssfix2: a file that arrives within the grace period opens with no false alarm', async () => {
  const session = memoryStorage(), P = studioPage({ sessionStorage: session, hold: [BACK_MS] }), root = await studioOpen(P);
  P.doc.querySelector('[data-picker="camera"]').click(); setHidden(P, true); setHidden(P, false); fireWin(P, 'focus');
  await cameraHandOff(P, [bytesFile(JPEG_HEAD, 'image/jpeg', 'image.jpg')]); await later(P);
  assert.ok(root.classList.contains('sst-has-media')); assert.equal(statusOf(P).error, false); assert.equal(noteCount(session), 0);
});

test('Studio ssfix2: other returns with no answer - a blur/focus dialog, a gallery sheet then a tap, a restored page - say so too', async () => {
  const cases = [
    ['desktop dialog (blur, focus)', 'gallery', (P) => { fireWin(P, 'blur'); fireWin(P, 'focus'); }, /no file/i],
    ['gallery sheet, then a tap on the page', 'gallery', (P) => { P.doc.querySelector('.sst-preview').dispatchEvent(new Ev('pointerdown', { bubbles: true, button: 0, pointerId: 1 })); }, /no file/i],
    ['camera, then a key on the page', 'camera', (P) => { key(P.doc.querySelector('.sst-preview'), 'a'); }, /camera/i],
    ['page hidden, restored from the back/forward cache', 'camera', (P) => { setHidden(P, true); P.doc.hidden = false; P.doc.visibilityState = 'visible'; fireWin(P, 'pageshow'); }, /camera/i],
  ];
  for (const [label, picker, back, words] of cases) {
    const session = memoryStorage(), P = studioPage({ sessionStorage: session, hold: [BACK_MS] }); await studioOpen(P);
    P.doc.querySelector('[data-picker="' + picker + '"]').click(); back(P); await later(P);
    const st = statusOf(P); assert.equal(st.role, 'alert', label); assert.match(st.text, words, label); assert.equal(noteCount(session), 0, label);
  }
  // still away (the camera is in front): nothing is said and the note stays for the reload that may come
  const session = memoryStorage(), P = studioPage({ sessionStorage: session, hold: [BACK_MS] }); await studioOpen(P);
  P.doc.querySelector('[data-picker="camera"]').click(); setHidden(P, true); fireWin(P, 'focus'); await later(P);
  assert.equal(statusOf(P).error, false); assert.equal(noteCount(session), 1);
});

test('Studio ssfix2: the note lives until the picture has opened - the decode is the memory peak - and a reload then says so', async () => {
  const session = memoryStorage(), P = studioPage({ sessionStorage: session }), root = await studioOpen(P);
  P.doc.querySelector('[data-picker="camera"]').click();
  const input = P.doc.querySelector('[data-pick="camera"]'); input.files = [bytesFile(JPEG_HEAD, 'image/jpeg', 'image.jpg')]; input.dispatchEvent(new Ev('change'));
  assert.equal(noteCount(session), 1, 'kept while the picture opens');
  const killed = memoryStorage(); Object.assign(killed._s, session._s);                // the page killed right now
  await flush(10); assert.ok(root.classList.contains('sst-has-media')); assert.equal(noteCount(session), 0, 'dropped once it has opened');
  const Q = studioPage({ sessionStorage: killed, navigation: 'back_forward' }); await flush(6);
  assert.ok(Q.doc.querySelector('.sst'), 'the studio is open again');
  const st = statusOf(Q); assert.equal(st.role, 'alert'); assert.match(st.text, /reload/i); assert.match(st.text, /opening/i); assert.doesNotMatch(st.text, /camera was open/i);
  // a typeless camera file keeps it through the byte check too
  const S2 = memoryStorage(), T = studioPage({ sessionStorage: S2 }); await studioOpen(T); T.doc.querySelector('[data-picker="camera"]').click();
  const ti = T.doc.querySelector('[data-pick="camera"]'); ti.files = [bytesFile(JPEG_HEAD, '', 'image')]; ti.dispatchEvent(new Ev('change'));
  assert.equal(noteCount(S2), 1); await flush(10); assert.equal(noteCount(S2), 0);
  // every refusal or failure drops it at once (nothing is opening any more)
  const refusals = [
    ['an empty file', {}, [bytesFile([], 'image/jpeg', 'image.jpg')]],
    ['too big', {}, [new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'image/jpeg' })]],
    ['not a picture', {}, [bytesFile(Array.from(Buffer.from('%PDF-1.7\n%stuff')), '', 'document')]],
    ['cannot be previewed', { decode: false }, [bytesFile(JPEG_HEAD, 'image/jpeg', 'image.jpg')]],
  ];
  for (const [label, options, files] of refusals) {
    const s = memoryStorage(), R = studioPage(Object.assign({ sessionStorage: s }, options)); await studioOpen(R); R.doc.querySelector('[data-picker="camera"]').click();
    await cameraHandOff(R, files); assert.ok(statusOf(R).error, label); assert.equal(noteCount(s), 0, label);
  }
});

test('Studio ssfix2: with no cancel event (older engines), a picker the user came back from leaves no note behind', async () => {
  // back (focus), then the page is left (pagehide) before the grace period ends: a later Back/reload must not reopen the studio
  const session = memoryStorage(), P = studioPage({ sessionStorage: session, hold: [BACK_MS] }); await studioOpen(P);
  P.doc.querySelector('[data-picker="gallery"]').click(); fireWin(P, 'blur'); fireWin(P, 'focus'); fireWin(P, 'pagehide');
  assert.equal(noteCount(session), 0, 'dropped on leaving');
  const Q = studioPage({ sessionStorage: session, navigation: 'back_forward' }); await flush(6);
  assert.equal(Q.doc.querySelector('.sst'), null, 'no studio, no wrong words');
  // but a page that is unloaded while the camera is still in front keeps it
  const s2 = memoryStorage(), R = studioPage({ sessionStorage: s2, hold: [BACK_MS] }); await studioOpen(R);
  R.doc.querySelector('[data-picker="camera"]').click(); setHidden(R, true); fireWin(R, 'pagehide');
  assert.equal(noteCount(s2), 1);
});



// Story Studio viewer/strip cases: append after the shared VM harness (page, El, Ev, flush, key).
function svEvent(P, type, detail) {
  const ev = new Ev(type, { detail, bubbles: false });
  for (const listener of P.doc.listeners.filter(l => l.type === type)) listener.fn.call(P.doc, ev);
}
function svCircle(id, extra = {}) {
  const item = { id: 'story-' + id, kind: 'photo', src: '/media/' + id + '/raw', page: '/media/' + id, source: 'user',
    by: 'Willow', created: Date.now(), expires: Date.now() + 86400e3, secs: 0, nsfw: false, ...extra.item };
  return { id, title: id, href: '/p/' + id, latest: item.created, count: 1, unseen: true, seen: 0,
    cover: item.src, ...extra, items: extra.items || [item] };
}
function svPost(P, circle, item = circle && circle.items[0]) { svEvent(P, 'patv:story-posted', { circle, item, scope: circle && circle.id }); }
function svStrip(P, { pad = '', scope = '', signed = true, add = true } = {}) {
  const strip = P.doc.createElement('section'); strip.className = 'ss'; strip.setAttribute('data-signed', signed ? '1' : '0');
  if (scope) strip.setAttribute('data-scope', scope);
  const box = P.doc.createElement('div'); box.className = 'ss-scroll'; strip.appendChild(box);
  const row = P.doc.createElement('div'); row.className = 'ss-row'; box.appendChild(row);
  if (add) { const plus = P.doc.createElement('button'); plus.className = 'ss-c ss-add'; plus.setAttribute('data-pad', pad); row.appendChild(plus); }
  P.doc.body.appendChild(strip); return { strip, box, row };
}
function svInline(P, circles) { const data = P.doc.createElement('script'); data.className = 'ss-data'; data.textContent = JSON.stringify(circles); P.doc.body.appendChild(data); }
function svLoadImage(V, w = 1080, h = 1920, box = { width: 375, height: 812 }) {
  V.stage.getBoundingClientRect = () => ({ left: 0, top: 0, ...box });
  const img = V.stage.querySelector('.sv-img'); img.naturalWidth = w; img.naturalHeight = h; img.onload(); return img;
}
const svClose = V => V.x.click();
const svGetCount = P => P.calls.filter(c => c.method === 'GET' && c.url.startsWith('/api/stories')).length;

test('Studio viewer: contain geometry, resize and RTL keep account links on the media pixels; links never advance', async () => {
  const C = svCircle('pond', { item: { alt: 'A small moon', mentions: [{ u: 'moss', d: '<b>Moss</b>', x: 0.2, y: 0.7, mine: true }] } });
  const P = page({ me: 'moss', withTip: false, routes: { 'GET /api/stories': { body: { ok: true, rooms: [C] } } } });
  const observers = [];
  P.win.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  await P.win.patvStories.open(C.id, C.items[0].id, null, C.id);
  const V = P.win.patvStories._state(); P.doc.documentElement.setAttribute('dir', 'rtl');
  svLoadImage(V, 1600, 900);
  let layer = V.stage.querySelector('.sv-mns'), chip = layer.querySelector('.sv-mn');
  assert.equal(layer.style.width, '375px'); assert.equal(layer.style.height, '210.9375px');
  assert.equal(layer.style.left, '0px'); assert.equal(layer.style.top, '300.53125px');
  assert.equal(chip.style.left, '20%'); assert.equal(chip.style.top, '70%');
  assert.equal(chip.href, '/u/moss'); assert.equal(chip.title, '<b>Moss</b>'); assert.equal(chip.textContent, '@moss');
  assert.equal(chip.getAttribute('aria-label'), 'Mentioned: @moss'); assert.equal(chip.querySelector('b'), null);
  assert.equal(V.stage.querySelector('.sv-img').alt, 'Willow’s story: A small moon');
  assert.match(V.live.textContent, /Willow’s story: A small moon/);
  const links = V.frame.querySelectorAll('a[href], button:not([disabled])');
  assert.ok(links.indexOf(chip) > links.indexOf(V.x)); assert.ok(links.indexOf(chip) < links.indexOf(V.foot.querySelector('a')));
  chip.dispatchEvent(new Ev('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 250, clientY: 200 }));
  chip.dispatchEvent(new Ev('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: 250, clientY: 200 }));
  const click = new Ev('click', { bubbles: true, button: 0 }); chip.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false); assert.equal(V.ii, 0); assert.equal(V.held, false);
  V.stage.getBoundingClientRect = () => ({ width: 900, height: 600 }); observers.at(-1).fn();
  assert.equal(layer.style.width, '900px'); assert.equal(layer.style.height, '506.25px'); assert.equal(layer.style.top, '46.875px');
  const old = observers.at(-1); svClose(V); assert.equal(old.disconnected, true);
  old.fn(); assert.equal(V.stage.querySelector('.sv-mns'), null);
});

test('Studio viewer: long names at either edge stay inside the letterboxed image in RTL', async () => {
  const C = svCircle('edges', { item: { mentions: [
    { u: 'a_very_long_moss_account', x: 0.05, y: 0.05 }, { u: 'a_very_long_fern_account', x: 0.95, y: 0.95 }
  ] } });
  const P = page({ withTip: false, routes: { 'GET /api/stories': { body: { ok: true, rooms: [C] } } } });
  const observers = []; P.win.ResizeObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} };
  await P.win.patvStories.open(C.id, C.items[0].id, null, C.id); const V = P.win.patvStories._state();
  P.doc.documentElement.setAttribute('dir', 'rtl'); svLoadImage(V, 1600, 900);
  const links = V.stage.querySelectorAll('.sv-mn');
  links.forEach(link => { Object.defineProperty(link, 'offsetWidth', { value: 240, configurable: true }); Object.defineProperty(link, 'offsetHeight', { value: 44, configurable: true }); });
  observers.at(-1).fn();
  const width = 375, height = 210.9375;
  links.forEach((link, index) => {
    const x = (index ? 0.95 : 0.05) * width + parseFloat(link.style.marginLeft);
    const y = (index ? 0.95 : 0.05) * height + parseFloat(link.style.marginTop);
    assert.ok(x - 120 >= -0.001 && x + 120 <= width + 0.001);
    assert.ok(y - 22 >= -0.001 && y + 22 <= height + 0.001);
    assert.equal(link.style.left, index ? '95%' : '5%'); assert.equal(link.style.top, index ? '95%' : '5%');
  });
});

test('Studio viewer: gate, gone state, portrait geometry, video alt and signed-out items', async () => {
  const C = svCircle('reeds', { item: { nsfw: true, mentions: [{ u: 'fern', x: 0.5, y: 0.5, mine: true }] } });
  const P = page({ me: 'fern', withTip: false, routes: { 'GET /api/stories': { body: { ok: true, rooms: [C] } } } });
  await P.win.patvStories.open(C.id, C.items[0].id, null, C.id);
  const V = P.win.patvStories._state(), image = svLoadImage(V);
  assert.equal(V.stage.querySelector('.sv-mns'), null); assert.equal(V.acts.querySelector('.sv-unmention'), null);
  V.stage.querySelector('.sv-nsfw button').click();
  const layer = V.stage.querySelector('.sv-mns'); assert.ok(layer); assert.equal(layer.style.width, '375px');
  assert.ok(Math.abs(parseFloat(layer.style.height) - 666.6666667) < 0.00001);
  assert.ok(V.acts.querySelector('.sv-unmention'));
  image.onerror(); assert.equal(V.stage.querySelector('.sv-mns'), null); assert.equal(V.acts.querySelector('.sv-unmention'), null);
  svClose(V);
  const A = page({ me: '', withTip: false, routes: { 'GET /api/stories': { body: { ok: true, rooms: [svCircle('anon', { item: { mentions: [{ u: 'fern', x: 0.5, y: 0.5, mine: true }] } })] } } } });
  await A.win.patvStories.open('anon', 'story-anon', null, 'anon'); const AV = A.win.patvStories._state(); svLoadImage(AV);
  assert.equal(AV.stage.querySelector('.sv-mns'), null); assert.equal(AV.acts.querySelector('.sv-unmention'), null);
  if (!El.prototype.play) El.prototype.play = function () { return Promise.resolve(); };
  if (!El.prototype.pause) El.prototype.pause = function () {};
  if (!El.prototype.load) El.prototype.load = function () {};
  const clip = svCircle('video', { item: { kind: 'clip', alt: 'Across the water', mentions: [{ u: 'reed', x: 0.3, y: 0.4 }] } });
  const Q = page({ withTip: false, routes: { 'GET /api/stories': { body: { ok: true, rooms: [clip] } } } });
  await Q.win.patvStories.open(clip.id, clip.items[0].id, null, clip.id); const QV = Q.win.patvStories._state();
  QV.stage.getBoundingClientRect = () => ({ width: 375, height: 812 }); QV.media.videoWidth = 720; QV.media.videoHeight = 1280; QV.media.duration = 12;
  QV.media.dispatchEvent(new Ev('loadedmetadata', { bubbles: false }));
  assert.equal(QV.media.getAttribute('aria-label'), 'Willow’s story: Across the water'); assert.ok(QV.stage.querySelector('.sv-mns'));
  assert.ok(Math.abs(parseFloat(QV.stage.querySelector('.sv-mns').style.height) - 666.6666667) < 0.00001);
});

test('Studio viewer: own mention removal persists through caches and stale reads, keeps other chips and playback, and retries failures', async () => {
  const C = svCircle('lilies', { item: { mentions: [{ u: 'moss', x: 0.4, y: 0.6, mine: true }, { u: 'fern', x: 0.7, y: 0.4 }] } });
  let refused = true;
  const P = page({ me: 'moss', withTip: false, routes: {
    'GET /api/stories': { body: { ok: true, rooms: [C] } },
    'POST /api/stories/story-lilies/unmention': () => refused ? { status: 503, body: { ok: false, error: 'Try again.' } } : { body: { ok: true, removed: false } }
  } });
  await P.win.patvStories.open(C.id, C.items[0].id, null, C.id); let V = P.win.patvStories._state(); svLoadImage(V);
  V.elapsed = 2345; V.paused = true;
  let button = V.acts.querySelector('.sv-unmention'); button.click(); await flush();
  assert.equal(button.disabled, false); assert.equal(V.stage.querySelectorAll('.sv-mn').length, 2);
  refused = false; button.focus(); button.click(); await flush();
  assert.equal(V.stage.querySelectorAll('.sv-mn').length, 1); assert.equal(V.stage.querySelector('.sv-mn').textContent, '@fern');
  assert.equal(V.acts.querySelector('.sv-unmention'), null); assert.equal(V.elapsed, 2345); assert.equal(V.paused, true); assert.equal(V.ii, 0);
  assert.ok(V.root.contains(P.doc.activeElement)); assert.match(V.frame.textContent, /Your mention was removed/);
  assert.equal(P.calls.filter(c => c.url.endsWith('/unmention')).length, 2);
  svClose(V);
  // A newly fetched different scope returns an intentionally stale copy of the same item.
  await P.win.patvStories.open(C.id, C.items[0].id, null, 'other-scope'); V = P.win.patvStories._state(); svLoadImage(V);
  assert.equal(V.stage.querySelectorAll('.sv-mn').length, 1); assert.equal(V.acts.querySelector('.sv-unmention'), null);
});

test('Studio strips: inline hydration, safe new circles, pad-avatar preservation, duplicate updates and no-fetch opening', async () => {
  const P = page({ me: 'moss', withTip: false });
  const global = svStrip(P), other = svCircle('other'); svInline(P, [other]);
  const C = svCircle('pond', { title: '<img onerror=evil()>', avatar: '/media/pad/still.webp', item: { by: '<script>name</script>' } });
  svPost(P, C);
  const button = global.row.querySelector('[data-story-room]'); assert.equal(global.row.children[1], button);
  assert.equal(button.querySelector('.ss-n').textContent, C.title); assert.equal(button.querySelector('script'), null);
  assert.equal(button.querySelector('.ss-pav').src, C.avatar); assert.equal(button.querySelector('.ss-k').textContent, '1');
  assert.equal(button.getAttribute('data-story-item'), C.items[0].id);
  button.click(); await flush(); let V = P.win.patvStories._state(); assert.ok(V.root.isConnected); assert.equal(svGetCount(P), 0);
  assert.equal(V.stage.querySelector('.sv-img').src, C.items[0].src); svClose(V);
  await P.win.patvStories.open(other.id, other.items[0].id, null, ''); assert.equal(svGetCount(P), 0); svClose(P.win.patvStories._state());
  const updated = { ...C, count: 2, latest: C.latest + 1000, items: C.items.concat([{ ...C.items[0], id: 'newer', created: C.latest + 1000 }]) };
  delete updated.avatar; svPost(P, updated, updated.items[1]);
  assert.equal(global.row.querySelectorAll('[data-story-room]').length, 1); assert.equal(button.querySelector('.ss-k').textContent, '2');
  assert.ok(button.classList.contains('unseen')); assert.equal(button.querySelector('.ss-pav').src, C.avatar);
  svPost(P, { ...updated, avatar: null }, updated.items[1]); assert.equal(button.querySelector('.ss-pav'), null); assert.ok(button.querySelector('.ss-mono'));
  const before = global.row.textContent; svPost(P, null); assert.equal(global.row.textContent, before);
});

test('Studio strips: destination restrictions, profile aliases, thumbnails, no-global-cache and scroller refresh', async () => {
  const P = page({ me: 'moss', withTip: false }), globals = svStrip(P), profile = svStrip(P, { pad: 'profile' });
  const ownAlias = svStrip(P, { pad: 'u/moss' }), pad = svStrip(P, { pad: 'pond', scope: 'pond' }), other = svStrip(P, { pad: 'reeds', scope: 'reeds' });
  const signedOut = svStrip(P, { signed: false }), noAdd = svStrip(P, { add: false });
  const C = svCircle('pond', { item: { kind: 'clip', secs: 12.4, poster: '/media/pond/poster' } });
  svPost(P, C);
  assert.equal(profile.row.querySelector('[data-story-room]'), null); assert.equal(ownAlias.row.querySelector('[data-story-room]'), null);
  assert.equal(other.row.querySelector('[data-story-room]'), null); assert.equal(signedOut.row.querySelector('[data-story-room]'), null);
  const thumb = pad.row.querySelector('.ss-t'); assert.ok(thumb.classList.contains('has-p')); assert.equal(thumb.querySelector('.dur').textContent, '▶0:12');
  assert.equal(thumb.href, C.items[0].page); assert.equal(thumb.querySelector('.pst').src, C.items[0].poster); assert.equal(pad.row.children[1], thumb);
  assert.ok(noAdd.row.children[0].hasAttribute('data-story-room')); assert.equal(globals.row.querySelector('[data-story-room]').getAttribute('data-story-scope'), 'pond');
  globals.row.querySelector('[data-story-room]').click(); await flush(); assert.equal(svGetCount(P), 0); svClose(P.win.patvStories._state());
  let refreshed = 0; pad.box.__ssUpdate = () => refreshed++;
  svPost(P, C); assert.equal(pad.row.querySelectorAll('.ss-t').length, 1); assert.ok(refreshed > 0);
  pad.row.querySelector('.pst').dispatchEvent(new Ev('load', { bubbles: false })); assert.ok(refreshed > 1);
  const person = svCircle('user:u_moss', { person: true, user: 'moss', avatar: '/avatar/moss.png' }); svPost(P, person);
  assert.ok(profile.row.querySelector('.ss-person')); assert.ok(ownAlias.row.querySelector('.ss-person'));
  assert.equal(profile.row.querySelector('.ss-person img').src, '/avatar/moss.png');
  const hidden = svCircle('pond', { item: { nsfw: true } }); svPost(P, hidden);
  assert.equal(pad.row.querySelectorAll('.ss-t').length, 1); assert.equal(pad.row.querySelector('img'), null); assert.equal(pad.row.querySelector('.ic').textContent, '🔞');
});

test('Studio lists: an older in-flight load keeps new posts, and active playback survives inserted circles', async () => {
  const P = page({ me: 'moss', withTip: false }); svStrip(P);
  let release;
  P.win.fetch = () => new Promise(resolve => { release = resolve; });
  const other = svCircle('other'), opening = P.win.patvStories.open(other.id, other.items[0].id, null, '');
  const C = svCircle('pond'); svPost(P, C);
  release({ ok: true, status: 200, json: async () => ({ ok: true, rooms: [other] }) }); await opening;
  const V = P.win.patvStories._state(); assert.equal(V.room.textContent, 'other'); svLoadImage(V); V.elapsed = 3210; V.paused = true;
  const beforeImage = V.stage.querySelector('.sv-img');
  const next = svCircle('harbor'); svPost(P, next);
  assert.equal(V.room.textContent, 'other'); assert.equal(V.stage.querySelector('.sv-img'), beforeImage); assert.equal(V.elapsed, 3210); assert.equal(V.paused, true);
  // Late image events use item identity rather than indices that changed when a circle was prepended.
  beforeImage.onload(); assert.equal(V.waiting, false);
  // Avoid an unrelated seen POST in the test's controlled network.
  P.win.fetch = async () => { throw new Error('unexpected fetch'); };
  svClose(V);
  assert.equal(await P.win.patvStories.open(C.id, C.items[0].id, null, ''), true); svClose(P.win.patvStories._state());
  assert.equal(await P.win.patvStories.open(next.id, next.items[0].id, null, ''), true);
});


// Story Studio loading and all viewer entry points, including the lazy DM loader.
test("Studio strip loads only the selected composer and every viewer entry uses the current assets", () => {
  const ejs = require("ejs");
  const stripFile = path.join(repo, "views/partials/story-strip.ejs");
  const stripSource = fs.readFileSync(stripFile, "utf8");
  const locals = { story: { signed: true, compose: true, rooms: [], caps: [], room: "studio-test-pad" }, user: "maplecanvas" };
  const render = extra => ejs.render(stripSource, Object.assign({}, locals, extra), { filename: stripFile });
  for (const extra of [{}, { storyStudioOn: () => false }]) {
    const html = render(extra);
    assert.match(html, /story-compose\.js\?v=1/);
    assert.doesNotMatch(html, /story-studio\.(?:js|css)/);
  }
  const html = render({ storyStudioOn: () => true });
  assert.match(html, /story-studio\.js\?v=7/);    // ssfix (v=3): the camera hand-off + the empty state's icon; story camera (v=4): the live camera hook; storyfix2 (v=5): camera clips + first frame; storyprev (v=6): the bounded wait, the camera's poster, ?storydebug=1; storyux (v=7): direct manipulation
  assert.match(html, /story-studio\.css\?v=4/);
  assert.doesNotMatch(html, /story-compose\.js/);
  assert.match(html, /data-story-compose data-pad="studio-test-pad"/);
  const signedOut = render({ story: { signed: false, compose: true, rooms: [], caps: [] }, storyStudioOn: () => true });
  assert.doesNotMatch(signedOut, /story-(?:studio|compose)\.(?:js|css)/);
  const files = [];
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) walk(file); else if (/\.(?:ejs|js)$/.test(e.name)) files.push(file); } }
  walk(path.join(repo, "views")); walk(path.join(repo, "public/js"));
  let jsPins = 0, cssPins = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/\/public\/(js|css)\/stories\.(js|css)\?v=(\d+)/g)) {
      assert.equal(m[3], m[2] === "js" ? "13" : "9", file);
      if (m[2] === "js") jsPins++; else cssPins++;
    }
  }
  assert.equal(jsPins, 4); assert.equal(cssPins, 5);
  assert.match(fs.readFileSync(path.join(repo, "views/messages.ejs"), "utf8"), /messages\.js\?v=14/);
});

// ── storyprev (1.99??): a <video> with no size at 'loadedmetadata' is waited for ('resize' / 'loadeddata' / 'canplay', WAIT_MS),
//    a refused media fragment gets one plain try, and a gallery video this browser can't show keeps "Post it as it is" in
//    kinder words; ?storydebug=1 shows what the browser made of it (story-camera.test.js has the camera's poster) ──
const WAIT_MS = 4000;
test('Studio storyprev: a gallery video with no size at loadedmetadata is not refused at once - canplay brings it; nothing in the wait gets the kinder recovery', async () => {
  let video = null;
  const P = studioPage({ hold: [WAIT_MS], sourceVideo: (node) => { video = node; node.videoWidth = 0; node.videoHeight = 0; node.duration = 8; node.dispatchEvent(new Ev('loadedmetadata')); return true; } });
  const root = await studioOpen(P); await studioPick(P, 'video/mp4'); await flush(4);
  assert.equal(P.doc.querySelector('.sst-status').textContent, '', 'no failure at loadedmetadata'); assert.ok(P.doc.querySelector('.sst-recovery').hidden);
  assert.equal(P.held.filter((h) => h.ms === WAIT_MS).length, 1, 'one bounded wait');
  video.videoWidth = 1080; video.videoHeight = 1920; video.dispatchEvent(new Ev('canplay')); await flush(4);
  assert.equal(P.held.filter((h) => h.ms === WAIT_MS).length, 0, 'the wait is over'); assert.ok(!P.doc.querySelector('.sst-post').disabled); assert.ok(!P.doc.querySelector('[data-tool="crop"]').disabled);
  assert.ok(root.classList.contains('sst-video'));
  // nothing within the wait: the recovery - it will still post
  const Q = studioPage({ hold: [WAIT_MS], sourceVideo: (node) => { node.videoWidth = 0; node.videoHeight = 0; node.duration = 8; node.dispatchEvent(new Ev('loadedmetadata')); return true; } });
  await studioOpen(Q); await studioPick(Q, 'video/mp4'); await flush(4);
  const wait = Q.held.find((h) => h.ms === WAIT_MS); assert.ok(wait); wait.fn(); await flush(4);
  const st = Q.doc.querySelector('.sst-status'); assert.match(st.textContent, /This browser can't preview this video here, but it will still post\. Post it as it is \(up to 30 seconds\), or pick another\./);
  assert.ok(!Q.doc.querySelector('.sst-recovery').hidden); clickText(Q, 'Post it as it is');
  Q.doc.querySelector('.sst-post').click(); await flush(16); assert.equal(Q.uploaded.length, 1); assert.equal(Q.uploaded[0].body.edit, undefined);
  // a phone says phone
  const R = studioPage({ decode: false }); R.win.matchMedia = (q) => ({ matches: /pointer:\s*coarse/.test(q), media: q });
  await studioOpen(R); await studioPick(R, 'video/mp4'); await flush(6);
  assert.match(R.doc.querySelector('.sst-status').textContent, /^Your phone can't preview this video here, but it will still post\./);
  // a picture keeps its own words
  const S = studioPage({ decode: false }); await studioOpen(S); await studioPick(S, 'image/jpeg'); await flush(4);
  assert.match(S.doc.querySelector('.sst-status').textContent, /cannot preview that file/);
});

test('Studio storyprev: a refused media fragment is tried once without it; the debug read-out is off unless ?storydebug=1', async () => {
  const srcs = [];
  const P = studioPage({ sourceVideo: (node, src) => { srcs.push(src); if (/#t=/.test(src)) { node.error = { code: 4, message: 'unsupported' }; node.dispatchEvent(new Ev('error')); return true; } return false; } });
  await studioOpen(P); await studioPick(P, 'video/mp4'); await flush(6);
  assert.equal(srcs.length, 2); assert.match(srcs[0], /#t=0\.001$/); assert.doesNotMatch(srcs[1], /#/);
  assert.ok(P.doc.querySelector('.sst-recovery').hidden); assert.equal(P.doc.querySelector('[data-tool="trim"]').disabled, false);
  assert.equal(P.doc.querySelector('.sst-debug'), null, 'off by default');
  const Q = studioPage({ search: '?storydebug=1' }); await studioOpen(Q); await studioPick(Q, 'video/mp4'); await flush(6);
  const box = Q.doc.querySelector('.sst-preview .sst-debug'); assert.ok(box);
  assert.match(box.textContent, /workshop\.mp4/); assert.match(box.textContent, /gallery/); assert.match(box.textContent, /1080×1920/); assert.match(box.textContent, /loadedmetadata \+\d+ ms/);
  assert.ok(!Q.calls.some((c) => /debug/i.test(String(c.url))), 'no network');
  await studioPick(Q, 'image/jpeg'); assert.equal(Q.doc.querySelectorAll('.sst-debug').length, 1, 'one read-out, for the current pick'); assert.match(Q.doc.querySelector('.sst-debug').textContent, /image\/jpeg/);
});

// ── storyux (1.99??): the owner (iPhone, iOS 26, Chrome = WebKit; 2026-11-08): "can we just interact with the objects to place and size
//    them? Like drag to move or pinch to shrink. Having sliders for horizontal and vertical position or rotation or size is very
//    janky. Same with the content itself... zoom in or out on it with normal gestures." + "we shouldn't show the gallery button and
//    camera button after a photo is selected/taken. Just an 'x' to go back to the camera screen." + "the other buttons can be
//    circles without labels" ──
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
// (DOM nodes are compared with assert.ok(a === b): a failing assert.equal on a fake node makes the reporter walk the whole VM graph)
const geometry = () => studioPage().win.patvStoryStudio.geometry;
/** A pointer event (touch unless said otherwise); captured pointers' moves and ups go to the stage, as in a browser. */
function ptr(node, type, id, x, y, extra) { const e = new Ev(type, Object.assign({ bubbles: true, pointerId: id, clientX: x, clientY: y, button: 0, buttons: 1, pointerType: 'touch', isPrimary: id === 1 }, extra || {})); node.dispatchEvent(e); return e; }
const stage = (P) => P.doc.querySelector('.sst-preview');
const layerEl = (P, kind) => P.doc.querySelector('.sst-layer[data-layer^="' + kind + '-"]');
const liveOps = (P, op) => P.draws.filter((r) => r.canvas.className === 'sst-overlay' && r.op === op);
async function studioSticker(P) { P.doc.querySelector('[data-tool="sticker"]').click(); await flush(); P.doc.querySelector('.sst-sticker').click(); await flush(8); return layerEl(P, 'sticker'); }
async function drag(P, node, from, to, id = 1, extra) { ptr(node, 'pointerdown', id, from[0], from[1], extra); await flush(); ptr(stage(P), 'pointermove', id, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, extra); await flush(); ptr(stage(P), 'pointermove', id, to[0], to[1], extra); await flush(); ptr(stage(P), 'pointerup', id, to[0], to[1], extra); await flush(6); }
async function tapAt(P, node, x = 150, y = 250, id = 1) { ptr(node, 'pointerdown', id, x, y); ptr(stage(P), 'pointerup', id, x, y); await flush(6); }

test('Studio storyux: gesture math - two fingers give scale, twist and the midpoint move; layers stay in the frame, snap to its centre and turn square', () => {
  const G = geometry();
  const m = G.twoFinger({ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 130, y: 65 }, { x: 130, y: 265 });
  assert.ok(near(m.scale, 2)); assert.ok(near(m.turn, Math.PI / 2)); assert.ok(near(m.dx, -20)); assert.ok(near(m.dy, 65));
  const frame = { width: 300, height: 500 };
  const st = { type: 'sticker', x: .5, y: .5, size: 240, rot: 0 }, start = { x: .5, y: .5, size: 240, rot: 0 };
  G.moveItem(st, start, m, frame, { snap: true });
  assert.ok(near(st.x, .5 - 20 / 300)); assert.ok(near(st.y, .5 + 65 / 500)); assert.equal(st.size, 480); assert.ok(near(st.rot, Math.PI / 2));
  // a drag alone moves, and never changes the size or the turn
  const one = { type: 'sticker', x: .3, y: .3, size: 300, rot: .4 };
  G.moveItem(one, { x: .3, y: .3, size: 300, rot: .4 }, { dx: 30, dy: -50 }, frame, { snap: true });
  assert.ok(near(one.x, .4)); assert.ok(near(one.y, .2)); assert.equal(one.size, 300); assert.ok(near(one.rot, .4));
  // a pinch and twist alone keep the place
  const two = { type: 'text', x: .3, y: .7, size: 72, rot: 0, bounds: { w: 300, h: 110 } };
  G.moveItem(two, { x: .3, y: .7, size: 72, rot: 0 }, { scale: 1.5, turn: .3 }, frame, { snap: true });
  assert.ok(near(two.x, .3)); assert.ok(near(two.y, .7)); assert.ok(near(two.size, 108)); assert.ok(near(two.rot, .3));
  // size limits: text 24..288 px, stickers 48..960 px (drawn in steps of 24 for crisp pixel art)
  const big = { type: 'text', x: .5, y: .5, size: 72, rot: 0 }; G.moveItem(big, { x: .5, y: .5, size: 72, rot: 0 }, { scale: 10 }, frame); assert.equal(big.size, 288);
  const tiny = { type: 'sticker', x: .5, y: .5, size: 240, rot: 0 }; G.moveItem(tiny, { x: .5, y: .5, size: 240, rot: 0 }, { scale: .01 }, frame); assert.equal(tiny.size, 48);
  assert.equal(G.stickerPx(250), 240); assert.equal(G.stickerPx(262), 264); assert.equal(G.stickerPx(5000), 960);
  // inside the frame: the turned layer's own box (a tall turned text can go nearer the side than an upright one)
  const edge = { type: 'sticker', x: .99, y: .01, size: 240, rot: 0 }; G.keepIn(edge);
  assert.ok(near(edge.x, 1 - 120 / 1080)); assert.ok(near(edge.y, 120 / 1920));
  const tall = { type: 'text', x: .99, y: .99, size: 72, rot: Math.PI / 2, bounds: { w: 800, h: 100 } }; G.keepIn(tall);
  assert.ok(near(tall.x, 1 - 50 / 1080)); assert.ok(near(tall.y, 1 - 400 / 1920));
  const flat = { type: 'text', x: .99, y: .5, size: 72, rot: 0, bounds: { w: 800, h: 100 } }; G.keepIn(flat); assert.ok(near(flat.x, 1 - 400 / 1080));
  const huge = { type: 'sticker', x: .9, y: .1, size: 960, rot: Math.PI / 4 }; G.keepIn(huge); assert.ok(near(huge.x, .5), 'wider than the frame turned: centred');
  // snapping: near the centre lines it sticks there and says which guide to show; a turn near square snaps square
  const s1 = { type: 'sticker', x: .51, y: .3, size: 240, rot: 0 }; let g = G.moveItem(s1, { x: .51, y: .3, size: 240, rot: 0 }, { dx: 0, dy: 0 }, frame, { snap: true });
  assert.equal(s1.x, .5); assert.ok(g.v); assert.ok(!g.h);
  const s2 = { type: 'sticker', x: .3, y: .5, size: 240, rot: 0 }; g = G.moveItem(s2, { x: .3, y: .5, size: 240, rot: 0 }, { dx: 0, dy: 3 }, frame, { snap: true });
  assert.equal(s2.y, .5); assert.ok(g.h); assert.ok(!g.v);
  const s3 = { type: 'sticker', x: .3, y: .3, size: 240, rot: 0 }; G.moveItem(s3, { x: .3, y: .3, size: 240, rot: 0 }, { dx: 30 }, frame, { snap: true }); assert.ok(near(s3.x, .4), 'away from the centre: no pull');
  const s4 = { type: 'sticker', x: .3, y: .3, size: 240, rot: 0 }; g = G.moveItem(s4, { x: .3, y: .3, size: 240, rot: 0 }, { turn: Math.PI / 2 + .04 }, frame, { snap: true }); assert.ok(near(s4.rot, Math.PI / 2)); assert.ok(g.turn);
  const s5 = { type: 'sticker', x: .3, y: .3, size: 240, rot: 0 }; G.moveItem(s5, { x: .3, y: .3, size: 240, rot: 0 }, { turn: .3 }, frame, { snap: true }); assert.ok(near(s5.rot, .3));
  const s6 = { type: 'sticker', x: .51, y: .3, size: 240, rot: 0 }; G.moveItem(s6, { x: .51, y: .3, size: 240, rot: 0 }, { dx: 0 }, frame); assert.equal(s6.x, .51, 'no snapping unless asked (the keyboard steps through the centre)');
  // a mention is a chip: it moves, never scales or turns, and stays 5% in from the edges
  const mn = { type: 'mention', x: .5, y: .5 }; G.moveItem(mn, { x: .5, y: .5 }, { dx: 1000, dy: 0, scale: 3, turn: 1 }, frame);
  assert.equal(mn.x, .95); assert.equal(mn.size, undefined); assert.equal(mn.rot, undefined);
});

test('Studio storyux: base picture math - pinch zooms about the fingers, drag pans; Fill never shows empty space, Fit may, within limits', () => {
  const G = geometry(), own = 4000 / 3000, cover = G.cover(own), contain = G.contain(own);
  assert.ok(near(cover.w, .421875)); assert.equal(cover.h, 1); assert.ok(near(cover.x, .2890625)); assert.equal(cover.y, 0);
  assert.equal(contain.w, 1); assert.ok(near(contain.h, own / (9 / 16))); assert.ok(near(contain.y, (1 - contain.h) / 2));
  // the picture point under the fingers stays under them (the fingers moved too: the picture follows)
  const f0 = { x: .3, y: .25 }, f1 = { x: .35, y: .3 }, r0 = G.rect(cover), u = (f0.x - r0.x) / r0.w, v = (f0.y - r0.y) / r0.h;
  const z = G.zoom(cover, own, 'fill', 2, f0, f1), r1 = G.rect(z);
  assert.ok(near(z.w, cover.w / 2)); assert.ok(near(r1.x + u * r1.w, f1.x)); assert.ok(near(r1.y + v * r1.h, f1.y));
  assert.ok(near(z.w * 4000 / (z.h * 3000), 9 / 16), 'still the 9:16 shape');
  // Fill: dragged far right, the picture's left edge stops at the frame's; zoomed out, it stops at cover; zoomed in, 8x
  const right = G.pan(z, own, 'fill', 5, 0), rr = G.rect(right); assert.equal(right.x, 0); assert.ok(rr.x <= 1e-9 && rr.x + rr.w >= 1 - 1e-9);
  const down = G.pan(z, own, 'fill', 0, -5); assert.ok(near(down.y, 1 - down.h));
  const out = G.zoom(z, own, 'fill', .1, { x: .5, y: .5 }, { x: .5, y: .5 }); assert.ok(near(out.w, cover.w)); assert.ok(out.x >= 0 && out.x + out.w <= 1 + 1e-9);
  const deep = G.zoom(cover, own, 'fill', 100, { x: .5, y: .5 }, { x: .5, y: .5 }); assert.ok(near(deep.w, cover.w / 8));
  // Fit: smaller than the whole picture (down to half), never pushed past the frame's centre lines
  const small = G.zoom(contain, own, 'fit', .1, { x: .5, y: .5 }, { x: .5, y: .5 }); assert.ok(near(small.w, 2)); assert.ok(near(G.rect(small).w, .5));
  const away = G.pan(small, own, 'fit', 3, 3), ra = G.rect(away); assert.ok(near(ra.x + ra.w / 2, 1)); assert.ok(near(ra.y + ra.h / 2, 1), 'the picture\'s centre stays in the frame');
  const back = G.pan(small, own, 'fit', -3, -3), rb = G.rect(back); assert.ok(near(rb.x + rb.w / 2, 0)); assert.ok(near(rb.y + rb.h / 2, 0));
  const fitIn = G.zoom(contain, own, 'fit', 100, { x: .5, y: .5 }, { x: .5, y: .5 }); assert.ok(near(fitIn.w, cover.w / 8), 'the same deepest zoom as Fill');
  // Fit -> Fill and back (the layout toggle): cover around the same centre, then the whole picture
  const filled = G.place(G.layout(away, own, 'fill'), own, 'fill'); assert.ok(near(filled.w, cover.w)); assert.ok(filled.x >= 0 && filled.x + filled.w <= 1 + 1e-9);
  const whole = G.layout(filled, own, 'fit'); assert.ok(near(whole.w, contain.w) && near(whole.x, contain.x) && near(whole.y, contain.y));
  // a 20:1 panorama can't fill (a crop under 5% of it), and its Fit limits still hold together
  assert.equal(G.canFill(4000 / 200), false); assert.equal(G.canFill(own), true);
  const pano = G.contain(20), pz = G.zoom(pano, 20, 'fit', 3, { x: .5, y: .5 }, { x: .5, y: .5 }); assert.ok(pz.w >= .05 - 1e-9 && pz.h >= .05);
});

test('Studio storyux: tap selects a layer (an outline and a delete handle); one finger drags it; two fingers pinch and twist it - drawn where its handle is', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P);
  const sticker = await studioSticker(P); assert.ok(sticker, 'the sticker has its handle on the picture');
  assert.ok(P.doc.querySelector('.sst-sheet') === null, 'adding a sticker closes the picker: it is placed on the picture, not with sliders');
  const sel = P.doc.querySelector('.sst-select'); assert.ok(sel && !sel.hidden, 'a new sticker is selected');
  const del = sel.querySelector('.sst-sel-del'); assert.equal(del.getAttribute('aria-label'), 'Delete layer'); assert.equal(del.title, 'Delete layer');
  await tapAt(P, stage(P), 20, 20); assert.ok(P.doc.querySelector('.sst-select').hidden, 'a tap on the picture lets go of it');
  await tapAt(P, sticker, 150, 250); assert.ok(!P.doc.querySelector('.sst-select').hidden, 'a tap on it selects it'); assert.ok(sticker.classList.contains('selected'));
  // one finger: 60 px right, 50 px down on a 300 x 500 frame = +20% and +10%
  await drag(P, sticker, [150, 250], [210, 300]);
  assert.ok(near(parseFloat(sticker.style.insetInlineStart), 70)); assert.ok(near(parseFloat(sticker.style.insetBlockStart), 60));
  let at = liveOps(P, 'translate').at(-1), img = liveOps(P, 'image').at(-1);
  assert.deepEqual(at.args, [756, 1152], 'drawn at the same place as its handle (canvas px)'); assert.deepEqual(img.args.slice(1), [-120, -120, 240, 240]);
  // two fingers: the first on the sticker, the second beside it; turned a quarter, then spread to twice the distance
  ptr(sticker, 'pointerdown', 1, 210, 300); ptr(stage(P), 'pointerdown', 2, 260, 300, { isPrimary: false }); await flush();
  ptr(stage(P), 'pointermove', 2, 210, 350, { isPrimary: false }); await flush();
  ptr(stage(P), 'pointermove', 2, 210, 400, { isPrimary: false }); await flush();
  ptr(stage(P), 'pointerup', 2, 210, 400, { isPrimary: false }); ptr(stage(P), 'pointerup', 1, 210, 300); await flush(6);
  const rot = liveOps(P, 'rotate').at(-1); assert.ok(rot && near(rot.args[0], Math.PI / 2), 'turned a quarter');
  img = liveOps(P, 'image').at(-1); assert.deepEqual(img.args.slice(1), [-240, -240, 480, 480], 'twice the size');
  assert.match(sticker.style.transform, /rotate\(1\.5707\d*rad\)/); assert.equal(sticker.style.inlineSize, 480 / 1080 * 100 + '%');
  // the midpoint moved 25 px left and 50 px down: the sticker with it
  at = liveOps(P, 'translate').at(-1); assert.deepEqual(at.args, [Math.round((.7 - 25 / 300) * 1080), Math.round((.6 + 50 / 500) * 1920)]);
  // the delete handle removes it
  P.doc.querySelector('.sst-sel-del').click(); await flush(4);
  assert.ok(layerEl(P, 'sticker') === null); assert.ok(P.doc.querySelector('.sst-select').hidden);
  P.doc.querySelector('.sst-post').click(); await flush(20); assert.deepEqual(P.uploaded.at(-1).body.edit.stickers, []);
});

test('Studio storyux: double-tap a text to edit its words; the keyboard moves (arrows), sizes (+ −), turns ([ ]) and deletes a focused layer', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P); await studioText(P, 'Hello pond');
  key(P.doc.activeElement, 'Escape'); assert.ok(P.doc.querySelector('.sst-sheet') === null);
  const text = layerEl(P, 'text'); assert.ok(text);
  await tapAt(P, text, 150, 150); await tapAt(P, text, 150, 150);
  const words = P.doc.querySelector('.sst-text-input'); assert.ok(words, 'a double tap opens the words'); assert.equal(words.value, 'Hello pond');
  assert.equal(P.doc.querySelectorAll('.sst-sheet input[type="range"]').length, 0, 'no size or position sliders');
  key(P.doc.activeElement, 'Escape');
  text.focus(); const x0 = parseFloat(text.style.insetInlineStart);
  key(text, 'ArrowRight'); assert.ok(near(parseFloat(text.style.insetInlineStart), x0 + 1, 1e-6), 'one step = 1% of the frame');
  key(text, 'ArrowDown', { shiftKey: true }); assert.ok(near(parseFloat(text.style.insetBlockStart), 40, 1e-6), '30% + a shifted 10%');
  const w0 = parseFloat(text.style.inlineSize); key(text, '+'); await flush(4); assert.ok(parseFloat(text.style.inlineSize) > w0 * 1.05, '+ grows it');
  key(text, '-'); key(text, '-'); await flush(4); assert.ok(parseFloat(text.style.inlineSize) < w0, '− shrinks it');
  key(text, ']'); await flush(4); assert.match(text.style.transform, /rotate\(0\.0872\d*rad\)/, '] turns it 5°');
  key(text, '['); key(text, '['); await flush(4); assert.match(text.style.transform, /rotate\(-0\.0872\d*rad\)/);
  key(text, 'Delete'); await flush(4); assert.ok(layerEl(P, 'text') === null);
  P.doc.querySelector('.sst-post').click(); await flush(20); assert.deepEqual(P.uploaded.at(-1).body.edit.text, []);
});

test('Studio storyux: with nothing selected the picture itself pans (one finger) and zooms (two fingers); Fit posts a frame, Fill a crop that stays in the picture', async () => {
  const P = studioPage({ width: 4000, height: 3000 }); await studioOpen(P); await studioPick(P);
  const layout = P.doc.querySelector('[data-tool="layout"]'); assert.equal(layout.getAttribute('aria-pressed'), 'false', 'a landscape picture starts whole (Fit)');
  const src = P.doc.querySelector('.sst-source'); assert.equal(src.style.inlineSize, '100%');
  // two fingers 100 px apart around the middle, spread to 200: twice the size
  ptr(stage(P), 'pointerdown', 1, 100, 250); ptr(stage(P), 'pointerdown', 2, 200, 250, { isPrimary: false }); await flush();
  ptr(stage(P), 'pointermove', 1, 50, 250); ptr(stage(P), 'pointermove', 2, 250, 250, { isPrimary: false }); await flush();
  ptr(stage(P), 'pointerup', 1, 50, 250); ptr(stage(P), 'pointerup', 2, 250, 250, { isPrimary: false }); await flush(6);
  assert.ok(near(parseFloat(src.style.inlineSize), 200)); assert.ok(near(parseFloat(src.style.insetInlineStart), -50));
  await drag(P, stage(P), [150, 250], [180, 250]);                 // + 10% of the frame
  assert.ok(near(parseFloat(src.style.insetInlineStart), -40));
  P.doc.querySelector('.sst-post').click(); await flush(20);
  let edit = P.uploaded.at(-1).body.edit; assert.equal(edit.fit, 'fit'); assert.equal(edit.crop, undefined);
  assert.ok(near(edit.frame.w, .5)); assert.ok(near(edit.frame.x, .2)); assert.ok(near(edit.frame.h, .5 * 4000 / 3000 / (9 / 16)));
  // Fill (the round layout toggle): the picture covers the frame; dragged far, its edge stops at the frame's
  const Q = studioPage({ width: 4000, height: 3000 }); await studioOpen(Q); await studioPick(Q);
  Q.doc.querySelector('[data-tool="layout"]').click(); await flush();
  assert.equal(Q.doc.querySelector('[data-tool="layout"]').getAttribute('aria-pressed'), 'true');
  await drag(Q, stage(Q), [10, 250], [300, 250]);
  Q.doc.querySelector('.sst-post').click(); await flush(20);
  edit = Q.uploaded.at(-1).body.edit; assert.equal(edit.fit, 'fill'); assert.equal(edit.frame, undefined);
  assert.equal(edit.crop.x, 0); assert.ok(near(edit.crop.w, .421875)); assert.ok(edit.crop.y >= 0 && edit.crop.y + edit.crop.h <= 1 + 1e-9);
  // a double tap on the picture puts it back the way the layout starts
  const R = studioPage({ width: 4000, height: 3000 }); await studioOpen(R); await studioPick(R);
  await drag(R, stage(R), [150, 250], [200, 300]); await tapAt(R, stage(R)); await tapAt(R, stage(R));
  R.doc.querySelector('.sst-post').click(); await flush(20); assert.equal(R.uploaded.at(-1).body.edit.frame, undefined, 'the whole picture again: no frame');
});

test('Studio storyux: after a photo is picked only an X is shown - no Gallery, no Camera; X goes back, and a draft with edits asks quietly first', async () => {
  const P = studioPage(), root = await studioOpen(P);
  const picks = P.doc.querySelector('.sst-picks'), head = P.doc.querySelector('.sst-head');
  assert.ok(!picks.hidden); assert.ok(!P.doc.querySelector('[data-picker="camera"]').hidden); assert.ok(!P.doc.querySelector('[data-picker="gallery"]').hidden);
  assert.ok(P.doc.querySelector('[data-picker="retake"]') === null, 'no Retake: the X is the one way back');
  await studioPick(P);
  assert.ok(picks.hidden, 'Gallery and Camera are gone once there is a picture');
  const x = head.querySelector('.sst-back'), close = head.querySelector('.sst-close');
  assert.ok(x && !x.hidden); assert.ok(close.hidden); assert.ok(head.children.indexOf(x) <= 1, 'top left');
  assert.equal(x.querySelector('.ds-ic').textContent, '✕');
  assert.equal(x.getAttribute('aria-label'), 'Choose another picture or video', 'no live camera here: X goes back to the picker'); assert.equal(x.title, x.getAttribute('aria-label'));
  P.win.confirm = () => { throw new Error('no browser dialog for this'); };
  x.click(); await flush(6);
  assert.ok(!root.classList.contains('sst-has-media')); assert.ok(P.doc.querySelector('.sst-source') === null); assert.ok(!picks.hidden); assert.ok(!close.hidden && x.hidden);
  assert.ok(P.calls.every((c) => c.url !== '/api/feed/uploads'), 'nothing was uploaded');
  // with edits: a quiet question in the editor; Keep editing keeps everything, Discard goes back
  await studioPick(P); await studioText(P, 'Keep me?'); key(P.doc.activeElement, 'Escape');
  x.click(); await flush();
  const ask = P.doc.querySelector('.sst-ask'); assert.ok(ask && !ask.hidden, 'asked in the editor'); assert.match(ask.textContent, /Discard your edits\?/);
  assert.ok(root.classList.contains('sst-has-media'));
  ask.querySelector('.sst-ask-keep').click(); await flush();
  assert.ok(P.doc.querySelector('.sst-ask') === null); assert.ok(root.classList.contains('sst-has-media')); assert.ok(layerEl(P, 'text'), 'the text is still there');
  x.click(); await flush(); key(P.doc.activeElement, 'Escape'); assert.ok(P.doc.querySelector('.sst-ask') === null, 'Escape keeps editing too'); assert.ok(P.doc.querySelector('.sst'));
  x.click(); await flush(); P.doc.querySelector('.sst-ask .sst-ask-go').click(); await flush(6);
  assert.ok(!root.classList.contains('sst-has-media')); assert.ok(layerEl(P, 'text') === null); assert.ok(!picks.hidden);
  // a chosen video: the same X
  await studioPick(P, 'video/mp4'); assert.ok(picks.hidden); assert.ok(!x.hidden);
});

test('Studio storyux: tool buttons are circles with no visible words, named by aria-label and title; Post stays a labelled button; no sliders anywhere for place, size, turn or zoom', async () => {
  const P = studioPage(); await studioOpen(P);
  const named = (b) => { const n = b.getAttribute('aria-label'); assert.ok(n && n.trim(), 'named'); assert.equal(b.title, n); assert.doesNotMatch(n, /^[←-⯿\u{1f000}-\u{1faff}]/u, 'the name is words, not the emoji'); };
  const iconOnly = (b) => { for (const span of b.querySelectorAll('span')) assert.equal(span.getAttribute('aria-hidden'), 'true', 'only the icon shows: ' + b.getAttribute('aria-label')); assert.ok(b.classList.contains('sst-round'), 'round: ' + b.getAttribute('aria-label')); };
  for (const b of P.doc.querySelectorAll('.sst-picks button, .sst-head button')) { named(b); iconOnly(b); }
  await studioPick(P);
  for (const b of P.doc.querySelectorAll('.sst-tools button, .sst-head button')) { named(b); iconOnly(b); }
  assert.deepEqual(P.doc.querySelectorAll('.sst-tools button').map((b) => b.getAttribute('data-tool')), ['layout', 'text', 'sticker', 'mention', 'trim']);
  assert.ok(P.doc.querySelector('.sst-button-label') === null);
  const post = P.doc.querySelector('.sst-post'); assert.equal(post.textContent, 'Post story'); assert.ok(!post.classList.contains('sst-round'));
  await studioText(P, 'Words'); assert.equal(P.doc.querySelectorAll('input[type="range"]').length, 0, 'the text sheet');
  key(P.doc.activeElement, 'Escape'); await studioSticker(P); assert.equal(P.doc.querySelectorAll('input[type="range"]').length, 0, 'a placed sticker');
  P.doc.querySelector('[data-tool="layout"]').click(); await flush(); assert.equal(P.doc.querySelectorAll('input[type="range"]').length, 0, 'the layout');
  P.doc.querySelector('[data-tool="mention"]').click(); assert.equal(P.doc.querySelectorAll('input[type="range"]').length, 0, 'the mention sheet');
  key(P.doc.activeElement, 'Escape');
  // a video: the trim bar's two handles are the only ranges (a timeline, not a placement slider)
  const Q = studioPage(); await studioOpen(Q); await studioPick(Q, 'video/mp4');
  assert.deepEqual(Q.doc.querySelectorAll('input[type="range"]').map((r) => r.classList.contains('sst-trim-handle')), [true, true]);
  for (const b of Q.doc.querySelectorAll('.sst-sheet .sst-position button')) { named(b); iconOnly(b); }
  const js = SRC('story-studio.js'); assert.equal((js.match(/input\('range'/g) || []).length, 1, 'one range input is made: the trim handle'); assert.match(js, /input\('range', d\.trim/);
  const css = fs.readFileSync(path.join(repo, 'public/css/story-studio.css'), 'utf8');
  assert.match(css, /\.sst \.ds-btn\.sst-round \{[^}]*border-radius:\s*50%/); assert.match(css, /\.sst \.sst-preview \{[^}]*touch-action:\s*none/);
  assert.match(css, /\.sst \.sst-preview \{[^}]*-webkit-touch-callout:\s*none/); assert.match(css, /\.sst \.sst-preview \{[^}]*user-select:\s*none/);
});

test('Studio storyux: iPhone - WebKit gesture events stand in when the pointers lose the second finger, and the stage never scrolls, zooms or calls out the page', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P); const sticker = await studioSticker(P);
  const gs = new Ev('gesturestart', { bubbles: true, scale: 1, rotation: 0 }); ptr(sticker, 'pointerdown', 1, 150, 250); stage(P).dispatchEvent(gs); assert.ok(gs.defaultPrevented, 'no page zoom');
  const gc = new Ev('gesturechange', { bubbles: true, scale: 2, rotation: 90 }); stage(P).dispatchEvent(gc); assert.ok(gc.defaultPrevented); await flush();
  stage(P).dispatchEvent(new Ev('gestureend', { bubbles: true, scale: 2, rotation: 90 })); ptr(stage(P), 'pointerup', 1, 150, 250); await flush(6);
  let img = liveOps(P, 'image').at(-1); assert.deepEqual(img.args.slice(1), [-240, -240, 480, 480], 'the gesture scale'); assert.ok(near(liveOps(P, 'rotate').at(-1).args[0], Math.PI / 2), 'and its rotation (degrees)');
  // both fingers seen as pointers: the pointer math wins and the gesture event is only kept from zooming the page
  ptr(sticker, 'pointerdown', 1, 150, 250); ptr(stage(P), 'pointerdown', 2, 250, 250, { isPrimary: false }); stage(P).dispatchEvent(new Ev('gesturestart', { bubbles: true, scale: 1, rotation: 0 }));
  const ignored = new Ev('gesturechange', { bubbles: true, scale: 3, rotation: 0 }); stage(P).dispatchEvent(ignored); assert.ok(ignored.defaultPrevented); await flush();
  ptr(stage(P), 'pointerup', 2, 250, 250, { isPrimary: false }); ptr(stage(P), 'pointerup', 1, 150, 250); await flush(6);
  img = liveOps(P, 'image').at(-1); assert.deepEqual(img.args.slice(1), [-240, -240, 480, 480], 'unchanged: no pointer moved');
  for (const type of ['touchmove', 'contextmenu', 'dragstart', 'selectstart']) { const e = new Ev(type, { bubbles: true }); stage(P).dispatchEvent(e); assert.ok(e.defaultPrevented, type); }
  // a third finger is ignored; a cancelled touch ends the gesture without a tap
  ptr(sticker, 'pointerdown', 1, 150, 250); ptr(stage(P), 'pointerdown', 2, 250, 250); ptr(stage(P), 'pointerdown', 3, 50, 50);
  ptr(stage(P), 'pointermove', 3, 0, 0); await flush(); ptr(stage(P), 'pointercancel', 1, 150, 250); ptr(stage(P), 'pointercancel', 2, 250, 250); ptr(stage(P), 'pointercancel', 3, 0, 0); await flush(6);
  img = liveOps(P, 'image').at(-1); assert.deepEqual(img.args.slice(1), [-240, -240, 480, 480]);
  // an engine whose pointer stream never starts (no pointerdown at all): the gesture events alone size and turn the selected layer
  const ge = (type, scale, rotation) => stage(P).dispatchEvent(new Ev(type, { bubbles: true, scale, rotation }));
  ge('gesturestart', 1, 0); ge('gesturechange', .5, -90); ge('gestureend', .5, -90); await flush(6);
  img = liveOps(P, 'image').at(-1); assert.deepEqual(img.args.slice(1), [-120, -120, 240, 240], 'half the size');
  assert.match(layerEl(P, 'sticker').style.transform, /rotate\(0rad\)/, 'back to upright (+90 then -90)');
});

test('Studio storyux: one finger off the selected layer lets it go and pans the picture from where it went down; a second finger there pinches the layer', async () => {
  const P = studioPage({ width: 4000, height: 3000 }); await studioOpen(P); await studioPick(P); const sticker = await studioSticker(P);
  const src = P.doc.querySelector('.sst-source'); assert.ok(!P.doc.querySelector('.sst-select').hidden);
  ptr(stage(P), 'pointerdown', 1, 60, 60); await flush(); ptr(stage(P), 'pointermove', 1, 75, 60); await flush(); ptr(stage(P), 'pointermove', 1, 90, 60); await flush(); ptr(stage(P), 'pointerup', 1, 90, 60); await flush(6);
  assert.ok(P.doc.querySelector('.sst-select').hidden, 'let go'); assert.ok(near(parseFloat(src.style.insetInlineStart), 10), 'panned the whole 30 px (10% of the frame)');
  // a small selected sticker is pinched around it: the first finger beside it waits for the second
  await tapAt(P, sticker, 150, 250); assert.ok(!P.doc.querySelector('.sst-select').hidden);
  ptr(stage(P), 'pointerdown', 1, 100, 250); ptr(stage(P), 'pointerdown', 2, 200, 250, { isPrimary: false }); await flush();
  ptr(stage(P), 'pointermove', 1, 50, 250); ptr(stage(P), 'pointermove', 2, 250, 250, { isPrimary: false }); await flush();
  ptr(stage(P), 'pointerup', 1, 50, 250); ptr(stage(P), 'pointerup', 2, 250, 250, { isPrimary: false }); await flush(6);
  assert.deepEqual(liveOps(P, 'image').at(-1).args.slice(1), [-240, -240, 480, 480], 'the sticker doubled'); assert.ok(near(parseFloat(src.style.insetInlineStart), 10), 'the picture stayed');
});

test('Studio storyux: desktop - the wheel sizes the selected layer, Shift+wheel turns it, the corner handle turns and sizes it; with nothing selected the wheel zooms the picture', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P); await studioSticker(P);
  const wheel = (o) => { const e = new Ev('wheel', Object.assign({ bubbles: true, clientX: 150, clientY: 250, deltaMode: 0 }, o)); stage(P).dispatchEvent(e); return e; };
  const e = wheel({ deltaY: -200 }); assert.ok(e.defaultPrevented); await flush(4);
  let img = liveOps(P, 'image').at(-1); assert.ok(img.args[3] > 240, 'wheel up grows it'); const grown = img.args[3];
  wheel({ deltaY: 400, ctrlKey: true }); await flush(4); img = liveOps(P, 'image').at(-1); assert.ok(img.args[3] < grown, 'ctrl+wheel (a trackpad pinch) shrinks it');
  wheel({ deltaY: 100, shiftKey: true }); await flush(4); assert.ok(liveOps(P, 'rotate').at(-1).args[0] > .1, 'Shift+wheel turns it');
  // the corner handle: dragged from the corner to a point twice as far from the centre, a quarter turn round
  const turn = P.doc.querySelector('.sst-select .sst-sel-turn'); assert.ok(turn); assert.equal(turn.getAttribute('aria-hidden'), 'true');
  const Q = studioPage(); await studioOpen(Q); await studioPick(Q); await studioSticker(Q);
  const handle = Q.doc.querySelector('.sst-select .sst-sel-turn'), mouse = { pointerType: 'mouse' };
  ptr(handle, 'pointerdown', 1, 200, 250, mouse); ptr(stage(Q), 'pointermove', 1, 150, 350, mouse); await flush(); ptr(stage(Q), 'pointerup', 1, 150, 350, mouse); await flush(6);
  img = liveOps(Q, 'image').at(-1); assert.deepEqual(img.args.slice(1), [-240, -240, 480, 480]); assert.ok(near(liveOps(Q, 'rotate').at(-1).args[0], Math.PI / 2));
  // nothing selected: the wheel zooms the picture about the pointer
  const R = studioPage(); await studioOpen(R); await studioPick(R); const src = R.doc.querySelector('.sst-source');
  const z = new Ev('wheel', { bubbles: true, clientX: 150, clientY: 250, deltaY: -300, deltaMode: 0 }); stage(R).dispatchEvent(z); assert.ok(z.defaultPrevented); await flush(4);
  assert.ok(parseFloat(src.style.inlineSize) > 100, 'zoomed in');
});

// ── storyux verify (the review of 2026-11-08): a tap that deleted what it meant to select, grips covering small layers, the
//    header and the tools taking touches meant for the picture, hit areas stacked unlike the drawing, a lost pointerup that broke
//    every later gesture, a deselecting tap that counted towards a reset, layout per frame, the corner grip running away at an
//    edge, the X pressed twice, focus lost after a pick, and the rest ──
const clickAt = (node) => node.dispatchEvent(new Ev('click', { bubbles: true, detail: 1, button: 0 }));   // a pointer's click (detail 1)
const rectOf = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height });
/** the selected layer's grips in the stage's px (the fake stage is 300 x 500): its outline's box, and each grip's centre */
function gripsOf(P) {
  const sel = P.doc.querySelector('.sst-select'), w = parseFloat(sel.style.inlineSize), h = parseFloat(sel.style.blockSize);
  const cx = parseFloat(sel.style.insetInlineStart) * 3, cy = parseFloat(sel.style.insetBlockStart) * 5;
  const at = (n) => ({ lx: parseFloat(n.style.insetInlineStart), ly: parseFloat(n.style.insetBlockStart), x: cx - w / 2 + parseFloat(n.style.insetInlineStart), y: cy - h / 2 + parseFloat(n.style.insetBlockStart), corner: n.getAttribute('data-at') });
  return { w, h, cx, cy, del: at(sel.querySelector('.sst-sel-del')), turn: at(sel.querySelector('.sst-sel-turn')) };
}
const clearOfBox = (p, w, h) => Math.hypot(Math.max(0 - p.lx, 0, p.lx - w), Math.max(0 - p.ly, 0, p.ly - h));

test('Studio storyux verify: a tap on a layer only selects it - the click a phone then sends to the delete grip that appeared under the finger deletes nothing; a press that starts on the grip does', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P); await studioText(P, 'Hi'); key(P.doc.activeElement, 'Escape');
  const text = layerEl(P, 'text'); await tapAt(P, stage(P), 20, 480); assert.ok(P.doc.querySelector('.sst-select').hidden, 'let go');
  // the tap's down selects the text and shows its grips; the browser sends the tap's click to whatever is under the finger then
  ptr(text, 'pointerdown', 1, 150, 150); ptr(stage(P), 'pointerup', 1, 150, 150); await flush(6);
  clickAt(P.doc.querySelector('.sst-sel-del')); await flush(4);
  assert.ok(layerEl(P, 'text'), 'the text is still there'); assert.ok(!P.doc.querySelector('.sst-select').hidden, 'and selected');
  const sticker = await studioSticker(P); await tapAt(P, stage(P), 20, 480);
  ptr(sticker, 'pointerdown', 1, 140, 240); ptr(stage(P), 'pointerup', 1, 140, 240); await flush(6);
  clickAt(P.doc.querySelector('.sst-sel-del')); await flush(4); assert.ok(layerEl(P, 'sticker'), 'the sticker is still there');
  // a drag that starts on the layer and ends on the grip is no delete either
  ptr(sticker, 'pointerdown', 1, 140, 240); ptr(stage(P), 'pointermove', 1, 100, 200); await flush(); ptr(stage(P), 'pointerup', 1, 100, 200); await flush(6);
  clickAt(P.doc.querySelector('.sst-sel-del')); await flush(4); assert.ok(layerEl(P, 'sticker'));
  // a press on the grip of the selected layer removes it - and Enter / Space (a click with no pointer) do too
  const del = P.doc.querySelector('.sst-sel-del'); ptr(del, 'pointerdown', 4, 100, 100); ptr(del, 'pointerup', 4, 100, 100); clickAt(del); await flush(4);
  assert.ok(layerEl(P, 'sticker') === null, 'deleted by its own press');
  await tapAt(P, text, 150, 150); P.doc.querySelector('.sst-sel-del').click(); await flush(4); assert.ok(layerEl(P, 'text') === null, 'deleted from the keyboard');
});

test('Studio storyux verify: the grips sit off the selected layer\'s corners - their finger-sized circles never cover even a small layer - inside the stage and clear of the buttons over the picture', async () => {
  const G = geometry(), stageBox = { w: 300, h: 500 }, RD = G.GRIP.del, RT = G.GRIP.turn;
  assert.ok(RD >= 24 && RT >= 21, 'finger-sized');
  const clear = (g, c, hw, hh, rot, k, r) => { const dx = g[k].x - c.x, dy = g[k].y - c.y, lx = dx * Math.cos(rot) + dy * Math.sin(rot), ly = -dx * Math.sin(rot) + dy * Math.cos(rot); return Math.hypot(Math.max(Math.abs(lx) - hw, 0), Math.max(Math.abs(ly) - hh, 0)) >= r; };
  // which of the box's corners a grip is off, on screen: the delete takes the top-left-most, the turn the bottom-right-most
  const cornerOf = (p, c, rot) => { const dx = p.x - c.x, dy = p.y - c.y; return [Math.sign(dx * Math.cos(rot) + dy * Math.sin(rot)), Math.sign(-dx * Math.sin(rot) + dy * Math.cos(rot))]; };
  const score = (k, c, hw, hh, rot) => c.x + k[0] * hw * Math.cos(rot) - k[1] * hh * Math.sin(rot) + c.y + k[0] * hw * Math.sin(rot) + k[1] * hh * Math.cos(rot);
  const ALL = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (const [hw, hh, rot] of [[18, 22, 0], [18, 22, .7], [60, 30, -2.5], [10, 10, Math.PI / 4], [40, 18, Math.PI]]) {
    const c = { x: 150, y: 250 }, g = G.grips(c, hw, hh, rot, stageBox, [], true);
    assert.ok(clear(g, c, hw, hh, rot, 'del', RD), 'delete clear of the box at ' + rot); assert.ok(clear(g, c, hw, hh, rot, 'turn', RT), 'turn clear of the box at ' + rot);
    assert.notEqual(g.del.at, g.turn.at);
    const scores = ALL.map((k) => score(k, c, hw, hh, rot));
    assert.ok(score(cornerOf(g.del, c, rot), c, hw, hh, rot) <= Math.min(...scores) + 1e-6, 'delete at the top-left-most corner, turned or not: ' + rot);
    assert.ok(score(cornerOf(g.turn, c, rot), c, hw, hh, rot) >= Math.max(...scores) - 1e-6, 'turn at the bottom-right-most corner: ' + rot);
    assert.ok(Math.hypot(g.del.x - g.turn.x, g.del.y - g.turn.y) >= RD + RT, 'the two never overlap');
  }
  // at the top edge, the top corners would leave the stage: the grips go below; in the top-left corner, wherever there is room
  let g = G.grips({ x: 150, y: 22 }, 40, 22, 0, stageBox, [], true);
  assert.equal(g.del.at, 'bl'); assert.equal(g.turn.at, 'br'); assert.ok(g.del.y - RD >= 0 && g.turn.y - RT >= 0);
  g = G.grips({ x: 40, y: 30 }, 40, 30, 0, stageBox, [], true);
  for (const k of ['del', 'turn']) { const r = G.GRIP[k], p = g[k]; assert.ok(p.x - r >= 0 && p.y - r >= 0 && p.x + r <= 300 && p.y + r <= 500, k + ' in the stage'); assert.ok(clear(g, { x: 40, y: 30 }, 40, 30, 0, k, r), k + ' clear'); }
  // a button over the picture (the header's X) is no place for a grip
  g = G.grips({ x: 100, y: 110 }, 33, 33, 0, stageBox, [{ x0: 8, y0: 8, x1: 52, y1: 52 }], true);
  assert.equal(g.del.at, 'tr', 'not under the X'); assert.equal(g.turn.at, 'br');
  // a mention chip has only the delete grip
  assert.equal(G.grips({ x: 150, y: 250 }, 40, 22, 0, stageBox, [], false).turn, undefined);

  // in the editor: a small selected text ("Hi", a phone's 36 x 44 hit box) - the outline is its whole hit box and the grips are off it
  const P = studioPage({ coarse: true }); await studioOpen(P); await studioPick(P); await studioText(P, 'Hi'); key(P.doc.activeElement, 'Escape');
  let q = gripsOf(P); assert.ok(q.w >= 36 && q.h >= 44, `the outline is the hit box (${q.w} x ${q.h})`);
  assert.ok(clearOfBox(q.del, q.w, q.h) >= RD, 'delete grip off the box'); assert.ok(clearOfBox(q.turn, q.w, q.h) >= RT, 'turn grip off the box');
  // dragged to the very top: the grips stay in the stage (below it)
  await drag(P, layerEl(P, 'text'), [150, 150], [150, -200]); q = gripsOf(P);
  assert.ok(q.cy - q.h / 2 < 2, 'the text is at the top'); assert.ok(q.del.y - RD >= 0 && q.turn.y - RT >= 0, 'both grips inside the stage'); assert.equal(q.del.corner, 'bl');
  // the buttons over the picture: a sticker near the header's X gets its delete grip on the other side
  const Q = studioPage(); await studioOpen(Q); await studioPick(Q);
  for (const b of Q.doc.querySelectorAll('.sst-head .ds-btn, .sst-tools .ds-btn')) b.getBoundingClientRect = rectOf(0, 0, 0, 0);
  const headButtons = Q.doc.querySelectorAll('.sst-head .ds-btn');
  Q.doc.querySelector('.sst-back').getBoundingClientRect = rectOf(8, 8, 44, 44); headButtons[headButtons.length - 1].getBoundingClientRect = rectOf(248, 8, 44, 44);
  Q.doc.querySelectorAll('.sst-tools .ds-btn').forEach((b, i) => { b.getBoundingClientRect = rectOf(252, 60 + 56 * i, 44, 44); });
  const sticker = await studioSticker(Q); await drag(Q, sticker, [150, 250], [100, 110]);
  q = gripsOf(Q); assert.equal(q.del.corner, 'tr', 'the delete grip is not put under the X');
  assert.ok(Math.hypot(Math.max(8 - q.del.x, 0, q.del.x - 52), Math.max(8 - q.del.y, 0, q.del.y - 52)) >= RD, 'clear of the X');
});

test('Studio storyux verify: the hit areas stack as the layers are drawn - texts under stickers - whatever order they were added in', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P); await studioSticker(P); await studioText(P, 'Hello pond'); key(P.doc.activeElement, 'Escape');
  const order = () => P.doc.querySelector('.sst-handles').children.filter((n) => n.classList.contains('sst-layer')).map((n) => n.getAttribute('data-layer').split('-')[0]);
  assert.deepEqual(order(), ['text', 'sticker']);
  await studioSticker(P); await studioText(P, 'Second'); key(P.doc.activeElement, 'Escape');
  assert.deepEqual(order(), ['text', 'text', 'sticker', 'sticker']);
  const kids = P.doc.querySelector('.sst-handles').children; assert.ok(kids[kids.length - 1].classList.contains('sst-select'), 'the selection over them all');
});

test('Studio storyux verify: a pointerup that never came ends with the next press - no ghost finger, no drag with no button held, a lost capture lets go', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P); const sticker = await studioSticker(P); await studioText(P, 'Hello pond'); key(P.doc.activeElement, 'Escape');
  await tapAt(P, stage(P), 20, 480); assert.ok(P.doc.querySelector('.sst-select').hidden);
  const where = (n) => [n.style.insetInlineStart, n.style.insetBlockStart], mouse = { pointerType: 'mouse' }, s0 = where(sticker);
  ptr(sticker, 'pointerdown', 1, 150, 250, mouse); await flush();                       // its pointerup never comes (Alt+Tab mid-drag)
  ptr(stage(P), 'pointermove', 1, 90, 190, { pointerType: 'mouse', buttons: 0 }); await flush(6);
  assert.deepEqual(where(sticker), s0, 'a mouse moving with no button held drags nothing');
  ptr(stage(P), 'pointerdown', 1, 20, 480, mouse); ptr(stage(P), 'pointerup', 1, 20, 480, mouse); await flush(6);
  assert.ok(P.doc.querySelector('.sst-select').hidden, 'the next click on the picture lets go, as ever');
  // a finger whose up never came, then a new first finger: its own one-finger drag, not a pinch about a ghost
  const text = layerEl(P, 'text'), t0 = where(text);
  ptr(sticker, 'pointerdown', 7, 150, 250, { isPrimary: true }); await flush();
  await drag(P, text, [150, 150], [150, 200], 8, { isPrimary: true });
  assert.notDeepEqual(where(text), t0, 'the text moved'); assert.deepEqual(where(sticker), s0, 'the sticker did not');
  // the same pointer id pressed again (its up was lost): a new gesture
  const t1 = parseFloat(text.style.insetBlockStart);
  ptr(sticker, 'pointerdown', 5, 150, 250, { isPrimary: false }); await flush();
  await drag(P, text, [150, 200], [150, 230], 5, { isPrimary: false });
  assert.deepEqual(where(sticker), s0); assert.ok(near(parseFloat(text.style.insetBlockStart), t1 + 6, 1e-6), 'the text moved again (30 px of 500)');
  // a capture lost on the stage ends that pointer (one lost on the layer's own button, as a capture moves to the stage, does not)
  ptr(sticker, 'pointerdown', 9, 150, 250, { isPrimary: true }); sticker.dispatchEvent(new Ev('lostpointercapture', { bubbles: true, pointerId: 9 }));
  ptr(stage(P), 'pointermove', 9, 160, 250, { isPrimary: true }); await flush(); ptr(stage(P), 'pointermove', 9, 170, 250, { isPrimary: true }); await flush();
  assert.ok(near(parseFloat(sticker.style.insetInlineStart), 50 + 20 / 3, 1e-6), 'still dragging after the button lost the capture to the stage');
  stage(P).dispatchEvent(new Ev('lostpointercapture', { bubbles: true, pointerId: 9 })); await flush(4);
  const before = liveOps(P, 'image').at(-1).args[3];
  const e = new Ev('wheel', { bubbles: true, clientX: 150, clientY: 250, deltaY: -200, deltaMode: 0 }); stage(P).dispatchEvent(e); await flush(4);
  assert.ok(e.defaultPrevented && liveOps(P, 'image').at(-1).args[3] > before, 'nothing is held: the wheel sizes the selected sticker');
});

test('Studio storyux verify: the tap that lets a layer go is no half of a double tap - the picture keeps its framing; a real double tap still puts it back', async () => {
  const P = studioPage({ width: 4000, height: 3000 }); await studioOpen(P); await studioPick(P); const src = P.doc.querySelector('.sst-source');
  stage(P).dispatchEvent(new Ev('wheel', { bubbles: true, clientX: 150, clientY: 250, deltaY: -300, deltaMode: 0 })); await flush(4);
  const zoomed = src.style.inlineSize; assert.ok(parseFloat(zoomed) > 100);
  await studioSticker(P); assert.ok(!P.doc.querySelector('.sst-select').hidden);
  await tapAt(P, stage(P), 20, 480); await tapAt(P, stage(P), 20, 480);
  assert.ok(P.doc.querySelector('.sst-select').hidden); assert.equal(src.style.inlineSize, zoomed, 'not reset');
  await tapAt(P, stage(P), 20, 480); await tapAt(P, stage(P), 20, 480); assert.equal(src.style.inlineSize, '100%', 'a double tap with nothing selected puts it back');
});

test('Studio storyux verify: while fingers pinch the picture it moves by a transform (no layout per frame); its size and place are written once, at the end', async () => {
  const P = studioPage({ width: 4000, height: 3000 }); await studioOpen(P); await studioPick(P); const src = P.doc.querySelector('.sst-source');
  ptr(stage(P), 'pointerdown', 1, 100, 250); ptr(stage(P), 'pointerdown', 2, 200, 250, { isPrimary: false }); await flush();
  ptr(stage(P), 'pointermove', 1, 50, 250); ptr(stage(P), 'pointermove', 2, 250, 250, { isPrimary: false }); await flush();
  assert.equal(src.style.inlineSize, '100%', 'no new size while the fingers move'); assert.equal(src.style.insetInlineStart, '0%');
  assert.match(src.style.transform, /^translate\(-50%, [-\d.e]+%\) scale\(2, 2\)$/, 'a transform: ' + src.style.transform);
  ptr(stage(P), 'pointerup', 1, 50, 250); ptr(stage(P), 'pointerup', 2, 250, 250, { isPrimary: false }); await flush(6);
  assert.ok(near(parseFloat(src.style.inlineSize), 200)); assert.ok(near(parseFloat(src.style.insetInlineStart), -50)); assert.equal(src.style.transform, '');
  const css = fs.readFileSync(path.join(repo, 'public/css/story-studio.css'), 'utf8'); assert.match(css, /\.sst \.sst-source \{[^}]*transform-origin:\s*0 0/);
});

test('Studio storyux verify: the corner grip sizes and turns from where the layer\'s centre was when it was pressed - pushed in from an edge, it never runs ahead of the finger', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P); const sticker = await studioSticker(P);
  await drag(P, sticker, [150, 250], [400, 250]); assert.ok(near(parseFloat(sticker.style.insetInlineStart), (1 - 120 / 1080) * 100, 1e-6), 'against the right edge');
  const c = { x: (1 - 120 / 1080) * 300, y: 250 }, turn = P.doc.querySelector('.sst-select .sst-sel-turn'), mouse = { pointerType: 'mouse' };
  ptr(turn, 'pointerdown', 1, c.x + 40, c.y + 40, mouse); await flush();
  for (let i = 0; i < 4; i++) { ptr(stage(P), 'pointermove', 1, c.x + 80, c.y + 80, mouse); await flush(); }
  ptr(stage(P), 'pointerup', 1, c.x + 80, c.y + 80, mouse); await flush(6);
  assert.deepEqual(liveOps(P, 'image').at(-1).args.slice(1), [-240, -240, 480, 480], 'twice as far from the centre: twice the size, frame after frame');
  const turns = liveOps(P, 'rotate'); assert.ok(!turns.length || near(turns.at(-1).args[0], 0, 1e-9), 'and not turned');
});

test('Studio storyux verify: the X pressed again while it asks keeps the question (only Discard discards); the question closes any sheet and sits under the header', async () => {
  const P = studioPage(), root = await studioOpen(P); await studioPick(P);
  P.doc.querySelector('[data-tool="text"]').click(); const ta = P.doc.querySelector('.sst-text-input'); ta.value = 'Hi'; ta.dispatchEvent(new Ev('input')); await flush();
  const x = P.doc.querySelector('.sst-back'); x.click(); await flush();
  assert.ok(P.doc.querySelector('.sst-ask'), 'asked'); assert.ok(P.doc.querySelector('.sst-sheet') === null, 'the text sheet closed for the question');
  const card = P.doc.querySelector('.sst-card'); assert.ok(card.children[1].classList.contains('sst-ask'), 'right under the header (next to the X), on a desktop too');
  x.click(); await flush(6);
  assert.ok(P.doc.querySelector('.sst-ask'), 'still asking'); assert.ok(root.classList.contains('sst-has-media')); assert.ok(layerEl(P, 'text'), 'nothing discarded');
  assert.ok(P.doc.activeElement === P.doc.querySelector('.sst-ask-keep'), 'the X points at the question');
  P.doc.querySelector('.sst-ask-go').click(); await flush(6); assert.ok(!root.classList.contains('sst-has-media'), 'Discard discards');
});

test('Studio storyux verify: after a pick the focus goes to the picture - not lost with the Gallery button that hid', async () => {
  const P = studioPage(); await studioOpen(P); const gallery = P.doc.querySelector('[data-picker="gallery"]'); gallery.focus();
  await studioPick(P); assert.ok(P.doc.activeElement === stage(P), 'the preview has the focus');
  const Q = studioPage(); await studioOpen(Q); const more = Q.doc.querySelectorAll('.sst-head .ds-btn'); more[more.length - 1].focus(); await studioPick(Q);
  assert.ok(Q.doc.activeElement === more[more.length - 1], 'a focus that is still on screen stays where it was');
});

test('Studio storyux verify: the screen-reader help says what works where - the picture\'s keys on the picture, the layer\'s on each layer - and the selected layer says so', async () => {
  const P = studioPage(); await studioOpen(P); await studioPick(P); await studioText(P, 'Hello pond'); key(P.doc.activeElement, 'Escape');
  const help = P.doc.getElementById(stage(P).getAttribute('aria-describedby')).textContent;
  assert.match(help, /zoom/i); assert.match(help, /\b0\b/); assert.doesNotMatch(help, /\[ and \] turn|Delete removes/, 'no layer keys on the picture');
  const text = layerEl(P, 'text'), lh = P.doc.getElementById(text.getAttribute('aria-describedby'));
  assert.ok(lh, 'each layer is described'); assert.match(lh.textContent, /\[ and \] turn/); assert.match(lh.textContent, /Delete removes/); assert.match(lh.textContent, /Enter/);
  assert.equal(text.getAttribute('aria-current'), 'true', 'the selected layer says so');
  await tapAt(P, stage(P), 20, 480); assert.equal(text.getAttribute('aria-current'), null);
});

test('Studio storyux verify: the page can still be zoomed from the sheets and the footer (their small print) - never from the picture or the buttons over it', async () => {
  const P = studioPage({ visualViewport: { height: 406, scale: 2 } }), root = await studioOpen(P); await studioPick(P);
  assert.equal(root.style['--sst-vh'], '812px', 'a pinch-zoomed page keeps the editor its own height (the keyboard still shrinks it)');
  const g = (n) => { const e = new Ev('gesturestart', { bubbles: true, scale: 1, rotation: 0 }); n.dispatchEvent(e); return e.defaultPrevented; };
  assert.ok(g(stage(P)), 'the picture'); assert.ok(g(P.doc.querySelector('[data-tool="text"]')), 'a tool over the picture'); assert.ok(g(P.doc.querySelector('.sst-back')), 'the header over the picture');
  assert.ok(!g(P.doc.querySelector('.sst-post')), 'the footer zooms the page'); assert.ok(!g(P.doc.querySelector('.sst-rules')));
  P.doc.querySelector('[data-tool="text"]').click(); assert.ok(!g(P.doc.querySelector('.sst-sheet')), 'a sheet zooms the page');
  const css = fs.readFileSync(path.join(repo, 'public/css/story-studio.css'), 'utf8'), sst = /\.sst \{[^}]*\}/.exec(css)[0];
  assert.doesNotMatch(sst, /pan-x|pan-y/, 'no pinch block on the whole editor'); assert.match(sst, /touch-action:\s*manipulation/, 'no double-tap zoom on its buttons');
  assert.match(css, /\.sst \.sst-head, \.sst \.sst-tools \{[^}]*touch-action:\s*pan-x pan-y/);
});

test('Studio storyux verify: Escape and a click outside ask the same quiet question as the X, only when there are edits - never a browser dialog; 0 resets the picture; Escape lets a layer go first', async () => {
  let confirms = 0;
  const P = studioPage(); await studioOpen(P); await studioPick(P); P.win.confirm = () => { confirms++; return true; };
  key(P.doc.activeElement, 'Escape'); assert.equal(P.doc.querySelector('.sst'), null, 'no edits: closed at once'); assert.equal(confirms, 0);
  const Q = studioPage(), root = await studioOpen(Q); await studioPick(Q); Q.win.confirm = () => { confirms++; return true; };
  await studioText(Q, 'Mine'); key(Q.doc.activeElement, 'Escape');
  root.dispatchEvent(new Ev('click', { bubbles: true, button: 0 })); await flush();
  const ask = Q.doc.querySelector('.sst-ask'); assert.ok(ask, 'a click outside asks'); assert.match(ask.textContent, /Discard this story\?/);
  ask.querySelector('.sst-ask-keep').click(); assert.ok(Q.doc.querySelector('.sst')); assert.ok(layerEl(Q, 'text'));
  key(Q.doc.activeElement, 'Escape'); assert.ok(Q.doc.querySelector('.sst-select').hidden, 'Escape lets the selected layer go first'); assert.ok(Q.doc.querySelector('.sst-ask') === null);
  key(Q.doc.activeElement, 'Escape'); assert.ok(Q.doc.querySelector('.sst-ask'), 'then asks');
  Q.doc.querySelector('.sst-ask-go').click(); await flush(); assert.equal(Q.doc.querySelector('.sst'), null, 'Discard closes the editor'); assert.equal(confirms, 0);
  // the focused picture: 0 puts it back the way its layout starts
  const S = studioPage({ width: 4000, height: 3000 }); await studioOpen(S); await studioPick(S); const src = S.doc.querySelector('.sst-source');
  key(stage(S), '+'); key(stage(S), '+'); assert.ok(parseFloat(src.style.inlineSize) > 100); key(stage(S), '0'); assert.equal(src.style.inlineSize, '100%');
});

test('Studio storyux verify: on a phone the header and the tools let touches through to the picture between their buttons; every round button shows a focus ring over its shadow', () => {
  const css = fs.readFileSync(path.join(repo, 'public/css/story-studio.css'), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 760px)'), css.indexOf('@keyframes sst-sheet-in'));
  assert.match(mobile, /\.sst \.sst-head, \.sst \.sst-tools \{[^}]*pointer-events:\s*none/);
  assert.match(mobile, /\.sst \.sst-head \.ds-btn, \.sst \.sst-tools \.ds-btn \{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.sst \.ds-btn\.sst-sel-del:focus-visible \{[^}]*box-shadow:\s*var\(--ds-focus-ring\)/);
  assert.match(mobile, /\.sst \.sst-tools \.ds-btn\.sst-round:focus-visible \{[^}]*box-shadow:\s*var\(--ds-focus-ring\)/);
  assert.doesNotMatch(css, /\.sst-sel-turn \{[^}]*inset-inline-end/, 'the script places the grips (off the corner with room, not a fixed corner)');
});
