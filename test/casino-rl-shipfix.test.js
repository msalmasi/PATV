"use strict";
// 1.99aoj - the release review's fixes, on a temp DB and in vms (invented accounts a..d and invented rooms only):
//   * the navbar (views/layout.ejs #navMark): the lobby's 🛞 Roulette link (/casino/blackjack#roulette) is the current one on that tab
//     and on the roulette pages - Blackjack gives way to it there - and following a menu link, or a new #tab, closes the More / ☰ menu
//   * Host Tools (public/js/casino-ui.js hostTools on the real partials): a room where roulette is off (rooms[].off) is greyed and named
//     in the push and advert pickers, a room where a card table's game is off in its advert picker; Add / Advertise hide once nothing is
//     left to pick; a wheel's sheet says "The wheel" / "Close the wheel" / "This wheel is on Pepe's stream." (Blackjack's unchanged)
//   * the lobby's Open cards: roulette.open false hides "Open a wheel", hr_open false the 💎 wheel section (and an empty 💎 card)
//   * the server: rl_hr_spin_cap 0 closes the 💎 wheels (saved and kept; refused at open, web and room: E_HR_CLOSED; an open one takes
//     no new line: E_BANK); rl_web_open off | staff | everyone says who opens a web wheel of their own (room wheels, the lobby wheel and
//     play unaffected); the lobby answer says open / hr_open
//   * Pepe's links: the poll's lobby.roulette is the lobby's 🛞 tab by the navbar's rule, and so is !rl's "No wheel here" reply
//   * the home page: a wheel reads as a 🛞 wheel with players; the tables line names each game once
//   node --test test/casino-rl-shipfix.test.js
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");
const ejs = require("ejs");
const { partial, page, flush } = require("./fixtures/casino-dom");
const h = require("./fixtures/casino-rl-harness");
const { svc, sql, act, actor, lobby, expect, repo } = h;
const RLCFG = require("../casino/roulette");

let n = 0;
const openWeb = (uid, hr) => svc.act(actor(uid), "start", hr ? ["hr"] : [], { room: null, game: "roulette" }, "shipfix-open-" + uid + "-" + ++n);
const openRoom = (uid, roomId, words = []) =>
  svc.act({ ...actor(uid, "room"), room: roomId }, "start", words, { room: roomId, game: "roulette" }, "shipfix-start-" + uid + "-" + ++n);
const highRoller = (uid) => sql("INSERT OR IGNORE INTO user_roles (userId, role) VALUES (?, 'High Roller')", [uid]);
async function server(t, bot = false) {
  const express = require("express"),
    app = express();
  app.use(express.json());
  const addUser = (q, r, next) => {
    const id = q.get("x-test-user");
    q.user = id ? { userId: id, username: "player" + id } : null;
    next();
  };
  require("../casino/routes").register(app, { isBotToken: (x) => bot && x === "localtest", addUser });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  t.after(() => srv.close());
  return async (p, user, b) => {
    const r = await fetch("http://127.0.0.1:" + srv.address().port + p, {
      method: b ? "POST" : "GET",
      redirect: "manual",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "x-test-user": user || "" },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
let booted = false;
async function fresh() {
  if (!booted) {
    await h.initialize();
    booted = true;
  }
  await h.fresh();
  await sql("DELETE FROM user_roles");
}
test.after(() => svc.stop());

// ── the navbar ──
const layout = path.join(repo, "views", "layout.ejs");
/** the rendered navbar's #navMark script in a vm: anchors per menu (More / ☰) from the real render, a click, a hashchange */
async function navbar(pathname, hash, locals) {
  const html = await ejs.renderFile(layout, Object.assign({ title: "T", ogPath: pathname, user: "someuser", casinoOn: () => true, rouletteOn: () => true }, locals || {}));
  const m = /<script id="navMark">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "the navbar's marker script (#navMark)");
  const nav = /<nav class="navbar">[\s\S]*?<\/nav>/.exec(html)[0];
  const menus = [],
    links = [];
  for (const cls of ["nav-more", "nav-burger"]) {
    const box = new RegExp('<details class="' + cls + '">[\\s\\S]*?</details>').exec(nav)[0];
    const d = { cls, open: false, kids: [], removeAttribute(a) { if (a === "open") this.open = false; }, contains(x) { return x === this || this.kids.includes(x); } };
    for (const [, href] of box.matchAll(/<a href="([^"]*)" class="nav-link/g)) {
      const set = new Set();
      const a = { href, menu: d, getAttribute: (k) => (k === "href" ? href : null), classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) } };
      a.closest = (q) => (q === "a[href]" ? a : null);
      d.kids.push(a);
      links.push(a);
    }
    menus.push(d);
  }
  const summary = { closest: () => null };
  menus.forEach((d) => d.kids.push(summary));
  const L = { click: [], keydown: [], hashchange: [] };
  const location = { pathname, hash };
  const document = {
    querySelectorAll: (q) => (q === ".navbar .nav-link" ? links : q === ".navbar details[open]" ? menus.filter((d) => d.open) : []),
    addEventListener: (t, f) => (L[t] = L[t] || []).push(f),
  };
  const window = { addEventListener: (t, f) => (L[t] = L[t] || []).push(f) };
  vm.runInNewContext(m[1], { window, document, location });
  const current = (href) => links.filter((a) => a.href === href).map((a) => a.classList.contains("current"));
  return {
    links, menus, window, location, current, summary,
    click: (target) => L.click.forEach((f) => f({ target })),
    hashchange: (hs) => { location.hash = hs; L.hashchange.forEach((f) => f({})); },
  };
}

test("navbar: the lobby's 🛞 Roulette link is the current one on the Roulette tab and the roulette pages; Blackjack gives way to it there", async () => {
  let N = await navbar("/casino/blackjack", "#roulette");
  assert.ok(N.links.some((a) => a.href === "/casino/blackjack#roulette"), "the lobby tab's link (the casino's front end is the PATV casino)");
  assert.deepEqual(N.current("/casino/blackjack#roulette"), [true, true], "More and ☰ alike");
  assert.deepEqual(N.current("/casino/blackjack"), [true, true].map(() => false), "Blackjack isn't current on the Roulette tab");
  N = await navbar("/casino/blackjack", "");
  assert.deepEqual(N.current("/casino/blackjack"), [true, true]);
  assert.deepEqual(N.current("/casino/blackjack#roulette"), [false, false]);
  N = await navbar("/casino/blackjack", "#all");
  assert.deepEqual(N.current("/casino/blackjack"), [true, true], "another tab of the lobby: Blackjack, as before");
  N = await navbar("/casino/roulette/t/abcdef0123", "");
  assert.deepEqual(N.current("/casino/blackjack#roulette"), [true, true], "a wheel's own page marks Roulette");
  assert.deepEqual(N.current("/casino/blackjack"), [false, false]);
  // neither game on the PATV casino: the link is /casino/roulette, current on the wheel pages (as before)
  N = await navbar("/casino/roulette/t/abcdef0123", "", { casinoOn: () => false });
  assert.deepEqual(N.current("/casino/roulette"), [true, true]);
  // a lobby tab picked by its button (replaceState: no hashchange) - casino-ui.js calls window.patvNavMark
  N = await navbar("/casino/blackjack", "");
  N.location.hash = "#roulette";
  N.window.patvNavMark();
  assert.deepEqual(N.current("/casino/blackjack#roulette"), [true, true]);
  assert.deepEqual(N.current("/casino/blackjack"), [false, false]);
});

test("navbar: following a link in the More / ☰ menu closes it - a hash-only link (the Roulette tab) never reloads the page; a new #tab closes it too", async () => {
  const N = await navbar("/casino/blackjack", "#all");
  const [more, burger] = N.menus;
  const rl = more.kids.find((a) => a.href === "/casino/blackjack#roulette");
  more.open = true;
  N.click(N.summary);
  assert.equal(more.open, true, "a click on the menu's own button keeps it (the native toggle)");
  N.click(rl);
  assert.equal(more.open, false, "the Roulette link closes More (it stayed open over the page)");
  N.hashchange("#roulette");
  assert.deepEqual(N.current("/casino/blackjack#roulette"), [true, true], "the hashchange re-marks");
  burger.open = true;
  N.hashchange("#bj");
  assert.equal(burger.open, false, "a new #tab closes ☰ (on a phone it covers the screen)");
  assert.deepEqual(N.current("/casino/blackjack"), [true, true]);
  burger.open = true;
  N.click({ closest: () => null });
  assert.equal(burger.open, false, "a click elsewhere closes it, as before");
});

// ── Host Tools ──
const TID = "abcdef0123";
function hostPage(game, rooms, extra, me) {
  const g = game === "bj" ? "bj" : game;
  const top = partial("casino-top", { game: g, tableId: TID });
  const sheets = partial("casino-sheets", game === "roulette" ? { game: "roulette" } : {});
  const table = Object.assign({ id: TID, game: g, status: "open", phase: "betting", rooms: [], room: null, adverts: [], on_stream: false, stream_queue: null,
    host: "Ann", seats: [], history: [], commitment: null, last_revealed: null }, extra || {});
  return page(`<main class="ds-page flow cz${game === "roulette" ? " rl-page" : ""}" id="cb" data-game="${g}" data-table="${TID}" data-signed="1" data-user="ann">${top}` +
              `<section id="cz-table"><strong id="cz-msg"></strong><div id="cz-dock"></div></section>${sheets}</main>`,
              { ["/api/casino/t/" + TID]: { ok: true, now: Date.now(), table, me: Object.assign({ name: "Ann", host: true, admin: false, balance: 1000 }, me || {}), rooms },
                post: () => ({ ok: true, reply: "ok" }) }, {});
}
const opts = (P, id) => P.$(id).querySelectorAll("option").map((o) => [o.getAttribute("value"), "disabled" in o.attrs, o.textContent]);
async function hosted(game, rooms, extra, me) {
  const P = hostPage(game, rooms, extra, me);
  P.CZ.wireHost(() => {}, () => {});
  P.CZ.startTable(() => {});
  await flush();
  await flush();
  return P;
}

test("Host Tools: a room where roulette is off is greyed and named in both pickers (the server refuses it); Add / Advertise hide once nothing is left", async () => {
  const LOUNGE = { id: "r-lounge", name: "Test Lounge", busy: false, off: false, games: { bj: true, holdem: true, roulette: true } };
  const QUIET = { id: "r-quiet", name: "Quiet Room", busy: false, off: true, games: { bj: true, holdem: true, roulette: false } };
  let P = await hosted("roulette", [LOUNGE, QUIET]);
  assert.equal(P.$("cz-hostbtn").hidden, false, "the host's Host Tools");
  assert.deepEqual(opts(P, "cz-room"), [["r-lounge", false, "Test Lounge"], ["r-quiet", true, "Quiet Room · roulette is off here"]]);
  assert.deepEqual(opts(P, "cz-adroom"), [["r-lounge", false, "Test Lounge"], ["r-quiet", true, "Quiet Room · roulette is off here"]]);
  assert.equal(P.$("cz-push").hidden, false);
  assert.equal(P.$("cz-adgo").hidden, false);
  // only rooms it can't go to: the pickers still say why, no button that always fails
  P = await hosted("roulette", [QUIET, { id: "r-busy", name: "Busy Room", busy: true, off: false }]);
  assert.deepEqual(opts(P, "cz-room"), [["r-quiet", true, "Quiet Room · roulette is off here"], ["r-busy", true, "Busy Room · has a table"]]);
  assert.equal(P.$("cz-push").hidden, true, "no Add this room");
  assert.equal(P.$("cz-adgo").hidden, false, "a busy room can still carry an advert");
  P = await hosted("roulette", [QUIET]);
  assert.equal(P.$("cz-adgo").hidden, true, "no Advertise there");
  // a blackjack table: the push picker as before (a card game's push isn't refused by the room's flag), the advert picker greys a room
  // where blackjack is off (the server refuses that advert)
  P = await hosted("bj", [LOUNGE, { id: "r-nobj", name: "No Cards", busy: false, games: { bj: false, holdem: true, roulette: true } }]);
  assert.deepEqual(opts(P, "cz-room"), [["r-lounge", false, "Test Lounge"], ["r-nobj", false, "No Cards"]]);
  assert.deepEqual(opts(P, "cz-adroom"), [["r-lounge", false, "Test Lounge"], ["r-nobj", true, "No Cards · this game is off here"]]);
});

test("Host Tools on a wheel words it as a wheel (The wheel, Close the wheel, its stream line, the advert's link); Blackjack's sheet is unchanged", async () => {
  const rl = partial("casino-sheets", { game: "roulette" }),
    bj = partial("casino-sheets", {});
  assert.match(rl, /<label class="lbl">The wheel<\/label>\s*<button type="button" class="cz-btn red sm" id="cz-close">Close the wheel<\/button>/);
  assert.match(rl, /Pepe posts one line there with the wheel's link \(and a reminder before a spin/);
  assert.doesNotMatch(rl, /The table|Close the table|table's link|The deck/, "no card-table words in a wheel's sheets");
  assert.match(rl, /Each spin is committed before bets open\./, "the history sheet's proof line, server-side too");
  assert.match(bj, /<label class="lbl">The table<\/label>\s*<button type="button" class="cz-btn red sm" id="cz-close">Close the table<\/button>/);
  assert.match(bj, /with the table's link \(and a reminder before a round/);
  const P = await hosted("roulette", [], { on_stream: true });
  assert.equal(P.$("cz-streamnow").textContent, "📺 This wheel is on Pepe's stream.");
  const B = await hosted("bj", [], { on_stream: true });
  assert.equal(B.$("cz-streamnow").textContent, "📺 This table is on Pepe's stream.");
  // the felt's "closed" line on a wheel (casinorl.js croupier) and the page's 404 path (casino-ui.js) say wheel too
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "casinorl.js"), "utf8"), /if \(t\.status !== "open"\) msg = T\("rl_closed", "This wheel has closed\."\);/);
  const C = page(`<main class="ds-page flow cz rl-page" id="cb" data-game="roulette" data-table="${TID}" data-signed="1" data-user="ann">${partial("casino-top", { game: "roulette", tableId: TID })}` +
                 `<section id="cz-table"><strong id="cz-msg"></strong><div id="cz-dock"></div></section></main>`, { ["/api/casino/t/" + TID]: { __status: 404 } }, {});
  C.CZ.startTable(() => {});
  await flush();
  await flush();
  assert.match(C.$("cz-msg").textContent, /^This wheel has closed\./);
});

test("D7: an admin pins a wheel on Pepe's stream from Host Tools (the 📌 box with Put it on the stream, the 📌 button once it's there); hosts and card tables get neither", async () => {
  const ADMIN = { admin: true };
  let P = await hosted("roulette", [], {}, ADMIN);
  assert.deepEqual([P.$("cz-pin-row").hidden, P.$("cz-pinnow").hidden], [false, true], "not on the stream: the box");
  P.$("cz-pin").checked = true;
  P.D.click(P.$("cz-stream"));
  await flush();
  assert.deepEqual(P.posts.map((x) => [x.url, x.body]), [["/api/casino/t/" + TID + "/stream", { on: true, override: false, pin: true }]]);
  P = await hosted("roulette", [], { on_stream: true, stream_pinned: false }, ADMIN);
  assert.deepEqual([P.$("cz-pin-row").hidden, P.$("cz-pinnow").hidden], [true, false], "on the stream, unpinned: the 📌 button");
  P.D.click(P.$("cz-pinnow"));
  await flush();
  assert.deepEqual(P.posts.map((x) => x.body), [{ on: true, pin: true }]);
  P = await hosted("roulette", [], { on_stream: true, stream_pinned: true }, ADMIN);
  assert.equal(P.$("cz-pinnow").hidden, true);
  assert.equal(P.$("cz-streamnow").textContent, "📌 This wheel is pinned on Pepe's stream: it stays there until it closes or is taken off.");
  P = await hosted("roulette", [], {}, {});
  assert.deepEqual([P.$("cz-pin-row").hidden, P.$("cz-pinnow").hidden], [true, true], "a host who isn't an admin: no pin (the server ignores it too)");
  P.D.click(P.$("cz-stream"));
  await flush();
  assert.equal(P.posts[0].body.pin, false);
  assert.doesNotMatch(partial("casino-sheets", {}), /cz-pin/, "a card table's sheet has no pin");
});

test("D7 (server): a wheel streamed with {pin: true} by an admin says stream_pinned in its view - a plain stream, a host's pin, off the stream: not", async () => {
  await fresh();
  const L = lobby(),
    admin = { ...actor("a"), admin: true };
  assert.ok((await svc.stream(L.id, true, admin, false, false)).ok);
  assert.deepEqual([svc.publicView(L).on_stream, svc.publicView(L).stream_pinned], [true, false], "a plain admin stream keeps the idle drop");
  const r = await svc.stream(L.id, true, admin, false, true);
  assert.match(r.reply, /Pinned/);
  assert.equal(svc.publicView(L).stream_pinned, true);
  assert.ok((await svc.stream(L.id, false, admin)).ok);
  assert.deepEqual([svc.publicView(L).on_stream, svc.publicView(L).stream_pinned], [false, false]);
  const W = svc.getTable(expect(await openWeb("b")).table);
  assert.ok((await svc.stream(W.id, true, actor("b"), false, true)).ok);
  assert.equal(svc.publicView(W).stream_pinned, false, "a host's {pin: true} is ignored (admins only)");
});

// ── the lobby's Open cards ──
const LIMITS = {
  bj: { min_bet: 100, max_bet: 100000, hr_min_bet: 100000, hr_max_bet: 1000000 },
  holdem: { sb_cap: 5000, bb_cap: 10000, hr_ladder: [] },
  roulette: { min_bet: 100, max_spin: 100000, caps: {}, hr: { min_bet: 1000, max_spin: 500000, caps: {}, spin_cap: 0 } },
};
async function lobbyOf(roulette) {
  const P = page(`<main class="ds-page flow cz" id="cb" data-game="bj" data-table="" data-signed="1" data-user="ann">${partial("casino-top", { game: "bj", tableId: null })}${partial("casino-lobby", { game: "bj", bjOn: false, hmOn: false })}</main>`,
                 { "/api/casino/lobby": { roulette: Object.assign({ on: true, lobby: null, wheels: [] }, roulette), enabled: false, hm_enabled: false, tables: [], rooms: [], stream: null,
                                          me: { name: "Ann", balance: 5000, high_roller: true }, limits: LIMITS, themes: { pick: false, list: [] }, now: Date.now() } },
                 { pre: [["self.js", "var self = window;"], ["rlbets.js", fs.readFileSync(path.join(repo, "casino", "rlbets.js"), "utf8")]] });
  P.CZ.startLobby();
  await flush();
  await flush();
  return P;
}
test("lobby: roulette.open false hides Open a wheel, hr_open false the 💎 wheel section (and the 💎 card left empty); an older answer opens as before", async () => {
  let P = await lobbyOf({ open: true, hr_open: true });
  assert.deepEqual([P.$("cz-open-wrap").hidden, P.$("cz-open-rl").hidden, P.$("cz-hrsec-rl").hidden, P.$("cz-open-hr").hidden], [false, false, false, false]);
  P = await lobbyOf({ open: true, hr_open: false });
  assert.deepEqual([P.$("cz-open-wrap").hidden, P.$("cz-open-rl").hidden, P.$("cz-hrsec-rl").hidden, P.$("cz-open-hr").hidden], [false, false, true, true],
                   "the 💎 wheels closed: no 💎 section - and with the card games off, no empty 💎 card");
  P = await lobbyOf({ open: false, hr_open: true });
  assert.deepEqual([P.$("cz-open-wrap").hidden, P.$("cz-open-rl").hidden, P.$("cz-hrsec-rl").hidden], [true, true, true], "web wheels closed to this viewer: no Open cards at all");
  P = await lobbyOf({});
  assert.deepEqual([P.$("cz-open-rl").hidden, P.$("cz-hrsec-rl").hidden], [false, false], "an answer without the flags (an older server): as before");
});

// ── the server ──
test("rl_hr_spin_cap 0 closes the 💎 wheels: saved and kept, none opens (web or room), an open one takes no new line; normal wheels play on", async () => {
  await fresh();
  await highRoller("b");
  await highRoller("c");
  const H = svc.getTable(expect(await openWeb("b", true)).table);
  expect(await act(H, "b", "bet", "red 1000"));
  // 0 was refused (35 x the straight had to fit) and a stored 0 fell back to 1,000,000; now it is the "closed" lever
  assert.equal(RLCFG.checkSetting("rl_hr_spin_cap", "0", svc.S.settings), "0");
  assert.equal(RLCFG.readSettings({ rl_hr_spin_cap: "0" }).rl_hr_spin_cap, 0);
  assert.throws(() => RLCFG.checkSetting("rl_hr_spin_cap", "1000", svc.S.settings), /35 times/, "a cap above 0 still has to fit one straight");
  await svc.setSetting("rl_hr_spin_cap", "0", "test");
  assert.equal(svc.S.settings.rl_hr_spin_cap, 0);
  const web = await openWeb("c", true);
  assert.equal(web.ok, false);
  assert.equal(web.code, "E_HR_CLOSED");
  assert.match(web.reply, /High Roller wheels are closed right now/);
  const inRoom = await openRoom("c", "pad-hr", ["hr"]);
  assert.equal(inRoom.ok, false);
  assert.equal(inRoom.code, "E_HR_CLOSED");
  const more = await act(H, "b", "bet", "17 1000");
  assert.equal(more.ok, false);
  assert.equal(more.code, "E_BANK", "an open 💎 wheel takes no new line");
  assert.equal(H.eng.book.length, 1, "its line rides");
  expect(await openWeb("c"));
  expect(await act(lobby(), "d", "bet", "17 100"));
  const L = await svc.RL.lobby("c");
  assert.deepEqual([L.on, L.open, L.hr_open], [true, true, false]);
  await svc.setSetting("rl_hr_spin_cap", "1000000", "test");
  assert.equal((await svc.RL.lobby("c")).hr_open, true);
  expect(await openRoom("c", "pad-hr", ["hr"]));
});

test("rl_web_open (off | staff | everyone, default everyone): who opens a web wheel of their own - room wheels, the lobby wheel and play unaffected", async (t) => {
  await fresh();
  const api = await server(t);
  assert.equal(svc.S.settings.rl_web_open, "everyone", "D1: everyone by default");
  await svc.setSetting("rl_web_open", "off", "test");
  const off = await api("/api/casino/open", "b", { game: "roulette", idem: "shipfix-web-off-1" });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, "E_WEB_CLOSED");
  assert.match(off.body.reply, /Opening a web wheel of your own is switched off right now/);
  assert.ok(![...svc.S.tables.values()].some((T) => T.game === "roulette" && T.web && T.status === "open"), "no web wheel opened");
  expect(await openRoom("b", "pad-web"));
  expect(await act(lobby(), "c", "bet", "red 100"));
  let L = (await api("/api/casino/lobby?rl=1", "b")).body;
  assert.deepEqual([L.roulette.on, L.roulette.open], [true, false]);
  await svc.setSetting("rl_web_open", "staff", "test");
  assert.match((await openWeb("b")).reply, /staff only/);
  assert.equal((await api("/api/casino/lobby?rl=1", "b")).body.roulette.open, false);
  assert.equal((await api("/api/casino/lobby?rl=1", "a")).body.roulette.open, true, "a is staff");
  expect(await openWeb("a"));
  await assert.rejects(svc.setSetting("rl_web_open", "maybe", "test"), /Invalid roulette setting/);
  await svc.setSetting("rl_web_open", "everyone", "test");
  expect(await openWeb("c"));
  assert.ok(!("rl_web_open" in svc.publicView(lobby()).limits), "a switch, not a limit: not in a wheel's limits");
});

test("Pepe's roulette links: the poll's lobby.roulette is the lobby's 🛞 tab by the navbar's rule; !rl's 'No wheel here' names it too", async (t) => {
  await fresh();
  const api = await server(t, true);
  const base = svc.link({ id: "x", game: "bj" }).replace(/\/casino\/blackjack\/t\/x$/, "");
  const poll = async () => (await api("/api/casino/bot/poll", null, { password: "localtest", after: 0, games: ["roulette"], state_after: 0 })).body;
  const noWheel = async () => (await svc.act({ ...actor("c", "room"), room: "pad-none" }, "limits", [], { room: "pad-none", game: "roulette" }, "shipfix-nw-" + ++n)).reply;
  try {
    await svc.setSetting("bj_enabled", "1", "test");
    assert.equal((await poll()).lobby.roulette, base + "/casino/blackjack#roulette", "Blackjack is the PATV casino: its lobby's Roulette tab");
    assert.equal(await noWheel(), "No wheel here. Use !rl start or play on the web: " + base + "/casino/blackjack#roulette");
    await svc.setSetting("bj_enabled", "0", "test");
    await svc.setSetting("hm_enabled", "1", "test");
    assert.equal((await poll()).lobby.roulette, base + "/casino/holdem#roulette");
    await svc.setSetting("hm_enabled", "0", "test");
    assert.equal((await poll()).lobby.roulette, base + "/casino/roulette", "neither game on the site: Pepe's lobby wheel, as before");
    assert.equal(await noWheel(), "No wheel here. Use !rl start or play on the web: " + base + "/casino/roulette");
  } finally {
    await svc.setSetting("bj_enabled", "0", "test");
    await svc.setSetting("hm_enabled", "0", "test");
  }
});

// ── the home page ──
const BM = require(path.join(repo, "boostmark"));
const UL = require(path.join(repo, "userlinks"));
const F = require("./fixtures/pad-dock/room.cjs");
function renderHome(locals) {
  const room = { id: "Alpha", slug: "alpha", name: "Alpha Room", count: 4, micCount: 1, live: true, topic: "Tonight" };
  return ejs.renderFile(path.join(repo, "views", "home.ejs"), Object.assign({
    username: null, me: null, mine: null, S: {}, rooms: [room], room, roomLive: F.initial(), roomGate: "ok", stage: { active: true }, top: [], tops: [],
    story: { rooms: [], caps: [], room: null, signed: false }, hot: null, fx: {}, roomOnStage: true, stageAdmin: null,
    frontInfo: { id: "Alpha", slug: "alpha", title: "Alpha Room", pinned: false, owner: null, boost: 0 }, pepeHere: true,
    slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "", boostMark: BM.boostMark, ul: UL, nextUp: null,
  }, locals)).then((x) => x.replace(/\r\n/g, "\n"));
}
const wheelRow = (id, seats) => ({ id, game: "Roulette", featured: false, on_stream: false, high_stakes: false, phase: "betting", room: "", seats, href: "/casino/roulette/t/" + id });
test("home: wheels read as 🛞 wheels with players (featured box, Now card, your chip); the tables line names each game once", async () => {
  const W1 = wheelRow("aaaaaaaaa1", ["Ann", "Bo", "Cy"]),
    W2 = wheelRow("aaaaaaaaa2", ["Di"]),
    W3 = wheelRow("aaaaaaaaa3", ["Ed", "Fy"]);
  const me = { userId: "u1", username: "viewer", displayname: "Viewer", level: 3, xp: 10, points_balance: 100, camfrogUsername: "viewercf", avatar: null, streak: null };
  let html = await renderHome({ S: { tables: [W1, W2, W3], featured: W1, tablesHref: "/casino/blackjack" }, me, username: "viewer", mine: { seat: W2 } });
  assert.ok(html.includes("Roulette open"), "the tables line: Roulette once");
  assert.ok(!html.includes("Roulette + Roulette"));
  assert.ok(html.includes("<h3>🛞 Featured wheel</h3>"));
  assert.ok(html.includes("<b>Roulette</b><span class=\"muted\"> · 3 playing</span>"));
  assert.ok(html.includes("Watch or place a bet ›"));
  assert.ok(html.includes('<span>🛞</span><span class="q">Roulette wheel · betting</span><span class="v">3 playing</span>'), "the Now card");
  assert.ok(html.includes("🛞 playing at Roulette"), "your chip");
  assert.ok(!/Featured table|Roulette table|seated/.test(html.replace(/<script[\s\S]*?<\/script>/g, "")), "no card-table words for a wheel");
  // a card table keeps its words, and a card table + a wheel name both games
  const BJ = { id: "bbbbbbbbb1", game: "Blackjack", featured: false, on_stream: false, phase: "betting", room: "", seats: ["Ann"], href: "/casino/blackjack/t/bbbbbbbbb1" };
  html = await renderHome({ S: { tables: [BJ, W1, W2], featured: BJ, tablesHref: "/casino/blackjack" }, me, username: "viewer", mine: { seat: BJ } });
  assert.ok(html.includes("Blackjack + Roulette open"));
  assert.ok(html.includes("<h3>🃏 Featured table</h3>") && html.includes(" · 1 seated</span>"));
  assert.ok(html.includes('<span>🃏</span><span class="q">Blackjack table · betting</span><span class="v">1 seated</span>'));
  assert.ok(html.includes("🃏 seated at Blackjack"));
});

// ── the roulette page's Sound toggle (casino-themes.css isn't loaded there) ──
test("the roulette page's Sound toggle sits at the row's end, the icon only on a phone (as on a themed table)", () => {
  const css = fs.readFileSync(path.join(repo, "views", "partials", "casino-rl-css.ejs"), "utf8").replace(/\r\n/g, "\n");
  assert.match(css, /\n\.rl-page \.cz-snd \{\n  float: inline-end;\n  margin: 0;\n\}/);
  assert.match(css, /@media \(max-width: 600px\) \{\n  \.rl-page \.cz-snd-l \{\n    display: none;\n  \}\n\}/);
  const v = fs.readFileSync(path.join(repo, "views", "casino-rl.ejs"), "utf8");
  assert.doesNotMatch(v, /casino-themes\.css/, "(why: the page never loads the themes' sheet)");
});

// ── /admin/games: the two levers ──
test("/admin/games: Who can open a web wheel (rl_web_open, its saved value selected) and the High Roller share's 0 = closed, checked in the browser as on the server", async () => {
  const casino = Object.assign({}, RLCFG.readSettings({ casino_roulette: "everyone", rl_web_open: "staff", rl_hr_spin_cap: "0" }), { hm_enabled: true, casino_sng: "off" });
  const html = (await ejs.renderFile(path.join(repo, "views", "admin", "games.ejs"), { title: "Games", user: { username: "ada" }, isAdmin: true, can: () => true, casino }))
    .replace(/\r\n/g, "\n");
  assert.match(html, /<label>Who can open a web wheel of their own<select name="rl_web_open" data-old="staff" aria-describedby="rlWebOpenHelp">/);
  assert.match(html, /<option value="staff" selected>staff<\/option>/);
  assert.match(html, /A High Roller share of 0 closes the 💎 wheels: none can be opened, and an open one takes no new bets\./);
  assert.match(html, /<input type="number" name="rl_hr_spin_cap" value="0" data-old="0" min="0"/);
  // the form's own check lets 0 through (35 x the straight only has to fit a cap above 0)
  assert.match(html, /\(Number\(form\.elements\.rl_hr_spin_cap\.value\) !== 0 && Number\(form\.elements\.rl_hr_max_straight\.value\) \* 35 > Number\(form\.elements\.rl_hr_spin_cap\.value\)\)/);
});
