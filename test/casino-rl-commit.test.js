"use strict";
// 1.99aof review fixes (ENGINE-1, MONEY-2, FAIR-2, SECURITY-1, SUITES-10): a spin's pocket is readable only after its draw
// has committed, and a wheel stops taking bets (committed) before it reveals an unused seed. Readers are modelled as they
// run on the site: outside the casino lock - a poller sampling the public view between I/O callbacks (GET /api/casino/t/:id,
// the OBS board) and a waiter woken by save() (Pepe's long-poll). A failing write inside the draw / close transaction is
// forced with a trigger (a full disk, an I/O error or a crash before COMMIT look the same from here).
const test = require("node:test"),
  assert = require("node:assert/strict");
const h = require("./fixtures/casino-rl-harness");
const { svc, sql, rows, act, total, room, expect, tick, restart } = h;
test.before(h.initialize);
test.beforeEach(h.fresh);
test.after(() => svc.stop());

function readers(T) {
  const seen = [];
  let on = true;
  const look = () => {
    const v = svc.publicView(T);
    seen.push({ phase: v.phase, spin: v.spin ? v.spin.number : null });
  };
  (function loop() {
    if (!on) return;
    look();
    setImmediate(loop);
  })();
  const w = () => {
    if (!on) return;
    look();
    svc.S.waiters.add(w);
  };
  svc.S.waiters.add(w);
  return {
    seen,
    stop() {
      on = false;
      svc.S.waiters.delete(w);
    },
  };
}
const failDraw = () =>
  sql("CREATE TRIGGER rl_commit_fail BEFORE UPDATE OF dealt ON casino_rounds BEGIN SELECT RAISE(ABORT,'disk full'); END");
const heal = () => sql("DROP TRIGGER IF EXISTS rl_commit_fail");
const paid = async (T, n, uid) =>
  (await rows("SELECT COALESCE(SUM(points),0) AS n FROM transactions WHERE transactionId=?", [`crl:${T.id}:s${n}:${uid}:pay`]))[0].n;

test("a failed `go` draw shows no pocket and leaves the wheel betting as it was", async () => {
  const T = await room();
  const start = await total();
  expect(await act(T, "b", "bet", "red 100"));
  const deadline = T.dl.bet;
  await failDraw();
  const R = readers(T);
  const out = await act(T, "b", "go");
  R.stop();
  await heal();
  assert.equal(out.ok, false);
  assert.ok(R.seen.length > 2, "the readers sampled the draw");
  assert.deepEqual(R.seen.filter((v) => v.spin !== null || v.phase === "spinning"), [], "a reader saw the drawn pocket");
  assert.equal(T.eng.phase, "betting");
  assert.equal(T.dl.bet, deadline);
  assert.equal(T.round.pocket, undefined);
  // the next draw commits: then (and only then) the pocket shows
  expect(await act(T, "b", "go"));
  assert.equal(svc.publicView(T).spin.number, T.round.pocket);
  await tick(8000);
  assert.equal(T.eng.phase, "result");
  assert.equal(await total(), start);
});

test("a deadline draw that never commits, then a restart: nobody saw the pocket", async () => {
  let T = await room();
  const start = await total(),
    n = T.round.no;
  expect(await act(T, "b", "bet", "red 100"));
  await failDraw();
  const R = readers(T);
  await tick(25000);
  await tick(250);
  R.stop();
  await heal();
  assert.deepEqual(R.seen.filter((v) => v.spin !== null), []);
  const saved = JSON.parse((await rows("SELECT state FROM casino_tables WHERE id=?", [T.id]))[0].state);
  assert.equal(saved.eng.phase, "betting");
  assert.equal(saved.round.pocket, undefined);
  T = await restart(T.id);
  assert.equal(T.eng.phase, "betting");
  await tick(25000);
  assert.equal(T.eng.phase, "spinning");
  await tick(8000);
  assert.equal(T.last_round.round_no, n);
  assert.ok((await paid(T, n, "b")) >= 0);
  assert.equal(await total(), start);
});

test("a failed close of an unused commitment leaves a closing wheel that refuses bets, then closes", async () => {
  const T = await room();
  const n = T.round.no;
  await sql(
    "CREATE TRIGGER rl_close_fail BEFORE UPDATE OF status ON casino_tables WHEN NEW.status='closed' BEGIN SELECT RAISE(ABORT,'disk full'); END",
  );
  const out = await act(T, "a", "end");
  await sql("DROP TRIGGER rl_close_fail");
  assert.equal(out.ok, false);
  assert.equal(T.status, "open");
  assert.equal(T.closing, true, "closing was committed before the reveal");
  const bet = await act(T, "c", "bet", "red 100");
  assert.equal(bet.ok, false);
  assert.match(bet.reply, /closes/);
  await tick(250);
  assert.equal(T.status, "closed");
  assert.equal((await svc.fairRecord(T.id, n)).verified, true);
  assert.equal(await paid(T, n, "c"), 0);
});

test("a host's end during the spin: a line typed afterwards is refused, not queued for a spin that never comes", async () => {
  const T = await room();
  expect(await act(T, "b", "bet", "red 100"));
  await tick(25000);
  assert.equal(T.eng.phase, "spinning");
  expect(await act(T, "a", "end"));
  const q = await act(T, "c", "bet", "black 500");
  assert.equal(q.ok, false);
  assert.match(q.reply, /closes after this spin/);
  await tick(8000);
  await tick(5000);
  assert.equal(T.status, "closed");
});
