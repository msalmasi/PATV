// 🎙 mic follows - the page side (static checks + sandboxes, like camstrip.test.js): stage-mic.js (text only via
// textContent, aria, muted / playsinline video, one tile per person in position order, Brady Bunch fillers, a ticket per
// live tile and a stop when it leaves), the CSS (layouts, 44 px targets, reduced motion), the room page (stage-mic.js
// only with WebRTC, one setMic inside safe()), stage-room.js (the default-view precedence, capture off), the pad
// settings card and the privacy switch render, and every new string exists in locales/en.json.
//   node --test test/micfollow-ui.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const EN = JSON.parse(read("locales", "en.json"));

// ── a tiny DOM for the sandboxes ──
function fakeDom() {
  const all = [];
  function mk(tag) {
    const e = { tagName: String(tag).toUpperCase(), children: [], attrs: {}, style: {}, hidden: false, parentNode: null, listeners: {}, className: "", _text: "",
      classList: { _e: null, has(c) { return (" " + e.className + " ").includes(" " + c + " "); },
        add(c) { if (!this.has(c)) e.className = (e.className + " " + c).trim(); }, remove(c) { e.className = (" " + e.className + " ").replace(" " + c + " ", " ").trim(); },
        toggle(c, on) { const want = on === undefined ? !this.has(c) : !!on; if (want) this.add(c); else this.remove(c); return want; }, contains(c) { return this.has(c); } },
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
      insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
      hasAttribute(k) { return k in this.attrs; },
      addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
      set textContent(v) { this._text = String(v); this.children = []; },
      get firstChild() { return this.children[0] || null; },
      querySelectorAll(sel) { const cls = sel.replace(/^\./, ""); const out = []; const walk = (n) => { for (const c of n.children) { if ((" " + c.className + " ").includes(" " + cls + " ")) out.push(c); walk(c); } }; walk(this); return out; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      play() { return Promise.resolve(); }, focus() {}, getBoundingClientRect() { return { width: 640 }; }, clientWidth: 640 };
    e.classList._e = e;
    Object.defineProperty(e, "innerHTML", { configurable: true, set() { throw new Error("innerHTML used"); }, get() { return ""; } });
    all.push(e);
    return e;
  }
  return { mk, all };
}

test("stage-mic.js: textContent only, aria, muted + playsinline video, tile per person, fillers, a ticket per live tile, stop on leave", async () => {
  const js = read("public", "js", "stage-mic.js");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/, "all text via textContent");
  for (const re of [/setAttribute\('role', 'group'\)/, /aria-live/, /aria-current/, /'playsinline'/, /v\.muted = true/, /PATVRtc\.watch/, /\/micfollow\/watch/,
                    /beat: true/, /stop: true/, /visibilitychange/, /HIDDEN_MS = 30000/, /Object\.create\(null\)/]) assert.match(js, re);
  const dom = fakeDom();
  const posts = [];
  const ctx = { document: { createElement: dom.mk, hidden: false, addEventListener() {}, removeEventListener() {} }, console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    fetch: (u, o) => { posts.push([u, o && o.body ? JSON.parse(o.body) : null]); return Promise.resolve({ json: () => Promise.resolve({ ok: true, whep: "https://x/whep?pt=1" }) }); },
    PATVRtc: { watch: () => new Promise(() => {}) }, RTCPeerConnection: function () {}, Date };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const host = dom.mk("div");
  const prog = (src, extra) => Object.assign({ v: 1, layout: "grid9", count: src.length, src, manage: null, still_s: 20 }, extra || {});
  const s = (id, pos, video, extra) => Object.assign({ kind: "cam", id, name: id.toUpperCase(), pos, newest: false, video, why: video === "card" ? "off_cam" : null, watch: "ok" }, extra || {});
  const ctl = ctx.PATVStageMic.render(host, prog([s("c", 2, "card"), s("a", 0, "live"), s("b", 1, "starting", { newest: true }),
                                                    s("d", 3, "live", { watch: "members_only" }), s("e", 4, "still")]), { slug: "pad" });
  const stage = host.children[0];
  assert.equal(stage.getAttribute("data-layout"), "grid9");
  assert.equal(stage.getAttribute("aria-label"), "On the mic: 5 people", "spec §6.2 / S-18: 'On the mic: N people'");
  const grid = stage.children[0];
  const ids = grid.children.filter((c) => c.className === "mf-tile" || c.className.startsWith("mf-tile")).map((c) => c.getAttribute("data-id"));
  assert.deepEqual(ids, ["a", "b", "c", "d", "e"], "reading order = positions");
  assert.equal(grid.children.filter((c) => c.className === "mf-empty").length, 4, "3x3: empty cells stay black");
  const b = grid.children.find((c) => c.getAttribute && c.getAttribute("data-id") === "b");
  assert.equal(b.getAttribute("aria-current"), "true");
  assert.ok(b.classList.contains("newest"));
  await new Promise((r) => setTimeout(r, 10));
  const watched = posts.filter((p) => /\/micfollow\/watch$/.test(p[0])).map((p) => p[1]);
  assert.deepEqual(watched.map((w) => w.login), ["a"], "a ticket for the live tile the viewer may watch, nobody else");
  assert.ok(posts.some((p) => /\/micfollow\/still\/e$/.test(p[0])), "the still tile asks for its frame");
  const d = grid.children.find((c) => c.getAttribute && c.getAttribute("data-id") === "d");
  assert.match(d.textContent, /only for members/);
  // a leaves: its session is closed (stop) and the tile is gone; the layout follows
  ctl.update(prog([s("b", 0, "live", { newest: true }), s("c", 1, "card")], { layout: "split" }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(posts.some((p) => /\/micfollow\/watch$/.test(p[0]) && p[1].login === "a" && p[1].stop === true));
  assert.equal(stage.getAttribute("data-layout"), "split");
  assert.equal(grid.children.filter((c) => c.className === "mf-empty").length, 0);
  assert.equal(ctl.selection().capture, false);
  assert.equal(ctl.selection().embed, true);
  // signed out: a note, no tiles, no requests
  posts.length = 0;
  ctl.update(prog([], { count: 3, signin: true }));
  assert.match(stage.children.find((c) => c.className === "mf-note").textContent, /sign in to watch/);
  ctl.stop();
  assert.equal(host.children.length, 0);
});

test("stage-mic.js: 'On the mic: 1 person'; a still that can't be shown says why (not 'starting' for ever); Escape closes ⋯ Manage", async () => {
  const js = read("public", "js", "stage-mic.js");
  const dom = fakeDom();
  const stills = { e: { ok: false, code: "blocked", error: "blocked here" }, f: { ok: true, state: "refused" }, g: { ok: true, state: "pending" } };
  let focused = null;
  const ctx = { document: { createElement: (t) => { const e = dom.mk(t); e.focus = () => { focused = e; }; return e; }, hidden: false, addEventListener() {}, removeEventListener() {} },
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: (u) => {
      const m = /\/still\/(\w+)$/.exec(u);
      return Promise.resolve({ json: () => Promise.resolve(m ? stills[m[1]] : { ok: true }) });
    },
    PATVRtc: { watch: () => new Promise(() => {}) }, RTCPeerConnection: function () {}, Date };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const host = dom.mk("div");
  const s = (id, pos, video, extra) => Object.assign({ kind: "cam", id, name: id.toUpperCase(), pos, newest: false, video, why: null, watch: "ok" }, extra || {});
  const ctl = ctx.PATVStageMic.render(host, { v: 1, layout: "single", count: 1, src: [s("e", 0, "still")], manage: { excluded_n: 0 }, still_s: 20 }, { slug: "pad" });
  const stage = host.children[0];
  assert.equal(stage.getAttribute("aria-label"), "On the mic: 1 person");
  await new Promise((r) => setTimeout(r, 10));
  const tileOf = (id) => stage.children[0].children.find((c) => c.getAttribute && c.getAttribute("data-id") === id);
  assert.match(tileOf("e").textContent, /blocked for you here/, "a refused still says why");
  assert.doesNotMatch(tileOf("e").textContent, /starting/);
  ctl.update({ v: 2, layout: "grid4", count: 3, src: [s("e", 0, "still"), s("f", 1, "still"), s("g", 2, "still")], manage: { excluded_n: 0 }, still_s: 20 });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(tileOf("f").textContent, /isn't available/, "a refused frame: a reason card");
  assert.match(tileOf("g").textContent, /starting/, "one pending round is still 'starting'");
  // a blocked still from the program itself (viewFor's watch: "blocked")
  ctl.update({ v: 3, layout: "single", count: 1, src: [s("h", 0, "still", { watch: "blocked" })], manage: { excluded_n: 0 }, still_s: 20 });
  assert.match(tileOf("h").textContent, /blocked for you here/);
  // ⋯ Manage: Escape closes it and puts the focus back on ⋯
  // (⋯ Manage lives in the bar ABOVE the tiles now - review r4)
  const bar = stage.children.find((c) => c.className === "mf-bar");
  const mBtn = bar.children.find((c) => c.className === "mf-mbtn"), panel = stage.children.find((c) => c.className === "mf-panel");
  mBtn.listeners.click[0]();
  assert.equal(panel.hidden, false);
  assert.equal(mBtn.getAttribute("aria-expanded"), "true");
  let prevented = false;
  panel.listeners.keydown[0]({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(panel.hidden, true);
  assert.equal(prevented, true);
  assert.equal(focused, mBtn, "the focus goes back to ⋯");
  ctl.stop();
});

test("webrtc.css: the layouts, 44 px targets, contain (never cropped), reduced motion", () => {
  const css = read("public", "css", "webrtc.css");
  for (const l of ["split", "grid4", "grid9", "pip"]) assert.match(css, new RegExp(`\\.mf-stage\\[data-layout=${l}\\]`));
  assert.match(css, /\.mf-tile \.rtc-video \{[^}]*object-fit: contain/);
  assert.match(css, /\.mf-x \{[^}]*min-width: 44px; min-height: 44px/);
  assert.match(css, /\.mf-mbtn \{[^}]*min-height: 44px/);
  assert.match(css, /\.mf-tapall \{[^}]*min-height: 44px/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.player \.mf-stage/);
  // mfix: the tile that fills a PiP is .main (the newest speaker, else the latest mic tile - a pin sits in the corner)
  assert.match(css, /\.narrow\[data-layout=pip\] \.mf-tile:not\(\.main\) \{ width: 38%/);
  assert.match(css, /\.mf-stage\.mf-dim \.mf-tile \.rtc-video/, "mfix: dimmed tiles while someone nobody can show talks");
  assert.match(css, /\.mf-off \{[^}]*min-height: 44px/, "mfix: 🙈 Take me off is a 44 px target");
});

test("room.ejs: stage-mic.js only with WebRTC; ONE setMic, inside safe(); the switcher is kept as PATVPadStage", () => {
  const room = read("views", "room.ejs");
  // review fix: the block ends where the onair scripts start (lip sync's own <% if %> sits inside it now)
  const blk = room.slice(room.indexOf("locals.webrtcCfg()) { %>"), room.indexOf("<% } %><% if (typeof onairAdmin", room.indexOf("locals.webrtcCfg()) { %>")));
  assert.match(blk, /stage-mic\.js\?v=\d+/);
  assert.equal((room.match(/stage-mic\.js/g) || []).length, 1);
  assert.equal((room.match(/PATVPadStage\.setMic\(/g) || []).length, 1);
  const gate = room.slice(room.indexOf("safe('stagemic'"), room.indexOf("safe('feed'"));
  assert.match(gate, /var showMic = function \(p\) \{ PATVPadStage\.setMic\(p\); \};/);
  assert.match(gate, /if \(window\.PATVAvSync\) window\.PATVAvSync\.gateProgram\(slug, d\.stage_program \|\| null, showMic\);/);
  assert.match(gate, /else showMic\(d\.stage_program \|\| null\);/);
  // (wave2 WP-4: av-sync.js?v=3 - it delays the dynamic layout's `ring` like newest / recent; 1.99ahm: v=4 - the On the mic card / chat lines;
  // v=5 - the people list's 🎙 icons; 1.99ahp v=6 - a stable program's places too)
  assert.ok(blk.indexOf('av-sync.js?v=6') >= 0 && blk.indexOf('av-sync.js?v=6') < blk.indexOf('webrtc-client.js?v=6'), 'controller loads before live-cam receivers');
  assert.match(blk, /<% if \(locals\.avsyncOn\) \{ %><script src="\/public\/js\/av-sync\.js\?v=6"><\/script><% \} %>/, "review fix: only while lip sync applies to the viewer");
  assert.match(room, /window\.PATVPadStage = PATVStage\.switcher\(\{/);
  assert.doesNotMatch(read("views", "home.ejs"), /stage-mic|setMic/, "the homepage never renders the mic stage");
});

function switcher(opts, withMic = true) {
  const js = read("public", "js", "stage-room.js");
  const dom = fakeDom();
  const rendered = [], timers = [];
  // (mfix: the mic view's grace timer is collected, so a test can run it as if 45 s had passed)
  const ctx = { document: { readyState: "complete", createElement: dom.mk }, console, setInterval: () => 0, clearInterval() {},
    setTimeout: (fn, ms) => { if (ms >= 40000) { timers.push(fn); return 1000 + timers.length; } return setTimeout(fn, ms); },
    clearTimeout: (h) => { if (h > 1000) timers[h - 1001] = null; else clearTimeout(h); }, location: { hostname: "x" },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }), confirm: () => false, alert() {} };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  ctx.PATVStage = { player: () => ({ stop() {}, setSrc() {}, start() {}, running: () => false }) };
  if (withMic) ctx.PATVStageMic = { render: (host, p) => { rendered.push(p); return { update(q) { rendered.push(q); }, stop() {}, selection: () => ({ stream: "mic", embed: true, capture: false, nsfw: false }) }; } };
  vm.runInNewContext(js, ctx);
  const tabs = dom.mk("div");
  let html = "";
  Object.defineProperty(tabs, "innerHTML", { set(v) { html = v; }, get() { return html; } });
  const sw = ctx.PATVStage.switcher(Object.assign({ tabs, wrap: dom.mk("div"), api: "/api/stage?room=pad", slots: [], pepeOn: true, pepeHere: true, slug: "pad", watch: false }, opts));
  return { sw, rendered, tabs: () => html, grace: () => { const fns = timers.splice(0); for (const f of fns) if (f) f(); }, click: (ev) => tabs.listeners.click[0](ev) };
}
const MIC = (extra) => Object.assign({ v: 1, active: true, count: 2, default: "first", layout: "split", src: [{ id: "a" }, { id: "b" }] }, extra || {});

test("stage-room.js: the default view - a chosen feature > the mic stage > an auto-featured stream > Pepe; capture off", () => {
  let x = switcher({});
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "mic", "the mic stage over Pepe's stream");
  assert.equal(x.sw.selection().capture, false);
  assert.match(x.tabs(), /data-v="mic"[^>]*>.*🎙 On the mic \(2\)/);
  assert.ok(x.tabs().indexOf('data-v="mic"') < x.tabs().indexOf('data-v="pepe"'), "before Pepe's tab");
  x = switcher({ slots: [{ id: "s1", display: "Stream", featured: true, feature_by: "auto", hls: "x" }] });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "mic", "over an AUTO-featured stream (default first)");
  x = switcher({ slots: [{ id: "s1", display: "Stream", featured: true, feature_by: "auto", hls: "x" }] });
  x.sw.setMic(MIC({ default: "after_streams" }));
  assert.equal(x.sw.view(), "slot:s1", "after_streams: any featured stream first");
  x = switcher({ slots: [{ id: "s1", display: "Stream", featured: true, feature_by: "owner", hls: "x" }] });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "slot:s1", "a feature someone chose wins");
  x = switcher({ pepeSrc: { mode: "stream", featured: true } });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "pepe", "Pepe's stream featured for an event");
  x = switcher({});
  x.sw.setMic(MIC({ default: "tab" }));
  assert.equal(x.sw.view(), "pepe", "only a tab");
  assert.match(x.tabs(), /data-v="mic"/);
  x = switcher({});
  x.sw.setMic(MIC({ active: false }));
  assert.equal(x.sw.view(), "pepe", "only name cards: not the default (OD-4)");
  x = switcher({});
  x.sw.setMic(MIC({ signin: true, src: [] }));
  assert.equal(x.sw.view(), "pepe");
  assert.match(x.tabs(), /sign in to watch/);
  // it goes idle: mfix - the view stays a while ("nobody is on the mic right now"), then back to the default
  x = switcher({});
  x.sw.setMic(MIC());
  x.sw.setMic(MIC({ count: 0, src: [], active: false }));
  assert.equal(x.sw.view(), "mic", "kept through the grace - a short gap between mic-ups doesn't flip viewers to Pepe");
  assert.match(x.tabs(), /data-v="mic"/);
  assert.equal(x.rendered[x.rendered.length - 1].idle, true, "the mic stage says nobody is on the mic right now");
  x.sw.setMic(MIC({ count: 1, src: [{ id: "a" }] }));
  assert.equal(x.sw.view(), "mic", "back within the grace: still the mic stage");
  x.sw.setMic(MIC({ count: 0, src: [], active: false }));
  x.grace();
  assert.equal(x.sw.view(), "pepe", "after the grace: the default");
  assert.doesNotMatch(x.tabs(), /data-v="mic"/);
  // mic follows switched off on the pad (null): at once
  x = switcher({});
  x.sw.setMic(MIC());
  x.sw.setMic(null);
  assert.equal(x.sw.view(), "pepe");
  // without stage-mic.js (WebRTC off) setMic does nothing
  x = switcher({}, false);
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "pepe");
});

test("/stage/admin: the 🎙 Mic follows card - the kill switch for staff, knobs + the appearance log only for admins", () => {
  const ejs = require("ejs");
  const core = require(path.join(repo, "micfollow-core"));
  const file = path.join(repo, "views", "stageAdmin.ejs");
  const tpl = read("views", "stageAdmin.ejs").replace(/<%- include\([^%]*%>/g, "");
  const C = { takeover_mode: "when_idle", price_per_min: 1000, min_minutes: 5, max_minutes: 60, pad_max_minutes: 360, max_concurrent: 6, max_slots_per_room: 4,
              schedule_days: 14, schedule_per_user: 3, lead_min: 5, queue_max: 10, start_window_min: 10, idle_grace_min: 5, bookings_per_hour: 3, room_rtc_cap: 25 };
  const state = { config: C, open: [], upcoming: [], log: [], bans: [], events: [], rtmp_app: "stage -> live", relays: 0, pepe_src: { mode: "stream" } };
  const mf = (admin) => ({ cfg: { ...core.DEFAULTS, enabled: true }, fields: core.FIELDS, admin, pads: [], metrics: {}, ...(admin ? { spans: [{ login: "x</script>" }] } : {}) });
  const staff = ejs.render(tpl, { user: "s", isAdmin: false, state, mf: mf(false) }, { filename: file });
  assert.match(staff, /id="mfCard"/);
  assert.match(staff, /id="mfKill" checked/);
  assert.doesNotMatch(staff, /id="mfCfg"|id="mfSpans"/);
  assert.match(staff, /stage-mf-admin\.js\?v=4/);           // (1.99afl: the Health column; 1.99afn: the courtesy-notice counts; wave2 WP-4: kept relays)
  assert.match(staff, /id="mfReports"/, "⚑ reports to review (staff)");
  const adm = ejs.render(tpl, { user: "a", isAdmin: true, state, mf: mf(true) }, { filename: file });
  assert.match(adm, /id="mfCfg"/);
  assert.match(adm, /id="mfSpans"/);
  assert.doesNotMatch(adm, /x<\/script>/, "the state JSON can't close its script tag");
  assert.doesNotMatch(ejs.render(tpl, { user: "a", isAdmin: true, state }, { filename: file }), /id="mfCard"/, "no card without the capability");
  const js = read("public", "js", "stage-mf-admin.js");
  assert.doesNotMatch(js, /innerHTML/);
  assert.match(js, /\/api\/stage\/admin\/micfollow\/kill/);
});

test("the pad settings card and the privacy switch render; every new string is in locales/en.json", async () => {
  const ejs = require("ejs");
  const mf = { settings: { on: true, layout: "grid", default_view: "first", max_people: 4, max_live: 3 }, on: true, running: false, why_off: "room_off", can_run: false,
               run_why: "room_off", tiles: 0, unproven_n: 2, excluded: [{ login: "bob", until: null, reason: "owner", by: "o", at: 1 }], max_live_cap: 4, site_on: true,
               layouts: ["auto", "single", "split", "grid", "pip"], default_views: ["first", "after_streams", "tab"], room_name: "Mic <Room>" };
  const html = await ejs.renderFile(path.join(repo, "views", "partials", "pad-micfollow.ejs"), { slug: "pad", room: { title: "Pad" }, mf });
  for (const re of [/id="mfForm"/, /name="on" checked/, /<option value="grid" selected>/, /name="max_live" min="1" max="4" value="3"/, /Mic &lt;Room&gt;/,
                    /bridge livecams on/, /2 people on the mic couldn/, /data-url="\/api\/rooms\/pad\/micfollow\/exclude"/, /pad-micfollow\.js/]) assert.match(html, re);
  const ps = read("views", "padSettings.ejs");
  assert.match(ps, /include\('partials\/pad-micfollow', \{ slug, room, mf \}\)/);
  const pv = await ejs.renderFile(path.join(repo, "views", "privacy-settings.ejs"), {
    user: "alice", st: { linked: true, on: false, login: "alice", log: [] }, lc: { linked: true, login: "alice", off: false },
    mf: { linked: true, login: "alice", auto: false, spans: [{ pad: "Pad <b>", started: Date.UTC(2026, 9, 19), secs: 30, video_secs: 20 }] }, oa: null, gh: null, pf: null });
  assert.match(pv, /id="pvMfSw"/);
  assert.doesNotMatch(pv, /id="pvMfSw" checked/);
  assert.match(pv, /Pad &lt;b&gt;/);
  assert.match(pv, /privacy-livecam\.js\?v=6/);
  // every t('...') key in the new / changed views exists
  for (const f of [["views", "partials", "pad-micfollow.ejs"], ["views", "privacy-settings.ejs"]]) {
    for (const m of read(...f).matchAll(/\bt\('([a-z0-9_.]+)'/g)) if (!m[1].endsWith(".")) assert.ok(m[1] in EN, f.join("/") + ": " + m[1]);
  }
  for (const k of ["pad.settings.mf.layout.auto", "pad.settings.mf.layout.pip", "pad.settings.mf.default.tab", "pad.settings.mf.why_off.pepe_old", "mf.notice.title",
                   "siteperm.k.micfollow.kill", "siteperm.k.micfollow.admin"]) assert.ok(k in EN, k);
  // every js.stage.mf.* / js.padset.mf.* / js.privacy.mf.* default in the scripts equals en.json (the i18n suite checks all files too)
  for (const f of ["stage-mic.js", "stage-room.js", "pad-micfollow.js", "privacy-livecam.js"]) {
    for (const m of read("public", "js", f).matchAll(/\b_{1,2}t\(\s*'(js\.(?:stage|padset|privacy)\.mf\.[a-z0-9_.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g)) {
      assert.equal(EN[m[1]], m[2].replace(/\\(['"\\])/g, "$1"), f + ": " + m[1]);
    }
  }
});

// ── review fixes (r3) ──

test("webrtc.css: the newest speaker's ring is drawn ABOVE the tile's video / still / card; narrow grid4 cards fit; ⋯ Manage gets a bar above the tiles", () => {
  const css = read("public", "css", "webrtc.css");
  const ring = /\.player \.mf-tile\.newest::after \{([^}]*)\}/.exec(css);
  assert.ok(ring, "a pseudo-element on top of the tile's children");
  assert.match(ring[1], /box-shadow: inset 0 0 0 3px var\(--ds-green-2/);
  assert.match(ring[1], /pointer-events: none/);
  const z = Number((/z-index: (\d+)/.exec(ring[1]) || [])[1]);
  const zOf = (sel) => Number((new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{[^}]*z-index: (\\d+)").exec(css) || [])[1]);
  assert.ok(z > zOf(".player .rtc-video") && z > zOf(".player .mf-tile .mf-card") && z > zOf(".player .mf-tile .mf-label"), "above video, card and label");
  assert.doesNotMatch((/\.player \.mf-tile\.newest \{([^}]*)\}/.exec(css) || [])[1] || "", /box-shadow/, "not under the children any more");
  assert.match(css, /\.narrow\[data-layout=grid4\] \.mf-tile \.mf-av \{ width: 28px; height: 28px/);
  // review r4: the bar sits above the tiles in EVERY layout (owners / staff; viewers' ⚑ on narrow grids) - .barred moves them
  assert.match(css, /\.mf-stage\.barred \.mf-bar \{ display: flex; \}/);
  assert.match(css, /\.mf-stage\.barred \.mf-grid, \.player \.mf-stage\.barred \.mf-neutral \{ top: 48px; \}/);
  assert.doesNotMatch(css, /\.mf-mbtn \{[^}]*position: absolute/, "⋯ is never drawn over a tile");
});

test("stage-room.js: setMic redraws nothing when nothing moved (null -> null, the same program) - the owner's tab buttons stay put", () => {
  const js = read("public", "js", "stage-room.js");
  const dom = fakeDom();
  const ctx = { document: { readyState: "complete", createElement: dom.mk }, console, setInterval: () => 0, clearInterval() {}, setTimeout, location: { hostname: "x" },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }), confirm: () => false, alert() {} };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  ctx.PATVStage = { player: () => ({ stop() {}, setSrc() {}, start() {}, running: () => false }) };
  let updates = 0;
  ctx.PATVStageMic = { render: () => ({ update() { updates++; }, stop() {}, selection: () => ({ stream: "mic", embed: true, capture: false, nsfw: false }) }) };
  vm.runInNewContext(js, ctx);
  const tabs = dom.mk("div");
  let html = "", renders = 0, shows = 0;
  Object.defineProperty(tabs, "innerHTML", { set(v) { html = v; renders++; }, get() { return html; } });
  const sw = ctx.PATVStage.switcher({ tabs, wrap: dom.mk("div"), api: "/api/stage?room=pad", slots: [{ id: "s1", display: "S", featured: true, feature_by: "owner", hls: "x" }],
    pepeOn: true, pepeHere: true, slug: "pad", watch: false, onShow: () => { shows++; } });
  const base = renders;
  for (let i = 0; i < 20; i++) sw.setMic(null);                  // a pad with mic follows off: every long-poll answer
  assert.equal(renders, base, "null -> null: the tab bar is never rebuilt");
  const P = { v: 3, active: true, count: 2, default: "first", layout: "split", src: [{ id: "a", video: "live" }, { id: "b", video: "card" }] };
  sw.setMic(P);
  const once = renders;
  assert.ok(once > base, "the mic tab appears");
  for (let i = 0; i < 20; i++) sw.setMic(JSON.parse(JSON.stringify(P)));
  assert.equal(renders, once, "the same program again: nothing redrawn");
  sw.setMic(Object.assign({}, P, { v: 4, src: [{ id: "a", video: "live" }, { id: "b", video: "still" }] }));
  assert.equal(renders, once, "a picture moved but the tab didn't: the tab bar stays");
  sw.setMic(Object.assign({}, P, { v: 5, count: 3, src: P.src.concat([{ id: "c", video: "card" }]) }));
  assert.equal(renders, once + 1, "the count moved: one redraw");
  assert.ok(shows >= 1);
});

test("stage-mic.js: tiles are labelled groups; stills stop polling in a hidden tab; ❄ freezes for the server's freeze_min", async () => {
  const js = read("public", "js", "stage-mic.js");
  const dom = fakeDom();
  const live = new Set();
  let n = 0, vis = null;
  const posts = [];
  const ctx = { document: { createElement: dom.mk, hidden: false, addEventListener(k, fn) { if (k === "visibilitychange") vis = fn; }, removeEventListener() {} },
    console, clearTimeout,
    setTimeout: (fn, ms) => (ms >= 30000 ? (fn(), 0) : setTimeout(fn, ms)),            // the 30 s hidden-tab wait runs at once
    setInterval: () => { const id = ++n; live.add(id); return id; }, clearInterval: (id) => { live.delete(id); },
    fetch: (u, o) => { posts.push([u, o && o.body ? JSON.parse(o.body) : null]); return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: "pending", frozen_until: 0 }) }); },
    PATVRtc: { watch: () => new Promise(() => {}) }, RTCPeerConnection: function () {}, Date };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const host = dom.mk("div");
  const s = (id, pos, video) => ({ kind: "cam", id, name: id.toUpperCase(), pos, newest: pos === 0, video, why: null, watch: "ok" });
  const ctl = ctx.PATVStageMic.render(host, { v: 1, layout: "split", count: 2, src: [s("a", 0, "still"), s("b", 1, "card")], manage: { excluded_n: 0, freeze_min: 15 }, still_s: 20 },
    { slug: "pad" });
  const stage = host.children[0];
  const tileA = stage.children[0].children.find((c) => c.getAttribute && c.getAttribute("data-id") === "a");
  assert.equal(tileA.getAttribute("role"), "group", "a role, so screen readers read its aria-label");
  assert.equal(tileA.getAttribute("aria-label"), "A");
  assert.equal(live.size, 1, "the still polls");
  ctx.document.hidden = true; vis();
  assert.equal(live.size, 0, "a hidden tab: the still stops polling");
  ctx.document.hidden = false; vis();
  assert.equal(live.size, 1, "back: it polls again");
  assert.ok(stage.classList.contains("managed"));
  const bar = stage.children.find((c) => c.className === "mf-bar");
  const mBtn = bar.children.find((c) => c.className === "mf-mbtn"), panel = stage.children.find((c) => c.className === "mf-panel");
  mBtn.listeners.click[0]();
  const freeze = panel.children[0];
  assert.match(freeze.textContent, /nobody new for 15 min/);
  freeze.listeners.click[0]();
  assert.ok(posts.some((p) => /\/micfollow\/freeze$/.test(p[0]) && p[1].minutes === 15));
  ctl.stop();
});

test("pad-micfollow.js: after a save the status line under the form is repainted (the server words it)", async () => {
  const js = read("public", "js", "pad-micfollow.js");
  const dom = fakeDom();
  const els = {};
  for (const id of ["mfForm", "mfMsg", "mfExRows", "mfExForm", "mfExMsg", "mfStatus"]) els[id] = dom.mk(id === "mfForm" || id === "mfExForm" ? "form" : "p");
  els.mfStatus.textContent = "Ready - switch it on above.";
  els.mfForm.setAttribute("data-url", "/api/rooms/pad/micfollow/settings");
  els.mfExRows.setAttribute("data-url", "/api/rooms/pad/micfollow/exclude");
  els.mfExRows.setAttribute("data-list", "[]");
  els.mfForm.elements = { on: { checked: true }, layout: { value: "auto" }, default_view: { value: "first" }, max_people: { value: "4" }, max_live: { value: "4" } };
  const ctx = { document: { getElementById: (id) => els[id] || null, createElement: dom.mk }, console, setTimeout, Date,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, settings: {}, state: { excluded: [], status_text: "Running: 2 on the mic stage. Can&#39;t &amp; won&#39;t" } }) }) };
  ctx.window = ctx;
  vm.runInNewContext(js, ctx);
  els.mfForm.listeners.submit[0]({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(els.mfStatus.textContent, "Running: 2 on the mic stage. Can't & won't", "repainted, entities decoded");
  assert.equal(els.mfMsg.textContent, "Saved.");
});

// ── final-verification fixes (r4): the before-prod deltas on the page ──

/** stage-mic.js in a sandbox; fetch answers per URL. -> {ctx, stage, posts, ctl, host} */
function micSandbox(program, answer) {
  const js = read("public", "js", "stage-mic.js");
  const dom = fakeDom();
  const posts = [];
  const ctx = { document: { createElement: dom.mk, hidden: false, addEventListener() {}, removeEventListener() {} }, console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    fetch: (u, o) => { const body = o && o.body ? JSON.parse(o.body) : null; posts.push([u, body]); return Promise.resolve({ json: () => Promise.resolve(answer ? answer(u, body) : { ok: true }) }); },
    PATVRtc: { watch: () => new Promise(() => {}) }, RTCPeerConnection: function () {}, Date };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const host = dom.mk("div");
  const ctl = ctx.PATVStageMic.render(host, program, { slug: "pad" });
  return { ctx, ctl, host, posts, stage: host.children[0] };
}
const tileS = (id, pos, video, extra) => Object.assign({ kind: "cam", id, name: id.toUpperCase(), pos, newest: false, video, why: video === "card" ? "off_cam" : null, watch: "ok" }, extra || {});
const findCls = (n, cls) => { if (!n) return null; if ((" " + n.className + " ").includes(" " + cls + " ")) return n; for (const c of n.children || []) { const f = findCls(c, cls); if (f) return f; } return null; };

test("r4 stage-mic.js: owners get a bar ABOVE the tiles with ⋯ and 🧹 Clear the stage (posts /clear); viewers get ⚑ per tile, no bar", async () => {
  const own = micSandbox({ v: 1, layout: "split", count: 2, src: [tileS("a", 0, "card"), tileS("b", 1, "card")], manage: { excluded_n: 0, freeze_min: 30 }, still_s: 20 },
    (u) => (/\/clear$/.test(u) ? { ok: true, frozen_until: Date.now() + 1800e3 } : { ok: true }));
  const bar = own.stage.children.find((c) => c.className === "mf-bar");
  assert.ok(bar, "a bar");
  assert.ok(own.stage.classList.contains("barred"), "the tiles move below the bar (it never covers one)");
  const clear = bar.children.find((c) => /mf-clear/.test(c.className));
  assert.equal(clear.hidden, false);
  assert.equal(clear.textContent, "🧹 Clear the stage");
  assert.ok(clear.getAttribute("aria-label"));
  clear.listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(own.posts.some((p) => /\/micfollow\/clear$/.test(p[0])), "POST /clear");
  assert.match(findCls(bar, "mf-bmsg").textContent, /Cleared - nobody new for 30 min/);
  own.ctl.stop();
  // a viewer (no manage): no bar on a wide layout, and no ✕ - a ⚑ per tile instead
  const v = micSandbox({ v: 1, layout: "split", count: 2, src: [tileS("a", 0, "live"), tileS("b", 1, "card")], manage: null, report: true, still_s: 20 });
  assert.ok(!v.stage.classList.contains("barred"));
  const ta = v.stage.children[0].children.find((c) => c.getAttribute && c.getAttribute("data-id") === "a");
  const x = ta.children.find((c) => c.className === "mf-x"), rp = ta.children.find((c) => /mf-rp/.test(c.className));
  assert.equal(x.hidden, true, "✕ is for owners");
  assert.equal(rp.hidden, false, "⚑ for viewers");
  assert.equal(rp.getAttribute("aria-label"), "Report A");
  v.ctl.stop();
});

test("r4 stage-mic.js: ⚑ report - a reason, POST /report, the tile hides for this viewer at once; narrow grids put ⚑ in the bar", async () => {
  const v = micSandbox({ v: 1, layout: "split", count: 2, src: [tileS("a", 0, "live"), tileS("b", 1, "card")], manage: null, report: true, still_s: 20 },
    (u) => (/\/report$/.test(u) ? { ok: true, hidden: true } : { ok: true, whep: "https://x/whep?pt=1" }));
  const ta = v.stage.children[0].children.find((c) => c.getAttribute && c.getAttribute("data-id") === "a");
  const rp = ta.children.find((c) => /mf-rp/.test(c.className));
  await new Promise((r) => setTimeout(r, 10));
  rp.listeners.click[0]();
  const rpanel = v.stage.children.find((c) => /mf-rpanel/.test(c.className));
  assert.equal(rpanel.hidden, false);
  assert.equal(rpanel.getAttribute("role"), "dialog");
  assert.match(rpanel.textContent, /Report A\? Why:/);
  const minor = rpanel.children.find((c) => c.textContent === "May be under 18");
  assert.ok(minor, "the under-18 reason (DF-10)");
  minor.listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  const sent = v.posts.find((p) => /\/micfollow\/report$/.test(p[0]));
  assert.deepEqual(sent[1], { login: "a", reason: "minor" });
  assert.equal(rpanel.hidden, true);
  assert.match(ta.textContent, /hidden for you \(you reported it\)/, "hidden at once, before the next program");
  assert.ok(v.posts.some((p) => /\/micfollow\/watch$/.test(p[0]) && p[1].login === "a" && p[1].stop === true), "its live session closes");
  assert.equal(rp.hidden, true, "no second ⚑ on a hidden tile");
  // the program says hidden too (viewFor's watch: "hidden")
  v.ctl.update({ v: 2, layout: "split", count: 2, src: [tileS("a", 0, "live", { watch: "hidden" }), tileS("b", 1, "card")], manage: null, report: true, still_s: 20 });
  assert.match(ta.textContent, /hidden for you/);
  v.ctl.stop();
  // narrow grid9: the tiles are too small for their own ⚑ - a ⚑ Report in the bar lists who
  const progN = () => ({ v: 1, layout: "grid9", count: 5, src: ["a", "b", "c", "d", "e"].map((id, i) => tileS(id, i, "card")), manage: null, report: true, still_s: 20 });
  const n = micSandbox(progN());
  n.host.clientWidth = 360;
  n.ctl.update(Object.assign(progN(), { v: 2 }));
  assert.ok(n.stage.classList.contains("narrow") && n.stage.classList.contains("barred"));
  const bar = n.stage.children.find((c) => c.className === "mf-bar");
  const rb = bar.children.find((c) => /mf-rbtn/.test(c.className));
  assert.equal(rb.hidden, false);
  rb.listeners.click[0]();
  const rpanel2 = n.stage.children.find((c) => /mf-rpanel/.test(c.className));
  assert.equal(rpanel2.children.filter((c) => /^⚑ /.test(c.textContent)).length, 5);
  n.ctl.stop();
});

test("r4 stage-mic.js: the neutral card - 'Someone is speaking' / Pepe's card, no name, no face; signed out never sees it", () => {
  const v = micSandbox({ v: 1, layout: "single", count: 0, src: [], manage: null, report: true, speaking: "someone", still_s: 20 });
  const card = v.stage.children.find((c) => c.className === "mf-neutral");
  assert.equal(card.hidden, false);
  assert.equal(card.textContent, "🎙Someone is speaking", "an icon + the words, nothing else");
  assert.equal(v.stage.getAttribute("aria-label"), "Someone is speaking");
  assert.equal(card.getAttribute("role"), "status");
  v.ctl.update({ v: 2, layout: "single", count: 0, src: [], manage: null, report: true, speaking: "pepe", still_s: 20 });
  assert.equal(card.textContent, "🐸Pepe is on the mic");
  assert.equal(v.ctl.selection().label, "🎙 On the mic");
  v.ctl.update({ v: 3, layout: "single", count: 1, src: [tileS("a", 0, "live")], manage: null, report: true, speaking: null, still_s: 20 });
  assert.equal(card.hidden, true, "a person on the stage: no neutral card");
  v.ctl.update({ v: 4, layout: "single", count: 0, src: [], signin: true, speaking: "someone", still_s: 20 });
  assert.equal(card.hidden, true, "signed out: the sign-in note only");
  v.ctl.stop();
});

test("r4 stage-room.js: a neutral-card program keeps the 🎙 tab but is never the default view (DF-15)", () => {
  const js = read("public", "js", "stage-room.js");
  const dom = fakeDom();
  const ctx = { document: { readyState: "complete", createElement: dom.mk }, console, setInterval: () => 0, clearInterval() {}, setTimeout, location: { hostname: "x" },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }), confirm: () => false, alert() {} };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  ctx.PATVStage = { player: () => ({ stop() {}, setSrc() {}, start() {}, running: () => false }) };
  ctx.PATVStageMic = { render: () => ({ update() {}, stop() {}, selection: () => ({ stream: "mic", embed: true, capture: false, nsfw: false }) }) };
  vm.runInNewContext(js, ctx);
  const tabs = dom.mk("div");
  let html = "";
  Object.defineProperty(tabs, "innerHTML", { set(v) { html = v; }, get() { return html; } });
  const sw = ctx.PATVStage.switcher({ tabs, wrap: dom.mk("div"), api: "/api/stage?room=pad", slots: [], pepeOn: true, pepeHere: true, slug: "pad", watch: false });
  sw.setMic({ v: 1, active: true, count: 1, default: "first", layout: "single", src: [{ id: "a", video: "live" }] });
  assert.equal(sw.view(), "mic", "a person with a picture: the mic stage first");
  sw.setMic({ v: 2, active: false, count: 0, default: "first", layout: "single", src: [], speaking: "someone" });
  assert.match(html, /data-v="mic"/, "the tab stays");
  assert.match(html, /🎙 On the mic</, "no count on it");
  assert.equal(sw.view(), "pepe", "a stage of only a neutral card is never the default view");
  sw.setMic({ v: 3, active: false, count: 0, default: "first", layout: "single", src: [], speaking: null });
  assert.doesNotMatch(html, /data-v="mic"/, "idle: no tab");
});

test("r4 the privacy card counts mic-stage viewers, never names them; the pad settings card says who's responsible", async () => {
  const js = read("public", "js", "privacy-camviewers.js");
  const dom = fakeDom();
  const els = {};
  for (const id of ["pvCv", "pvCvLive", "pvCvRecent", "pvCvBlocks", "pvCvForm", "pvCvName", "pvCvSt"]) els[id] = dom.mk(id === "pvCvForm" ? "form" : "ul");
  const ctx = { document: { getElementById: (id) => els[id] || null, createElement: dom.mk, hidden: false }, console, setTimeout, setInterval: () => 0, clearInterval() {}, Date,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, linked: true, live: [{ username: "v1", display: "V One", since: Date.now() }], recent: [], blocks: [], mic_stage_n: 3 }) }) };
  ctx.window = ctx;
  vm.runInNewContext(js, ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.match(els.pvCvLive.textContent, /V One/);
  assert.match(els.pvCvLive.textContent, /On a pad's 🎙 mic stage: 3 watching \(not named\)/);
  for (const m of js.matchAll(/\b_t\(\s*'(js\.cv\.[a-z0-9_.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g)) assert.equal(EN[m[1]], m[2].replace(/\\(['"\\])/g, "$1"), m[1]);
  const ejs = require("ejs");
  const mf = { settings: { on: false, layout: "auto", default_view: "first", max_people: 4, max_live: 4 }, on: false, running: false, why_off: null, can_run: false,
               run_why: "adult", tiles: 0, unproven_n: 0, excluded: [], max_live_cap: 4, max_people_cap: 9, site_on: true,
               layouts: ["auto", "single", "split", "grid", "pip"], default_views: ["first", "after_streams", "tab"], room_name: "Room" };
  const html = await ejs.renderFile(path.join(repo, "views", "partials", "pad-micfollow.ejs"), { slug: "pad", room: { title: "Pad" }, mf });
  assert.match(html, /You(&#39;|')re responsible for what your Stage shows; Clear the stage is on the bar\./);
  assert.match(html, /marked 18\+/, "an 18+ pad says why it can't run");
  assert.match(html, /name="max_people" min="1" max="9"/, "the site's default cap leaves the 3 x 3 grid reachable");
});

// ── mfix (owner 2026-10-25) ──
function micBox(fetchImpl) {
  const js = read("public", "js", "stage-mic.js");
  const dom = fakeDom();
  const posts = [];
  const ctx = { document: { createElement: dom.mk, hidden: false, addEventListener() {}, removeEventListener() {} }, console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {},
    fetch: (u, o) => {
      posts.push([u, o && o.body ? JSON.parse(o.body) : null, o && o.method]);
      return Promise.resolve({ json: () => Promise.resolve(fetchImpl ? fetchImpl(u, o) : { ok: true, whep: "https://x/whep?pt=1" }) });
    },
    PATVRtc: { watch: () => new Promise(() => {}) }, RTCPeerConnection: function () {}, Date, confirm: () => true };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const host = dom.mk("div");
  return { ctx, dom, posts, host };
}
const mfS = (id, pos, video, extra) => Object.assign({ kind: "cam", id, name: id.toUpperCase(), pos, newest: false, video, why: video === "card" ? "full" : null, watch: "ok" }, extra || {});
const allText = (n) => n.textContent;
const findBy = (root, cls) => { const out = []; const walk = (n) => { for (const c of n.children || []) { if ((" " + c.className + " ").includes(" " + cls + " ")) out.push(c); walk(c); } }; walk(root); return out; };

test("mfix stage-mic.js: 📌 pinned tiles first with their tag, a pin's ticket through its pin, owners unpin with 📌✕ and pin with 📌; recent tiles carry no ring", async () => {
  const { ctx, posts, host } = micBox();
  const prog = { v: 1, layout: "split", count: 2, still_s: 20, manage: { excluded_n: 0, pins_room: 2 },
                 src: [mfS("p", 0, "live", { pin: true }), mfS("a", 1, "live", { recent: true })] };
  const ctl = ctx.PATVStageMic.render(host, prog, { slug: "pad" });
  const stage = host.children[0];
  const grid = stage.children[0];
  const ids = grid.children.filter((c) => /mf-tile/.test(c.className)).map((c) => c.getAttribute("data-id"));
  assert.deepEqual(ids, ["p", "a"], "the pin takes the first place");
  const p = grid.children.find((c) => c.getAttribute && c.getAttribute("data-id") === "p");
  assert.ok(p.classList.contains("pinned"));
  assert.equal(findBy(p, "mf-pin")[0].hidden, false, "📌 on its label");
  const a = grid.children.find((c) => c.getAttribute && c.getAttribute("data-id") === "a");
  assert.ok(a.classList.contains("recent") && !a.classList.contains("newest"), "a recent speaker: no ring");
  await new Promise((r) => setTimeout(r, 10));
  const watch = posts.filter((x) => /\/micfollow\/watch$/.test(x[0])).map((x) => x[1]);
  assert.ok(watch.some((w) => w.login === "p" && w.pin === true), "the pinned cam's ticket comes through its pin");
  assert.ok(watch.some((w) => w.login === "a" && w.pin === undefined));
  // owners: ✕ on a pin unpins it; 📌 on a mic tile pins that person
  const px = findBy(p, "mf-x").find((b) => !/mf-rp|mf-pn/.test(b.className));
  assert.equal(px.textContent, "📌✕");
  px.listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(posts.some((x) => /\/micfollow\/pin$/.test(x[0]) && x[1].login === "p" && x[1].remove === true));
  const apn = findBy(a, "mf-pn")[0];
  assert.equal(apn.hidden, false, "room for another pin: 📌 on the mic tile");
  apn.listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(posts.some((x) => /\/micfollow\/pin$/.test(x[0]) && x[1].login === "a" && !x[1].remove));
  // no room left: no 📌; viewers (no manage) never see either
  ctl.update(Object.assign({}, prog, { v: 2, manage: { excluded_n: 0, pins_room: 1 } }));
  assert.equal(findBy(a, "mf-pn")[0].hidden, true);
  ctl.update(Object.assign({}, prog, { v: 3, manage: null, report: true }));
  assert.equal(findBy(p, "mf-pn")[0].hidden, true);
  ctl.stop();
});

test("mfix stage-mic.js: tiles kept up while someone nobody can show talks are DIMMED with a strip (no ring); Pepe's own strip; the idle card; the new card reasons", () => {
  const { ctx, host } = micBox();
  const ctl = ctx.PATVStageMic.render(host, { v: 1, layout: "single", count: 1, still_s: 20, speaking: "someone", src: [mfS("a", 0, "card", { why: "retry" })] }, { slug: "pad" });
  const stage = host.children[0];
  const strip = stage.children.find((c) => c.className === "mf-strip");
  const neutral = stage.children.find((c) => c.className === "mf-neutral");
  assert.ok(stage.classList.contains("mf-dim"), "dimmed");
  assert.equal(strip.hidden, false);
  assert.equal(strip.textContent, "Someone else is speaking");
  assert.equal(neutral.hidden, true, "the tiles stay - no neutral card over them");
  assert.match(allText(stage.children[0]), /trying their cam again/, "a soft failure says it'll try again");
  ctl.update({ v: 2, layout: "single", count: 1, still_s: 20, speaking: "pepe", src: [mfS("a", 0, "card", { why: "cold_off" })] });
  assert.equal(strip.textContent, "🐸 Pepe is on the mic");
  assert.match(allText(stage.children[0]), /only cams already live/);
  for (const [why, re] of [["rate", /opened just now/], ["pool", /Pepe's cams are all busy/], ["pad_cap", /live cams are all in use/], ["full", /full right now/]]) {
    ctl.update({ v: 3 + why.length, layout: "single", count: 1, still_s: 20, src: [mfS("a", 0, "card", { why })] });
    assert.match(allText(stage.children[0]), re, why);
  }
  assert.ok(!stage.classList.contains("mf-dim"), "a proven speaker: nothing dimmed");
  assert.equal(strip.hidden, true);
  // the page's grace: an idle program says nobody is on the mic
  ctl.update({ v: 9, layout: "single", count: 0, still_s: 20, src: [], idle: true });
  assert.equal(neutral.hidden, false);
  assert.match(neutral.textContent, /Nobody is on the mic right now/);
  assert.equal(stage.getAttribute("aria-label"), "Nobody is on the mic right now");
  ctl.stop();
});

test("mfix stage-mic.js: the viewer's OWN cam has 🙈 Take me off (POST /api/stage/leave with the pad); ⋯ Manage → 📌 Pin a cam lists who's on cam", async () => {
  const { ctx, posts, host } = micBox((u) => (/\/pins$/.test(u) ? { ok: true, room: 2, pins: [{ login: "p" }], cams: [
    { login: "p", display: "P", pinned: true }, { login: "q", display: "Q" }, { login: "r", display: "R", blocked: "unavailable" }, { login: "s", display: "S", ask: true },
    { login: "w", display: "W", blocked: "limited" }] } : { ok: true }));
  const ctl = ctx.PATVStageMic.render(host, { v: 1, layout: "split", count: 1, still_s: 20, src: [mfS("me", 0, "live", { mine: true })], report: true }, { slug: "my-pad" });
  const stage = host.children[0];
  const tileMe = stage.children[0].children.find((c) => c.getAttribute && c.getAttribute("data-id") === "me");
  const off = findBy(tileMe, "mf-off")[0];
  assert.equal(off.hidden, false);
  off.listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  const lv = posts.find((x) => x[0] === "/api/stage/leave");
  assert.ok(lv, "posted the take-off");
  assert.deepEqual(lv[1], { room: "my-pad" });
  // owners: ⋯ Manage -> 📌 Pin a cam…
  ctl.update({ v: 2, layout: "split", count: 1, still_s: 20, src: [mfS("x", 0, "live")], manage: { excluded_n: 0, pins_room: 2 } });
  const bar = stage.children.find((c) => c.className === "mf-bar");
  bar.children.find((c) => c.className === "mf-mbtn").listeners.click[0]();
  const panel = stage.children.find((c) => c.className === "mf-panel");
  const pinBtn = panel.children.find((c) => /Pin a cam/.test(c.textContent || ""));
  assert.ok(pinBtn && !pinBtn.hidden, "📌 Pin a cam… in ⋯ Manage");
  pinBtn.listeners.click[0]();
  await new Promise((r) => setTimeout(r, 20));
  const list = findBy(panel, "mf-pins")[0];
  const txt = list.textContent;
  for (const re of [/P.*pinned.*Unpin/, /Q.*📌 Pin/, /R.*isn't available/, /S.*asks them first.*Ask to pin/, /W.*cam only for some viewers/]) assert.match(txt, re);
  assert.ok(posts.some((x) => /\/micfollow\/pins$/.test(x[0]) && !x[2]), "GET the list");
  ctl.stop();
});

test("mfix stage-room.js: a viewer who picked the 🎙 tab gets it back by itself when the mic stage returns after the grace (until they pick another tab)", () => {
  const x = switcher({ slots: [] });
  x.sw.setMic(MIC({ default: "tab" }));
  assert.equal(x.sw.view(), "pepe", "only a tab by default");
  // the viewer clicks 🎙 (the tab bar's own click handler)
  const btn = { hasAttribute: (k) => k === "data-v", getAttribute: () => "mic" };
  x.click({ target: { closest: () => btn } });
  assert.equal(x.sw.view(), "mic");
  x.sw.setMic(MIC({ default: "tab", count: 0, src: [], active: false }));
  assert.equal(x.sw.view(), "mic", "the grace");
  x.grace();
  assert.equal(x.sw.view(), "pepe", "after the grace: the default");
  x.sw.setMic(MIC({ default: "tab" }));
  assert.equal(x.sw.view(), "mic", "it came back: the viewer's pick again");
  // they pick Pepe's tab: no more auto-return
  const pb = { hasAttribute: (k) => k === "data-v", getAttribute: () => "pepe" };
  x.click({ target: { closest: () => pb } });
  x.sw.setMic(MIC({ default: "tab", count: 0, src: [], active: false }));
  x.sw.setMic(MIC({ default: "tab", count: 3, src: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
  assert.equal(x.sw.view(), "pepe");
});

test("mfix: the pad settings card has the recent-speakers choice; every new string is in locales/en.json", async () => {
  const ejs = require("ejs");
  const mf = { settings: { on: true, layout: "split", default_view: "first", max_people: 4, max_live: 3, keep_recent: 5 }, on: true, running: true, why_off: null, can_run: true,
               run_why: null, tiles: 1, unproven_n: 0, excluded: [], max_live_cap: 6, site_on: true, keep_recent: [0, 1, 2, 5],
               layouts: ["auto", "single", "split", "grid", "pip"], default_views: ["first", "after_streams", "tab"], room_name: "Room" };
  const html = await ejs.renderFile(path.join(repo, "views", "partials", "pad-micfollow.ejs"), { slug: "pad", room: { title: "Pad" }, mf });
  assert.match(html, /<select name="keep_recent">/);
  assert.match(html, /<option value="5" selected>5 min<\/option>/);
  assert.match(html, /<option value="0">No - only whoever holds the mic<\/option>/);
  assert.match(html, /name="max_live" min="1" max="6"/, "up to 6 live cams on a pad");
  assert.match(read("public", "js", "pad-micfollow.js"), /body\.keep_recent = Number\(f\.keep_recent\.value\)/);
  for (const k of ["pad.settings.mf.keep_recent", "pad.settings.mf.keep_recent.off", "pad.settings.mf.keep_recent.min", "js.stage.mf.pin_open", "js.stage.mf.someone_strip",
                   "js.stage.mf.idle", "js.stage.mf.retry", "js.stage.mf.cold_off"]) assert.ok(k in EN, k);
});

// ── mfix review (2026-10-25): a relay Pepe re-opens (an exact re-open for a pad's mic stage, a publisher restart) never kills
// the viewers' pictures - every live-cam player watches again while the site still says the cam is connecting / live ──
const tick = () => new Promise((r) => setTimeout(r, 10));
function liveCamBox(beatFn) {
  const js = read("public", "js", "pad-livecam.js");
  const dom = fakeDom();
  const posts = [], sessions = [];
  const ctx = { document: { createElement: dom.mk }, console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    fetch: (u, o) => {
      const body = o && o.body ? JSON.parse(o.body) : null;
      posts.push([u, body]);
      const d = /\/beat$/.test(u) ? beatFn() : /\/stop$/.test(u) ? { ok: true } : { ok: true, whep: "https://x/whep?pt=" + posts.length, slots: { used: 1, max: 4 } };
      return Promise.resolve({ json: () => Promise.resolve(d) });
    },
    PATVRtc: { watch: (url) => { const ss = { url, closed: false, onfail: null, close() { ss.closed = true; } }; sessions.push(ss); return Promise.resolve(ss); } },
    RTCPeerConnection: function () {}, Date, confirm: () => true };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const box = dom.mk("div");
  ctx.PATVLiveCam.row(box, "pad", { login: "ann", display: "Ann" }, { slots: { used: 0, max: 4 } }, {});
  const live = dom.all.find((e) => e.tagName === "BUTTON" && e.className === "live");
  return { ctx, dom, posts, sessions, box, live };
}

test("mfix review pad-livecam.js: a ▶ Live picture whose connection drops is watched again (a fresh ticket, the same slot) while the site says connecting / live - a few times, then 'the live cam stopped'", async () => {
  let beat = { ok: true, state: "connecting" };
  const { posts, sessions, box, live } = liveCamBox(() => beat);
  live.listeners.click[0]();
  await tick();
  assert.equal(sessions.length, 1, "playing");
  posts.length = 0;
  sessions[0].onfail();                                     // Pepe re-opened the relay: MediaMTX closed the reader
  await tick();
  assert.equal(sessions.length, 2, "watched again");
  assert.ok(sessions[0].closed);
  assert.deepEqual(posts.map((p) => p[0].replace(/^.*\/livecam/, "")), ["/beat", ""], "asks the site first, then a fresh ticket");
  assert.notEqual(sessions[1].url, sessions[0].url, "a new ticket");
  assert.ok(!posts.some((p) => /\/stop$/.test(p[0])), "the slot is kept (no /stop)");
  assert.doesNotMatch(box.textContent, /stopped/);
  // the site says it ended: no more re-watching - the reason
  beat = { ok: true, state: "ended", why: "gone" };
  sessions[1].onfail();
  await tick();
  assert.equal(sessions.length, 2, "not watched again");
  assert.match(box.textContent, /The live cam stopped/);
});

test("mfix review pad-livecam.js: re-watching is bounded (REWATCH_MAX in REWATCH_WIN_MS)", async () => {
  const { sessions, box, live } = liveCamBox(() => ({ ok: true, state: "live" }));
  live.listeners.click[0]();
  await tick();
  for (let i = 0; i < 4; i++) { sessions[sessions.length - 1].onfail(); await tick(); }
  assert.equal(sessions.length, 5, "four drops: four re-watches");
  sessions[sessions.length - 1].onfail();
  await tick();
  assert.equal(sessions.length, 5, "the fifth in a row: given up");
  assert.match(box.textContent, /The live cam stopped/);
});

test("mfix review stage-mic.js: a live mic tile whose connection drops re-watches at once ('reconnecting…', not 'couldn't open'), a few times", async () => {
  const sessions = [];
  const { ctx, posts, host } = micBox();
  ctx.PATVRtc.watch = (url) => { const ss = { url, onfail: null, close() { ss.closed = true; } }; sessions.push(ss); return Promise.resolve(ss); };
  const prog = { v: 1, layout: "single", count: 1, still_s: 20, manage: null, src: [mfS("a", 0, "live")] };
  const ctl = ctx.PATVStageMic.render(host, prog, { slug: "pad" });
  await tick();
  assert.equal(sessions.length, 1);
  const before = posts.filter((p) => /\/micfollow\/watch$/.test(p[0]) && !p[1].beat && !p[1].stop).length;
  ctx.PATVRtc.watch = (url) => { const ss = { url, onfail: null, close() { ss.closed = true; } }; sessions.push(ss); return new Promise(() => {}); };
  sessions[0].onfail();
  await tick();
  const tileA = findBy(host, "mf-tile")[0];
  assert.match(tileA.textContent, /reconnecting/, "says it's reconnecting");
  assert.doesNotMatch(tileA.textContent, /couldn't open/);
  assert.equal(posts.filter((p) => /\/micfollow\/watch$/.test(p[0]) && !p[1].beat && !p[1].stop).length, before + 1, "a fresh ticket at once");
  assert.ok(!posts.some((p) => /\/micfollow\/watch$/.test(p[0]) && p[1].stop), "its viewer slot isn't given up");
  ctl.stop();
});

test("mfix review: the strip (pad-camstrip.js) and a cam slot on the stage (stage-room.js) re-watch a dropped connection too - bounded, the slot kept", () => {
  const strip = read("public", "js", "pad-camstrip.js");
  assert.match(strip, /ss\.onfail = function \(\) \{ if \(my === t\.gen\) rewatch\(my\); \};/);
  assert.match(strip, /REWATCH_MAX = 4, REWATCH_WIN_MS = 3 \* 60 \* 1000/);
  assert.match(strip, /function rewatch\(my\) \{[^]*?post\(base \+ '\/beat'[^]*?post\(base, \{ login: t\.login \}\)[^]*?PATVRtc\.watch\(/);
  const room = read("public", "js", "stage-room.js");
  assert.match(room, /ss\.onfail = function \(\) \{ if \(g === my\.gen\) rewatch\(\); \};/);
  assert.match(room, /CAM_REWATCH_MAX = 4/);
  assert.match(room, /function rewatch\(\) \{[^]*?camPost\(s\.id, \{\}\)[^]*?PATVRtc\.watch\(d2\.whep/);
  for (const k of ["js.pad.live.reconnecting", "js.stage.mf.reconnecting", "js.stage.mf.tab_pins", "js.stage.mf.group_aria_pins"]) assert.ok(EN[k], k + " in en.json");
});

test("mfix review stage-room.js: the 🎙 tab counts the people ON THE MIC; pinned cams show as 📌 n and keep the stage up with nobody on the mic", () => {
  const js = read("public", "js", "stage-room.js");
  assert.match(js, /function micOn\(\) \{ return !!\(window\.PATVStageMic && mic && \(mic\.count > 0 \|\| pinsN\(\) > 0/);
  assert.match(js, /_t\('js\.stage\.mf\.tab_pins', '📌 \{n\}'/);
  assert.match(js, /p\.pins_n \|\| 0/, "a pin count change redraws the tab");
});

// ── mfix staging proof (2026-10-25): on staging an admin couldn't reach 📌 Pin a cam with nobody on the mic - the 🎙 tab (and so
// ⋯ Manage) only showed while someone was on it. The pad's owner / staff now get the tab on a RUNNING idle mic stage. ──
test("mfix staging proof stage-room.js: owners / staff get the 🎙 tab on an idle running mic stage (⋯ Manage → 📌 Pin a cam); viewers don't; never the default", () => {
  const IDLE = (extra) => Object.assign({ v: 1, on: true, active: false, count: 0, pins_n: 0, default: "first", layout: "split", src: [] }, extra || {});
  const M = { pins_room: 1, excluded_n: 0 };
  // a viewer: nothing to watch, no tab
  const v = switcher({ slots: [] });
  v.sw.setMic(IDLE());
  assert.equal(v.sw.view(), "pepe");
  assert.doesNotMatch(v.tabs(), /data-v="mic"/);
  // the owner: the tab, but Pepe's stream stays the default view
  const o = switcher({ slots: [] });
  o.sw.setMic(IDLE({ manage: M }));
  assert.equal(o.sw.view(), "pepe", "never the default view");
  assert.match(o.tabs(), /data-v="mic"/);
  // paused (why_off) or not running: no tab - a pin is refused there anyway
  const p = switcher({ slots: [] });
  p.sw.setMic(IDLE({ manage: M, why_off: "pepe_gone" }));
  assert.doesNotMatch(p.tabs(), /data-v="mic"/);
  const q = switcher({ slots: [] });
  q.sw.setMic(IDLE({ manage: M, on: false }));
  assert.doesNotMatch(q.tabs(), /data-v="mic"/);
  // the owner opens it: the idle program WITH ⋯ Manage, and it stays (no grace, no jump back to Pepe's stream)
  o.click({ target: { closest: () => ({ hasAttribute: (k) => k === "data-v", getAttribute: () => "mic" }) } });
  assert.equal(o.sw.view(), "mic");
  const last = o.rendered[o.rendered.length - 1];
  assert.equal(last.idle, true, "the idle card");
  assert.ok(last.manage && last.manage.pins_room === 1, "⋯ Manage (📌 Pin a cam) is there");
  o.sw.setMic(IDLE({ v: 2, manage: M }));
  o.grace();
  assert.equal(o.sw.view(), "mic", "the owner stays on the idle mic stage");
  // someone took the mic and let go: still the owner's view
  o.sw.setMic(MIC({ manage: M, on: true }));
  o.sw.setMic(IDLE({ v: 3, manage: M }));
  o.grace();
  assert.equal(o.sw.view(), "mic");
  // mic follows paused while they're on it: the usual grace, then the default
  o.sw.setMic(IDLE({ v: 4, manage: M, why_off: "pepe_gone" }));
  o.grace();
  assert.equal(o.sw.view(), "pepe");
});

// ── wave2 WP-4 (the incognito / mic-stage spec F.3): the dynamic layout on the page ──
/** stage-mic.js in a sandbox whose stage box is `width` px wide (375 = a phone: .narrow). -> {ctx, ctl, host, stage, grid} */
function dynSandbox(program, width = 640) {
  const js = read("public", "js", "stage-mic.js");
  const dom = fakeDom();
  const ctx = { document: { createElement: dom.mk, hidden: false, addEventListener() {}, removeEventListener() {} }, console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {}, fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }),
    PATVRtc: { watch: () => new Promise(() => {}) }, RTCPeerConnection: function () {}, Date };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const host = dom.mk("div");
  host.clientWidth = width; host.getBoundingClientRect = () => ({ width });
  const ctl = ctx.PATVStageMic.render(host, program, { slug: "pad" });
  const stage = host.children[0];
  return { ctx, ctl, host, stage, grid: stage.children[0] };
}
const dynProg = (ids, main, extra) => Object.assign({ v: 1, layout: ids.length <= 1 ? "single" : ids.length === 2 ? "split" : ids.length <= 4 ? "grid4" : "grid9",
  count: ids.length, src: ids.map((id, i) => tileS(id, i, "card", { ring: true })), dyn: { n: ids.length, t: "d" + ids.length, main }, still_s: 20 }, extra || {});
const tileEl = (grid, id) => grid.children.find((c) => c.getAttribute && c.getAttribute("data-id") === id);

test("wave2 F.3 stage-mic.js: the d1-d9 templates equal stagemiccap.rects - same cells, the main first, the others in place order (a capture is what you see)", () => {
  const { ctx } = dynSandbox({ v: 1, layout: "single", count: 0, src: [] });
  const DYN = ctx.PATVStageMic._dyn;
  const cap = require(path.join(repo, "stagemiccap"));
  for (let n = 1; n <= 9; n++) {
    for (const mainAt of [0, n - 1, Math.floor(n / 2)]) {
      const src = Array.from({ length: n }, (_, i) => ({ kind: "cam", id: "p" + i, pos: i, watch: "ok" }));
      const main = "p" + mainAt;
      const want = cap.rects({ src, dyn: { n, t: "d" + n, main } });
      const [cols, rows, cells] = DYN[n];
      assert.equal(cells.length, n, "d" + n + ": one cell per tile");
      // rects' own arithmetic (1280 x 720, 2 px gaps) over the PAGE's template
      const W = 1280, H = 720, gap = 2, unit = (W - gap * (cols.length - 1)) / cols.reduce((a, b) => a + b, 0), rh = (H - gap * (rows - 1)) / rows;
      const xs = [0]; for (const c of cols) xs.push(xs[xs.length - 1] + c * unit + gap);
      const order = [src.find((e) => e.id === main), ...src.filter((e) => e.id !== main)];
      const got = order.map((e, i) => {
        const [cx, cy, cw, ch] = cells[i], x = xs[cx], y = cy * (rh + gap), w = xs[cx + cw] - xs[cx] - gap, h = ch * rh + (ch - 1) * gap;
        return { id: e.id, x: Math.round(x), y: Math.round(y), w: Math.max(2, Math.min(W, Math.round(x + w)) - Math.round(x)), h: Math.max(2, Math.min(H, Math.round(y + h)) - Math.round(y)) };
      });
      assert.deepEqual(got, want, "d" + n + " main " + main);
    }
  }
});

test("wave2 F.3 stage-mic.js: dynamic - data-layout / data-dyn, the grid's template, each tile's grid-area (main in cell 0), no fillers, rings; the main changing moves NO node (no re-attach)", () => {
  const s = dynSandbox(dynProg(["a", "b", "c"], "b"));
  assert.equal(s.stage.getAttribute("data-layout"), "dynamic");
  assert.equal(s.stage.getAttribute("data-dyn"), "d3");
  assert.equal(s.grid.style.gridTemplateColumns, "2fr 1fr");
  assert.equal(s.grid.style.gridTemplateRows, "repeat(2, 1fr)");
  const A = tileEl(s.grid, "a"), B = tileEl(s.grid, "b"), C = tileEl(s.grid, "c");
  assert.equal(B.style.gridArea, "1 / 1 / span 2 / span 1", "the main spans the left column");
  assert.equal(A.style.gridArea, "1 / 2 / span 1 / span 1");
  assert.equal(C.style.gridArea, "2 / 2 / span 1 / span 1");
  assert.ok(B.classList.contains("main") && !A.classList.contains("main"));
  assert.ok([A, B, C].every((e) => e.classList.contains("ring")), "every holder's ring");
  assert.equal(s.grid.querySelectorAll("mf-empty").length, 0, "no fillers (grid4 would add one)");
  assert.deepEqual(s.grid.children.map((c) => c.getAttribute("data-id")), ["a", "b", "c"], "reading order = positions");
  // the active speaker changes: only grid-area moves - no appendChild / insertBefore / removeChild of an existing tile
  const moved = [];
  for (const k of ["appendChild", "insertBefore", "removeChild"]) { const f = s.grid[k]; s.grid[k] = function (c, ...r) { if ([A, B, C].includes(c)) moved.push(k); return f.call(this, c, ...r); }; }
  const vidA = A.children.find((c) => c.tagName === "VIDEO");
  s.ctl.update(dynProg(["a", "b", "c"], "c", { v: 2 }));
  assert.deepEqual(moved, [], "no node moved");
  assert.equal(A.children.find((c) => c.tagName === "VIDEO"), vidA, "the same video element");
  assert.equal(C.style.gridArea, "1 / 1 / span 2 / span 1");
  assert.equal(A.style.gridArea, "1 / 2 / span 1 / span 1");
  assert.equal(B.style.gridArea, "2 / 2 / span 1 / span 1");
  // a new tile (a pin, place 0) goes in at its place - the existing ones still never move
  const p = dynProg(["z", "a", "b", "c"], "c", { v: 3 }); p.src[0].pin = true; p.src[0].ring = false;
  s.ctl.update(p);
  assert.deepEqual(moved, [], "existing tiles untouched");
  assert.deepEqual(s.grid.children.map((c) => c.getAttribute("data-id")), ["z", "a", "b", "c"], "inserted before a");
  assert.equal(s.stage.getAttribute("data-dyn"), "d4");
  assert.equal(s.grid.style.gridTemplateColumns, "3fr 1fr");
  assert.equal(tileEl(s.grid, "z").classList.contains("ring"), false);
  // back to a legacy layout: the inline placement is cleared
  s.ctl.update({ v: 4, layout: "grid4", count: 3, src: [tileS("a", 0, "card"), tileS("b", 1, "card"), tileS("c", 2, "card")], still_s: 20 });
  assert.equal(s.stage.getAttribute("data-layout"), "grid4");
  assert.equal(s.stage.getAttribute("data-dyn"), null);
  assert.equal(s.grid.style.gridTemplateColumns, "");
  assert.equal(A.style.gridArea, "");
  s.ctl.stop();
});

test("wave2 F.3 stage-mic.js: a delayed view with another count than dyn.n re-fits the template (never the legacy grid); the main falls back to the newest, then the first; a bad dyn is the legacy layout", () => {
  const p = dynProg(["a", "b"], "gone"); p.dyn = { n: 3, t: "d3", main: "gone" }; p.src[1].newest = true;
  const s = dynSandbox(p);
  assert.equal(s.stage.getAttribute("data-layout"), "dynamic", "not the legacy 'split'");
  assert.equal(s.stage.getAttribute("data-dyn"), "d2");
  assert.equal(tileEl(s.grid, "b").style.gridArea, "1 / 1 / span 1 / span 1", "the newest takes the main");
  const q = dynProg(["a", "b"], "gone", { v: 2 });
  s.ctl.update(q);
  assert.equal(tileEl(s.grid, "a").style.gridArea, "1 / 1 / span 1 / span 1", "no newest: the first");
  s.ctl.update(dynProg(["a", "b"], "a", { v: 3, dyn: { n: 2, t: "d<script>", main: "a" } }));
  assert.equal(s.stage.getAttribute("data-layout"), "split", "a malformed dyn: the legacy layout");
  s.ctl.stop();
});

test("wave2 F.3 stage-mic.js: a 375 px phone keeps the templates (.narrow) with short names on 6+ cells and ⚑ in the bar; the stage bar offers Dynamic only when the site does", () => {
  const ids = ["alexander_the_great", "b", "c", "d", "e", "f", "g"];
  const s = dynSandbox(Object.assign(dynProg(ids, "b"), { report: true }), 375);
  assert.ok(s.stage.classList.contains("narrow"));
  assert.equal(s.stage.getAttribute("data-dyn"), "d7");
  assert.equal(s.grid.style.gridTemplateColumns, "2fr 1fr 1fr");
  assert.equal(s.grid.style.gridTemplateRows, "repeat(3, 1fr)");
  const nm = findCls(tileEl(s.grid, "alexander_the_great"), "mf-name");
  assert.equal(nm.textContent, "ALEXANDER_…", "short names on small cells");
  assert.ok(s.stage.classList.contains("barred"), "⚑ moves to the bar on small cells");
  s.ctl.stop();
  const css = read("public", "css", "webrtc.css");
  assert.match(css, /\.player \.mf-stage\[data-layout=dynamic\] \.mf-grid/);
  assert.match(css, /\.player \.mf-tile\.ring::after \{[^}]*box-shadow/);
  assert.match(css, /\.player \.mf-stage\.narrow\[data-layout=dynamic\] \.mf-tile:not\(\.main\) \.mf-label/);
  // the stage bar: "Dynamic" only with manage.dyn_ok (the site switch on, or the pad already uses it)
  const opts = (st) => { const sel = findCls(st, "mf-layout"); return sel.children.map((o) => o.value); };
  const off = dynSandbox({ v: 1, layout: "split", count: 2, src: [tileS("a", 0, "card"), tileS("b", 1, "card")], manage: { excluded_n: 0, freeze_min: 30 }, still_s: 20 });
  findCls(off.stage, "mf-mbtn").listeners.click[0]();
  assert.ok(!opts(off.stage).includes("dynamic"));
  off.ctl.update({ v: 2, layout: "split", count: 2, src: [tileS("a", 0, "card"), tileS("b", 1, "card")], manage: { excluded_n: 0, freeze_min: 30, dyn_ok: true }, still_s: 20 });
  assert.ok(opts(off.stage).includes("dynamic"));
  assert.equal(EN["js.stage.mf.layout_dynamic"], "Dynamic (fits the speakers)");
  assert.equal(EN["pad.settings.mf.layout.dynamic"], "Dynamic (fits the speakers)");
  off.ctl.stop();
});

test("wave2 WP-4 stage-room.js (?v=18): the mic stage repaints when only the dynamic main, a ring, a cover's flags or 'Dynamic offered' change", () => {
  const x = switcher({});
  const base = () => MIC({ dyn: { n: 2, t: "d2", main: "a" }, src: [{ id: "a" }, { id: "b" }], manage: { pins_room: 0 } });
  x.sw.setMic(base());
  const n0 = x.rendered.length;
  x.sw.setMic(base());
  assert.equal(x.rendered.length, n0, "nothing moved: no repaint");
  const changes = [
    (p) => { p.dyn.main = "b"; },
    (p) => { p.src[1].ring = true; },
    (p) => { p.src[1] = { id: "b", kind: "cover", hood: 2, veil: "incognito" }; },
    (p) => { p.src[1] = { id: "b", kind: "cover", hood: 2, veil: "incognito", rv: 1, ex: 1 }; },
    (p) => { p.src[1] = { id: "b", kind: "cover", hood: 2, veil: "hidden", rv: 1, ex: 1, self: 1 }; },
    (p) => { p.manage.dyn_ok = true; },
  ];
  let last = base();
  for (const f of changes) {
    const p = JSON.parse(JSON.stringify(last)); f(p);
    const before = x.rendered.length;
    x.sw.setMic(p);
    assert.equal(x.rendered.length, before + 1, "repainted after " + f.toString());
    last = p;
  }
  for (const v of ["home.ejs", "room.ejs"]) assert.match(read("views", v), /stage-room\.js\?v=18/, v);
});

// ── wave2 WP-4 (the incognito / mic-stage spec F.4): cover tiles on the page ──
const coverS = (id, pos, extra) => Object.assign({ kind: "cover", id, name: null, hood: 3, veil: "incognito", pos, newest: false, video: "cover", watch: "cover" }, extra || {});

test("wave2 F.4 stage-mic.js: a cover tile - the hooded frog (peek / shadow, its hood), '<frog name or someone> · incognito', the ring; NO button for members (no ⚑ ✕ 📌 🙈 Reveal), no ticket, no still; ⚑ lists skip it", async () => {
  const s = dynSandbox({ v: 1, layout: "split", count: 2, report: true, still_s: 20,
    src: [tileS("alice", 0, "live"), coverS("anon-1a2b3c4d", 1, { newest: true, ring: true })] });
  const e = tileEl(s.grid, "anon-1a2b3c4d");
  assert.ok(e.classList.contains("mf-cover"));
  assert.equal(e.getAttribute("data-why"), "cover");
  assert.equal(e.getAttribute("data-hood"), "3");
  const hood = findCls(e, "mf-hood");
  assert.equal(hood.src, "/public/img/anon/hood-peek-3.svg");
  assert.equal(hood.hidden, false);
  assert.equal(hood.alt, "", "decorative (the tile's label says who)");
  assert.equal(findCls(e, "mf-name").textContent, "someone · incognito");
  assert.equal(e.getAttribute("aria-label"), "someone, incognito, on the mic");
  assert.ok(e.classList.contains("newest") && e.classList.contains("ring"));
  assert.equal(e.children.find((c) => c.tagName === "VIDEO").hidden, true, "never a video");
  assert.equal(findCls(e, "mf-card").hidden, true);
  for (const cls of ["mf-rp", "mf-pn", "mf-off", "mf-rv"]) assert.equal(findCls(e, cls).hidden, true, cls);
  assert.equal(e.children.find((c) => c.className === "mf-x").hidden, true, "✕");
  await new Promise((r) => setTimeout(r, 10));
  s.ctl.stop();
  // a frog name (v2) and the hidden veil -> the shadow hood
  const h = dynSandbox({ v: 1, layout: "single", count: 1, still_s: 20, src: [coverS("anon-00000001", 0, { name: "Soggy Bullfrog", veil: "hidden", hood: 6 })] });
  const he = tileEl(h.grid, "anon-00000001");
  assert.equal(findCls(he, "mf-hood").src, "/public/img/anon/hood-shadow-6.svg");
  assert.equal(findCls(he, "mf-name").textContent, "Soggy Bullfrog · hidden");
  h.ctl.stop();
  // a bad hood can't build another path
  const b = dynSandbox({ v: 1, layout: "single", count: 1, still_s: 20, src: [coverS("anon-00000002", 0, { hood: "../../x" })] });
  assert.equal(findCls(tileEl(b.grid, "anon-00000002"), "mf-hood").src, "/public/img/anon/hood-peek-0.svg");
  b.ctl.stop();
  // no ticket asked for a cover; ⚑ in the bar (narrow) never lists it
  const posts = [];
  const n = dynSandbox({ v: 1, layout: "grid4", count: 3, report: true, still_s: 20, src: [tileS("alice", 0, "card"), tileS("bob", 1, "card"), coverS("anon-00000003", 2)] }, 375);
  n.ctx.fetch = (u, o) => { posts.push(u); return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); };
  const rb = findCls(n.stage, "mf-rbtn");
  assert.equal(rb.hidden, false);
  rb.listeners.click[0]();
  const rp = findCls(n.stage, "mf-rpanel");
  const labels = rp.children.map((c) => c.textContent);
  assert.ok(labels.some((t) => /ALICE/.test(t)) && !labels.some((t) => /someone|anon-/.test(t)), JSON.stringify(labels));
  assert.ok(!posts.some((u) => /watch|still/.test(u)), "no ticket / still for a cover");
  n.ctl.stop();
  for (const k of ["js.pad.veil.incognito", "js.pad.veil.hidden", "js.stage.mf.cover_someone", "js.stage.mf.cover_aria", "js.stage.mf.cover_self", "js.stage.mf.reveal",
                   "js.stage.mf.reveal_aria", "js.stage.mf.revealed", "js.stage.mf.exclude_cover_q"]) assert.ok(k in EN, k);
  const css = read("public", "css", "webrtc.css");
  assert.match(css, /\.mf-tile\.mf-cover \{[^}]*repeating-linear-gradient/, "static scanlines");
  assert.match(css, /\.mf-tile \.mf-hood \{[^}]*image-rendering: pixelated/);
  for (let i = 1; i <= 7; i++) assert.match(css, new RegExp('\\.mf-cover\\[data-hood="' + i + '"\\]'), "hood token " + i);
});

test("wave2 F.4 stage-mic.js: Reveal only with rv: 1 AND WP-2's client (window.PATVReveal.tile) - the answer shows only to this viewer (dashed edge + chip); ✕ only with ex: 1; 'this is you' with self: 1", async () => {
  const prog = (extra) => ({ v: 1, layout: "single", count: 1, still_s: 20, manage: { excluded_n: 0, freeze_min: 30 }, src: [coverS("anon-0000000a", 0, extra)] });
  // rv: 1 but no PATVReveal on the page (WP-2 not in yet): no button
  let s = dynSandbox(prog({ rv: 1 }));
  let e = tileEl(s.grid, "anon-0000000a");
  assert.equal(findCls(e, "mf-rv").hidden, true);
  assert.equal(e.children.find((c) => c.className === "mf-x").hidden, true, "a manager without ex: 1 - no ✕");
  s.ctl.stop();
  // with WP-2's client
  const calls = [];
  s = dynSandbox(prog({ rv: 1, ex: 1 }));
  s.ctx.PATVReveal = { tile: (slug, id) => { calls.push([slug, id]); return Promise.resolve({ ok: true, login: "erin" }); } };
  s.ctl.update(Object.assign(prog({ rv: 1, ex: 1 }), { v: 2 }));
  e = tileEl(s.grid, "anon-0000000a");
  const rv = findCls(e, "mf-rv");
  assert.equal(rv.hidden, false);
  assert.equal(rv.getAttribute("aria-label"), "Reveal who this is (only you see it; it is logged)");
  assert.equal(e.children.find((c) => c.className === "mf-x").hidden, false, "ex: 1 - ✕");
  rv.listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, [["pad", "anon-0000000a"]]);
  assert.ok(e.classList.contains("revealed"), "the dashed edge");
  assert.equal(findCls(e, "mf-chip").textContent, "erin · only you can see this");
  assert.equal(findCls(e, "mf-rv").hidden, true);
  s.ctl.update(Object.assign(prog({ rv: 1, ex: 1 }), { v: 3 }));
  assert.equal(findCls(e, "mf-chip").textContent, "erin · only you can see this", "kept across updates while it stays up");
  // its ✕ (ex: 1) keeps the veiled speaker off by the TILE id - the server maps it; the question never names anyone
  const sent = [];
  s.ctx.fetch = (u, o) => { sent.push([u, o && o.body ? JSON.parse(o.body) : null]); return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); };
  e.children.find((c) => c.className === "mf-x").listeners.click[0]();
  const askP = findCls(s.stage, "mf-ask");
  assert.equal(askP.children[0].textContent, "Keep this veiled speaker off the mic stage");
  askP.children[1].listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent.find((x) => /\/exclude$/.test(x[0]))[1], { tile: "anon-0000000a", hours: 1 });
  s.ctl.stop();
  // a bad answer reveals nothing
  s = dynSandbox(prog({ rv: 1 }));
  s.ctx.PATVReveal = { tile: () => Promise.resolve({ ok: true, login: "<b>x</b>" }) };
  s.ctl.update(Object.assign(prog({ rv: 1 }), { v: 2 }));
  e = tileEl(s.grid, "anon-0000000a");
  findCls(e, "mf-rv").listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!e.classList.contains("revealed"));
  s.ctl.stop();
  // the speaker sees their own cover
  s = dynSandbox(prog({ self: 1 }));
  assert.equal(findCls(tileEl(s.grid, "anon-0000000a"), "mf-chip").textContent, "this is you");
  s.ctl.stop();
});

// ── wave2 WP-4 review fixes ──
test("wave2 review (B-privacy-ux-6) stage-mic.js: ⋯ Manage lists a cover with ex: 1 ('✕ <frog name or someone>', posting {tile}) - the small cells of a narrow 6-9 dynamic stage hide a tile's own ✕; never a cover without ex: 1", async () => {
  const src = ["a", "b", "c", "d", "e"].map((id, i) => tileS(id, i, "card"));
  src.push(coverS("anon-0000000b", 5, { name: "Soggy Bullfrog", ex: 1 }), coverS("anon-0000000c", 6, { ex: 1 }), coverS("anon-0000000d", 7));
  const s = dynSandbox({ v: 1, layout: "grid9", count: 8, src, dyn: { n: 8, t: "d8", main: "a" }, still_s: 20, manage: { excluded_n: 0, freeze_min: 30 } }, 375);
  assert.ok(s.stage.classList.contains("narrow"), "a phone");
  assert.match(read("public", "css", "webrtc.css"), /\.mf-stage\.narrow\[data-dyn=d8\] \.mf-tile:not\(\.main\) \.mf-x/, "(the CSS that hides the small cells' ✕)");
  const sent = [];
  s.ctx.fetch = (u, o) => { sent.push([u, o && o.body ? JSON.parse(o.body) : null]); return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }); };
  findCls(s.stage, "mf-mbtn").listeners.click[0]();
  const panel = s.stage.children.find((c) => c.className === "mf-panel");
  assert.equal(panel.hidden, false);
  const people = panel.children.find((c) => c.className === "mf-people");
  const items = people.children.map((li) => li.children[0]);
  assert.deepEqual(items.map((b) => b.textContent), ["✕ A", "✕ B", "✕ C", "✕ D", "✕ E", "✕ Soggy Bullfrog", "✕ someone"], "the ex: 1 covers by frog name / 'someone'; anon-0000000d (no ex) isn't listed");
  assert.equal(items[5].getAttribute("aria-label"), "Keep this veiled speaker off the mic stage");
  items[6].listeners.click[0]();
  const askP = findCls(s.stage, "mf-ask");
  assert.equal(askP.children[0].textContent, "Keep this veiled speaker off the mic stage", "the question never names anyone");
  askP.children[1].listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent.find((x) => /\/exclude$/.test(x[0]))[1], { tile: "anon-0000000c", hours: 1 }, "by the tile id - the server maps it");
  s.ctl.stop();
});

test("wave2 review (B-privacy-ux-7) pad-micfollow.js: a veiled exclusion with no frog name (the server sends null - no English copy in the DB) reads 'a veiled speaker' in the page's language; removal by its xid; every key in en.json", async () => {
  const js = read("public", "js", "pad-micfollow.js");
  const dom = fakeDom();
  const els = {};
  for (const id of ["mfForm", "mfMsg", "mfExRows", "mfExForm", "mfExMsg", "mfStatus"]) els[id] = dom.mk(id === "mfForm" || id === "mfExForm" ? "form" : "p");
  els.mfForm.setAttribute("data-url", "/api/rooms/pad/micfollow/settings");
  els.mfExRows.setAttribute("data-url", "/api/rooms/pad/micfollow/exclude");
  const X1 = "0123456789abcdef", X2 = "fedcba9876543210";
  els.mfExRows.setAttribute("data-list", JSON.stringify([{ login: null, veiled: null, xid: X1, until: null, reason: "owner", by: "admin", at: 3 },
    { login: null, veiled: "Soggy Bullfrog", xid: X2, until: null, reason: "owner", by: "admin", at: 2 }, { login: "bob", until: null, reason: "owner", by: "admin", at: 1 }]));
  const sent = [];
  const ctx = { document: { getElementById: (id) => els[id] || null, createElement: dom.mk }, console, setTimeout, Date,
    __t: (k, d, v) => (k === "js.padset.mf.veiled_anon" ? "un orateur voilé" : String(d).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m))),
    fetch: (u, o) => { sent.push(JSON.parse(o.body)); return Promise.resolve({ json: () => Promise.resolve({ ok: true, state: { excluded: [] } }) }); } };
  ctx.window = ctx;
  vm.runInNewContext(js, ctx);
  const rows = els.mfExRows.children;
  assert.deepEqual(rows.map((tr) => tr.children[0].textContent), ["🕶 un orateur voilé", "🕶 Soggy Bullfrog", "bob"]);
  rows[0].children[4].children[0].listeners.click[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent[0], { xid: X1, remove: true });
  assert.equal(EN["js.padset.mf.veiled_anon"], "a veiled speaker");
});

// ── wave 2: WP-4's covers wired to WP-2 (veilstage.js) - the page side ──
/** A stand-in for pad-reveal.js's window.PATVReveal: the toggle's state, its listeners, the asks. */
function fakeReveal(state0, login = (id) => (id === "anon-0000000b" ? "erin" : "fay")) {
  const R = { st: state0, calls: [], subs: [], offers: 0 };
  R.api = { tile: (slug, id, o) => { R.calls.push([slug, id, !!(o && o.toggle)]); return Promise.resolve({ ok: true, login: login(id) }); },
            state: () => R.st, on: (fn) => { R.subs.push(fn); return () => { R.subs = R.subs.filter((x) => x !== fn); }; }, offer: () => { R.offers++; } };
  R.set = (v) => { R.st = v; R.subs.slice().forEach((fn) => fn(v)); };
  return R;
}

test("wave2 (J-18) stage-mic.js: while 'Show real names' is on, each rv: 1 cover reveals itself ONCE ({toggle: true}) - never one without rv; 'Hide again' hides what the toggle showed (a Reveal pressed by hand stays); unknown asks once, off never; a cover with Reveal offers the toggle's bar", async () => {
  const prog = (v, src) => ({ v, layout: "grid4", count: src.length, still_s: 20, src });
  const three = () => [coverS("anon-0000000b", 0, { rv: 1 }), coverS("anon-0000000c", 1, { rv: 1 }), coverS("anon-0000000d", 2)];
  const chipOf = (s, id) => { const e = tileEl(s.grid, id); const c = findCls(e, "mf-chip"); return c.hidden ? "" : c.textContent; };
  // on: both rv covers reveal themselves, counted on the toggle (toggle: true); the cover without rv: never
  let R = fakeReveal(true);
  let s = dynSandbox({ v: 1, layout: "single", count: 0, still_s: 20, src: [] });
  s.ctx.PATVReveal = R.api;
  s.ctl.update(prog(2, three()));
  await tick();
  assert.deepEqual(R.calls, [["pad", "anon-0000000b", true], ["pad", "anon-0000000c", true]]);
  assert.equal(chipOf(s, "anon-0000000b"), "erin · only you can see this");
  assert.ok(tileEl(s.grid, "anon-0000000b").classList.contains("revealed"), "the dashed edge");
  assert.equal(chipOf(s, "anon-0000000d"), "", "no rv: nothing");
  assert.equal(R.offers, 1, "the pad chat is asked to offer its toggle bar (once)");
  s.ctl.update(prog(3, three()));
  await tick();
  assert.equal(R.calls.length, 2, "once per cover id - a new program asks nothing again");
  // "Hide again": what the toggle showed is hidden again; nothing is asked while it's off
  R.set(false);
  await tick();
  assert.deepEqual([chipOf(s, "anon-0000000b"), chipOf(s, "anon-0000000c")], ["", ""]);
  assert.ok(!tileEl(s.grid, "anon-0000000b").classList.contains("revealed"));
  s.ctl.update(prog(4, three()));
  await tick();
  assert.equal(R.calls.length, 2, "off: no ask");
  // a Reveal pressed by hand (no toggle) stays when the toggle goes on and off again
  findCls(tileEl(s.grid, "anon-0000000b"), "mf-rv").listeners.click[0]();
  await tick();
  assert.deepEqual(R.calls[2], ["pad", "anon-0000000b", false]);
  R.set(true);
  await tick();
  assert.deepEqual(R.calls.slice(3), [["pad", "anon-0000000c", true]], "on again: only the one not shown yet");
  R.set(false);
  await tick();
  assert.deepEqual([chipOf(s, "anon-0000000b"), chipOf(s, "anon-0000000c")], ["erin · only you can see this", ""], "the hand-pressed one stays");
  // a cover that leaves and comes back with a new id is asked about afresh; a stopped stage stops listening
  s.ctl.stop();
  assert.equal(R.subs.length, 0, "unsubscribed on stop");
  // not known yet (null): the first ask finds out; off from the start: never asked
  R = fakeReveal(null);
  s = dynSandbox({ v: 1, layout: "single", count: 0, still_s: 20, src: [] });
  s.ctx.PATVReveal = R.api;
  s.ctl.update(prog(2, [coverS("anon-0000000b", 0, { rv: 1 })]));
  await tick();
  assert.deepEqual(R.calls, [["pad", "anon-0000000b", true]]);
  s.ctl.stop();
  R = fakeReveal(false);
  s = dynSandbox({ v: 1, layout: "single", count: 0, still_s: 20, src: [] });
  s.ctx.PATVReveal = R.api;
  s.ctl.update(prog(2, [coverS("anon-0000000b", 0, { rv: 1 })]));
  await tick();
  assert.deepEqual(R.calls, []);
  s.ctl.stop();
  // a bad answer reveals nothing
  R = fakeReveal(true, () => "<b>x</b>");
  s = dynSandbox({ v: 1, layout: "single", count: 0, still_s: 20, src: [] });
  s.ctx.PATVReveal = R.api;
  s.ctl.update(prog(2, [coverS("anon-0000000b", 0, { rv: 1 })]));
  await tick();
  assert.equal(chipOf(s, "anon-0000000b"), "");
  s.ctl.stop();
});

test("wave2 pad-reveal.js: PATVReveal.tile posts {room, tile} same-origin / no-store / no-referrer / fetch-only; {toggle: true} adds toggle and learns the toggle (ok -> on, 409 -> off, then no ask until it's on); a bad id never goes out, a bad login never comes back; on / offer reach their listeners", async () => {
  const js = read("public", "js", "pad-reveal.js");
  const sent = [];
  let answer = { status: 200, d: { ok: true, tile: "anon-0000000b", login: "erin", display: "Erin" } };
  const ctx = { console, fetch: (u, o) => { sent.push([u, o]); const a = answer; return Promise.resolve({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.d) }); } };
  ctx.window = ctx;
  vm.runInNewContext(js, ctx);
  const R = ctx.PATVReveal;
  const seen = [];
  const un = R.on((v) => seen.push(v));
  assert.equal(R.state(), null, "not known yet");
  // a press on Reveal
  let r = await R.tile("pad", "anon-0000000b");
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, login: "erin", display: "Erin" });
  assert.equal(sent[0][0], "/api/chatlog/reveal");
  const o = sent[0][1];
  assert.deepEqual([o.method, o.credentials, o.cache, o.referrerPolicy, o.headers["x-requested-with"]], ["POST", "same-origin", "no-store", "no-referrer", "fetch"]);
  assert.deepEqual(JSON.parse(o.body), { room: "pad", tile: "anon-0000000b" });
  assert.equal(R.state(), null, "a press says nothing about the toggle");
  // the toggle's auto-reveal: toggle: true, an answer = on
  r = await R.tile("pad", "anon-0000000b", { toggle: true });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(sent[1][1].body), { room: "pad", tile: "anon-0000000b", toggle: true });
  assert.equal(R.state(), true);
  // 409 (the toggle is off): off, and no more asks until it's on again
  answer = { status: 409, d: { ok: false, code: "toggle_off", error: "Show real names is off - turn it on first." } };
  r = await R.tile("pad", "anon-0000000c", { toggle: true });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: false, off: true });
  assert.equal(R.state(), false);
  const n = sent.length;
  r = await R.tile("pad", "anon-0000000c", { toggle: true });
  assert.equal(sent.length, n, "off: not asked");
  assert.deepEqual(seen, [true, false], "listeners told of each change");
  R.setState(true);
  assert.deepEqual(seen, [true, false, true], "the chat's bar turning it on");
  // refusals carry the server's words; a bad id never goes out; a login that isn't one never comes back
  answer = { status: 403, d: { ok: false, error: "Only PATV admins…" } };
  assert.deepEqual(JSON.parse(JSON.stringify(await R.tile("pad", "anon-0000000c"))), { ok: false, error: "Only PATV admins…" });
  const m = sent.length;
  for (const bad of ["frankiefettuccine", "anon-1", "../x", ""]) assert.equal((await R.tile("pad", bad)).ok, false);
  assert.equal((await R.tile("", "anon-0000000c")).ok, false);
  assert.equal(sent.length, m, "nothing sent for a bad id or pad");
  answer = { status: 200, d: { ok: true, login: "<img src=x>" } };
  assert.equal((await R.tile("pad", "anon-0000000c")).ok, false);
  let offered = 0;
  R.onOffer(() => offered++);
  R.offer(); R.offer();
  assert.equal(offered, 2);
  un();
  R.setState(false);
  assert.equal(seen.length, 3, "unsubscribed");
});

test("wave2 room.ejs: pad-reveal.js loads before stage-mic.js (v9 - 1.99ahp stable slots) in the WebRTC block; the pad's ONE 'Show real names' toggle mirrors its state into PATVReveal, takes what the stage learns, and draws its bar on a cover's offer", () => {
  const room = read("views", "room.ejs");
  const blk = room.slice(room.indexOf("locals.webrtcCfg()) { %>"), room.indexOf("<% } %><% if (typeof onairAdmin", room.indexOf("locals.webrtcCfg()) { %>")));
  assert.ok(blk.indexOf("/public/js/pad-reveal.js?v=1") >= 0 && blk.indexOf("/public/js/pad-reveal.js?v=1") < blk.indexOf("/public/js/stage-mic.js?v=9"), "pad-reveal.js, then stage-mic.js v9");   // (1.99ahn dead relay: v8 - resuming…; 1.99ahp stable slots: v9)
  const tg = room.slice(room.indexOf("var on = null, bar = null, busy = false"), room.indexOf("function nearBottom()"));
  assert.ok(tg.includes("function mirror() { if (PR) PR.setState(on); }"), "mirrored into PATVReveal");
  assert.ok(/busy = false; on = true; mirror\(\);/.test(tg), "a batch that answers: on");
  assert.ok(/if \(err\.status === 409\) mirror\(\);/.test(tg), "a 409: off");
  assert.ok(/on = !!d\.on;[\s\S]{0,200}mirror\(\);/.test(tg), "the bar's own flip");
  assert.ok(tg.includes("PR.on(function (s) {") && tg.includes("PR.onOffer(function () { if (!bar) draw(); });"), "what the stage learns comes back; a cover offers the bar");
  for (const v of ["room.ejs", "home.ejs"]) assert.match(read("views", v), /\/public\/css\/veil\.css\?v=2"/, v + ": veil.css v2 (the hood tokens moved)");
});

test("wave2: one frog-name session = one hood - the chat bubble (chatlog-core .hdN over veil.css --hood-N) and the stage cover (stage-mic hood-*-N.svg over webrtc.css .mf-cover[data-hood=N]) use the same index, the same picture and the same colour token", () => {
  const veil = read("public", "css", "veil.css"), rtc = read("public", "css", "webrtc.css");
  const core = read("public", "js", "chatlog-core.js"), mic = read("public", "js", "stage-mic.js");
  const tok = (n) => (veil.match(new RegExp("--hood-" + n + ": (#[0-9a-f]{6})")) || [])[1];
  const coverTok = (n) => (n === 0 ? (rtc.match(/\.player \.mf-tile\.mf-cover \{ --mf-hood: (#[0-9a-f]{6})/) || [])[1]
    : (rtc.match(new RegExp('\\.mf-cover\\[data-hood="' + n + '"\\] \\{ --mf-hood: (#[0-9a-f]{6})')) || [])[1]);
  for (let n = 0; n < 8; n++) {
    assert.ok(tok(n) && tok(n) === coverTok(n), `hood ${n}: chat ${tok(n)} = stage ${coverTok(n)}`);
    assert.ok(veil.includes(`.av.hood.hd${n} { background-color: var(--hood-${n}); }`), "the bubble's colour " + n);
    assert.ok(veil.includes(`.av.hood-peek.hd${n} { background-image: url(/public/img/anon/hood-peek-${n}.svg); }`), "the peek picture " + n);
    assert.ok(veil.includes(`.av.hood-shadow.hd${n} { background-image: url(/public/img/anon/hood-shadow-${n}.svg); }`), "the shadow picture " + n);
  }
  // both pass the session's index through unchanged (0-7, integers only)
  assert.ok(core.includes("' hd' + hd") && /function hoodOf\(u\) \{ var n = u \? Number\(u\.hood\) : NaN; return veilAlias\(u\) && n >= 0 && n <= 7/.test(core), "chatlog-core: .hd<session hood>");
  assert.ok(mic.includes("hoodImg.src = '/public/img/anon/hood-' + (veil === 'hidden' ? 'shadow' : 'peek') + '-' + hood + '.svg';"), "stage-mic: hood-*-<session hood>.svg");
  // the hood art itself: index N is the Nth hood colour of both palettes (charcoal, midnight, plum, forest, maroon, teal, mustard, slate)
  const art = ["#2b2d31", "#23305c", "#4b2a5e", "#1f4a33", "#5c2228", "#1d4f57", "#6b5418", "#3d4654"];
  for (let n = 0; n < 8; n++) assert.ok(read("public", "img", "anon", `hood-peek-${n}.svg`).includes(`fill="${art[n]}"`), "hood-peek-" + n);
});

// ── wave2 integration review ──
test("wave2 integration review (P2 / P3) pad-micfollow.js: a veiled exclusion sent with no xid (the viewer - site staff - may not lift it) shows its label and no Remove, never a login; one with an xid keeps its Remove", async () => {
  const js = read("public", "js", "pad-micfollow.js");
  const dom = fakeDom();
  const els = {};
  for (const id of ["mfForm", "mfMsg", "mfExRows", "mfExForm", "mfExMsg", "mfStatus"]) els[id] = dom.mk(id === "mfForm" || id === "mfExForm" ? "form" : "p");
  els.mfForm.setAttribute("data-url", "/api/rooms/pad/micfollow/settings");
  els.mfExRows.setAttribute("data-url", "/api/rooms/pad/micfollow/exclude");
  els.mfExRows.setAttribute("data-list", JSON.stringify([{ login: null, veiled: "Soggy Bullfrog", until: null, reason: "owner", by: "admin", at: 3 },
    { login: null, veiled: null, until: null, reason: "owner", by: "admin", at: 2 }, { login: "bob", until: null, reason: "owner", by: "admin", at: 1 }]));
  const ctx = { document: { getElementById: (id) => els[id] || null, createElement: dom.mk }, console, setTimeout, Date,
    __t: (k, d, v) => String(d).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)),
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, state: { excluded: [] } }) }) };
  ctx.window = ctx;
  vm.runInNewContext(js, ctx);
  const rows = els.mfExRows.children;
  assert.deepEqual(rows.map((tr) => tr.children[0].textContent), ["🕶 Soggy Bullfrog", "🕶 a veiled speaker", "bob"], "labels - never 'null' or a login");
  for (const tr of rows.slice(0, 2)) {
    assert.equal(tr.children[4].textContent, "Only an admin or the pad's owner can lift this.");
    assert.ok(!tr.children[4].children.some((c) => c.tagName === "BUTTON" || (c.listeners && c.listeners.click)), "no Remove");
  }
  assert.equal(rows[2].children[4].children[0].textContent, "Remove", "a by-name row keeps its Remove");
  assert.equal(EN["js.padset.mf.veiled_nolift"], "Only an admin or the pad's owner can lift this.");
});

test("wave2 integration review (T-3) pad-reveal.js: the toggle's auto-reveal learns whether this viewer can turn the toggle on - ok or 409 toggle_off = yes, 409 toggle_na = no (a role the toggle's rule refuses); a press says nothing", async () => {
  const js = read("public", "js", "pad-reveal.js");
  const mk = (answer) => {
    const ctx = { console, fetch: () => Promise.resolve({ ok: answer.status < 400, status: answer.status, json: () => Promise.resolve(answer.d) }) };
    ctx.window = ctx;
    vm.runInNewContext(js, ctx);
    return ctx.PATVReveal;
  };
  let R = mk({ status: 200, d: { ok: true, login: "erin" } });
  assert.equal(R.can(), null, "not known yet");
  await R.tile("pad", "anon-0000000b");
  assert.equal(R.can(), null, "a press says nothing about the toggle");
  await R.tile("pad", "anon-0000000b", { toggle: true });
  assert.equal(R.can(), true, "it answered: the toggle is on");
  R = mk({ status: 409, d: { ok: false, code: "toggle_off" } });
  await R.tile("pad", "anon-0000000b", { toggle: true });
  assert.deepEqual([R.can(), R.state()], [true, false], "off - but theirs to turn on");
  R = mk({ status: 409, d: { ok: false, code: "toggle_na" } });
  const r = await R.tile("pad", "anon-0000000b", { toggle: true });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: false, off: true });
  assert.deepEqual([R.can(), R.state()], [false, false], "not theirs to turn on - and no more auto asks");
  R = mk({ status: 409, d: { ok: false, code: "privwire_off" } });
  await R.tile("pad", "anon-0000000b", { toggle: true });
  assert.deepEqual([R.can(), R.state()], [null, null], "the switch off says nothing");
});

test("wave2 integration review (T-3) stage-mic.js: the pad chat's toggle bar is offered only once the first ask says this viewer can turn it on (PATVReveal.can() true) - never to an owner the toggle's rule refuses (toggle_na); their tile Reveal stays", async () => {
  const prog = (v, src) => ({ v, layout: "grid4", count: src.length, still_s: 20, src });
  const run = async (state0, can0, after) => {
    const R = fakeReveal(state0);
    let can = can0;
    R.api.can = () => can;
    R.api.tile = (slug, id, o) => { R.calls.push([slug, id, !!(o && o.toggle)]); can = after.can; if (after.state !== undefined) R.st = after.state; return Promise.resolve(after.r); };
    const s = dynSandbox({ v: 1, layout: "single", count: 0, still_s: 20, src: [] });
    s.ctx.PATVReveal = R.api;
    s.ctl.update(prog(2, [coverS("anon-0000000b", 0, { rv: 1 })]));
    await tick();
    const rv = findCls(tileEl(s.grid, "anon-0000000b"), "mf-rv");
    s.ctl.stop();
    return { R, rvShown: !rv.hidden };
  };
  // an owner nothing dates: the ask says toggle_na - no bar, the tile's Reveal still there
  let o = await run(null, null, { can: false, state: false, r: { ok: false, off: true } });
  assert.deepEqual(o.R.calls, [["pad", "anon-0000000b", true]]);
  assert.equal(o.R.offers, 0, "never offered the bar it can't turn on");
  assert.equal(o.rvShown, true, "Reveal on the tile stays");
  // someone who can: toggle_off -> offered (once)
  o = await run(null, null, { can: true, state: false, r: { ok: false, off: true } });
  assert.equal(o.R.offers, 1, "offered");
  // the toggle on: revealed and offered
  o = await run(null, null, { can: true, state: true, r: { ok: true, login: "erin" } });
  assert.equal(o.R.offers, 1);
  // known already (an earlier ask): offered at once, or never
  o = await run(false, true, { can: true, r: { ok: false } });
  assert.deepEqual([o.R.calls.length, o.R.offers], [0, 1], "off but theirs: offered, not asked");
  o = await run(false, false, { can: false, r: { ok: false } });
  assert.deepEqual([o.R.calls.length, o.R.offers], [0, 0], "not theirs: neither");
});

// ── 1.99ahn dead relay: back from a hidden tab, the paused tiles say "resuming…" (their cams never stopped - only this tab's
// players did), never "cam starting…"; a tile that really starts still says "cam starting…"; the pause itself is unchanged ──
/** stage-mic.js with a hidden-tab switch: every live tile plays (its WHEP connects) unless its login is in `stuck`; a still
 *  gets its picture. -> {ctx, host, ctl, posts, tileOf, hide(), show()} */
function visHarness(program, stuck = new Set()) {
  const js = read("public", "js", "stage-mic.js");
  const dom = fakeDom();
  let vis = null;
  const posts = [];
  const ctx = { document: { createElement: dom.mk, hidden: false, addEventListener(k, fn) { if (k === "visibilitychange") vis = fn; }, removeEventListener() {} },
    console, clearTimeout,
    setTimeout: (fn, ms) => (ms >= 30000 ? (fn(), 0) : setTimeout(fn, ms)),            // the 30 s hidden-tab wait runs at once
    setInterval: () => 0, clearInterval() {},
    fetch: (u, o) => {
      const body = o && o.body ? JSON.parse(o.body) : null;
      posts.push([u, body]);
      const d = /\/still\//.test(u) ? { ok: true, state: "ok", img: "data:image/jpeg;base64,AAAA" }
        : { ok: true, whep: "https://x/whep?pt=1&who=" + (body && body.login), state: "pending" };
      return Promise.resolve({ json: () => Promise.resolve(d) });
    },
    PATVRtc: { watch: (whep) => (stuck.has(String(whep).split("who=")[1]) ? new Promise(() => {}) : Promise.resolve({ close() {} })) },
    RTCPeerConnection: function () {}, Date };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const host = dom.mk("div");
  const ctl = ctx.PATVStageMic.render(host, program, { slug: "pad" });
  const tileOf = (id) => findBy(host, "mf-tile").find((t) => t.getAttribute("data-id") === id) || null;
  return { ctx, host, ctl, posts, tileOf, hide() { ctx.document.hidden = true; vis(); }, show() { ctx.document.hidden = false; vis(); } };
}
const visTile = (id, pos, video) => ({ kind: "cam", id, name: id.toUpperCase(), pos, newest: pos === 0, video, why: null, watch: "ok" });
/** the words on a tile's card (its "mf-why") */
const reasonOf = (tile) => (findBy(tile, "mf-why")[0] || {}).textContent;

test("1.99ahn stage-mic.js: after 30 s in a hidden tab the live / still tiles pause; on return they say 'resuming…', not 'cam starting…'", async () => {
  const js = read("public", "js", "stage-mic.js");
  assert.match(js, /HIDDEN_MS = 30000/, "the pause is unchanged");
  const s = visTile;
  const H = visHarness({ v: 1, layout: "split", count: 2, src: [s("a", 0, "live"), s("b", 1, "still")], manage: null, still_s: 20 });
  const { posts, tileOf, ctl } = H;
  const A = tileOf("a"), Bt = tileOf("b");
  assert.match(A.textContent, /cam starting…/, "a first start says 'cam starting…'");
  assert.match(Bt.textContent, /cam starting…/);
  await tick();
  const tickets = () => posts.filter((p) => /\/micfollow\/watch$/.test(p[0]) && !p[1].beat && !p[1].stop).length;
  const n0 = tickets();
  H.hide();
  assert.ok(posts.some((p) => /\/micfollow\/watch$/.test(p[0]) && p[1].stop === true), "hidden 30 s: the live tile's session closes (as before)");
  H.show();
  assert.match(A.textContent, /resuming…/, "back: the live tile says 'resuming…'");
  assert.doesNotMatch(A.textContent, /cam starting/);
  assert.match(Bt.textContent, /resuming…/, "...and so does the still");
  await tick();
  assert.equal(tickets(), n0 + 1, "it watches again with a fresh ticket (as before)");
  // a tile that comes on the stage now (not a resume) still says "cam starting…"
  ctl.update({ v: 2, layout: "grid4", count: 3, src: [s("a", 0, "live"), s("b", 1, "still"), s("c", 2, "live")], manage: null, still_s: 20 });
  assert.match(tileOf("c").textContent, /cam starting…/, "a new tile: 'cam starting…'");
  ctl.stop();
  assert.equal(EN["js.stage.mf.resuming"], "resuming…", "the new string is in locales/en.json");
});

test("1.99ahn review UX-2 stage-mic.js: 'resuming…' only on a tile whose picture the pause took away - one still starting, one that came on or went live while hidden says 'cam starting…'", async () => {
  const s = visTile;
  // a plays; b's live video never connects (still "cam starting…" when the tab hides); c is "starting" (a card)
  const H = visHarness({ v: 1, layout: "grid4", count: 3, src: [s("a", 0, "live"), s("b", 1, "live"), s("c", 2, "starting")], manage: null, still_s: 20 }, new Set(["b"]));
  await tick();
  H.hide();
  // while hidden: c's cam goes live, d comes on the stage
  H.ctl.update({ v: 2, layout: "grid4", count: 4, src: [s("a", 0, "live"), s("b", 1, "live"), s("c", 2, "live"), s("d", 3, "live")], manage: null, still_s: 20 });
  H.show();
  assert.equal(reasonOf(H.tileOf("a")), "resuming…", "a had its picture: 'resuming…'");
  assert.equal(reasonOf(H.tileOf("b")), "cam starting…", "b never played here: 'cam starting…'");
  assert.equal(reasonOf(H.tileOf("c")), "cam starting…", "c went live while hidden: 'cam starting…'");
  assert.equal(reasonOf(H.tileOf("d")), "cam starting…", "d came on while hidden: 'cam starting…'");
  // a tile that played, then went to a card while hidden (its relay restarted) and live again: it starts over
  await tick();
  H.hide();
  H.ctl.update({ v: 3, layout: "grid4", count: 4, src: [s("a", 0, "starting"), s("b", 1, "live"), s("c", 2, "live"), s("d", 3, "live")], manage: null, still_s: 20 });
  H.ctl.update({ v: 4, layout: "grid4", count: 4, src: [s("a", 0, "live"), s("b", 1, "live"), s("c", 2, "live"), s("d", 3, "live")], manage: null, still_s: 20 });
  H.show();
  assert.equal(reasonOf(H.tileOf("a")), "cam starting…", "a's relay started over while hidden: 'cam starting…'");
  assert.equal(reasonOf(H.tileOf("c")), "resuming…", "c played after the first return: 'resuming…'");
  H.ctl.stop();
});

// ── 1.99ahp STABLE SLOTS (owner 2026-11-02: "It doesn't need to move speaker slots unless a new speaker is coming in") ──
/** Spy on the grid: which existing tile nodes get appended / inserted / removed (a moved node re-attaches its video). */
function moves(grid, nodes) {
  const out = [];
  let inside = 0;                        // (the fake DOM's insertBefore / appendChild detach through removeChild: one move)
  for (const k of ["appendChild", "insertBefore", "removeChild"]) {
    const f = grid[k];
    grid[k] = function (c, ...r) {
      if (nodes.includes(c) && !inside) out.push(k + ":" + c.getAttribute("data-id"));
      inside++;
      try { return f.call(this, c, ...r); } finally { inside--; }
    };
  }
  return out;
}
const idsOf = (grid) => grid.children.filter((c) => c.getAttribute && c.getAttribute("data-id")).map((c) => c.getAttribute("data-id"));
const area = (grid, id) => tileEl(grid, id).style.gridArea;
const fillersOf = (grid) => grid.children.filter((c) => c.className === "mf-empty").length;

test("1.99ahp stage-mic.js: a node only moves when its place changed - the same program again (legacy grid, no stable flag) moves NO tile (it used to re-append every one); a newcomer goes in at its place, the others stay", () => {
  const prog = (src, extra) => Object.assign({ v: 1, layout: "grid4", count: src.length, src, still_s: 20 }, extra || {});
  const s = dynSandbox(prog([tileS("a", 0, "card"), tileS("b", 1, "card"), tileS("c", 2, "card")]));
  const A = tileEl(s.grid, "a"), B = tileEl(s.grid, "b"), C = tileEl(s.grid, "c");
  const moved = moves(s.grid, [A, B, C]);
  s.ctl.update(prog([tileS("a", 0, "card"), tileS("b", 1, "card", { newest: true }), tileS("c", 2, "card")], { v: 2 }));
  s.ctl.update(prog([tileS("a", 0, "card", { newest: true }), tileS("b", 1, "card"), tileS("c", 2, "card")], { v: 3 }));
  assert.deepEqual(moved, [], "nothing moved: no node re-attached");
  assert.deepEqual(idsOf(s.grid), ["a", "b", "c"]);
  assert.equal(fillersOf(s.grid), 1, "grid4: one empty cell");
  // d comes in at place 1 (today's order can do that: a pin first): inserted there - a, b, c never move
  s.ctl.update(prog([tileS("a", 0, "card"), tileS("d", 1, "card"), tileS("b", 2, "card"), tileS("c", 3, "card")], { v: 4 }));
  assert.deepEqual(moved, [], "existing tiles untouched");
  assert.deepEqual(idsOf(s.grid), ["a", "d", "b", "c"], "reading order = positions");
  // b leaves: removed; the others stay where they are
  s.ctl.update(prog([tileS("a", 0, "card"), tileS("d", 1, "card"), tileS("c", 2, "card")], { v: 5 }));
  assert.deepEqual(moved, ["removeChild:b"]);
  assert.deepEqual(idsOf(s.grid), ["a", "d", "c"]);
  // today's order really changed (c before a): only what's out of place moves
  moved.length = 0;
  s.ctl.update(prog([tileS("c", 0, "card"), tileS("a", 1, "card"), tileS("d", 2, "card")], { v: 6 }));
  assert.deepEqual(idsOf(s.grid), ["c", "a", "d"]);
  assert.deepEqual(moved, ["insertBefore:c"], "one move, not three");
  s.ctl.stop();
});

test("1.99ahp stage-mic.js (program.stable): a tile's cell is its place - an empty place stays an empty cell, each tile its grid-area in the layout's columns, a newcomer fills its cell, no node ever moves", () => {
  const prog = (layout, src, extra) => Object.assign({ v: 1, layout, count: src.length, src, still_s: 20, stable: true }, extra || {});
  const s = dynSandbox(prog("grid4", [tileS("a", 0, "card"), tileS("c", 2, "card"), tileS("d", 3, "card")]));
  assert.equal(area(s.grid, "a"), "1 / 1 / span 1 / span 1");
  assert.equal(area(s.grid, "c"), "2 / 1 / span 1 / span 1", "place 2: second row, first column (place 1 is empty)");
  assert.equal(area(s.grid, "d"), "2 / 2 / span 1 / span 1");
  assert.equal(fillersOf(s.grid), 1, "the empty cell is a filler (it flows into place 1)");
  const A = tileEl(s.grid, "a"), C = tileEl(s.grid, "c"), D = tileEl(s.grid, "d");
  const moved = moves(s.grid, [A, C, D]);
  // e takes the empty place 1
  s.ctl.update(prog("grid4", [tileS("a", 0, "card"), tileS("e", 1, "card", { newest: true }), tileS("c", 2, "card"), tileS("d", 3, "card")], { v: 2 }));
  assert.equal(area(s.grid, "e"), "1 / 2 / span 1 / span 1");
  assert.deepEqual(idsOf(s.grid), ["a", "e", "c", "d"], "inserted at its place");
  assert.equal(fillersOf(s.grid), 0);
  // grid9 with gaps: 3 columns
  s.ctl.update(prog("grid9", [tileS("a", 0, "card"), tileS("e", 1, "card"), tileS("c", 2, "card"), tileS("d", 3, "card"), tileS("f", 7, "card")], { v: 3 }));
  assert.equal(area(s.grid, "d"), "2 / 1 / span 1 / span 1");
  assert.equal(area(s.grid, "f"), "3 / 2 / span 1 / span 1");
  assert.equal(fillersOf(s.grid), 4);
  // two on one place (a delayed view mixing places with a new pin's): the second takes the next free cell
  s.ctl.update(prog("grid9", [tileS("a", 0, "card"), tileS("p", 0, "card", { pin: true }), tileS("e", 1, "card")], { v: 4 }));
  assert.deepEqual(["a", "p", "e"].map((x) => area(s.grid, x)), ["1 / 1 / span 1 / span 1", "1 / 2 / span 1 / span 1", "1 / 3 / span 1 / span 1"]);
  assert.deepEqual(moved.filter((m) => !m.startsWith("removeChild")), [], "no existing node moved");
  // split: two cells side by side
  s.ctl.update(prog("split", [tileS("e", 0, "card"), tileS("a", 1, "card")], { v: 5 }));
  assert.deepEqual([area(s.grid, "e"), area(s.grid, "a")], ["1 / 1 / span 1 / span 1", "1 / 2 / span 1 / span 1"]);
  // the knob off again: no inline placement (the legacy CSS)
  s.ctl.update({ v: 6, layout: "split", count: 2, src: [tileS("e", 0, "card"), tileS("a", 1, "card")], still_s: 20 });
  assert.deepEqual([area(s.grid, "e"), area(s.grid, "a")], ["", ""]);
  s.ctl.stop();
});

test("1.99ahp stage-mic.js (program.stable): a back-and-forth of 2 moves nobody - dynamic keeps place order (never the main first), picture in picture's big picture is place 0; dynamic 3+: only the two trading tiles change cells", () => {
  const dyn = (src, main, extra) => Object.assign({ v: 1, layout: src.length === 2 ? "split" : "grid4", count: src.length, src, dyn: { n: src.length, t: "d" + src.length, main }, still_s: 20, stable: true }, extra || {});
  const s = dynSandbox(dyn([tileS("a", 0, "card", { ring: true }), tileS("b", 1, "card", { ring: true, newest: true })], "a"));
  const A = tileEl(s.grid, "a"), B = tileEl(s.grid, "b");
  const moved = moves(s.grid, [A, B]);
  assert.deepEqual([area(s.grid, "a"), area(s.grid, "b")], ["1 / 1 / span 1 / span 1", "1 / 2 / span 1 / span 1"]);
  // even a main the server didn't put in place 0 (an older program / a delayed view) moves nobody with 2
  for (const [v, main] of [[2, "b"], [3, "a"], [4, "b"]]) {
    s.ctl.update(dyn([tileS("a", 0, "card", { ring: true, newest: main === "a" }), tileS("b", 1, "card", { ring: true, newest: main === "b" })], main, { v }));
    assert.deepEqual([area(s.grid, "a"), area(s.grid, "b")], ["1 / 1 / span 1 / span 1", "1 / 2 / span 1 / span 1"], "v" + v + ": nobody moved");
  }
  // 3: the main in cell 0 (the big one) - the server's main trades with whoever is in place 0, b keeps its cell
  s.ctl.update(dyn([tileS("a", 0, "card"), tileS("b", 1, "card"), tileS("c", 2, "card")], "c", { v: 5 }));
  assert.equal(area(s.grid, "c"), "1 / 1 / span 2 / span 1", "c: the big cell");
  assert.equal(area(s.grid, "b"), "1 / 2 / span 1 / span 1", "b stays in its cell");
  assert.equal(area(s.grid, "a"), "2 / 2 / span 1 / span 1", "a: c's old cell");
  assert.ok(tileEl(s.grid, "c").classList.contains("main"));
  // the server's own swap (c in place 0): the same cells
  s.ctl.update(dyn([tileS("c", 0, "card"), tileS("b", 1, "card"), tileS("a", 2, "card")], "c", { v: 6 }));
  assert.deepEqual(["c", "b", "a"].map((x) => area(s.grid, x)), ["1 / 1 / span 2 / span 1", "1 / 2 / span 1 / span 1", "2 / 2 / span 1 / span 1"]);
  assert.deepEqual(moved, [], "no node moved, ever");
  s.ctl.stop();
  // picture in picture: the big picture is place 0 - the newest speaker only rings
  const pip = (newest, v) => ({ v, layout: "pip", count: 2, src: [tileS("a", 0, "card", { newest: newest === "a" }), tileS("b", 1, "card", { newest: newest === "b" })], still_s: 20, stable: true });
  const p = dynSandbox(pip("b", 1));
  for (const [nw, v] of [["b", 1], ["a", 2], ["b", 3]]) {
    if (v > 1) p.ctl.update(pip(nw, v));
    assert.ok(tileEl(p.grid, "a").classList.contains("main") && !tileEl(p.grid, "b").classList.contains("main"), "v" + v + ": a (place 0) fills the stage");
    assert.ok(tileEl(p.grid, nw).classList.contains("newest"), "the one talking is highlighted");
  }
  // without stable (an older server): today's - the newest fills the stage
  p.ctl.update(Object.assign(pip("b", 9), { stable: undefined }));
  assert.ok(tileEl(p.grid, "b").classList.contains("main"));
  p.ctl.stop();
});

test("1.99ahp stable slots: the page's cells are the capture's - stage-mic.js slotCells / CELLS / COLS equal stagemiccap's, and a stable program's grid-areas match stagemiccap.rects cell for cell (a capture is what you see)", () => {
  const { ctx } = dynSandbox({ v: 1, layout: "single", count: 0, src: [] });
  const page = ctx.PATVStageMic, cap = require(path.join(repo, "stagemiccap"));
  assert.deepEqual(JSON.parse(JSON.stringify(page._cells)), { ...cap.CELLS });
  assert.deepEqual(JSON.parse(JSON.stringify(page._cols)), { ...cap.COLS });
  const cases = [[[0, 2, 3], 4, false], [[1, 1, 5], 9, false], [[0, 4, 7, 8], 4, false], [[3, 0], 2, false], [[2, 6, 4], 9, true], [["x", -3, 70], 9, false]];
  for (const [ps, cells, dense] of cases) {
    const src = ps.map((p, i) => ({ id: "p" + i, pos: p }));
    const norm = (r) => r.map((e) => (e ? e.id : null));
    assert.deepEqual(norm(JSON.parse(JSON.stringify(page._slotCells(src, cells, dense)))), norm(cap.slotCells(src, cells, dense)), JSON.stringify([ps, cells, dense]));
  }
  // grid-areas vs rects: each tile's (row, column) on the page = its rectangle's cell in the capture
  for (const [layout, ps] of [["grid4", [0, 2, 3]], ["grid9", [0, 4, 8, 5]], ["split", [1, 0]], ["grid4", [3]]]) {
    const src = ps.map((p, i) => tileS("t" + i, p, "card"));
    const s = dynSandbox({ v: 1, layout, count: src.length, src, still_s: 20, stable: true });
    const rs = cap.rects({ layout, src: src.map((x) => ({ ...x, kind: "cam" })), stable: true });
    assert.equal(rs.length, src.length, layout);
    const cols = cap.COLS[layout], rows = layout === "grid9" ? 3 : layout === "grid4" ? 2 : 1;
    for (const r of rs) {
      const col = Math.round(r.x / (1280 / cols)) + 1, row = Math.round(r.y / (720 / rows)) + 1;
      assert.equal(area(s.grid, r.id), row + " / " + col + " / span 1 / span 1", layout + " " + r.id);
    }
    s.ctl.stop();
  }
});

test("1.99ahp review fix C2 stage-mic.js (program.stable): on the grid / side by side / single layouts the reading order (DOM order) is the cells' again - a node a picture in picture pick or a dynamic main swap left out of place moves back on the next layout; picture in picture and dynamic themselves never move a node; the same program again moves nothing", () => {
  const prog = (layout, src, extra) => Object.assign({ v: 1, layout, count: src.length, src, still_s: 20, stable: true }, extra || {});
  // the single layout with a pin (picture in picture): alice in place 0, the pin fay in place 1
  const s = dynSandbox(prog("pip", [tileS("alice", 0, "card"), tileS("fay", 1, "card", { pin: true })]));
  const A = tileEl(s.grid, "alice"), F = tileEl(s.grid, "fay");
  const moved = moves(s.grid, [A, F]);
  // the pick: fay (talking) takes place 0 - the big picture changes by the .main class, no node moves
  s.ctl.update(prog("pip", [tileS("fay", 0, "card", { pin: true, newest: true }), tileS("alice", 1, "card")], { v: 2 }));
  assert.ok(F.classList.contains("main") && !A.classList.contains("main"), "fay fills the stage");
  assert.deepEqual(moved, [], "picture in picture: no node moved");
  assert.deepEqual(idsOf(s.grid), ["alice", "fay"], "(the DOM order trails the places here)");
  // the layout becomes grid4, the same places: fay's cell is 1/1, alice's 1/2 - and the reading order follows (one move)
  s.ctl.update(prog("grid4", [tileS("fay", 0, "card", { pin: true }), tileS("alice", 1, "card")], { v: 3 }));
  assert.deepEqual([area(s.grid, "fay"), area(s.grid, "alice")], ["1 / 1 / span 1 / span 1", "1 / 2 / span 1 / span 1"]);
  assert.deepEqual(idsOf(s.grid), ["fay", "alice"], "the reading order = the cells'");
  assert.equal(moved.length, 1, "one node moved: " + moved.join(","));
  // the same program again / a back-and-forth (ring only): nothing moves
  moved.length = 0;
  s.ctl.update(prog("grid4", [tileS("fay", 0, "card", { pin: true }), tileS("alice", 1, "card", { newest: true })], { v: 4 }));
  s.ctl.update(prog("grid4", [tileS("fay", 0, "card", { pin: true, newest: true }), tileS("alice", 1, "card")], { v: 5 }));
  assert.deepEqual(moved, [], "unchanged places: no node moved");
  // a gap and a newcomer in it: inserted at its place, nobody else moves
  s.ctl.update(prog("grid4", [tileS("fay", 0, "card", { pin: true }), tileS("bob", 1, "card"), tileS("alice", 2, "card")], { v: 6 }));
  assert.deepEqual(idsOf(s.grid), ["fay", "bob", "alice"]);
  assert.deepEqual(moved, [], "existing nodes untouched");
  s.ctl.stop();
  // dynamic: a main swap never moves a node (the cells come from grid-area) - and the same on split after a dynamic swap
  const dyn = (src, main, v) => prog(src.length <= 2 ? "split" : "grid4", src, { v, dyn: { n: src.length, t: "d" + src.length, main } });
  const d = dynSandbox(dyn([tileS("a", 0, "card"), tileS("b", 1, "card"), tileS("c", 2, "card")], "a", 1));
  const DA = tileEl(d.grid, "a"), DB = tileEl(d.grid, "b"), DC = tileEl(d.grid, "c");
  const dm = moves(d.grid, [DA, DB, DC]);
  d.ctl.update(dyn([tileS("c", 0, "card"), tileS("b", 1, "card"), tileS("a", 2, "card")], "c", 2));
  assert.deepEqual(dm, [], "dynamic: no node moved");
  assert.deepEqual(idsOf(d.grid), ["a", "b", "c"]);
  // the stage leaves dynamic (grid4, the same places): the reading order is the cells' again
  d.ctl.update(prog("grid4", [tileS("c", 0, "card"), tileS("b", 1, "card"), tileS("a", 2, "card")], { v: 3 }));
  assert.deepEqual(idsOf(d.grid), ["c", "b", "a"]);
  assert.deepEqual(["c", "b", "a"].map((x) => area(d.grid, x)), ["1 / 1 / span 1 / span 1", "1 / 2 / span 1 / span 1", "2 / 1 / span 1 / span 1"]);
  d.ctl.stop();
});
