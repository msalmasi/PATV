// CL5: one renderer for the pad chat (public/js/chatlog-core.js + public/css/chatlog.css, chat-history spec §3.7).
//   * no visible change: for every fixture line the shared renderer builds the DOM tree the pad page's inline renderer built
//     (that renderer, frozen from git d6263ec9, is test/fixtures/chatlog/legacy-room-item.js) - in English and in a
//     translated catalog - and the mic / people lists' avatars and names, the 📜 chip's spans and the clock are the same;
//   * h-tree parity without a DOM: the same line through a recording h, the DOM h and the server's HTML h, compared as trees;
//   * the server h escapes; links and pictures only by the server's own rules; the download options (origin, data: false,
//     timeTitle, avatar); times and day labels from an offset (no ICU dependence); the TXT / JSONL item grammar (§3.8);
//   * room.ejs uses it (no inline copy), chatlog.css carries the moved rules as ds tokens, home.ejs is left alone.
//   node --test test/chatlog-render.test.js            (no database, no node_modules)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const CL = require(path.join(repo, "public", "js", "chatlog-core.js"));
const legacy = require(path.join(__dirname, "fixtures", "chatlog", "legacy-room-item.js"));
const EN = JSON.parse(rd("locales", "en.json"));

// ── a small DOM: just what the two renderers touch ──
function parseDecl(s) {
  const d = {};
  for (const part of String(s || "").split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase(), v = part.slice(i + 1).trim().replace(/\s+/g, " ");
    if (k && v) d[k] = v;
  }
  return d;
}
const styleStr = (d) => Object.keys(d).sort().map((k) => k + ":" + d[k]).join(";");
class FakeStyle {
  constructor() { this._d = {}; }
  set cssText(v) { this._d = parseDecl(v); }
  get cssText() { return styleStr(this._d); }
  set background(v) { this._d.background = String(v).replace(/\s+/g, " "); }
  setProperty(k, v) { this._d[k] = String(v); }
}
class FakeText { constructor(t) { this.nodeType = 3; this.data = String(t); } }
class FakeEl {
  constructor(tag) { this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.kids = []; this.style = new FakeStyle(); this._cls = []; }
  get className() { return this._cls.join(" "); }
  set className(v) { this._cls = String(v).split(/\s+/).filter(Boolean); }
  get classList() { const me = this; return { add(c) { if (!me._cls.includes(c)) me._cls.push(c); }, contains: (c) => me._cls.includes(c) }; }
  setAttribute(k, v) { if (k === "class") this.className = v; else this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  set textContent(v) { this.kids = v == null || v === "" ? [] : [new FakeText(v)]; }
  appendChild(c) { this.kids.push(c); return c; }
  set title(v) { this.attrs.title = String(v); }
  set href(v) { this.attrs.href = String(v); }
  set src(v) { this.attrs.src = String(v); }
  set alt(v) { this.attrs.alt = String(v); }
  set loading(v) { this.attrs.loading = String(v); }
  set dateTime(v) { this.attrs.datetime = String(v); }
}
const fakeDoc = (lang = "en") => ({ documentElement: { lang }, createElement: (t) => new FakeEl(t), createTextNode: (t) => new FakeText(t) });

// ── one tree shape for all three: {t, a: {sorted attrs, style normalised}, k: [children, adjacent text merged]} ──
function mergeKids(kids) {
  const out = [];
  for (const k of kids) {
    if (typeof k === "string") { if (!k) continue; if (typeof out[out.length - 1] === "string") out[out.length - 1] += k; else out.push(k); }
    else out.push(k);
  }
  return out;
}
function tree(tag, attrs, kids) {
  const a = {};
  for (const k of Object.keys(attrs).sort()) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === "style") { const s = styleStr(parseDecl(v)); if (s) a.style = s; continue; }
    if (k === "class") { const c = String(v).split(/\s+/).filter(Boolean).join(" "); if (c) a.class = c; continue; }
    a[k] = v === true ? "" : String(v);
  }
  return { t: String(tag).toLowerCase(), a, k: mergeKids(kids) };
}
function fromDom(n) {
  if (n == null) return null;
  if (n.nodeType === 3) return n.data;
  const attrs = Object.assign({}, n.attrs);
  if (n.className) attrs.class = n.className;
  if (n.style.cssText) attrs.style = n.style.cssText;
  return tree(n.tagName, attrs, n.kids.map(fromDom));
}
const recH = (tag, attrs, kids) => ({ rec: true, tag, attrs: attrs || {}, kids: kids == null ? [] : Array.isArray(kids) ? kids : [kids] });
function fromRec(n) {
  if (n == null) return null;
  if (!n.rec) return String(n);
  return tree(n.tag, n.attrs, n.kids.filter((c) => c != null && c !== false).map(fromRec));
}
const DEC = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => DEC[e]);
function fromHtml(html) {
  const VOID = new Set(["img", "br", "hr", "meta", "link", "input"]);
  const root = { kids: [] }, stack = [root];
  const re = /<\/([a-z0-9]+)>|<([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/gy;
  let m, at = 0;
  while ((m = re.exec(html))) {
    at = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1]) { const open = stack.pop(); assert.equal(open.tag, m[1], "balanced </" + m[1] + ">"); }
    else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] == null ? true : decode(a[2]);
      const node = { tag: m[2], attrs, kids: [] };
      top.kids.push(node);
      if (!VOID.has(m[2])) stack.push(node);
    } else top.kids.push(decode(m[4]));
  }
  assert.equal(at, html.length, "the whole string parsed: " + html.slice(at, at + 40));
  assert.equal(stack.length, 1, "every element closed");
  const conv = (n) => (typeof n === "string" ? n : tree(n.tag, n.attrs, n.kids.map(conv)));
  return root.kids.length === 1 ? conv(root.kids[0]) : root.kids.map(conv);
}

// ── the translators: the page's English fallback (room.ejs, no catalog) and a translated catalog (like window.__t) ──
const tEN = function (k, d, v) { if (d && typeof d === "object") d = v && v.count === 1 ? d.one : d.other; return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
const DE = { "js.pad.chat.joined": "→ {name} ist da", "js.pad.someone": "jemand", "js.pad.chat.tx": "Am Mikro gesagt (automatisch)",
  "js.pad.chat.web": "Von der Website", "js.pad.flair": "Pad-Flair: {name}", "js.pad.chat.span_h": { one: "{count} Stunde", other: "{count} Stunden" },
  "js.pad.chat.note_window": "📜 Chatverlauf: die letzten {span}", "js.pad.chat.live_what": "🎥 {name} ist live auf {pad} — {what}", "js.pad.chat.chip_h": "{n} Std." };
const tDE = function (k, d, v) { const s = DE[k] != null ? DE[k] : d; return tEN(k, s, v); };

// ── the fixture lines: every branch of the inline renderer ──
const T0 = Date.UTC(2026, 9, 19, 1, 4, 11, 123);
const FLAIR = { name: "Resident Frog Wrangler", emoji: "🐸", color: "#123abc", ink: "#ffffff" };
const STYLE = "color: #ffd54f; background: linear-gradient(90deg, #ff5252, #448aff); -webkit-background-clip: text; animation: cx-shift 6s linear infinite";
const PB = { login: "leafy1111", display: "Plantbaked", cf: "Plantbaked", patv: { username: "pb", avatar: "/uploads/avatars/pb.png", style: STYLE, flair: FLAIR } };
const FIX = [
  { k: "msg", c: 101, ts: T0, u: PB, text: "hello room" },
  { k: "msg", c: 102, ts: T0 + 1e3, u: { login: "bob", display: "bob" }, text: "display = login: no tooltip" },
  { k: "msg", c: 103, ts: T0 + 2e3, u: { login: "bobcf", display: "Bobby" }, text: "display differs: the login is the tooltip" },
  { k: "msg", c: 104, ts: T0 + 3e3, u: { login: "u:ABC-123456", display: "Mae", acct: true, web: true, patv: { username: "mae", avatar: null, style: "" } }, text: "typed on the website" },
  { k: "msg", c: 105, ts: T0 + 4e3, u: { login: "pepefrog", display: "PepeFrog", self: true, patv: { username: "pepe", avatar: "https://cdn.example.com/pepe.png", style: "" } }, text: "🔊 Pepe's own line", cap: "tts" },
  { k: "msg", c: 106, ts: T0 + 5e3, u: { former: true }, text: "a former member's line" },
  { k: "msg", c: 107, ts: T0 + 6e3, u: { login: "linky", display: "Linky", web: true, patv: { username: "linky<&>", avatar: null, style: "", flair: { name: "Hot <b>takes</b> & \"more\"", emoji: "", color: "red", ink: "#00ff00" } } },
    text: "<script>alert(1)</script> & \"quotes\" 'single' <b>bold</b>" },
  { k: "msg", ts: T0 + 7e3, u: { display: "you", login: "", web: true }, text: "a pending relay line (no cursor)" },
  { k: "msg", c: 108, ts: T0 + 8e3, u: { login: "émile.ü", display: "Émile 🌸", patv: { username: "emile", avatar: null, style: "", flair: { name: "Fan", emoji: "⭐" } } }, text: "ünïcödé ✓ — 漢字" },
  { k: "tx", c: 109, ts: T0 + 9e3, id: "tx-0123abcd", u: { login: "bob", display: "Bob", on_mic: true }, text: "said on the mic" },
  { k: "tx", c: 110, ts: T0 + 10e3, u: { login: "pepefrog", display: "PepeFrog", self: true }, text: "a transcript with no id" },
  { k: "tx", c: 111, ts: T0 + 11e3, id: "tx-89abcdef", u: PB, text: "a linked speaker on the mic" },
  { k: "join", c: 112, ts: T0 + 12e3, u: { login: "bob", display: "Bob" } },
  { k: "leave", c: 113, ts: T0 + 13e3, u: { anon: true, display: "someone" } },
  { k: "mic", c: 114, ts: T0 + 14e3, u: PB },
  { k: "unmic", c: 115, ts: T0 + 15e3, u: { login: "x", display: "X" }, ms: 180000 },
  { k: "unmic", c: 116, ts: T0 + 16e3, u: { login: "x", display: "X" }, ms: 0 },
  { k: "unmic", c: 117, ts: T0 + 17e3, u: { login: "x", display: "X" }, ms: 42000 },
  { k: "unmic", c: 118, ts: T0 + 18e3, u: { former: true }, ms: 5400000 },
  { k: "topic", c: 119, ts: T0 + 19e3, text: "movie night at 9 <tonight>" },
  { k: "live", c: 120, ts: T0 + 20e3, who: "pb", pad: "Pepe's Pad", what: "Movie night", link: "/p/pepes-pad" },
  { k: "live", c: 121, ts: T0 + 21e3, who: "pb", pad: "Pepe's Pad", what: "", link: "" },
  { k: "live", c: 122, ts: T0 + 22e3, np: 1, who: "pb", pad: "Pepe's Pad", what: "The Observance", link: "/p/pepes-pad" },
  { k: "note", c: 123, ts: T0 + 23e3, w: "window", s: null },
  { k: "note", c: 124, ts: T0 + 24e3, w: "window", s: 0 },
  { k: "note", c: 125, ts: T0 + 25e3, w: "window", s: 900 },
  { k: "note", c: 126, ts: T0 + 26e3, w: "window", s: 86400 },
  { k: "note", c: 127, ts: T0 + 27e3, w: "window", s: 7 * 86400 },
  { k: "note", c: 128, ts: T0 + 28e3, w: "window", s: 90 },
  { k: "note", c: 129, ts: T0 + 29e3, w: "window", s: 3600 },
  { k: "note", c: 130, ts: T0 + 30e3, w: "search", s: 1 },
  { k: "note", c: 131, ts: T0 + 31e3, w: "search", s: 0 },
  { k: "note", c: 132, ts: T0 + 32e3, w: "open", o: T0 + 7 * 864e5, sc: "both" },
  { k: "note", c: 133, ts: T0 + 33e3, w: "open_done", sc: "window" },
  { k: "note", c: 134, ts: T0 + 34e3, w: "something-newer" },
  { k: "something-newer", c: 135, ts: T0 + 35e3, text: "never shown" },
];
const PEOPLE = [PB, { login: "bob", display: "Bob", on_cam: true, src: "seen" }, { login: "bobcf", display: "Bobby", tip: { to: "bob" } },
  { anon: true, display: "someone" }, { former: true }, { login: "pepefrog", display: "PepeFrog", self: true },
  { login: "u:ABC-123456", display: "Mae", acct: true, web: true, patv: { username: "mae", avatar: null, style: "" } }, null];

for (const [lang, t] of [["en", tEN], ["de", tDE]]) {
  test(`no visible change (${lang}): every fixture line is the DOM the inline renderer built`, () => {
    const doc = fakeDoc(lang);
    const old = legacy(doc, t), ctx = { t, lang: doc.documentElement.lang || undefined }, H = CL.domH(doc);
    let shown = 0;
    for (const it of FIX) {
      const a = fromDom(old.item(it)), b = fromDom(CL.renderItem(it, ctx, H));
      assert.deepEqual(b, a, `c=${it.c} k=${it.k}`);
      if (a) shown++;
    }
    assert.equal(shown, FIX.length - 2, "every fixture but the two unknown kinds is a line");
    // the mic and people lists' pieces, the clock, the 📜 chip
    for (const u of PEOPLE) {
      assert.deepEqual(fromDom(CL.avatarNode(u, ctx, H)), fromDom(old.avatar(u)), "avatar " + JSON.stringify(u));
      if (u) assert.deepEqual(fromDom(CL.nameNode(u, ctx, H)), fromDom(old.name(u)), "name " + JSON.stringify(u));
      assert.equal(CL.label(u, ctx), old.label(u));
    }
    for (const ts of [T0, T0 + 59e3, Date.UTC(2026, 0, 1, 0, 0), Date.UTC(2026, 6, 4, 23, 59, 59)]) assert.equal(CL.fmtTime(ts, ctx), old.hhmm(ts));
    for (const s of [60, 90, 900, 3600, 7200, 86400, 172800, 7 * 86400, 30 * 86400, 3650 * 86400]) assert.equal(CL.chipSpan(s, ctx), old.chipSpan(s), "chip " + s);
  });
}

test("h-tree parity without a DOM: a recording h, the DOM h and the server's HTML h build the same tree", () => {
  const doc = fakeDoc("en"), ctx = { t: tEN, lang: "en" };
  for (const it of FIX) {
    const rec = fromRec(CL.renderItem(it, ctx, recH));
    const dom = fromDom(CL.renderItem(it, ctx, CL.domH(doc)));
    const html = CL.renderItem(it, ctx, CL.htmlH);
    assert.deepEqual(dom, rec, `dom c=${it.c}`);
    if (rec == null) { assert.equal(html, null); continue; }
    assert.deepEqual(fromHtml(String(html)), rec, `html c=${it.c}`);
  }
  for (const u of PEOPLE) {
    assert.deepEqual(fromHtml(String(CL.avatarNode(u, ctx, CL.htmlH))), fromRec(CL.avatarNode(u, ctx, recH)));
    if (u) assert.deepEqual(fromHtml(String(CL.nameNode(u, ctx, CL.htmlH))), fromRec(CL.nameNode(u, ctx, recH)));
  }
});

test("the server h escapes every text and attribute; data never becomes markup", () => {
  const ctx = { t: tEN };
  const x = FIX.find((it) => it.c === 107);
  const html = String(CL.renderItem(x, ctx, CL.htmlH));
  assert.ok(!html.includes("<script"), html);
  assert.ok(!html.includes("<b>"), "flair / text tags escaped");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot; &#39;single&#39;/);
  assert.match(html, /data-text="&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quotes&quot; &#39;single&#39; &lt;b&gt;bold&lt;\/b&gt;"/);
  assert.match(html, /href="\/u\/linky%3C%26%3E"/, "the profile link is URL-encoded");
  assert.match(html, /class="ufl" title="Pad flair: Hot &lt;b&gt;takes&lt;\/b&gt; &amp; &quot;more&quot;" style="--fli:#00ff00"/, "only strict-hex colours");
  const topic = String(CL.renderItem(FIX.find((it) => it.k === "topic"), ctx, CL.htmlH));
  assert.match(topic, /^<div class="sys topic">📌 topic: movie night at 9 &lt;tonight&gt; · \d\d:\d\d<\/div>$/);
  assert.equal(String(CL.htmlH("img", { "class": "av", src: "/a.png", alt: "", hidden: true, title: null, x: false })), '<img class="av" src="/a.png" alt="" hidden>');
  assert.equal(String(CL.htmlH("p", null, ["a", CL.htmlH("b", null, "<i>"), null, false, 0])), "<p>a<b>&lt;i&gt;</b>0</p>");
});

test("links and pictures follow the server's own rules (defence in depth): anything else is plain text / the letter bubble", () => {
  const ctx = { t: tEN }, H = CL.htmlH;
  for (const bad of ["javascript:alert(1)", "//evil.example/p", "http://plain.example", "/p/x\"onmouseover=1", " /p/x", "data:text/html,x"]) {
    const html = String(CL.renderItem({ k: "live", ts: T0, who: "pb", pad: "P", link: bad }, ctx, H));
    assert.ok(!html.includes("<a"), bad + " -> " + html);
    assert.equal(CL.jsonItem({ k: "live", ts: T0, who: "pb", pad: "P", link: bad }, ctx).link, null);
  }
  assert.match(String(CL.renderItem({ k: "live", ts: T0, who: "pb", pad: "P", link: "https://twitch.tv/x" }, ctx, H)), /<a href="https:\/\/twitch\.tv\/x">/);
  for (const bad of ["javascript:x", "http://x/a.png", "/a b.png", "/a.png?v=1", "data:image/png;base64,AAAA"]) {
    const html = String(CL.avatarNode({ login: "z", display: "Zed", patv: { username: "z", avatar: bad } }, ctx, H));
    assert.match(html, /^<span class="av" style="background:hsl\(\d+,55%,62%\)" aria-hidden="true">Z<\/span>$/, bad);
  }
  assert.equal(CL.safeSrc("/uploads/avatars/a_b-1.png"), true);
  assert.equal(CL.safeLink("/p/pepes-pad"), true);
});

test("the download options: absolute links with rel, no data-*, a time tooltip, inlined avatars", () => {
  const ctx = { t: tEN, origin: "https://publicaccess.tv/", data: false, offset: -240,
                timeTitle: (ts) => "Sunday 18 October 2026, 21:04 EDT (UTC−04:00) #" + ts,
                avatar: (u) => (u.patv && u.patv.username === "pb" ? "data:image/png;base64,iVBORw0KGgo=" : null) };
  const html = String(CL.renderItem(FIX[0], ctx, CL.htmlH));
  assert.match(html, /^<div class="line"><img class="av" src="data:image\/png;base64,iVBORw0KGgo=" alt="" loading="lazy">/);
  assert.match(html, /<a class="who cx-name" style="[^"]+" title="leafy1111" href="https:\/\/publicaccess\.tv\/u\/pb" rel="nofollow noopener">Plantbaked<\/a>/);
  assert.match(html, /<time class="when" datetime="2026-10-19T01:04:11\.123Z" title="Sunday 18 October 2026, 21:04 EDT \(UTC−04:00\) #\d+">21:04<\/time>/);
  assert.doesNotMatch(html, /data-/, "no data-* in a file");
  const bob = String(CL.renderItem(FIX[1], ctx, CL.htmlH));
  assert.match(bob, /<span class="av" style="background:hsl\(\d+,55%,62%\)" aria-hidden="true">B<\/span>/, "no picture -> the letter bubble");
  const live = String(CL.renderItem(FIX.find((it) => it.c === 120), ctx, CL.htmlH));
  assert.equal(live, '<div class="sys live"><a href="https://publicaccess.tv/p/pepes-pad" rel="nofollow noopener">🎥 pb just went live on Pepe&#39;s Pad — Movie night</a> · 21:04</div>');
  // the live page keeps its relative links and its data-* (✂️ Clip / quotes read them)
  const page = String(CL.renderItem(FIX[0], { t: tEN }, CL.htmlH));
  assert.match(page, /href="\/u\/pb">/);
  assert.match(page, /data-c="101" data-k="msg" data-name="Plantbaked" data-text="hello room"/);
});

test("the translator: ctx.t, else the page's __t, else the English defaults (plural objects too)", () => {
  assert.equal(CL.spanOf(7200, {}), "2 hours");
  assert.equal(CL.spanOf(3600, {}), "1 hour");
  assert.equal(CL.spanOf(90, {}), "2 minutes");
  assert.equal(CL.spanOf(3 * 86400), "3 days");
  assert.equal(CL.spanOf(86400, { t: tDE }), "24 Stunden");
  assert.equal(CL.sysText({ k: "join", u: { login: "a", display: "Ann" } }, { t: tDE }), "→ Ann ist da");
  assert.equal(CL.dur(59000), "59s");
  assert.equal(CL.dur(180000), "3m");
  assert.equal(CL.dur(5400000), "1.5h");
  // as a browser script: the global PATVChatlog, and the page's __t when no ctx.t is given
  const win = { __t: (k, d, v) => "[" + k + "]" + (v && v.name ? v.name : "") };
  win.self = win;
  vm.runInNewContext(rd("public", "js", "chatlog-core.js"), { self: win, window: win });
  assert.equal(typeof win.PATVChatlog.renderItem, "function");
  assert.equal(win.PATVChatlog.sysText({ k: "leave", u: { login: "b", display: "Bo" } }, {}), "[js.pad.chat.left]Bo");
  // every string is a literal _t('js…', 'default') call, so test/i18n.test.js checks it against en.json
  const src = rd("public", "js", "chatlog-core.js");
  const calls = [...src.matchAll(/\b_t\(\s*'(js\.[a-z0-9_.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g)];
  assert.ok(calls.length >= 25, "literal calls: " + calls.length);
  for (const [, k, d] of calls) assert.equal(typeof EN[k] === "object" ? EN[k].other : EN[k], d, k);
  for (const k of ["js.pad.chat.span_d", "js.pad.chat.span_h", "js.pad.chat.span_min"]) assert.equal(typeof EN[k], "object", k + " is a plural");
  assert.equal(EN["js.pad.chat.today"], "Today");
  assert.equal(EN["js.pad.chat.yesterday"], "Yesterday");
});

test("times and day labels from an offset: the same answer on any machine zone and ICU build", () => {
  const ts = Date.parse("2026-10-19T01:04:11.123Z");
  assert.equal(CL.fmtTime(ts, { offset: -240 }), "21:04");
  assert.equal(CL.fmtTime(ts, { offset: 330 }), "06:34");
  assert.equal(CL.fmtTime(ts, { offset: 0 }), "01:04");
  assert.equal(CL.fmtTime(ts, { offset: (ms) => (ms < ts ? -240 : -300) }), "20:04", "a per-moment offset (a DST change)");
  assert.equal(CL.fmtTime(new Date(ts).toISOString(), { offset: 0 }), "01:04", "an ISO time");
  assert.equal(CL.localIso(ts, { offset: -240 }), "2026-10-18T21:04:11-04:00");
  assert.equal(CL.localIso(ts, { offset: 330 }), "2026-10-19T06:34:11+05:30");
  assert.equal(CL.localIso(ts, { offset: 0 }), "2026-10-19T01:04:11+00:00");
  assert.equal(CL.isoOf(ts), "2026-10-19T01:04:11.123Z");
  const names = { weekdays: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
                  months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"] };
  assert.equal(CL.dayLabel(ts, { offset: -240, names, year: true }), "Sonntag 18 Oktober 2026");
  assert.equal(CL.dayLabel(ts, { offset: 0, names, year: true }), "Montag 19 Oktober 2026");
  const en = { weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] };
  assert.equal(CL.dayLabel(ts, { offset: -240, names: en, now: ts }), "Sunday 18 October", "this year: no year");
  assert.equal(CL.dayLabel(ts, { offset: -240, names: en, now: ts + 400 * 864e5 }), "Sunday 18 October 2026", "another year: the year");
  assert.equal(CL.dayLabel(ts, { offset: -240, names: en, now: ts + 400 * 864e5, year: false }), "Sunday 18 October");
  // scrollback's dividers: Today / Yesterday in the viewer's language, by the wall-clock day (not 24-hour steps)
  assert.equal(CL.dayLabel(ts, { offset: -240, names: en, relative: true, now: ts + 2 * 3600e3 }), "Today");
  assert.equal(CL.dayLabel(ts, { offset: -240, names: en, relative: true, now: ts + 3 * 3600e3 }), "Yesterday", "past local midnight");
  assert.equal(CL.dayLabel(ts, { offset: -240, names: en, relative: true, now: ts + 20 * 3600e3, t: (k, d) => (k === "js.pad.chat.yesterday" ? "Gestern" : d) }), "Gestern");
  assert.equal(CL.dayLabel(ts, { offset: -240, names: en, relative: true, now: ts + 3 * 864e5 }), "Sunday 18 October");
  // no names: with an offset (CL5 fix-up) English, never Intl whatever `lang` says (the browser, with no offset, keeps Intl);
  // missing names fall back to English
  assert.equal(CL.dayLabel(ts, { offset: -240, lang: "de", year: true }), "Sunday 18 October 2026");
  assert.match(CL.dayLabel(ts, { lang: "en-GB", year: true }), /^\w+,? \d{1,2} October 2026$/, "the browser: Intl in the page's language");
  assert.equal(CL.dayLabel(ts, { offset: -240, names: {}, year: true }), "Sunday 18 October 2026");
});

test("TXT: the 'PATV chat log v1' item grammar (spec §3.8)", () => {
  const at = (hh, mm) => Date.UTC(2026, 9, 18, hh + 4, mm);       // hh:mm on 18 October in New York (UTC−04:00)
  const ctx = { t: tEN, offset: -240, origin: "https://publicaccess.tv" };
  const L = (it) => CL.textItem(it, ctx);
  const bob = { login: "bob", display: "Bob" };
  assert.equal(L({ k: "msg", ts: at(21, 4), u: { login: "leafy1111", display: "Plantbaked", patv: { username: "pb" } }, text: "hello room" }), "[21:04] Plantbaked: hello room");
  assert.equal(L({ k: "msg", ts: at(21, 4), u: { login: "u:ABC-123456", display: "Mae", acct: true, web: true }, text: "typed on the website" }), "[21:04] Mae 🌐: typed on the website");
  assert.equal(L({ k: "tx", ts: at(21, 5), u: bob, text: "said on the mic", id: "tx-01234567" }), "[21:05] 🎙 Bob: “said on the mic”");
  assert.equal(L({ k: "join", ts: at(21, 6), u: bob }), "[21:06] → Bob joined");
  assert.equal(L({ k: "unmic", ts: at(21, 7), u: bob, ms: 180000 }), "[21:07] 🎙️ Bob dropped the mic after 3m");
  assert.equal(L({ k: "topic", ts: at(21, 8), text: "movie night at 9" }), "[21:08] 📌 topic: movie night at 9");
  assert.equal(L({ k: "live", ts: at(21, 9), who: "pb", pad: "Pepe's Pad", what: "Movie night", link: "/p/pepes-pad" }),
    "[21:09] 🎥 pb just went live on Pepe's Pad — Movie night <https://publicaccess.tv/p/pepes-pad>");
  assert.equal(L({ k: "note", ts: at(21, 10), w: "window", s: 86400 }), "[21:10] 📜 Chat history on this pad: last 24 hours");
  assert.equal(L({ k: "leave", ts: at(21, 11), u: { anon: true, display: "someone" } }), "[21:11] ← someone left");
  assert.equal(L({ k: "mic", ts: at(21, 12), u: { former: true } }), "[21:12] 🎙️ former member grabbed the mic");
  assert.equal(L({ k: "msg", ts: at(21, 13), u: bob, text: "two\nlines\r\nand a third" }), "[21:13] Bob: two ⏎ lines ⏎ and a third", "one line per item");
  assert.equal(L({ k: "msg", ts: at(21, 14), u: bob, text: "<b>&amp;</b>" }), "[21:14] Bob: <b>&amp;</b>", "plain text: nothing escaped");
  assert.equal(L({ k: "note", ts: at(21, 15), w: "something-newer" }), null);
  assert.equal(L({ k: "something-newer", ts: at(21, 15) }), null);
  assert.equal(L(null), null);
});

test("JSONL: the item objects (spec §3.8) - kinds, the author, no account ids", () => {
  const ts = Date.parse("2026-10-19T01:04:11.123Z");
  const ctx = { t: tEN, offset: -240, origin: "https://publicaccess.tv" };
  const J = (it) => CL.jsonItem(it, ctx);
  assert.equal(JSON.stringify(J({ k: "msg", c: 155960, ts, u: { login: "leafy1111", display: "Plantbaked", cf: "Plantbaked", patv: { username: "pb", avatar: "/x.png", style: "color:red" } }, text: "hello room" })),
    '{"c":155960,"ts":"2026-10-19T01:04:11.123Z","local":"2026-10-18T21:04:11-04:00","kind":"chat","author":{"name":"Plantbaked","patv":"pb","camfrog":"leafy1111","web":false,"pepe":false,"bot":false,"someone":false},"text":"hello room"}');
  const mic = J({ k: "tx", c: 155961, ts, id: "tx-0123abcd", u: { login: "bob", display: "Bob" }, text: "said on the mic" });
  assert.deepEqual(Object.keys(mic), ["c", "ts", "local", "kind", "auto", "author", "text"]);
  assert.equal(mic.kind, "mic"); assert.equal(mic.auto, true);
  const drop = J({ k: "unmic", c: 155962, ts, u: { login: "bob", display: "Bob" }, ms: 180000 });
  assert.deepEqual(Object.keys(drop), ["c", "ts", "local", "kind", "author", "held_ms"]);
  assert.equal(drop.kind, "mic_drop"); assert.equal(drop.held_ms, 180000);
  const kinds = { msg: "chat", tx: "mic", join: "join", leave: "leave", mic: "mic_grab", unmic: "mic_drop", topic: "topic", note: "note" };
  for (const [k, kind] of Object.entries(kinds)) assert.equal(J({ k, c: 1, ts, u: { login: "a", display: "A" }, text: "x", w: "search", s: 1 }).kind, kind, k);
  assert.equal(J({ k: "live", c: 1, ts, who: "pb", pad: "P" }).kind, "live");
  assert.deepEqual(J({ k: "live", c: 2, ts, np: 1, who: "pb", pad: "P", what: "Film", link: "/p/p" }),
    { c: 2, ts: "2026-10-19T01:04:11.123Z", local: "2026-10-18T21:04:11-04:00", kind: "now_playing", who: "pb", pad: "P", what: "Film", link: "https://publicaccess.tv/p/p" });
  assert.equal(J({ k: "note", c: 3, ts, w: "window", s: 0 }).text, "📜 Chat history on this pad: off");
  assert.equal(J({ k: "something-newer", c: 4, ts }), null);
  // the author: the Camfrog login only where the live chat shows it - never for a web account key, "someone" or a former member
  assert.deepEqual(J({ k: "msg", c: 5, ts, u: { login: "u:ABC-123456", display: "Mae", acct: true, web: true, patv: { username: "mae" } }, text: "w" }).author,
    { name: "Mae", patv: "mae", camfrog: null, web: true, pepe: false, bot: false, someone: false });
  assert.deepEqual(J({ k: "join", c: 6, ts, u: { anon: true, display: "someone" } }).author,
    { name: "someone", patv: null, camfrog: null, web: false, pepe: false, bot: false, someone: true });
  assert.deepEqual(J({ k: "msg", c: 7, ts, u: { former: true }, text: "x" }).author,
    { name: "former member", patv: null, camfrog: null, web: false, pepe: false, bot: false, someone: false });
  assert.deepEqual(J({ k: "msg", c: 8, ts, u: { login: "pepefrog", display: "PepeFrog", self: true, bot: true }, text: "x" }).author,
    { name: "PepeFrog", patv: null, camfrog: "pepefrog", web: false, pepe: true, bot: true, someone: false });
  // no account ids, ever: only these keys
  const allKeys = new Set();
  for (const it of FIX) { const o = J(it); if (!o) continue; Object.keys(o).forEach((k) => allKeys.add(k)); if (o.author) Object.keys(o.author).forEach((k) => allKeys.add("author." + k)); }
  for (const k of allKeys) assert.ok(["c", "ts", "local", "kind", "auto", "author", "text", "held_ms", "who", "pad", "what", "link",
    "author.name", "author.patv", "author.camfrog", "author.web", "author.pepe", "author.bot", "author.someone"].includes(k), k);
  assert.ok(!JSON.stringify(FIX.map(J)).includes("ABC-123456"), "no u:<id> account key");
});

test("room.ejs builds every line with chatlog-core: no inline copy, the stylesheet right after its style block", () => {
  const room = rd("views", "room.ejs");
  for (const gone of ["function flairEl(", "function noteText(", "function spanOf(", "function hue(", "'line' + (it.k === 'tx'", "el('div', 'sys note'", "d.style.background = 'hsl("]) {
    assert.ok(!room.includes(gone), "inline copy gone: " + gone);
  }
  assert.match(room, /function item\(it\) \{ return CLR \? CLR\.renderItem\(it, rctx, H\) : plainItem\(it\); \}/);
  // CL5 fix-up: a renderer that didn't load never takes the page down (test/chatlog-page.test.js runs the page without it)
  assert.match(room, /var CLR = window\.PATVChatlog && typeof window\.PATVChatlog\.renderItem === 'function' \? window\.PATVChatlog : null, H = CLR \? CLR\.domH\(document\) : null;/);
  assert.doesNotMatch(room, /var CLR = window\.PATVChatlog, H = CLR\.domH/, "no unguarded use");
  assert.match(room, /var rctx = \{ t: _t, lang: document\.documentElement\.lang \|\| undefined \};/);
  assert.match(room, /function avatar\(u\) \{ if \(CLR\) return CLR\.avatarNode\(u, rctx, H\);/, "the mic / people lists too");
  assert.equal((room.match(/render: renderLine, ctx: rctx,/g) || []).length, 2, "scrollback's and search's lines too (CL8 / CL9)");
  assert.match(room, /feed: feedEl, line: item,/, "your pending relay lines are built the same way (room-bridge.js)");
  // the script loads before the page's own; the stylesheet right after the block it came from (the cascade keeps its order)
  const core = room.indexOf('<script src="/public/js/chatlog-core.js?v=4"></script>'), init = room.indexOf('<script id="rmInit"');   // CL5 fix-up: v=4
  assert.ok(core > 0 && core < init, "chatlog-core.js before the page script");
  const styleEnd = room.indexOf("</style>"), link = room.indexOf('<link rel="stylesheet" href="/public/css/chatlog.css?v=9">');   // CL10: v=8 (the download dialog's rules); CL10 fix-up: v=9 (a time beside each date)
  assert.ok(styleEnd > 0 && link > styleEnd, "linked after the style block");
  assert.match(room.slice(styleEnd + 8, link), /^\s*<%#[^%]*%>\s*$/, "nothing in between but a comment");
  assert.match(room, /<main class="ds-page rm chatlog<%= LK_ && LK_\.accent \? ' pad-acc' : '' %>"/);
  // the moved rules left the page's style block, and their legacy hex values with them (the reduced-motion transition rule
  // still names .line among the controls it calms)
  const block = room.slice(room.indexOf("<style>"), styleEnd).replace(".rm .ptab, .rm .ibtn, .rm .btn, .rm .line { transition: none; }", "");
  assert.doesNotMatch(block, /\.rm \.(feed|line|sys|av)\b/);
  for (const hex of ["#e0b400", "#4f7fa8", "#0f141b", "#c8d6e5", "#c9b46a"]) assert.ok(!block.includes(hex), hex);   // the chat's own colours
  // CL5 fix-up: the heading's topic keeps the 📌 line's colour - the chat's own token, the shade it always had
  assert.match(block, /\.rm \.rm-chat \.topic \{ color: var\(--ds-chat-topic\);/);
  // ds.css carries the chat's tokens: a cached v=2 without them would leave the lines colourless, so the layout asks for v=3
  assert.match(rd("views", "layout.ejs"), /<link rel="stylesheet" href="\/public\/css\/ds\.css\?v=3">/);
  // home.ejs is left alone in v1 (its own markup and keys)
  assert.ok(!rd("views", "home.ejs").includes("PATVChatlog"));
  assert.ok(!rd("views", "home.ejs").includes("chatlog.css"));
});

test("chatlog.css: the moved rules, ds tokens only, logical properties, cx-shift and reduced motion", () => {
  const css = rd("public", "css", "chatlog.css");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal((code.match(/\{/g) || []).length, (code.match(/\}/g) || []).length, "braces balance");
  assert.doesNotMatch(code, /#[0-9a-f]{3,8}\b/i, "no hex values - tokens");
  const ds = rd("public", "css", "ds.css");
  const defined = new Set([...ds.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  for (const m of code.matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(defined.has(m[1]), "token defined in ds.css: " + m[1]);
  // logical properties (RTL) - but for the name / time gaps (CL5 fix-up): they sit between inline runs that follow the CONTENT's
  // direction, so they keep room.ejs's physical sides (a logical gap fell outside a Latin name in an RTL page)
  const gaps = [".chatlog .line .who { font-weight: bold; margin-right: 6px; }", ".chatlog .line .when { color: var(--ds-text-faint); font-size: 11px; margin-left: 4px; white-space: nowrap; }"];
  for (const g of gaps) assert.ok(code.includes(g), g);
  assert.doesNotMatch(gaps.reduce((s, g) => s.replace(g, ""), code), /(margin|padding|border)-(left|right)\s*:/, "logical properties (RTL)");
  const rules = code.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
  for (const m of rules.matchAll(/(^|[{}])\s*([^{}@]+)\{/g)) {
    // CL5 fix-up: [dir="rtl"] .chatlog … = the design system's RTL override pattern (docs/design-system.md §9)
    for (const sel of m[2].split(",")) assert.match(sel.trim(), /^(\[dir="rtl"\] )?\.chatlog /, "scoped: " + sel.trim());
  }
  // CL5 fix-up: a box-shadow bar has no logical form - every inset bar at the inline start has its [dir="rtl"] twin on the right
  const bars = [...code.matchAll(/(^|\})\s*(\.chatlog [^{}]+)\{[^}]*box-shadow: inset 3px 0 0 (var\([^)]+\))/g)];
  assert.ok(bars.length >= 2, ".line.hl and .sys.hl");
  for (const b of bars) {
    const twin = "[dir=\"rtl\"] " + b[2].trim() + " { box-shadow: inset -3px 0 0 " + b[3] + "; }";
    assert.ok(code.includes(twin), "RTL twin: " + twin);
  }
  for (const r of [/\.chatlog \.feed \{[^}]*scroll-behavior: smooth;/, /\.chatlog \.line \{ display: grid; grid-template-columns: 28px minmax\(0, 1fr\);/,
    /\.chatlog \.line\.hl \{/, /\.chatlog \.line\.tx \.who::before \{ content: "\\1F399  "; \}/, /\.chatlog \.sys \{[^}]*padding-inline: 42px 6px;/,
    /\.chatlog \.sys\.topic \{/, /\.chatlog \.sys\.note \{/, /\.chatlog \.av \{/, /\.chatlog \.av\.anon \{[^}]*!important/,
    /@media \(max-width: 860px\) \{ \.chatlog \.feed \{ height: 50vh; min-height: 260px; \} \}/,
    /@keyframes cx-shift \{ from \{ background-position: 0% 50%; \} to \{ background-position: 200% 50%; \} \}/,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.chatlog \.feed \{ scroll-behavior: auto; \}\s*\.chatlog \.cx-name \{ animation: none !important; \}/]) {
    assert.match(css, r);
  }
  // the order the rules had in room.ejs (equal specificity: the later one wins)
  const pos = (s) => { const i = css.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(pos(".chatlog .line:hover") < pos(".chatlog .line.pepe") && pos(".chatlog .line.pepe") < pos(".chatlog .line.hl") && pos(".chatlog .line.hl") < pos(".chatlog .line.tx {"));
  assert.ok(pos(".chatlog .sys {") < pos(".chatlog .sys.topic") && pos(".chatlog .feed {") < pos("@media (max-width: 860px)"));
});

test("Node 16 / old browsers: chatlog-core.js is plain ES5 with no newer APIs", () => {
  const src = rd("public", "js", "chatlog-core.js").replace(/^\s*\/\/.*$/gm, "");
  for (const re of [/\.findLast(Index)?\(/, /\.toSorted\(/, /\bstructuredClone\(/, /(^|[^.\w])fetch\(/m, /\bObject\.hasOwn\(/, /\.at\(-?\d/, /\.replaceAll\(/,
    /=>/, /\blet\s/, /\bconst\s/, /`/, /\.\.\.\w/, /\bclass\s+\w/, /\?\./, /\?\?/]) assert.doesNotMatch(src, re, String(re));
  assert.doesNotMatch(src, /<%|%>/, "no EJS tags");
});

// ── CL5 fix-up (the review): exact colours, the deliberate differences, account keys, pictures, ICU, one TXT line ──
test("CL5 fix-up: no visible change in colour - every moved colour is a --ds-chat-* token holding the exact shade room.ejs had", () => {
  const css = rd("public", "css", "chatlog.css"), ds = rd("public", "css", "ds.css");
  const tok = {};
  for (const m of ds.matchAll(/(--ds-chat-[a-z0-9-]+):\s*([^;]+);/g)) tok[m[1]] = m[2].trim();
  // selector -> property -> the value it had in room.ejs at d6263ec9 (the rules CL5 moved)
  const OLD = [
    [".chatlog .line:hover {", "background", "#161616"],
    [".chatlog .line.pepe {", "background", "#0f1a10"],
    [".chatlog .line.hl {", "background", "#2a2410"],
    [".chatlog .line.hl {", "box-shadow", "inset 3px 0 0 #e0b400"],
    [".chatlog .line.tx {", "border-inline-start", "3px solid #4f7fa8"],
    [".chatlog .line.tx {", "background", "#0f141b"],
    [".chatlog .line.tx .body {", "color", "#c8d6e5"],
    [".chatlog .sys.topic {", "color", "#c9b46a"],
    [".chatlog .av {", "color", "#0d0d0d"],
    [".chatlog .av.anon {", "background", "#2a2a2a !important"],
  ];
  for (const [sel, prop, old] of OLD) {
    const i = css.indexOf(sel);
    assert.ok(i >= 0, sel);
    const body = css.slice(i + sel.length, css.indexOf("}", i));
    const m = new RegExp("(?:^|;)\\s*" + prop + ":\\s*([^;]+);").exec(body);
    assert.ok(m, sel + " " + prop);
    const val = m[1].trim().replace(/var\((--ds-chat-[a-z0-9-]+)\)/g, (x, t) => { assert.ok(tok[t], "ds.css defines " + t); return tok[t]; });
    assert.equal(val, old, sel + " " + prop);
  }
  // the heading's topic (room.ejs) and a jump's highlighted system line (CL8) use the same tokens
  const room = rd("views", "room.ejs");
  assert.match(room, /\.rm \.rm-chat \.topic \{ color: var\(--ds-chat-topic\);/);
  assert.match(css, /\.chatlog \.sys\.hl \{ background: var\(--ds-chat-hl-bg\); box-shadow: inset 3px 0 0 var\(--ds-chat-hl-bar\);/);
  // the standard-palette counterpart of each (the owner's call) is named next to it, so re-pointing is one block
  for (const t of Object.keys(tok)) assert.match(ds, new RegExp(t + ": #[0-9a-f]{6};\\s*/\\*[^*]*\\(.*var\\(--ds-[a-z0-9-]+\\)\\)\\s*\\*/"), t);
  assert.equal(Object.keys(tok).length, 10);
});

test("CL5 fix-up: the deliberate differences from the old inline renderer - each safer, none on what the live view sends", () => {
  const doc = fakeDoc("en"), old = legacy(doc, tEN), ctx = { t: tEN, lang: "en" }, H = CL.domH(doc);
  const both = (it) => [fromDom(old.item(it)), fromDom(CL.renderItem(it, ctx, H))];
  const flat = (n) => (n == null ? "" : typeof n === "string" ? n : Object.values(n.a).join(" ") + " " + n.k.map(flat).join(" "));
  // 1. a picture outside the server's rule (another host, a "." / ".." path, a script URL): the old one loaded it, now the bubble
  for (const bad of ["//evil.example/a.png", "/uploads/../admin.png", "/uploads/./a.png", "javascript:alert(1)", "http://plain.example/a.png"]) {
    const u = { login: "zed", display: "Zed", patv: { username: "zed", avatar: bad, style: "" } };
    assert.equal(fromDom(old.avatar(u)).t, "img", "old: " + bad);
    assert.deepEqual(fromDom(CL.avatarNode(u, ctx, H)), { t: "span", a: { "aria-hidden": "true", class: "av", style: "background:hsl(" + CL.hue("zed") + ",55%,62%)" }, k: ["Z"] }, bad);
  }
  // 2. a 🎥 link that isn't a /path or https: was a link, now plain text
  for (const bad of ["javascript:alert(1)", "//evil.example/p", "http://plain.example/p"]) {
    const [a, b] = both({ k: "live", c: 1, ts: T0, who: "pb", pad: "P", link: bad });
    assert.equal(a.k[0].t, "a", "old: " + bad);
    assert.equal(typeof b.k[0], "string", bad);
  }
  // 3. a line without text: the old one printed "undefined" (text and data-text), now nothing
  const [a3, b3] = both({ k: "msg", c: 2, ts: T0, u: { login: "bob", display: "Bob" } });
  assert.match(flat(a3), /undefined/);
  assert.doesNotMatch(flat(b3), /undefined/);
  // 4. a bad time: the old toISOString threw (and took the whole addFeed batch with it), now the line shows without datetime
  for (const ts of [NaN, "not a time", undefined]) {
    assert.throws(() => old.item({ k: "msg", c: 3, ts, u: { login: "bob", display: "Bob" }, text: "x" }), RangeError);
    const n = fromDom(CL.renderItem({ k: "msg", c: 3, ts, u: { login: "bob", display: "Bob" }, text: "x" }, ctx, H));
    const time = n.k[1].k.find((k) => k && k.t === "time");
    assert.ok(time && !("datetime" in time.a), "no datetime");
  }
  // 5. an account key "u:<id>": the old one showed it (the name, a tooltip on your own pending line); now never
  const key = { login: "u:ABC-123456", display: "", acct: true, web: true };
  assert.match(flat(both({ k: "msg", c: 4, ts: T0, u: key, text: "x" })[0]), /ABC-123456/);
  assert.doesNotMatch(flat(both({ k: "msg", c: 4, ts: T0, u: key, text: "x" })[1]), /ABC-123456/i);
  const mine = { login: "u:ABC-123456", display: "Mae", web: true, patv: { username: "mae", avatar: null, style: "" } };   // bridge.meFor: no acct flag
  assert.equal(fromDom(old.name(mine)).k[0].a.title, "u:ABC-123456", "old: the key as the tooltip");
  assert.equal(fromDom(CL.nameNode(mine, ctx, H)).k[0].a.title, undefined);
});

test("CL5 fix-up: an account key u:<id> never shows - name, tooltip, letter, data-name, TXT, JSONL - 'a PATV member' instead", () => {
  const ctx = { t: tEN, lang: "en" }, file = { t: tEN, offset: 0, origin: "https://publicaccess.tv", data: false };
  const KEYS = [{ login: "u:ABC-123456", acct: true, web: true }, { login: "u:ABC-123456", display: "u:ABC-123456", acct: true, web: true },
    { login: "U:abc-123456", display: "u:ABC-123456", web: true }, { login: "", display: "u:ABC-123456", web: true },
    { login: "u:ABC-123456", display: "u:ABC-123456", web: true, patv: { username: "mae", avatar: null, style: "" } }];
  for (const u of KEYS) {
    const outs = [CL.label(u, ctx), String(CL.nameNode(u, ctx, CL.htmlH)), String(CL.avatarNode(u, ctx, CL.htmlH)),
      String(CL.renderItem({ k: "msg", c: 9, ts: T0, u, text: "hi" }, ctx, CL.htmlH)), String(CL.renderItem({ k: "join", c: 10, ts: T0, u }, ctx, CL.htmlH)),
      CL.textItem({ k: "msg", ts: T0, u, text: "hi" }, file), CL.textItem({ k: "unmic", ts: T0, u, ms: 5000 }, file),
      JSON.stringify(CL.jsonItem({ k: "msg", c: 9, ts: T0, u, text: "hi" }, file)), JSON.stringify(CL.jsonItem({ k: "leave", c: 11, ts: T0, u }, file))];
    for (const s of outs) assert.doesNotMatch(s, /abc-123456/i, JSON.stringify(u) + " -> " + s);
    assert.equal(CL.label(u, ctx), "a PATV member");
    assert.match(String(CL.renderItem({ k: "msg", c: 9, ts: T0, u, text: "hi" }, ctx, CL.htmlH)), /data-name="a PATV member"/);
    assert.match(String(CL.avatarNode(u, ctx, CL.htmlH)), />A<\/span>$/);
    assert.equal(CL.jsonItem({ k: "msg", c: 9, ts: T0, u, text: "hi" }, file).author.name, "a PATV member");
    assert.equal(CL.jsonItem({ k: "msg", c: 9, ts: T0, u, text: "hi" }, file).author.camfrog, null);
  }
  assert.equal(CL.label({ login: "u:ABC-123456" }, { t: (k, d) => (k === "js.pad.chat.member" ? "ein PATV-Mitglied" : d) }), "ein PATV-Mitglied", "translated");
  assert.equal(EN["js.pad.chat.member"], "a PATV member");
  // everyone else is as before: a resolved web member, a Camfrog login, a Camfrog display name that merely looks like a key
  assert.equal(CL.label({ login: "u:ABC-123456", display: "Mae", acct: true }, ctx), "Mae");
  assert.equal(CL.label({ login: "bob", display: "" }, ctx), "bob");
  assert.equal(CL.label({ login: "bob", display: "u:smiley-face" }, ctx), "u:smiley-face", "a Camfrog member's own display name");
  assert.equal(CL.label({ display: "you", login: "", web: true }, ctx), "you", "your pending line before your look is known");
  assert.equal(CL.label({ login: "", display: "" }, ctx), "");
});

test("CL5 fix-up: pictures - a site path never starts '//' and has no '.' / '..' segment (stricter than bridge.js safeImg)", () => {
  for (const bad of ["//evil.example/a.png", "/uploads/../secret.png", "/uploads/./a.png", "/..", "/.", "/uploads/avatars/..", "/a/../../b.png", "/a b.png", "/a.png?x", "http://x/a.png"]) {
    assert.equal(CL.safeSrc(bad), false, bad);
  }
  for (const ok of ["/uploads/avatars/pb.png", "/uploads/avatars/a..b.png", "/public/img/v1.2/pepe.png", "/uploads/.x.png", "https://cdn.example.com/a/../b.png"]) {
    assert.equal(CL.safeSrc(ok), true, ok);
  }
});

test("CL5 fix-up: with an offset nothing calls Intl - the 📜 note's day and day labels too (any ICU build, any machine zone)", () => {
  const o = Date.parse("2026-10-18T23:30:00Z");                      // 19 October in UTC+01:00; 18 October in New York (this machine?)
  const note = { k: "note", c: 7, ts: o, w: "open", o };
  const de = { weekdays: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
               months: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"] };
  const saved = { ld: Date.prototype.toLocaleDateString, ls: Date.prototype.toLocaleString, lt: Date.prototype.toLocaleTimeString, dtf: Intl.DateTimeFormat };
  const boom = () => { throw new Error("Intl used"); };
  Date.prototype.toLocaleDateString = boom; Date.prototype.toLocaleString = boom; Date.prototype.toLocaleTimeString = boom; Intl.DateTimeFormat = boom;
  try {
    const f = { t: tEN, offset: 60 };
    assert.equal(CL.noteText(note, f), "📜 Earlier history opens on 19 October");
    assert.equal(CL.textItem(note, f), "[00:30] 📜 Earlier history opens on 19 October");
    assert.equal(CL.jsonItem(note, f).text, "📜 Earlier history opens on 19 October");
    assert.equal(CL.jsonItem(note, f).local, "2026-10-19T00:30:00+01:00");
    assert.match(String(CL.renderItem(note, f, CL.htmlH)), /^<div class="sys note">📜 Earlier history opens on 19 October · 00:30<\/div>$/);
    assert.equal(CL.noteText(note, { t: tEN, offset: -240 }), "📜 Earlier history opens on 18 October");
    assert.equal(CL.noteText(note, { t: tEN, offset: (ms) => (ms > 0 ? 60 : 0) }), "📜 Earlier history opens on 19 October", "a per-moment offset");
    assert.equal(CL.noteText(note, { t: tEN, offset: 60, names: de }), "📜 Earlier history opens on 19 Oktober", "the file's language");
    assert.equal(CL.noteText(note, { t: tEN, offset: 60, date: () => "the 19th" }), "📜 Earlier history opens on the 19th", "ctx.date still wins");
    assert.equal(CL.noteText({ k: "note", w: "open", o: NaN }, f), "📜 Earlier history opens on ");
    // day labels: names, else English - never Intl, whatever `lang` says
    assert.equal(CL.dayLabel(o, { offset: 60, year: true }), "Monday 19 October 2026");
    assert.equal(CL.dayLabel(o, { offset: 60, year: true, lang: "de" }), "Monday 19 October 2026");
    assert.equal(CL.dayLabel(o, { offset: 60, year: true, names: de }), "Montag 19 Oktober 2026");
    assert.equal(CL.dayLabel(o, { offset: -240, year: false }), "Sunday 18 October");
    assert.equal(CL.dayLabel(NaN, { offset: 0 }), "");
    assert.equal(CL.fmtTime(o, f), "00:30");
  } finally {
    Date.prototype.toLocaleDateString = saved.ld; Date.prototype.toLocaleString = saved.ls; Date.prototype.toLocaleTimeString = saved.lt; Intl.DateTimeFormat = saved.dtf;
  }
  // the browser (no offset, no names) keeps Intl in the page's language - the live chat's 📜 line is unchanged (the parity fixture
  // c=132 compares it with the old renderer)
  assert.equal(CL.noteText(note, { t: tEN, lang: "en-GB" }), "📜 Earlier history opens on " + new Date(o).toLocaleDateString("en-GB", { day: "numeric", month: "long" }));
});

test("CL5 fix-up: TXT - one line per item whatever the text holds (every Unicode line break folded, control characters neutralised)", () => {
  const f = { t: tEN, offset: 0 }, bob = { login: "bob", display: "Bob" };
  const BREAKS = ["\n", "\r", "\r\n", "\u000b", "\u000c", "\u001c", "\u001d", "\u001e", "\u0085", "\u2028", "\u2029"];
  for (const br of BREAKS) {
    const s = CL.textItem({ k: "msg", ts: T0, u: bob, text: "hi" + br + "[01:04] pb: forged" }, f);
    assert.equal(s, "[01:04] Bob: hi ⏎ [01:04] pb: forged", JSON.stringify(br));
  }
  // every splitter a reader might use (JS, Python's str.splitlines, a terminal) sees ONE line - in names, topics and 🎥 lines too
  const evil = "a" + BREAKS.join("b") + "c\u001b[1A\u001b[2K\u0007\u007f\u009b\u0000z\tq";
  const lines = [CL.textItem({ k: "msg", ts: T0, u: { login: "bob", display: "Bo" + "\u2028b" }, text: evil }, f),
    CL.textItem({ k: "tx", ts: T0, u: bob, text: evil }, f), CL.textItem({ k: "topic", ts: T0, text: evil }, f),
    CL.textItem({ k: "live", ts: T0, who: "p\u2029b", pad: "P\u0085", what: evil, link: "/p/x" }, f), CL.textItem({ k: "join", ts: T0, u: { login: "x", display: "X\u000bY" } }, f)];
  for (const s of lines) {
    assert.doesNotMatch(s, /[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/, JSON.stringify(s));
    assert.doesNotMatch(s, /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/, "no control characters: " + JSON.stringify(s));
  }
  assert.match(lines[0], /^\[01:04\] Bo ⏎ b: a ⏎ b ⏎ b ⏎ b/);
  assert.match(lines[0], /c�\[1A�\[2K����z\tq$/, "ESC / BEL / DEL / CSI / NUL -> U+FFFD, the tab stays");
  // the live page and the HTML keep the text as it is (each line is its own element there)
  assert.match(String(CL.renderItem({ k: "msg", c: 1, ts: T0, u: bob, text: "a\u2028b" }, { t: tEN }, CL.htmlH)), /data-text="a\u2028b"/);
});

test("CL6: a hidden line as the owner / staff see it (muted, why, data-rmc - never ✂️-able), a purged one; the viewer's own lines carry data-own", () => {
  const ctx = { t: tEN, lang: "en" }, doc = fakeDoc("en");
  const base = { c: 300, k: "msg", ts: T0, u: { login: "bob", display: "Bob" }, text: "said something" };
  assert.equal(CL.renderItem(Object.assign({}, base, { own: 1 }), ctx, recH).attrs["data-own"], "1");
  assert.equal(CL.renderItem(base, ctx, recH).attrs["data-own"], undefined);
  assert.equal(CL.renderItem(Object.assign({}, base, { own: 1 }), Object.assign({ data: false }, ctx), recH).attrs["data-own"], undefined, "downloads: no data-*");
  const hidden = Object.assign({}, base, { removed: { at: T0, by: "mod", who: "mae", why: "spam" } });
  const s = String(CL.renderItem(hidden, ctx, CL.htmlH));
  assert.match(s, /^<div class="line rm" data-rmc="300" data-rm="mod">/);
  assert.doesNotMatch(s, /data-c=|data-text=|data-name=|data-own=/, "chat-clip.js picks .line[data-c] - a hidden line never");
  assert.match(s, /<span class="rm-note">Hidden by @mae · spam<\/span>/);
  assert.match(s, /said something/);
  assert.equal(CL.removedNote({ by: "self" }, ctx), "Removed by its author");
  assert.equal(CL.removedNote({ by: "report" }, ctx), "Hidden after a report");
  assert.equal(CL.removedNote({ by: "mod" }, ctx), "Hidden by a moderator");
  assert.equal(CL.removedNote({ by: "staff", who: "helper" }, ctx), "Hidden by @helper");
  assert.equal(CL.removedNote({ purged: true }, ctx), "Removed");
  const purged = { c: 301, k: "msg", ts: T0, u: { anon: true, display: "someone" }, removed: { purged: true } };
  assert.match(String(CL.renderItem(purged, ctx, CL.htmlH)), /^<div class="sys rm" data-rmc="301" data-rm="purged">Removed · \d\d:\d\d<\/div>$/);
  const sysHidden = { c: 302, k: "topic", ts: T0, text: "a topic", removed: { at: T0, by: "staff", why: "" } };
  // CL6 fix-up: a staff hide without a name (the owner's view) is "PATV staff", never "a moderator"
  assert.match(String(CL.renderItem(sysHidden, ctx, CL.htmlH)), /^<div class="sys rm" data-rmc="302" data-rm="staff">Hidden by PATV staff · /);
  assert.equal(CL.removedNote({ by: "staff" }, ctx), "Hidden by PATV staff");
  // CL6 fix-up: a SEALED row (the owner's view of a self-removal or a "minor" report's hide) has no words and no speaker: a .sys.rm
  const sealed = { c: 303, k: "msg", ts: T0, u: { anon: true, display: "someone" }, removed: { at: T0, by: "self", sealed: true } };
  const ss = String(CL.renderItem(sealed, ctx, CL.htmlH));
  assert.match(ss, /^<div class="sys rm" data-rmc="303" data-rm="self">Removed by its author · \d\d:\d\d<\/div>$/);
  const sealedRep = { c: 304, k: "tx", ts: T0, u: { anon: true, display: "someone" }, removed: { at: T0, by: "staff", sealed: true } };
  assert.match(String(CL.renderItem(sealedRep, ctx, CL.htmlH)), /^<div class="sys rm" data-rmc="304" data-rm="staff">Hidden by PATV staff · \d\d:\d\d<\/div>$/);
  for (const it of [hidden, purged, sysHidden, sealed, sealedRep, Object.assign({}, base, { k: "tx", id: "tx-1", own: 1 })]) {
    const rec = fromRec(CL.renderItem(it, ctx, recH));
    assert.deepEqual(fromDom(CL.renderItem(it, ctx, CL.domH(doc))), rec);
    assert.deepEqual(fromHtml(String(CL.renderItem(it, ctx, CL.htmlH))), rec);
  }
  for (const k of ["js.pad.chat.removed", "js.pad.chat.removed_self", "js.pad.chat.hidden_report", "js.pad.chat.hidden_by", "js.pad.chat.hidden_mod",
                   "js.pad.chat.hidden_staff"]) assert.ok(EN[k], k);
  const css = rd("public", "css", "chatlog.css");
  for (const r of [/\.chatlog \.line\.rm \{/, /\.chatlog \.sys\.rm \{/, /\.chatlog \.line \.la-btn \{/, /\.chatlog \.feed-log\.cc-on \.line \.la-btn \{ display: none; \}/,   // CL8: the live log
                   /@media \(hover: none\) \{[^}]*\.chatlog \.line\.la \{ padding-inline-end: 50px; \}/]) assert.match(css, r);
  assert.doesNotMatch(css.slice(css.indexOf("CL6")), /#[0-9a-f]{3,6}\b/i, "CL6's rules: ds tokens only");
});
