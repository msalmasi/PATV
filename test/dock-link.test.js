"use strict";
// 1.99?? dockpop (owner P1): public/js/dock-link.js - the Room Dock's windows talk in this browser only (a pad tab, the pad's chat in its
// own window, the homepage). BroadcastChannel 'patv-dock', a localStorage 'storage' fallback; messages carry no chat text (only the
// viewer's own draft, only between windows of the same viewer tag); other rooms are ignored, another tag is a re-check trigger, the
// sign-out page's {t: 'session'} too. And the window protocol end to end, on the pad Dock's harness: newest window wins, one window per
// room + tag, a popped tab restores after 15 s without a heartbeat.
//   node --test test/dock-link.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { harness, bus } = require("./fixtures/pad-dock/dom.cjs");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "dock-link.js"), "utf8");

/** one browser: a shared bus of fake BroadcastChannels (or none, with a shared fake localStorage) */
function browser(opts = {}) {
  const chans = new Set(), queue = [], sent = [], storageListeners = [], store = new Map();
  class BC {
    constructor(name) { this.name = name; this.l = []; chans.add(this); }
    addEventListener(t, f) { if (t === "message") this.l.push(f); }
    removeEventListener(t, f) { this.l = this.l.filter((x) => x !== f); }
    postMessage(m) { const c = JSON.parse(JSON.stringify(m)); sent.push(c); queue.push({ from: this, m: c }); }
    close() { chans.delete(this); }
  }
  function win() {
    const w = { listeners: {}, addEventListener(t, f) { (w.listeners[t] ||= []).push(f); if (t === "storage") storageListeners.push({ w, f }); },
      removeEventListener(t, f) { w.listeners[t] = (w.listeners[t] || []).filter((x) => x !== f); const i = storageListeners.findIndex((x) => x.f === f); if (i >= 0) storageListeners.splice(i, 1); },
      crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 2 ** 32); return a; } } };
    if (!opts.noChannel) w.BroadcastChannel = BC;
    if (!opts.noStorage) w.localStorage = { setItem(k, v) { store.set(k, v); sent.push(JSON.parse(v)); for (const l of storageListeners) if (l.w !== w) queue.push({ storage: l, key: k, v }); }, removeItem(k) { store.delete(k); }, getItem(k) { return store.get(k) || null; } };
    vm.runInNewContext(SRC, { window: w, JSON, Date, Math });
    return w;
  }
  function flush() {
    let n = 0;
    while (queue.length && n++ < 200) {
      const q = queue.shift();
      if (q.storage) { q.storage.f({ key: q.key, newValue: q.v }); continue; }
      for (const c of [...chans]) if (c !== q.from && c.name === q.from.name) for (const f of c.l) f({ data: JSON.parse(JSON.stringify(q.m)) });
    }
  }
  return { win, flush, sent, chans };
}
const recorder = () => { const r = { msg: [], foreign: [], session: [] }; r.o = { onMsg: (m) => r.msg.push(m), onForeign: (m) => r.foreign.push(m), onSession: (m) => r.session.push(m) }; return r; };

test("messages reach the same room and tag only; another room is ignored; another tag is a re-check trigger", () => {
  const B = browser();
  const a = recorder(), b = recorder(), c = recorder(), d = recorder();
  const la = B.win().PATVDockLink.open({ room: "Pad_1", tag: "tagA", role: "tab", ...a.o });
  B.win().PATVDockLink.open({ room: "Pad_1", tag: "tagA", role: "pop", ...b.o });
  B.win().PATVDockLink.open({ room: "Pad_2", tag: "tagA", role: "tab", ...c.o });
  B.win().PATVDockLink.open({ room: "Pad_1", tag: "tagB", role: "tab", ...d.o });
  assert.equal(la.ok, true);
  la.send("who"); B.flush();
  assert.deepEqual(b.msg.map((m) => m.t), ["who"], "same room + tag");
  assert.equal(c.msg.length, 0, "another room never hears it");
  assert.equal(d.msg.length, 0, "another tag never gets it as a message ...");
  assert.deepEqual(d.foreign.map((m) => m.t), ["who"], "... only as a re-check trigger");
  assert.equal(a.msg.length, 0, "a window never hears itself");
  const m = b.msg[0];
  assert.deepEqual(Object.keys(m).sort(), ["at", "id", "room", "t", "tag", "v"], "the envelope only");
  assert.equal(m.v, 1); assert.equal(m.room, "Pad_1"); assert.equal(m.tag, "tagA"); assert.match(m.id, /^[a-z0-9]{4,}$/);
});

test("the only text is the viewer's own draft - on draft / handoff / pop-closed, at most 300 characters, and only to the same tag", () => {
  const B = browser();
  const same = recorder(), other = recorder();
  const l = B.win().PATVDockLink.open({ room: "R", tag: "t1" });
  B.win().PATVDockLink.open({ room: "R", tag: "t1", ...same.o });
  B.win().PATVDockLink.open({ room: "R", tag: "t2", ...other.o });
  l.send("draft", { draft: "x".repeat(400) });
  l.send("pop-alive", { audio: true, draft: "never on a heartbeat" });
  l.send("handoff", { draft: "half a thought", audio: false, to: "abc" });
  B.flush();
  assert.deepEqual(same.msg.map((m) => [m.t, m.draft && m.draft.length, m.audio]), [["draft", 300, undefined], ["pop-alive", undefined, 1], ["handoff", 14, 0]]);
  assert.equal(same.msg[2].to, "abc");
  assert.equal(other.msg.length, 0); assert.equal(other.foreign.length, 3);
  for (const f of other.foreign) assert.equal(f.draft, undefined, "another tag's trigger never carries the draft");
  // nothing on the channel is chat content: no lines, names, logins or account ids - the envelope, the audio flag, the draft, the hand-over's target
  for (const s of B.sent) for (const k of Object.keys(s)) assert.ok(["v", "t", "room", "tag", "id", "at", "audio", "draft", "to"].includes(k), k);
  // a forged message from elsewhere on the channel: only known types and fields get through
  const raw = new (B.chans.values().next().value.constructor)("patv-dock");
  raw.postMessage({ v: 1, t: "pop-open", room: "R", tag: "t1", id: "forged", text: "a chat line", login: "someone", feed: [1, 2] });
  raw.postMessage({ v: 2, t: "pop-open", room: "R", tag: "t1", id: "x" });
  raw.postMessage({ v: 1, t: "eval", room: "R", tag: "t1", id: "x" });
  B.flush();
  const forged = same.msg.at(-1);
  assert.equal(forged.t, "pop-open"); assert.equal(forged.text, undefined); assert.equal(forged.login, undefined); assert.equal(forged.feed, undefined);
  assert.equal(same.msg.filter((m) => m.t === "eval").length, 0); assert.equal(same.msg.length, 4, "a wrong version / type is dropped");
});

test("audio-on reaches every window of the room (one room is never heard twice); session reaches everyone", () => {
  const B = browser();
  const same = recorder(), other = recorder(), elsewhere = recorder();
  const l = B.win().PATVDockLink.open({ room: "R", tag: "t1" });
  B.win().PATVDockLink.open({ room: "R", tag: "t1", ...same.o });
  B.win().PATVDockLink.open({ room: "R", tag: "t2", ...other.o });
  B.win().PATVDockLink.open({ room: "Q", tag: "t1", ...elsewhere.o });
  l.send("audio-on"); B.flush();
  assert.deepEqual(same.msg.map((m) => m.t), ["audio-on"]);
  assert.deepEqual(other.msg.map((m) => m.t), ["audio-on"], "another tag playing the same room pauses too");
  assert.equal(elsewhere.msg.length, 0, "a different room is left alone");
  assert.equal(l.send("session"), false, "a window can't send session itself (the sign-out page does)");
  const w = B.win(); w.PATVDockLink.session(); B.flush();
  assert.equal(same.session.length + other.session.length + elsewhere.session.length, 3);
});

test("the localStorage fallback (no BroadcastChannel): written then removed at once, read from 'storage' events; neither: no coordination", () => {
  const B = browser({ noChannel: true });
  const r = recorder();
  const l = B.win().PATVDockLink.open({ room: "R", tag: "t", ...r.o });
  B.win().PATVDockLink.open({ room: "R", tag: "t", ...r.o });
  assert.equal(l.ok, true);
  l.send("pop-open", { audio: false }); B.flush();
  assert.deepEqual(r.msg.map((m) => m.t), ["pop-open"]);
  const none = browser({ noChannel: true, noStorage: true }).win().PATVDockLink.open({ room: "R", tag: "t" });
  assert.equal(none.ok, false); assert.equal(none.send("who"), false, "no channel at all: the page simply stays as it is");
  assert.equal(browser().win().PATVDockLink.roomKey("You Were.Never/Here"), "You_Were_Never_Here");
});

test("chat-sweep.ejs (the first page after any sign-out) tells every Dock window to re-check: a static {v: 1, t: 'session'}", () => {
  const src = fs.readFileSync(path.join(repo, "views", "partials", "chat-sweep.ejs"), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(src)[1];
  const firstTry = script.indexOf("try {"), cookie = script.indexOf("patv_chat_sweep");
  assert.ok(firstTry >= 0 && firstTry < cookie, "before (outside) the cookie check");
  assert.match(script, /var m = \{ v: 1, t: 'session' \}; if \(window\.BroadcastChannel\) \{ var c = new BroadcastChannel\('patv-dock'\); c\.postMessage\(m\); c\.close\(\); \}/);
  assert.match(script, /localStorage\.setItem\('patv\.dock\.msg', JSON\.stringify\(m\)\); localStorage\.removeItem\('patv\.dock\.msg'\);/);
  // the page's session post, run as the browser runs it, is heard by a Dock window
  const B = browser(), r = recorder();
  B.win().PATVDockLink.open({ room: "R", tag: "t", ...r.o });
  const w = B.win();
  vm.runInNewContext(script, { window: w, BroadcastChannel: w.BroadcastChannel, document: { cookie: "" }, JSON });
  B.flush();
  assert.equal(r.session.length, 1);
});

// ── the window protocol on the Dock's harness (a pad tab and its chat window share one bus) ──
const flushAll = (b, ...hs) => { for (let i = 0; i < 6; i++) b.flush(); };
function tabAndWindow(extra = {}) {
  const b = bus();
  const tab = harness({ bus: b, fine: true, open: true, opts: { room: "Dock.Equipped", vt: "tag-1", ...(extra.tab || {}) } });
  const win = harness({ bus: b, closeWin: true, opts: { mode: "popout", room: "Dock.Equipped", vt: "tag-1", padHref: "/p/night-orchard", ...(extra.win || {}) } });
  flushAll(b);
  return { b, tab, win };
}
test("a window announces itself: its pad tab goes popped (the chat hidden in place, the 44px bar), answers tab-here, and hands over its draft", () => {
  const b = bus();
  const tab = harness({ bus: b, fine: true, opts: { room: "Dock.Equipped", vt: "tag-1" } });
  tab.input.value = "half a thought"; flushAll(b);
  const win = harness({ bus: b, closeWin: true, opts: { mode: "popout", room: "Dock.Equipped", vt: "tag-1" } });
  flushAll(b);
  assert.equal(tab.root.classList.contains("rmd-popped"), true);
  assert.equal(tab.chat.parentNode.querySelector(".rmd-popbar") !== null, true);
  assert.equal(tab.doc.getElementById("rmFeed"), tab.feed, "hidden in place - never moved");
  assert.equal(tab.root.classList.contains("rmd-chat-out"), true, "the stage takes the freed height");
  assert.equal(win.input.value, "half a thought", "the tab's unsent words go to the new window");
  assert.equal(tab.input.value, "", "and leave the tab");
  assert.ok(b.types().includes("tab-here"));
  win.button("Chat options").click();
  assert.ok(win.doc.querySelector(".rmd-menu").textContent.includes("Back in the pad tab"), "the window offers the way back while its tab is there");
});
test("the newest window wins; another account's tag or room leaves a tab alone", () => {
  const b = bus();
  const tab = harness({ bus: b, opts: { room: "Dock.Equipped", vt: "tag-1" } });
  const other = harness({ bus: b, opts: { room: "Dock.Equipped", vt: "tag-2", recheck: () => { other.calls.rechecks = (other.calls.rechecks || 0) + 1; } } });
  const w1 = harness({ bus: b, closeWin: true, opts: { mode: "popout", room: "Dock.Equipped", vt: "tag-1" } });
  flushAll(b);
  const w2 = harness({ bus: b, closeWin: true, opts: { mode: "popout", room: "Dock.Equipped", vt: "tag-1" } });
  flushAll(b);
  assert.equal(w1.calls.closed, undefined, "(a pop-open is answered by the OLDER window, not the newer)");
  assert.ok(w1.root.querySelector(".rmd-gone"), "the older window stands down (one poll, one audio per room + account)");
  assert.equal(w2.root.querySelector(".rmd-gone"), null, "the newest one stays");
  assert.equal(tab.root.classList.contains("rmd-popped"), true);
  assert.equal(other.root.classList.contains("rmd-popped"), false, "another account's tab is never popped by this window");
  assert.ok(other.calls.rechecks >= 1, "it re-checks who is signed in instead");
});
test("a popped tab restores itself after 15 s without a heartbeat (a crashed window); a live one keeps it popped", () => {
  const { b, tab, win } = tabAndWindow();
  assert.equal(tab.root.classList.contains("rmd-popped"), true);
  const realNow = Date.now; let now = realNow();
  try {
    Date.now = () => now;
    for (let i = 0; i < 4; i++) { now += 5000; win.tick(); flushAll(b); tab.tick(); }
    assert.equal(tab.root.classList.contains("rmd-popped"), true, "heartbeats every 5 s keep it popped");
    win.controller.destroy();
    now += 16000; tab.tick(); tab.tick(); tab.tick();
    assert.equal(tab.root.classList.contains("rmd-popped"), false, "no pop-alive for 15 s: restored");
    assert.equal(tab.chat.parentNode.querySelector(".rmd-popbar"), null);
  } finally { Date.now = realNow; }
});
