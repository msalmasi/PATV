// Hand-off 20 verify (review findings 1, 3 and 11): the card tables' themes in the BROWSER code, run in node vm on a small DOM built
// from the real partials (views/partials/casino-top.ejs, casino-lobby.ejs, casino-theme-saloon.ejs - no jsdom here):
//   * CZ.theme (public/js/casino-ui.js): a saloon table gets .cz-theme-saloon on #cz-table, the scene as the wrap's first child and
//     the sign on the felt (not in the board's column - it must not move the board); classic / the switch going off takes the
//     class and the art away again; CZSound.update hears every render
//   * the sound toggle (public/js/casino-sound.js) sits in the table's own top row (beside "All tables"), never in the page header
//     (an extra header pill wrapped the header and pushed the table down)
//   * the lobby: the theme picker only when the lobby says this viewer may pick (and signed in), aria-pressed follows a click, the
//     "looks only" note; Open sends body.theme only for a picked theme drawn for that game; a saloon table's row has its tag
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-themes-ui.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const partial = (name, locals) => ejs.render(rd("views", "partials", name + ".ejs"), locals, { filename: path.join(repo, "views", "partials", name + ".ejs") });

// ── a small DOM: elements, text, a template's content, compound selectors with descendant / child combinators, bubbling clicks ──
function miniDom() {
  const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "wbr"]);
  const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1))
    : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()]));
  const doc = { listeners: {}, hidden: false };
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
  const posts = [], location = { href: "" };
  const fetch = async (url, o) => {
    if (o && o.method === "POST") { const b = JSON.parse(o.body); posts.push({ url, body: b }); return { json: async () => (api.post ? api.post(url, b) : { ok: false }) }; }
    const j = typeof api[url] === "function" ? api[url]() : api[url];
    return { json: async () => j || {} };
  };
  const store = {}, timers = [];
  const window = { matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
  const ctx = { window, document: D.doc, fetch, location, console, setInterval: (fn) => timers.push(fn), clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
                crypto: { randomUUID: () => "00000000-0000-4000-8000-" + String(posts.length).padStart(12, "0") }, navigator: {}, Math, Date, JSON, Number, String, Array, Object, Set, Map, Promise };
  window.document = D.doc;
  window.fetch = fetch;
  window.location = location;
  window.crypto = ctx.crypto;
  vm.createContext(ctx);
  for (const k of Object.keys(window)) if (!(k in ctx)) ctx[k] = window[k];
  ctx.window = window;
  vm.runInContext(rd("public", "js", "casino-ui.js"), ctx, { filename: "casino-ui.js" });
  if (opts.sound) vm.runInContext(rd("public", "js", "casino-sound.js"), ctx, { filename: "casino-sound.js" });
  // poll(): the lobby's 4 s refresh (startLobby's setInterval(lobby, ...)) once
  const poll = async () => { for (const fn of timers.filter((f) => f.name === "lobby")) await fn(); };
  return { D, CZ: window.CZ, window, posts, location, poll, $: (id) => D.doc.getElementById(id) };
}
const flush = () => new Promise((r) => setImmediate(r));

// the table part of views/casino-hm.ejs (the elements CZ.theme and the sound toggle work with), checked against the view itself
const HM_TABLE = `<section id="cz-table" hidden><a class="back" href="/casino/holdem">← All tables</a>
  <div class="hm-wrap"><div class="felt hm" id="cz-felt"><div class="hm-center"><span class="hm-logo" aria-hidden="true">publicaccess.tv</span>
  <div class="board" id="cz-board"></div><div class="pot" id="cz-pot"></div><div class="felt-msg" id="cz-msg"></div></div>
  <div id="cz-bets"></div><div id="cz-seats"></div></div></div><div class="felt-meta" id="cz-meta"></div></section>`;
test("the harness's Hold'em table matches views/casino-hm.ejs (the back link, then the wrap, the felt's centre, bets and seats)", () => {
  const v = rd("views", "casino-hm.ejs").replace(/<%[\s\S]*?%>/g, "");
  assert.match(v, /<section id="cz-table" hidden>\s*<a class="back" href="\/casino\/holdem">[\s\S]*?<\/a>\s*<div class="hm-wrap">\s*<div class="felt hm" id="cz-felt">\s*<div class="hm-center">/);
  assert.match(v, /<div id="cz-bets"><\/div>\s*<div id="cz-seats"><\/div>\s*<\/div>\s*<\/div>/);
  assert.match(rd("public", "js", "casinohm.js"), /CZ\.theme\(t, \{ scene: \$\("cz-felt"\)\.parentNode, sign: \$\("cz-seats"\) \}\)/,
               "review 3: the sign goes on the felt itself (before the seats), out of the board's column");
});

function tablePage(opts) {
  const top = partial("casino-top", { game: "holdem", tableId: "abc1234567" });
  const art = partial("casino-theme-saloon", {});
  return page(`<main class="ds-page flow cz" id="cb" data-game="holdem" data-table="abc1234567" data-signed="1" data-user="ann">${top}${HM_TABLE}${art}</main>`, {}, opts);
}

test("CZ.theme: a saloon table gets the class, the scene behind the felt and the sign on the felt; classic takes them away; CZSound hears every render", () => {
  const P = tablePage();
  const calls = [];
  P.window.CZSound = { update: (id, t) => calls.push([id, t && t.rev]) };
  const wrap = P.$("cz-table"), felt = P.$("cz-felt"), seats = P.$("cz-seats");
  const at = () => ({ scene: felt.parentNode, sign: seats });
  assert.equal(typeof P.CZ.theme, "function");
  assert.equal(P.CZ.theme({ theme: "saloon", rev: 1 }, at()), "saloon");
  assert.ok(wrap.classList.contains("cz-theme-saloon"), "the class on #cz-table");
  const scene = felt.parentNode.firstChild;
  assert.ok(scene && scene.classList.contains("cz-scene") && scene.hasAttribute("data-cz-art"), "the scene: the wrap's first child");
  assert.ok(scene.querySelector(".cz-scene-art") && scene.querySelector(".cz-wallsign"), "the scene's art + the phones' wall sign");
  const sign = felt.querySelector(".cz-sign");
  assert.ok(sign && sign.parentNode === felt && sign.nextSibling === seats, "the sign on the felt, right before the seats");
  assert.equal(felt.querySelector(".hm-center .cz-sign"), null, "not in the board's column");
  assert.equal(P.D.doc.querySelectorAll("[data-cz-art]").length, 2);
  // a re-render with the same theme: nothing doubled
  P.CZ.theme({ theme: "saloon", rev: 2 }, at());
  assert.equal(P.D.doc.querySelectorAll("[data-cz-art]").length, 2, "every poll: still one scene + one sign");
  // the switch goes off: the table reads classic - the class and the art go
  assert.equal(P.CZ.theme({ theme: "classic", rev: 3 }, at()), "classic");
  assert.ok(!wrap.classList.contains("cz-theme-saloon"));
  assert.equal(P.D.doc.querySelectorAll("[data-cz-art]").length, 0);
  // an odd id: classic (it becomes a class name)
  assert.equal(P.CZ.theme({ theme: "Saloon x", rev: 4 }, at()), "classic");
  assert.equal(P.CZ.theme({ rev: 5 }, at()), "classic", "an older view without a theme");
  // back on
  P.CZ.theme({ theme: "saloon", rev: 6 }, at());
  assert.ok(wrap.classList.contains("cz-theme-saloon"));
  assert.deepEqual(calls, [["saloon", 1], ["saloon", 2], ["classic", 3], ["classic", 4], ["classic", 5], ["saloon", 6]], "CZSound.update(id, view) on every render");
});

test("review 1/3: the sound toggle sits in the table's own top row beside 'All tables' (no extra pill in the page header); hidden on classic", () => {
  const P = tablePage({ sound: true });
  const wrap = P.$("cz-table"), felt = P.$("cz-felt"), seats = P.$("cz-seats");
  const bar = P.D.doc.querySelector(".cz-bar");
  const pills = bar.children.length;
  P.CZ.theme({ theme: "saloon", game: "holdem", rev: 1 }, { scene: felt.parentNode, sign: seats });
  const btn = P.$("cz-soundbtn");
  assert.ok(btn, "a themed table has the toggle");
  assert.equal(bar.children.length, pills, "the page header keeps its pills (an extra one wrapped the header onto another row)");
  assert.ok(!bar.contains(btn));
  const back = wrap.querySelector(".back");
  assert.equal(btn.parentNode, wrap, "in the table section");
  assert.equal(back.nextSibling, btn, "right after the 'All tables' link - the table's top row");
  assert.equal(btn.getAttribute("aria-pressed"), "false", "off by default");
  assert.equal(btn.getAttribute("aria-label"), "Table sounds");
  assert.ok(btn.classList.contains("cz-snd"));
  const lbl = btn.querySelector(".cz-snd-l");
  assert.ok(lbl && lbl.textContent === "Sound", "a label (phones: the icon only - casino-themes.css)");
  assert.match(btn.textContent, /^🔇/);
  P.D.click(btn);
  assert.equal(btn.getAttribute("aria-pressed"), "true");
  assert.match(btn.textContent, /^🔊/);
  assert.equal(btn.querySelector(".cz-snd-l").textContent, "Sound");
  P.CZ.theme({ theme: "saloon", game: "holdem", rev: 2 }, { scene: felt.parentNode, sign: seats });
  assert.equal(P.D.doc.querySelectorAll("#cz-soundbtn").length, 1, "one toggle");
  P.CZ.theme({ theme: "classic", game: "holdem", rev: 3 }, { scene: felt.parentNode, sign: seats });
  assert.equal(btn.hidden, true, "classic: hidden");
  // the CSS: the label hides on phones, the toggle floats at the row's end (no height of its own)
  const css = rd("public", "css", "casino-themes.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.cz-theme-saloon \.cz-snd \{[^}]*float:\s*inline-end/);
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.cz-theme-saloon \.cz-snd-l \{[^}]*display:\s*none/);
});

// ── the lobby ──
const LOBBY = (pick, list, tables) => ({
  enabled: true, hm_enabled: true, rooms: [], stream: null, me: { balance: 5000, high_roller: false },
  limits: { bj: { min_bet: 100, max_bet: 100000, hr_min_bet: 100000, hr_max_bet: 1000000 }, holdem: { hr_ladder: [[100000, 200000]] } },
  tables: tables || [], themes: { pick, list: pick ? list : [] },
});
const LIST = [{ id: "classic", games: ["holdem", "bj"], default: true }, { id: "saloon", games: ["holdem", "bj"], default: false }];
function lobbyPage(data, signed) {
  const top = partial("casino-top", { game: "holdem", tableId: null });
  const lob = partial("casino-lobby", { game: "holdem", bjOn: true, hmOn: true });
  return page(`<main class="ds-page flow cz" id="cb" data-game="holdem" data-table="" data-signed="${signed === false ? "" : "1"}" data-user="ann">${top}${lob}</main>`,
              { "/api/casino/lobby": () => data, post: () => ({ ok: true, table: "t9" }) });
}

test("lobby picker: shown only when the lobby says this viewer may pick (and signed in); aria-pressed follows a click; the 'looks only' note", async () => {
  // the switch off / staff without the capability: no picker
  let P = lobbyPage(LOBBY(false, LIST));
  P.CZ.startLobby();
  await flush(); await flush();
  assert.equal(P.$("cz-themepick").hidden, true, "pick=false: hidden");
  assert.equal(P.$("cz-themes").querySelectorAll("button").length, 0);
  // signed out: hidden even if the flag were on
  P = lobbyPage(LOBBY(true, LIST), false);
  P.CZ.startLobby();
  await flush(); await flush();
  assert.equal(P.$("cz-themepick").hidden, true, "signed out: hidden");
  // may pick: Classic + Saloon, Classic pressed, no note
  P = lobbyPage(LOBBY(true, LIST));
  P.CZ.startLobby();
  await flush(); await flush();
  assert.equal(P.$("cz-themepick").hidden, false);
  const btns = () => P.$("cz-themes").querySelectorAll("button");
  assert.deepEqual(btns().map((b) => [b.dataset.th, b.getAttribute("aria-pressed")]), [["classic", "true"], ["saloon", "false"]]);
  assert.deepEqual(btns().map((b) => b.textContent), ["🃏 Classic", "🤠 Saloon"]);
  assert.equal(P.$("cz-themenote").textContent, "");
  P.D.click(btns()[1]);
  assert.deepEqual(btns().map((b) => b.getAttribute("aria-pressed")), ["false", "true"], "the saloon picked");
  assert.match(P.$("cz-themenote").textContent, /^Looks only: the rules, the cards, the odds and every PAT amount stay the same\.$/);
  P.D.click(btns()[0]);
  assert.deepEqual(btns().map((b) => b.getAttribute("aria-pressed")), ["true", "false"]);
  assert.equal(P.$("cz-themenote").textContent, "");
});

test("lobby Open: body.theme only for a picked theme drawn for that game; classic / no flag sends none", async () => {
  const open = async (P, btn) => { P.D.click(P.$(btn)); await flush(); await flush(); return P.posts[P.posts.length - 1].body; };
  let P = lobbyPage(LOBBY(true, LIST));
  P.CZ.startLobby();
  await flush(); await flush();
  let b = await open(P, "cz-open-hm-go");
  assert.equal(b.game, "holdem");
  assert.ok(!("theme" in b), "classic picked: no theme");
  P.D.click(P.$("cz-themes").querySelectorAll("button")[1]);
  b = await open(P, "cz-open-hm-go");
  assert.deepEqual([b.game, b.theme, b.blinds], ["holdem", "saloon", "25/50"]);
  assert.equal(P.location.href, "/casino/holdem/t/t9?sit=1");
  b = await open(P, "cz-open-bj-go");
  assert.deepEqual([b.game, b.theme], ["bj", "saloon"], "the saloon is drawn for blackjack too");
  // a theme drawn for Hold'em only: blackjack opens classic (and the note says so)
  const ONLY = LIST.concat([{ id: "vegas", games: ["holdem"], default: false }]);
  P = lobbyPage(LOBBY(true, ONLY));
  P.CZ.startLobby();
  await flush(); await flush();
  P.D.click(P.$("cz-themes").querySelector('button[data-th="vegas"]'));
  assert.match(P.$("cz-themenote").textContent, /Blackjack tables open in Classic for now\.$/);
  assert.equal((await open(P, "cz-open-hm-go")).theme, "vegas");
  assert.ok(!("theme" in (await open(P, "cz-open-bj-go"))), "not drawn for blackjack: none");
  // the flag gone (the switch went off between polls): nothing sent even though the saloon was picked
  let data = LOBBY(true, LIST);
  P = page(`<main class="ds-page flow cz" id="cb" data-game="holdem" data-table="" data-signed="1">${partial("casino-top", { game: "holdem", tableId: null })}${partial("casino-lobby", { game: "holdem", bjOn: true, hmOn: true })}</main>`,
           { "/api/casino/lobby": () => data, post: () => ({ ok: true, table: "t9" }) });
  P.CZ.startLobby();
  await flush(); await flush();
  P.D.click(P.$("cz-themes").querySelectorAll("button")[1]);
  assert.equal((await open(P, "cz-open-hm-go")).theme, "saloon");
  data = LOBBY(false, LIST);
  await P.poll();
  assert.equal(P.$("cz-themepick").hidden, true, "the next poll: the picker goes");
  assert.ok(!("theme" in (await open(P, "cz-open-hm-go"))), "no pick flag: no theme");
});

test("lobby rows: a saloon table has its 🤠 Saloon tag, a classic or older row none", async () => {
  const row = (id, theme) => Object.assign({ id, game: "holdem", host: "Ann", phase: "between", hand_no: 0, players: 2, max_seats: 9, sb: 25, bb: 50, rooms: [], adverts: [] },
                                          theme === undefined ? {} : { theme });
  const P = lobbyPage(LOBBY(false, LIST, [row("t1", "saloon"), row("t2", "classic"), row("t3")]));
  P.CZ.startLobby();
  await flush(); await flush();
  const cards = P.$("cz-tables").querySelectorAll("article");
  assert.equal(cards.length, 3);
  const tags = (c) => c.querySelectorAll(".meta .tag").map((x) => x.textContent);
  assert.ok(tags(cards[0]).includes("🤠 Saloon"), tags(cards[0]).join(" | "));
  for (const c of cards.slice(1)) assert.ok(!tags(c).some((x) => /Saloon|Classic|🎨/.test(x)), tags(c).join(" | "));
});
