// storyreact site, the browser side: the story viewer's reaction row and reply sheet (public/js/stories.js) and the tip sheet
// (public/js/post-tip.js), run in a vm against a small fake DOM (elements, selectors, event capture / bubbling). Checks: typing
// in the reply box never drives the viewer (arrows / Space / M), Enter sends and Shift+Enter / IME composition don't, Esc closes
// the sheet only, Tab stays inside it, the optimistic vote rolls back on an error, the 💸 sheet opens ABOVE the viewer (and the
// story resumes when it closes), and post-tip.js loaded twice keeps one listener.
//   NODE_PATH=G:/PATV/node_modules node --test test/story-react-client.test.js
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

const ROOM = { id: "mem.pad", title: "Members Pond", href: "/p/mem-pad", latest: Date.now(), seen: 0 };
function storyList(react) {
  const it = (id, extra) => Object.assign({ id, kind: "photo", src: "/x.jpg", page: "/x", subject: "Carol C", by: "bobcf", created: Date.now() - 60e3, expires: Date.now() + 3600e3,
                                            secs: 0, source: "cam", nsfw: false, poster: null,
                                            react: Object.assign({ votes: true, score: 3, ups: 4, downs: 1, my: 0, tips: null,
                                                                   can: { vote: true, down: true, tip: true, reply: true, quick: true }, to: "Carol C", role: "subject", signin: false }, react || {}) }, extra || {});
  return { ok: true, rooms: [Object.assign({}, ROOM, { items: [it("aa000001"), it("aa000002")] })] };
}
async function openViewer(P) {
  P.win.patvStories.open(ROOM.id, "aa000001", null, ROOM.id);
  await flush();
  const V = P.win.patvStories._state();
  assert.ok(V && V.root.isConnected, "the viewer is open");
  return V;
}

test("the reaction row: Reply pill, ▲ score ▼, 💸 - from it.react only; none without it", async () => {
  const P = page({ routes: { "GET /api/stories": { body: storyList() } } });
  const V = await openViewer(P);
  assert.ok(V.frame.classList.contains("has-react"));
  assert.equal(V.react.querySelector(".sv-reply").textContent, "Reply to Carol C…");
  assert.equal(V.react.querySelector(".sv-vs").textContent, "3");
  assert.equal(V.react.querySelector(".sv-vs").title, "4 up · 1 down");
  assert.equal(V.react.getAttribute("role"), "group");
  assert.ok(V.react.querySelector(".sv-tipb"));
  // an item without react: no row, today's layout
  const P2 = page({ routes: { "GET /api/stories": { body: { ok: true, rooms: [Object.assign({}, ROOM, { items: [{ id: "bb000001", kind: "photo", src: "/y.jpg", page: "/y", created: Date.now(), source: "cam" }] })] } } } });
  P2.win.patvStories.open(ROOM.id, "bb000001", null, ROOM.id);
  await flush();
  const V2 = P2.win.patvStories._state();
  assert.ok(!V2.frame.classList.contains("has-react") && V2.react.classList.contains("hide"));
  // NSFW, still blurred: the row waits
  const P3 = page({ routes: { "GET /api/stories": { body: { ok: true, rooms: [Object.assign({}, ROOM, { items: [Object.assign(storyList().rooms[0].items[0], { nsfw: true })] })] } } } });
  P3.win.patvStories.open(ROOM.id, "aa000001", null, ROOM.id);
  await flush();
  const V3 = P3.win.patvStories._state();
  assert.ok(V3.react.classList.contains("hide"), "hidden while gated");
  V3.stage.querySelector(".sv-btn.primary").click();
  assert.ok(!V3.react.classList.contains("hide"), "shown once revealed");
});

test("the reply sheet: typing never drives the viewer; Enter sends, Shift+Enter / IME don't; Tab stays inside; Esc closes the sheet only", async () => {
  const P = page({ routes: { "GET /api/stories": { body: storyList() }, "GET /api/stories/aa000001/reply": { body: { ok: true, canSend: true, refusal: null, code: null } },
                             "POST /api/stories/aa000001/reply": { body: { ok: true, conversation: "c0ffee0123456789", created: true } } } });
  const V = await openViewer(P);
  V.react.querySelector(".sv-reply").click();
  await flush();
  const panel = V.frame.querySelector(".sv-panel.sv-rp");
  assert.ok(panel, "the sheet is open");
  assert.equal(panel.getAttribute("role"), "dialog");
  assert.equal(V.paused, true, "the story pauses while composing");
  const ta = panel.querySelector("textarea.sv-rt");
  assert.equal(P.doc.activeElement, ta);
  assert.equal(ta.getAttribute("enterkeyhint"), "send");
  assert.equal(panel.querySelectorAll(".sv-rqb").length, 8, "the quick reactions");
  const ii = V.ii, muted = V.muted;
  for (const k of ["ArrowRight", "ArrowLeft", "ArrowDown", " ", "m", "M"]) key(ta, k);
  assert.equal(V.ii, ii, "no navigation");
  assert.equal(V.muted, muted, "M didn't mute");
  assert.equal(V.paused, true, "Space didn't resume");
  assert.ok(V.root.isConnected && V.panel === panel);
  const posts = () => P.calls.filter((c) => c.method === "POST" && /\/reply$/.test(c.url));
  ta.value = "hello";
  ta.dispatchEvent(new Ev("input", { bubbles: true }));
  assert.equal(V.drafts.aa000001, "hello", "the draft lives in memory");
  key(ta, "Enter", { shiftKey: true });
  key(ta, "Enter", { isComposing: true });
  assert.equal(posts().length, 0, "Shift+Enter / IME composition: no send");
  // Tab cycles inside the sheet
  const focusables = panel.querySelectorAll("textarea:not([disabled]), input:not([disabled]), button:not([disabled]), a[href]");
  focusables[focusables.length - 1].focus();
  key(focusables[focusables.length - 1], "Tab");
  assert.equal(P.doc.activeElement, focusables[0], "Tab wraps to the first control");
  key(focusables[0], "Tab", { shiftKey: true });
  assert.equal(P.doc.activeElement, focusables[focusables.length - 1], "Shift+Tab wraps to the last");
  key(ta, "Enter");
  await flush();
  assert.equal(posts().length, 1, "Enter sends");
  assert.deepEqual(posts()[0].body, { body: "hello", quick: false });
  assert.equal(V.panel.querySelector("a").getAttribute("href"), "/messages/c/c0ffee0123456789", "View in Messages");
  assert.equal(V.drafts.aa000001, undefined, "sent: the draft goes");
  key(V.panel.querySelector("a"), "Escape");
  assert.equal(V.panel, null, "Esc closes the sheet");
  assert.ok(V.root.isConnected, "...and only the sheet");
  assert.equal(V.paused, false, "the story resumes");
  assert.equal(P.doc.activeElement, V.react.querySelector(".sv-reply"), "focus back on the pill");
});

test("the reply sheet: a refused preflight shows the DM's text and disables sending; a quick reaction sends the emoji", async () => {
  const P = page({ routes: { "GET /api/stories": { body: storyList() },
                             "GET /api/stories/aa000001/reply": { body: { ok: true, canSend: false, refusal: "Carol C isn't taking new messages.", code: "closed" } } } });
  const V = await openViewer(P);
  V.react.querySelector(".sv-reply").click();
  await flush();
  assert.equal(V.panel.querySelector(".sv-err").textContent, "Carol C isn't taking new messages.");
  assert.ok(V.panel.querySelector("textarea").disabled);
  assert.ok(V.panel.querySelectorAll(".sv-rqb").every((b) => b.disabled));
  // the focused textarea was disabled: Cancel took the focus first (never <body>), so the keys still work
  const cancel = V.panel.querySelectorAll(".sv-ask-btns button")[1];
  assert.equal(P.doc.activeElement, cancel, "Cancel has the focus");
  keyActive(P, "Tab");
  assert.ok(V.panel.contains(P.doc.activeElement), "Tab stays in the sheet");
  P.doc.activeElement = cancel;
  keyActive(P, "Escape");
  assert.equal(V.panel, null, "Esc closes the sheet");
  assert.ok(V.root.isConnected);
  assert.equal(P.doc.activeElement, V.react.querySelector(".sv-reply"));
  const P2 = page({ routes: { "GET /api/stories": { body: storyList() }, "GET /api/stories/aa000001/reply": { body: { ok: true, canSend: true } },
                              "POST /api/stories/aa000001/reply": { body: { ok: true, conversation: "c0ffee0123456789", created: false } } } });
  const V2 = await openViewer(P2);
  V2.react.querySelector(".sv-reply").click();
  await flush();
  V2.panel.querySelectorAll(".sv-rqb")[5].click();
  await flush();
  const sent = P2.calls.filter((c) => c.method === "POST" && /\/reply$/.test(c.url));
  assert.deepEqual(sent.map((c) => c.body), [{ body: "🔥", quick: true }]);
  assert.equal(V2.panel, null, "a quick reaction closes the sheet");
  assert.equal(V2.frame.querySelector(".sv-toast").textContent, "Sent 🔥");
});

test("votes: optimistic, settled by the server, rolled back on an error; ▼ disabled on your own story; signed out asks to sign in", async () => {
  let answer = { status: 200, body: { ok: true, vote: 1, counted: true, score: 4, ups: 5, downs: 1 } };
  const P = page({ routes: { "GET /api/stories": { body: storyList() }, "POST /api/stories/aa000001/vote": () => answer } });
  const V = await openViewer(P);
  V.react.querySelector(".sv-up").click();
  assert.equal(V.react.querySelector(".sv-vs").textContent, "4", "optimistic");
  assert.equal(V.react.querySelector(".sv-up").getAttribute("aria-pressed"), "true");
  await flush();
  assert.equal(V.react.querySelector(".sv-vs").textContent, "4");
  assert.equal(V.live.textContent, "Upvoted · score 4");
  answer = { status: 429, body: { ok: false, error: "You're voting very fast - take a breather." } };
  V.react.querySelector(".sv-down").click();
  assert.equal(V.react.querySelector(".sv-vs").textContent, "2", "optimistic: -1 and the old +1 out");
  await flush();
  assert.equal(V.react.querySelector(".sv-vs").textContent, "4", "rolled back");
  assert.equal(V.react.querySelector(".sv-up").getAttribute("aria-pressed"), "true");
  assert.equal(V.frame.querySelector(".sv-toast").textContent, "You're voting very fast - take a breather.");
  const own = page({ routes: { "GET /api/stories": { body: storyList({ can: { vote: true, down: false, tip: false, reply: false } }) } } });
  const V2 = await openViewer(own);
  assert.ok(V2.react.querySelector(".sv-down").disabled);
  assert.equal(V2.react.querySelector(".sv-down").getAttribute("aria-label"), "You can't downvote your own story");
  assert.ok(!V2.react.querySelector(".sv-reply") && !V2.react.querySelector("button.sv-tipb"), "no pill, no 💸 on your own story");
  const out = page({ me: "", routes: { "GET /api/stories": { body: storyList({ signin: true, my: undefined, to: null, role: null, can: { vote: false, down: false, tip: false, reply: false } }) } } });
  const V3 = await openViewer(out);
  V3.react.querySelector(".sv-up").focus();
  V3.react.querySelector(".sv-up").click();
  const ask = out.doc.body.querySelector(".sv-ask");
  assert.ok(ask, "the sign-in prompt");
  assert.equal(V3.paused, true, "the story waits behind the prompt (it can't run on or close under it)");
  assert.equal(out.calls.filter((c) => c.method === "POST").length, 0);
  ask.querySelector("button.ghost").click();                                // "Not now"
  assert.ok(!ask.isConnected);
  assert.equal(V3.paused, false, "resumes");
  assert.equal(out.doc.activeElement, V3.react.querySelector(".sv-up"), "focus back on ▲");
});

test("focus never falls out of the viewer: the story moving on rebuilds the row with the same control focused; a failed quick reaction refocuses its emoji", async () => {
  const P = page({ routes: { "GET /api/stories": { body: storyList() }, "POST /api/stories/aa000001/vote": { body: { ok: true, vote: 1, score: 4, ups: 5, downs: 1 } } } });
  const V = await openViewer(P);
  V.react.querySelector(".sv-up").focus();
  keyActive(P, "ArrowRight");                                              // (or the photo's 5 s running out)
  assert.equal(V.ii, 1, "moved on");
  assert.equal(P.doc.activeElement, V.react.querySelector(".sv-up"), "the new ▲ has the focus");
  keyActive(P, "ArrowLeft");
  assert.equal(V.ii, 0, "...so the keys keep working");
  V.foot.querySelector("a").focus();                                       // a control that has no twin in the row
  keyActive(P, "ArrowRight");
  assert.equal(P.doc.activeElement, V.root, "the viewer itself, never <body>");
  keyActive(P, "Escape");
  assert.ok(!V.root.isConnected, "Esc still closes it");
  // a quick reaction that fails: back on that emoji (it was disabled while sending)
  const Q = page({ routes: { "GET /api/stories": { body: storyList() }, "GET /api/stories/aa000001/reply": { body: { ok: true, canSend: true } },
                             "POST /api/stories/aa000001/reply": { status: 429, body: { ok: false, error: "You're sending messages too fast." } } } });
  const W = await openViewer(Q);
  W.react.querySelector(".sv-reply").click();
  await flush();
  const fire = W.panel.querySelectorAll(".sv-rqb")[5];
  fire.focus();
  fire.click();
  assert.ok(W.panel.contains(Q.doc.activeElement), "while sending: still inside the sheet");
  await flush();
  assert.equal(W.panel.querySelector(".sv-err").textContent, "You're sending messages too fast.");
  assert.equal(Q.doc.activeElement, fire, "back on 🔥");
});

test("open() from a DM card opens THAT story or nothing; the read-only tip tally is announced", async () => {
  const P = page({ routes: { "GET /api/stories": { body: storyList() } } });
  const ok = await P.win.patvStories.open(ROOM.id, "zz999999", null, ROOM.id, true);
  assert.equal(ok, false, "not in the pad's list any more: no viewer (the card turns into 'Story no longer available')");
  assert.ok(!(P.win.patvStories._state() && P.win.patvStories._state().root.isConnected));
  assert.equal(await P.win.patvStories.open("no.such.pad", "aa000001", null, "no.such.pad", true), false, "the pad isn't there");
  assert.equal(await P.win.patvStories.open(ROOM.id, "aa000002", null, ROOM.id, true), true);
  assert.equal(P.win.patvStories._state().ii, 1, "the replied-to story itself");
  // strips (not fresh) keep their old behaviour: an unknown item starts the pad's story at the beginning
  const P2 = page({ routes: { "GET /api/stories": { body: storyList() } } });
  assert.equal(await P2.win.patvStories.open(ROOM.id, "zz999999", null, ROOM.id), true);
  assert.equal(P2.win.patvStories._state().ii, 0);
  // a viewer who can't tip still sees (and hears) the tally
  const P3 = page({ routes: { "GET /api/stories": { body: storyList({ tips: { n: 2, total: 1500 }, to: null, role: null,
                                                                             can: { vote: true, down: true, tip: false, reply: false, quick: false } }) } } });
  const V3 = await openViewer(P3);
  const ro = V3.react.querySelector(".sv-tipb.ro");
  assert.deepEqual([ro.localName, ro.getAttribute("role"), ro.getAttribute("aria-label")], ["span", "img", "2 tips · 1,500 PAT"]);
  assert.ok(!V3.react.querySelector(".sv-reply"), "no pill without a name");
});

test("💸 opens the tip sheet ABOVE the viewer (paused meanwhile) and posts to the story's tip route", async () => {
  const P = page({ routes: { "GET /api/stories": { body: storyList() }, "GET /api/u/bob/balance": { body: { balance: 50000 } },
                             "POST /api/stories/aa000001/tip": { body: { ok: true, amount: 2500, balance: 47500, tips: { n: 1, total: 2500 } } } } });
  const V = await openViewer(P);
  V.react.querySelector(".sv-tipb").click();
  await flush();
  const scrim = P.doc.body.querySelector(".ds-scrim.ptip-top");
  assert.ok(scrim, "the sheet's scrim carries ptip-top (z-index above .sv)");
  assert.equal(V.paused, true);
  assert.equal(scrim.querySelector(".ds-sub").textContent, "For this story. Carol C gets the full amount.");
  scrim.querySelector("#ptipAmt").value = "2,500";
  scrim.querySelector("form").dispatchEvent(new Ev("submit", { bubbles: true }));
  assert.equal(scrim.querySelector(".ptip-sum").textContent, "Send 2,500 PAT to Carol C for this story?");
  scrim.querySelectorAll(".ds-modal-f button")[3].click();
  await flush();
  const t = P.calls.find((c) => c.method === "POST" && c.url === "/api/stories/aa000001/tip");
  assert.ok(t && t.body.amount === 2500 && t.body.idempotency_key);
  assert.equal(V.react.querySelector(".sv-tipn").textContent, "1 · 2.5k", "the tally updates");
  key(scrim.querySelector("button"), "Escape");
  assert.ok(!scrim.isConnected, "closed");
  assert.equal(V.paused, false, "the story resumes");
});

test("post-tip.js loaded twice: one click listener, one API object", () => {
  const doc = makeDoc("bob");
  const win = { document: doc, window: null, crypto: {} };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(SRC("post-tip.js"), ctx);
  const api = win.PATVPostTip;
  vm.runInContext(SRC("post-tip.js"), ctx);
  assert.equal(win.PATVPostTip, api);
  assert.equal(doc.listeners.filter((l) => l.type === "click").length, 1);
});

test("client strings: textContent only - no new innerHTML in the reaction / reply / DM-card code", () => {
  const s = SRC("stories.js");
  const reactPart = s.slice(s.indexOf("// ── storyreact site: ↩ Reply"), s.indexOf("function setPaused"));
  assert.ok(reactPart.length > 1000);
  assert.doesNotMatch(reactPart, /\.innerHTML\s*=/);
  const m = SRC("messages.js");
  const card = m.slice(m.indexOf("function storyLabel"), m.indexOf("function msgNode"));
  assert.doesNotMatch(card, /\.innerHTML\s*=/);
  const node = m.slice(m.indexOf("function storyNode"), m.indexOf("var viewerP"));
  assert.ok(node.length > 300);
  assert.doesNotMatch(node, /href|\/media\//, "the DM card is a button: no link, no media address");
});
