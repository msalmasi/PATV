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
  const blk = room.slice(room.indexOf("locals.webrtcCfg()) { %>"), room.indexOf("<% } %>", room.indexOf("locals.webrtcCfg()) { %>")));
  assert.match(blk, /stage-mic\.js\?v=\d+/);
  assert.equal((room.match(/stage-mic\.js/g) || []).length, 1);
  assert.equal((room.match(/PATVPadStage\.setMic\(/g) || []).length, 1);
  assert.match(room, /safe\('stagemic', function \(\) \{ if \(window\.PATVPadStage && PATVPadStage\.setMic\) PATVPadStage\.setMic\(d\.stage_program \|\| null\); \}\);/);
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
  assert.match(staff, /stage-mf-admin\.js\?v=1/);
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
  assert.match(pv, /privacy-livecam\.js\?v=5/);
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
