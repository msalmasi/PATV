// 1.99ado: the wheels draw their canvas ONCE while idle. The OBS wheel (public/publicwheel.js) used to repaint its
// 1000x1000 canvas with shadow blur every 60 ms forever ("keep the glow pulsing"); OBS's embedded Chromium grew its
// GPU process to 6.9 GB over ~2 days and the overlay crashed "Out of Memory". The gold wheel (public/script.js) had
// the same loop. Now: no timer / animation-frame loop while idle, the jackpot glow pulse is a CSS opacity animation
// on #jpGlow, and the canvas is redrawn only when something changes (config, contextrestored, resize, shown again,
// end of a spin). The spin itself still animates on requestAnimationFrame, then lands, settles and shows the result.
// Both page scripts run here in a vm with a small fake DOM, fake timers and a fake requestAnimationFrame queue.
//   NODE_PATH=G:/PATV/node_modules node --test test/wheel-idle.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

const SEGMENTS = [
  { color: "#f00", label: "100", size: 1 },
  { color: "#0f0", label: "200", size: 1 },
  { color: "#00f", label: "0", size: 1 },
  { color: "#FFD700", label: "JACKPOT", size: 0.01, jackpot: true },
];

function el(id, tag) {
  const listeners = {};
  const classes = new Set();
  const e = {
    id, tagName: tag || "div", children: [], style: {}, attrs: {}, hidden: false, textContent: "", className: "",
    offsetWidth: 0, nextSibling: null, _q: {},
    parentNode: { insertBefore() {}, removeChild() {} },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {},
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t, ev) { (listeners[t] || []).forEach((f) => f(ev || {})); },
    querySelector(sel) { return this._q[sel] || (this._q[sel] = el(null)); },
  };
  return e;
}

// Loads one wheel page script into a fresh sandbox. answers: url prefix -> JSON body.
function load(file, { answers = {}, reduceMotion = false, pathname = "/g/wheel" } = {}) {
  // canvas 2D context: counts every call; a draw = one clearRect. Records shadowBlur values.
  const calls = {};
  const blurs = [];
  const transforms = [];
  const props = {};
  const ctx = new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k];
      return (...a) => { calls[k] = (calls[k] || 0) + 1; if (k === "setTransform") transforms.push(a); };
    },
    set(t, k, v) { t[k] = v; if (k === "shadowBlur") blurs.push(v); return true; },
  });
  const canvas = Object.assign(el("wheelCanvas", "canvas"), { width: 500, height: 500, getContext: () => ctx });
  const container = el(null);
  const els = { wheelCanvas: canvas };
  const docListeners = {};
  const document = {
    hidden: false,
    head: el("head"), body: el("body"),
    getElementById: (id) => els[id] || (els[id] = el(id)),
    querySelector: (sel) => (sel === ".wheel-container" ? container : el(null)),
    createElement: (tag) => el(null, tag),
    createTextNode: (text) => ({ textContent: String(text) }),
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    fire(t) { (docListeners[t] || []).forEach((f) => f({})); },
    dispatchEvent() { return true; },
  };

  // fake clock: setTimeout / setInterval run only when advance() passes their time
  let now = 0, seq = 0;
  const timers = new Map();
  const intervals = [];
  const winListeners = {};
  const rafQ = [];
  const fetches = [];
  const sources = [];
  class FakeES { constructor(url) { this.url = url; this.readyState = 1; sources.push(this); } close() {} }
  FakeES.CLOSED = 2;
  const answer = (url) => {
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    return key ? answers[key] : {};
  };

  const sandbox = {
    document, console: { log() {}, error() {}, warn() {} }, alert() {},
    Audio: function () { return { pause() {}, play() { return Promise.resolve(); }, currentTime: 0 }; },
    EventSource: FakeES,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    matchMedia: () => ({ matches: reduceMotion }),
    location: { pathname, reload() {} },
    addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
    requestAnimationFrame(f) { rafQ.push(f); return rafQ.length; },
    setTimeout(f, ms) { const id = ++seq; timers.set(id, { f, at: now + (ms || 0), every: 0 }); return id; },
    setInterval(f, ms) { const id = ++seq; intervals.push(ms); timers.set(id, { f, at: now + ms, every: ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
    fetch(url, opts) {
      fetches.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      const body = answer(url);
      return Promise.resolve({ ok: true, status: 200, redirected: false, url,
                               headers: { get: () => "application/json" }, json: () => Promise.resolve(body) });
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("public", file), sandbox, { filename: file });

  const h = {
    sandbox, canvas, container, document, calls, blurs, transforms, intervals, rafQ, fetches, sources, winListeners,
    draws: () => calls.clearRect || 0,
    get: (expr) => vm.runInContext(expr, sandbox),
    glow: () => container.children.find((c) => c.id === "jpGlow"),
    timersPending: () => timers.size,
    // run due timers (repeating intervals) up to now + ms
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.f();
      }
      now = end;
    },
    // run the queued animation frames once (each may queue the next)
    frame(ts) { const q = rafQ.splice(0); q.forEach((f) => f(ts)); return q.length; },
  };
  return h;
}

// the jackpot slice's mid angle on the canvas for a given wheel angle
function jackpotMid(segments, currentAngle) {
  const total = segments.reduce((a, s) => a + s.size, 0);
  let a0 = currentAngle;
  for (const s of segments) {
    const a1 = a0 + (s.size / total) * 2 * Math.PI;
    if (s.jackpot) return (a0 + a1) / 2;
    a0 = a1;
  }
  return null;
}
const glowAngle = (g) => Number(/^rotate\((-?[\d.e+-]+)rad\)$/.exec(g.style.transform)[1]);

// Lets the page sit idle: 10 minutes of timers + any queued frames. Returns how many draws happened.
async function idle(h, minutes = 10) {
  const before = h.draws();
  for (let i = 0; i < minutes * 60; i++) {
    h.advance(1000);
    h.frame(1e6 + i * 1000);
    if (i % 60 === 0) await flush();
  }
  await flush();
  return h.draws() - before;
}

// ─── the OBS wheel (public/publicwheel.js) ───
const OBS_ANSWERS = {
  "/api/wheel/config": { segments: SEGMENTS },
  "/api/jackpot": { jackpotTotal: 123456, wheelJackpot: 100000 },
  "/api/g/acknowledge-spin": { success: true, message: "public spinid S1 from bob", targetIndex: 1, spinner: { display: "Bob", nameCss: "" } },
  "/api/wheel/settle": { result: 220 },
};

test("OBS wheel: idle schedules no periodic redraw - drawn on load + config, then nothing for 10 minutes", async () => {
  const h = load("publicwheel.js", { answers: OBS_ANSWERS });
  await flush();
  assert.equal(h.draws(), 2, "the first draw + the server's slice table");
  assert.deepEqual(h.intervals, [5000], "the only timer is the 5 s jackpot refresh (no 60 ms redraw loop)");
  assert.equal(h.rafQ.length, 0, "no animation frame queued while idle");
  assert.equal(await idle(h), 0, "not one canvas repaint while idle");
  assert.equal(h.rafQ.length, 0, "still no animation frame queued");
  assert.ok(h.fetches.filter((f) => f.url === "/api/jackpot").length >= 100, "the jackpot refresh still runs (and draws nothing)");
  assert.ok(h.blurs.length > 0 && h.blurs.every((b) => b === 12), "idle draws use the steady base glow (pulse 0)");
  assert.deepEqual(h.transforms[0], [2, 0, 0, 2, 0, 0], "every draw still applies the 2x HiDPI transform first (1.99gr)");
});

test("OBS wheel: the glow pulse is the #jpGlow CSS ray, laid over the jackpot slice", async () => {
  const h = load("publicwheel.js", { answers: OBS_ANSWERS });
  await flush();
  const g = h.glow();
  assert.ok(g, "#jpGlow is in the wheel container");
  assert.equal(g.attrs["aria-hidden"], "true");
  assert.equal(g.hidden, false, "shown while idle");
  const want = jackpotMid(SEGMENTS, h.get("currentAngle"));
  assert.ok(Math.abs(glowAngle(g) - want) < 1e-9, `rotated onto the jackpot slice (${glowAngle(g)} vs ${want})`);

  // a slice table without a jackpot slice hides it
  vm.runInContext("segments = segments.filter(s => !s.jackpot); drawWheel();", h.sandbox);
  assert.equal(h.glow().hidden, true, "no jackpot slice, no glow");
});

test("OBS wheel: redraws once on contextrestored / resize / shown again - never a loop", async () => {
  const h = load("publicwheel.js", { answers: OBS_ANSWERS });
  await flush();
  let d = h.draws();
  h.canvas.fire("contextrestored");
  assert.equal(h.draws(), d + 1, "contextrestored redraws (1.99gr)");
  assert.deepEqual(h.transforms[h.transforms.length - 1], [2, 0, 0, 2, 0, 0], "with the 2x transform re-applied");

  d = h.draws();
  for (let i = 0; i < 5; i++) h.winListeners.resize.forEach((f) => f({}));
  assert.equal(h.rafQ.length, 1, "a burst of resizes queues ONE frame");
  h.frame(1);
  assert.equal(h.draws(), d + 1, "...and one redraw");
  assert.equal(h.frame(2), 0, "which does not queue another");

  d = h.draws();
  h.document.hidden = true; h.document.fire("visibilitychange");
  assert.equal(h.rafQ.length, 0, "hidden: nothing");
  h.document.hidden = false; h.document.fire("visibilitychange");
  h.frame(3);
  assert.equal(h.draws(), d + 1, "shown again: one redraw");
  assert.equal(await idle(h, 2), 0, "then idle again");
});

test("OBS wheel: a spin still animates every frame, hides the CSS glow, lands, redraws once, settles, shows the result", async () => {
  const h = load("publicwheel.js", { answers: OBS_ANSWERS });
  await flush();
  // the SSE spin flow: request -> acknowledge -> spinWheel(server's targetIndex)
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].url, "/events?type=spin&identifier=public");
  h.sources[0].onmessage({ data: JSON.stringify({ message: "Spin Request", spinId: "S1" }) });
  await flush();
  assert.deepEqual(h.fetches.find((f) => f.url === "/api/g/acknowledge-spin").body, { spinId: "S1" });
  assert.equal(h.get("isSpinning"), true);
  assert.equal(h.document.getElementById("wheelFrame").classList.contains("spinning"), true, "the bulbs chase");
  assert.equal(h.document.getElementById("spinnerName").textContent, "Bob");

  const before = h.draws();
  let frames = 0, ts = 1000;
  while (h.rafQ.length) {
    h.frame(ts); ts += 16; frames++;
    if (h.rafQ.length) assert.equal(h.glow().hidden, true, "the CSS glow is hidden while the wheel moves");
    assert.ok(frames < 1000, "the spin ends");
  }
  assert.ok(frames >= 6000 / 16, `~6 s of frames (${frames})`);
  assert.equal(h.draws() - before, frames + 1, "one draw per frame + the final landing draw");
  assert.ok(h.blurs.slice(-frames).every((b) => b >= 12 && b <= 26), "the canvas pulses the glow itself while spinning");
  assert.equal(h.get("isSpinning"), true, "still 'spinning' for the 500 ms settle pause");

  const landed = h.draws();
  h.advance(500);
  assert.equal(h.get("isSpinning"), false);
  assert.equal(h.draws(), landed + 1, "back to idle: ONE redraw");
  const g = h.glow();
  assert.equal(g.hidden, false, "the CSS glow is back...");
  const want = jackpotMid(h.get("segments"), h.get("currentAngle"));
  assert.ok(Math.abs(glowAngle(g) - want) < 1e-9, "...over the slice where the wheel landed");
  // the wheel landed on the server's slice (index 1) under the arrow (3pi/2)
  const ca = h.get("currentAngle"), total = SEGMENTS.reduce((a, s) => a + s.size, 0);
  const mid1 = ca + ((1 + 0.5) / total) * 2 * Math.PI;
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  assert.ok(Math.abs(norm(mid1) - 3 * Math.PI / 2) < 1e-9, "landed on targetIndex 1");

  await flush();
  assert.deepEqual(h.fetches.find((f) => f.url === "/api/wheel/settle").body, { spinId: "S1" });
  const rc = h.document.getElementById("resultContainer");
  assert.equal(rc.style.display, "flex", "the winner banner shows");
  assert.equal(h.document.getElementById("resultText").textContent, (220).toLocaleString());
  assert.equal(h.document.getElementById("wheelFrame").classList.contains("won"), true);
  h.advance(44000);
  assert.equal(rc.style.display, "flex", "the banner is still up inside its 45 s");
  h.advance(1000);
  assert.equal(rc.style.display, "none", "the banner hides after 45 s");
  assert.equal(h.document.getElementById("wheelFrame").classList.contains("won"), false, "the frame is back to idle");
  assert.equal(await idle(h, 2), 0, "and once settled the canvas is left alone again");
  assert.deepEqual(h.intervals, [5000], "no timer was added by the spin");
});

// ─── the gold wheel (public/script.js) ───
const GOLD_ANSWERS = {
  "/api/u/bob/level": { level: 5, xp: 100 },
  "/api/u/bob/balance": { balance: 50000 },
  "/api/wheel/config": { segments: SEGMENTS },
  "/api/jackpot": { jackpotTotal: 1000 },
  "/api/u/acknowledge-spin": { success: true, targetIndex: 2 },
  "/api/wheel/settle": { result: 0, xp: 10 },
};

test("gold wheel: idle schedules no periodic redraw; a spin still animates and lands; the glow is CSS", async () => {
  const h = load("script.js", { answers: GOLD_ANSWERS, pathname: "/u/bob/wheel" });
  await flush();
  assert.equal(h.draws(), 2, "drawn for the level + the server's slice table");
  assert.deepEqual(h.intervals, [30000], "the only timer is the 30 s jackpot refresh");
  assert.equal(h.rafQ.length, 0);
  assert.equal(await idle(h), 0, "not one canvas repaint while idle");
  assert.ok(h.blurs.every((b) => b === 12), "steady base glow while idle");
  const g = h.glow();
  assert.ok(g && g.hidden === false, "#jpGlow is shown over the slice");
  assert.ok(Math.abs(glowAngle(g) - jackpotMid(SEGMENTS, h.get("currentAngle"))) < 1e-9);

  let d = h.draws();
  h.canvas.fire("contextrestored");
  assert.equal(h.draws(), d + 1, "a restored 2D context is redrawn (the idle loop used to do it)");

  h.sources[0].onmessage({ data: JSON.stringify({ message: "Spin Request", spinId: "G1" }) });
  await flush();
  assert.equal(h.get("isSpinning"), true);
  d = h.draws();
  let frames = 0, ts = 0;
  while (h.rafQ.length) { h.frame(ts); ts += 16; frames++; if (h.rafQ.length) assert.equal(h.glow().hidden, true); assert.ok(frames < 1000); }
  assert.equal(h.draws() - d, frames + 1, "one draw per frame + the landing draw");
  const landed = h.draws();
  h.advance(500);
  assert.equal(h.get("isSpinning"), false);
  assert.equal(h.draws(), landed + 1, "one idle redraw after landing");
  assert.equal(h.glow().hidden, false);
  await flush();
  assert.deepEqual(h.fetches.find((f) => f.url === "/api/wheel/settle").body, { spinId: "G1" });
  assert.equal(await idle(h, 2), 0, "idle again: no repaints");
  assert.deepEqual(h.intervals, [30000]);
});

test("gold wheel, reduced motion: full static canvas glow, no CSS ray, no loop", async () => {
  const h = load("script.js", { answers: GOLD_ANSWERS, pathname: "/u/bob/wheel", reduceMotion: true });
  await flush();
  assert.ok(h.blurs.length && h.blurs.every((b) => b === 26), "pulse 1 = the full glow, as before");
  assert.equal(h.glow().hidden, true, "no pulsing ray");
  assert.equal(await idle(h, 2), 0);
});

// ─── static: sources, styles, cache-busters ───
test("no idle redraw timer left in either wheel; the glow keyframes animate opacity only; cache-busters bumped", () => {
  for (const f of ["publicwheel.js", "script.js"]) {
    const src = read("public", f);
    assert.doesNotMatch(src, /setInterval\([^;]*drawWheel/, `${f}: no setInterval redraw`);
    assert.match(src, /canvas\.addEventListener\('contextrestored', \(\) => drawWheel\(\)\)/, `${f}: contextrestored redraw`);
    assert.match(src, /jpGlow\.id = 'jpGlow'/);
  }
  for (const [f, kf] of [["obs-wheel.css", "ow-jpglow"], ["arcade-wheel.css", "aw-jpglow"]]) {
    const css = read("public", "css", f);
    assert.match(css, new RegExp(`#jpGlow \\{[^}]*animation: ${kf} \\.785s ease-in-out infinite alternate`), `${f}: the pulse`);
    assert.match(css, /#jpGlow\[hidden\] \{ display: none; \}/);
    const body = new RegExp(`@keyframes ${kf} \\{([^\\n]*)\\}`).exec(css)[1];
    assert.deepEqual([...new Set(body.match(/[a-z-]+(?=:)/g))], ["opacity"], `${f}: compositor-only keyframes`);
  }
  const pw = read("views", "publicwheel.ejs");
  assert.match(pw, /\/public\/publicwheel\.js\?v=ow4"/);
  assert.match(pw, /\/public\/css\/obs-wheel\.css\?v=ow2"/);
  const gw = read("views", "wheel.ejs");
  assert.match(gw, /\/public\/script\.js\?v=aw2"/);
  assert.match(gw, /\/public\/css\/arcade-wheel\.css\?v=aw4"/);
  assert.match(read("views", "home.ejs"), /\/public\/css\/arcade-wheel\.css\?v=aw4"/);
});
