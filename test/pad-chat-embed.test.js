"use strict";
// 1.99ajw casino2 (owner 2026-11-04, point 18: "Docking chat doesn't stay active between page switches (like going to holdem). Would be nice
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
//   * tablechat (owner 2026-11-07): the panel's picker lists every pad chat the server says the viewer may open (the table's own on top,
//     Recent, More pads); the search filters in the page, only a full address is asked; recent pads per viewer; a follow mark of another
//     pad is asked of the server (its exact address)
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
// (tablechat: `server` answers the page's fetches - url -> JSON or null; every asked url is kept in `asked`; `local` = localStorage; me / signed)
// (review fixes: `session` = a sessionStorage Map kept across "reloads" of the tab; a server answer {__status: 429} is that HTTP status)
function tablePage({ follow = null, pads = [], width = 1280, server = null, local = null, me = "", signed = true, fine = true, session = null } = {}) {
  const doc = new Document(), win = { listeners: {}, innerWidth: width, location: { origin: ORIGIN, pathname: TABLE } };
  win.addEventListener = (t, f) => { (win.listeners[t] ||= []).push(f); };
  win.dispatch = (t, e) => (win.listeners[t] || []).forEach((f) => f(e));
  win.matchMedia = () => ({ matches: !!fine });
  const ss = session || new Map(); if (follow) ss.set("patv.chat.follow", JSON.stringify(follow));
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
  win.CZ = { tableId: "0123456789", T: (k, d, v) => String(d).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)), toast: (t) => toasts.push(t), people: () => null, me, signed };
  const sandbox = { window: win, document: doc, sessionStorage, screen: {}, CustomEvent: Event, location: win.location, setTimeout, clearTimeout, JSON, Date, matchMedia: win.matchMedia };
  const asked = [];
  if (server) {
    sandbox.fetch = (url) => {
      asked.push(url); const d = server(url), st = d && d.__status;
      return Promise.resolve({ ok: d != null && !st, status: st || (d != null ? 200 : 500), json: () => Promise.resolve(d) });
    };
  }
  if (local) win.localStorage = { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)) };
  sandbox.addEventListener = win.addEventListener;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "casino-chat.js"), "utf8"), sandbox);
  const people = (list, more) => doc.dispatchEvent(new Event("cz:people", { detail: { ok: true, pads: list, more: !!more } }));
  return { doc, win, panel, btn, ss, toasts, people, asked, frame: () => panel.querySelector("iframe") };
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
  for (const f of ["casino-hm.ejs", "casino-bj.ejs"]) assert.match(fs.readFileSync(path.join(repo, "views", f), "utf8"), /flair\.css\?v=5/, f);   // (flairfix: v5)
  // F8: the table pages are never framed by another site
  assert.match(fs.readFileSync(path.join(repo, "casino", "routes.js"), "utf8"), /res\.set\(\{ "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": "frame-ancestors 'self'" \}\);/);
});

// ── tablechat (owner 2026-11-07: "Also for poker table chats, let users pull up any pad chats regardless if its been advertised or added to a
// room chat"): the panel's picker - every pad chat the viewer may open (GET /api/casino/t/:id/chatpads, casino/chatpads.js) ──
const ALL = [{ room: "Dock.Equipped", slug: "night-orchard", name: "Night Orchard", role: "advert", count: 4 },
             { room: "Lily.Pond", slug: "lily-pond", name: "Lily Pond", role: "recent", count: 2 },
             { room: "Big.Room", slug: "big-room", name: "Café Royale", role: "pad", count: 12 },
             { room: "Quiet.Room", slug: "quiet-room", name: "Quiet Room", role: "pad", count: 0 }];
const SECRET = { room: "Hidden.Den", slug: "hidden-den", name: "Hidden Den", role: "pad", count: 3 };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const chatServer = (extra = {}) => (url) => {
  const u = new URL(url, ORIGIN);
  if (u.pathname !== "/api/casino/t/0123456789/chatpads") return null;
  if (u.searchParams.has("slug")) return { ok: true, pad: (extra.bySlug || {})[u.searchParams.get("slug")] || null };
  return { ok: true, pads: extra.pads || ALL };
};
const pickerOf = (p) => p.panel.querySelector(".cz-chat-pk");
const groupsOf = (p) => pickerOf(p).querySelectorAll(".cz-pk-g").map((g) => [g.querySelector(".cz-pk-h").textContent, g.querySelectorAll(".cz-pk-i").map((b) => b.querySelector(".cz-pk-n").textContent)]);
const typeIn = (p, text) => { const q = pickerOf(p).querySelector(".cz-pk-q"); q.value = text; q.dispatchEvent(new Event("input")); return q; };
const key = (el, k) => el.dispatchEvent(new Event("keydown", { key: k, bubbles: true }));

test("tablechat: ▾ opens the picker with EVERY pad the server lists - the table's own on top, Recent, More pads; a pad never advertised here opens in the frame", async () => {
  const p = tablePage({ server: chatServer(), local: new Map(), me: "viewer" });
  p.people(PADS, true);
  p.btn.dispatchEvent(new Event("click"));
  assert.equal(p.frame().getAttribute("src"), "/p/night-orchard/chat?embed=1", "one pad of the table's own: 💬 opens it, as before");
  const pick = p.panel.querySelector(".cz-chat-pick");
  assert.equal(pick.hidden, false, "▾ shows: other pads' chats exist (more)");
  pick.dispatchEvent(new Event("click"));
  assert.ok(pickerOf(p) && !pickerOf(p).hidden, "the picker, in the panel");
  assert.equal(pick.getAttribute("aria-expanded"), "true");
  assert.equal(p.doc.body.classList.contains("cz-chat-pk-on"), true);
  assert.equal(p.doc.body.classList.contains("cz-chat-tall"), true, "tall (room above a phone's keyboard)");
  assert.ok(p.frame(), "the chat keeps running under it");
  assert.equal(p.doc.activeElement, pickerOf(p).querySelector(".cz-pk-q"), "a mouse / keyboard: the search box has focus");
  assert.deepEqual(groupsOf(p), [["At this table", ["Night Orchard"]]], "the table's own pads at once, while the list loads");
  assert.match(pickerOf(p).querySelector(".cz-pk-st").textContent, /Loading pads…/);
  await tick();
  assert.deepEqual(p.asked, ["/api/casino/t/0123456789/chatpads?recent=night-orchard"], "one ask for the whole list, with the pads recently opened at a table");
  assert.deepEqual(groupsOf(p), [["At this table", ["Night Orchard"]], ["Recent", ["Lily Pond"]], ["More pads", ["Café Royale", "Quiet Room"]]]);
  const cur = pickerOf(p).querySelector('[data-slug="night-orchard"]');
  assert.equal(cur.getAttribute("aria-current"), "true"); assert.equal(cur.querySelector(".cz-pk-ic").textContent, "✓");
  assert.equal(cur.querySelector(".cz-pk-m").textContent, "advertised here · p/night-orchard · 4 in the room");
  assert.equal(pickerOf(p).querySelector('[data-slug="quiet-room"] .cz-pk-m').textContent, "p/quiet-room", "nobody in the room: no count");
  assert.equal(pickerOf(p).querySelector(".cz-pk-back").textContent, "‹ Back to Night Orchard");
  pickerOf(p).querySelector('[data-slug="big-room"]').dispatchEvent(new Event("click"));
  assert.equal(p.frame().getAttribute("src"), "/p/big-room/chat?embed=1", "a pad the table never advertised: its chat beside the table");
  assert.equal(pickerOf(p).hidden, true); assert.equal(p.doc.body.classList.contains("cz-chat-pk-on"), false);
  assert.equal(p.panel.querySelector(".cz-chat-n a").href, "/p/big-room");
  assert.deepEqual(JSON.parse(p.ss.get("patv.cz.chat.0123456789")), { u: "viewer", slug: "big-room" }, "remembered for this table in this tab - for this viewer, and no name (review)");
  // a people update that doesn't list it keeps it (any pad's chat may be here); the frame's gate decides access
  p.people(PADS, true);
  assert.equal(p.frame().getAttribute("src"), "/p/big-room/chat?embed=1");
  // ✕ and 💬 again: the pad this tab last opened here
  p.panel.querySelector(".cz-chat-x").dispatchEvent(new Event("click"));
  assert.match(p.btn.querySelector(".cz-chat-lbl").textContent, /Chat · Café Royale/);
  p.btn.dispatchEvent(new Event("click"));
  assert.equal(p.frame().getAttribute("src"), "/p/big-room/chat?embed=1");
});

test("tablechat: the search filters in the page (nothing typed is sent); p/<address> or Enter with no match asks for that one pad; Escape clears, then closes", async () => {
  const p = tablePage({ server: chatServer({ bySlug: { "hidden-den": SECRET } }), local: new Map(), me: "viewer" });
  p.people([], true);
  assert.equal(p.btn.hidden, false, "no pad of the table's own, but other pads' chats exist: 💬 shows");
  assert.equal(p.btn.querySelector(".cz-chat-lbl").textContent, "Chat");
  p.btn.dispatchEvent(new Event("click"));
  assert.ok(pickerOf(p) && !pickerOf(p).hidden, "💬 with no table pad: the picker");
  assert.equal(p.frame(), null);
  assert.equal(p.panel.querySelector(".cz-chat-n").textContent, "Pick a pad's chat");
  assert.equal(p.panel.querySelector(".cz-chat-win").hidden, true, "no chat yet: no ↗️");
  await tick();
  typeIn(p, "cafe");
  assert.deepEqual(groupsOf(p), [["More pads", ["Café Royale"]]], "by name, accents folded");
  typeIn(p, "QUIET-ro");
  assert.deepEqual(groupsOf(p), [["More pads", ["Quiet Room"]]], "by address");
  typeIn(p, "lily pond");
  assert.deepEqual(groupsOf(p), [["Recent", ["Lily Pond"]]], "spaces match the address's dashes too");
  typeIn(p, "zebra");
  assert.deepEqual(groupsOf(p), []);
  assert.equal(pickerOf(p).querySelector(".cz-pk-st").textContent, "No pad matches “zebra”.");
  await tick(400);
  assert.equal(p.asked.length, 1, "a name with no match is never sent");
  typeIn(p, "p/hidden-den");
  assert.match(pickerOf(p).querySelector(".cz-pk-st").textContent, /Press Enter to look up p\/hidden-den/, "(review: asked after a pause in the typing)");
  await tick(800);
  assert.deepEqual(p.asked.slice(1), ["/api/casino/t/0123456789/chatpads?slug=hidden-den"], "an address typed as one: that one pad is asked");
  assert.deepEqual(groupsOf(p), [["By address", ["Hidden Den"]]]);
  typeIn(p, "https://publicaccess.tv/p/night-gone");
  await tick(800);
  assert.equal(p.asked.at(-1), "/api/casino/t/0123456789/chatpads?slug=night-gone", "a pasted link");
  assert.equal(pickerOf(p).querySelector(".cz-pk-st").textContent, "No pad matches “https://publicaccess.tv/p/night-gone”.", "the server said no: nothing");
  const q = typeIn(p, "hidden-den");
  assert.deepEqual(groupsOf(p), [["By address", ["Hidden Den"]]], "(asked already this session)");
  typeIn(p, "other-den");
  key(q, "Enter");
  await tick(20);
  assert.equal(p.asked.at(-1), "/api/casino/t/0123456789/chatpads?slug=other-den", "Enter with no match: asks for it as an address");
  typeIn(p, "royale");
  key(q, "Enter");
  assert.equal(p.frame().getAttribute("src"), "/p/big-room/chat?embed=1", "Enter: the first match");
  // Escape: clears the box first, then closes the picker (back to the chat)
  p.panel.querySelector(".cz-chat-pick").dispatchEvent(new Event("click"));
  const q2 = typeIn(p, "lily");
  key(q2, "Escape");
  assert.equal(q2.value, ""); assert.equal(pickerOf(p).hidden, false);
  key(q2, "Escape");
  assert.equal(pickerOf(p).hidden, true); assert.equal(p.frame().getAttribute("src"), "/p/big-room/chat?embed=1", "the chat that was open");
  assert.equal(p.doc.activeElement, p.panel.querySelector(".cz-chat-pick"), "focus back on ▾");
  const src = fs.readFileSync(path.join(repo, "public", "js", "casino-chat.js"), "utf8");
  assert.doesNotMatch(src, /[?&]q=/, "no search term parameter at all");
});

test("tablechat: arrows move through the pads; ✕ while picking closes the panel; a phone gets the list focused (no keyboard popping up)", async () => {
  const p = tablePage({ server: chatServer(), local: new Map(), me: "viewer", width: 390, fine: false });
  p.people([], true);
  p.btn.dispatchEvent(new Event("click"));
  assert.equal(p.doc.body.classList.contains("cz-chat-sheet"), true);
  assert.equal(p.doc.activeElement, pickerOf(p), "touch: the picker region, not the search box");
  await tick();
  const q = pickerOf(p).querySelector(".cz-pk-q");
  key(q, "ArrowDown");
  assert.equal(p.doc.activeElement.getAttribute("data-slug"), "night-orchard");
  key(p.doc.activeElement, "ArrowDown");
  assert.equal(p.doc.activeElement.getAttribute("data-slug"), "lily-pond");
  key(p.doc.activeElement, "End");
  assert.equal(p.doc.activeElement.getAttribute("data-slug"), "quiet-room");
  key(p.doc.activeElement, "Home"); key(p.doc.activeElement, "ArrowUp");
  assert.equal(p.doc.activeElement, q, "up from the first pad: the search box");
  // your turn on a phone: the sheet makes room (the picker too), and comes back
  p.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: true, act: true } }));
  assert.equal(p.doc.body.classList.contains("cz-chat-mini"), true);
  p.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: false, act: false } }));
  assert.equal(p.doc.body.classList.contains("cz-chat-mini"), false); assert.equal(pickerOf(p).hidden, false);
  p.panel.querySelector(".cz-chat-x").dispatchEvent(new Event("click"));
  assert.equal(p.panel.hidden, true); assert.equal(p.doc.body.classList.contains("cz-chat-on"), false);
});

test("tablechat: recent pads are kept per viewer (another account's list is ignored) and ride along with the list ask; guests get the sign-in link", async () => {
  const local = new Map();
  const p = tablePage({ server: chatServer(), local, me: "Viewer" });
  p.people([], true);
  p.btn.dispatchEvent(new Event("click")); await tick();
  pickerOf(p).querySelector('[data-slug="quiet-room"]').dispatchEvent(new Event("click"));
  p.panel.querySelector(".cz-chat-pick").dispatchEvent(new Event("click"));
  pickerOf(p).querySelector('[data-slug="big-room"]').dispatchEvent(new Event("click"));
  assert.deepEqual(JSON.parse(local.get("patv.cz.chat.recent")), { u: "viewer", s: ["big-room", "quiet-room"] });
  assert.equal(pickerOf(p).querySelector(".cz-pk-foot").hidden, true, "signed in: no sign-in line");
  // the next table page, same account: the recent slugs are sent (the server checks each again)
  const q = tablePage({ server: chatServer(), local, me: "viewer" });
  q.people([], true);
  q.btn.dispatchEvent(new Event("click")); await tick();
  assert.deepEqual(q.asked, ["/api/casino/t/0123456789/chatpads?recent=" + encodeURIComponent("big-room,quiet-room")]);
  // another account on this browser: not theirs
  const o = tablePage({ server: chatServer(), local, me: "someone-else" });
  o.people([], true);
  o.btn.dispatchEvent(new Event("click")); await tick();
  assert.deepEqual(o.asked, ["/api/casino/t/0123456789/chatpads"]);
  // a guest: the list (Public pads - the server's rule) and a sign-in link back to this table
  const g = tablePage({ server: chatServer(), local: new Map(), signed: false });
  g.people([], true);
  g.btn.dispatchEvent(new Event("click")); await tick();
  const a = pickerOf(g).querySelector(".cz-pk-foot a");
  assert.equal(pickerOf(g).querySelector(".cz-pk-foot").hidden, false);
  assert.equal(a.href, "/login?next=" + encodeURIComponent(TABLE)); assert.equal(a.textContent, "Sign in for members' pads");
});

test("tablechat: the list failing says so with Try again; no pads at all says so; 💬 hides when there's nothing to open", async () => {
  let fail = true;
  const p = tablePage({ server: (url) => (fail ? null : chatServer({ pads: [] })(url)), local: new Map() });
  p.people([], false);
  assert.equal(p.btn.hidden, true, "no table pad and nothing more: no 💬");
  p.people([], true);
  p.btn.dispatchEvent(new Event("click")); await tick();
  const st = pickerOf(p).querySelector(".cz-pk-st");
  assert.match(st.textContent, /Couldn't load the pads\./);
  fail = false;
  st.querySelector("button").dispatchEvent(new Event("click")); await tick();
  assert.equal(pickerOf(p).querySelector(".cz-pk-st").textContent, "No pad chats are open to you right now.");
});

test("tablechat: the follow mark of a pad this table doesn't play in asks the server (its exact address) and opens if it may; never a table pad that said no", async () => {
  const p = tablePage({ follow: { room: "Big_Room", slug: "big-room", at: Date.now() - 1000, audio: 1 }, server: chatServer({ bySlug: { "big-room": ALL[2] } }), local: new Map() });
  p.people(PADS, true);
  await tick();
  assert.deepEqual(p.asked, ["/api/casino/t/0123456789/chatpads?slug=big-room"]);
  assert.equal(p.frame().getAttribute("src"), "/p/big-room/chat?embed=1#listen", "it came along, playing");
  assert.deepEqual(p.toasts, ["Your chat came along · ✕ closes it"]);
  const q = tablePage({ follow: { room: "Gone", slug: "gone-pad", at: Date.now() - 1000 }, server: chatServer(), local: new Map() });
  q.people(PADS, true); await tick();
  assert.equal(q.frame(), null, "the server said no");
  const r = tablePage({ follow: { room: "Dock_Plus", slug: "lantern", at: Date.now() - 1000 }, server: chatServer({ bySlug: { lantern: { room: "Dock.Plus", slug: "lantern", name: "Lantern", role: "home" } } }), local: new Map() });
  r.people(PADS, true); await tick();
  assert.deepEqual(r.asked, [], "a table pad whose chat said no isn't asked again");
  assert.equal(r.frame(), null);
  // a table pad whose chat stops being yours closes (the frame shows its own card too)
  const s = tablePage({ server: chatServer(), local: new Map() });
  s.people(PADS, true);
  s.btn.dispatchEvent(new Event("click"));
  assert.ok(s.frame());
  s.people([{ ...PADS[0], chat: false }, PADS[1]], true);
  assert.equal(s.frame(), null, "chat: false for the open table pad - closed");
});

// ── tablechat review fixes (access + UX reviews, 2026-11-07) ──
const PICK = "patv.cz.chat.0123456789";
const sayTo = (p, data) => { const f = p.frame(); f.contentWindow = f.contentWindow || { postMessage() {} }; p.win.dispatch("message", { data, source: f.contentWindow, origin: ORIGIN }); };
const has = (p, cls) => p.doc.body.classList.contains(cls);
const statusOf = (p) => pickerOf(p).querySelector(".cz-pk-st").textContent;

test("tablechat review: a picked pad whose chat closes to you is forgotten (this tab's pick, Recent) - 💬 never reopens it; the picker opens to choose another", async () => {
  const session = new Map(), local = new Map();
  const p = tablePage({ server: chatServer(), local, session, me: "viewer" });
  p.people(PADS, true);
  p.btn.dispatchEvent(new Event("click"));
  p.panel.querySelector(".cz-chat-pick").dispatchEvent(new Event("click")); await tick();
  pickerOf(p).querySelector('[data-slug="big-room"]').dispatchEvent(new Event("click"));
  assert.equal(p.frame().getAttribute("src"), "/p/big-room/chat?embed=1");
  assert.deepEqual(JSON.parse(local.get("patv.cz.chat.recent")).s, ["big-room", "night-orchard"]);
  // the pad went offline / banned you / changed its level: the frame answers the card
  sayTo(p, { t: "patv-chat:closed", why: "gate" });
  assert.equal(p.frame(), null, "the frame is gone");
  assert.deepEqual(p.toasts, ["That pad's chat isn't open to you here."]);
  assert.equal(session.has(PICK), false, "this tab's pick for the table is forgotten");
  assert.deepEqual(JSON.parse(local.get("patv.cz.chat.recent")).s, ["night-orchard"], "and it leaves Recent");
  assert.equal(p.panel.hidden, false); assert.equal(pickerOf(p).hidden, false, "the picker, to choose another pad");
  assert.equal(p.btn.querySelector(".cz-chat-lbl").textContent, "Chat · Night Orchard", "💬 names what it opens: the table's own pad");
  p.panel.querySelector(".cz-chat-x").dispatchEvent(new Event("click"));
  for (let i = 0; i < 3; i++) {
    p.btn.dispatchEvent(new Event("click"));
    assert.equal(p.frame().getAttribute("src"), "/p/night-orchard/chat?embed=1", "💬 #" + (i + 1) + ": never the dead pad");
    p.panel.querySelector(".cz-chat-x").dispatchEvent(new Event("click"));
  }
  // the frame's own "isn't available to you any more" card (a 403 mid-chat) and its ✕: forgotten the same way (no toast - the card said it)
  p.btn.dispatchEvent(new Event("click"));
  p.panel.querySelector(".cz-chat-pick").dispatchEvent(new Event("click")); await tick();
  pickerOf(p).querySelector('[data-slug="quiet-room"]').dispatchEvent(new Event("click"));
  sayTo(p, { t: "patv-chat:retired", key: "pop_unavail" });
  sayTo(p, { t: "patv-chat:closed", why: "pop_unavail" });
  assert.equal(p.panel.hidden, true); assert.equal(session.has(PICK), false);
  assert.ok(!JSON.parse(local.get("patv.cz.chat.recent")).s.includes("quiet-room"));
  assert.equal(p.toasts.length, 1);
});

test("tablechat review: a saved pick that isn't one of the table's pads is confirmed by the server first - never its stored name; gone = the picker", async () => {
  // a reload of the tab: the pick says Quiet Room, the server now says no
  const session = new Map([[PICK, JSON.stringify({ u: "viewer", room: "Quiet.Room", slug: "quiet-room", name: "Quiet Room", role: "pad" })]]);
  const p = tablePage({ server: chatServer({ bySlug: {} }), local: new Map(), session, me: "viewer" });
  p.people([], true);
  assert.equal(p.btn.querySelector(".cz-chat-lbl").textContent, "Chat", "until the server says so: no stored name");
  await tick();
  assert.deepEqual(p.asked, ["/api/casino/t/0123456789/chatpads?slug=quiet-room"], "one ask for the saved pick");
  assert.equal(session.has(PICK), false, "the server said no: forgotten");
  p.btn.dispatchEvent(new Event("click")); await tick();
  assert.equal(p.frame(), null, "no frame for the dead pad"); assert.equal(pickerOf(p).hidden, false, "the picker instead");
  // still open to you: the server's name (not the stored one) and 💬 opens it
  const s2 = new Map([[PICK, JSON.stringify({ u: "viewer", room: "Big.Room", slug: "big-room", name: "Old Name", role: "pad" })]]);
  const q = tablePage({ server: chatServer({ bySlug: { "big-room": ALL[2] } }), local: new Map(), session: s2, me: "viewer" });
  q.people([], true);
  assert.equal(q.btn.querySelector(".cz-chat-lbl").textContent, "Chat");
  await tick();
  assert.equal(q.btn.querySelector(".cz-chat-lbl").textContent, "Chat · Café Royale", "the server's name");
  q.btn.dispatchEvent(new Event("click")); await tick();
  assert.equal(q.frame().getAttribute("src"), "/p/big-room/chat?embed=1");
  assert.equal(q.panel.querySelector(".cz-chat-n a").textContent, "Café Royale");
  // a click before the answer waits for it (one ask, no frame of an unconfirmed pad)
  const s3 = new Map([[PICK, JSON.stringify({ u: "viewer", room: "Big.Room", slug: "big-room", name: "Café Royale", role: "pad" })]]);
  const r = tablePage({ server: chatServer({ bySlug: { "big-room": ALL[2] } }), local: new Map(), session: s3, me: "viewer" });
  r.people([], true);
  r.btn.dispatchEvent(new Event("click"));
  assert.equal(r.frame(), null, "not before the server answers");
  await tick();
  assert.equal(r.frame().getAttribute("src"), "/p/big-room/chat?embed=1");
  assert.equal(r.asked.filter((u) => /slug=big-room/.test(u)).length, 1, "asked once");
  // a table pad that now says chat: false is forgotten without asking
  const s4 = new Map([[PICK, JSON.stringify({ u: "viewer", room: "Dock.Plus", slug: "lantern", name: "Lantern", role: "home" })]]);
  const t = tablePage({ server: chatServer(), local: new Map(), session: s4, me: "viewer" });
  t.people(PADS, true);
  await tick();
  assert.deepEqual(t.asked, []); assert.equal(s4.has(PICK), false);
  assert.equal(t.btn.querySelector(".cz-chat-lbl").textContent, "Chat · Night Orchard");
});

test("tablechat review: the saved pick is the viewer's - another account or a guest in the same tab never sees its name or opens it; 1.99ajw's bare slug counts only for a table pad", async () => {
  const session = new Map([[PICK, JSON.stringify({ u: "boss", room: "Approved.Pad", slug: "approved-pad", name: "Secret Garden", role: "pad" })]]);
  const g = tablePage({ server: chatServer({ bySlug: { "approved-pad": { room: "Approved.Pad", slug: "approved-pad", name: "Secret Garden", role: "pad" } } }), local: new Map(), session, signed: false, me: "" });
  g.people(PADS, true);
  await tick();
  assert.equal(g.btn.querySelector(".cz-chat-lbl").textContent, "Chat · Night Orchard", "the table's own pad, never the other account's pick");
  assert.deepEqual(g.asked, [], "not even asked about");
  g.btn.dispatchEvent(new Event("click"));
  assert.equal(g.frame().getAttribute("src"), "/p/night-orchard/chat?embed=1");
  assert.doesNotMatch(g.panel.textContent, /Secret Garden/);
  const old = new Map([[PICK, "big-room"]]);
  const o = tablePage({ server: chatServer({ bySlug: { "big-room": ALL[2] } }), local: new Map(), session: old, me: "viewer" });
  o.people(PADS, true); await tick();
  assert.deepEqual(o.asked, [], "a bare slug from 1.99ajw: not a table pad - ignored");
  assert.equal(o.btn.querySelector(".cz-chat-lbl").textContent, "Chat · Night Orchard");
  const tbl = new Map([[PICK, "night-orchard"]]);
  const k = tablePage({ server: chatServer(), local: new Map(), session: tbl, me: "viewer" });
  k.people([PADS[0], { room: "Two.Pad", slug: "two-pad", name: "Two", role: "home", chat: true }], true);
  assert.equal(k.btn.querySelector(".cz-chat-lbl").textContent, "Chat · Night Orchard", "a bare slug of a table pad: as before");
});

test("tablechat review: the picker never grows over the action dock while the table needs you (phone sheet / float); it grows again after", async () => {
  for (const [width, kind] of [[390, "sheet"], [900, "float"]]) {
    const p = tablePage({ server: chatServer(), local: new Map(), me: "viewer", width, fine: width > 760 });
    p.people([], true);
    p.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: true, act: true } }));
    p.btn.dispatchEvent(new Event("click"));
    assert.equal(has(p, "cz-chat-" + kind), true);
    assert.equal(has(p, "cz-chat-pk-on"), true, kind + ": the picker you opened on your turn");
    assert.equal(has(p, "cz-chat-act"), true);
    assert.equal(has(p, "cz-chat-tall"), false, kind + ": not tall while it's your turn (Fold / Call / Raise stay above it)");
    p.doc.dispatchEvent(new Event("cz:state", { detail: { myTurn: false, act: false } }));
    assert.equal(has(p, "cz-chat-tall"), true, kind + ": your move made - tall again (room above the keyboard)");
  }
});

test("tablechat review: an address typed is matched by its start in the list; the server is asked only after a pause with no pad of that start (or Enter); a refused or failed lookup isn't 'no pad'", async () => {
  let rate = false, down = false;
  const srv = chatServer({ bySlug: { "hidden-den": SECRET } });
  const p = tablePage({ server: (u) => (/slug=/.test(u) && rate ? { __status: 429 } : /slug=/.test(u) && down ? null : srv(u)), local: new Map(), me: "viewer" });
  p.people([], true);
  p.btn.dispatchEvent(new Event("click")); await tick();
  typeIn(p, "p/");
  assert.equal(groupsOf(p).flatMap((g) => g[1]).length, 4, "p/ alone: every pad");
  for (const s of ["p/b", "p/big", "p/big-ro", "p/big-roo", "https://publicaccess.tv/p/big-r"]) {
    typeIn(p, s);
    assert.deepEqual(groupsOf(p), [["More pads", ["Café Royale"]]], s + ": the pad whose address starts so");
    assert.equal(pickerOf(p).querySelector(".cz-pk-st").hidden, true, s + ": no 'No pad matches' while typing");
  }
  await tick(800);
  assert.equal(p.asked.filter((u) => /slug=/.test(u)).length, 0, "a pad in the list starts with it: never asked");
  // phone-pace typing of an address no listed pad starts with: one ask, after the pause
  for (const s of ["p/hi", "p/hid", "p/hidden", "p/hidden-de", "p/hidden-den"]) {
    typeIn(p, s);
    assert.match(statusOf(p), /Press Enter to look up p\//, s + ": a hint, not 'No pad matches'");
    await tick(420);
  }
  assert.equal(p.asked.filter((u) => /slug=/.test(u)).length, 0, "no ask while typing (each pause under the wait)");
  await tick(400);
  assert.deepEqual(p.asked.filter((u) => /slug=/.test(u)), ["/api/casino/t/0123456789/chatpads?slug=hidden-den"], "one ask, for the whole address");
  assert.deepEqual(groupsOf(p), [["By address", ["Hidden Den"]]]);
  // Enter asks at once
  const q = typeIn(p, "p/other-den");
  key(q, "Enter"); await tick(20);
  assert.equal(p.asked.at(-1), "/api/casino/t/0123456789/chatpads?slug=other-den");
  assert.equal(statusOf(p), "No pad matches “p/other-den”.", "the server said no pad");
  // rate-limited: says so, isn't remembered as 'no pad'; Try again asks again
  rate = true;
  typeIn(p, "p/rate-den"); key(q, "Enter"); await tick(20);
  assert.match(statusOf(p), /Slow down/); assert.doesNotMatch(statusOf(p), /No pad matches/);
  rate = false;
  pickerOf(p).querySelector(".cz-pk-st button").dispatchEvent(new Event("click")); await tick(20);
  assert.equal(p.asked.filter((u) => /slug=rate-den/.test(u)).length, 2, "asked again");
  assert.equal(statusOf(p), "No pad matches “p/rate-den”.");
  // a network error: the same
  down = true;
  typeIn(p, "p/down-den"); key(q, "Enter"); await tick(20);
  assert.match(statusOf(p), /Couldn't look up p\/down-den/);
  down = false;
  key(q, "Enter"); await tick(20);
  assert.equal(statusOf(p), "No pad matches “p/down-den”.", "Enter tries again");
});

test("tablechat review: 💬 while the picker is over a chat closes the picker only; focus lands on ▾ after a pick; the header says a chat isn't the table's; a pick moves to Recent at once; Back is 44px on a phone", async () => {
  const p = tablePage({ server: chatServer(), local: new Map(), me: "viewer" });
  p.people(PADS, true);
  p.btn.dispatchEvent(new Event("click"));
  assert.equal(p.panel.querySelector(".cz-chat-sub"), null, "the table's own pad: no note");
  const pick = p.panel.querySelector(".cz-chat-pick");
  pick.dispatchEvent(new Event("click")); await tick();
  p.btn.dispatchEvent(new Event("click"));
  assert.equal(pickerOf(p).hidden, true, "the picker closed");
  assert.equal(p.frame().getAttribute("src"), "/p/night-orchard/chat?embed=1", "the chat under it stays");
  assert.equal(p.panel.hidden, false); assert.equal(p.btn.getAttribute("aria-expanded"), "true");
  p.btn.dispatchEvent(new Event("click"));
  assert.equal(p.panel.hidden, true, "a second press closes the chat");
  p.btn.dispatchEvent(new Event("click"));
  pick.dispatchEvent(new Event("click")); await tick();
  const item = pickerOf(p).querySelector('[data-slug="big-room"]');
  item.focus(); item.dispatchEvent(new Event("click"));      // (Enter on a focused pad = its click)
  assert.equal(p.doc.activeElement, pick, "focus on ▾, not lost to the page");
  assert.equal(p.panel.querySelector(".cz-chat-sub").textContent, "Not this table's chat · p/big-room", "the header says where you'd be typing (the note first: a narrow header cuts the address)");
  pick.dispatchEvent(new Event("click"));
  assert.deepEqual(groupsOf(p), [["At this table", ["Night Orchard"]], ["Recent", ["Café Royale", "Lily Pond"]], ["More pads", ["Quiet Room"]]], "the pick is in Recent at once");
  pickerOf(p).querySelector('[data-slug="night-orchard"]').dispatchEvent(new Event("click"));
  assert.equal(p.panel.querySelector(".cz-chat-sub"), null, "back on the table's pad: no note");
  const css = fs.readFileSync(path.join(repo, "views", "partials", "casino-chat.ejs"), "utf8");
  assert.match(css, /body\.cz-chat-sheet \.cz-pk-back \{[^}]*min-height: 44px/, "a phone's Back is a 44px target");
  assert.match(css, /\.cz-chat-sub \{/);
});
