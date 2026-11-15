"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const E = require("../casino/rlengine"),
  F = require("../casino/fair");
const v = require("./fixtures/casino-rl-vectors.json");
test("single-zero wheel, felt counts and exhaustive payouts", () => {
  assert.equal(new Set(E.WHEEL).size, 37);
  assert.equal(E.RED.length, 18);
  E.WHEEL.slice(2).forEach((n, i) => assert.notEqual(E.color(n), E.color(E.WHEEL[i + 1])));
  const counts = {};
  for (const b of Object.values(E.positions)) {
    counts[b.kind] = (counts[b.kind] || 0) + 1;
    let total = 0;
    for (let p = 0; p < 37; p++) {
      const n = E.returnOf(b, 100, p);
      assert.equal(n, b.nums.includes(p) ? 100 * (b.odds + 1) : 0);
      total += n;
    }
    assert.equal(total, 3600);
  }
  assert.deepEqual(counts, {
    straight: 37,
    split: 60,
    corner: 22,
    trio: 2,
    first_four: 1,
    street: 12,
    line: 11,
    dozen: 3,
    column: 3,
    red: 1,
    black: 1,
    even: 1,
    odd: 1,
    low: 1,
    high: 1,
  });
});
test("fairness known answer and independent pinned slips", () => {
  assert.equal(F.commitment(v.seed), v.commitment);
  for (const [i, p] of v.pockets.entries()) {
    assert.equal(F.spinPocket(v.seed, v.client, i + 1), p);
    const rec = {
      commitment: v.commitment,
      server_seed: v.seed,
      client_seed: v.client,
      round: i + 1,
      shoe: { pocket: p, pockets: 37 },
    };
    assert.equal(F.verifySpin(rec).ok, true);
    assert.equal(F.verifySpin({ ...rec, shoe: { pocket: (p + 1) % 37, pockets: 37 } }).ok, false);
  }
  for (const row of v.slips) {
    const lines = row.lines.map(([uid, token, amount]) => ({ uid, bets: [{ ...E.positions[token], amount }] }));
    const r = E.settle(lines, row.pocket);
    for (const [u, n] of Object.entries(row.returns)) assert.equal(r[u].returned, n);
  }
});
test("liability includes losing stakes and a withdrawn hedge may be refused", () => {
  const make = (t, n) => ({ uid: "a", bets: [{ ...E.positions[t], amount: n }] });
  const lines = [make("17", 100), make("red", 100)];
  assert.equal(E.worst(E.lossVector(lines)), 3400);
  assert.equal(E.removeOk(E.lossVector(lines), lines[1], 3400), false);
  let seed = 13;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pos = Object.values(E.positions);
  for (let i = 0; i < 300; i++) {
    const book = Array.from({ length: 1 + Math.floor(next() * 12) }, () =>
      make(pos[Math.floor(next() * pos.length)].token, 1 + Math.floor(next() * 400)),
    );
    const risk = Array.from({ length: 37 }, (_, p) =>
      book.reduce((s, l) => s + E.returnOf(l.bets[0], l.bets[0].amount, p) - l.bets[0].amount, 0),
    );
    assert.deepEqual(E.lossVector(book), risk);
    const ceiling = E.worst(risk) + Math.floor(next() * 1000),
      b = pos[Math.floor(next() * pos.length)],
      max = E.maxMore(risk, b, ceiling);
    assert.ok(E.worst(E.lossVector(book.concat(make(b.token, max)))) <= ceiling);
    assert.ok(E.worst(E.lossVector(book.concat(make(b.token, max + 1)))) > ceiling);
    assert.equal(E.removeOk(risk, book[0], ceiling), E.worst(E.lossVector(book.slice(1))) <= ceiling);
  }
});
