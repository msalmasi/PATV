"use strict";
// upnext2 (owner 2026-11-05: "unless there is an existing queue, Plex doesn't show the 'add to the queue' button. Just a play this instead
// button."): the 📼 Play from Plex sheet (public/js/plex-play.js - the Room Dock's sheet and /stage) in the plexreplace-ui.test.js DOM:
//   * a single title on this pad: "+ Add to the queue" beside ▶ Play this instead -> POST /api/medialib/queue/after (a queue of yours that
//     plays after it), the pick's choices; a paid one confirms the server's estimate first
//   * someone else's titles already waiting / no rights: "+ My list"
//   * a queue on THIS pad you may grow: "+ Add to the queue that's playing" on THIS pad (review bug: it added to your queue on any pad), a paid
//     one confirms what it adds; someone else's queue: "+ My list"
//   node --test test/upnext2-sheet.test.js
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

// ── the sheet against a stubbed site (the plexreplace-ui.test.js harness + /queue/after, /queue/edit, mine().queues) ──
const MOVIE = { key: "501", type: "movie", title: "Night of the Living Dead", year: 1968, duration: 5760, audio: [], subs: [], summary: "They're coming." };
function sheet({ onPad = null, queues = [], after = [], edit = [], perHour = 0 } = {}) {
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
  const store = {};
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
  const P = { pick: host.querySelector('[data-px="pick"]'), msg: host.querySelector('[data-px="msg"]') };
  const add = () => P.pick.querySelector("[data-add]");
  const askBox = () => P.pick.querySelector(".px-ask");
  const yes = () => askBox().querySelector("button.primary");
  const posts = (u) => calls.filter((c) => c.url === u);
  return { flow, calls, posts, pick, P, add, askBox, yes, started, store, play: () => P.pick.querySelector("[data-play]") };
}
const SINGLE = { title: "Charade (1963)", queue: false, left: 0, by: "cedar-fable", mine: false, can_replace: true, slot_id: "6f1c2e0a-0b1d-4c55-9a7e-2d3f4a5b6c7d", can_after: true };

test("E: a single title on this pad, no queue - the pick offers \"+ Add to the queue\" beside ▶ Play this instead; one tap = ONE POST /queue/after with the pick's choices (it plays after what's on)", async () => {
  const s = sheet({ onPad: SINGLE });
  s.flow.info(); await tick();
  await s.pick();
  assert.equal(s.play().textContent, "▶ Play this instead");
  assert.equal(s.add().textContent, "+ Add to the queue");
  assert.equal(s.add().getAttribute("title"), "Plays after what’s on now");
  s.add().click(); await tick();
  const p = s.posts("/api/medialib/queue/after");
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body, { room: "Night.Orchard", key: "501", scope: "episode", offset: 0, quality: 720, audio: null, sub: null });
  assert.equal(s.posts("/api/medialib/play").length, 0, "nothing replaced");
  assert.equal(s.P.msg.textContent, "Added - it plays after “Charade (1963)” (1 up next).");
  assert.equal(s.store["patv.plexList"], undefined, "not this tab's list");
});

test("E: a paid add says what it costs first - the server's estimate in the sheet's own confirm (nothing taken until it starts); yes = the same POST with that estimate", async () => {
  const s = sheet({ onPad: SINGLE, perHour: 1000, after: [{ status: 400, j: { ok: false, error: "This costs about 2,000 PAT as it plays - confirm it to add it.", code: "estimate", estimate: 2000 } },
                                                          { status: 200, j: { ok: true, after: true, items: 1, behind: "Charade (1963)" } }] });
  s.flow.info(); await tick();
  await s.pick();
  s.add().click(); await tick();
  const box = s.askBox();
  assert.ok(box, "the confirm");
  assert.equal(box.querySelector("p").textContent, "Add it to play after “Charade (1963)”? About 2,000 PAT, charged as it plays (only what actually plays) - nothing is taken until it starts.");
  assert.equal(s.yes().textContent, "Yes, add it");
  s.yes().click(); await tick();
  const p = s.posts("/api/medialib/queue/after");
  assert.equal(p.length, 2);
  assert.equal(p[1].body.estimate, 2000);
  assert.match(s.P.msg.textContent, /^Added - it plays after/);
});

test("E: someone else's titles already wait behind it (can_after false) / no rights -> \"+ My list\" (this tab's list), never a POST", async () => {
  const s = sheet({ onPad: { ...SINGLE, can_after: false, after: { count: 2, mine: false } } });
  s.flow.info(); await tick();
  await s.pick();
  assert.equal(s.add().textContent, "+ My list");
  s.add().click(); await tick();
  assert.equal(s.posts("/api/medialib/queue/after").length + s.posts("/api/medialib/queue/edit").length, 0);
  assert.match(s.store["patv.plexList"] || "", /"key":"501"/);
});

test("E: a queue on THIS pad you may grow -> \"+ Add to the queue that's playing\" adds to it on THIS pad; a paid one confirms what it adds", async () => {
  const s = sheet({ onPad: { title: "The Show — S1E1 Pilot", queue: true, left: 2, by: "me", mine: true, can_replace: true, slot_id: "q-slot-0000-0000", can_add: true },
                    queues: [{ id: 7, room: "Night.Orchard", state: "active" }],
                    edit: [{ status: 400, j: { ok: false, error: "That adds about 1,000 PAT to the queue as it plays - confirm it to add it.", code: "estimate", estimate: 1000 } },
                           { status: 200, j: { ok: true, items: 4 } }] });
  s.flow.info(); await tick();
  await s.pick();
  assert.equal(s.add().textContent, "+ Add to the queue that’s playing");
  s.add().click(); await tick();
  assert.equal(s.askBox().querySelector("p").textContent, "That adds about 1,000 PAT to the queue, charged as it plays (only what actually plays). Add it?");
  s.yes().click(); await tick();
  const e = s.posts("/api/medialib/queue/edit");
  assert.equal(e.length, 2);
  assert.deepEqual(e[1].body, { room: "Night.Orchard", op: "add", keys: ["501"], estimate: 1000 }, "THIS pad");
  assert.equal(s.P.msg.textContent, "Added to the queue that’s playing (4 titles now).");
});

test("E (review bug): your queue running on ANOTHER pad no longer turns this pad's \"+\" into \"Add to the queue that's playing\" (it added to the other pad's queue)", async () => {
  const s = sheet({ onPad: null, queues: [{ id: 9, room: "Other.Pad", state: "active" }] });
  s.flow.info(); await tick();
  await s.pick();
  assert.equal(s.play().textContent, "▶ Play on Night Orchard");
  assert.equal(s.add().textContent, "+ My list", "nothing on here: this tab's list");
  s.add().click(); await tick();
  assert.equal(s.posts("/api/medialib/queue/edit").length, 0, "never the other pad's queue");
  // someone else's queue on this pad: + My list too
  const t = sheet({ onPad: { title: "The Show — S1E1 Pilot", queue: true, left: 2, by: "cedar-fable", mine: false, can_replace: false, can_add: false } });
  t.flow.info(); await tick();
  await t.pick();
  assert.equal(t.add().textContent, "+ My list");
  for (const k of ["js.plex.q_add_after", "js.plex.q_add_after_title", "js.plex.q_added_after", "js.plex.q_after_cost", "js.plex.q_add_cost", "js.plex.ask_add", "js.plex.qn_after"]) assert.ok(EN[k], k);
});

// ── upnext2 review fixes (1.99??) ──
test("review F8: someone who can't change what's on gets no pink ▶ Play the server would refuse as busy - it's off, \"+ Add to the queue\" is the primary button and the line says so; back once the title ends", async () => {
  let on = { ...SINGLE, by: "cedar-fable", mine: false, can_replace: false, slot_id: null };
  const s = sheet({ onPad: () => on, perHour: 1000 });
  s.flow.info(); await tick();
  await s.pick();
  assert.equal(s.play().disabled, true, "▶ off");
  assert.equal(s.play().classList.contains("primary"), false);
  assert.equal(s.add().textContent, "+ Add to the queue");
  assert.equal(s.add().classList.contains("primary"), true, "the way forward");
  assert.equal(s.P.pick.querySelector("[data-now]").textContent,
               "📼 Now on Night Orchard: “Charade (1963)” - you can’t change it, but + Add to the queue plays your pick after it.");
  on = null;                                                    // it ended: ▶ plays again
  s.flow.info(); await tick();
  assert.equal(s.play().disabled, false);
  assert.equal(s.play().classList.contains("primary"), true);
  assert.equal(s.add().classList.contains("primary"), false);
  assert.equal(s.add().textContent, "+ My list");
  // someone who may replace it: ▶ Play this instead stays the primary
  const t = sheet({ onPad: SINGLE });
  t.flow.info(); await tick();
  await t.pick();
  assert.deepEqual([t.play().disabled, t.play().classList.contains("primary"), t.add().classList.contains("primary")], [false, true, false]);
  assert.equal(EN["js.plex.now_on_after"], "📼 Now on {pad}: “{now}” - you can’t change it, but + Add to the queue plays your pick after it.");
});

test("review safety F4: your titles waiting behind it - \"✕ Take them out\" in the pick's line -> ONE POST /queue/after/cancel for THIS pad; a notice when someone else took them out", async () => {
  let on = { ...SINGLE, can_replace: false, slot_id: null, can_after: true, after: { count: 2, mine: true } };
  const s = sheet({ onPad: () => on });
  s.flow.info(); await tick();
  await s.pick();
  const line = s.P.pick.querySelector("[data-now]");
  assert.match(line.textContent, /Your titles up next after it: 2\./);
  const x = line.querySelector("[data-after-x]");
  assert.ok(x);
  assert.equal(x.textContent, "✕ Take them out");
  on = { ...on, after: null };
  x.click(); await tick();
  const p = s.posts("/api/medialib/queue/after/cancel");
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body, { room: "Night.Orchard" });
  assert.equal(s.P.msg.textContent, "Taken out - nothing was charged.");
  assert.equal(s.P.pick.querySelector("[data-after-x]"), null, "read again: gone");
  // someone else's waiting titles: no ✕ here
  const t = sheet({ onPad: { ...SINGLE, after: { count: 1, mine: false }, can_after: false } });
  t.flow.info(); await tick();
  await t.pick();
  assert.equal(t.P.pick.querySelector("[data-after-x]"), null);
  for (const k of ["js.plex.after_mine", "js.plex.after_x", "js.plex.after_x_done", "js.plex.qn_after_removed", "js.plexq.after_x", "js.plexq.q_after_x"]) assert.ok(EN[k], k);
  assert.match(SRC, /if \(q\.notice === 'after_removed'\) return _t\('js\.plex\.qn_after_removed'/);
});

test("review safety F4: the 📼 player - \"✕ Take them out\" for whoever may (can_withdraw: their owner, the pad's owner, an admin), even without control of the title on now; who added them only to those", async () => {
  const src = read("public", "js", "pad-plexq.js");
  const run = (player) => {
    const doc = mkDoc();
    const box = doc.body.appendChild(doc.createElement("div"));
    box.id = "rmPlexQ"; box.setAttribute("data-room", "Night.Orchard");
    doc.getElementById = (id) => (id === "rmPlexQ" ? box : null);
    doc.addEventListener = () => {}; doc.hidden = false; doc.activeElement = null;
    const calls = [];
    const win = { document: doc, console, Date, Math, JSON, confirm: () => true, setTimeout: () => 0, setInterval: () => 0, clearInterval() {},
                  fetch: async (url, o = {}) => { calls.push({ url, method: (o.method || "GET").toUpperCase(), body: o.body ? JSON.parse(o.body) : null });
                                                 return { ok: true, status: 200, json: async () => (url.startsWith("/api/medialib/player") ? player : { ok: true }) }; } };
    win.window = win;
    vm.runInNewContext(src, win, { filename: "pad-plexq.js" });
    return { box, calls };
  };
  const base = { ok: true, on: true, room: "Night.Orchard", title: "Charade (1963)", state: "playing", position: 10, duration: 6780, by: "cedar-fable", can_control: false, queue: null, log: [] };
  const mine = run({ ...base, after: { count: 1, next: [{ key: "501", type: "movie", title: "Night of the Living Dead", year: 1968, duration: 5760 }], mine: true, can_withdraw: true, by: "me" } });
  await tick();
  const x = mine.box.querySelector("[data-after-x]");
  assert.ok(x, "their owner, without control of the title on now");
  assert.equal(x.textContent, "✕ Take them out");
  x.click(); await tick();
  const p = mine.calls.filter((c) => c.url === "/api/medialib/queue/after/cancel");
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body, { room: "Night.Orchard" });
  const other = run({ ...base, after: { count: 1, next: [{ key: "501", type: "movie", title: "Night of the Living Dead", year: 1968, duration: 5760 }], mine: false, can_withdraw: false } });
  await tick();
  assert.equal(other.box.querySelector("[data-after-x]"), null, "anyone else: no ✕");
  assert.doesNotMatch(other.box.textContent, /added by/, "and no name");
});

test("review F8: while ▶ is off the sheet looks again every 20 s - the title ends and ▶ comes back without reopening it; a closed sheet stops looking", () => {
  assert.match(SRC, /var BLOCK_LOOK_MS = 20000, blockT = null;/);
  assert.match(SRC, /blockT = setTimeout\(function \(\) \{ blockT = null; if \(host\.isConnected === false \|\| !blocked\(\)\) return; info\(\); \}, BLOCK_LOOK_MS\);/);
  assert.match(SRC, /if \(bl\) \{ b0\.setAttribute\('data-blocked', '1'\); b0\.disabled = true; blockLook\(\); \}/);
});
