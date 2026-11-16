"use strict";
// 1.99aoe roulette review fixes - the Room Dock sheet (public/js/casinorl-dock.js mount + controls) in a vm with a little DOM
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
  assert.match(dockCss, /\.rl-table-link \{[^}]*min-height: 44px/);
  assert.match(dockCss, /\.rl-timer\.idle \{[^}]*width: 44px;[^}]*height: 44px/);
  assert.match(felt, /\.rl-more a \{[^}]*min-height: 44px/);
  assert.match(felt, /grid-template-rows: repeat\(3, minmax\(44px, 1fr\)\)/);
  assert.match(felt, /@media \(pointer: coarse\) and \(min-width: 640px\) \{\s*\.rl-modes \{\s*display: flex;[\s\S]*?\.rl-grid \.edge \{\s*display: none;/);
  assert.match(lobby, /#cz-roulette > a \{[^}]*min-height: 44px/);
  assert.match(read("public/js/casinorl.js"), /matchMedia\("\(max-width:639px\), \(pointer:coarse\)"\)/);
});
