"use strict";
// 1.99aof roulette review fixes - the Room Dock sheet (public/js/casinorl-dock.js mount + controls) in a vm with a little DOM
// (test/fixtures/mini-dom.js) and a scripted network: what the sheet shows and which wheel it follows.
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { makeWindow } = require("./fixtures/mini-dom");
const repo = path.resolve(__dirname, "..");
const SRC = ["public/js/patamount.js", "casino/rlbets.js", "public/js/casinorl-dock.js"].map((f) => [f, fs.readFileSync(path.join(repo, f), "utf8")]);
const LOBBY = "aaaaaaaaaa",
  ROOMW = "bbbbbbbbbb";
const limits = { rl_min_bet: 100, rl_bet_secs: 25, rl_spin_secs: 8, rl_result_secs: 5 };
function view(id, phase, me, extra) {
  return {
    ok: true,
    now: Date.now(),
    table: Object.assign(
      { id, game: "roulette", status: "open", phase, round_no: 2, history: [{ round_no: 1, number: 17, color: "black" }], limits,
        deadline: phase === "betting" ? Date.now() + 20000 : null, land_at: null, result_until: phase === "result" ? Date.now() + 4000 : null,
        totals: { players: me.staked ? 1 : 0, staked: me.staked || 0 }, seats: [] },
      extra || {},
    ),
    me: Object.assign({ lines: [], staked: 0, pending: null, last_slip: null, banned: false, net: null, private_note: null, notice: null }, me),
  };
}
async function dock(state) {
  const W = makeWindow((url) => {
    const u = new URL(url, "http://dock.test");
    if (u.pathname === "/api/casino/roulette/pad/test-pad") return state.pad();
    if (u.pathname.startsWith("/api/casino/t/")) return state.table(u.pathname.slice(14), u.search);
    return { status: 404, body: { ok: false } };
  });
  for (const [f, src] of SRC) W.run(src, f);
  const box = W.document.createElement("div");
  W.PATVRoulette.mount(box, { slug: "test-pad" });
  await W.settle();
  return { W, box, text: () => box.innerText, q: (s) => box.querySelector(s) };
}

test("UI-2: at the result the Dock shows the player's own net, and why a queued line wasn't placed", async () => {
  let me = { lines: [], staked: 0, net: 100 };
  const D = await dock({ pad: () => ({ ok: true, table: LOBBY, here: false }), table: () => view(LOBBY, "result", me) });
  assert.match(D.q(".rl-own").textContent, /Your net \+100 PAT/);
  me = { private_note: "Your queued line (black 100) wasn't placed: The stake could not be charged. Check your available PAT." };
  D.W.document.hidden = false;
  await D.W.tick();
  await D.W.settle();
  assert.match(D.q(".rl-feedback").textContent, /black 100\) wasn't placed/);
});

test("SUITES-6: the Dock stays on the wheel where the member's line rides when a room wheel opens, then follows it", async () => {
  let roomOpen = false,
    riding = { lines: [{ text: "red 800", amount: 800 }], staked: 800 };
  const D = await dock({
    pad: () => (roomOpen ? { ok: true, table: ROOMW, here: true } : { ok: true, table: LOBBY, here: false }),
    table: (id) => (id === LOBBY ? view(LOBBY, "betting", riding) : view(ROOMW, "idle", {})),
  });
  assert.match(D.q(".rl-state").textContent, /Lobby wheel/);
  roomOpen = true;
  for (let i = 0; i < 2; i++) { await D.W.tick(); await D.W.settle(); }
  assert.equal(D.q(".rl-table-link").href, "/casino/roulette/t/" + LOBBY, "stayed while 800 PAT ride");
  assert.match(D.q(".rl-own").textContent, /red 800/);
  assert.match(D.q(".rl-state").textContent, /Lobby wheel/);
  riding = { lines: [], staked: 0 };
  for (let i = 0; i < 2; i++) { await D.W.tick(); await D.W.settle(); }     // (the poll that sees the line gone, then the move)
  assert.equal(D.q(".rl-table-link").href, "/casino/roulette/t/" + ROOMW, "then follows the pad's wheel");
  assert.match(D.q(".rl-state").textContent, /Room wheel/);
});

test("ENGINE-3 / UI-1: the sheet's first table request asks for the intro notice and shows its text; its polls don't ask", async () => {
  const asks = [];
  const D = await dock({
    pad: () => ({ ok: true, table: LOBBY, here: false }),
    table: (id, q) => {
      asks.push(q);
      return view(LOBBY, "idle", { notice: q === "?notice=1" ? { id: "rl_intro", text: "PAT are points with no cash value." } : null });
    },
  });
  await D.W.tick();
  await D.W.settle();
  assert.deepEqual(asks, ["?notice=1", ""]);
  assert.equal(D.q(".rl-intro").hidden, false);
  assert.match(D.q(".rl-intro").textContent, /no cash value/);
});

test("UI-13 / UI-9 / UI-3: an idle ring holds a dash, the small links and inputs are 44 px targets, touch screens get the modes", async () => {
  const D = await dock({ pad: () => ({ ok: true, table: LOBBY, here: false }), table: () => view(LOBBY, "idle", {}) });
  const ring = D.q(".rl-timer");
  assert.equal(ring.textContent, "–");
  assert.ok(ring.classList.contains("idle"));
  const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  const dockCss = read("public/css/casinorl-dock.css"),
    felt = read("views/partials/casino-rl-css.ejs"),
    lobby = read("views/partials/casino-css.ejs");
  assert.match(dockCss, /\.rl-controls input \{[^}]*min-height: 44px/);
  // (WP5b: the edges keep a 22 px hit area on a mouse screen; touch screens bet them with the modes)
  assert.match(felt, /\.rl-grid \.edge::before \{\s*content: "";\s*position: absolute;\s*inset: -2px -7px;/);
  assert.match(dockCss, /\.rl-table-link \{[^}]*min-height: 44px/);
  assert.match(dockCss, /\.rl-timer\.idle \{[^}]*width: 44px;[^}]*height: 44px/);
  assert.match(felt, /\.rl-more a \{[^}]*min-height: 44px/);
  assert.match(felt, /grid-template-rows: repeat\(3, minmax\(44px, 1fr\)\)/);
  assert.match(felt, /@media \(pointer: coarse\) and \(min-width: 640px\) \{\s*\.rl-modes \{\s*display: flex;[\s\S]*?\.rl-grid \.edge \{\s*display: none;/);
  // (roulette2 WP5a: the lobby's bare roulette link is gone - each wheel is a table card with Play / Watch buttons, casino-lobby.test.js)
  assert.doesNotMatch(lobby, /#cz-roulette/);
  assert.match(read("public/js/casinorl.js"), /matchMedia\("\(max-width:639px\), \(pointer:coarse\)"\)/);
});

function postBodies(D) {
  return D.W.fetched.filter((f) => f.opts && f.opts.method === "POST").map((f) => JSON.parse(f.opts.body));
}
test("UI-4 / UI-5 / UI-11: a burst of chips goes as one line; mid-spin chips join the queued line; slips read in the felt's words", async () => {
  let me = { lines: [{ text: "c2 100 · low 100", amount: 200 }], staked: 200, pending: null };
  let phase = "betting";
  const D = await dock({
    pad: () => ({ ok: true, table: LOBBY, here: false }),
    table: () => view(LOBBY, phase, me),
  });
  const W = D.W;
  W.fetch = ((orig) => async (url, opts) => (opts && opts.method === "POST" ? (W.fetched.push({ url, opts }), { status: 200, json: async () => ({ ok: true, reply: "ok" }) }) : orig(url, opts)))(W.fetch);
  assert.equal(D.q(".rl-own").textContent, "Column 2 100 · 1–18 100", "UI-11: the felt's labels, not c2 / low");
  const red = D.box.querySelectorAll("button").find((b) => b.textContent === "◆ Red"),
    odd = D.box.querySelectorAll("button").find((b) => b.textContent === "Odd");
  red.click();
  odd.click();
  const t = W.timers.filter((x) => !x.done).pop();
  assert.equal(t.ms, 900, "UI-4: the batch waits 900 ms after the last chip (it was 300)");
  t.done = true;
  await t.fn();
  await W.settle();
  assert.deepEqual(postBodies(D).at(-1).bets, [{ b: "red", a: "100" }, { b: "odd", a: "100" }], "one line for the burst");
  // UI-5: mid-spin the queued line comes along with the new chip
  phase = "spinning";
  me = { lines: [], staked: 300, pending: "black 200 · 17 100" };
  await W.tick();
  await W.settle();
  assert.match(D.q(".rl-own").textContent, /Next spin: black 200 · 17 100/);
  red.click();
  const t2 = W.timers.filter((x) => !x.done && x.ms === 900).pop();
  t2.done = true;
  await t2.fn();
  await W.settle();
  assert.deepEqual(postBodies(D).at(-1).bets, [{ b: "black", a: "200" }, { b: "17", a: "100" }, { b: "red", a: "100" }]);
});

test("UI-6 / UI-7 / UI-8 / UI-12 / UI-14: sign-in prompt, plural counts, spoken labels, lobby copy, a refresh that waits for a fresh state", () => {
  const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  const page = read("public/js/casinorl.js"),
    ui = read("public/js/casino-ui.js"),
    en = JSON.parse(read("locales/en.json"));
  // (roulette2 WP5b: the signed-out line is the table's .watchbar, as on the Blackjack and Hold'em tables - test/casino-rl-page.test.js)
  assert.match(page, /if \(t\.status === "open" && !CZ\.signed\)\s*txt = "👁 " \+ CZ\.esc\(T\("watching_signin", "You're watching\."\)\) \+ ' <a href="\/login">'/);
  assert.deepEqual(en["js.casino.rl_layout_n"], { one: "Layout: {players} player · {pat} PAT", other: "Layout: {players} players · {pat} PAT" });
  assert.deepEqual(en["js.casino.rl_lobby_status"], { one: "{n} player · {phase}", other: "{n} players · {phase}" });
  assert.match(page, /count: lay\.players/);
  assert.match(ui, /count: players \}/, "roulette2 WP5a: the lobby's wheel card counts its players with a plural");
  // UI-8 / O7: a spot's spoken name - the felt's words (never the internal kind or token), what it pays, its cap, my bet
  assert.match(page, /T\("rl_spot_aria", "\{spot\} · \{kind\} · pays \{odds\} to 1 · up to \{cap\} PAT · your bet \{n\} PAT", \{\s*spot: spotWords\(token\),\s*kind: kinds\[p\.kind\]/);
  for (const k of ["rl_trio", "rl_first_four", "rl_dozen", "rl_column", "rl_even_money", "lobby_sub_rl", "lobby_tag_rl"]) assert.ok(en["js.casino." + k], k);
  assert.match(en["js.casino.lobby_tag_rl"], /roulette/);
  assert.match(ui, /if \(running\) \{\s*if \(!again\) again = running\.then/);
});

// ── roulette2 WP5b: the shared controls on the casino's chips, compact mode in the Room Dock, one key per line ──
test("WP5b / contract 9: the Room Dock keeps its compact sheet - the casino's chips, its own buttons, no Spin now, a mini wheel, the layout line", async () => {
  const calls = [];
  const wheel = {};
  for (const k of ["setSkew", "spin", "rest", "idle", "destroy"]) wheel[k] = (...a) => { calls.push([k, ...a]); return wheel; };
  const W = makeWindow((url) => {
    const u = new URL(url, "http://dock.test");
    if (u.pathname === "/api/casino/roulette/pad/test-pad") return { ok: true, table: LOBBY, here: false };
    return view(LOBBY, "betting", { lines: [], staked: 0 }, {
      felt: [{ t: "red", n: 3000, k: 2 }],
      seats: [{ name: "Rocco", seat: "s1", staked: 2500, chips: [["red", 2500]] }, { name: "frog 3", seat: "s2", staked: 500, chips: [["red", 500]], veil: 1 }],
    });
  });
  for (const [f, src] of SRC) W.run(src, f);
  W.PATVRlWheel = { mount: (c, o) => { calls.push(["mount", c.tagName, o.compact]); return wheel; } };
  const box = W.document.createElement("div");
  const close = W.PATVRoulette.mount(box, { slug: "test-pad" });
  await W.settle();
  const chips = box.querySelectorAll("button").filter((b) => b.classList.contains("chipbtn"));
  assert.deepEqual(chips.map((b) => b.dataset.chip), ["100", "500", "1000", "5000", "25000"]);
  assert.deepEqual(chips.map((b) => b.children[0].className), ["chip", "chip c500", "chip c1k", "chip c5k", "chip c25k"], "contract 9's chip classes");
  assert.equal(chips[0].getAttribute("aria-pressed"), "true");
  assert.ok(box.querySelector(".rl-compact"), "the Dock's own look");
  const names = box.querySelectorAll("button").map((b) => b.textContent);
  assert.ok(!names.includes("Spin now"), "no Spin now in the Dock");
  assert.ok(names.includes("×2"));
  assert.ok(box.querySelectorAll("button").every((b) => !/cz-btn/.test(b.className)), "no casino-css buttons on the pad page");
  assert.deepEqual(calls.find((c) => c[0] === "mount"), ["mount", "CANVAS", true], "the compact mini wheel");
  assert.equal(box.querySelector(".rl-mini").hidden, false);
  assert.ok(calls.some((c) => c[0] === "idle"), "bets open: the rotor turns, no ball");
  assert.equal(box.querySelector(".rl-who").textContent, "Layout: 2 players · 3,000 PAT · Rocco 2.5K, frog 3 500");
  close();
  assert.ok(calls.some((c) => c[0] === "destroy"), "closing the sheet stops the wheel");
});

test("WP5b: every POST has its own idempotency key; a call line that waits for the line in flight goes next, on its own and whole", async () => {
  let release;
  const posts = [];
  const W = makeWindow(async (url, o) => {
    if (o && o.method === "POST") {
      posts.push(JSON.parse(o.body));
      if (posts.length === 1) await new Promise((r) => (release = r));
      return { ok: true, reply: "ok" };
    }
    return { ok: false };
  });
  for (const [f, src] of SRC) W.run(src, f);
  const box = W.document.createElement("div");
  const c = W.PATVRoulette.controls(box, { id: LOBBY, refresh: async () => {} });
  c.update(view(LOBBY, "betting", { lines: [], staked: 0, used: { positions: 0, actions: 0, per_token: {} } }, { rules: null }));
  assert.equal(c.place("red"), true);
  const t = W.timers.filter((x) => !x.done && x.ms === 900).pop();
  t.done = true;
  t.fn();
  await W.settle();
  assert.equal(posts.length, 1, "the burst's line is in flight");
  assert.equal(c.placeMany([{ b: "0-2-3", a: "200" }, { b: "4-7", a: "100" }]), true);
  await W.settle();
  assert.equal(posts.length, 1, "it waits");
  release();
  await W.settle();
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(posts[1].bets)), [{ b: "0-2-3", a: "200" }, { b: "4-7", a: "100" }], "on its own, never split");
  assert.notEqual(posts[0].idem, posts[1].idem);
  // more than 20 positions can't be one line: refused, nothing sent
  const many = Array.from({ length: 21 }, (_, i) => ({ b: String(i + 1), a: "100" }));
  assert.equal(c.placeMany(many), false);
  assert.equal(box.querySelector(".rl-feedback").textContent, "That's more than 20 spots for one line.");
  // the table page's controls: the casino's buttons with their keys, the typed line and a custom chip under "Type a bet"
  const box2 = W.document.createElement("div");
  W.PATVRoulette.controls(box2, { id: LOBBY, refresh: async () => {} });
  const b2 = box2.querySelectorAll("button");
  assert.deepEqual(b2.filter((b) => /cz-btn/.test(b.className)).map((b) => b.textContent + ":" + b.getAttribute("aria-keyshortcuts")),
    ["Undo:Z", "Clear:C", "Rebet:R", "×2:D", "Spin now:Space", "Place line:null"]);
  const typed = box2.querySelector(".rl-type");
  assert.equal(typed.tagName, "DETAILS");
  assert.equal(typed.children[0].textContent, "Type a bet");
  assert.ok(typed.querySelector("input") && typed.querySelector("form"), "the custom chip and the bet line fold under it");
});

// ── roulette2 WP5b review fixes (the shared controls) ──
test("review: an E_SPIN refusal of a Rebet or of a line queued while the wheel spins names the line's real total", async () => {
  let reply = null;
  const W = makeWindow(async (url, o) => (o && o.method === "POST" ? reply : { ok: false }));
  for (const [f, src] of SRC) W.run(src, f);
  const box = W.document.createElement("div");
  const c = W.PATVRoulette.controls(box, { id: LOBBY, refresh: async () => {} });
  const fb = () => box.querySelector(".rl-feedback").textContent;
  // Rebet: the server's have is what the player has on this spin before the line (60,000); the line is the last slip (60,000)
  c.update(view(LOBBY, "betting", { lines: [{ text: "d1 60000", amount: 60000 }], staked: 60000, last_slip: "black 30000 · red 30000" }));
  reply = { ok: false, reply: "That line exceeds your per-spin limit.", code: "E_SPIN", max: 100000, have: 60000 };
  assert.equal(c.run("rebet"), true);
  await W.settle();
  assert.equal(fb(), "Your total this spin would be 120,000 PAT — the most per player per spin is 100,000 PAT.", "was 60,000");
  // while it spins: the server checks the queued line AND the new chip as one line (have 0)
  c.update(view(LOBBY, "spinning", { lines: [], staked: 0, pending: "17 100 · red 50000" }));
  reply = { ok: false, reply: "That line exceeds your per-spin limit.", code: "E_SPIN", max: 50000, have: 0 };
  assert.equal(c.place("red"), true);
  const t = W.timers.filter((x) => !x.done && x.ms === 900).pop();
  t.done = true;
  await t.fn();
  await W.settle();
  assert.equal(fb(), "Your total this spin would be 50,200 PAT — the most per player per spin is 50,000 PAT.", "was 100");
  // an E_SPIN with no line total known (an undo / clear never gets one): the server's own text
  reply = { ok: false, reply: "That line exceeds your per-spin limit.", code: "E_SPIN", max: 50000, have: 0 };
  c.update(view(LOBBY, "spinning", { lines: [], staked: 0, pending: "17 100" }));
  assert.equal(c.run("clear"), true);
  await W.settle();
  assert.equal(fb(), "That line exceeds your per-spin limit.");
});

test("review: a waiting call / ×2 line refused at its turn never strands the chips placed meanwhile - they go next", async () => {
  let release;
  const posts = [];
  const W = makeWindow(async (url, o) => {
    if (o && o.method === "POST") {
      posts.push(JSON.parse(o.body));
      if (posts.length === 1) await new Promise((r) => (release = r));
      return { ok: true, reply: "ok" };
    }
    return { ok: false };
  });
  for (const [f, src] of SRC) W.run(src, f);
  const box = W.document.createElement("div");
  const queued = (n) => Array.from({ length: n }, (_, i) => String(i + 1) + " 100").join(" · ");
  let next = null;
  const c = W.PATVRoulette.controls(box, { id: LOBBY, refresh: async () => { if (next) c.update(next); } });
  c.update(view(LOBBY, "spinning", { lines: [], staked: 0, pending: queued(10) }));
  // 1. five chips while it spins: one line (with the 10 queued) in flight, its answer slow
  for (const tk of ["11", "12", "13", "14", "15"]) assert.equal(c.place(tk), true);
  const t = W.timers.filter((x) => !x.done && x.ms === 900).pop();
  t.done = true;
  t.fn();
  await W.settle();
  assert.equal(posts.length, 1);
  // 2. a 7-spot call line waits behind it (10 + 7 is within 20 now), and one more chip is placed
  assert.equal(c.placeMany(["16", "17", "18", "19", "20", "21", "22"].map((b) => ({ b, a: "100" }))), true);
  assert.equal(c.place("23"), true);
  for (const x of W.timers.filter((y) => !y.done && y.ms === 900)) { x.done = true; x.fn(); }     // (its batch timer: the line is still out)
  await W.settle();
  assert.equal(posts.length, 1);
  // 3. the answer: the queued line is now 15 spots - the waiting 7 can't join it (22 > 20), refused with the reason...
  next = view(LOBBY, "spinning", { lines: [], staked: 0, pending: queued(15) });
  release();
  await W.settle();
  assert.equal(box.querySelector(".rl-feedback").textContent, "That's more than 20 spots for one line.");
  // ...and the chip placed meanwhile still goes (was: no timer left, the chip dimmed and the buttons off until another chip)
  const left = W.timers.filter((x) => !x.done && x.ms <= 900);
  assert.equal(left.length, 1, "the batch is scheduled again");
  left[0].done = true;
  await left[0].fn();
  await W.settle();
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(posts[1].bets)).map((b) => b.b), Array.from({ length: 15 }, (_, i) => String(i + 1)).concat("23"));
});

test("review: the Room Dock's mini wheel follows this browser's ⚡ Quick spin (the table page's setting)", async () => {
  const calls = [];
  const wheel = {};
  for (const k of ["setSkew", "spin", "rest", "idle", "destroy"]) wheel[k] = () => wheel;
  const W = makeWindow((url) => {
    const u = new URL(url, "http://dock.test");
    if (u.pathname === "/api/casino/roulette/pad/test-pad") return { ok: true, table: LOBBY, here: false };
    return view(LOBBY, "betting", { lines: [], staked: 0 });
  });
  for (const [f, src] of SRC) W.run(src, f);
  W.localStorage = { getItem: (k) => (k === "rl-quick" ? "1" : null) };
  W.PATVRlWheel = { mount: (cv, o) => { calls.push(o); return wheel; } };
  W.PATVRoulette.mount(W.document.createElement("div"), { slug: "test-pad" });
  await W.settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reduced, true, "Quick spin on: the mini wheel's reduced path (its rotor doesn't turn non-stop)");
  // blocked storage: the system setting
  const W2 = makeWindow((url) => (String(url).includes("/pad/") ? { ok: true, table: LOBBY, here: false } : view(LOBBY, "betting", { lines: [], staked: 0 })));
  for (const [f, src] of SRC) W2.run(src, f);
  Object.defineProperty(W2, "localStorage", { get() { throw new Error("blocked"); } });
  const c2 = [];
  W2.PATVRlWheel = { mount: (cv, o) => { c2.push(o); return wheel; } };
  W2.PATVRoulette.mount(W2.document.createElement("div"), { slug: "test-pad" });
  await W2.settle();
  assert.equal(c2[0].reduced, undefined);
});
