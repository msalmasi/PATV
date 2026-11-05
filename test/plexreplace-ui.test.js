"use strict";
// plexreplace (owner 2026-11-05: "a one-step 'play this instead'"): the 📼 Play from Plex sheet (public/js/plex-play.js - the Room Dock's 📼
// sheet and /stage run this one copy) in a small DOM that parses the sheet's own markup, against a stubbed site:
//   * something on this pad that you may change (medialib.mine on_pad.can_replace): the pick says what's on, its button reads "▶ Play this
//     instead", the sheet's own confirm names what comes off (someone else's play, a queue's titles after it) - one tap = ONE POST with
//     {replace: true}; the answer says what it replaced
//   * the pad got busy under the sheet: a busy refusal WITH can_replace turns into that confirm (never the old dead end); WITHOUT it the
//     refusal shows as before and nothing is re-asked
//   * someone who may not change it: the plain "▶ Play on …" and a line saying why the pick waits
//   * a 📼 queue on the pad ("Play 2 titles instead" / it ends the queue), nothing on (no "instead" anywhere)
//   node --test test/plexreplace-ui.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");
const EN = JSON.parse(read("locales", "en.json"));
const SRC = read("public", "js", "plex-play.js");

// ── a small DOM: elements, a parser for the sheet's own innerHTML, simple selectors (tag, .class, [attr], [attr="v"], comma lists), bubbling clicks ──
const VOID = new Set(["input", "img", "br", "hr", "meta", "link"]);
const decode = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));
class Node_ {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.root; }
}
class Text_ extends Node_ { constructor(doc, t) { super(doc); this.nodeType = 3; this.data = String(t); } get textContent() { return this.data; } }
class El extends Node_ {
  constructor(doc, tag) {
    super(doc); this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.listeners = {}; this.style = {}; this.disabled = false; this._value = null;
    const self = this;
    this.classList = {
      _get: () => String(self.attrs.class || "").split(/\s+/).filter(Boolean),
      _set: (a) => { self.attrs.class = a.join(" "); },
      add(...c) { const a = this._get(); c.forEach((x) => { if (!a.includes(x)) a.push(x); }); this._set(a); },
      remove(...c) { this._set(this._get().filter((x) => !c.includes(x))); },
      contains(c) { return this._get().includes(c); },
      toggle(c, on) { const has = this.contains(c), v = on === undefined ? !has : !!on; if (v) this.add(c); else this.remove(c); return v; },
    };
  }
  get className() { return this.attrs.class || ""; } set className(v) { this.attrs.class = String(v); }
  get id() { return this.attrs.id || ""; } set id(v) { this.attrs.id = String(v); }
  get hidden() { return "hidden" in this.attrs; } set hidden(v) { if (v) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get type() { return this.attrs.type || ""; } set type(v) { this.attrs.type = String(v); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = []; if (v !== "" && v != null) this.appendChild(new Text_(this.ownerDocument, v)); }
  set innerHTML(html) { this.textContent = ""; parseInto(this, String(html)); }
  get value() {
    if (this.tagName === "SELECT") { const o = this.querySelectorAll("option"); const s = o.find((x) => x.hasAttribute("selected")) || o[0]; return s ? (s.hasAttribute("value") ? s.getAttribute("value") : s.textContent) : ""; }
    return this._value != null ? this._value : (this.attrs.value || "");
  }
  set value(v) { this._value = String(v); }
  get checked() { return "checked" in this.attrs; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); } removeEventListener() {}
  dispatch(type, target) { const ev = { type, target: target || this, preventDefault() {}, stopPropagation() {} }; for (let n = this; n; n = n.parentNode) for (const fn of (n.listeners && n.listeners[type]) || []) fn.call(n, ev); }
  click() { if (!this.disabled) this.dispatch("click", this); }
  focus() { this.ownerDocument.active = this; } scrollIntoView() {}
  matches(sel) { return sel.split(",").some((one) => matchOne(this, one.trim())); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); }); walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function matchOne(el, s) {
  const m = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:=(?:"[^"]*"|[^\]]*))?\])*)$/i.exec(s);
  if (!m) throw new Error("selector not supported here: " + s);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const c of m[2].split(".").filter(Boolean)) if (!el.classList.contains(c)) return false;
  for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
    const am = /^\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]$/.exec(a);
    if (!el.hasAttribute(am[1])) return false;
    const want = am[2] != null ? am[2] : am[3];
    if (want != null && el.getAttribute(am[1]) !== want) return false;
  }
  return true;
}
function parseInto(parent, html) {
  const doc = parent.ownerDocument;
  const re = /<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
  let cur = parent, m;
  while ((m = re.exec(html))) {
    if (m[1]) { for (let n = cur; n && n !== parent.parentNode; n = n.parentNode) if (n.tagName === m[1].toUpperCase()) { cur = n.parentNode; break; } continue; }
    if (m[2]) {
      const e = new El(doc, m[2]);
      for (const a of m[3].match(/[\w-]+(?:="[^"]*")?/g) || []) { const i = a.indexOf("="); if (i < 0) e.attrs[a] = ""; else e.attrs[a.slice(0, i)] = decode(a.slice(i + 2, -1)); }
      cur.appendChild(e);
      if (!VOID.has(m[2].toLowerCase()) && !/\/>$/.test(m[0])) cur = e;
      continue;
    }
    cur.appendChild(new Text_(doc, decode(m[4])));
  }
}
function mkDoc() { const doc = { active: null }; doc.root = new El(doc, "html"); doc.body = doc.root.appendChild(new El(doc, "body")); doc.createElement = (t) => new El(doc, t); return doc; }
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ── the sheet against a stubbed site ──
const MOVIE = { key: "501", type: "movie", title: "Night of the Living Dead", year: 1968, duration: 5760, audio: [], subs: [], summary: "They're coming." };
function sheet({ onPad = null, play = null, perHour = 0 } = {}) {
  const doc = mkDoc();
  const calls = [];
  const answers = { play: play || [] };
  const fetchStub = async (url, o = {}) => {
    const method = (o.method || "GET").toUpperCase(), body = o.body ? JSON.parse(o.body) : null;
    calls.push({ url, method, body });
    let status = 200, j = { ok: true };
    if (url.startsWith("/api/medialib/mine")) j = { ok: true, streams: { used: 1, max: 2 }, daily_left: null, queues: [], on_pad: typeof onPad === "function" ? onPad() : onPad };
    else if (url.startsWith("/api/medialib/item/")) j = { ok: true, item: MOVIE };
    else if (url === "/api/medialib/play") { const a = answers.play.shift() || { status: 200, j: { ok: true, title: "Night of the Living Dead (1968)", price: 0 } }; status = a.status; j = a.j; }
    return { ok: status < 400, status, json: async () => j };
  };
  const win = { document: doc, fetch: fetchStub, sessionStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, console, Intl, Date, Math, JSON };
  win.window = win;
  vm.runInNewContext(SRC, win, { filename: "plex-play.js" });
  const host = doc.body.appendChild(doc.createElement("div"));
  win.PATVPlexPlay.build(host, { note: "Free for you." });
  const started = [];
  const flow = win.PATVPlexPlay.mount(host, { roomId: () => "Night.Orchard", roomTitle: () => "Night Orchard", free: perHour === 0, perHour, quality: 720, queues: true,
                                              inlineConfirm: true, balance: () => "1,000", onStarted: (j) => started.push(j) });
  const res = host.querySelector('[data-px="results"]');
  const pick = async () => {                              // a search result clicked: the pick opens
    res.innerHTML = '<button type="button" class="px-it" data-key="501"><b>Night of the Living Dead</b></button>';
    res.querySelector(".px-it").click();
    await tick();
  };
  const P = { pick: host.querySelector('[data-px="pick"]'), msg: host.querySelector('[data-px="msg"]') };
  const btn = () => P.pick.querySelector("[data-play]");
  const now = () => P.pick.querySelector("[data-now]");
  const askBox = () => P.pick.querySelector(".px-ask");
  const yes = () => askBox().querySelector("button.primary");
  const plays = () => calls.filter((c) => c.url === "/api/medialib/play");
  return { doc, host, flow, calls, plays, pick, P, btn, now, askBox, yes, started, answers };
}
const ON = { title: "Charade (1963)", queue: false, left: 0, by: "cedar-fable", mine: false, can_replace: true, slot_id: "6f1c2e0a-0b1d-4c55-9a7e-2d3f4a5b6c7d" };

test("something on that you may change: the pick says so, ▶ Play this instead, the sheet's own confirm names what comes off - one tap = ONE request {replace: true}", async () => {
  const s = sheet({ onPad: ON, play: [{ status: 200, j: { ok: true, title: "Night of the Living Dead (1968)", price: 0, replaced: { title: "Charade (1963)", queue: false } } }] });
  s.flow.info();
  await tick();
  await s.pick();
  assert.equal(s.btn().textContent, "▶ Play this instead");
  assert.equal(s.now().classList.contains("hide"), false);
  assert.equal(s.now().textContent, "📼 Now on Night Orchard: “Charade (1963)” - ▶ swaps it for your pick.");
  s.btn().click();
  const box = s.askBox();
  assert.ok(box, "the sheet's own confirm (a row above the button), not the browser's dialog");
  assert.equal(s.btn().hidden, true, "one way forward: the confirm's own button");
  const lines = box.querySelectorAll("p").map((p) => p.textContent);
  assert.equal(lines[0], "Play “Night of the Living Dead” on Night Orchard’s stage instead of “Charade (1963)”?");
  assert.equal(lines[1], "“Charade (1963)” was started by cedar-fable - it stops for everyone watching.");
  assert.equal(s.yes().textContent, "Yes, play it instead");
  assert.equal(s.plays().length, 0, "nothing sent before the yes");
  s.yes().click();
  await tick();
  assert.equal(s.plays().length, 1, "ONE request - no ⏹ then ▶");
  assert.deepEqual(s.plays()[0].body, { room: "Night.Orchard", key: "501", quality: 720, offset: 0, audio: null, sub: null, replace: ON.slot_id },
                   "the replace names the slot the confirm named (review fix: never whatever is on by then)");
  assert.equal(s.calls.filter((c) => /\/stop$/.test(c.url)).length, 0);
  assert.equal(s.P.msg.textContent, "▶ Night of the Living Dead (1968) is starting on Night Orchard instead of “Charade (1963)” - it shows on the stage within a few seconds.");
  assert.equal(s.btn().textContent, "✓ Started");
  assert.equal(s.now().classList.contains("hide"), true, "started: the 'now on' line goes");
  assert.equal(s.started.length, 1);
  // every string is en.json's
  for (const k of ["js.plex.play_instead", "js.plex.now_on", "js.plex.q_instead", "js.plex.instead_by", "js.plex.ask_instead", "js.plex.started_instead"]) assert.ok(EN[k], k);
});

test("the pad got busy under the sheet: a busy refusal WITH can_replace becomes the 'instead' confirm (never a dead end); yes = the replace", async () => {
  const s = sheet({ onPad: null, play: [
    { status: 409, j: { ok: false, error: "This pad is already playing from the library - stop it first.", code: "busy_library", can_replace: true, playing: "Charade (1963)", playing_queue: false, playing_left: 0,
                        playing_by: "cedar-fable", playing_mine: false, playing_slot: "9a8b7c6d-0000-4000-8000-000000000001" } },
    { status: 200, j: { ok: true, title: "Night of the Living Dead (1968)", price: 0, replaced: { title: "Charade (1963)", queue: false } } }] });
  s.flow.info();
  await tick();
  await s.pick();
  assert.equal(s.btn().textContent, "▶ Play on Night Orchard", "nothing on when the sheet opened");
  assert.equal(s.now().classList.contains("hide"), true);
  s.btn().click();
  assert.equal(s.askBox().querySelector("p").textContent, "Play “Night of the Living Dead” on Night Orchard’s stage?");
  s.yes().click();
  await tick();
  assert.equal(s.plays().length, 1);
  assert.equal(s.plays()[0].body.replace, undefined, "a plain play first");
  const box = s.askBox();
  assert.ok(box, "asked again - as a replace");
  assert.equal(box.querySelector("p").textContent, "Play “Night of the Living Dead” on Night Orchard’s stage instead of “Charade (1963)”?");
  assert.doesNotMatch(s.P.msg.textContent, /stop it first/, "the old dead-end line never shows");
  assert.equal(s.now().textContent, "📼 Now on Night Orchard: “Charade (1963)” - ▶ swaps it for your pick.");
  s.yes().click();
  await tick();
  assert.equal(s.plays().length, 2);
  assert.equal(s.plays()[1].body.replace, "9a8b7c6d-0000-4000-8000-000000000001", "the slot the busy refusal named");
  assert.match(s.P.msg.textContent, /instead of “Charade \(1963\)”/);
});

test("someone who may not change it: the plain button, a line saying why the pick waits; the busy refusal shows as before and nothing is re-asked", async () => {
  const s = sheet({ onPad: { ...ON, can_replace: false }, play: [
    { status: 409, j: { ok: false, error: "This pad is already playing from the library - stop it first.", code: "busy_library", can_replace: false, playing: "Charade (1963)" } }] });
  s.flow.info();
  await tick();
  await s.pick();
  assert.equal(s.btn().textContent, "▶ Play on Night Orchard");
  assert.equal(s.now().textContent, "📼 Now on Night Orchard: “Charade (1963)” - only whoever started it, the pad’s owner or an admin can change it, so a new pick waits until it ends.");
  s.btn().click();
  s.yes().click();
  await tick();
  assert.equal(s.plays().length, 1);
  assert.equal(s.plays()[0].body.replace, undefined);
  assert.equal(s.askBox(), null, "no confirm offered");
  assert.equal(s.P.msg.textContent, "This pad is already playing from the library - stop it first.");
  assert.equal(s.btn().disabled, false);
});

test("a 📼 queue on the pad (yours): the confirm says it ends the queue; a paid pick says 'instead for N PAT'; your own play has no 'started by' line", async () => {
  const s = sheet({ perHour: 1000, onPad: { title: "The Show — S1E1 Pilot", queue: true, left: 2, by: "viewer-fable", mine: true, can_replace: true } });
  s.flow.info();
  await tick();
  await s.pick();
  assert.equal(s.btn().textContent, "▶ Play this instead for 2,000 PAT");
  s.btn().click();
  const lines = s.askBox().querySelectorAll("p").map((p) => p.textContent);
  assert.equal(lines[0], "Play “Night of the Living Dead” on Night Orchard’s stage instead of “The Show — S1E1 Pilot”?");
  assert.equal(lines[1], "It ends the 📼 queue that’s playing too (2 more titles after this one).");
  assert.ok(!lines.some((l) => /was started by/.test(l)), "your own: no 'started by'");
  assert.equal(lines[2], "It costs 2,000 PAT, taken now. If it never gets on the stage, it all comes back.");
  assert.equal(s.yes().textContent, "Yes, play it instead for 2,000 PAT");
  s.yes().click();
  await tick();
  assert.deepEqual([s.plays()[0].body.replace, s.plays()[0].body.price], [true, 2000], "an older server (no slot_id in on_pad): replace true");
});

test("the source: one POST per tap, replace only after the yes, the server's refusals handled, strings from en.json", () => {
  assert.doesNotThrow(() => new vm.Script(SRC));
  assert.match(SRC, /if \(rep\) body\.replace = replaceArg\(\);/);
  assert.match(SRC, /if \(insteadAgain\(e, body\)\) \{ say\(changedLine\(e\)\); btn\.disabled = false; play\(btn, confirmed\); return; \}/);
  assert.match(SRC, /if \(insteadAgain\(e, body\)\) \{ say\(changedLine\(e\)\); btn\.disabled = false; startQueue\(btn, body, pv, confirmedEst\); return; \}/);
  assert.match(SRC, /var again = d\.code === 'replace_changed' \|\| \(!body\.replace && \/\^busy_\/\.test\(String\(d\.code \|\| ''\)\)\);/, "only a busy refusal / a changed stage that says you may");
  assert.match(SRC, /if \(!d\.can_replace \|\| !d\.playing \|\| !again\) return false;/);
  assert.match(SRC, /noteOnPad\(j\.on_pad \|\| null\);/);
  assert.equal((SRC.match(/\/api\/medialib\/stop/g) || []).length, 0, "the sheet never sends a ⏹");
});

test("what's on changed between the confirm and the yes (replace_changed): asked again, naming what's on NOW - the yes names its slot; never a title nobody agreed to take off", async () => {
  const s = sheet({ onPad: ON, play: [
    { status: 409, j: { ok: false, error: "What's on this pad's stage has just changed - it's \"Carnival of Souls (1962)\" now. Confirm again to play yours instead of it.", code: "replace_changed",
                        can_replace: true, playing: "Carnival of Souls (1962)", playing_queue: false, playing_left: 0, playing_by: "moss-harbor", playing_mine: false,
                        playing_slot: "11111111-2222-4333-8444-555555555555" } },
    { status: 200, j: { ok: true, title: "Night of the Living Dead (1968)", price: 0, replaced: { title: "Carnival of Souls (1962)", queue: false } } }] });
  s.flow.info();
  await tick();
  await s.pick();
  s.btn().click();
  s.yes().click();
  await tick();
  assert.equal(s.plays().length, 1);
  assert.equal(s.plays()[0].body.replace, ON.slot_id);
  const box = s.askBox();
  assert.ok(box, "asked again");
  const lines = box.querySelectorAll("p").map((p) => p.textContent);
  assert.equal(lines[0], "Play “Night of the Living Dead” on Night Orchard’s stage instead of “Carnival of Souls (1962)”?");
  assert.equal(lines[1], "“Carnival of Souls (1962)” was started by moss-harbor - it stops for everyone watching.", "who started what's on NOW");
  assert.equal(s.now().textContent, "📼 Now on Night Orchard: “Carnival of Souls (1962)” - ▶ swaps it for your pick.");
  assert.equal(s.P.msg.textContent, "What’s on Night Orchard’s stage just changed - it’s “Carnival of Souls (1962)” now.", "the sheet says why it asks again (en.json)");
  assert.ok(EN["js.plex.now_changed"]);
  assert.equal(s.plays().length, 1, "nothing more sent before the new yes");
  s.yes().click();
  await tick();
  assert.equal(s.plays().length, 2);
  assert.equal(s.plays()[1].body.replace, "11111111-2222-4333-8444-555555555555", "the yes names what's on now");
  assert.match(s.P.msg.textContent, /instead of “Carnival of Souls \(1962\)”/);
});

test("a replace that fails any other way (control_denied, the encoder): the sheet asks what's on again - never a stale 'Now on … ▶ Play this instead'", async () => {
  let state = ON;
  const s = sheet({ onPad: () => state, play: [{ status: 403, j: { ok: false, error: "Only whoever started it, the pad's owner or an admin can control it.", code: "control_denied" } }] });
  s.flow.info();
  await tick();
  await s.pick();
  assert.equal(s.btn().textContent, "▶ Play this instead");
  const mines = () => s.calls.filter((c) => c.url.startsWith("/api/medialib/mine")).length;
  const before = mines();
  state = { title: "Carnival of Souls (1962)", queue: false, left: 0, by: "moss-harbor", mine: false, can_replace: false };   // someone else's now
  s.btn().click();
  s.yes().click();
  await tick(12);
  assert.equal(s.plays().length, 1);
  assert.equal(mines(), before + 1, "asked /mine again");
  assert.equal(s.P.msg.textContent, "Only whoever started it, the pad's owner or an admin can control it.");
  assert.equal(s.now().textContent, "📼 Now on Night Orchard: “Carnival of Souls (1962)” - only whoever started it, the pad’s owner or an admin can change it, so a new pick waits until it ends.");
  assert.equal(s.btn().textContent, "▶ Play on Night Orchard", "the plain button now");
  assert.equal(s.askBox(), null);
});
