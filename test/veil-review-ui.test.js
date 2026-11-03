// wave 2 WP-2 review fixes (track A), the page side - each test fails without its fix:
//   A-tests-ux-03  a masked line (data-vc) gets its ⋯ (Report, its speaker's Remove my line, a moderator's Hide) - chat-lines.js
//   A-tests-ux-04  the staff per-login tool prints "N veiled line(s) - ask an admin" - views/admin/bridge.ejs
//   A-tests-ux-05  the pad page has the J-18 "Show real names" toggle (E.2 banner, Hide again) and shows reveal errors - room.ejs
//   A-tests-ux-06  the report queue says "Hidden line - needs an admin", not "(its text is gone)" - chatlog-reports.js
//   A-tests-ux-07  /help replaces the incognito / bridge / transcripts wording with Pepe's v2 text while the switch is on - help.js
//   A-tests-ux-09  the homepage panel draws a frog name in italics with its tag, never as a plain name - views/home.ejs
//   A-tests-ux-11  the switched-on policy has section H's :136 / :219 sentences and the :270 frog-name wording; the see-through card
//                  names the chat scopes - views/privacy.ejs, views/admin/bridge.ejs
//   node --test test/veil-review-ui.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "veil-review-ui-test-")));     // (help.js opens ./myapp.db: a temp one)
process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret";
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const lf = (s) => String(s).replace(/\r\n/g, "\n");

// ── a tiny DOM: what chat-lines.js's decorate and the homepage's name helpers touch ──
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.attrs = {}; this.children = []; this.parentNode = null;
                     this.className = ""; this._text = ""; this.style = {}; this.listeners = {}; }
  get classList() {
    const s = this;
    return { contains: (c) => s.className.split(/\s+/).includes(c), add: (c) => { if (!s.classList.contains(c)) s.className = (s.className + " " + c).trim(); },
             remove: (c) => { s.className = s.className.split(/\s+/).filter((x) => x && x !== c).join(" "); } };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const parts = sel.split(",").map((s) => s.trim());
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.nodeType === 1 && parts.some((p) => matches(c, p))) out.push(c); if (c.children) walk(c); } };
    walk(this);
    return out;
  }
}
class Txt { constructor(t) { this.nodeType = 3; this.data = String(t); this.parentNode = null; this.children = []; } get textContent() { return this.data; } }
function matches(n, p) {
  if (p.startsWith(".")) return n.classList.contains(p.slice(1));
  const m = /^\[([\w-]+)\]$/.exec(p);
  if (m) return n.hasAttribute(m[1]);
  return n.tagName === p.toUpperCase();
}
const doc = () => ({ createElement: (t) => new El(t), createTextNode: (t) => new Txt(t), body: new El("body") });

test("A-tests-ux-03: a masked line (data-vc) gets its ⋯ - Report for others, Remove for its speaker, Hide for a moderator", () => {
  const ctx = { document: doc(), MutationObserver: class { observe() {} }, setTimeout, clearTimeout, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(rd("public", "js", "chat-lines.js"), ctx, { filename: "chat-lines.js" });
  const feed = new El("div");
  const mk = (attrs) => { const n = new El("div"); n.className = "line"; Object.assign(n.attrs, attrs); feed.appendChild(n); return n; };
  const masked = mk({ "data-vc": "42" }), own = mk({ "data-vc": "43", "data-own": "1" }), named = mk({ "data-c": "44" });
  const api = ctx.window.PATVChatLines.init({ feed, slug: "p1" });
  api.update({ history: { acts: { report: true, hide: true, purge: false } } });
  for (const [n, what] of [[masked, "someone else's masked line"], [own, "the speaker's own masked line"], [named, "a named line"]]) {
    assert.ok(n.querySelector(".la-btn"), what + " has its ⋯");
  }
  const ids = (n) => api._items(n).map((x) => x.id);
  assert.equal(ids(masked).join(","), "report,hide");
  assert.equal(ids(own).join(","), "remove,hide");
  assert.ok(!masked.hasAttribute("data-c"), "still out of the ✂️ / 🔊 pickers (they read data-c)");
});

test("A-tests-ux-04 / A-tests-ux-11: the per-login tool prints the veiled note; the see-through card names the chat scopes", () => {
  const src = rd("views", "admin", "bridge.ejs");
  assert.match(src, /s\.veiled_note \? ' · ' \+ s\.veiled_note : ''/, "showWho appends 'N veiled line(s) - ask an admin'");
  assert.ok(!src.includes("(room analytics now; pad chat later)"), "the stale help text is gone");
  for (const s of ["chat_line", "chat_toggle", "chat_tool"]) assert.ok(src.includes("<code>" + s + "</code>"), s);
});

test("A-tests-ux-05: the pad page has the J-18 toggle (Show real names / Hide again, the E.2 banner) and inline reveal errors", () => {
  const src = rd("views", "room.ejs");
  assert.ok(src.includes("stPost('/api/chatlog/seethrough', { room: slug, on: !on })"), "the toggle POSTs the see-through switch");
  assert.ok(src.includes("{ room: slug, c: cs, toggle: true }"), "batch reveals while it's on (counted on the toggle's row)");
  assert.ok(src.includes("err.status === 409") || src.includes("on = false;"), "a 409 = off");
  assert.ok(src.includes("revealErr(b, err.message)"), "a failed reveal says so on the line");
  const en = JSON.parse(rd("locales", "en.json"));
  for (const k of ["js.pad.veil.st_show", "js.pad.veil.st_hide", "js.pad.veil.st_on", "js.pad.veil.st_off", "js.pad.veil.reveal_err"]) assert.ok(en[k], k);
});

test("A-tests-ux-06: the report queue says a hidden line needs an admin (never '(its text is gone)')", () => {
  const src = rd("public", "js", "chatlog-reports.js");
  // (1.99?? privacy controls round 3 - F3: while text reveal roles are on (L.tr) the note says staff can reveal it on the pad too)
  assert.ok(/L\.needs_admin \? \(L\.tr \? 'Hidden line - reveal it on the pad[^']*'\s*: 'Hidden line - needs an admin/.test(src));
  assert.ok(src.includes("L.link"), "a link to the line for the admin");
});

test("A-tests-ux-07: /help - Pepe's v2 wording replaces the old promise while the switch is on (summary too)", () => {
  const H = require(path.join(repo, "help"));
  const PW = require(path.join(repo, "privwire"));
  const cards = [{ id: "incognito", summary: "you show as \"someone\"", details: "you show as \"someone\" on the website",
                   v2: { summary: "a random frog name instead of your name", details: "under a random frog name" } },
                 { id: "bridge", summary: "Is this room live?", details: "!bridge hide leaves you out of the website", v2: { details: "hidden: a blacked-out bar" } }];
  const on = PW.isOn;
  PW.isOn = () => true;
  try {
    const out = H.withPrivwireNotes(cards);
    assert.equal(out[0].summary, "a random frog name instead of your name");
    assert.equal(out[0].details, "under a random frog name", "replaced, not appended under the old text");
    assert.equal(out[1].summary, "Is this room live?", "no v2 summary: its own");
    assert.equal(out[1].details, "hidden: a blacked-out bar");
    // help data from a Pepe without the v2 wording: the visible summary still changes, the note is added
    const old = H.withPrivwireNotes([{ id: "incognito", summary: "with incognito on you show as \"someone\" on the website", details: "" }]);
    assert.match(old[0].summary, /random frog name/);
    assert.ok(!/show as "someone"/.test(old[0].summary));
  } finally { PW.isOn = on; }
  // the bundled copy of Pepe's help carries the v2 wording
  const data = JSON.parse(rd("data", "help-commands.json"));
  const inc = (data.entries || []).find((e) => e.id === "incognito");
  assert.ok(inc && inc.v2 && /frog name/.test(inc.v2.details || ""), "data/help-commands.json: incognito.v2");
});

test("A-tests-ux-09: the homepage panel draws a frog name in italics with its tag; a Camfrog name that looks like one stays plain", () => {
  const src = lf(rd("views", "home.ejs"));
  const a = src.indexOf("    var ALIAS_RE = ");
  const b = src.indexOf("    function chipTitle(");
  assert.ok(a > 0 && b > a, "the panel's name helpers");
  assert.equal(/var ALIAS_RE = (\/.*\/);/.exec(src.slice(a, b))[1], /var ALIAS_RE = (\/.*\/);/.exec(rd("public", "js", "chatlog-core.js"))[1], "the same pattern as chatlog-core.js");
  const ctx = { document: doc(), _t: (k, d, v) => String(d).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)) };
  ctx.el = function (tag, cls, text) { const e = ctx.document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + "\nthis.nameEl = nameEl; this.label = label;", ctx);
  const v = ctx.nameEl({ anon: true, display: "someone", veil: "incognito", alias: "Soggy Bullfrog" });
  const i = v.querySelector("i"), tag = v.querySelector(".veil-tag");
  assert.ok(i && i.textContent === "Soggy Bullfrog", "the frog name in <i>");
  assert.ok(tag && tag.textContent === "incognito", "with its tag");
  const fake = ctx.nameEl({ login: "soggyb", display: "Soggy Bullfrog" });
  assert.ok(!fake.querySelector("i") && !fake.querySelector(".veil-tag") && fake.textContent === "Soggy Bullfrog", "a named user: plain, no tag");
  assert.equal(ctx.label({ anon: true, veil: "hidden", alias: "Mystery Frog 3" }), "Mystery Frog 3", "the generator's fallback is a frog name too");
  const h = ctx.nameEl({ anon: true, display: "someone", veil: "hidden" });
  assert.ok(h.textContent.includes("someone") && h.querySelector(".veil-tag"), "an alias-less veiled person: 'someone' + the tag");
});

test("A-tests-ux-11: the switched-on policy has section H's :136 / :219 sentences and the frog-name wording at :270", () => {
  const FILE = path.join(repo, "views", "privacy.ejs");
  const BASE = { user: null, title: "Privacy Policy", VERSION: "x", UPDATED: "1 November 2026", enforced: false, chatlog: { notice_day: "1 October 2026", start_day: "8 October 2026" },
                 hubErasure: { export: true, on_day: null }, micrec: null, memory: null, policyDates: {} };
  const render = (extra) => ejs.render(lf(fs.readFileSync(FILE, "utf8")), Object.assign({}, BASE, extra), { filename: FILE });
  const on = render({ privwire: { on: true, g: 1793534400000, g_day: "1 November 2026" } });
  const off = render({});
  const want = ["the pad's owner and PATV staff (logged) see everything its tier keeps; only the pad's owner and PATV administrators can reveal who is behind a frog name or read hidden lines, and every reveal is logged",
                "<code>!incognito</code> shows you on the website under a frog name instead of your name, and <code>!bridge hide</code> also blacks out what you say. Neither mutes your voice in the room's audio.",
                "(they are shown as \"someone\", or under a frog name from 1 November 2026)"];
  for (const s of want) { assert.ok(on.includes(s), "on: " + s); assert.ok(!off.includes(s), "off: " + s); }
  assert.ok(!on.includes("<code>!bridge hide</code> keep your name off the website"), "the old :219 promise is gone while on");
  assert.ok(off.includes("<code>!bridge hide</code> keep your name off the website"), "...and still there while off");
});
