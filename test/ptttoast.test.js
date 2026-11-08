"use strict";
// 1.99?? ptttoast (owner 2026-11-08, a screenshot of Pepe's Pad: "slow down — one every 15s" and "🎙 your clip: played" as plain text under
// the composer's tool row): "These mic related messages show up in this spot below the toolbar, they should show up the same way the other
// stuff does as the modal that auto-dismisses. Make sure the other status messages like "recording is empty" also dont show up here."
// In the Room Dock every push-to-talk line (the recorder's, the upload's refusals, the clip's progress) and the relay's own notes
// (queue full, offline) are the chat card's auto-dismissing notices - pad-dock.js chatToast, the one the command acknowledgements use
// (1.99ajq dockpol item 22): same look, place, timing (3 s done / 8 s a refusal / 30 s on its way) and stack (at most two passing ones).
// One press = one notice, updated in place from "opening the microphone…" to "your clip: played". The classic layout keeps its lines.
//   node --test test/ptttoast.test.js
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { harness, Event, Document } = require("./fixtures/pad-dock/dom.cjs");
const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
// (review F4) how long a clip's progress notice stays up at most: the site settles every clip well inside it (bridge-relay.js)
const CLIP_OPEN_MS = 10 * 60 * 1000;

// room-bridge.js in a deterministic page: a fake recorder, the mic, a clock the test moves, uploads answered from a queue
function client(o = {}) {
  const doc = new Document(), clock = { t: 1000000 }, timers = [], fetches = [];
  class Target { constructor() { this.l = {}; } addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); } removeEventListener() {} dispatchEvent() { return true; } }
  const win = new Target();
  Object.assign(win, { document: doc });
  doc.defaultView = win;
  class FakeDate extends Date { static now() { return clock.t; } }
  win.MediaRecorder = class {
    constructor(s) { this.stream = s; this.state = "inactive"; this.mimeType = "audio/webm"; }
    static isTypeSupported(t) { return t === "audio/webm"; }
    start() { this.state = "recording"; } stop() { this.state = "inactive"; if (this.onstop) this.onstop(); }
  };
  const answers = (o.answers || []).slice();
  const mic = { allow: o.deny ? false : true };
  const ctx = {
    window: win, document: doc, console,
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0,
      mediaDevices: { getUserMedia: () => mic.allow ? Promise.resolve({ getTracks: () => [{ stop() {} }] }) : Promise.reject(new Error("NotAllowedError")) } },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    fetch: (url, init) => {
      fetches.push({ url, init });
      const a = answers.length ? answers.shift() : { status: 200, body: { ok: true, id: "j1" } };
      if (a === "hang") return new Promise(() => {});
      if (a === "offline") return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve({ status: a.status || 200, ok: (a.status || 200) < 400, json: () => a.html ? Promise.reject(new SyntaxError("<")) : Promise.resolve(a.body) });
    },
    Blob: class { constructor(p, b) { this.type = b.type; } },
    CustomEvent: Event, Date: FakeDate, JSON, Math, Number, String, Object, Array, Promise, isFinite, Uint8Array,
  };
  win.fetch = ctx.fetch; ctx.MediaRecorder = win.MediaRecorder;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8"), ctx);
  return { PATV: win.PATVRoom, doc, win, clock, timers, fetches, answers, mic };
}
// a push-to-talk box in that page; toasts = what it handed the Dock's notices ({text, id, ms, bad})
function pttRig(o = {}) {
  const c = client(o);
  const host = c.doc.createElement("div"); c.doc.body.appendChild(host);
  const p = c.PATV.ptt(host, "pepes-pad");
  const toasts = [];
  if (o.toast !== false) {
    assert.equal(typeof p.useToast, "function", "PATVRoom.ptt(...).useToast(fn): the Dock hands it its chat notices");
    p.useToast((text, opts) => { toasts.push(Object.assign({ text: String(text == null ? "" : text) }, opts || {})); return null; });
  }
  p.update({ room: { micRelay: true, pttMax: 30 }, mine: o.mine || [] });      // (the page's first live view)
  const box = host.querySelector(".rb-ptt"), btn = host.querySelector(".rb-talk"), txt = host.querySelector(".rb-ptt-txt"), mine = host.querySelector(".rb-mine");
  const press = async () => { btn.dispatchEvent(new Event("keydown", { key: "Enter" })); await flush(); };
  // hold for `secs`, then tap again to send (a tap starts tap mode)
  const clip = async (secs) => { await press(); c.clock.t += secs * 1000; await press(); await flush(); };
  return Object.assign(c, { host, p, toasts, box, btn, txt, mine, press, clip });
}

test("ptttoast: in the Dock the recorder's lines are ONE notice per press, updated in place - nothing is written under the tool row", async () => {
  const r = pttRig();
  assert.ok(r.txt.classList.contains("rb-hide") && r.mine.classList.contains("rb-hide"), "the line under the composer is gone (rb-hide), not just empty");
  const idle = r.txt.textContent;
  await r.press();
  assert.deepEqual(r.toasts.map((t) => t.text), ["🎙 opening the microphone…", "🎙 recording…"]);
  const id = r.toasts[0].id;
  assert.ok(id && r.toasts.every((t) => t.id === id), "one notice for the press: " + JSON.stringify(r.toasts.map((t) => t.id)));
  assert.ok(r.toasts.every((t) => !t.bad), "progress is no refusal");
  assert.equal(r.toasts[0].ms, 30000, "on its way: 30 s, like a command waiting for Pepe");
  assert.ok(r.toasts[1].ms >= 35000, "recording: it stays while the clip can last (30 s + 5): " + r.toasts[1].ms);
  r.clock.t += 300; await r.press(); await flush();
  const last = r.toasts.at(-1);
  assert.equal(last.text, "🎙 too short — hold the button while you talk");
  assert.equal(last.id, id, "the same notice"); assert.equal(last.bad, true); assert.equal(last.ms, 8000, "a refusal stays 8 s");
  assert.equal(r.fetches.length, 0, "too short: never sent");
  assert.equal(r.txt.textContent, idle, "the inline line never changed"); assert.ok(r.txt.classList.contains("rb-ptt-idle"));
  assert.equal(r.mine.textContent, "");
  // the next press is its own notice
  await r.press();
  assert.notEqual(r.toasts.at(-1).id, id, "a new press, a new notice");
});

test("ptttoast: the site's refusals are notices - slow down, the recording is empty, too long, too big, signed out, unreachable - never the inline line", async () => {
  const cases = [
    [{ status: 429, body: { ok: false, code: "rate", error: "slow down — one every 15s" } }, "🎙 slow down — one every 15s"],
    [{ status: 429, body: { ok: false, code: "rate", error: "slow down — 12 clips per 10 min, played or not" } }, "🎙 slow down — 12 clips per 10 min, played or not"],
    [{ status: 400, body: { ok: false, error: "That recording is empty." } }, "🎙 That recording is empty."],
    [{ status: 400, body: { ok: false, code: "too_long", max: 30, error: "Keep it under 30 seconds." } }, "🎙 Keep it under 30 seconds."],
    [{ status: 413, html: true }, "🎙 that recording is too big — try a shorter one"],
    [{ status: 401, body: { ok: false, error: "Sign in first." } }, "🎙 Sign in first."],
    [{ status: 403, body: { ok: false, error: "Link your Camfrog name first: type !verify in a Camfrog room with Pepe." } }, "🎙 Link your Camfrog name first: type !verify in a Camfrog room with Pepe."],
    [{ status: 400, body: { ok: false } }, "🎙 not sent"],
    ["offline", "🎙 couldn't reach the site"],
  ];
  for (const [answer, words] of cases) {
    const r = pttRig({ answers: [answer] });
    const idle = r.txt.textContent;
    await r.clip(4);
    assert.equal(r.fetches.length, 1, words + ": uploaded");
    const last = r.toasts.at(-1);
    assert.equal(last.text, words);
    assert.equal(last.bad, true, words + ": a refusal"); assert.equal(last.ms, 8000);
    assert.ok(r.toasts.every((t) => t.id === last.id), words + ": the press's own notice, from opening to the refusal");
    assert.ok(r.toasts.some((t) => t.text === "🎙 sending 4s…"), "sending is shown on the way");
    assert.equal(r.txt.textContent, idle, words + ": nothing under the composer"); assert.equal(r.mine.textContent, "");
  }
  // the browser said no to the mic / can't record at all
  const d = pttRig({ deny: true });
  await d.press();
  assert.equal(d.toasts.at(-1).text, "🎙 the browser didn't allow the microphone"); assert.equal(d.toasts.at(-1).bad, true);
  // a press that ended while the browser was still opening the mic: "keep holding" is said, and a cancelled one takes its notice down
  const k = pttRig();
  k.btn.dispatchEvent(new Event("pointerdown", { preventDefault() {} }));
  k.clock.t += 800; k.btn.dispatchEvent(new Event("pointerup")); await flush();
  assert.equal(k.toasts.at(-1).text, "🎙 keep holding until it says Recording, then talk"); assert.equal(k.toasts.at(-1).bad, true);
  const h = pttRig();
  h.btn.dispatchEvent(new Event("pointerdown", { preventDefault() {} }));
  h.p.update({ room: { micRelay: false }, mine: [] });           // the room stopped taking clips while the mic opened
  await flush();
  assert.deepEqual(h.toasts.at(-1), { text: "", id: h.toasts[0].id }, "a press that came to nothing: its notice goes ('' = take it down)");
});

test("ptttoast: a clip's progress updates the SAME notice - sent -> waiting for Pepe -> queued -> waiting -> playing -> played (3 s); a dropped / refunded clip is a refusal (8 s)", async () => {
  const r = pttRig({ answers: [{ status: 200, body: { ok: true, id: "j7" } }, { status: 200, body: { ok: true, id: "j8" } }] });
  await r.clip(5);
  const id = r.toasts[0].id;
  assert.equal(r.toasts.at(-1).text, "🎙 sent — Pepe plays it when the mic is free"); assert.equal(r.toasts.at(-1).ms, 30000);
  const room = { micRelay: true, pttMax: 30 };
  const step = (job) => r.p.update({ room, mine: [{ kind: "say", id: "s1", state: "done", ok: true }, Object.assign({ kind: "clip", id: "j7", at: 5 }, job)] });
  const seen = [];
  for (const [job, words] of [
    [{ state: "pending" }, "🎙 your clip: sent — waiting for Pepe…"],
    [{ state: "queued", ok: true, msg: "queued" }, "🎙 your clip: queued for the mic…"],
    [{ state: "waiting", ok: true, msg: "waiting" }, "🎙 your clip: waiting for the mic…"],
    [{ state: "playing", ok: true, msg: "playing" }, "🎙 your clip: playing on the mic now"],
  ]) {
    step(job); const t = r.toasts.at(-1); seen.push(t.text);
    assert.equal(t.text, words); assert.equal(t.id, id, words + ": the press's notice"); assert.ok(!t.bad);
    // (review F4: a clip's progress stays up until its next state - the site settles every clip (bridge-relay.js clipOpenUntil) - not 30 s)
    assert.equal(t.ms, CLIP_OPEN_MS, words + ": up until the next state"); assert.equal(t.busy, true, words + ": progress (review F2)");
  }
  const n = r.toasts.length;
  step({ state: "playing", ok: true, msg: "playing" });
  assert.equal(r.toasts.length, n, "no change, no notice");
  step({ state: "done", ok: true, msg: "played" });
  assert.deepEqual(r.toasts.at(-1), { text: "🎙 your clip: played", id, ms: 3000, bad: false });
  assert.ok(r.toasts.every((t) => t.id === id), "one notice for the whole clip");
  assert.equal(r.mine.textContent, "", "the clip line is never drawn under the composer");
  // the next clip didn't play: Pepe couldn't get the mic here - it didn't count (the site gave the clip back) - a refusal, its own notice
  await r.clip(3);
  const id2 = r.toasts.at(-1).id; assert.notEqual(id2, id);
  r.p.update({ room, mine: [{ kind: "clip", id: "j7", at: 5, state: "done", ok: true, msg: "played" }, { kind: "clip", id: "j8", at: 9, state: "done", ok: false, code: "mic_later", msg: "" }] });
  assert.deepEqual(r.toasts.at(-1), { text: "🎙 your clip: Pepe can’t get the mic here right now — it didn’t count toward your limit", id: id2, ms: 8000, bad: true });
  // an older Pepe's own words for a dropped clip
  r.p.update({ room, mine: [{ kind: "clip", id: "j8", at: 9, state: "done", ok: false, msg: "dropped: the mic stayed busy" }] });
  assert.equal(r.toasts.at(-1).text, "🎙 your clip: couldn’t get the mic, try again"); assert.equal(r.toasts.at(-1).id, id2);
});

test("ptttoast: a clip finished before the page (or before the Dock took over) is not news; one still on its way shows in its own notice", () => {
  const room = { micRelay: true, pttMax: 30 };
  const old = { kind: "clip", id: "old", at: 1, state: "done", ok: true, msg: "played" };
  let r = pttRig({ mine: [old] });
  assert.equal(r.toasts.length, 0, "played before this page: no notice");
  r.p.update({ room, mine: [old, { kind: "clip", id: "j2", at: 2, state: "queued", ok: true }] });
  assert.equal(r.toasts.length, 1); assert.equal(r.toasts[0].text, "🎙 your clip: queued for the mic…");
  assert.ok(r.toasts[0].id, "a clip from another tab gets its own notice");
  // one that finished between two views is news
  r.p.update({ room, mine: [old, { kind: "clip", id: "j2", at: 2, state: "queued", ok: true }, { kind: "clip", id: "j5", at: 5, state: "done", ok: true, msg: "played" }] });
  assert.equal(r.toasts.at(-1).text, "🎙 your clip: played"); assert.notEqual(r.toasts.at(-1).id, r.toasts[0].id, "each clip its own notice");
  // a clip on its way when the page opens is shown
  r = pttRig({ mine: [{ kind: "clip", id: "j3", at: 3, state: "playing", ok: true }] });
  assert.equal(r.toasts.length, 1); assert.equal(r.toasts[0].text, "🎙 your clip: playing on the mic now");
  // the classic line first, then the Dock: what the line showed is not said again, and the line goes
  r = pttRig({ toast: false, mine: [{ kind: "clip", id: "j4", at: 4, state: "done", ok: true, msg: "played" }] });
  assert.equal(r.mine.textContent, "🎙 your clip: played", "classic layout: the line under the button, as before");
  const got = []; r.p.useToast((text, o) => got.push(Object.assign({ text }, o)));
  assert.equal(r.mine.textContent, ""); assert.ok(r.mine.classList.contains("rb-hide"));
  r.p.update({ room, mine: [{ kind: "clip", id: "j4", at: 4, state: "done", ok: true, msg: "played" }, { kind: "say", id: "s9", state: "pending" }] });
  assert.equal(got.length, 0, "already shown: not news");
});

test("ptttoast: the classic layout (no Dock) keeps its lines beside the button", async () => {
  const r = pttRig({ toast: false, answers: [{ status: 429, body: { ok: false, code: "rate", error: "slow down — one every 15s" } }] });
  assert.ok(!r.txt.classList.contains("rb-hide"));
  await r.clip(4);
  assert.equal(r.txt.textContent, "slow down — one every 15s");
  assert.equal(r.toasts.length, 0);
});

// ── the relay's own notes ──
function relayRig(o = {}) {
  const c = client(o);
  const host = c.doc.createElement("div"); c.doc.body.appendChild(host);
  const feed = c.doc.createElement("div"); c.doc.body.appendChild(feed);
  const R = c.PATV.relay(host, "pepes-pad", { feed, onCmd() {} });
  const toasts = [];
  assert.equal(typeof R.useToast, "function", "PATVRoom.relay(...).useToast(fn)");
  R.useToast((text, opts) => { toasts.push(Object.assign({ text: String(text == null ? "" : text) }, opts || {})); return null; });
  R.update({ room: { relay: true, cmds: {} }, mine: [] });
  const run = async () => { for (let i = 0; i < 4; i++) { const due = c.timers.filter((t) => !t.cleared && !t.ran && t.ms >= 1000 && t.ms <= 15000); due.forEach((t) => { t.ran = true; t.fn(); }); await flush(); } };
  return Object.assign(c, { host, R, toasts, note: host.querySelector(".rb-note"), off: host.querySelector(".rb-offline"), run });
}
test("ptttoast: the relay's notes in the Dock - 'wait a moment' and 'you're offline' are notices, offline taken down when the site answers again", async () => {
  let r = relayRig({ answers: ["hang"] });
  assert.ok(r.note.classList.contains("rb-hide") && r.off.classList.contains("rb-hide"), "the lines under the tool row are gone");
  for (let i = 0; i < 5; i++) assert.equal(r.R._send("line " + i), true);
  assert.equal(r.R._send("one too many"), false, "the outbox is full");
  assert.deepEqual(r.toasts.at(-1), { text: "Wait a moment — 5 messages are already on their way.", id: "rb-note", ms: 6000, bad: true });
  assert.ok(r.note.classList.contains("hide") || r.note.textContent === "", "never written inline");
  // the connection drops: one notice for the whole outage (every retry is no news), gone when a send gets through
  r = relayRig({ answers: ["offline", "offline", { status: 200, body: { ok: true, id: "s1" } }] });
  r.R._send("hello"); await flush();
  const offline = r.toasts.filter((t) => t.id === "rb-offline");
  assert.equal(offline.length, 1); assert.equal(offline[0].text, "You're offline — your messages will send when the connection is back.");
  // (review F3: the outage is a state - the notice stays until the site answers again, never pushed out; not an 8 s notice)
  assert.equal(offline[0].bad, true); assert.equal(offline[0].sticky, true); assert.equal(offline[0].ms, undefined);
  await r.run();
  assert.equal(r.fetches.length, 3, "retried until it went");
  const off2 = r.toasts.filter((t) => t.id === "rb-offline");
  assert.equal(off2.length, 2, "said once, then taken down: " + JSON.stringify(off2)); assert.deepEqual(off2[1], { text: "", id: "rb-offline" });
  assert.ok(r.off.classList.contains("rb-hide"));
});

// ── the Dock's side (pad-dock.js) ──
test("ptttoast (pad-dock.js): the Dock hands its chat notices to push-to-talk and the relay; '' takes one down; never an empty notice", () => {
  let pt = null, rt = null, D0 = null; const pttCalls = [];
  const ptt = { adopt() {}, onRecording() {}, useToast(f) { pttCalls.push(f); pt = f; } };
  const relay = { getInput: () => D0.querySelector("#rmRelay input"), sendCmd() {}, insert: (t) => t, useToast(f) { rt = f; } };
  const h = harness({ setup: (p) => { D0 = p.doc; }, opts: { ptt, relay } });
  assert.equal(typeof pt, "function", "push-to-talk got the Dock's notices"); assert.equal(typeof rt, "function", "the relay too");
  const notes = () => h.doc.querySelectorAll(".rmd-log > .rmd-toasts .rmd-ct");
  pt("🎙 recording…", { id: "ptt:p1", ms: 35000 });
  assert.equal(notes().length, 1); assert.match(notes()[0].textContent, /🎙 recording…/);
  pt("🎙 your clip: played", { id: "ptt:p1", ms: 3000, bad: false });
  assert.equal(notes().length, 1, "the same notice, in place"); assert.match(notes()[0].textContent, /🎙 your clip: played/);
  pt("", { id: "ptt:p1" });
  assert.equal(notes().length, 0, "'' takes it down");
  pt("🎙 slow down — one every 15s", { id: "ptt:p2", ms: 8000, bad: true });
  assert.ok(notes()[0].classList.contains("rmd-ct-bad"), "a refusal looks like a command's refusal");
  h.tick();
  assert.equal(notes().length, 0, "it goes by itself");
  const sr = h.doc.querySelector(".rmd-log > .rmd-toasts-sr");
  assert.match(sr.textContent, /slow down — one every 15s/, "announced (the polite status region)");
  assert.equal(pt("", { id: "nothing-here" }), null);
  assert.equal(notes().length, 0); assert.equal(h.doc.querySelectorAll(".ds-toast").length, 0, "no empty notice anywhere");
  rt("Wait a moment — 5 messages are already on their way.", { id: "rb-note", ms: 6000, bad: true });
  assert.equal(notes().length, 1);
  h.controller.destroy();
  assert.equal(pttCalls.at(-1), null, "a Dock that's gone hands the lines back");
});

// ── review fixes (F1-F4) ──
test("ptttoast review F2 (room-bridge.js): progress carries busy - the Dock knows a step on the way from a finished one", async () => {
  const r = pttRig({ answers: [{ status: 200, body: { ok: true, id: "j1" } }] });
  await r.clip(4);
  const by = (re) => r.toasts.filter((t) => re.test(t.text));
  const steps = [...by(/opening the microphone/), ...by(/recording…/), ...by(/sending 4s/), ...by(/^🎙 sent — /)];
  assert.equal(steps.length, 4, JSON.stringify(r.toasts));
  for (const t of steps) assert.equal(t.busy, true, t.text);
  const room = { micRelay: true, pttMax: 30 };
  r.p.update({ room, mine: [{ kind: "clip", id: "j1", at: 5, state: "done", ok: true, msg: "played" }] });
  assert.equal(r.toasts.at(-1).text, "🎙 your clip: played"); assert.equal(r.toasts.at(-1).busy, undefined, "a finished step is no progress");
  const s = pttRig({ answers: [{ status: 429, body: { ok: false, code: "rate", error: "slow down — one every 15s" } }] });
  await s.clip(4);
  assert.equal(s.toasts.at(-1).bad, true); assert.equal(s.toasts.at(-1).busy, undefined, "a refusal is no progress");
});

test("ptttoast review F2 (pad-dock.js): a notice closed with its ✕ stays closed - its later progress and finished steps are quiet, only a refusal shows; '' frees the id", () => {
  let pt = null, rt = null, D0 = null;
  const ptt = { adopt() {}, onRecording() {}, useToast(f) { if (f) pt = f; } };
  const relay = { getInput: () => D0.querySelector("#rmRelay input"), sendCmd() {}, insert: (t) => t, useToast(f) { if (f) rt = f; } };
  const h = harness({ setup: (p) => { D0 = p.doc; }, opts: { ptt, relay } });
  const notes = () => h.doc.querySelectorAll(".rmd-log > .rmd-toasts .rmd-ct");
  const x = (n) => h.button("Dismiss", n).click();
  pt("🎙 your clip: queued for the mic…", { id: "ptt:p1", ms: CLIP_OPEN_MS, busy: true });
  assert.equal(notes().length, 1); x(notes()[0]); assert.equal(notes().length, 0);
  pt("🎙 your clip: waiting for the mic…", { id: "ptt:p1", ms: CLIP_OPEN_MS, busy: true });
  pt("🎙 your clip: playing on the mic now", { id: "ptt:p1", ms: CLIP_OPEN_MS, busy: true });
  assert.equal(notes().length, 0, "closed with ✕: the clip's progress doesn't bring it back");
  pt("🎙 your clip: played", { id: "ptt:p1", ms: 3000, bad: false });
  assert.equal(notes().length, 0, "nor its finished step");
  // the next clip: closed while it waited, then it didn't play - that refusal still shows
  pt("🎙 your clip: waiting for the mic…", { id: "ptt:p2", ms: CLIP_OPEN_MS, busy: true }); x(notes()[0]);
  pt("🎙 your clip: couldn’t get the mic, try again", { id: "ptt:p2", ms: 8000, bad: true });
  assert.equal(notes().length, 1, "a refusal breaks through"); assert.ok(notes()[0].classList.contains("rmd-ct-bad"));
  assert.match(notes()[0].textContent, /couldn’t get the mic/);
  h.tick(); assert.equal(notes().length, 0);
  // a notice that went by itself (or was pushed out) is not closed: its next state shows
  pt("🎙 your clip: queued for the mic…", { id: "ptt:p3", ms: CLIP_OPEN_MS, busy: true }); h.tick();
  pt("🎙 your clip: playing on the mic now", { id: "ptt:p3", ms: CLIP_OPEN_MS, busy: true });
  assert.equal(notes().length, 1, "timed out, not closed: the next state is news"); h.tick();
  // '' frees the id: the relay's offline notice closed in one outage is back in the next
  rt("You're offline — your messages will send when the connection is back.", { id: "rb-offline", bad: true, sticky: true }); x(notes()[0]);
  rt("", { id: "rb-offline" });
  rt("You're offline — your messages will send when the connection is back.", { id: "rb-offline", bad: true, sticky: true });
  assert.equal(notes().length, 1, "a new outage, a new notice"); x(notes()[0]);
  // a command's notice closed while Pepe ran it: its "done" is quiet, a private answer closed with ✕ doesn't come back on the next update
  h.controller.cmd({ id: "c1", text: "!spin", st: "waiting for Pepe…", ok: null, replies: [] }); x(notes()[0]);
  h.controller.cmd({ id: "c1", text: "!spin", st: "done", ok: true, replies: [] });
  assert.equal(notes().length, 0, "a command closed with ✕ stays closed");
  h.controller.cmd({ id: "c2", text: "!bal", st: "", ok: true, replies: ["Your balance: 5 PAT"] });
  const sticky = notes().filter((n) => n.classList.contains("rmd-ct-sticky")); assert.equal(sticky.length, 1); x(sticky[0]); h.tick();
  h.controller.cmd({ id: "c2", text: "!bal", st: "", ok: true, replies: ["Your balance: 5 PAT"] });
  assert.equal(notes().filter((n) => n.classList.contains("rmd-ct-sticky")).length, 0, "a private answer closed with ✕ stays closed");
  h.tick();
  h.controller.cmd({ id: "c3", text: "!heist", st: "waiting for Pepe…", ok: null, replies: [] }); x(notes()[0]);
  h.controller.cmd({ id: "c3", text: "!heist", st: "not run — refused", ok: false, replies: [] });
  assert.equal(notes().length, 1, "a command's refusal still shows"); assert.ok(notes()[0].classList.contains("rmd-ct-bad"));
});

test("ptttoast review F3: the offline notice stays for the whole outage (sticky, never pushed out) and goes when the site answers again", async () => {
  // room-bridge.js: sticky, no timer - also when the Dock takes over during an outage
  const r = relayRig({ answers: ["offline", "offline", { status: 200, body: { ok: true, id: "s1" } }] });
  r.R._send("hello"); await flush();
  assert.deepEqual(r.toasts.filter((t) => t.id === "rb-offline"), [{ text: "You're offline — your messages will send when the connection is back.", id: "rb-offline", bad: true, sticky: true }]);
  const again = []; r.R.useToast((text, o) => again.push(Object.assign({ text }, o)));
  assert.deepEqual(again, [{ text: "You're offline — your messages will send when the connection is back.", id: "rb-offline", bad: true, sticky: true }], "handed over mid-outage: still a state");
  await r.run();
  assert.deepEqual(again.at(-1), { text: "", id: "rb-offline" }, "back online: taken down");
  // pad-dock.js: a sticky refusal stays through the timers and the passing notices, '' takes it down
  let rt = null, D0 = null;
  const relay = { getInput: () => D0.querySelector("#rmRelay input"), sendCmd() {}, insert: (t) => t, useToast(f) { if (f) rt = f; } };
  const h = harness({ setup: (p) => { D0 = p.doc; }, opts: { relay } });
  const notes = () => h.doc.querySelectorAll(".rmd-log > .rmd-toasts .rmd-ct");
  rt("You're offline — your messages will send when the connection is back.", { id: "rb-offline", bad: true, sticky: true });
  for (let i = 0; i < 4; i++) h.controller.cmd({ id: "q" + i, text: "!np", st: "waiting for Pepe…", ok: null, replies: [] });
  h.tick(); h.tick();
  const off = notes().filter((n) => /You're offline/.test(n.textContent));
  assert.equal(off.length, 1, "still up after the timers and four newer notices"); assert.ok(off[0].classList.contains("rmd-ct-bad"));
  rt("", { id: "rb-offline" });
  assert.equal(notes().filter((n) => /You're offline/.test(n.textContent)).length, 0, "back online: gone");
});

test("ptttoast review F4: a clip's progress notice stays until its next state (the site settles every clip inside CLIP_OPEN_MS), not 30 s", async () => {
  const relaySrc = read("bridge-relay.js");
  const mins = (name) => { const m = relaySrc.match(new RegExp("const " + name + " = (\\d+) \\* (\\d+) \\* 1000;")); assert.ok(m, name); return m[1] * m[2] * 1000; };
  const secs = (name) => { const m = relaySrc.match(new RegExp("const " + name + " = (\\d+) \\* 1000;")); assert.ok(m, name); return m[1] * 1000; };
  assert.ok(CLIP_OPEN_MS > mins("CLIP_TTL") && CLIP_OPEN_MS > secs("CLIP_PENDING_TTL") && CLIP_OPEN_MS > Math.max(mins("CLIP_PLAYING_GRACE"), 120000 + secs("CLIP_PLAYED_SLACK")),
    "longer than any wait the site allows before it settles the clip (pending, the 8 min from Pepe's claim, playing)");
  const r = pttRig({ answers: [{ status: 200, body: { ok: true, id: "j9" } }] });
  await r.clip(3);
  const room = { micRelay: true, pttMax: 30 };
  for (const state of ["pending", "queued", "waiting", "playing"]) {
    r.p.update({ room, mine: [{ kind: "clip", id: "j9", at: 5, state, ok: true, msg: state }] });
    assert.equal(r.toasts.at(-1).ms, CLIP_OPEN_MS, state); assert.equal(r.toasts.at(-1).busy, true, state);
  }
  // a clip from another tab too
  r.p.update({ room, mine: [{ kind: "clip", id: "k1", at: 6, state: "waiting", ok: true }] });
  assert.equal(r.toasts.at(-1).ms, CLIP_OPEN_MS); assert.notEqual(r.toasts.at(-1).id, r.toasts[0].id);
  // the recorder's own steps keep their timing (30 s on its way)
  assert.equal(r.toasts.find((t) => /sending/.test(t.text)).ms, 30000);
});

test("ptttoast review F1: the character counter sits in the input's row beside the field - nothing under the tool row past 240 characters either", () => {
  const css = read("public", "css", "pad-dock.css");
  const under = css.match(/main\.rm\.rm-dock \.rmd-input-row :is\(([^)]*)\) \{ grid-column: 1 \/ -1;/);
  assert.ok(under, "the rule for what may sit under the tool row (the classic lines, hidden in the Dock)");
  assert.doesNotMatch(under[1], /rb-count/, "the counter is not one of them");
  assert.match(css, /main\.rm\.rm-dock \.rmd-input-row \.rb-count \{ grid-row: 1; grid-column: 3; [^}]*\}/, "row 1, its own column after the field");
  // while it shows, the row has a column for it; 🎙 and Send move one along (the slim homepage row too - no tool row there, the same idea)
  assert.match(css, /main\.rm\.rm-dock \.rmd-input-row:has\(\.rb-count:not\(\.hide\)\) \{ grid-template-columns: auto minmax\(0, 1fr\) auto auto auto; \}/);
  assert.match(css, /main\.rm\.rm-dock \.rmd-input-row\.rmd-input-slim:has\(\.rb-count:not\(\.hide\)\) \{ grid-template-columns: 0 minmax\(0, 1fr\) auto auto auto; \}/);
  assert.match(css, /main\.rm\.rm-dock \.rmd-input-row:has\(\.rb-count:not\(\.hide\)\) \.rb-talk \{ grid-column: 4; \}/);
  assert.match(css, /main\.rm\.rm-dock \.rmd-input-row:has\(\.rb-count:not\(\.hide\)\) \.rb-send \{ grid-column: 5; \}/);
  // the composer box's background spans every column (1 / -1 = the last explicit line - the template names them all)
  assert.match(css, /main\.rm\.rm-dock \.rmd-input-row::before \{ content: ""; grid-row: 1 \/ 3; grid-column: 1 \/ -1;/);
  // hidden below 240 characters, as before (room-bridge.js COUNT_FROM)
  assert.match(read("public", "js", "room-bridge.js"), /COUNT_FROM = 240/);
});

test("ptttoast: cache-busters - room-bridge.js v33 and pad-dock.js v13 wherever they load, pad-dock.css v12 (review F1); the hidden line rule is room-bridge.css's", () => {
  for (const v of ["room.ejs", "home.ejs"]) {
    const s = read("views", v);
    assert.match(s, /room-bridge\.js\?v=33/, v);
    assert.doesNotMatch(s, /room-bridge\.js\?v=(?!33\b)\d+/, v + ": one version");
    assert.match(s, /<script src="\/public\/js\/pad-dock\.js\?v=13"><\/script>/, v);
  }
  assert.match(read("public", "css", "room-bridge.css"), /^\.rb-hide, [^{]*\{ display: none !important; \}/m);
  const dock = read("public", "js", "pad-dock.js");
  assert.match(dock, /o\.ptt\.useToast\(/); assert.match(dock, /o\.relay\.useToast\(/);
  // (review F1: pad-dock.css v12 - the counter beside the field - on the pad, the homepage and both casino tables)
  for (const v of ["room.ejs", "home.ejs", "casino-bj.ejs", "casino-hm.ejs"]) {
    const s = read("views", v);
    assert.match(s, /<link rel="stylesheet" href="\/public\/css\/pad-dock\.css\?v=12">/, v);
    assert.doesNotMatch(s, /pad-dock\.css\?v=(?!12")\d+/, v + ": one css version");
  }
});
