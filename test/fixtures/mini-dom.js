// test/fixtures/mini-dom.js - the little DOM the roulette Room Dock controls (public/js/casinorl-dock.js) need, for vm tests
// with no browser: elements with children / text / attributes / dataset / listeners / style, querySelector(All) for simple
// selectors (tag, .class, [attr], tag.class, comma lists), and a run(src, globals) that evaluates a browser script with a fake
// window. Not a DOM implementation - just enough for these tests (1.99aof roulette review fixes).
"use strict";
const vm = require("vm");

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.className = "";
    this._text = "";
    const props = {};
    this.style = { setProperty: (k, v) => { props[k] = String(v); }, getPropertyValue: (k) => props[k] || "", props };
    this.classList = {
      toggle: (c, on) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); this.className = [...s].join(" "); },
      contains: (c) => this.className.split(/\s+/).includes(c),
      add: (c) => this.classList.toggle(c, true),
      remove: (c) => this.classList.toggle(c, false),
    };
  }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text; }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = v == null ? "" : String(v); }
  get innerText() { return this.hidden ? "" : this.children.length ? this.children.map((c) => c.innerText).filter(Boolean).join("\n") : this._text; }
  append(...nodes) { for (const n of nodes) { const c = typeof n === "string" ? Object.assign(new El("#text"), { _text: n }) : n; c.parentNode = this; this.children.push(c); } }
  replaceChildren(...nodes) { this.textContent = ""; this.append(...nodes); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "href") this.href = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "href") delete this.href; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, extra) { const e = Object.assign({ type, target: this, preventDefault() {} }, extra || {}); for (const fn of this.listeners[type] || []) fn(e); if (typeof this["on" + type] === "function") this["on" + type](e); return e; }
  click() { if (!this.disabled) this.fire("click"); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  matches(sel) {
    return sel.split(",").some((one) => {
      const m = /^\s*([a-z0-9]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?\s*$/i.exec(one);
      if (!m) throw new Error("mini-dom: selector " + one);
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      for (const c of (m[2] || "").split(".").filter(Boolean)) if (!this.classList.contains(c)) return false;
      if (m[3]) {
        const key = m[3].startsWith("data-") ? m[3].slice(5).replace(/-(\w)/g, (_, x) => x.toUpperCase()) : null;
        const v = key ? this.dataset[key] : this.getAttribute(m[3]);
        if (v == null || (m[4] != null && String(v) !== m[4])) return false;
      }
      return true;
    });
  }
  querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/** a fake window: document.createElement, timers you run by hand, fetch from a handler; run(src) evaluates a browser script */
function makeWindow(fetchHandler) {
  const timers = [];
  const doc = { hidden: false, createElement: (t) => new El(t), body: new El("body") };
  const W = {
    document: doc,
    fetched: [],
    timers,
    setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.done = true; },
    setInterval: () => 0,
    clearInterval: () => {},
    crypto: { randomUUID: () => "uuid-" + Math.random().toString(16).slice(2) },
    fetch: async (url, opts) => {
      W.fetched.push({ url, opts });
      const out = await fetchHandler(url, opts || {});
      return { status: out && out.status ? out.status : 200, json: async () => (out && out.body !== undefined ? out.body : out) };
    },
    location: { replace: (u) => { W.replaced = u; } },
    console,
    Number, Math, Date, JSON, String, Array, Object, Promise, RegExp, Set, Map, Error,
  };
  W.window = W;
  W.self = W;
  /** run the earliest pending timer (whatever its delay) and let the microtasks settle */
  W.tick = async () => {
    const t = timers.find((x) => !x.done);
    if (!t) return false;
    t.done = true;
    await t.fn();
    await new Promise((r) => setImmediate(r));
    return true;
  };
  W.settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  W.run = (src, name) => vm.runInNewContext(src, W, { filename: name || "script.js" });
  return W;
}

module.exports = { El, makeWindow };
