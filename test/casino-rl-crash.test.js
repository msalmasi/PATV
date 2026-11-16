"use strict";
// O2 (per-bet storage, casino/rlstore.js): each money step of a wheel is ONE transaction - a stake with its line's row,
// the wheel's header and the act key's answer; a refund with every flip and credit of the call; a landing with its keyed
// payouts, the House legs, the settled rows, the reveal and the result line. An interruption inside one rolls ALL of it
// back (nothing charged, refunded or paid; the wheel as it was), a restart finds the rows exactly as they committed, and a
// retry moves the PAT once. The draw (unchanged) still commits the pocket from a copy: a failed draw shows nobody a pocket.
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
const lines = (id) => rows("SELECT key, user_id, amount, state, why, bets FROM casino_rl_lines WHERE table_id=? ORDER BY opno", [id]);
const stakes = () => rows("SELECT * FROM transactions WHERE type='roulette bet'");
const refunds = () => rows("SELECT * FROM transactions WHERE type LIKE 'roulette refund%'");
const payouts = () => rows("SELECT * FROM transactions WHERE type='roulette payout'");
const betMs = () => svc.S.settings.rl_bet_secs * 1000,
  spinMs = () => svc.S.settings.rl_spin_secs * 1000;
const liveSum = async () => (await rows("SELECT COALESCE(SUM(amount),0) AS n FROM casino_rl_lines WHERE state='live'"))[0].n;

for (const step of ["intent", "charge", "row", "answer"])
  test("a bet interrupted at " + step + " charges nothing, writes no line or answer; the retry places it once", async () => {
    let T = await room();
    const before = await total();
    interrupt(step);
    const out = await act(T, "a", "bet", "red 500", { key: "rl-crash-" + step });
    assert.equal(out.ok, false);
    assert.equal(T.eng.book.length, 0, "the live wheel is as it was");
    assert.equal(T.eng.phase, "idle");
    assert.equal(await total(), before);
    T = await restart(T.id);
    assert.equal(T.eng.book.length, 0);
    assert.equal(T.eng.phase, "idle");
    assert.equal(await cash("a"), 500000);
    assert.equal((await stakes()).length, 0, "the charge rolled back with the row");
    assert.equal((await refunds()).length, 0, "so nothing needed refunding");
    assert.deepEqual(await lines(T.id), []);
    assert.equal(await held(), 0);
    assert.equal(await total(), before);
    // the interrupted key answers what it answered (act stored the failure): a replay charges nothing
    const replay = await act(T, "a", "bet", "red 500", { key: "rl-crash-" + step });
    assert.equal(replay.ok, false);
    assert.equal(replay.replayed, true);
    assert.equal((await stakes()).length, 0);
    expect(await act(T, "a", "bet", "red 500"));
    assert.equal(await cash("a"), 499500);
    assert.deepEqual(
      (await lines(T.id)).map((l) => [l.user_id, l.amount, l.state, l.bets]),
      [["a", 500, "live", '[["red",500]]']],
    );
    assert.equal((await stakes())[0].transactionId, (await lines(T.id))[0].key, "the row's key is its stake's transactionId");
    assert.equal(await held(), 500);
    assert.equal(await total(), before);
  });

for (const verb of ["undo", "clear", "end"])
  test("an interrupted " + verb + " rolls back whole: no line refunded, both still ride; the retry refunds each once", async () => {
    let T = await room();
    expect(await act(T, "a", "bet", "red 500"));
    expect(await act(T, "a", "bet", "black 300"));
    const before = await total();
    interrupt("refund");
    assert.equal((await act(T, "a", verb)).ok, false);
    assert.equal(T.eng.book.length, 2, "the live wheel is as it was");
    assert.equal(await held(), 800);
    T = await restart(T.id);
    assert.equal(await held(), 800);
    assert.equal(T.eng.book.length, 2);
    assert.equal((await refunds()).length, 0, "the first credit rolled back with its flip");
    assert.deepEqual((await lines(T.id)).map((l) => l.state), ["live", "live"]);
    if (verb === "end") assert.equal(T.closing, true, "the close itself was committed before its refunds");
    expect(await act(T, "a", verb));
    assert.equal((await refunds()).length, verb === "undo" ? 1 : 2);
    assert.deepEqual((await lines(T.id)).map((l) => l.state), verb === "undo" ? ["live", "refunded"] : ["refunded", "refunded"]);
    if (verb === "undo") {
      assert.equal(await held(), 500);
      expect(await act(T, "a", "go"));
      await tick(spinMs());
      assert.deepEqual((await lines(T.id)).map((l) => l.state), ["settled", "refunded"]);
    }
    if (verb === "end") assert.equal(T.status, "closed");
    T = await restart(T.id);
    assert.equal((await refunds()).length, verb === "undo" ? 1 : 2, "a restart refunds nothing again");
    assert.equal(await held(), 0);
    assert.equal(await total(), before);
  });

const inLand = ["payouts", "house+", "flash", "house-", "round"];
for (const step of ["predraw", "draw", ...inLand, "rewards"])
  test("restart after " + step + " preserves the committed pocket and conservation", async () => {
    let T = await room();
    const before = await total(),
      p = fair.spinPocket(T.round.seed, T.client_seed, 1);
    expect(await act(T, "a", "bet", p + " 200"));
    expect(await act(T, "b", "bet", ((p + 1) % 37) + " 500"));
    interrupt(step);
    await tick(betMs());
    if (step !== "draw" && step !== "predraw") await tick(spinMs());
    if (inLand.includes(step)) {
      // the settlement is one transaction: interrupted, none of it happened - no payout, no House leg, both rows live,
      // and the supply never counts the stakes as held AND paid
      assert.equal((await payouts()).length, 0);
      assert.equal((await rows("SELECT * FROM jackpot_rakes WHERE spinId=?", ["crl:" + T.id + ":s1"])).length, 0);
      assert.deepEqual((await lines(T.id)).map((l) => l.state), ["live", "live"]);
      assert.equal(await held(), 700);
      assert.equal(await total(), before);
      assert.equal(T.eng.phase, "spinning");
    }
    T = await restart(T.id);
    if (step === "predraw") {
      assert.equal(T.eng.phase, "betting");
      assert.equal(T.dl.bet, h.time() + betMs());
      await tick(betMs());
    }
    if (step === "draw" || step === "predraw") {
      assert.equal(T.eng.phase, "spinning");
      assert.equal(T.round.pocket, p);
      await tick(spinMs());
    }
    T = await restart(T.id);
    assert.equal(T.eng.phase, "result");
    assert.equal(T.last_round.number, p);
    assert.equal(await cash("a"), 507000);
    assert.equal(await cash("b"), 499500);
    assert.equal(await total(), before);
    assert.equal(await held(), 0);
    assert.deepEqual((await lines(T.id)).map((l) => l.state), ["settled", "settled"]);
    assert.equal(
      (await rows("SELECT amount FROM jackpot_rakes WHERE spinId=?", ["crl:" + T.id + ":s1"])).length,
      2,
    );
    assert.equal((await payouts()).length, 1);
    assert.equal(
      (await rows("SELECT * FROM casino_events WHERE table_id=? AND kind='result'", [T.id])).length,
      1,
    );
    assert.equal((await svc.fairRecord(T.id, 1)).verified, true);
    // the landed set while the result is up, after the restart too (O10 / the rewards)
    assert.deepEqual(svc.RL.frozenLines(T).map((l) => [l.uid, l.amount]), [["a", 200], ["b", 500]]);
  });
test("a crash between the landing's commit and its rewards: the restart runs them, once", async () => {
  let T = await room();
  const p = fair.spinPocket(T.round.seed, T.client_seed, 1);
  expect(await act(T, "a", "bet", p + " 100"));
  expect(await act(T, "a", "go"));
  interrupt("landed");
  await tick(spinMs());
  const counts = () => rows("SELECT metric, n FROM casino_ach_counts WHERE userId='a' ORDER BY metric");
  assert.deepEqual(await counts(), [], "paid and settled, no rewards yet");
  assert.equal(await cash("a"), 503500);
  T = await restart(T.id);
  T = await restart(T.id);
  assert.deepEqual((await counts()).map((r) => [r.metric, r.n]), [["rl_spins", 1], ["rl_straight_wins", 1]]);
  assert.equal(await cash("a"), 503500);
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
    await tick(spinMs());
    assert.equal((await rows("SELECT * FROM reserve_claims WHERE flow='flash:house:roulette'")).length, 0, "the claim rolled back too");
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
  move(spinMs() + 1000);
  T = await restart(T.id);
  assert.equal(T.eng.phase, "result");
  assert.equal(await liveSum(), 0);
});
test("a refused charge writes no row and no wheel state (act keeps only its refusal for the key)", async () => {
  const T = await room();
  await sql("UPDATE users SET points_balance=300 WHERE userId='b'");
  const rev = T.rev;
  const out = await act(T, "b", "bet", "red 500", { key: "rl-poor" });
  assert.equal(out.ok, false);
  assert.match(out.reply, /could not be charged/);
  assert.equal(T.rev, rev, "the wheel's JSON was not rewritten");
  assert.deepEqual(await lines(T.id), []);
  assert.equal(await cash("b"), 300);
});
