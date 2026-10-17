// 1.99abn: 🎱 the live Bingo page (bingo.js) - Pepe's snapshots in, the public state out (nobody else's cards), your
// own cards with line / full-card hints, stale and finished games, and the page rendering.
//   node --test test/bingo.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const ejs = require("ejs");
const BG = require(path.join(__dirname, "..", "bingo"));

let T = 1_800_000_000_000;
BG._setClock(() => T);
const card = (shift = 0) => [0, 1, 2, 3, 4].map((c) => [1, 2, 3, 4, 5].map((r) => (c === 2 && r === 3 ? 0 : c * 15 + r + shift)));
const snap = (over = {}) => ({ game: { id: "123", room: "PepeFrog.Room", phase: "running", called: [1, 2, 3, 4, 5], pot: { total: 9000, line: 3000, blackout: 6000, rollover: 0 },
  price: 1000, max_cards: 6, line_won: false, line_winners: [], blackout_winners: [],
  players: [{ login: "alice", key: "alice", name: "Alice", cards: [card(), card(5)] }, { login: "bob", key: "bob", name: "Bob", cards: [card(10)] }], ...over } });

test("public state: the balls, pot and players with card COUNTS - never anyone's cards", () => {
  assert.equal(BG.botPost(snap()).ok, true);
  const s = BG.stateFor(null);
  assert.equal(s.game.phase, "running");
  assert.equal(s.game.last, 5);
  assert.deepEqual(s.game.players, [{ name: "Alice", cards: 2 }, { name: "Bob", cards: 1 }]);
  assert.equal(s.me, null);
  assert.ok(!JSON.stringify(s).includes('"card"'), "no cards in the public state");
});

test("your own cards (by linked login, any case) with a line ready; someone else's never", () => {
  BG.botPost(snap());
  const s = BG.stateFor("ALICE");
  assert.equal(s.me.cards.length, 2);
  assert.equal(s.me.cards[0].line, true, "column B 1-5 all called");
  assert.equal(s.me.cards[0].full, false);
  assert.equal(s.me.cards[1].line, false);
  assert.equal(BG.stateFor("carol").me, null);
  assert.equal(BG.stateFor("carol").linked, true);
});

test("junk is refused: bad phase, cards with numbers outside their column", () => {
  assert.equal(BG.botPost({ game: { phase: "weird" } }).ok, false);
  BG.botPost(snap({ players: [{ login: "x", name: "X", cards: [[[99, 1, 2, 3, 4], [16, 17, 18, 19, 20], [31, 32, 0, 33, 34], [46, 47, 48, 49, 50], [61, 62, 63, 64, 65]]] }] }));
  assert.equal(BG.stateFor("x").me.cards.length, 0, "an invalid card is dropped");
});

test("a game Pepe stopped talking about goes away; a finished one stays up a while", () => {
  BG.botPost(snap());
  T += BG.STALE_MS + 1;
  assert.equal(BG.stateFor(null).game, null);
  BG.botPost(snap({ phase: "done", line_winners: ["Alice"], blackout_winners: ["Bob"] }));
  T += BG.STALE_MS + 1;
  assert.equal(BG.stateFor(null).game.blackout_winners[0], "Bob", "done games stay up past STALE_MS");
  T += BG.DONE_MS;
  assert.equal(BG.stateFor(null).game, null);
});

test("the page renders (signed out, no game / a game with my cards)", async () => {
  const view = path.join(__dirname, "..", "views", "bingo.ejs");
  BG._reset();
  const html = await ejs.renderFile(view, { user: null, st: { ok: true, signedIn: false, ...BG.stateFor(null) } }, { async: false });
  assert.match(html, /bingo-page\.js/);
  BG.botPost(snap());
  const html2 = await ejs.renderFile(view, { user: "alice", st: { ok: true, signedIn: true, ...BG.stateFor("alice") } }, { async: false });
  assert.match(html2, /window\.BINGO = /);
  assert.ok(!/<\/script><script>/.test(html2.split("window.BINGO = ")[1].split(";\n")[0]), "the state can't close the script tag");
});
