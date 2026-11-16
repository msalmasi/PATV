"use strict";
// 1.99aof review fix FAIR-1: a staging refresh (deploy/refresh-staging-db.sh: VACUUM INTO, then deploy/keep-staging-tables.js on
// the copy) must never let staging play or publish the seed of a round prod's wheel is still taking bets on. Prod's lobby wheel
// has a line on its round; a room wheel sits idle on its committed round. The copy keeps neither seed (not even in its free
// pages); staging (its own process: test/fixtures/casino-rl-staging-boot.js) boots 11 minutes later, refunds the copied book,
// closes both copied wheels unrevealed, plays a fresh lobby wheel of its own and is switched off - and no prod seed is ever in
// what its public /api/casino/fair returns. PAT on staging is conserved.
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { execFileSync } = require("node:child_process");
const h = require("./fixtures/casino-rl-harness");
const { svc, sql, room, lobby, time, act, expect } = h;
const sqlite3 = require(require.resolve("sqlite3", { paths: [h.repo] }));
test.before(h.initialize);
test.beforeEach(h.fresh);
test.after(() => svc.stop());

async function refresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-staging-"));
  const old = path.join(dir, "myapp.db"),
    copy = path.join(dir, "myapp.db.new");
  await new Promise((res, rej) => {
    const d = new sqlite3.Database(old, (e) => (e ? rej(e) : d.exec("CREATE TABLE staging_marker (k TEXT)", (e2) => d.close(() => (e2 ? rej(e2) : res())))));
  });
  await sql(`VACUUM INTO '${copy.replace(/\\/g, "/")}'`);
  const out = execFileSync(process.execPath, [path.join(h.repo, "deploy", "keep-staging-tables.js"), old, copy], { encoding: "utf8" });
  fs.renameSync(old, old + ".previous");
  fs.renameSync(copy, old);
  return { dir, out, file: old };
}

test("FAIR-1: a staging refresh never lets staging play or publish a seed prod's wheels are still taking bets on", async () => {
  const L = lobby();
  expect(await act(L, "b", "bet", "red 300"));
  const R = await room("pad-a");
  const live = { [L.id]: L.round.seed, [R.id]: R.round.seed };
  const { dir, out, file } = await refresh();
  assert.match(out, /casino_tables scrubbed 2/);
  const bytes = fs.readFileSync(file).toString("latin1");
  for (const [id, seed] of Object.entries(live)) assert.ok(!bytes.includes(seed), "the copy still holds " + id + "'s seed");
  const raw = execFileSync(process.execPath, [path.join(__dirname, "fixtures", "casino-rl-staging-boot.js"), dir, Object.keys(live).join(","), String(time())], { encoding: "utf8" });
  const st = JSON.parse(raw.trim().split("\n").pop());
  assert.deepEqual(st.loaded, [], "staging closes the copied wheels at boot");
  assert.deepEqual(st.revealed.filter((r) => live[r.id] === r.seed), [], "staging published a seed prod's wheel is still on");
  assert.deepEqual(st.revealed, [], "a copied wheel's commitment is never revealed on staging");
  assert.equal(st.fresh.length, 1, "staging plays a lobby wheel of its own");
  assert.equal(st.after, st.before, "staging's PAT is conserved (the copied book is refunded there)");
  assert.equal(st.held, 0);
  // prod is untouched: both wheels are still open on the same committed rounds
  assert.equal(L.status, "open");
  assert.equal(R.status, "open");
  assert.equal(L.round.seed, live[L.id]);
  assert.equal(R.round.seed, live[R.id]);
});

const markCopied = (id) =>
  sql("UPDATE casino_tables SET state = json_set(json_remove(state, '$.round.seed', '$.next.seed'), '$.copied', 1) WHERE id = ?", [id]);
test("a copied wheel mid-spin or mid-settlement at boot: refunded or settled by key, closed, never revealed", async () => {
  const { cash, total, held, tick, restart, rows } = h;
  for (const at of ["spinning", "settling"]) {
    await h.fresh();
    let T = await room("pad-c");
    const start = await total();
    const p = h.fair.spinPocket(T.round.seed, T.client_seed, 1);
    expect(await act(T, "b", "bet", p + " 100"));
    await tick(25000);
    assert.equal(T.eng.phase, "spinning");
    if (at === "settling") {
      svc.S.hooks.crash = "rl:payouts";
      await tick(8000);
      assert.equal(T.round.settle, "pending");
    }
    svc.stop();
    await markCopied(T.id);
    T = await restart(T.id);
    assert.equal(T.status, "closed", at);
    assert.equal(T.eng.book.length, 0);
    assert.equal(await held(), 0);
    assert.equal(await total(), start, at + ": conserved");
    if (at === "spinning") assert.equal(await cash("b"), 500000, "the copied book was refunded");
    const rec = await svc.fairRecord(T.id, 1);
    assert.equal(rec.server_seed, null, at + ": no seed published");
    const ahead = await svc.fairRecord(T.id, 2);
    assert.ok(ahead && ahead.commitment, at + ": the next spin was committed at the draw (FAIR-3)");
    assert.equal(ahead.server_seed, null, at + ": and never revealed here");
    assert.equal((await rows("SELECT COUNT(*) AS n FROM transactions WHERE type='roulette payout'"))[0].n, at === "settling" ? 1 : 0);
  }
});

test("the scrub touches only open roulette wheels' seeds (card tables and closed wheels as they were)", async () => {
  const L = lobby();
  const R = await room("pad-b");
  expect(await act(R, "a", "end"));
  const { file } = await refresh();
  const d = new sqlite3.Database(file);
  const rowsOf = () => new Promise((res, rej) => d.all("SELECT id, status, state FROM casino_tables", (e, r) => (e ? rej(e) : res(r))));
  const got = Object.fromEntries((await rowsOf()).map((r) => [r.id, { status: r.status, s: JSON.parse(r.state) }]));
  await new Promise((res) => d.close(res));
  assert.equal(got[L.id].s.copied, 1);
  assert.equal(got[L.id].s.round.seed, undefined);
  assert.equal(got[L.id].s.round.commitment, L.round.commitment);
  assert.equal(got[R.id].status, "closed");
  assert.equal(got[R.id].s.copied, undefined);
  assert.equal(got[R.id].s.round.seed, R.round.seed, "a closed wheel's revealed seed stays");
});
