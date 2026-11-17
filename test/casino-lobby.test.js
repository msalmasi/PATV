"use strict";
// roulette2 WP5a (O4 / O5 / O9, decisions D1 D2, contracts 3 / 4 / 9): the casino lobby with roulette as its third game, and the
// shared chips.
//   * the browser (public/js/casino-ui.js on the real partials in a vm - test/fixtures/casino-dom.js): the lobby asks ?rl=1; a 🛞
//     Roulette tab while roulette is open to the viewer (#roulette picks it, a tab you pick is written back); the wheels as table
//     cards (Pepe's lobby wheel first, "{host}'s wheel", the live phase + countdown on the server's clock, the last pockets in the
//     felt's colours from PATVRlBets.red, who's on the layout, the limits, 💎 / rooms / web / 📺 / Fair, Play + Watch); 💎 wheels in
//     the High Roller section (locked for everyone else); the stats count the wheels; "Open a wheel" / the 💎 one post
//     {game: "roulette", hr?, idem} and go to /casino/roulette/t/<id>; the old "Roulette · N players" box above the hero is gone
//   * the chips: one public/css/casino-chips.css (.chip, .pile, .stack, ONE .chipbtn - Hold'em's .rchip is .chipbtn.sm - and
//     .rl-pocket), linked right after the casino-css partial on the blackjack, Hold'em and roulette pages and on the pad page
//   * the route: /api/casino/lobby says the server's `now`, and its wheel rows draw as wheel cards
// Invented accounts a..d only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { rd, partial, page, flush } = require("./fixtures/casino-dom");

const NOW = 1800000000000;
const RLBETS = [["self.js", "var self = window;"], ["rlbets.js", rd("casino", "rlbets.js")]];
const LIMITS = {
  bj: { min_bet: 100, max_bet: 100000, hr_min_bet: 100000, hr_max_bet: 1000000 },
  holdem: { sb_cap: 5000, bb_cap: 10000, hr_ladder: [[100000, 200000], [250000, 500000]] },
  roulette: { min_bet: 100, max_spin: 100000, caps: { straight: 5000, split: 10000, street: 15000, corner: 20000, line: 30000, outside: 50000 },
              hr: { min_bet: 1000, max_spin: 500000, caps: { straight: 25000, split: 50000, street: 75000, corner: 100000, line: 150000, outside: 250000 }, spin_cap: 1000000 } },
};
// a lobby row as svc.lobby() + the route send it (contract 3)
const wheel = (id, o) => Object.assign({ id, game: "roulette", host: "Pepe", room: null, room_name: null, rooms: [], adverts: [], url: "https://x.test/casino/roulette/t/" + id,
  on_stream: false, phase: "idle", players: 0, max_seats: 35, high_stakes: false, tier: "main", theme: "classic", round_no: 1, min_bet: 100, max_bet: 100000,
  max_straight: 5000, lobby: false, slot: null, deadline: null, land_at: null, staked: 0, last: [], proof: null, stream_queue: null }, o);
const bj = (id, o) => Object.assign({ id, game: "bj", host: "Ann", room: null, rooms: [], adverts: [], phase: "betting", players: 1, max_seats: 6, min_bet: 100, max_bet: 100000,
  round_no: 3, high_stakes: false, theme: "classic", proof: null, stream_queue: null }, o);
const hm = (id, o) => Object.assign({ id, game: "holdem", host: "Bo", room: null, rooms: [], adverts: [], phase: "between", hand_no: 0, players: 2, max_seats: 9, sb: 25, bb: 50,
  high_stakes: false, theme: "classic" }, o);
const LOBBY = (o) => Object.assign({ roulette: { on: true, lobby: null, wheels: [] }, enabled: true, hm_enabled: true, tables: [], rooms: [], stream: null,
  me: { name: "Ann", balance: 5000, high_roller: false }, limits: LIMITS, themes: { pick: false, list: [] }, now: NOW }, o);

function lobbyPage(data, opts) {
  opts = opts || {};
  const g = opts.game || "bj";
  const top = partial("casino-top", { game: g, tableId: null });
  const lob = partial("casino-lobby", { game: g, bjOn: true, hmOn: true });
  const P = page(`<main class="ds-page flow cz" id="cb" data-game="${g === "holdem" ? "holdem" : "bj"}" data-table="" data-signed="${opts.signed === false ? "" : "1"}" data-user="ann">${top}${lob}</main>`,
                 { "/api/casino/lobby": () => (typeof data === "function" ? data() : data), post: opts.post || (() => ({ ok: true, table: "w9", reply: "Wheel open." })) },
                 { hash: opts.hash, pre: opts.noBets ? [] : RLBETS });
  return P;
}
async function started(data, opts) {
  const P = lobbyPage(data, opts);
  P.CZ.startLobby();
  await flush(); await flush();
  return P;
}
const cards = (P, id) => P.$(id || "cz-tables").querySelectorAll("article");
const titles = (P, id) => cards(P, id).map((c) => c.querySelector(".tcard-h b").textContent);
const tab = (P, k) => P.D.doc.querySelector(`.lob-tabs button[data-tab="${k}"]`);

test("the lobby asks /api/casino/lobby?rl=1; roulette open to you: a 🛞 Roulette tab; the old box above the hero is gone", async () => {
  const P = await started(LOBBY({ tables: [wheel("w1", { lobby: true, slot: "main" })] }));
  assert.deepEqual(P.gets, ["/api/casino/lobby?rl=1"], "the wheel rows are asked for");
  assert.equal(P.$("cz-roulette"), null, "no bare roulette box above the hero");
  assert.equal(P.$("cz-wheel-status"), null);
  assert.equal(P.D.doc.querySelector("#cz-lobby").children[0].className, "lob-hero", "the hero comes first again");
  const t = tab(P, "roulette");
  assert.ok(t, "a fourth tab");
  assert.equal(t.hidden, false, "shown: roulette is open to this viewer");
  assert.match(t.textContent, /🛞\s*Roulette/);
  assert.deepEqual(P.D.doc.querySelectorAll(".lob-tabs button").map((b) => b.dataset.tab), ["all", "bj", "holdem", "roulette"]);
  // four tabs don't fit a phone's row (the 🛞 one scrolled out of sight at 375 px in Chrome): .four makes it a 2 x 2 switcher there
  assert.ok(P.D.doc.querySelector(".lob-tabs").classList.contains("four"));
  const css = rd("views", "partials", "casino-css.ejs").replace(/\r\n/g, "\n");
  const phone = /@media \(max-width: 600px\) \{\n {4}\.cz \{ --cw: 38px;[\s\S]*?\n {2}\}/.exec(css);
  assert.ok(phone, "the lobby's phone block");
  assert.match(phone[0], /\.lob-tabs\.four \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); width: 100%;/);
  // the countdown sits in the subtitle line (not .tcard-h b's 16 px title block)
  assert.match(css, /\.tcard\.rl \.tcard-h small b \{ display: inline; font-size: inherit;/);
  // the header and hero name roulette (UI-12)
  assert.equal(P.D.doc.querySelector(".cz-brand small").textContent, "Blackjack, Hold'em and roulette with your PAT");
  assert.match(P.D.doc.querySelector("#cz-lobby .lob-hero p").textContent, /single-zero roulette/);
  // roulette shut for this viewer: no tab (it starts hidden in the page)
  const Q = await started(LOBBY({ roulette: { on: false, lobby: null, wheels: [] } }));
  assert.equal(tab(Q, "roulette").hidden, true);
  assert.ok(!Q.D.doc.querySelector(".lob-tabs").classList.contains("four"), "three tabs: the strip as it was");
  assert.equal(Q.$("cz-open-rl").hidden, true, "no Open a wheel");
  assert.equal(Q.$("cz-hrsec-rl").hidden, true, "no 💎 wheel sub-section");
  assert.match(partial("casino-lobby", { game: "bj", bjOn: true, hmOn: true }), /data-tab="roulette" aria-selected="false" hidden>/, "hidden until the lobby says so");
});

test("(review) the page's first guess: app.locals.rouletteOn(can) draws the 🛞 tab and the 2 x 2 strip before the lobby answers (no shift under a thumb)", async () => {
  const can = () => false;
  let given = null;
  const on = partial("casino-lobby", { game: "bj", bjOn: true, hmOn: true, can, rouletteOn: (c) => ((given = c), true) });
  assert.equal(given, can, "the view's can() (the request's user), as the navbar asks");
  assert.match(on, /<div class="lob-tabs four" role="tablist"/);
  assert.match(on, /data-tab="roulette" aria-selected="false">/, "the tab drawn, not hidden");
  assert.match(on, /<span id="cz-hr-locked-t" hidden>[^<]*<\/span><span id="cz-hr-locked-rl">/, "the 💎 note that names the wheels");
  for (const off of [{ rouletteOn: () => false }, {}]) {
    const html = partial("casino-lobby", Object.assign({ game: "holdem", bjOn: true, hmOn: true, can }, off));
    assert.match(html, /<div class="lob-tabs" role="tablist"/, "three tabs: the strip as it was");
    assert.match(html, /data-tab="roulette" aria-selected="false" hidden>/);
    assert.match(html, /<span id="cz-hr-locked-t">[^<]*<\/span><span id="cz-hr-locked-rl" hidden>/);
  }
  // the guess and the lobby answer agree: nothing moves; the answer says shut: the strip goes back to three
  const page1 = (data) => page(`<main class="ds-page flow cz" id="cb" data-game="bj" data-table="" data-signed="1" data-user="ann">${partial("casino-top", { game: "bj", tableId: null })}${on}</main>`,
                               { "/api/casino/lobby": data, post: () => ({ ok: false }) }, { pre: RLBETS });
  let P = page1(LOBBY({ tables: [wheel("w1", { lobby: true })] }));
  assert.equal(tab(P, "roulette").hidden, false, "before the first answer");
  P.CZ.startLobby(); await flush(); await flush();
  assert.equal(tab(P, "roulette").hidden, false);
  assert.ok(P.D.doc.querySelector(".lob-tabs").classList.contains("four"));
  P = page1(LOBBY({ roulette: { on: false, lobby: null, wheels: [] } }));
  P.CZ.startLobby(); await flush(); await flush();
  assert.equal(tab(P, "roulette").hidden, true, "corrected by the answer");
  assert.ok(!P.D.doc.querySelector(".lob-tabs").classList.contains("four"));
  assert.equal(P.$("cz-hr-locked-t").hidden, false);
  assert.equal(P.$("cz-hr-locked-rl").hidden, true);
});

test("wheel cards: Pepe's lobby wheel first on All, then the rest as listed; the card's lines (phase + countdown, pockets, who, limits, tags, Play / Watch)", async () => {
  const ann = wheel("w2", { host: "Annie", players: 3, staked: 1200, phase: "betting", deadline: NOW + 12000, round_no: 6, last: [17, 0, 18, 14, 2],
                            rooms: [{ id: "pad-a", name: "Pad A" }], adverts: [{ id: "pad-b", name: "Pad B" }], on_stream: true, proof: "/casino/fair/w2/5" });
  const pepe = wheel("w1", { lobby: true, slot: "main", players: 1, staked: 500 });
  const P = await started(LOBBY({ tables: [bj("t1"), ann, pepe] }), { hash: "#all" });
  assert.deepEqual(titles(P), ["Pepe's wheel", "Ann's table", "Annie's wheel"], "the lobby wheel first, then as the server lists them");
  const [lob, , card] = cards(P);
  assert.ok(card.classList.contains("tcard") && card.classList.contains("rl"), "the table card's markup");
  assert.equal(card.getAttribute("aria-label"), "Annie's wheel");
  assert.equal(card.querySelector(".tcard-h .ic").textContent, "🛞");
  // the live line: "Single-zero roulette · Bets open · 0:12" - the countdown on the server's clock (the answer's now)
  const sub = card.querySelector(".tcard-h small");
  assert.match(sub.textContent, /^Single-zero roulette · Bets open · /);
  const cd = sub.querySelector("b");
  assert.equal(cd.getAttribute("data-rldl"), String(NOW + 12000));
  assert.equal(cd.textContent, "0:12", "the server's clock, not this machine's (it is years off here)");
  // the pockets: newest first with the ring, colours from PATVRlBets.red (14 and 18 red, 0 zero, 2 and 17 black)
  const pk = card.querySelectorAll(".rl-last .rl-pocket");
  assert.deepEqual(pk.map((x) => x.className), ["rl-pocket black newest", "rl-pocket red", "rl-pocket red", "rl-pocket zero", "rl-pocket black"]);
  assert.deepEqual(pk.map((x) => x.textContent), ["2", "14", "18", "0", "17"]);
  assert.deepEqual(pk.map((x) => x.getAttribute("aria-label")), ["2 black", "14 red", "18 red", "0 green", "17 black"], "the colour as a word too");
  assert.ok(pk.every((x) => x.getAttribute("role") === "img"));
  assert.equal(card.querySelector(".rl-last").getAttribute("aria-label"), "Last spins, newest first", "(review) the order is said, not only drawn");
  assert.equal(card.querySelector(".rl-tally").textContent, "3 players · 1,200 PAT on the layout");
  assert.equal(lob.querySelector(".rl-tally").textContent, "1 player · 500 PAT on the layout", "one player: the singular");
  const tags = (c) => c.querySelectorAll(".meta .tag").map((x) => x.textContent);
  assert.deepEqual(tags(card), ["Min 100 · Straight 5,000 · 100,000 a spin", "🐸 Pad A", "📣 Pad B", "📺 On Pepe's stream", "🔐 Fair"]);
  assert.equal(card.querySelector(".meta .tag.gold").textContent, "Min 100 · Straight 5,000 · 100,000 a spin", "the limits in gold");
  assert.equal(card.querySelector('.meta a.tag.green').getAttribute("href"), "/casino/fair/w2/5");
  assert.deepEqual(tags(lob), ["Min 100 · Straight 5,000 · 100,000 a spin", "Lobby wheel", "🌐 Web only"]);
  assert.equal(lob.querySelector(".rl-last .none").textContent, "No spins yet");
  assert.equal(lob.querySelector(".tcard-h small").textContent, "Single-zero roulette · Bets open", "idle: no clock until the first chip");
  const acts = card.querySelectorAll(".acts a");
  assert.deepEqual(acts.map((a) => [a.textContent, a.getAttribute("href"), a.className]),
                   [["Play", "/casino/roulette/t/w2", "cz-btn gold sm"], ["👁 Watch", "/casino/roulette/t/w2", "cz-btn ghost sm"]]);
  // spinning: the landing countdown; result: the pocket in words
  const Q = await started(LOBBY({ tables: [wheel("w3", { phase: "spinning", land_at: NOW + 9000, last: [5] }), wheel("w4", { phase: "result", last: [5, 32] }),
                                           wheel("w5", { phase: "result", last: [0] })] }), { hash: "#roulette" });
  const subs = cards(Q).map((c) => c.querySelector(".tcard-h small").textContent);
  assert.deepEqual(subs, ["Single-zero roulette · No more bets · 0:09", "Single-zero roulette · Result · 32 ◆ Red", "Single-zero roulette · Result · 0 · Zero"]);
});

test("tabs: Roulette shows only wheels, Blackjack and Hold'em none; an empty Roulette tab says so; Sit & Gos stay off the Roulette tab", async () => {
  const rows = [bj("t1"), hm("h1"), wheel("w1", { lobby: true }), wheel("w2", { host: "Cy" })];
  const P = await started(LOBBY({ tables: rows }));
  assert.deepEqual(titles(P), ["Ann's table"], "the page's game (blackjack): no wheels - they used to draw as Blackjack cards");
  P.D.click(tab(P, "holdem"));
  assert.deepEqual(titles(P), ["Bo's table"]);
  P.D.click(tab(P, "roulette"));
  assert.deepEqual(titles(P), ["Pepe's wheel", "Cy's wheel"]);
  assert.equal(tab(P, "roulette").getAttribute("aria-selected"), "true");
  assert.equal(tab(P, "bj").getAttribute("aria-selected"), "false");
  P.D.click(tab(P, "all"));
  assert.deepEqual(titles(P), ["Pepe's wheel", "Ann's table", "Bo's table", "Cy's wheel"]);
  const E = await started(LOBBY({ tables: [bj("t1")] }), { hash: "#roulette" });
  assert.equal(cards(E).length, 0);
  assert.equal(E.D.doc.querySelector("#cz-tables .lob-empty").textContent, "No wheel is open right now. Open one and others can join you.");
  // the Hold'em page's Sit & Go section hides on the Roulette tab as on the Blackjack one
  const src = rd("public", "js", "casino-ui.js");
  assert.match(src, /lobbyTab === "bj" \|\| lobbyTab === "roulette";/);
});

test("💎 wheels sit in the High Roller section: locked for everyone else (anyone watches), Play for a High Roller", async () => {
  const H = wheel("w7", { host: "Dee", high_stakes: true, tier: "hr", min_bet: 1000, max_bet: 500000, max_straight: 25000, players: 2 });
  const P = await started(LOBBY({ tables: [wheel("w1", { lobby: true }), H] }), { hash: "#roulette" });
  assert.deepEqual(titles(P), ["Pepe's wheel"], "not with the normal wheels");
  assert.deepEqual(titles(P, "cz-hrtables"), ["Dee's wheel"]);
  const c = cards(P, "cz-hrtables")[0];
  assert.ok(c.classList.contains("hr"));
  assert.equal(c.querySelector(".tcard-h .ic").textContent, "💎");
  assert.ok(c.querySelectorAll(".meta .tag").map((x) => x.textContent).includes("💎 High Roller"));
  assert.equal(c.querySelector(".meta .tag.gold").textContent, "Min 1,000 · Straight 25,000 · 500,000 a spin");
  assert.equal(c.querySelector(".acts .tag.lock").textContent, "🔒 High Rollers only");
  assert.equal(c.querySelectorAll(".acts a").map((a) => a.textContent).join("|"), "👁 Watch", "anyone can watch");
  const Q = await started(LOBBY({ tables: [H], me: { name: "Dee", balance: 900000, high_roller: true } }), { hash: "#roulette" });
  assert.equal(cards(Q, "cz-hrtables")[0].querySelector(".acts a.gold").textContent, "Play");
  // a full wheel (players per spin): Full, aria-disabled
  const F = await started(LOBBY({ tables: [wheel("w8", { host: "Eve", players: 35 })] }), { hash: "#roulette" });
  const full = cards(F)[0].querySelector(".acts a.gold");
  assert.deepEqual([full.textContent, full.getAttribute("aria-disabled")], ["Full", "true"]);
});

test("#roulette picks the tab once the lobby says roulette is open; a tab you pick is written to the address; roulette shut: the page's own game, no wheels drawn", async () => {
  const rows = [bj("t1"), wheel("w1", { lobby: true })];
  const P = await started(LOBBY({ tables: rows }), { hash: "#roulette" });
  assert.equal(tab(P, "roulette").getAttribute("aria-selected"), "true");
  assert.deepEqual(titles(P), ["Pepe's wheel"]);
  P.D.click(tab(P, "all"));
  assert.deepEqual(P.replaced, ["#all"], "replaceState - no history entry for a tab");
  P.D.click(tab(P, "bj"));
  assert.deepEqual(P.replaced, ["#all", "/casino/blackjack"], "the page's own game: the plain address");
  P.D.click(tab(P, "bj"));
  assert.equal(P.replaced.length, 2, "nothing to write");
  // an unknown hash (the Hold'em page's #mtt anchor) is left alone
  const M = await started(LOBBY({ tables: rows }), { hash: "#mtt", game: "holdem" });
  assert.equal(tab(M, "holdem").getAttribute("aria-selected"), "true");
  M.D.click(tab(M, "holdem"));
  assert.deepEqual(M.replaced, [], "#mtt stays");
  // roulette shut for this viewer: #roulette falls back to the page's game, and a stray wheel row (an older server) is never drawn
  let data = LOBBY({ roulette: { on: false, lobby: null, wheels: [] }, tables: rows });
  const S = await started(() => data, { hash: "#roulette" });
  assert.equal(tab(S, "bj").getAttribute("aria-selected"), "true");
  assert.equal(tab(S, "roulette").hidden, true);
  assert.deepEqual(titles(S), ["Ann's table"]);
  S.D.click(tab(S, "all"));
  assert.deepEqual(titles(S), ["Ann's table"], "no wheel card while roulette is shut");
  assert.equal(S.$("cz-stat-tables").querySelector("b").textContent, "1");
  // it opens: the next poll shows the tab and the wheels
  data = LOBBY({ tables: rows });
  await S.poll();
  assert.equal(tab(S, "roulette").hidden, false);
  assert.deepEqual(titles(S), ["Pepe's wheel", "Ann's table"]);
});

test("the hero's stats count the wheels and their players", async () => {
  const P = await started(LOBBY({ tables: [bj("t1", { players: 2 }), hm("h1", { players: 3 }), wheel("w1", { lobby: true, players: 4 }), wheel("w2", { high_stakes: true, players: 1 })],
                                  rooms: [{ id: "pad-a", name: "Pad A" }] }));
  const stat = (id) => P.$(id).querySelector("b").textContent;
  assert.deepEqual([stat("cz-stat-tables"), stat("cz-stat-players"), stat("cz-stat-rooms")], ["4", "10", "1"]);
});

test("Open a wheel: {game: roulette, idem} -> the wheel's page; 💎 sends hr (High Rollers only); never a theme; a refusal says why", async () => {
  const LIST = [{ id: "classic", games: ["holdem", "bj"], default: true }, { id: "saloon", games: ["holdem", "bj"], default: false }];
  let P = await started(LOBBY({ themes: { pick: true, list: LIST } }));
  assert.equal(P.$("cz-open-rl").hidden, false, "the Open a wheel card");
  assert.equal(P.$("cz-open-rl-go").textContent, "Open a wheel");
  assert.equal(P.$("cz-rlmax").textContent, "Bets from 100 PAT · up to 100,000 PAT a spin, all your bets together.", "the per-spin maximum spelled out");
  P.D.click(P.$("cz-themes").querySelectorAll("button")[1]);       // the saloon picked - wheels still open classic
  assert.match(P.$("cz-themenote").textContent, / Roulette wheels open in Classic\.$/);
  P.D.click(P.$("cz-open-rl-go"));
  await flush(); await flush();
  assert.equal(P.posts.length, 1);
  assert.equal(P.posts[0].url, "/api/casino/open");
  assert.deepEqual(Object.keys(P.posts[0].body).sort(), ["game", "idem"], "no theme, no hr");
  assert.equal(P.posts[0].body.game, "roulette");
  assert.match(P.posts[0].body.idem, /^[0-9a-f-]{36}$/, "an idempotency key per open");
  assert.equal(P.location.href, "/casino/roulette/t/w9");
  // a blackjack open still carries the theme (unchanged)
  P.D.click(P.$("cz-open-bj-go"));
  await flush(); await flush();
  assert.deepEqual([P.posts[1].body.game, P.posts[1].body.theme], ["bj", "saloon"]);
  // the 💎 sub-section: its limits for everyone, its button only for High Rollers
  assert.equal(P.$("cz-hrsec-rl").hidden, false);
  assert.equal(P.$("cz-hrrl").textContent, "Bets from 1,000 PAT · up to 500,000 PAT a spin, all your bets together.");
  assert.equal(P.$("cz-open-hrrl-go").parentNode.hidden, true, "not a High Roller: no button");
  assert.ok(P.$("cz-open-hr").classList.contains("three"), "three sub-sections (blackjack, Hold'em, roulette)");
  // (review, WCAG 2.5.3) the 💎 button's spoken name starts with its visible text (Voice Control: "tap Open a wheel, High Roller"),
  // with no emoji read out as "gem stone"
  const hrb = P.$("cz-open-hrrl-go");
  assert.equal(hrb.getAttribute("aria-label"), "Open a wheel, High Roller");
  assert.ok(hrb.getAttribute("aria-label").startsWith(hrb.textContent), "the visible text first");
  assert.doesNotMatch(hrb.getAttribute("aria-label"), /\p{Extended_Pictographic}/u);
  assert.notEqual(hrb.getAttribute("aria-label"), P.$("cz-open-rl-go").textContent, "not the normal button's name");
  // (review) the note under the sub-sections names the 💎 wheels while theirs shows
  assert.equal(P.$("cz-hr-locked").hidden, false);
  assert.equal(P.$("cz-hr-locked-t").hidden, true);
  assert.equal(P.$("cz-hr-locked-rl").hidden, false);
  assert.match(P.$("cz-hr-locked-rl").textContent, /💎 roulette wheels/);
  assert.equal(P.$("cz-hr-locked").querySelector("a").getAttribute("href"), "/shop", "the store link stays");
  P = await started(LOBBY({ me: { name: "Dee", balance: 900000, high_roller: true } }));
  assert.equal(P.$("cz-open-hrrl-go").parentNode.hidden, false);
  P.D.click(P.$("cz-open-hrrl-go"));
  await flush(); await flush();
  assert.deepEqual([P.posts[0].body.game, P.posts[0].body.hr], ["roulette", true]);
  assert.equal(P.location.href, "/casino/roulette/t/w9");
  // refused (one web wheel per host): (review) the refusal names your wheel - go to it (its Host Tools close it); a retry after a lost
  // answer lands on the wheel the first try opened
  P = await started(LOBBY({}), { post: () => ({ ok: false, reply: "You already have a roulette wheel open — close it before you open another.", table: "w2" }) });
  P.D.click(P.$("cz-open-rl-go"));
  await flush(); await flush();
  assert.equal(P.location.href, "/casino/roulette/t/w2", "to your wheel");
  assert.equal(P.$("cz-toast").textContent, "You already have a roulette wheel open — close it before you open another.");
  assert.equal(P.$("cz-open-rl-go").disabled, false);
  // any other refusal (no wheel named): the reason as a toast, no navigation, the button back on
  P = await started(LOBBY({}), { post: () => ({ ok: false, reply: "the casino has 9 tables open already — join one at /tables." }) });
  P.D.click(P.$("cz-open-rl-go"));
  await flush(); await flush();
  assert.equal(P.location.href, "");
  assert.equal(P.$("cz-toast").textContent, "the casino has 9 tables open already — join one at /tables.");
  assert.ok(P.$("cz-toast").classList.contains("bad"));
  assert.equal(P.$("cz-open-rl-go").disabled, false);
  // a blackjack refusal is a toast whatever it carries (unchanged)
  P = await started(LOBBY({}), { post: () => ({ ok: false, reply: "No.", table: "t1" }) });
  P.D.click(P.$("cz-open-bj-go"));
  await flush(); await flush();
  assert.equal(P.location.href, "");
  // signed out: the sign-in link instead of the button
  P = await started(LOBBY({ me: null }), { signed: false });
  assert.equal(P.$("cz-open-rl-go").hidden, true);
  assert.equal(P.$("cz-open-rl").querySelector(".cz-signin").hidden, false);
  // roulette off, blackjack and Hold'em off: no open section at all (as before); roulette on alone keeps it
  P = await started(LOBBY({ enabled: false, hm_enabled: false, roulette: { on: false } }));
  assert.equal(P.$("cz-open-wrap").hidden, true);
  P = await started(LOBBY({ enabled: false, hm_enabled: false }));
  assert.equal(P.$("cz-open-wrap").hidden, false);
  assert.ok(P.$("cz-open-hr").classList.contains("one"), "the 💎 card with roulette alone");
});

test("roulette off: the lobby is the one it was (the 💎 card's two sub-sections, the Open cards, no tab)", async () => {
  const P = await started(LOBBY({ roulette: { on: false, lobby: null, wheels: [] }, tables: [bj("t1"), hm("h1")] }), { hash: "#all" });
  assert.equal(P.$("cz-open-rl").hidden, true);
  assert.equal(P.$("cz-hrsec-rl").hidden, true);
  assert.ok(!P.$("cz-open-hr").classList.contains("three") && !P.$("cz-open-hr").classList.contains("one"));
  assert.equal(P.D.doc.querySelector(".cz-brand small").textContent, "Blackjack and Hold'em with your PAT");
  assert.deepEqual(titles(P), ["Ann's table", "Bo's table"]);
});

test("without PATVRlBets (rlbets.js didn't load) the pockets show without a colour - never a guessed one", async () => {
  const P = await started(LOBBY({ tables: [wheel("w1", { lobby: true, last: [14, 3] })] }), { hash: "#roulette", noBets: true });
  const pk = cards(P)[0].querySelectorAll(".rl-pocket");
  assert.deepEqual(pk.map((x) => x.className), ["rl-pocket newest", "rl-pocket"]);
  assert.deepEqual(pk.map((x) => x.getAttribute("aria-label")), ["3", "14"]);
  // and a bad pocket from a row is dropped, never drawn
  const Q = await started(LOBBY({ tables: [wheel("w1", { lobby: true, last: [5, 37, -1, "x", null, 2.5] })] }), { hash: "#roulette" });
  assert.deepEqual(cards(Q)[0].querySelectorAll(".rl-pocket").map((x) => x.textContent), ["5"]);
});

test("a poll with nothing new keeps the cards as they are (no re-draw: a focused link keeps its focus)", async () => {
  const data = LOBBY({ tables: [wheel("w1", { lobby: true, last: [4] })] });
  const P = await started(data, { hash: "#roulette" });
  const before = cards(P)[0];
  await P.poll();
  assert.equal(cards(P)[0], before, "the same element");
  data.tables[0].players = 2;
  await P.poll();
  assert.notEqual(cards(P)[0], before, "a change redraws");
});

test("(review) a redraw keeps the keyboard focus: the same control in the same card (data-id), one of its kind when its link moved on, the card's first when it's gone", async () => {
  const data = LOBBY({ tables: [bj("t1"), wheel("w1", { lobby: true, last: [4] }), wheel("w2", { host: "Cy", proof: "/casino/fair/w2/5" })] });
  const P = await started(data, { hash: "#all" });
  const doc = P.D.doc;
  const card = (id) => cards(P).find((c) => c.getAttribute("data-id") === id);
  assert.deepEqual(cards(P).map((c) => c.getAttribute("data-id")), ["w1", "t1", "w2"], "each card says its table");
  // Cy's Play link focused; a chip lands on Cy's wheel (its card changes) -> the new Play link of the same card
  const el = card("w2").querySelector(".acts a.gold");
  el.focus();
  data.tables[2].staked = 100;
  await P.poll();
  assert.notEqual(card("w2").querySelector(".acts a.gold"), el, "redrawn");
  assert.equal(doc.activeElement, card("w2").querySelector(".acts a.gold"), "the focus follows the redraw");
  assert.equal(doc.activeElement.focusOpts.preventScroll, true, "no scroll jump");
  // Watch (same href as Play): Watch again, never Play
  card("w2").querySelector(".acts a.ghost").focus();
  data.tables[2].players = 1;
  await P.poll();
  assert.equal(doc.activeElement, card("w2").querySelector(".acts a.ghost"));
  // blackjack's Join on the All tab while a wheel changes
  card("t1").querySelector(".acts a.gold").focus();
  data.tables[1].last = [4, 9];
  await P.poll();
  assert.equal(doc.activeElement, card("t1").querySelector(".acts a.gold"));
  assert.equal(doc.activeElement.getAttribute("href"), "/casino/blackjack/t/t1#bet");
  // the 🔐 Fair link's round moves on: the Fair link of the new round
  card("w2").querySelector("a.tag.green").focus();
  data.tables[2].proof = "/casino/fair/w2/6";
  await P.poll();
  assert.equal(doc.activeElement.getAttribute("href"), "/casino/fair/w2/6");
  // Play turns into Full (the same gold link, aria-disabled): still it
  card("w2").querySelector(".acts a.gold").focus();
  data.tables[2].players = 35;
  await P.poll();
  assert.equal(doc.activeElement.textContent, "Full");
  // the card is gone: the focus goes with it (the body)
  card("t1").querySelector(".acts a.gold").focus();
  data.tables.splice(0, 1);
  await P.poll();
  assert.equal(doc.activeElement, doc.body);
  // focus outside the grids is left alone
  P.$("cz-open-rl-go").focus();
  data.tables[0].players = 3;
  await P.poll();
  assert.equal(doc.activeElement, P.$("cz-open-rl-go"));
  // Play gone (the High Roller role ended: a 💎 wheel's Play turns into the 🔒 tag): the card's first control, Watch
  const H = LOBBY({ tables: [wheel("w7", { host: "Dee", high_stakes: true })], me: { name: "Dee", balance: 900000, high_roller: true } });
  const Q = await started(H, { hash: "#roulette" });
  const hc = () => cards(Q, "cz-hrtables")[0];
  hc().querySelector(".acts a.gold").focus();
  H.me.high_roller = false;
  await Q.poll();
  assert.ok(hc().querySelector(".acts .tag.lock"), "locked now");
  assert.equal(Q.D.doc.activeElement, hc().querySelector(".acts a.ghost"));
});

// ── the chips: one file for every table (contract 9) ──
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
test("chips: casino-chips.css holds .chip / .pile / .stack / ONE .chipbtn / .rl-pocket; casino-css and the pages keep none of it", () => {
  const css = strip(rd("public", "css", "casino-chips.css"));
  const base = strip(rd("views", "partials", "casino-css.ejs"));
  const baseNoPot = base.split(/\r?\n/).filter((l) => !/\.pot \.main/.test(l)).join("\n");      // (the Hold'em pot's bigger pile stays)
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const sel of [".chip {", ".chip.c500", ".chip.c1k", ".chip.c5k", ".chip.c25k", ".chip.cmax", ".chip.hrc {", ".chip.hrc::after", ".chip.c100k", ".chip.c500k",
                     ".chip.c1m {", ".chip.c5m {", ".chip.c1m::before", ".pile {", ".pile .chip", ".stack {", ".stack .chip", ".stack.hr", ".chipbtn {", ".chipbtn .chip",
                     ".chipbtn span.l", ".chipbtn.hr span.l", ".chipbtn:hover", ".chipbtn:active", ".chipbtn[disabled]", ".chipbtn.sm {"]) {
    assert.ok(css.includes(":where(.cz, .rl-controls, .cz-chipset) " + sel), "casino-chips.css: " + sel);
    assert.doesNotMatch(baseNoPot, new RegExp("(^|[}\\n,])\\s*" + reEsc(sel)), "casino-css.ejs no longer has " + sel);
  }
  for (const c of ["red", "black", "zero", "newest"]) assert.match(css, new RegExp("\\.rl-pocket\\." + c + " \\{"));
  // casino-css keeps the felt, the High Roller felt / tags, the buttons, the dock, the cards, and the Hold'em pot's pile
  for (const sel of [".felt {", ".felt.hr {", ".tag.hr", ".cz-btn {", ".dock {", ".tcard {", ".pot .main .pile", ".pot .main.hr"]) assert.ok(base.includes(sel), "casino-css.ejs keeps " + sel);
  assert.doesNotMatch(base, /^\s*\.chip[ .{]/m);
  assert.doesNotMatch(base, /\.chipbtn|\.rchip/);
  // the pages: no chip button rules of their own; Hold'em's rack draws .chipbtn.sm
  const bjv = strip(rd("views", "casino-bj.ejs")).replace(/<%[\s\S]*?%>/g, ""), hmv = strip(rd("views", "casino-hm.ejs")).replace(/<%[\s\S]*?%>/g, "");
  assert.doesNotMatch(bjv, /\.chipbtn[ .:[{]/, "blackjack: the shared .chipbtn");
  assert.doesNotMatch(hmv, /\.rchip/);
  assert.match(bjv, /\.chipbtns \{ display: flex;/, "the rack's row stays the page's");
  const hmjs = rd("public", "js", "casinohm.js");
  assert.doesNotMatch(hmjs, /rchip/);
  assert.match(hmjs, /class="chipbtn sm\$\{\/hrc\/\.test\(c\) \? " hr" : ""\}"/);
  assert.match(rd("public", "js", "casinobj.js"), /class="chipbtn\$\{\/hrc\/\.test\(c\) \? " hr" : ""\}"/, "blackjack's rack: .chipbtn as before");
});

test("chips: the same box model as before - .chipbtn is blackjack's 58 / 52 px button, .chipbtn.sm Hold'em's 46 px .rchip (moved verbatim)", () => {
  const css = strip(rd("public", "css", "casino-chips.css")).replace(/:where\(\.cz, \.rl-controls, \.cz-chipset\) /g, "");
  const rule = (sel) => { const m = new RegExp("(?:^|\\n|\\})\\s*" + sel.replace(/[.[\]()]/g, "\\$&") + " \\{([^}]*)\\}").exec(css); assert.ok(m, sel); return m[1].replace(/\s+/g, " ").trim(); };
  assert.equal(rule(".chipbtn"), "position: relative; display: grid; place-items: center; width: 58px; height: 58px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; background: transparent; font: 700 13px/1 var(--ds-font); color: #111; transition: transform .1s;");
  assert.equal(rule(".chipbtn span.l"), "position: relative; z-index: 2; padding: 3px 5px; border-radius: 999px; background: rgba(255,255,255,.92);");
  assert.equal(rule(".chipbtn.hr span.l"), "background: rgba(0,0,0,.82); color: #ffe082; box-shadow: 0 0 0 1px rgba(255,215,64,.75);");
  assert.equal(rule(".chipbtn.sm"), "width: 46px; height: 46px; font-size: 11px;");
  assert.equal(rule(".chipbtn.sm span.l"), "padding: 2px 4px;");
  assert.equal(rule(".chipbtn.sm.hr span.l"), "box-shadow: 0 0 0 1px rgba(255,215,64,.7);");
  assert.equal(rule(".chipbtn.sm:hover"), "transform: translateY(-2px);");
  assert.equal(rule(".chipbtn.sm:active:not(:hover)"), "transform: none;", "Hold'em's chips never had a press dip");
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.chipbtn \{ width: 52px; height: 52px; \}\s*\}/);
});

test("chips: linked right after the casino-css partial on the blackjack, Hold'em and roulette pages, and with the Room Dock's roulette on the pad page", () => {
  const LINK = '<link rel="stylesheet" href="/public/css/casino-chips.css?v=1">';
  for (const v of ["casino-bj.ejs", "casino-hm.ejs", "casino-rl.ejs"]) {
    const src = rd("views", v).replace(/\r\n/g, "\n");
    assert.ok(src.includes("<%- include('partials/casino-css') %>\n" + LINK), v + ": right after casino-css (the cascade the rules had)");
    assert.equal(src.split(LINK).length, 2, v + ": once");
  }
  const room = rd("views", "room.ejs");
  assert.ok(room.includes(LINK + '<link rel="stylesheet" href="/public/css/casinorl-dock.css?v=3">'), "the pad page, before the Dock's roulette sheet");
  // the lobby pages colour the wheel cards' pockets from PATVRlBets.red: rlbets.js on the lobby (not on a table: that page has its own)
  for (const v of ["casino-bj.ejs", "casino-hm.ejs"]) {
    assert.match(rd("views", v), /<% if \(!tableId\) \{ %><script src="\/api\/casino\/rlbets\.js\?v=2"><\/script><% \} %>/);
    assert.match(rd("views", v), /casino-ui\.js\?v=15/);
  }
  assert.match(rd("views", "casino-hm.ejs"), /casinohm\.js\?v=15/);
});

test("pockets: the lobby's .rl-pocket rules are WP0's (casinorl-dock.css) - one look on the felt, the Dock and the lobby", () => {
  const block = (s) => { const t = strip(s); const a = t.indexOf(".rl-pocket {"); const b = t.indexOf("@media (forced-colors: active)"); return t.slice(a, t.indexOf("}", t.indexOf("}", b) + 1) + 1).replace(/\s+/g, " "); };
  assert.equal(block(rd("public", "css", "casino-chips.css")), block(rd("public", "css", "casinorl-dock.css")));
});

// ── (review) the shared chip inside the Room Dock's .rl-controls: a small cascade (specificity, then source order) over the two sheets
// the pad page links - casino-chips.css, then casinorl-dock.css - for the dock's markup, against the same chip inside .cz ──
const splitTop = (s, sep) => { const parts = []; let d = 0, cur = ""; for (const ch of s) { if ("([".includes(ch)) d++; if (")]".includes(ch)) d--; if (ch === sep && !d) { parts.push(cur.trim()); cur = ""; } else cur += ch; } parts.push(cur.trim()); return parts; };
function cssRules(src) {
  const out = [];
  const walk = (text, media) => {
    let pos = 0;
    for (;;) {
      const open = text.indexOf("{", pos);
      if (open < 0) return;
      const head = text.slice(pos, open).trim();
      let depth = 1, j = open + 1;
      while (depth) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, head.slice(6).trim());
      else if (!head.startsWith("@")) {
        const decls = {};
        for (const d of splitTop(body, ";")) { const k = d.indexOf(":"); if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim().replace(/\s+/g, " "); }
        for (const sel of splitTop(head, ",")) out.push({ sel: sel.replace(/\s+/g, " "), decls, media });
      }
      pos = j;
    }
  };
  walk(strip(src), null);
  return out;
}
function compounds(sel) {           // [{c, comb}] - the combinator to the LEFT of each compound (" " or ">")
  const parts = []; let cur = "", d = 0, pend = null;
  for (const ch of sel) {
    if ("([".includes(ch)) d++;
    if (")]".includes(ch)) d--;
    if (!d && (ch === " " || ch === ">")) { if (cur) { parts.push({ c: cur, comb: pend }); cur = ""; pend = " "; } if (ch === ">") pend = ">"; continue; }
    cur += ch;
  }
  if (cur) parts.push({ c: cur, comb: pend });
  return parts;
}
function simples(c) {
  const out = []; let i = 0;
  const m0 = /^([a-z][\w-]*|\*)/i.exec(c);
  if (m0) { out.push({ t: "tag", v: m0[1].toLowerCase() }); i = m0[0].length; }
  while (i < c.length) {
    const ch = c[i];
    if (ch === "." || ch === "#") { const m = /^[\w-]+/.exec(c.slice(i + 1)); out.push({ t: ch === "." ? "cls" : "id", v: m[0] }); i += 1 + m[0].length; }
    else if (ch === "[") { const j = c.indexOf("]", i); const m = /^([\w-]+)(?:="([^"]*)")?$/.exec(c.slice(i + 1, j)); out.push({ t: "attr", k: m[1], v: m[2] }); i = j + 1; }
    else if (ch === ":") {
      const m = /^::?([\w-]+)/.exec(c.slice(i)); i += m[0].length;
      let arg = null;
      if (c[i] === "(") { let d = 1, j = i + 1; while (d) { if (c[j] === "(") d++; else if (c[j] === ")") d--; j++; } arg = c.slice(i + 1, j - 1); i = j; }
      out.push({ t: m[0].startsWith("::") ? "pel" : "pseudo", v: m[1], arg });
    } else throw new Error("selector " + c);
  }
  return out;
}
function spec(sel) {
  let a = 0, b = 0, c = 0;
  for (const { c: comp } of compounds(sel)) for (const s of simples(comp)) {
    if (s.t === "id") a++;
    else if (s.t === "cls" || s.t === "attr") b++;
    else if (s.t === "tag") c += s.v === "*" ? 0 : 1;
    else if (s.t === "pel") c++;
    else if (s.v === "is" || s.v === "not") { const best = splitTop(s.arg, ",").map(spec).sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0]; a += best[0]; b += best[1]; c += best[2]; }
    else if (s.v !== "where") b++;
  }
  return [a, b, c];
}
function matchSel(sel, chain, ei) {
  const parts = compounds(sel);
  const at = (pi, k) => {
    if (!matchCompound(parts[pi].c, chain, k)) return false;
    if (pi === 0) return true;
    if (parts[pi].comb === ">") return k > 0 && at(pi - 1, k - 1);
    for (let x = k - 1; x >= 0; x--) if (at(pi - 1, x)) return true;
    return false;
  };
  return at(parts.length - 1, ei);
}
function matchCompound(comp, chain, k) {
  const e = chain[k];
  return simples(comp).every((s) => {
    if (s.t === "tag") return s.v === "*" || e.tag === s.v;
    if (s.t === "cls") return e.cls.includes(s.v);
    if (s.t === "id") return e.id === s.v;
    if (s.t === "attr") return s.k in e.attrs && (s.v === undefined || e.attrs[s.k] === s.v);
    if (s.t === "pel") return false;                                   // (the element itself, never a pseudo-element)
    if (s.v === "where" || s.v === "is") return splitTop(s.arg, ",").some((x) => matchSel(x, chain, k));
    if (s.v === "not") return !splitTop(s.arg, ",").some((x) => matchSel(x, chain, k));
    if (s.v === "disabled") return "disabled" in e.attrs;
    if (s.v === "enabled") return !("disabled" in e.attrs);
    return !!e.state[s.v];                                             // :hover / :active as forced; anything else off
  });
}
const mediaOk = (m, w) => { if (!m) return true; const x = /^\((max|min)-width: (\d+)px\)$/.exec(m); return !!x && (x[1] === "max" ? w <= +x[2] : w >= +x[2]); };
function cascade(rules, chain, w) {
  const won = {};
  rules.forEach((r, order) => {
    if (!mediaOk(r.media, w) || !matchSel(r.sel, chain, chain.length - 1)) return;
    const sp = spec(r.sel);
    for (const [p, v] of Object.entries(r.decls)) {
      const cur = won[p];
      const cmp = cur ? sp[0] - cur.sp[0] || sp[1] - cur.sp[1] || sp[2] - cur.sp[2] : 1;
      if (cmp >= 0) won[p] = { v, sp, sel: r.sel };              // (equal specificity: the later rule wins)
    }
  });
  return won;
}
test("(review) chips in the Room Dock: inside .rl-controls the one .chipbtn keeps its box (58 / 52 px round, transparent, #111 label) - the Dock's `.rl-controls button` tile never wins, in either link order", () => {
  const chips = rd("public", "css", "casino-chips.css"), dockCss = rd("public", "css", "casinorl-dock.css");
  const el = (tag, cls, attrs, state) => ({ tag, cls, attrs: attrs || {}, state: state || {} });
  // the cascade itself, on known cases: the Dock's (0,1,1) beats a (0,1,0) :where() rule, whichever comes first
  for (const css of [":where(.a) .chipbtn { color: red; } .rl-controls button { color: blue; }", ".rl-controls button { color: blue; } :where(.a) .chipbtn { color: red; }"]) {
    assert.equal(cascade(cssRules(css), [el("div", ["rl-controls", "a"]), el("button", ["chipbtn"])], 1280).color.v, "blue");
  }
  assert.deepEqual(spec(":where(.cz, .rl-controls, .cz-chipset) .chipbtn[disabled]"), [0, 2, 0]);
  assert.deepEqual(spec(".rl-controls button:disabled"), [0, 2, 1]);
  assert.deepEqual(spec(".chipbtn.sm:active:not(:hover)"), [0, 4, 0]);
  const INITIAL = { "min-height": "auto", opacity: "1" };
  // (WP0 O13(1), the iPhone: a quick second tap on the Dock's chips bets again - no zoom, no text selection; it looks the same)
  const DOCK_ONLY = { "touch-action": "manipulation", "-webkit-user-select": "none", "user-select": "none" };
  for (const [oname, order] of [["chips then Dock", [chips, dockCss]], ["Dock then chips", [dockCss, chips]]]) {
    const rules = order.flatMap((src) => cssRules(src));
    for (const w of [1280, 375]) for (const variant of [[], ["hr"], ["sm"], ["sm", "hr"]]) for (const state of [{}, { hover: true }, { active: true }, { disabled: true }]) {
      const btn = el("button", ["chipbtn"].concat(variant), Object.assign({ type: "button" }, state.disabled ? { disabled: "" } : {}), state);
      const label = el("span", ["l"]);
      const cz = [el("main", ["ds-page", "cz"]), el("div", ["dock-row", "chipbtns"]), btn];
      const dock = [el("div", ["rl-controls"]), el("div", ["rl-chips"]), btn];
      const czDock = [el("main", ["ds-page", "cz"]), el("div", ["dock"]), el("div", ["rl-controls"]), el("div", ["rl-chips"]), btn];     // (the roulette page's dock)
      const want = cascade(rules, cz, w), wantL = cascade(rules, cz.concat([label]), w);
      for (const [name, chain] of [["the Dock", dock], ["the roulette page's dock", czDock]]) {
        const got = cascade(rules, chain, w), gotL = cascade(rules, chain.concat([label]), w);
        const why = `${name} · ${oname} · ${w}px · .chipbtn${variant.map((v) => "." + v).join("")}${Object.keys(state).map((s) => ":" + s).join("")}`;
        for (const p of new Set(Object.keys(want).concat(Object.keys(got)))) {
          const v = (x) => (x[p] ? x[p].v : INITIAL[p] || "(initial)");
          if (p in DOCK_ONLY && !want[p]) { assert.equal(v(got), DOCK_ONLY[p], `${why}: ${p}`); continue; }
          assert.equal(v(got), v(want), `${why}: ${p} (won by ${got[p] ? got[p].sel : "-"})`);
        }
        for (const p of new Set(Object.keys(wantL).concat(Object.keys(gotL)))) assert.equal(gotL[p] && gotL[p].v, wantL[p] && wantL[p].v, `${why}: the label's ${p}`);
      }
    }
    // and the values themselves, in the Dock
    const box = (w, attrs) => cascade(rules, [el("div", ["rl-controls"]), el("div", ["rl-chips"]), el("button", ["chipbtn"], attrs)], w);
    const b = box(1280);
    assert.deepEqual([b.width.v, b.height.v, b["border-radius"].v, b.background.v, b.color.v, b.border.v, b.padding.v], ["58px", "58px", "50%", "transparent", "#111", "0", "0"]);
    assert.equal(box(375).width.v, "52px");
    const off = box(1280, { disabled: "" });
    assert.deepEqual([off.opacity.v, off.cursor.v], [".35", "not-allowed"], "a disabled chip as on the tables");
  }
});

test("(review) the navbar's 🛞 Roulette lands on the lobby's Roulette tab on the page the casino's front end uses (Pepe's wheel only while neither game is the PATV casino)", async () => {
  const ejs = require("ejs");
  const layout = path.join(__dirname, "..", "views", "layout.ejs");
  const nav = (html) => /<nav class="navbar">[\s\S]*?<\/nav>/.exec(html)[0];
  const href = async (fronts) => {
    const html = nav(await ejs.renderFile(layout, { title: "T", ogPath: "/", user: "someuser", can: () => false, rouletteOn: () => true, casinoOn: (g) => !!fronts[g] }));
    const m = html.match(/<a href="[^"]*" class="nav-link" title="Roulette">/g) || [];
    assert.ok(m.length >= 1, "the link is there");
    const hs = new Set(m.map((x) => /href="([^"]*)"/.exec(x)[1]));
    assert.equal(hs.size, 1, "the same place in every menu");
    return [...hs][0];
  };
  assert.equal(await href({ bj: true, holdem: true }), "/casino/blackjack#roulette");
  assert.equal(await href({ bj: true }), "/casino/blackjack#roulette");
  assert.equal(await href({ holdem: true }), "/casino/holdem#roulette", "blackjack on Pepe's tables: the Hold'em lobby");
  assert.equal(await href({}), "/casino/roulette", "no PATV lobby: Pepe's lobby wheel (the route's redirect)");
  // the lobby reads #roulette as its tab (startLobby's hashTab)
  const P = await started(LOBBY({ tables: [bj("t1"), wheel("w1", { lobby: true })] }), { hash: "#roulette" });
  assert.equal(tab(P, "roulette").getAttribute("aria-selected"), "true");
});

test("(review) a closed player's wheel: Back to the lobby goes to the lobby's 🛞 tab (#cb data-lobby), else Pepe's wheel as before", async () => {
  const closed = async (attrs) => {
    const P = page(`<main class="ds-page flow cz rl-page" id="cb" data-game="roulette" data-table="abc1234567" data-signed="1" data-user="ann"${attrs}>${partial("casino-top", { game: "roulette", tableId: "abc1234567" })}` +
                   `<section id="cz-table" hidden><strong id="cz-msg"></strong><div id="cz-dock"></div></section></main>`,
                   { "/api/casino/t/abc1234567": { __status: 404 } }, {});
    P.CZ.startTable(() => {});
    await flush(); await flush();
    return P;
  };
  let P = await closed(' data-lobby="/casino/blackjack#roulette"');
  const a = P.$("cz-msg").querySelector("a");
  assert.deepEqual([a.textContent, a.getAttribute("href")], ["Back to the lobby", "/casino/blackjack#roulette"]);
  assert.equal(P.$("cz-dock").hidden, true);
  P = await closed(' data-lobby="/casino/holdem#roulette"');
  assert.equal(P.$("cz-msg").querySelector("a").getAttribute("href"), "/casino/holdem#roulette");
  P = await closed("");
  assert.equal(P.$("cz-msg").querySelector("a").getAttribute("href"), "/casino/roulette", "no data-lobby (an older page): as before");
  for (const bad of ["//evil.test/x", "https://evil.test/", "javascript:alert(1)", '/casino/blackjack#x" onclick="y']) {
    P = await closed(` data-lobby="${bad.replace(/"/g, "&quot;")}"`);
    assert.equal(P.$("cz-msg").querySelector("a").getAttribute("href"), "/casino/roulette", "only a same-site path: " + bad);
  }
});

// ── the route ──
const h = require("./fixtures/casino-rl-harness");
const { svc, sql, actor } = h;
async function server(t) {
  const express = require("express"), app = express();
  app.use(express.json());
  app.use((q, r, next) => { const id = q.get("x-test-user"); q.user = id ? { userId: id, username: "player" + id } : null; next(); });
  require("../casino/routes").register(app, { isBotToken: () => false, addUser: (q, r, next) => next() });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  t.after(() => srv.close());
  return async (p, user) => {
    const r = await fetch("http://127.0.0.1:" + srv.address().port + p, { headers: { "X-Requested-With": "fetch", "x-test-user": user || "" } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
test("route: the lobby says the server's clock (now), and the wheel rows it sends draw as wheel cards (Pepe's first, 💎 apart)", async (t) => {
  await h.initialize();
  await h.fresh();
  await sql("DELETE FROM user_roles");
  t.after(() => svc.stop());
  const api = await server(t);
  await sql("INSERT OR IGNORE INTO user_roles (userId, role) VALUES ('b', 'High Roller')");
  const web = await svc.act(actor("a"), "start", [], { room: null, game: "roulette" }, "lobby-open-a");
  assert.equal(web.ok, true, web.reply);
  const hr = await svc.act(actor("b"), "start", ["hr"], { room: null, game: "roulette" }, "lobby-open-b");
  assert.equal(hr.ok, true, hr.reply);
  const j = (await api("/api/casino/lobby?rl=1", "c")).body;
  assert.equal(j.now, svc.S.hooks.now(), "the clock the deadlines are on");
  const ids = j.tables.filter((x) => x.game === "roulette").map((x) => x.id);
  assert.ok(ids.includes(web.table) && ids.includes(hr.table) && ids.length === 3, "the lobby wheel + the two web wheels");
  const P = await started(j, { hash: "#roulette" });
  assert.deepEqual(titles(P), ["Pepe's wheel", "Playera's wheel"]);
  assert.deepEqual(titles(P, "cz-hrtables"), ["Playerb's wheel"]);
  const c = cards(P).find((x) => x.getAttribute("aria-label") === "Playera's wheel");
  assert.equal(c.querySelector(".acts a").getAttribute("href"), "/casino/roulette/t/" + web.table);
  assert.equal(c.querySelector(".meta .tag.gold").textContent, `Min ${svc.S.settings.rl_min_bet.toLocaleString("en")} · Straight ${svc.S.settings.rl_max_straight.toLocaleString("en")} · ${svc.S.settings.rl_max_spin.toLocaleString("en")} a spin`);
  assert.equal(cards(P, "cz-hrtables")[0].querySelector(".meta .tag.gold").textContent, "Min 1,000 · Straight 25,000 · 500,000 a spin");
  assert.equal(P.$("cz-hrrl").textContent, "Bets from 1,000 PAT · up to 500,000 PAT a spin, all your bets together.", "limits().roulette.hr");
});

test("en.json: the lobby's keys", () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales", "en.json"), "utf8"));
  for (const k of ["casino.rl.open_note", "casino.rl.open_go", "casino.rl.open_hr", "js.casino.rl_wheel_pepe", "js.casino.rl_wheel_of", "js.casino.g_rl", "js.casino.rl_play",
                   "js.casino.rl_no_spins", "js.casino.rl_card_limits", "js.casino.none_rl", "js.casino.rl_open_limits", "js.casino.rl_open_fail", "js.casino.theme_rl_classic",
                   "casino.hr_locked_rl", "js.casino.rl_recent_order"])
    assert.equal(typeof en[k], "string", k);
  assert.deepEqual(en["js.casino.rl_card_tally"], { one: "{n} player · {pat} PAT on the layout", other: "{n} players · {pat} PAT on the layout" });
  assert.doesNotMatch(JSON.stringify(["casino.rl.open_note", "js.casino.rl_open_limits", "js.casino.rl_card_tally"].map((k) => en[k])), /money|real prize/i);
});
