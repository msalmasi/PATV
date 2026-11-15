"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const h = require("./fixtures/casino-rl-harness");
const { svc, sql, rows, act, cash, total, held, room, expect, tick, restart, fair, move, funding } = h;
test.before(h.initialize);
test.beforeEach(h.fresh);
test.after(() => svc.stop());
const interrupt = (step) => {
  svc.S.hooks.crash = "rl:" + step;
};
for (const step of ["intent", "charge"])
  test("interruption after " + step + " refunds at most the one interrupted charge", async () => {
    const T = await room(),
      before = await total();
    interrupt(step);
    const out = await act(T, "a", "bet", "red 500");
    assert.equal(out.ok, false);
    const recovered = await restart(T.id);
    assert.equal(recovered.eng.book.length, 0);
    assert.equal(await cash("a"), 500000);
    assert.equal(await total(), before);
    assert.equal(await held(), 0);
    assert.equal(
      (await rows("SELECT * FROM transactions WHERE type LIKE 'roulette refund%'")).length,
      step === "charge" ? 1 : 0,
    );
  });
for (const verb of ["undo", "clear", "end"])
  test("interrupted " + verb + " cannot return a line and settle it again", async () => {
    let T = await room();
    expect(await act(T, "a", "bet", "red 500"));
    expect(await act(T, "a", "bet", "black 300"));
    const before = await total();
    interrupt("refund");
    await act(T, "a", verb);
    T = await restart(T.id);
    if (verb === "undo") {
      assert.equal(await held(), 500);
      expect(await act(T, "a", "go"));
      await tick(8000);
    } else assert.equal(await held(), 0);
    assert.equal(
      (await rows("SELECT * FROM transactions WHERE type LIKE 'roulette refund%'")).length,
      verb === "undo" ? 1 : 2,
    );
    assert.equal(await held(), 0);
    assert.equal(await total(), before);
    if (verb === "end") assert.equal(T.status, "closed");
  });
for (const step of ["predraw", "draw", "payouts", "house+", "flash", "house-", "rewards", "round"])
  test("restart after " + step + " preserves the committed pocket and conservation", async () => {
    let T = await room();
    const before = await total(),
      p = fair.spinPocket(T.round.seed, T.client_seed, 1);
    expect(await act(T, "a", "bet", p + " 200"));
    expect(await act(T, "b", "bet", ((p + 1) % 37) + " 500"));
    interrupt(step);
    await tick(25000);
    if (step !== "draw" && step !== "predraw") await tick(8000);
    T = await restart(T.id);
    if (step === "predraw") {
      assert.equal(T.eng.phase, "betting");
      assert.equal(T.dl.bet, h.time() + 25000);
      await tick(25000);
    }
    if (step === "draw" || step === "predraw") {
      assert.equal(T.eng.phase, "spinning");
      assert.equal(T.round.pocket, p);
      await tick(8000);
    }
    T = await restart(T.id);
    assert.equal(T.eng.phase, "result");
    assert.equal(T.last_round.number, p);
    assert.equal(await cash("a"), 507000);
    assert.equal(await cash("b"), 499500);
    assert.equal(await total(), before);
    assert.equal(
      (await rows("SELECT amount FROM jackpot_rakes WHERE spinId=?", ["crl:" + T.id + ":s1"])).length,
      2,
    );
    assert.equal((await rows("SELECT * FROM transactions WHERE type='roulette payout'")).length, 1);
    assert.equal(
      (await rows("SELECT * FROM casino_events WHERE table_id=? AND kind='result'", [T.id])).length,
      1,
    );
    assert.equal((await svc.fairRecord(T.id, 1)).verified, true);
  });
for (const needed of [false, true])
  test("flash after the outgoing house leg: " + (needed ? "one claim" : "no phantom claim"), async () => {
    let T = await room(),
      p = fair.spinPocket(T.round.seed, T.client_seed, 1);
    expect(await act(T, "a", "bet", p + " 100"));
    expect(await act(T, "a", "go"));
    funding.sync({
      flows: { wheel_shortfall: "jackpot" },
      monetary: {
        flash: { house: true, bank: true, mm: true },
        fedloan_room: 10000000,
        house_hard_floor: 5000000,
      },
    });
    await sql("UPDATE jackpot_rakes SET amount=? WHERE jackpotId='seed'", [5000000 + (needed ? 2000 : 3500)]);
    interrupt("house-");
    await tick(8000);
    T = await restart(T.id);
    const claims = await rows("SELECT amount FROM reserve_claims WHERE flow='flash:house:roulette'");
    assert.equal(claims.length, needed ? 1 : 0);
    if (needed) assert.equal(claims[0].amount, 1500);
    assert.equal(T.eng.phase, "result");
    assert.equal(await cash("a"), 503500);
  });
test("a service offline across land_at pays immediately on boot", async () => {
  let T = await room();
  expect(await act(T, "a", "bet", "red 500"));
  expect(await act(T, "a", "go"));
  move(9000);
  T = await restart(T.id);
  assert.equal(T.eng.phase, "result");
});
