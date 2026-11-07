"use strict";
// upnext3 (1.99ali): the owner's answers of 2026-11-07 in the pages - the 📼 sheet (public/js/plex-play.js, the test/upnext2-sheet.test.js DOM):
// "+ Line up my queue" behind someone else's running queue (item 5), your place in the line, a booking due next and a paused queue (item 10),
// ▶ Play this instead keeps the line waiting (item 7); the 📼 player's line (pad-plexq.js: who's lined up, ✕ by id, ⏹ says what starts next);
// the Cut confirm (stage-room.js); the schedule / Your bookings' "waiting for the current title to finish"; the strings (en.json, points)
//   node --test test/upnext3-sheet.test.js
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
  // (review fixes: <details> open state, focus kept across a redraw)
  get open() { return "open" in this.attrs; } set open(v) { if (v) this.attrs.open = ""; else delete this.attrs.open; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  getClientRects() { return this.isConnected ? [{}] : []; }
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

// ── the sheet against a stubbed site (the plexreplace-ui.test.js harness + /queue/after, /queue/edit, mine().queues) ──
const MOVIE = { key: "501", type: "movie", title: "Night of the Living Dead", year: 1968, duration: 5760, audio: [], subs: [], summary: "They're coming." };
function sheet({ onPad = null, queues = [], after = [], edit = [], perHour = 0, list = null } = {}) {
  const doc = mkDoc();
  const calls = [];
  const answers = { after: after.slice(), edit: edit.slice() };
  const fetchStub = async (url, o = {}) => {
    const method = (o.method || "GET").toUpperCase(), body = o.body ? JSON.parse(o.body) : null;
    calls.push({ url, method, body });
    let status = 200, j = { ok: true };
    if (url.startsWith("/api/medialib/mine")) j = { ok: true, streams: { used: 1, max: 2 }, daily_left: null, queues, on_pad: typeof onPad === "function" ? onPad() : onPad };
    else if (url.startsWith("/api/medialib/item/")) j = { ok: true, item: MOVIE };
    else if (url === "/api/medialib/queue/after") { const a = answers.after.shift() || { status: 200, j: { ok: true, after: true, items: 1, behind: "Charade (1963)" } }; status = a.status; j = a.j; }
    else if (url === "/api/medialib/queue/edit") { const a = answers.edit.shift() || { status: 200, j: { ok: true, items: 4 } }; status = a.status; j = a.j; }
    return { ok: status < 400, status, json: async () => j };
  };
  const store = list ? { "patv.plexList": JSON.stringify(list) } : {};
  const win = { document: doc, fetch: fetchStub, sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); } }, setTimeout, clearTimeout, console, Intl, Date, Math, JSON };
  win.window = win;
  vm.runInNewContext(SRC, win, { filename: "plex-play.js" });
  const host = doc.body.appendChild(doc.createElement("div"));
  win.PATVPlexPlay.build(host, { note: "Free for you." });
  const started = [];
  const flow = win.PATVPlexPlay.mount(host, { roomId: () => "Night.Orchard", roomTitle: () => "Night Orchard", free: perHour === 0, perHour, quality: 720, queues: true,
                                              inlineConfirm: true, balance: () => "1,000", onStarted: (j) => started.push(j) });
  const res = host.querySelector('[data-px="results"]');
  const pick = async () => {
    res.innerHTML = '<button type="button" class="px-it" data-key="501"><b>Night of the Living Dead</b></button>';
    res.querySelector(".px-it").click();
    await tick();
  };
  const P = { pick: host.querySelector('[data-px="pick"]'), msg: host.querySelector('[data-px="msg"]'), info: host.querySelector('[data-px="info"]') };
  const add = () => P.pick.querySelector("[data-add]");
  const askBox = () => P.pick.querySelector(".px-ask");
  const yes = () => askBox().querySelector("button.primary");
  const posts = (u) => calls.filter((c) => c.url === u);
  return { flow, calls, posts, pick, P, add, askBox, yes, started, store, play: () => P.pick.querySelector("[data-play]") };
}
const SINGLE = { title: "Charade (1963)", queue: false, left: 0, by: "cedar-fable", mine: false, can_replace: true, slot_id: "6f1c2e0a-0b1d-4c55-9a7e-2d3f4a5b6c7d", can_after: true };

// ───────────────────────── upnext3 (1.99ali): the sheet, the 📼 player, the Cut confirm, the schedule ─────────────────────────
const QUEUE_ON = { title: "The Show — S1E2 Second", queue: true, left: 1, by: "cedar-fable", mine: false, can_replace: false, slot_id: null, can_after: true };
const NEW_KEYS = ["js.plex.qn_held", "js.plex.qn_held_cancelled", "js.plex.now_on_booking", "js.plex.now_on_after_q", "js.plex.after_held", "js.plex.after_mine_place",
                  "js.plex.instead_after", "js.plex.b_waits", "js.plex.q_add_line", "js.plex.q_add_line_title", "js.plex.q_added_line", "js.plex.q_line_cost",
                  "js.plexq.line_n", "js.plexq.line_booking", "js.plexq.line_resume", "js.plexq.line_more", "js.plexq.q_stop_next", "js.stage.room.q_cut_next",
                  "js.stage.room.q_cut_ban_next", "js.stage.lib_wait", "js.sched.lib_wait", "pad.sched.lib_wait", "pad.golive.lib_wait"];

test("5: behind someone else's RUNNING queue the pick offers \"+ Line up my queue\" (not + My list) - one tap = ONE POST /queue/after with the pick's choices; it says where you are in line", async () => {
  const s = sheet({ onPad: QUEUE_ON, after: [{ status: 200, j: { ok: true, after: true, items: 1, behind: "The Show — S1E2 Second", behind_queue: true, place: 2, line: 2 } }] });
  s.flow.info(); await tick();
  await s.pick();
  assert.equal(s.add().textContent, "+ Line up my queue");
  assert.equal(s.add().getAttribute("title"), "Your own queue, charged to you - it plays when the queue that’s on ends");
  assert.equal(s.play().disabled, true, "▶ can't replace it (someone else's)");
  assert.ok(s.add().classList.contains("primary"), "the way forward is the primary button");
  assert.match(s.P.pick.querySelector("[data-now]").textContent, /from someone’s queue - you can’t change it, but \+ Line up my queue plays yours when that queue ends\./);
  s.add().click(); await tick();
  const p = s.posts("/api/medialib/queue/after");
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body, { room: "Night.Orchard", key: "501", scope: "episode", offset: 0, quality: 720, audio: null, sub: null });
  assert.equal(s.posts("/api/medialib/queue/edit").length, 0, "never into their queue");
  // (review ux 6: it plays when that queue ends, not after the title on now)
  assert.equal(s.P.msg.textContent, "Lined up - your queue plays when the queue that’s on ends (1 more after “The Show — S1E2 Second”): 2 of 2 in line.");
});

test("5: a paid line-up confirms the server's estimate in points, charged to you (nothing taken until it starts); yes = the same POST with that estimate", async () => {
  const s = sheet({ onPad: QUEUE_ON, perHour: 1000, after: [{ status: 400, j: { ok: false, error: "x", code: "estimate", estimate: 2000 } },
                                                           { status: 200, j: { ok: true, after: true, items: 1, behind: "The Show — S1E2 Second", behind_queue: true, place: 1, line: 1 } }] });
  s.flow.info(); await tick();
  await s.pick();
  s.add().click(); await tick();
  assert.equal(s.askBox().querySelector("p").textContent, "Line up your own queue to play when “The Show — S1E2 Second”’s queue ends? About 2,000 points, charged to you as it plays (only what actually plays) - nothing is taken until it starts.");
  s.yes().click(); await tick();
  const p = s.posts("/api/medialib/queue/after");
  assert.deepEqual([p.length, p[1].body.estimate], [2, 2000]);
});

test("5: your place in a longer line (✕ takes yours out); a full line / a queue you may grow keep their old buttons", async () => {
  const s = sheet({ onPad: { ...QUEUE_ON, after: { count: 1, mine: true, place: 3, line: 4 } } });
  s.flow.info(); await tick();
  await s.pick();
  const line = s.P.pick.querySelector("[data-now]");
  assert.match(line.textContent, /Your queue is 3 of 4 in line after the queue that’s on \(1 more after this title\)\./, "(review ux 6)");
  assert.ok(line.querySelector("[data-after-x]"));
  const full = sheet({ onPad: { ...QUEUE_ON, can_after: false, after: { count: 1, mine: false, place: null, line: 5 } } });
  full.flow.info(); await tick();
  await full.pick();
  assert.equal(full.add().textContent, "+ My list");
  const grow = sheet({ onPad: { ...QUEUE_ON, mine: true, can_add: true, can_replace: true, slot_id: "q-slot-1" }, queues: [{ id: 7, room: "Night.Orchard", state: "active" }] });
  grow.flow.info(); await tick();
  await grow.pick();
  assert.equal(grow.add().textContent, "+ Add to the queue that’s playing");
});

test("10: a booking due next - the pick says a booked stream starts right after the title on, ▶ waits (no replace); your paused queue says it carries on; a booking's preview says it waits for a title still on", async () => {
  const at = Date.UTC(2026, 10, 7, 21, 0);
  const s = sheet({ onPad: { ...SINGLE, can_replace: false, slot_id: null, booking: { at, mine: false } } });
  s.flow.info(); await tick();
  await s.pick();
  assert.match(s.P.pick.querySelector("[data-now]").textContent, /^📼 Now on Night Orchard: “Charade \(1963\)” - a stream booked for .+ starts right after it, so a new pick waits until then\.$/);
  assert.equal(s.play().disabled, true);
  const h = sheet({ onPad: { ...QUEUE_ON, can_after: false, after: { count: 2, mine: true, place: 2, line: 2, held: true } },
                    queues: [{ id: 9, room: "Night.Orchard", state: "after", held: true, notice: "held" }] });
  h.flow.info(); await tick();
  await h.pick();
  // (review ux 8: said once - the pick's line, not the info line too, never "only whoever started it…")
  assert.match(h.P.pick.querySelector("[data-now]").textContent, /^📼 Now on Night Orchard: “The Show — S1E2 Second” - your paused queue carries on right after it\. ✕ Take them out$/);
  assert.doesNotMatch(h.P.info.textContent, /paused/);
  assert.match(SRC, /esc\(_t\('js\.plex\.b_waits', 'If something from the library is still on then, yours waits for that title to finish and starts right after it\.'\)\)/);
});

test("7: ▶ Play this instead's confirm says what's lined up keeps waiting (behind yours)", async () => {
  const s = sheet({ onPad: { ...SINGLE, after: { count: 1, mine: false, place: null, line: 2 } } });
  s.flow.info(); await tick();
  await s.pick();
  s.play().click(); await tick();
  assert.match(s.askBox().textContent, /The 2 lined up after it keep waiting - they play after yours\./, "(review ux 13: the plural)");
});

function player(j, { confirmAns = true } = {}) {
  const src = read("public", "js", "pad-plexq.js");
  const doc = mkDoc();
  const box = doc.body.appendChild(doc.createElement("div"));
  box.id = "rmPlexQ"; box.setAttribute("data-room", "Night.Orchard");
  doc.getElementById = (id) => (id === "rmPlexQ" ? box : null);
  doc.addEventListener = () => {}; doc.hidden = false; doc.activeElement = null;
  const calls = [], asked = [];
  const win = { document: doc, console, Date, Math, JSON, confirm: (m) => { asked.push(m); return confirmAns; }, setTimeout: () => 0, setInterval: () => 0, clearInterval() {},
                fetch: async (url, o = {}) => { calls.push({ url, method: (o.method || "GET").toUpperCase(), body: o.body ? JSON.parse(o.body) : null });
                                               return { ok: true, status: 200, json: async () => (url.startsWith("/api/medialib/player") ? j : { ok: true }) }; } };
  win.window = win;
  vm.runInNewContext(src, win, { filename: "pad-plexq.js" });
  return { box, calls, asked };
}
const BASE = { ok: true, on: true, room: "Night.Orchard", title: "The Show — S1E2 Second", state: "playing", position: 10, duration: 2400, by: "cedar-fable", can_control: false,
               queue: { id: 3, pos: 1, count: 3, now: null, next: [{ key: "913", type: "episode", show: "The Show", season: 1, episode: 3, title: "Third", duration: 2400, index: 2 }], left_sec: 4800 }, log: [] };
const LINE = [
  { id: null, kind: "booking", count: 1, next: [{ key: "501", type: "movie", title: "Night of the Living Dead", year: 1968, duration: 5760 }], mine: false, can_withdraw: false, at: Date.UTC(2026, 10, 7, 21, 0) },
  { id: 41, kind: "after", count: 2, next: [{ key: "500", type: "movie", title: "Charade", year: 1963, duration: 6780 }, { key: "502", type: "movie", title: "Carnival of Souls", year: 1962, duration: 4680 }], mine: false, can_withdraw: false },
  { id: 42, kind: "after", count: 1, next: [{ key: "911", type: "episode", show: "The Show", season: 1, episode: 1, title: "Pilot", duration: 2400 }], mine: true, can_withdraw: true, by: "me" },
];

test("5: the 📼 player lists who's lined up next, in order, behind a running queue too - titles for everyone (a booking's time), names only where the server sends them, ✕ only on rows you may take out -> ONE POST {room, id}", async () => {
  const p = player({ ...BASE, line: LINE });
  await tick();
  const sec = p.box.querySelector("details.pq-line");
  assert.ok(sec, "behind a running queue");
  assert.equal(sec.querySelector("summary").textContent, "Lined up next (3)");
  const items = sec.querySelectorAll("li");
  assert.equal(items.length, 3);
  // (review ux 13: the viewer's own clock, as the sheet says it - 12 h here)
  assert.equal(items[0].textContent, "Night of the Living Dead (1968) · 📅 booked for " + new Date(LINE[0].at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  assert.equal(items[1].textContent, "Charade (1963) +1 more");
  assert.equal(items[2].textContent.replace("✕", ""), "The Show — S1E1 Pilot · yours", "(review ux 13: your own row)");
  assert.equal(sec.querySelectorAll("[data-after-x]").length, 1, "✕ only on your own");
  assert.doesNotMatch(items[1].textContent, /added by/);
  sec.querySelector('[data-after-x="42"]').click(); await tick();
  const c = p.calls.filter((x) => x.url === "/api/medialib/queue/after/cancel");
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].body, { room: "Night.Orchard", id: 42 });
  const r = player({ ...BASE, line: [{ id: 50, kind: "resume", count: 2, next: [{ key: "912", type: "episode", show: "The Show", season: 1, episode: 2, title: "Second", duration: 2400 }], mine: false, can_withdraw: false }] });
  await tick();
  assert.match(r.box.querySelector("details.pq-line").querySelector("li").textContent, /The Show — S1E2 Second \+1 more · ⏸ carries on after the booking/);
});

test("7: the player's ⏹ says what's lined up next starts right after it (its own station break); nothing lined up: as before", async () => {
  const p = player({ ...BASE, can_control: true, line: LINE });
  await tick();
  p.box.querySelector('[data-q="stop"]').click(); await tick();
  assert.deepEqual(p.asked, ["Stop it? What’s lined up next starts right after (its own station break first)."]);
  assert.equal(p.calls.filter((x) => x.url === "/api/medialib/stop").length, 1);
  const q = player({ ...BASE, can_control: true });
  await tick();
  q.box.querySelector('[data-q="stop"]').click(); await tick();
  assert.deepEqual(q.asked, ["Stop the queue and end the library slot?"]);
});

test("7: a moderator's Cut of a 📼 slot with someone lined up says it starts next (✕ in the 📼 player clears it first); a cut + ban says it's cancelled too - coming.queued from the server", () => {
  const src = read("public", "js", "stage-room.js");
  // (review fixes: the condition is coming.line > 0 now - the "ux 2 / 3" test below)
  assert.match(src, /_t\('js\.stage\.room\.q_cut_ban_next', 'What’s lined up after it from the library is cancelled too\.'\)/);
  assert.match(src, /_t\('js\.stage\.room\.q_cut_next', 'What’s lined up after it from the library starts next - take it out in the 📼 player first to leave the stage empty\.'\)/);
  assert.match(src, /n && x\.queued === true \? \{ ends: ends, next: n, at: at, queued: true \}/);
  assert.match(read("medialib.js"), /if \(out\.next && headNext && out\.next === headNext\) out\.queued = true;/);
});

test("10: the schedule (server render + its poll), the pad page's coming-up list and /stage's Your bookings say a 📼 booking waits for the current title to finish", () => {
  assert.match(read("views", "partials", "room-schedule.ejs"), /<% if \(r\.lib_wait\) \{ %><span class="tg pend"><%- t\('pad\.sched\.lib_wait'\) %><\/span><% \} %>/);
  assert.match(read("public", "js", "room-schedule.js"), /if \(r\.lib_wait\) s\.appendChild\(el\('span', 'tg pend', typeof __t === 'function' \? __t\('js\.sched\.lib_wait'/);
  assert.match(read("views", "room.ejs"), /<%- u\.lib_wait \? ' · ' \+ t\('pad\.golive\.lib_wait'\) : '' %>/);
  assert.match(read("public", "js", "stage-book.js"), /\(x\.lib_wait \? ' · <i>' \+ esc\(_t\('js\.stage\.lib_wait', '⏳ Waiting for the current title to finish - it starts right after it'\)\) \+ '<\/i>' : ''\)/);
  for (const [f, re] of [[["views", "room.ejs"], /plex-play\.js\?v=4"/], [["views", "stageBook.ejs"], /plex-play\.js\?v=4"/], [["views", "room.ejs"], /pad-plexq\.js\?v=7"/],
                         [["views", "room.ejs"], /stage-room\.js\?v=26"/], [["views", "home.ejs"], /stage-room\.js\?v=26"/], [["views", "stageBook.ejs"], /stage-book\.js\?v=15"/],
                         [["views", "partials", "room-schedule.ejs"], /room-schedule\.js\?v=7"/]]) assert.match(read(...f), re, f.join("/"));
});

test("strings: every new one is in en.json (in the source's words), none says PAT", () => {
  const all = [SRC, read("public", "js", "pad-plexq.js"), read("public", "js", "stage-room.js"), read("public", "js", "stage-book.js"), read("public", "js", "room-schedule.js")].join("\n");
  for (const k of NEW_KEYS) {
    assert.ok(EN[k], k);
    assert.doesNotMatch(EN[k], /\bPAT\b/, k + ": points, not PAT");
    if (k.startsWith("js.")) {
      const m = all.match(new RegExp("_?_t\\('" + k.replace(/\./g, "\\.") + "', '((?:[^'\\\\]|\\\\.)*)'"));
      assert.ok(m, k + " used in the client");
      assert.equal(m[1].replace(/\\'/g, "'"), EN[k], k + ": the source's default = en.json");
    }
  }
});


// ───────────────────────── upnext3 review fixes (1.99ali): the UX review in the pages - each failed on 792ccd1b ─────────────────────────
const LIST = [{ key: "500", label: "Charade (1963)", duration: 6780 }, { key: "502", label: "Carnival of Souls (1962)", duration: 4680 }];
const NEW_KEYS2 = ["js.plex.q_line_list", "js.plex.q_line_list_cost", "js.plex.q_added_line_q", "js.plex.after_mine_q", "js.plex.after_mine_place_q", "js.plex.line_full",
                   "js.plex.now_on_held", "js.plex.held_x_ask", "js.plex.held_x_ask_paid", "js.plex.ask_take_out", "js.plex.held_x_done", "js.plex.now_on_booking_mine",
                   "js.plex.instead_after_n", "js.plexq.line_booked_by", "js.plexq.line_yours", "js.plexq.after_x_t", "js.plexq.q_stop_next_nb", "js.plexq.q_held_x",
                   "js.plexq.q_held_x_paid", "js.stage.room.q_cut_next_booking", "js.stage.room.q_cut_ban_kept", "js.sched.lib_after", "js.sched.lib_about",
                   "pad.sched.lib_after", "pad.sched.lib_about", "pad.golive.lib_after", "js.stage.lib_after", "js.stage.lib_after_about"];

test("ux 4: behind someone else's title / running queue, my list's button lines it up - \"+ Line up my list\" = ONE POST /queue/after with the list (a paid one confirms in points first), never /queue/start; your own (you may replace it): ▶ Play my list as before", async () => {
  const s = sheet({ onPad: QUEUE_ON, list: LIST, perHour: 1000, after: [{ status: 400, j: { ok: false, error: "x", code: "estimate", estimate: 4000 } },
                                                                        { status: 200, j: { ok: true, after: true, items: 2, behind: "The Show — S1E2 Second", behind_queue: true, behind_left: 1, place: 1, line: 1 } }] });
  s.flow.info(); await tick();
  const lp = () => s.P.pick.parentNode.querySelector("[data-lplay]");
  assert.equal(lp().textContent, "+ Line up my list");
  lp().click(); await tick();
  const ask = s.P.pick.parentNode.querySelector(".px-ask");
  assert.equal(ask.querySelector("p").textContent, "Line up your list (2 titles) as your own queue? It plays when what’s on ends - about 4,000 points, charged to you as it plays (only what actually plays); nothing is taken until it starts.");
  ask.querySelector("button.primary").click(); await tick();
  const p = s.posts("/api/medialib/queue/after");
  assert.deepEqual(p.map((x) => x.body), [{ room: "Night.Orchard", keys: ["500", "502"], quality: 720 }, { room: "Night.Orchard", keys: ["500", "502"], quality: 720, estimate: 4000 }]);
  assert.equal(s.posts("/api/medialib/queue/start").length + s.posts("/api/medialib/queue/preview").length, 0, "never a start of its own");
  assert.equal(s.P.msg.textContent, "Lined up - your queue plays when the queue that’s on ends (1 more after “The Show — S1E2 Second”): 1 of 1 in line.");
  assert.equal(s.store["patv.plexList"], "[]", "the list is lined up: it empties");
  const own = sheet({ onPad: { ...QUEUE_ON, mine: true, can_replace: true, slot_id: "q-slot-1", can_add: true }, list: LIST });
  own.flow.info(); await tick();
  assert.equal(own.P.pick.parentNode.querySelector("[data-lplay]").textContent, "▶ Play my list");
});

test("ux 7: a full line says so (not only the permissions sentence)", async () => {
  const s = sheet({ onPad: { ...QUEUE_ON, can_after: false, line_full: true, line_max: 5, after: { count: 1, mine: false, place: null, line: 5 } } });
  s.flow.info(); await tick();
  await s.pick();
  assert.match(s.P.pick.querySelector("[data-now]").textContent, /5 people are lined up after it already - try again when one has started\.$/);
});

test("ux 8: your paused queue's ✕ in the sheet asks first (a paid one: what it paid for isn't refunded), then says nothing more is charged", async () => {
  const s = sheet({ onPad: { ...QUEUE_ON, can_after: false, after: { count: 2, mine: true, place: 2, line: 2, held: true, paid: true } },
                    queues: [{ id: 9, room: "Night.Orchard", state: "after", held: true, notice: "held" }] });
  s.flow.info(); await tick();
  await s.pick();
  s.P.pick.querySelector("[data-after-x]").click(); await tick();
  assert.equal(s.posts("/api/medialib/queue/after/cancel").length, 0, "asks first");
  const ask = s.P.pick.parentNode.querySelector(".px-ask");
  assert.equal(ask.querySelector("p").textContent, "Take your paused queue out? It won’t carry on after the booked stream, and nothing more is charged - what it already paid for isn’t refunded.");
  assert.equal(ask.querySelector("button.primary").textContent, "Yes, take it out");
  ask.querySelector("button.primary").click(); await tick();
  assert.equal(s.posts("/api/medialib/queue/after/cancel").length, 1);
  assert.equal(s.P.msg.textContent, "Taken out - nothing more is charged.");
  // (an ordinary row of yours: one tap, as before)
  const r = sheet({ onPad: { ...QUEUE_ON, after: { count: 1, mine: true, place: 1, line: 1 } } });
  r.flow.info(); await tick();
  await r.pick();
  r.P.pick.querySelector("[data-after-x]").click(); await tick();
  assert.equal(r.posts("/api/medialib/queue/after/cancel").length, 1);
});

test("ux 13: your own booking due next says it's yours; behind a running queue your titles' line says it plays when that queue ends", async () => {
  const at = Date.UTC(2026, 10, 7, 21, 0);
  const s = sheet({ onPad: { ...SINGLE, can_replace: false, slot_id: null, booking: { at, mine: true } } });
  s.flow.info(); await tick();
  await s.pick();
  assert.match(s.P.pick.querySelector("[data-now]").textContent, /^📼 Now on Night Orchard: “Charade \(1963\)” - your stream booked for .+ starts right after it, so a new pick waits until then\.$/);
  const m = sheet({ onPad: { ...QUEUE_ON, left: 3, after: { count: 1, mine: true, place: 1, line: 1 } } });
  m.flow.info(); await tick();
  await m.pick();
  assert.match(m.P.pick.querySelector("[data-now]").textContent, /Your queue plays when the queue that’s on ends \(3 more after this title\)\./);
  const one = sheet({ onPad: { ...SINGLE, after: { count: 1, mine: false, place: null, line: 1 } } });
  one.flow.info(); await tick();
  await one.pick();
  one.play().click(); await tick();
  assert.match(one.askBox().textContent, /What’s lined up after it keeps waiting - it plays after yours\./);
});

// the player with a clock (its poll is guarded for 1.5 s) and answers that change
function player2(answers, { confirmAns = true } = {}) {
  const src = read("public", "js", "pad-plexq.js");
  const doc = mkDoc();
  const box = doc.body.appendChild(doc.createElement("div"));
  box.id = "rmPlexQ"; box.setAttribute("data-room", "Night.Orchard");
  doc.getElementById = (id) => (id === "rmPlexQ" ? box : null);
  doc.addEventListener = () => {}; doc.hidden = false; doc.activeElement = null;
  const clock = { t: Date.UTC(2026, 10, 7, 20, 0) };
  class D extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.t); } static now() { return clock.t; } }
  const calls = [], asked = [];
  let k = 0;
  const win = { document: doc, console, Date: D, Math, JSON, confirm: (m) => { asked.push(m); return confirmAns; }, setTimeout: () => 0, setInterval: () => 0, clearInterval() {},
                fetch: async (url, o = {}) => { calls.push({ url, method: (o.method || "GET").toUpperCase(), body: o.body ? JSON.parse(o.body) : null });
                                               const j = url.startsWith("/api/medialib/player") ? answers[Math.min(k++, answers.length - 1)] : { ok: true };
                                               return { ok: true, status: 200, json: async () => j }; } };
  win.window = win;
  vm.runInNewContext(src, win, { filename: "pad-plexq.js" });
  const again = async () => { clock.t += 2000; win.PATVPlexQ.poll(); await tick(); };
  return { box, calls, asked, doc, again };
}

test("ux 9: the player keeps each list's own open state and focus across a redraw - collapsing \"Lined up next\" and keeping focus on it survives a change in the line (focus never jumps to Up next)", async () => {
  const LINE2 = LINE.slice(0, 2);
  const p = player2([{ ...BASE, line: LINE }, { ...BASE, line: LINE2 }]);
  await tick();
  const det = p.box.querySelector("details.pq-line"), up = p.box.querySelector("details.pq-upnext");
  assert.ok(det && up, "two lists, told apart");
  assert.deepEqual([det.open, up.open], [true, false]);
  det.open = false;
  up.open = true;
  p.doc.activeElement = det.querySelector("summary");
  await p.again();
  const det2 = p.box.querySelector("details.pq-line"), up2 = p.box.querySelector("details.pq-upnext");
  assert.notEqual(det2, det, "redrawn");
  assert.equal(det2.querySelector("summary").textContent, "Lined up next (2)");
  assert.deepEqual([det2.open, up2.open], [false, true], "each keeps its own state");
  assert.equal(p.doc.active, det2.querySelector("summary"), "focus back on the line's summary");
});

test("ux 10 / 13: each ✕ in the line names its first title; a booking says booked by, a paused queue started by, yours says yours; the ⏹ confirm drops the station break when the pad has none; a paused queue's ✕ asks in its own words", async () => {
  const L3 = [{ ...LINE[0], by: "aster-fable" }, { id: 50, kind: "resume", count: 2, next: [{ key: "912", type: "episode", show: "The Show", season: 1, episode: 2, title: "Second", duration: 2400 }],
               mine: false, can_withdraw: true, by: "rowan-fable", paid: true }, { ...LINE[1], can_withdraw: true, by: "willow-fable" }, LINE[2]];
  const p = player2([{ ...BASE, can_control: true, station_break: false, line: L3 }]);
  await tick();
  const li = p.box.querySelector("details.pq-line").querySelectorAll("li");
  assert.match(li[0].textContent, /· booked by aster-fable$/);
  assert.match(li[1].textContent, /· ⏸ carries on after the booking · started by rowan-fable/);
  assert.match(li[2].textContent, /· added by willow-fable/);
  assert.match(li[3].textContent, /· yours/);
  assert.equal(p.box.querySelector('[data-after-x="41"]').getAttribute("aria-label"), "Take out “Charade (1963)”");
  assert.equal(p.box.querySelector('[data-after-x="50"]').getAttribute("aria-label"), "Take out “The Show — S1E2 Second”");
  p.box.querySelector('[data-q="stop"]').click(); await tick();
  assert.deepEqual(p.asked, ["Stop it? What’s lined up next starts right after."]);
  p.box.querySelector('[data-after-x="50"]').click(); await tick();
  assert.equal(p.asked[1], "Take this paused queue out? It won’t carry on after the booking, and nothing more is charged - what it already paid for isn’t refunded.");
  assert.deepEqual(p.calls.filter((x) => x.url === "/api/medialib/queue/after/cancel").map((x) => x.body), [{ room: "Night.Orchard", id: 50 }]);
});

test("ux 2 / 3: the Cut confirm warns whenever anyone is lined up (coming.line - a queue with titles left too): a booking first says it starts next; a cut + ban says the picks are cancelled and what still starts", () => {
  const src = read("public", "js", "stage-room.js");
  assert.match(src, /if \(act === 'cut' && cs && cs\.lib && cs\.id === b\.getAttribute\('data-id'\) && coming && coming\.line > 0\) \{/);
  assert.match(src, /_t\('js\.stage\.room\.q_cut_next_booking', 'A stream booked for this time starts next on this stage\.'\)/);
  assert.match(src, /_t\('js\.stage\.room\.q_cut_ban_kept', 'A booked stream that’s due, or a queue paused for one, still starts next\.'\)/);
  assert.match(src, /line: Math\.max\(0, Math\.min\(99, Math\.floor\(Number\(x\.line\)\) \|\| 0\)\), line_head: \['booking', 'resume', 'after'\]\.indexOf\(x\.line_head\) >= 0 \? x\.line_head : null,/);
  const adm = read("public", "js", "stage-admin.js");
  assert.match(adm, /'" data-lib="1"' : ''\) \+ '>✂ Cut<\/button>'/);
  assert.match(adm, /Cut this 📼 slot\? Whoever is lined up after it from the library starts next\./);
  assert.match(adm, /Cut this 📼 slot and ban them from booking\? The picks lined up after it are cancelled; a booking that is due still starts\./);
  assert.match(read("views", "stageAdmin.ejs"), /stage-admin\.js\?v=6"/);
});

test("ux 12: a waiting booking shows 'After the current title · about <its end>' instead of its old time - the schedule (server render + its poll), the pad page's coming-up list, Your bookings", () => {
  assert.match(read("views", "partials", "room-schedule.ejs"), /<% if \(r\.lib_wait\) \{ %><%- t\('pad\.sched\.lib_after'\) %><% if \(r\.lib_wait\.ends_at\) \{ %> · <%- t\('pad\.sched\.lib_about'\) %> <time data-ts="<%= r\.lib_wait\.ends_at %>" data-fmt="t"/);
  const rs = read("public", "js", "room-schedule.js");
  assert.match(rs, /if \(r\.lib_wait\) \{/);
  assert.match(rs, /T\('js\.sched\.lib_after', 'After the current title'\)/);
  assert.match(rs, /T\('js\.sched\.lib_about', 'about'\)/);
  assert.match(read("views", "room.ejs"), /u\.lib_wait \? t\('pad\.golive\.lib_after'\) \+ \(u\.lib_wait\.ends_at \? ' ~' \+ /);
  const sb = read("public", "js", "stage-book.js");
  assert.match(sb, /x\.lib_wait \? \(x\.lib_wait\.ends_at \? esc\(_t\('js\.stage\.lib_after_about', 'after the current title \(about \{time\}\)', \{ time: hm\(x\.lib_wait\.ends_at\) \}\)\) : esc\(_t\('js\.stage\.lib_after', 'after the current title'\)\)\) : when\(x\.start_at\)/);
});

test("review strings: every new one is in en.json (in the source's words), none says PAT; the line's own changed strings too", () => {
  const all = [SRC, read("public", "js", "pad-plexq.js"), read("public", "js", "stage-room.js"), read("public", "js", "stage-book.js"), read("public", "js", "room-schedule.js")].join("\n");
  for (const k of NEW_KEYS2) {
    assert.ok(EN[k], k);
    assert.doesNotMatch(EN[k], /\bPAT\b/, k + ": points, not PAT");
    if (k.startsWith("js.")) {
      const m = all.match(new RegExp("_?_?T?t?\\('" + k.replace(/\./g, "\\.") + "', '((?:[^'\\\\]|\\\\.)*)'"));
      assert.ok(m, k + " used in the client");
      assert.equal(m[1].replace(/\\'/g, "'"), EN[k], k + ": the source's default = en.json");
    }
  }
  assert.equal(EN["js.plex.instead_after"], "What’s lined up after it keeps waiting - it plays after yours.");
});
