"use strict";
// 1.99aoe roulette review fixes (handoff 37 integration review): one test per finding, invented accounts a..d.
const test = require("node:test"),
  assert = require("node:assert/strict");
const h = require("./fixtures/casino-rl-harness");
const { svc, act, cash, total, room, expect, tick } = h;
test.before(h.initialize);
test.beforeEach(h.fresh);
test.after(() => svc.stop());

test("MONEY-1: Rebet while a spin is in the air repeats that spin's slip (queued), also for a first-time player", async () => {
  const T = await room();
  const start = await total();
  expect(await act(T, "a", "bet", "17 5000"));
  await tick(25000);
  await tick(8000);
  await tick(5000);
  expect(await act(T, "a", "bet", "red 100"));
  await tick(25000);
  assert.equal(T.eng.phase, "spinning");
  assert.equal((await svc.meView(T, "a")).last_slip, "red 100");
  const out = expect(await act(T, "a", "rebet"));
  assert.match(out.reply, /red 100/);
  assert.doesNotMatch(out.reply, /17 5000/);
  await tick(8000);
  assert.equal((await svc.meView(T, "a")).last_slip, "red 100", "at the result: the spin that landed");
  const landed = await cash("a");
  await tick(5000);
  assert.equal(landed - (await cash("a")), 100, "the queued rebet is charged when the next window opens");
  // betting: the previous spin, not the lines on the wheel now
  assert.equal((await svc.meView(T, "a")).last_slip, "red 100");
  const first = await room("pad-b");
  expect(await act(first, "b", "bet", "black 200"));
  await tick(25000);
  const again = expect(await act(first, "b", "rebet"));
  assert.match(again.reply, /black 200/);
  await tick(8000);
  await tick(5000);
  assert.equal(await total(), start);
});
