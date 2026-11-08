// h22 phase 2 (1.99??): the prize arithmetic of a scheduled multi-table tournament (casino/mttpay.js) - pure, integer amounts. The small-field
// bands, the curve in basis points (pinned for E = 2..500), the escrow / overlay splits, places from bust batches (ties, across tables,
// a disqualification, re-entries), the tie split's odd PAT in odd-chip order, the leaderboard points and the estimated length.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(require("os").tmpdir(), "casino-mtt-pure-")));     // (tourney.js loads the database module)
const PAY = require(path.join(repo, "casino", "mttpay"));
const TN = require(path.join(repo, "casino", "tourney"));
const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "mtt-payout-vectors.json"), "utf8"));
const money = { small_pcts: TN.parsePayouts("100|65,35|50,30,20"), paid_pct: 15, exp: 0.9, min_paid: 3 };

test("E <= 9: the owner's bands (100 | 65/35 | 50/30/20) - the Sit & Go's format and prizeTable's arithmetic", () => {
  for (let E = 2; E <= 9; E++) {
    const band = E <= 3 ? [100] : E <= 6 ? [65, 35] : [50, 30, 20];
    assert.equal(PAY.paid(E, money), band.length, `E=${E}`);
    assert.deepEqual(PAY.planBp(E, money), band.map((p) => p * 100));
    for (const P of [E * 1000, E * 1001, E * 999 + 7]) {
      assert.deepEqual(PAY.split(P, PAY.planBp(E, money)), TN.prizeTable(P, band), `E=${E} P=${P}: the same floors and remainder as phase 1`);
    }
  }
});

test("E = 10..500: paid = min(E-1, max(3, floor(0.15 E))); 10,000 basis points, non-increasing, pinned; the smallest prize >= the entry", () => {
  for (let E = 10; E <= 500; E++) {
    const bp = PAY.planBp(E, money);
    assert.equal(bp.length, Math.min(E - 1, Math.max(3, Math.floor(0.15 * E))), `E=${E}`);
    assert.equal(bp.reduce((a, b) => a + b, 0), 10000);
    for (let i = 1; i < bp.length; i++) assert.ok(bp[i] <= bp[i - 1], `E=${E}: non-increasing at ${i}`);
    assert.deepEqual(bp, VEC.defaults[E], `E=${E}: pinned`);
    const buyin = 1000, fee = 100;
    const prizes = PAY.split(buyin * E, bp);
    assert.ok(Math.min(...prizes) >= buyin + fee, `E=${E}: the smallest paid prize ${Math.min(...prizes)} >= ${buyin + fee}`);
  }
  for (let E = 2; E <= 9; E++) assert.deepEqual(PAY.planBp(E, money), VEC.defaults[E]);
  assert.deepEqual(PAY.planBp(27, Object.assign({}, money, { paid_pct: 25 })), VEC.e27_25pct, "E = 27 at 25 %: paid 6");
  assert.equal(PAY.paid(27, Object.assign({}, money, { paid_pct: 25 })), 6);
});

test("splits: escrow sums to P exactly (the remainder to 1st), overlay to O exactly, prize = escrow + overlay; zero prizes; a freeroll (P = 0)", () => {
  for (const [E, P, O] of [[10, 10007, 0], [27, 27000, 3001], [180, 900000, 99999], [500, 499999, 1], [4, 0, 20000]]) {
    const bp = PAY.planBp(E, money);
    const esc = PAY.split(P, bp), ovl = PAY.split(O, bp);
    assert.equal(esc.reduce((a, b) => a + b, 0), P);
    assert.equal(ovl.reduce((a, b) => a + b, 0), O);
    assert.ok(esc.every((x) => Number.isInteger(x) && x >= 0));
    assert.ok(esc[0] >= Math.floor((P * bp[0]) / 10000), "the remainder goes to 1st");
  }
  assert.deepEqual(PAY.split(0, [5000, 3000, 2000]), [0, 0, 0]);
});

const ent = (key, seq, stack, table, oc, winner) => ({ key, bust_seq: seq, bust_stack: stack, bust_table_no: table, bust_oc: oc, winner: !!winner });

test("places: the winner 1st; later bust batches higher; within a batch the bigger starting stack higher; equal = one tie group; across tables; a DQ; re-entries", () => {
  const list = [ent("w:1", null, null, 1, 0, true), ent("a:1", 5, 3000, 1, 2), ent("b:1", 5, 1200, 2, 0), ent("c:1", 4, 9000, 1, 1),
                ent("d:1", 6, 500, 3, 4), ent("e:1", 6, 500, 2, 1), ent("f:1", 2, 0, 0, 0), ent("a:2", 1, 1500, 2, 3)];
  const p = PAY.places(list);
  assert.deepEqual(p.map((x) => [x.key, x.place, x.tied]), [
    ["w:1", 1, null], ["e:1", 2, [2, 3]], ["d:1", 3, [2, 3]], ["a:1", 4, null], ["b:1", 5, null], ["c:1", 6, null], ["f:1", 7, null], ["a:2", 8, null],
  ], "a tie across tables (one hand-for-hand batch): table 2 before table 3 in odd-chip order; a DQ (own batch, stack 0) ranks by its batch; a re-entry is its own entry");
});

test("ties: two- and three-way, straddling the bubble (unpaid places count 0), the odd PAT one each in odd-chip order (table, then seat after the button)", () => {
  // three-way tie for places 2-4 with prizes 300 / 200 / 101 (601 / 3 = 200 r 1): the first in odd-chip order gets the odd PAT
  let placed = PAY.places([ent("w", null, null, 1, 0, true), ent("x", 3, 800, 2, 0), ent("y", 3, 800, 1, 5), ent("z", 3, 800, 1, 2)]);
  assert.deepEqual(placed.map((p) => p.key), ["w", "z", "y", "x"]);
  let got = PAY.award(placed, [1000, 300, 200, 101]);
  assert.deepEqual(Object.fromEntries(got), { w: 1000, z: 201, y: 200, x: 200 });
  // straddling the bubble: 2 paid places, a tie for 2nd-3rd shares the 2nd prize only
  placed = PAY.places([ent("w", null, null, 1, 0, true), ent("x", 3, 800, 1, 1), ent("y", 3, 800, 1, 0)]);
  got = PAY.award(placed, [700, 301]);
  assert.deepEqual(Object.fromEntries(got), { w: 700, y: 151, x: 150 });
  assert.equal(Array.from(got.values()).reduce((a, b) => a + b, 0), 1001, "amounts exact");
  // two-way
  placed = PAY.places([ent("w", null, null, 1, 0, true), ent("x", 3, 800, 1, 1), ent("y", 3, 800, 1, 0), ent("q", 2, 50, 1, 0)]);
  got = PAY.award(placed, [600, 250, 150]);
  assert.deepEqual(Object.fromEntries(got), { w: 600, y: 200, x: 200, q: 0 });
});

test("points: floor(100 (sqrt(E/place) - 1)), 0 for the last place - vectors; the estimated length (180 x 1,500 -> 18 levels)", () => {
  assert.equal(PAY.points(1, 100), 900);
  assert.equal(PAY.points(1, 10), 216);
  for (const [E, v] of Object.entries(VEC.points)) {
    assert.equal(PAY.points(1, Number(E)), v.first);
    assert.equal(PAY.points(Math.ceil(Number(E) / 2), Number(E)), v.mid);
    assert.equal(PAY.points(Number(E), Number(E)), 0, "the last place scores nothing");
  }
  const levels = TN.parseLevels(TN.DEFAULTS.sng_levels);
  const est = PAY.estimate({ start_chips: 1500, level_ms: 300000, levels }, 180, TN.levelAt);
  assert.deepEqual(est, VEC.estimate_180x1500);
  assert.equal(est.levels, 18);
  assert.equal(est.bound_ms, Math.min(12 * 3600e3, 1.5 * est.est_ms));
});
