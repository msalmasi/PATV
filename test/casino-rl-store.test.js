"use strict";
// O2 (ENGINE-8) per-bet storage, release A - casino/rlstore.js: a line is one casino_rl_lines row keyed by its stake's
// transactionId, committed with the stake and the act key's answer; the supply sums the live rows; the shared bank sums
// every open wheel's cached rows. Release A keeps a JSON mirror the PREVIOUS build (1.99aoi, the deployed base: every module this
// release changed as that build has it - test/fixtures/casino-prev/ - run in its own process by test/fixtures/casino-rl-prev-boot.js)
// acts on correctly after the CI's automatic rollback, and this build migrates exactly what that build leaves (mid-betting, mid-spin,
// mid-settlement, an interrupted refund or placement).
const test = require("node:test"),
  assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const h = require("./fixtures/casino-rl-harness");
const { svc, sql, rows, act, cash, total, held, room, lobby, expect, tick, restart, fair } = h;
const engine = require("../casino/rlengine");
const grammar = require("../casino/rlbets");
const store = require("../casino/rlstore");
test.before(h.initialize);
test.beforeEach(h.fresh);
test.after(() => svc.stop());

const lines = (id) => rows("SELECT * FROM casino_rl_lines WHERE table_id=? ORDER BY opno", [id]);
const live = async () => (await rows("SELECT COALESCE(SUM(amount),0) AS n FROM casino_rl_lines WHERE state='live'"))[0].n;
const refunds = () => rows("SELECT * FROM transactions WHERE type LIKE 'roulette refund%' ORDER BY transactionId");
const payouts = () => rows("SELECT * FROM transactions WHERE type='roulette payout'");
const stateOf = async (id) => JSON.parse((await rows("SELECT state FROM casino_tables WHERE id=?", [id]))[0].state);
const spinMs = () => svc.S.settings.rl_spin_secs * 1000,
  betMs = () => svc.S.settings.rl_bet_secs * 1000,
  resultMs = () => svc.S.settings.rl_result_secs * 1000;
const bare = (b) => ({ kind: b.kind, nums: [...b.nums], odds: b.odds, amount: b.amount, token: b.token });
const shape = (book) => book.map((l) => ({ uid: l.uid, key: l.key, amount: l.amount, bets: l.bets.map(bare) }));
const settleOf = (book, p) => engine.settle(book.map((l) => ({ uid: l.uid, bets: l.bets })), p);
// The previous build on this database (the CI's rollback), in its own process. -> its JSON summary; the clock follows it
function prevBuild(steps) {
  svc.stop();
  const raw = execFileSync(
    process.execPath,
    [path.join(__dirname, "fixtures", "casino-rl-prev-boot.js"), process.cwd(), String(h.time()), JSON.stringify(steps)],
    { encoding: "utf8" },
  );
  const out = JSON.parse(raw.trim().split("\n").pop());
  for (const f of out.loaded || []) prevLoaded.add(f);
  h.move(out.now - h.time());
  return out;
}
const prevLoaded = new Set(); // (the repo modules each previous-build run loaded - the last test checks them against the base)

test("a line is one row: its stake's key, compact bets, committed with the stake and the act key's answer", async () => {
  let T = await room();
  expect(await act(T, "a", "bet", "17 300 17-18 200 red 100", { key: "rl-store-1" }));
  const [row] = await lines(T.id);
  const [debit] = await rows("SELECT * FROM transactions WHERE type='roulette bet'");
  assert.equal(row.key, "crl:" + T.id + ":s1:a:b1");
  assert.equal(row.key, debit.transactionId);
  assert.equal(row.amount, 600);
  assert.equal(debit.points, -600);
  assert.equal(row.state, "live");
  assert.equal(row.act_key, "rl-store-1");
  assert.equal(row.round_no, 1);
  assert.deepEqual(JSON.parse(row.bets), [["17", 300], ["17-18", 200], ["red", 100]]);
  const answer = await rows("SELECT response FROM casino_actions WHERE key='rl-store-1'");
  assert.equal(answer.length, 1);
  assert.equal(JSON.parse(answer[0].response).ok, true);
  // the cached line is the parser's, and it comes back the same from the row (kind / nums / odds from rlbets.positions)
  const parsed = grammar.parse("17 300 17-18 200 red 100", { maxPairs: 20, minBet: 100 }).bets;
  assert.deepEqual(T.eng.book[0].bets.map(bare), parsed.map(bare));
  T = await restart(T.id);
  assert.deepEqual(T.eng.book[0].bets.map(bare), parsed.map(bare));
  assert.deepEqual(T.escrowed, { a: 600 });
  assert.deepEqual(T.stakes, [{ key: row.key, uid: "a", amount: 600 }]);
  assert.equal(await held(), 600);
});

test("a replayed act key after its commit returns the stored answer and charges or refunds nothing - after a restart too", async () => {
  let T = await room();
  const first = expect(await act(T, "a", "bet", "red 500", { key: "rl-replay-bet" }));
  const again = await act(T, "a", "bet", "red 500", { key: "rl-replay-bet" });
  assert.equal(again.replayed, true);
  assert.equal(again.reply, first.reply);
  assert.equal(await cash("a"), 499500);
  T = await restart(T.id);
  assert.equal((await act(T, "a", "bet", "red 500", { key: "rl-replay-bet" })).replayed, true);
  assert.equal(await cash("a"), 499500);
  assert.equal((await lines(T.id)).length, 1);
  expect(await act(T, "a", "bet", "black 200"));
  expect(await act(T, "a", "undo", null, { key: "rl-replay-undo" }));
  T = await restart(T.id);
  assert.equal((await act(T, "a", "undo", null, { key: "rl-replay-undo" })).replayed, true);
  assert.equal((await refunds()).length, 1);
  assert.equal(await cash("a"), 499500);
  assert.deepEqual((await lines(T.id)).map((l) => l.state), ["live", "refunded"]);
  assert.equal(T.eng.book.length, 1);
});

test("supply: the held PAT is the sum of the live rows at every step (refunded and settled rows hold nothing)", async () => {
  const T = await room(),
    L = lobby(),
    start = await total();
  const check = async (n) => {
    assert.equal(await held(), n);
    assert.equal(await live(), n);
    const cached = [T, L].reduce((s, t) => s + Object.values(t.escrowed).reduce((a, b) => a + b, 0), 0);
    assert.equal(cached, n, "the caches are the live rows");
    assert.equal(await total(), start);
  };
  expect(await act(T, "a", "bet", "red 500"));
  expect(await act(L, "b", "bet", "17 100 18 100"));
  expect(await act(T, "c", "bet", "odd 300"));
  await check(1000);
  expect(await act(T, "a", "bet", "black 200"));
  expect(await act(T, "a", "undo"));
  await check(1000);
  expect(await act(T, "c", "clear"));
  await check(700);
  await tick(betMs());
  assert.equal(T.eng.phase, "spinning");
  await check(700);
  await tick(spinMs());
  assert.equal(T.eng.phase, "result");
  assert.equal(L.eng.phase, "result");
  await check(0);
  assert.equal((await rows("SELECT COUNT(*) AS n FROM casino_rl_lines WHERE state='settled'"))[0].n, 2);
});

test("the shared bank sums every open wheel's live rows: the same refusal before and after a restart (the JSON has no book)", async () => {
  await svc.setSetting("rl_spin_cap", "40000");
  let T = await room(),
    L = lobby();
  expect(await act(T, "a", "bet", "17 1000"));
  const before = await act(L, "b", "bet", "17 200");
  assert.equal(before.ok, false);
  assert.equal(before.reply, "🏦 The wheel can take at most 100 more on 17 this spin.");
  assert.deepEqual((await stateOf(T.id)).eng.book, [], "before the draw the JSON carries no bet objects");
  T = await restart(T.id);
  L = lobby();
  const after = await act(L, "b", "bet", "17 200");
  assert.equal(after.reply, before.reply, "the other wheel's rows count right after the boot");
  expect(await act(L, "b", "bet", "17 100"));
  // and a removal is checked against the same book (engine.removeOk): a's line can go, then b's reserve is all there is
  expect(await act(T, "a", "undo"));
  expect(await act(L, "b", "bet", "17 900"));
});

test("release A's mirror: before the draw a refund the previous build can run, from the draw the full book, then nothing", async () => {
  const T = await room();
  const lineOf = (j) => Array.from({ length: 20 }, (_, m) => ((j + m) % 30) + 1 + " 100").join(" ");
  expect(await act(T, "a", "bet", lineOf(0)));
  const one = (await rows("SELECT length(state) AS n FROM casino_tables WHERE id=?", [T.id]))[0].n;
  for (let j = 1; j < 20; j++) {
    svc.S.rate.clear();
    expect(await act(T, "a", "bet", lineOf(j)));
  }
  const s = await stateOf(T.id);
  const twenty = (await rows("SELECT length(state) AS n FROM casino_tables WHERE id=?", [T.id]))[0].n;
  // per extra line the JSON grows by its stake and its key in the refund - not by its 20 bet objects (~1.3 KB)
  assert.ok((twenty - one) / 19 < 200, "the mirror grew " + Math.round((twenty - one) / 19) + " bytes per line");
  assert.deepEqual(s.eng.book, []);
  assert.deepEqual(s.stakes, T.stakes);
  assert.deepEqual(s.escrowed, { a: 40000 });
  assert.deepEqual(s.intent, { refund: T.stakes.map((x) => x.key), amount: 40000, why: "restart", mirror: 1 });
  assert.equal(T.intent, null, "the mirror's intent never reaches the live wheel");
  assert.deepEqual(s.eng.lastslip, {});
  await tick(betMs());
  const drawn = await stateOf(T.id);
  assert.equal(drawn.eng.phase, "spinning");
  assert.equal(drawn.intent, null);
  assert.deepEqual(drawn.eng.book, shape(T.eng.book), "drawn: the full book in the previous build's format");
  svc.S.rate.clear();
  expect(await act(T, "b", "bet", "red 100")); // queued while it spins: the JSON still lands the drawn book
  assert.equal((await stateOf(T.id)).eng.book.length, 20);
  await tick(spinMs());
  const done = await stateOf(T.id);
  assert.equal(done.eng.phase, "result");
  assert.deepEqual([done.eng.book, done.stakes, done.escrowed, done.intent], [[], [], {}, null]);
  assert.equal(done.eng.slips.a.length, 30, "the slip is one compact pair per position");
  assert.ok(done.eng.slips.a.every((x) => Array.isArray(x) && x.length === 2));
  assert.equal(done.round.results, undefined);
});

test("frozenLines: live lines while betting, the frozen set while spinning, the landed set while the result is up", async () => {
  let T = await room();
  const p = fair.spinPocket(T.round.seed, T.client_seed, 1),
    pairs = () => svc.RL.frozenLines(T).map((l) => [l.uid, l.amount]);
  expect(await act(T, "a", "bet", p + " 100"));
  expect(await act(T, "b", "bet", "red 200"));
  assert.deepEqual(pairs(), [["a", 100], ["b", 200]]);
  await tick(betMs());
  assert.deepEqual(pairs(), [["a", 100], ["b", 200]]);
  await tick(spinMs());
  assert.equal(T.eng.book.length, 0);
  assert.deepEqual(pairs(), [["a", 100], ["b", 200]]);
  // the rewards read the landed lines (the book is empty by then): a's straight win counts
  const won = await rows("SELECT n FROM casino_ach_counts WHERE userId='a' AND metric='rl_straight_wins'");
  assert.equal(won[0] && won[0].n, 1);
  T = await restart(T.id);
  assert.deepEqual(pairs(), [["a", 100], ["b", 200]], "while the result is up, after a restart too");
  await tick(resultMs());
  assert.equal(T.eng.phase, "idle");
  assert.deepEqual(pairs(), []);
});

test("migration: a wheel the previous build left mid-betting becomes rows exactly - its bets ride, settle and pay", async () => {
  const start = await total();
  const prev = prevBuild([
    { open: "pad-mig" },
    { act: ["$0", "a", "bet", "red 500"] },
    { act: ["$0", "a", "go"] },
    { tick: spinMs() },
    { tick: resultMs() },
    { act: ["$0", "b", "bet", "17 300 17-18 200"] },
    { act: ["$0", "c", "bet", "odd 100"] },
    { act: ["$0", "c", "bet", "d2 100 c3 100"] },
  ]);
  const id = prev.opened[0],
    old = await stateOf(id);
  assert.equal(old.eng.round_no, 2);
  assert.equal(old.eng.phase, "betting");
  assert.equal(old.eng.book.length, 3);
  assert.equal(old.eng.lastslip.a[0].kind, "red", "the previous build's slip: full bet objects");
  assert.equal(prev.heldJson, 800);
  let T = await restart(id);
  const got = await lines(id);
  assert.deepEqual(got.map((l) => [l.key, l.user_id, l.amount, l.state, l.round_no]), old.eng.book.map((l) => [l.key, l.uid, l.amount, "live", 2]));
  assert.deepEqual(JSON.parse(got[0].bets), [["17", 300], ["17-18", 200]]);
  assert.deepEqual(shape(T.eng.book), shape(old.eng.book), "the cached book is the previous build's book");
  assert.equal(await held(), prev.heldJson);
  assert.equal(await total(), start);
  assert.deepEqual(T.eng.slips.a, [["red", 500]]);
  assert.deepEqual(T.eng.lastslip, {});
  expect(await act(T, "a", "rebet"));
  assert.equal(T.opno, old.opno + 1, "the stake keys carry on");
  const book = T.eng.book.slice();
  await tick(betMs());
  const p = T.round.pocket;
  await tick(spinMs());
  assert.equal(T.eng.phase, "result");
  const net = settleOf(book, p);
  for (const uid of ["b", "c"]) assert.equal(await cash(uid), 500000 + net[uid].net);
  assert.equal(await held(), 0);
  assert.equal(await total(), start);
  assert.deepEqual((await lines(id)).map((l) => l.state), ["settled", "settled", "settled", "settled"]);
});

for (const at of ["spinning", "settling"])
  test("migration: a wheel the previous build left " + (at === "spinning" ? "mid-spin" : "mid-settlement") + " lands its drawn book once", async () => {
    const start = await total();
    const steps = [{ open: "pad-mig2" }, { act: ["$0", "a", "bet", "red 500"] }, { act: ["$0", "b", "bet", "17 300 0 100"] }, { tick: betMs() }];
    if (at === "settling") steps.push({ crash: "rl:payouts" }, { tick: spinMs() });
    const prev = prevBuild(steps);
    const id = prev.opened[0],
      old = await stateOf(id),
      p = old.round.pocket;
    assert.equal(old.eng.phase, "spinning");
    assert.equal(old.round.settle, at === "settling" ? "pending" : undefined);
    const net = settleOf(old.eng.book, p),
      winners = Object.values(net).filter((x) => x.returned > 0).length;
    assert.equal((await payouts()).length, at === "settling" ? winners : 0);
    let T = await restart(id);
    if (at === "spinning") {
      assert.deepEqual(shape(T.eng.book), shape(old.eng.book));
      assert.equal(T.round.pocket, p);
      assert.equal(await held(), 900);
      await tick(spinMs());
    }
    assert.equal(T.eng.phase, "result");
    assert.equal(T.last_round.number, p);
    for (const uid of ["a", "b"]) assert.equal(await cash(uid), 500000 + net[uid].net);
    assert.equal((await payouts()).length, winners, "each winner paid once");
    assert.equal(await held(), 0);
    assert.equal(await total(), start);
    assert.deepEqual((await lines(id)).map((l) => l.state), ["settled", "settled"]);
    T = await restart(id);
    assert.equal(await total(), start);
    assert.equal((await payouts()).length, winners);
  });

test("migration: the previous build's interrupted refund finishes by key (the line it refunded isn't refunded again)", async () => {
  const start = await total();
  const prev = prevBuild([
    { open: "pad-mig3" },
    { act: ["$0", "a", "bet", "red 500"] },
    { act: ["$0", "a", "bet", "black 300"] },
    { act: ["$0", "b", "bet", "odd 100"] },
    { crash: "rl:refund" },
    { act: ["$0", "a", "clear"] },
  ]);
  const id = prev.opened[0],
    old = await stateOf(id);
  assert.equal(old.intent.refund.length, 2);
  assert.equal((await refunds()).length, 1, "that build refunded the first line, then stopped");
  const T = await restart(id);
  assert.equal(T.intent, null);
  assert.equal((await refunds()).length, 2);
  assert.equal(await cash("a"), 500000);
  assert.deepEqual((await lines(id)).map((l) => [l.user_id, l.state]), [["a", "refunded"], ["a", "refunded"], ["b", "live"]]);
  assert.deepEqual(T.escrowed, { b: 100 });
  assert.equal(await held(), 100);
  assert.equal(await total(), start);
});

for (const step of ["intent", "charge"])
  test("migration: the previous build's placement interrupted after its " + step + " - the stake back only if it was charged", async () => {
    const start = await total();
    const prev = prevBuild([{ open: "pad-mig4" }, { act: ["$0", "b", "bet", "odd 100"] }, { crash: "rl:" + step }, { act: ["$0", "a", "bet", "red 500"] }]);
    const id = prev.opened[0];
    assert.equal((await stateOf(id)).intent.key, "crl:" + id + ":s1:a:b2");
    assert.equal(prev.cash.a, step === "charge" ? 499500 : 500000);
    const T = await restart(id);
    assert.equal(T.intent, null);
    assert.equal(await cash("a"), 500000);
    assert.equal((await refunds()).length, step === "charge" ? 1 : 0);
    assert.deepEqual(
      (await lines(id)).map((l) => [l.user_id, l.state]),
      step === "charge" ? [["b", "live"], ["a", "refunded"]] : [["b", "live"]],
    );
    assert.equal(await held(), 100);
    assert.equal(await total(), start);
  });

test("rollback mid-betting: the previous build refunds this build's lines by their keys; rolling forward refunds nothing twice", async () => {
  let T = await room("pad-rb");
  const start = await total();
  expect(await act(T, "a", "bet", "red 500"));
  expect(await act(T, "a", "bet", "4 100 5 100"));
  expect(await act(T, "b", "bet", "17 300 17-18 200"));
  expect(await act(T, "c", "bet", "odd 100"));
  const keys = (await lines(T.id)).map((l) => l.key);
  // the CI rolls back: the previous build boots on this database, refunds the mirror and takes a bet of its own
  const prev = prevBuild([{ act: [T.id, "d", "bet", "even 400"] }]);
  const P = prev.tables.find((t) => t.id === T.id);
  assert.equal(P.phase, "betting");
  assert.deepEqual(P.escrowed, { d: 400 });
  assert.equal(P.intent, null);
  for (const uid of ["a", "b", "c"]) assert.equal(prev.cash[uid], 500000, uid + " refunded by the previous build");
  assert.equal(prev.cash.d, 499600);
  assert.equal(prev.heldJson, 400, "that build's supply counts only its own line");
  assert.deepEqual((await refunds()).map((r) => r.transactionId), keys.map((k) => k + ":refund").sort());
  // the next deploy rolls forward
  const flagged = store.flags.length;
  T = await restart(T.id);
  assert.deepEqual(
    (await lines(T.id)).map((l) => [l.user_id, l.state]),
    [["a", "refunded"], ["a", "refunded"], ["b", "refunded"], ["c", "refunded"], ["d", "live"]],
  );
  assert.deepEqual(store.flags.slice(flagged).map((f) => f.kind), Array(4).fill("live_with_refund"));
  assert.deepEqual(T.escrowed, { d: 400 });
  assert.equal(await held(), 400);
  assert.equal(await total(), start);
  await tick(betMs());
  const p = T.round.pocket;
  await tick(spinMs());
  assert.equal(await cash("d"), 499600 + (p && p % 2 === 0 ? 800 : 0));
  assert.equal((await refunds()).length, 4);
  assert.equal(await held(), 0);
  assert.equal(await total(), start);
});

test("rollback mid-spin: the previous build lands this build's drawn spin from the mirror exactly; rolling forward pays nothing twice", async () => {
  let T = await room("pad-rb2");
  const start = await total(),
    p = fair.spinPocket(T.round.seed, T.client_seed, 1);
  expect(await act(T, "a", "bet", p + " 200"));
  expect(await act(T, "b", "bet", ((p + 1) % 37) + " 500 red 100"));
  expect(await act(T, "c", "bet", "d1 300"));
  await tick(betMs());
  assert.equal(T.eng.phase, "spinning");
  const net = settleOf(T.eng.book, p),
    winners = Object.values(net).filter((x) => x.returned > 0).length;
  const prev = prevBuild([{ tick: spinMs() }]);
  assert.equal(prev.tables.find((t) => t.id === T.id).phase, "result");
  for (const uid of ["a", "b", "c"]) assert.equal(prev.cash[uid], 500000 + net[uid].net, uid + " settled by the previous build");
  assert.equal(prev.heldJson, 0);
  assert.equal((await payouts()).length, winners);
  const flagged = store.flags.length;
  T = await restart(T.id);
  assert.deepEqual((await lines(T.id)).map((l) => l.state), ["settled", "settled", "settled"]);
  assert.deepEqual(store.flags.slice(flagged).map((f) => f.kind), Array(3).fill("settled_elsewhere"));
  assert.equal(await held(), 0);
  assert.equal(await total(), start);
  assert.equal((await payouts()).length, winners);
  await tick(resultMs());
  assert.equal(T.eng.round_no, 2);
  expect(await act(T, "a", "bet", "red 100"));
  assert.equal(await held(), 100);
});

test("boot audit: a live row of a wheel that is not open is refunded by its key, once", async () => {
  let T = await room("pad-audit");
  const start = await total();
  expect(await act(T, "a", "bet", "red 500"));
  svc.stop();
  await sql("UPDATE casino_tables SET status='closed' WHERE id=?", [T.id]); // (its refunds lost: never in this build)
  const flagged = store.flags.length;
  await svc.boot({ tick: false });
  assert.deepEqual(store.flags.slice(flagged).map((f) => f.kind), ["stranded_refunded"]);
  assert.equal(await cash("a"), 500000);
  assert.deepEqual((await lines(T.id)).map((l) => [l.state, l.why]), [["refunded", "audit"]]);
  assert.equal(await held(), 0);
  assert.equal(await total(), start);
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal((await refunds()).length, 1);
});

test("boot audit: a stake debit of the open spin with no row is refunded once and gets a row for the record", async () => {
  let T = await room("pad-stray");
  const start = await total();
  expect(await act(T, "a", "bet", "red 500"));
  svc.stop();
  await require("../casino/money").charge("crl:" + T.id + ":s1:b:b9", "b", 700, "roulette bet"); // charged, never booked
  const flagged = store.flags.length;
  T = await restart(T.id);
  assert.deepEqual(store.flags.slice(flagged).map((f) => f.kind), ["stray_stake_refunded"]);
  assert.equal(await cash("b"), 500000);
  assert.deepEqual((await lines(T.id)).map((l) => [l.user_id, l.state]), [["a", "live"], ["b", "refunded"]]);
  assert.deepEqual(T.escrowed, { a: 500 });
  assert.equal(T.opno, 9, "the next stake key skips the stray one");
  expect(await act(T, "c", "bet", "odd 100"));
  assert.equal((await lines(T.id)).pop().key, "crl:" + T.id + ":s1:c:b10");
  T = await restart(T.id);
  assert.equal((await refunds()).length, 1);
  assert.equal(await held(), 600);
  assert.equal(await total(), start);
});

// ── review fixes ──
test("migration: the previous build's undo and clear in the open spin are no finding - their refunded stakes get record rows, nothing moves", async () => {
  const start = await total();
  const prev = prevBuild([
    { open: "pad-mig5" },
    { act: ["$0", "a", "bet", "red 500"] },
    { act: ["$0", "a", "bet", "black 300"] },
    { act: ["$0", "a", "undo"] },
    { act: ["$0", "b", "bet", "odd 100"] },
    { act: ["$0", "b", "bet", "even 200"] },
    { act: ["$0", "b", "clear"] },
    { act: ["$0", "c", "bet", "d1 100"] },
  ]);
  const id = prev.opened[0];
  assert.equal((await refunds()).length, 3, "that build refunded a's undone line and b's two cleared ones");
  const flagged = store.flags.length;
  let T = await restart(id);
  assert.deepEqual(store.flags.slice(flagged), [], "no audit finding (and so no ops alert)");
  assert.equal((await refunds()).length, 3, "nothing refunded again");
  assert.deepEqual(
    (await lines(id)).map((l) => [l.user_id, l.amount, l.state, l.why]),
    [
      ["a", 500, "live", null],
      ["a", 300, "refunded", "migrated"],
      ["b", 100, "refunded", "migrated"],
      ["b", 200, "refunded", "migrated"],
      ["c", 100, "live", null],
    ],
  );
  assert.deepEqual(T.escrowed, { a: 500, c: 100 });
  assert.equal(await held(), 600);
  assert.equal(await total(), start);
  T = await restart(id);
  assert.deepEqual(store.flags.slice(flagged), []);
  assert.equal((await lines(id)).length, 5);
});

test("boot audit with roulette off and no wheel open: rows the previous build refunded are closed, and the supply never counts them", async () => {
  const T = await room("pad-off"),
    L = lobby();
  const start = await total();
  expect(await act(T, "a", "bet", "red 500"));
  expect(await act(T, "b", "bet", "odd 300"));
  expect(await act(L, "c", "bet", "17 200"));
  await svc.setSetting("casino_roulette", "off");
  // the CI rolls back with roulette off: that build refunds the mirror and closes both wheels
  const prev = prevBuild([{ tick: 1000 }]);
  assert.deepEqual(prev.tables.filter((t) => t.status === "open"), []);
  for (const uid of ["a", "b", "c"]) assert.equal(prev.cash[uid], 500000);
  assert.equal(prev.heldJson, 0);
  assert.deepEqual((await rows("SELECT state FROM casino_rl_lines")).map((r) => r.state), ["live", "live", "live"]);
  assert.equal(await held(), 0, "a live row whose refund exists holds nothing, before any audit");
  assert.equal(await total(), start);
  // the next deploy boots with roulette still off and no wheel open: the audit runs all the same
  const flagged = store.flags.length;
  await svc.boot({ tick: false });
  assert.deepEqual([...svc.S.tables.values()].filter((t) => t.status === "open"), []);
  assert.deepEqual(store.flags.slice(flagged).map((f) => f.kind), Array(3).fill("live_with_refund"));
  assert.deepEqual((await rows("SELECT state FROM casino_rl_lines")).map((r) => r.state), ["refunded", "refunded", "refunded"]);
  assert.equal((await refunds()).length, 3, "nothing refunded twice");
  assert.equal(await held(), 0);
  assert.equal(await total(), start);
});

test("a queued line while the wheel spins is its queue row, not a header write; a restart keeps it (and a clearing); the landing's header takes it over", async () => {
  let T = await room("pad-q");
  const start = await total();
  expect(await act(T, "a", "bet", "red 500"));
  await tick(betMs());
  assert.equal(T.eng.phase, "spinning");
  const header = async () => ({ ...(await rows("SELECT rev, updated, length(state) AS n FROM casino_tables WHERE id=?", [T.id]))[0] });
  const drawn = await header();
  assert.match(expect(await act(T, "b", "bet", "17 300")).reply, /Queued for the next spin/);
  expect(await act(T, "c", "bet", "odd 200"));
  expect(await act(T, "c", "clear"));
  expect(await act(T, "d", "bet", "red 100"));
  assert.match(expect(await act(T, "d", "bet", "black 100")).reply, /Replaced your queued line/);
  assert.deepEqual(await header(), drawn, "the drawn header (the mirror's full book) is not rewritten for a queued line");
  const q = await rows("SELECT user_id, bets, length(bets) + length(profile) AS n FROM casino_rl_queue WHERE table_id=? ORDER BY user_id", [T.id]);
  assert.deepEqual(q.map((r) => [r.user_id, r.bets]), [["b", '[["17",300]]'], ["c", null], ["d", '[["black",100]]']]);
  assert.ok(q.every((r) => r.n == null || r.n < 400), "a queued action writes a few hundred bytes");
  T = await restart(T.id);
  assert.equal(T.eng.phase, "spinning");
  assert.deepEqual(Object.keys(T.eng.pending).sort(), ["b", "d"]);
  assert.equal(T.players.b.name, "Playerb", "a player the drawn header never saw gets their profile back");
  assert.equal((await svc.RL.meView(T, "d")).pending, "black 100");
  await tick(spinMs());
  assert.equal(T.eng.phase, "result");
  assert.deepEqual(await rows("SELECT * FROM casino_rl_queue WHERE table_id=?", [T.id]), [], "the landing's header carries them");
  assert.deepEqual(Object.keys((await stateOf(T.id)).eng.pending).sort(), ["b", "d"]);
  T = await restart(T.id);
  assert.deepEqual(Object.keys(T.eng.pending).sort(), ["b", "d"]);
  await tick(resultMs());
  assert.equal(T.eng.round_no, 2);
  assert.deepEqual(
    (await lines(T.id)).filter((l) => l.round_no === 2).map((l) => [l.user_id, l.amount, l.state]),
    [["b", 300, "live"], ["d", 100, "live"]],
  );
  assert.equal(await cash("b"), 499700);
  assert.equal(await cash("c"), 500000);
  assert.equal(await total(), start);
});

test("rollback mid-spin with queued lines: the previous build lands the spin and loses only the queued lines (never charged); rolling forward never brings them back", async () => {
  let T = await room("pad-q2");
  const start = await total();
  expect(await act(T, "a", "bet", "red 500"));
  await tick(betMs());
  expect(await act(T, "b", "bet", "17 300"));
  const prev = prevBuild([{ tick: spinMs() }, { tick: resultMs() }]);
  assert.equal(prev.tables.find((t) => t.id === T.id).round_no, 2);
  assert.equal(prev.cash.b, 500000, "the queued line was never charged");
  T = await restart(T.id);
  assert.deepEqual(T.eng.pending, {});
  expect(await act(T, "c", "bet", "odd 100"));
  await tick(betMs());
  assert.equal(T.eng.phase, "spinning");
  T = await restart(T.id);
  assert.deepEqual(T.eng.pending, {}, "an earlier spin's queue rows never come back");
  await tick(spinMs());
  assert.deepEqual(await rows("SELECT * FROM casino_rl_queue WHERE table_id=?", [T.id]), []);
  assert.equal(await cash("b"), 500000);
  assert.equal(await total(), start);
});

test("the first line's 'Bets are open' goes out after its commit: a bet rolled back at its answer leaves no event a poll can read", async () => {
  const T = await room("pad-ev");
  const cursor = svc.S.lastSeq;
  svc.S.hooks.crash = "rl:answer";
  const waiting = svc.poll(cursor, 300);
  assert.equal((await act(T, "a", "bet", "red 500")).ok, false);
  const got = await waiting;
  assert.deepEqual(got.events, [], "the poll read no event of the rolled-back bet");
  assert.equal(got.cursor, cursor);
  assert.equal(svc.S.lastSeq, cursor, "and the cursor never moved past it");
  svc.S.hooks.crash = null;
  expect(await act(T, "a", "bet", "red 500"));
  const next = await svc.poll(cursor, 0);
  assert.deepEqual(next.events.map((e) => [e.kind, e.data.text]), [["line", "🛞 Bets are open."]]);
  assert.ok(next.events[0].seq > cursor);
  await tick(betMs());
  assert.ok((await stateOf(T.id)).log.some((l) => /Bets are open/.test(l.text)), "its log line rides the next save");
});

test("a landing rolled back after its result line: the poll cursor goes back to the last committed event, and the retry's line reaches the poll", async () => {
  const T = await room("pad-ev2");
  expect(await act(T, "a", "bet", "red 500"));
  await tick(betMs());
  const cursor = svc.S.lastSeq; // ("No more bets")
  svc.S.hooks.crash = "rl:result";
  await tick(spinMs());
  assert.equal(T.eng.phase, "spinning", "the landing rolled back whole");
  assert.equal(svc.S.lastSeq, cursor, "the rolled-back result line is not the cursor");
  const stale = await svc.poll(cursor + 1, 0); // (a poll that read the uncommitted line)
  assert.equal(stale.cursor, cursor, "is answered from the last committed event");
  svc.S.hooks.crash = null;
  await tick(0);
  assert.equal(T.eng.phase, "result");
  const next = await svc.poll(stale.cursor, 0);
  assert.deepEqual(next.events.map((e) => e.kind), ["result"]);
});

test("the row reads of a boot and a restore are index seeks: a wheel's MAX(opno), the book's keys", async () => {
  await store.ensure();
  const plan = async (q, p) => (await rows("EXPLAIN QUERY PLAN " + q, p)).map((r) => r.detail).join(" | ");
  assert.match(await plan("SELECT MAX(opno) AS n FROM casino_rl_lines WHERE table_id = ?", ["x"]), /USING (COVERING )?INDEX casino_rl_lines_opno \(table_id=\?\)/);
  assert.match(await plan("SELECT key FROM casino_rl_lines WHERE key IN (?, ?)", ["a", "b"]), /USING (COVERING )?INDEX sqlite_autoindex_casino_rl_lines_1 \(key=\?\)/);
});

// 1.99aoj (review): the rollback proof runs the build a rollback runs. The previous build is the deployed base WHOLE - every module this
// release changed as that build has it (test/fixtures/casino-prev/, git blobs in its manifest), not just its roulette.js inside this
// build's service.js - and every other module it loads is the same file in both builds (checked where git has the base: a shallow CI
// clone checks the copies against the manifest only).
test("rollback proof: the previous build is the deployed base - its vendored modules byte for byte, every other module it loads unchanged since", async () => {
  const fs = require("node:fs"),
    crypto = require("node:crypto");
  const dir = path.join(__dirname, "fixtures", "casino-prev"),
    man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const blob = (buf) => crypto.createHash("sha1").update(Buffer.concat([Buffer.from("blob " + buf.length + "\0"), buf])).digest("hex");
  const lf = (buf) => Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  assert.match(man.base, /^[0-9a-f]{40}$/);
  assert.equal(man.label, "1.99aoi", "the build prod runs before this release");
  for (const [f, sha] of Object.entries(man.files)) assert.equal(blob(lf(fs.readFileSync(path.join(dir, f + ".txt")))), sha, f + ": the base's blob, byte for byte");
  // a run of its own (an open, a bet, a spin) so the loaded set is there when this test runs alone
  prevBuild([{ open: "pad-prev" }, { act: ["$0", "b", "bet", "red 200"] }, { tick: svc.S.settings.rl_bet_secs * 1000 }, { tick: svc.S.settings.rl_spin_secs * 1000 }]);
  const loaded = [...prevLoaded];
  for (const f of ["casino/service.js", "casino/roulette.js", "casino/money.js", "ledger.js"]) assert.ok(loaded.includes(f), "the previous build ran " + f);
  for (const f of loaded) assert.ok(!f.startsWith("casino/rlstore"), "release A's row store is not in the previous build: " + f);
  for (const f of ["casino/service.js", "casino/roulette.js"]) assert.ok(man.files[f], f + " is the previous build's own");
  let git = null;
  try {
    git = (...a) => execFileSync("git", ["-C", h.repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    git("cat-file", "-e", man.base + "^{commit}");
  } catch (e) {
    git = null;
  }
  if (!git) return; // (no base commit in this clone: the manifest check above is the proof)
  for (const [f, sha] of Object.entries(man.files)) assert.equal(git("rev-parse", man.base + ":" + f), sha, f + ": the manifest's blob is the base's");
  for (const f of loaded.filter((x) => !man.files[x])) {
    const now = blob(lf(fs.readFileSync(path.join(h.repo, f)))),
      then = git("rev-parse", man.base + ":" + f);
    if (now === then) continue;
    // a data file (locales/en.json: this release only ADDS keys) may grow - the previous build reads every key it knows unchanged
    assert.ok(f.endsWith(".json"), f + " changed since the base - vendor its previous copy into test/fixtures/casino-prev/");
    const was = JSON.parse(execFileSync("git", ["-C", h.repo, "cat-file", "blob", then], { encoding: "utf8", maxBuffer: 1 << 28 })),
      is = JSON.parse(fs.readFileSync(path.join(h.repo, f), "utf8"));
    for (const k of Object.keys(was)) assert.deepEqual(is[k], was[k], f + ": " + k + " reads as the previous build shipped it");
  }
});
