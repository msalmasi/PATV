"use strict";
// 1.99?? casino2 (owner 2026-11-04, point 18: "Docking chat doesn't stay active between page switches (like going to holdem). Would be nice
// if users could also bring up a chat from the tables."): the pad chat window FRAMED beside a casino table (pad-dock.js o.embed; the table's
// casino-chat.js) and "the chat follows" (sessionStorage 'patv.chat.follow').
//   * the frame keeps the window's role on the channel: a pad tab of the pad goes popped ("Chat is open beside a casino table"), the newest
//     window or frame wins; ✕ / the hand-over / a retire talk to the table page (postMessage, same origin) instead of closing a window
//   * only inside a same-origin casino TABLE page; framed by anything else it is the plain window
//   * links: the casino's own pages and sign in take the whole tab (_top); others open a new tab as in the window
//   * the table page -> frame bridge: pvp (the person menu's ⚔️ Duel) re-checks the person like the Dock; wrong origin / source ignored
//   * dock-link v2: pop-open / pop-alive keep embed: 1
//   * the follow mark: a pad page whose chat FLOATS writes it when it goes (and on a casino link); not while docked or popped
//   * casino-chat.js reads the mark once: under 2 minutes, one of the table's pads with a chat -> opened (+ a toast); writes it when it goes
//   node --test test/pad-chat-embed.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { harness, bus, Document, Event } = require("./fixtures/pad-dock/dom.cjs");

const repo = path.resolve(__dirname, "..");
const ORIGIN = "https://publicaccess.test";
const TABLE = "/casino/holdem/t/0123456789";

/** a parent window (the casino table page) + the frame's location; posts to the parent are recorded */
function framed(pathname, origin = ORIGIN) {
  const parent = { posted: [], location: { origin, pathname }, postMessage(m, o) { this.posted.push({ m: JSON.parse(JSON.stringify(m)), o }); } };
  return { parent, setup(win) {
    win.location = { origin: ORIGIN, href: ORIGIN + "/p/night-orchard/chat?embed=1", pathname: "/p/night-orchard/chat", reload() {} };
    win.URL = URL;
    win.parent = parent;
    const ss = new Map(); win.sessionStorage = { setItem: (k, v) => ss.set(k, String(v)), getItem: (k) => (ss.has(k) ? ss.get(k) : null), removeItem: (k) => ss.delete(k), _m: ss };
  } };
}
const embedOpts = (extra = {}) => Object.assign({ mode: "popout", embed: true, room: "Dock.Equipped", vt: "tag-1", padHref: "/p/night-orchard" }, extra);
const flushAll = (b) => { for (let i = 0; i < 6; i++) b.flush(); };

test("framed beside a casino table: pop-open says embed; a pad tab goes popped 'beside a casino table'; the frame tells the table it is ready", () => {
  const b = bus(), f = framed(TABLE);
  const tab = harness({ bus: b, fine: true, open: true, opts: { room: "Dock.Equipped", vt: "tag-1" } });
  const fr = harness({ bus: b, closeWin: true, win: f.setup, opts: embedOpts() });
  flushAll(b);
  const open = b.sent.find((x) => x.m.t === "pop-open");
  assert.equal(open.m.embed, 1, "the frame says what it is");
  assert.equal(fr.controller.embedded(), true);
  assert.equal(tab.root.classList.contains("rmd-popped"), true, "the pad tab is popped (one poller's chat shown, one audio)");
  const bar = tab.chat.parentNode.querySelector(".rmd-popbar");
  assert.match(bar.textContent, /Chat is open beside a casino table/);
  assert.equal(tab.button("Show it").hidden, true, "no window of ours to show");
  assert.ok(f.parent.posted.some((x) => x.m.t === "patv-chat:ready" && x.o === ORIGIN), "ready, to this origin only");
  assert.equal(fr.doc.body.classList.contains("rmd-embed"), true);
  fr.tick(); flushAll(b);
  assert.ok(b.sent.filter((x) => x.m.t === "pop-alive").every((x) => x.m.embed === 1), "its heartbeats say so too");
});

test("Bring it back from the pad tab: the frame hands over and asks the table page to close it (no window.close)", () => {
  const b = bus(), f = framed(TABLE);
  const tab = harness({ bus: b, fine: true, open: true, opts: { room: "Dock.Equipped", vt: "tag-1" } });
  const fr = harness({ bus: b, closeWin: true, win: f.setup, opts: embedOpts() });
  flushAll(b);
  fr.input.value = "typed beside the table";
  tab.button("Bring it back").click(); flushAll(b);
  assert.equal(fr.calls.closed, undefined, "the frame never closes the table's window");
  assert.deepEqual(f.parent.posted.filter((x) => x.m.t === "patv-chat:closed").map((x) => x.m.why), ["handoff"]);
  assert.equal(tab.root.classList.contains("rmd-popped"), false, "the tab restores");
  assert.equal(tab.input.value, "typed beside the table", "with the frame's draft");
});

test("a newer window retires the frame: the table page hears why; the frame's card closes the chat through the table page", () => {
  const b = bus(), f = framed(TABLE);
  const fr = harness({ bus: b, closeWin: true, win: f.setup, opts: embedOpts() });
  flushAll(b);
  harness({ bus: b, closeWin: true, opts: { mode: "popout", room: "Dock.Equipped", vt: "tag-1" } });   // ↗️ its own window
  flushAll(b);
  assert.deepEqual(f.parent.posted.filter((x) => x.m.t === "patv-chat:retired").map((x) => x.m.key), ["pop_moved"]);
  const close = fr.button("Close the chat");
  close.click();
  assert.equal(fr.calls.closed, undefined);
  assert.ok(f.parent.posted.some((x) => x.m.t === "patv-chat:closed" && x.m.why === "pop_moved"));
  // and a plain window that hears a newer FRAME says where the chat went
  const b2 = bus();
  const win = harness({ bus: b2, closeWin: true, opts: { mode: "popout", room: "Dock.Equipped", vt: "tag-1" } });
  flushAll(b2);
  harness({ bus: b2, closeWin: true, win: framed(TABLE).setup, opts: embedOpts() });
  flushAll(b2);
  assert.match(win.doc.querySelector(".rmd-gone").textContent, /This chat is open beside a casino table/);
  assert.equal(b2.sent.filter((x) => x.m.t === "pop-closed").length, 0, "a moved chat doesn't restore the pad tab (the frame holds it)");
});

test("framed by anything but a casino table page (or another origin): the plain window - no embed flag, ✕ closes the window", () => {
  for (const [p, o] of [["/p/other-pad", ORIGIN], ["/casino/holdem", ORIGIN], [TABLE, "https://evil.test"]]) {
    const b = bus(), f = framed(p, o);
    const fr = harness({ bus: b, closeWin: true, win: f.setup, opts: embedOpts() });
    flushAll(b);
    assert.equal(fr.controller.embedded(), false, p + " " + o);
    assert.equal(b.sent.find((x) => x.m.t === "pop-open").m.embed, undefined);
    assert.equal(f.parent.posted.length, 0, "nothing is posted to that parent");
    fr.controller.gone("pop_gone", "gone");
    fr.button("Close this window").click();
    assert.equal(fr.calls.closed, 1);
  }
});

test("links in the frame: the casino's pages and sign in take the whole tab; a profile opens a new tab as in the window", () => {
  const f = framed(TABLE);
  const fr = harness({ win: f.setup, opts: embedOpts({ vt: null }) });
  const click = (href) => { const a = fr.make("a", null, null, fr.chat); a.setAttribute("href", href); const e = new Event("click", { bubbles: true }); a.dispatchEvent(e); return a; };
  const c = click("/casino/blackjack/t/abcdefabcd");
  assert.equal(c.getAttribute("target"), "_top");
  const l = click("/login");
  assert.equal(l.getAttribute("target"), "_top"); assert.equal(l.getAttribute("href"), "/login?next=" + encodeURIComponent(TABLE), "back to the table after signing in");
  const u = click("/u/willow-fable");
  assert.equal(u.getAttribute("target"), "_blank"); assert.equal(u.getAttribute("rel"), "noopener");
});

test("the table page's ⚔️ Duel reaches the frame's stake sheet for a named member; wrong origin / source and absent people do nothing", () => {
  const f = framed(TABLE);
  const fr = harness({ win: f.setup, opts: embedOpts({ vt: null }), data: (d) => { d.room.cmds["!duel"] = 0; } });
  const msg = (data, o = {}) => fr.win.dispatchEvent(new Event("message", { data, origin: o.origin || ORIGIN, source: o.source === undefined ? f.parent : o.source }));
  msg({ t: "patv-chat:pvp", kind: "duel", login: "willow_fable" }, { origin: "https://evil.test" });
  assert.equal(fr.doc.querySelector(".rmd-layer form.rmd-pvp"), null, "another origin: ignored");
  msg({ t: "patv-chat:pvp", kind: "duel", login: "willow_fable" }, { source: {} });
  assert.equal(fr.doc.querySelector(".rmd-layer form.rmd-pvp"), null, "another window: ignored");
  msg({ t: "patv-chat:pvp", kind: "duel", login: "Willow_Fable" });
  const form = fr.doc.querySelector(".rmd-layer form.rmd-pvp");
  assert.ok(form, "the stake sheet opens in the chat");
  assert.match(fr.doc.querySelector(".rmd-layer [role=dialog]").getAttribute("aria-label"), /Duel Willow Fable/);
  form.dispatchEvent(new Event("submit"));
  assert.deepEqual(fr.calls.send, ["!duel willow_fable 5000"], "sent by the chat's own relay, with its stake");
  msg({ t: "patv-chat:pvp", kind: "duel", login: "nobody_here" });
  assert.match(fr.doc.querySelector(".rmd-toast").textContent, /aren’t in the room right now/);
  msg({ t: "patv-chat:pvp", kind: "brawl", login: "willow_fable" });
  assert.match(fr.doc.querySelector(".rmd-toast").textContent, /aren’t in the room right now/, "a command the room doesn't offer: no sheet");
});

test("review: a sheet opened in the frame asks the table page for the height (tall on), and gives it back when it closes (tall off)", () => {
  const f = framed(TABLE);
  const fr = harness({ win: f.setup, opts: embedOpts({ vt: null }), data: (d) => { d.room.cmds["!duel"] = 0; } });
  const tall = () => f.parent.posted.filter((x) => x.m.t === "patv-chat:tall").map((x) => x.m.on);
  fr.win.dispatchEvent(new Event("message", { data: { t: "patv-chat:pvp", kind: "duel", login: "willow_fable" }, origin: ORIGIN, source: f.parent }));
  assert.ok(fr.doc.querySelector(".rmd-layer form.rmd-pvp"));
  assert.deepEqual(tall(), [true], "the stake sheet: tall");
  fr.doc.querySelector(".rmd-layer .ds-modal-h button").click();
  assert.equal(fr.doc.querySelector(".rmd-layer"), null);
  assert.deepEqual(tall(), [true, false], "closed: back");
  // a plain window (not framed) never posts
  const g = framed("/p/night-orchard");
  const w = harness({ win: g.setup, opts: embedOpts({ vt: null }), data: (d) => { d.room.cmds["!duel"] = 0; } });
  assert.equal(w.controller.embedded(), false);
  assert.equal(g.parent.posted.length, 0);
});

test("the follow mark: a FLOATING pad chat leaves it when the tab goes (and on a casino link); docked or popped it doesn't; a pad page drops an old one", () => {
  const f = framed("/");
  const pad = harness({ fine: true, win: (w) => { f.setup(w); w.location = { origin: ORIGIN, href: ORIGIN + "/p/night-orchard", pathname: "/p/night-orchard" }; w.sessionStorage.setItem("patv.chat.follow", "old"); w.parent = w; }, opts: { room: "Dock.Equipped" } });
  assert.equal(pad.win.sessionStorage.getItem("patv.chat.follow"), null, "the pad's own chat is here: an old mark goes");
  pad.win.dispatchEvent(new Event("pagehide"));
  assert.equal(pad.win.sessionStorage.getItem("patv.chat.follow"), null, "docked: no mark");
  pad.menuPick("Chat options", "Float chat");
  const a = pad.make("a", null, null, pad.root); a.setAttribute("href", "/casino/holdem/t/0123456789");
  a.dispatchEvent(new Event("click", { bubbles: true }));
  const m = JSON.parse(pad.win.sessionStorage.getItem("patv.chat.follow"));
  assert.deepEqual(Object.keys(m).sort(), ["at", "audio", "room", "slug"]);
  assert.equal(m.room, "Dock_Equipped"); assert.equal(m.slug, "night-orchard"); assert.equal(m.audio, 0); assert.ok(Math.abs(Date.now() - m.at) < 5000);
  pad.win.sessionStorage.removeItem("patv.chat.follow");
  pad.win.dispatchEvent(new Event("pagehide"));
  assert.ok(pad.win.sessionStorage.getItem("patv.chat.follow"), "floating + leaving: the mark");
  // popped (the chat in its own window, which follows by itself): no mark
  const b = bus();
  const tab = harness({ bus: b, fine: true, open: true, win: (w) => { f.setup(w); w.parent = w; }, opts: { room: "Dock.Equipped", vt: "tag-1" } });
  tab.menuPick("Chat options", "Float chat");
  harness({ bus: b, closeWin: true, opts: { mode: "popout", room: "Dock.Equipped", vt: "tag-1" } });
  flushAll(b);
  assert.equal(tab.root.classList.contains("rmd-popped"), true);
  tab.win.dispatchEvent(new Event("pagehide"));
  assert.equal(tab.win.sessionStorage.getItem("patv.chat.follow"), null, "popped: the window follows by itself");
});

test("dock-link v2: embed survives clean() on pop-open / pop-alive only", () => {
  const w = { crypto: { getRandomValues: (a) => a } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "dock-link.js"), "utf8"), { window: w, JSON, Date, Math });
  const c = w.PATVDockLink._clean;
  assert.equal(c({ v: 1, t: "pop-open", room: "r", tag: "t", id: "i", embed: 1 }).embed, 1);
  assert.equal(c({ v: 1, t: "pop-alive", room: "r", tag: "t", id: "i", embed: true }).embed, 1);
  assert.equal(c({ v: 1, t: "who", room: "r", tag: "t", id: "i", embed: 1 }).embed, undefined, "nothing else carries it");
  assert.equal(c({ v: 1, t: "pop-open", room: "r", tag: "t", id: "i", embed: "yes please" }).embed, 1, "a flag, never text");
});

// ── casino-chat.js on a minimal page ──
function tablePage({ follow = null, pads = [], width = 1280 } = {}) {
  const doc = new Document(), win = { listeners: {}, innerWidth: width, location: { origin: ORIGIN, pathname: TABLE } };
  win.addEventListener = (t, f) => { (win.listeners[t] ||= []).push(f); };
  win.dispatch = (t, e) => (win.listeners[t] || []).forEach((f) => f(e));
  win.matchMedia = () => ({ matches: true });
  const ss = new Map(); if (follow) ss.set("patv.chat.follow", JSON.stringify(follow));
  const sessionStorage = { getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k) };
  const mk = (tag, cls, parent, id) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (id) n.id = id; parent.appendChild(n); return n; };
  const root = mk("main", "cz", doc.body, "cb");
  const btn = mk("button", null, root, "cz-chatbtn"); btn.hidden = true; mk("span", "cz-chat-lbl", btn);
  const panel = mk("aside", "cz-chat", doc.body, "cz-chat"); panel.hidden = true; panel.style.setProperty = (k, v) => { panel.style[k] = v; };
  const h = mk("div", "cz-chat-h", panel); mk("h2", "cz-chat-n", h); const dot = mk("span", "cz-chat-dot", h); dot.hidden = true;
  for (const c of ["cz-chat-pick", "cz-chat-win", "cz-chat-min", "cz-chat-x"]) { const b = mk("button", c, h); mk("span", "ds-ic", b); }
  const bar = mk("div", "cz-chat-bar", panel); bar.hidden = true; mk("span", "cz-chat-bar-t", bar); mk("button", null, bar);
  mk("div", "cz-chat-b", panel);
  const toasts = [];
  win.CZ = { tableId: "0123456789", T: (k, d, v) => String(d).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)), toast: (t) => toasts.push(t), people: () => null };
  const sandbox = { window: win, document: doc, sessionStorage, screen: {}, CustomEvent: Event, location: win.location, setTimeout, clearTimeout, JSON, Date, matchMedia: win.matchMedia };
  sandbox.addEventListener = win.addEventListener;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "casino-chat.js"), "utf8"), sandbox);
  const people = (list) => doc.dispatchEvent(new Event("cz:people", { detail: { ok: true, pads: list } }));
  return { doc, win, panel, btn, ss, toasts, people, frame: () => panel.querySelector("iframe") };
}
const PADS = [{ room: "Dock.Equipped", slug: "night-orchard", name: "Night Orchard", role: "advert", chat: true }, { room: "Dock.Plus", slug: "lantern", name: "Lantern", role: "home", chat: false }];

test("casino-chat: the follow mark opens that pad's chat (advertised pads too) once; old marks, other pads and pads without a chat don't", () => {
  const p = tablePage({ follow: { room: "Dock_Equipped", slug: "night-orchard", at: Date.now() - 30000, audio: 1 } });
  assert.equal(p.ss.has("patv.chat.follow"), false, "read once and dropped");
  p.people(PADS);
  assert.equal(p.btn.hidden, false, "💬 shows: a pad with a chat");
  assert.equal(p.frame().getAttribute("src"), "/p/night-orchard/chat?embed=1#listen", "the chat came along, playing");
  assert.equal(p.frame().getAttribute("allow"), "autoplay"); assert.equal(p.frame().getAttribute("referrerpolicy"), "same-origin");
  assert.deepEqual(p.toasts, ["Your chat came along · ✕ closes it"]);
  // it follows on: the table page leaves the mark when it goes with the chat open
  p.win.dispatch("pagehide");
  const m = JSON.parse(p.ss.get("patv.chat.follow"));
  assert.equal(m.slug, "night-orchard"); assert.equal(m.room, "Dock_Equipped");
  for (const follow of [{ room: "Dock_Equipped", slug: "night-orchard", at: Date.now() - 121000 }, { room: "X", slug: "elsewhere", at: Date.now() }, { room: "Dock_Plus", slug: "lantern", at: Date.now() }]) {
    const q = tablePage({ follow });
    q.people(PADS);
    assert.equal(q.frame(), null, JSON.stringify(follow));
    q.win.dispatch("pagehide");
    assert.equal(q.ss.has("patv.chat.follow"), false, "no chat open: no mark");
  }
});

test("casino-chat: ✕ removes the frame; a retire to its own window shows Bring it here; the frame's 'closed' closes; the phone's turn minimizes", () => {
  const p = tablePage({ width: 390 });
  p.people(PADS);
  p.btn.dispatchEvent(new Event("click"));
  const f = p.frame();
  assert.ok(f, "opened from 💬");
  assert.equal(p.doc.body.classList.contains("cz-chat-sheet"), true, "a phone: the bottom sheet");
  // only that frame's messages count
  const say = (data, source = f.contentWindow, origin = ORIGIN) => p.win.dispatch("message", { data, source, origin });
  f.contentWindow = { postMessage() {} };
  say({ t: "patv-chat:retired", key: "pop_moved" }, {});
  assert.equal(p.panel.querySelector(".cz-chat-bar").hidden, true, "another window's message: ignored");
  say({ t: "patv-chat:retired", key: "pop_moved" }, f.contentWindow, "https://evil.test");
  assert.equal(p.panel.querySelector(".cz-chat-bar").hidden, true, "another origin: ignored");
  p.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: true } }));
  assert.equal(p.doc.body.classList.contains("cz-chat-mini"), true, "your turn: the sheet makes room for the action dock");
  p.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: false } }));
  assert.equal(p.doc.body.classList.contains("cz-chat-mini"), false, "and comes back after your move");
  say({ t: "patv-chat:retired", key: "pop_moved" });
  assert.equal(p.frame(), null, "retired: the frame goes (its poll and audio with it)");
  assert.match(p.panel.querySelector(".cz-chat-bar").textContent, /Chat is open in its own window/);
  p.panel.querySelector(".cz-chat-bar button").dispatchEvent(new Event("click"));
  assert.ok(p.frame(), "Bring it here: a new frame (its pop-open retires the window)");
  const f2 = p.frame(); f2.contentWindow = { postMessage() {} };
  p.win.dispatch("message", { data: { t: "patv-chat:closed", why: "handoff" }, source: f2.contentWindow, origin: ORIGIN });
  assert.equal(p.frame(), null); assert.equal(p.panel.hidden, true);
  assert.deepEqual(p.toasts, ["The chat went back to the pad tab."]);
  p.btn.dispatchEvent(new Event("click"));
  p.panel.querySelector(".cz-chat-x").dispatchEvent(new Event("click"));
  assert.equal(p.frame(), null, "✕: the frame is removed"); assert.equal(p.doc.body.classList.contains("cz-chat-on"), false);
});

test("casino-chat review: the float and the sheet make room while the table needs you (act), docked never; tall grows it; retired collapses", () => {
  for (const [width, kind] of [[900, "float"], [390, "sheet"]]) {
    const p = tablePage({ width });
    p.people(PADS);
    p.btn.dispatchEvent(new Event("click"));
    assert.equal(p.doc.body.classList.contains("cz-chat-" + kind), true, kind);
    p.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: false, act: true } }));
    assert.equal(p.doc.body.classList.contains("cz-chat-mini"), true, kind + ": a Blackjack bet / your turn - minimized (the float covered Raise / All-in)");
    assert.equal(p.doc.body.classList.contains("cz-chat-act"), true);
    p.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: false, act: false } }));
    assert.equal(p.doc.body.classList.contains("cz-chat-mini"), false, kind + ": back after");
    // a sheet in the chat (⚔️ Duel's stake): taller, and un-minimized
    const f = p.frame(); f.contentWindow = { postMessage() {} };
    const say = (data) => p.win.dispatch("message", { data, source: f.contentWindow, origin: ORIGIN });
    p.panel.querySelector(".cz-chat-min").dispatchEvent(new Event("click"));
    assert.equal(p.doc.body.classList.contains("cz-chat-mini"), true);
    say({ t: "patv-chat:tall", on: true });
    assert.equal(p.doc.body.classList.contains("cz-chat-tall"), true); assert.equal(p.doc.body.classList.contains("cz-chat-mini"), false);
    say({ t: "patv-chat:tall", on: false });
    assert.equal(p.doc.body.classList.contains("cz-chat-tall"), false);
  }
  const d = tablePage({ width: 1280 });
  d.people(PADS);
  d.btn.dispatchEvent(new Event("click"));
  assert.equal(d.doc.body.classList.contains("cz-chat-dock"), true);
  d.doc.dispatchEvent(new Event("cz:state", { detail: { act: true } }));
  assert.equal(d.doc.body.classList.contains("cz-chat-mini"), false, "docked beside the table: it covers nothing");
  const f = d.frame(); f.contentWindow = { postMessage() {} };
  d.win.dispatch("message", { data: { t: "patv-chat:retired", key: "pop_moved" }, source: f.contentWindow, origin: ORIGIN });
  assert.equal(d.doc.body.classList.contains("cz-chat-retired"), true);
  assert.equal(d.doc.body.classList.contains("cz-chat-mini"), true, "retired: the bar alone - the table gets its width back");
  assert.equal(d.panel.querySelector(".cz-chat-bar").hidden, false);
  assert.equal(d.btn.getAttribute("aria-expanded"), "false");
  d.panel.querySelector(".cz-chat-bar button").dispatchEvent(new Event("click"));
  assert.equal(d.doc.body.classList.contains("cz-chat-retired"), false); assert.equal(d.doc.body.classList.contains("cz-chat-mini"), false);
  assert.equal(d.btn.getAttribute("aria-expanded"), "true");
  // the panel's title is a link to the pad (the frame's own pad chip is left out - pad-dock.css body.rmd-embed)
  const a = d.panel.querySelector(".cz-chat-n a");
  assert.equal(a.href, "/p/night-orchard"); assert.equal(a.target, "_blank"); assert.equal(a.rel, "noopener");
  assert.match(fs.readFileSync(path.join(repo, "public", "css", "pad-dock.css"), "utf8"), /body\.rmd-pop\.rmd-embed main\.rm\.rm-dock #chatH > \.rmd-chip-chat \{ display: none; \}/);
});

test("casino-chat review F7: the frame's 'not open to you' card closes the panel, says so and asks for the pads again; a chat that came along on your turn starts minimized", () => {
  const p = tablePage({ width: 900 });
  let asked = 0; p.win.CZ.loadPeople = () => { asked++; };
  p.people(PADS);
  p.btn.dispatchEvent(new Event("click"));
  const f = p.frame(); f.contentWindow = { postMessage() {} };
  p.win.dispatch("message", { data: { t: "patv-chat:closed", why: "gate" }, source: f.contentWindow, origin: ORIGIN });
  assert.equal(p.frame(), null); assert.equal(p.panel.hidden, true);
  assert.deepEqual(p.toasts, ["That pad's chat isn't open to you here."]);
  assert.equal(asked, 1, "the table's pads are asked again");
  const q = tablePage({ width: 390, follow: { room: "Dock_Equipped", slug: "night-orchard", at: Date.now() - 1000 } });
  q.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: true, act: true } }));
  q.people(PADS);
  assert.ok(q.frame(), "it came along");
  assert.equal(q.doc.body.classList.contains("cz-chat-mini"), true, "...minimized beside the action dock");
  q.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: false, act: false } }));
  assert.equal(q.doc.body.classList.contains("cz-chat-mini"), false, "...and opens after your move");
});

test("casino review: the table pages emit act for a Blackjack bet / insurance, the docked felt draws a size down, Pepe's role line isn't a login", () => {
  const bj = fs.readFileSync(path.join(repo, "public", "js", "casinobj.js"), "utf8");
  assert.match(bj, /const actNow = !!\(me && open && \(me\.my_turn \|\| me\.can_insure \|\|\s*\(t\.phase === "betting" && t\.bet_deadline && me\.seat && !\(me\.bet > 0\)/);
  assert.match(bj, /detail: \{ myTurn: !!\(me && me\.my_turn\), act: actNow \}/);
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "casinohm.js"), "utf8"), /detail: \{ myTurn: !!\(me && me\.my_turn\), act: !!\(me && me\.my_turn\) \}/);
  const hm = fs.readFileSync(path.join(repo, "views", "casino-hm.ejs"), "utf8");
  assert.match(hm, /@media \(min-width: 1100px\) and \(max-width: 1365px\) \{\s*body\.cz-chat-dock:not\(\.cz-chat-mini\) \.hm-wrap/);
  const cc = fs.readFileSync(path.join(repo, "views", "partials", "casino-chat.ejs"), "utf8");
  assert.match(cc, /body\.cz-chat-dock:not\(\.cz-chat-mini\) main\.cz \{ margin-inline-start: max\(var\(--ds-sp-3, 12px\), calc\(\(100% - var\(--czc-w\) - 1120px\) \/ 2\)\); margin-inline-end: auto;/, "centred left of the panel");
  assert.match(cc, /body\.cz-chat-dock:not\(\.cz-chat-mini\) \.site-foot \{ margin-inline-end: var\(--czc-w\); \}/);
  assert.match(cc, /body\.cz-chat-sheet\.cz-chat-act:not\(\.cz-chat-mini\) \.cz \.dock \{ inset-block-end: calc\(var\(--czc-sheet\) \+ var\(--ds-sp-2, 8px\)\); \}/);
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "casino-ui.js"), "utf8"), /className: "pm-login cz-pm-role"/);
  for (const f of ["casino-hm.ejs", "casino-bj.ejs"]) assert.match(fs.readFileSync(path.join(repo, "views", f), "utf8"), /flair\.css\?v=4/, f);
  // F8: the table pages are never framed by another site
  assert.match(fs.readFileSync(path.join(repo, "casino", "routes.js"), "utf8"), /res\.set\(\{ "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" \}\);/);
});
