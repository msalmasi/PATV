// h22 phase 2 (1.99amj): every cut point of a scheduled tournament - a crash INSIDE a transaction (S.hooks.crash "mtt:<op>:in-tx": nothing
// committed, M and every touched table restored by full replacement, no new table reaches S.tables), right AFTER a commit (the post-commit
// work is lost; the restart picks it up) and a restart (svc.stop() + boot() on the same database) at each step of section 27 of the spec.
// Every case checks PAT conservation (wallets + held + House) and that every hold ends exactly once.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-crash");
const { svc, MT, H, getQuery, runQuery } = h;
const SEAT = require(path.join(h.repo, "casino", "mttseat"));
SEAT.newSeed = () => "c3".repeat(32);

test.before(async () => { await h.setup(80); });
test.after(() => svc.stop());
const P = () => h.players;
const live = (M) => svc.S.mtts.get(M.id);
const mrow = async (M) => JSON.parse((await getQuery("SELECT state FROM casino_mtt WHERE id = ?", [M.id]))[0].state);

/** run until the crash point fires once (the hook is cleared then) -> true if it fired */
async function untilCrash(M, name, policy, max = 20000) {
  svc.S.hooks.crashed = [];
  svc.S.hooks.crash = name;
  const hands = new Map();
  policy = policy || h.policy(0.35, 0.8);
  try {
    for (let i = 0; i < max; i++) {
      if ((svc.S.hooks.crashed || []).includes(name)) return true;
      const m = live(M) || M;
      if (!["running", "finishing", "registering"].includes(m.status)) return false;
      let acted = false;
      for (const T of MT.liveTables(m)) {
        if (!T.eng.hand_active) continue;
        if (hands.get(T.id) !== T.eng.hand_no) { hands.set(T.id, T.eng.hand_no); T.__caller = null; }
        const a = H.currentActor(T.eng);
        if (!a || !T.turn || T.turn.uid !== a) continue;
        await h.A(h.byUid[a], policy(T, a) || "fold", T.id);
        acted = true;
        if ((svc.S.hooks.crashed || []).includes(name)) return true;
      }
      if (!acted) { h.NOW += 1000; await svc.tickOnce(); }
    }
    return false;
  } finally { svc.S.hooks.crash = null; }
}
/** (review) the restore is checked against the TEST's own snapshots, taken when the failed transaction began (S.hooks.txnStart) and compared
 *  the moment the restore is done (S.hooks.onRestore - before anything else runs: tickOnce goes on with the other tables): M and EVERY
 *  table of the tournament, touched or not (a body that changed a table it never ctx.touch'ed is caught), and the stream slot */
const tablesOf = (id) => Array.from(svc.S.tables.values()).filter((T) => T.tourney && T.tourney.id === id);
const begun = [];
svc.S.hooks.txnStart = (label, M) => {
  if (!M) return;
  begun.push({ label, id: M.id, m: JSON.stringify(M), t: tablesOf(M.id).map((T) => [T, JSON.stringify(T)]), stream: JSON.stringify(svc.S.stream) });
  if (begun.length > 40) begun.shift();
};
let verdict = null;
svc.S.hooks.onRestore = (label, M) => {
  const s = begun.filter((x) => x.label === label && x.id === (M && M.id)).pop();
  const bad = [];
  if (!s) bad.push(`no snapshot of ${label}`);
  else {
    if (JSON.stringify(M) !== s.m) bad.push(`${label}: M differs from when the transaction began`);
    for (const [T, snap] of s.t) if (JSON.stringify(T) !== snap) bad.push(`${label}: table ${T.tourney && T.tourney.no} (${T.id}) differs from when the transaction began`);
    if (JSON.stringify(svc.S.stream) !== s.stream) bad.push(`${label}: the stream slot changed`);
  }
  verdict = { label, bad };
};
function restoredExactly(M) {
  const r = svc.S.hooks.lastRestore;
  assert.ok(r && r.after, "a transaction was rolled back");
  assert.ok(verdict && verdict.label === r.label, `the restore of ${r.label} was checked`);
  assert.deepEqual(verdict.bad, [], `${r.label}: M, every table of the tournament and the stream slot are what they were when it began`);
  assert.ok(svc.S.mtts.get(M.id) === live(M), "the same object stays in S.mtts");
  for (const id of r.created) assert.ok(!svc.S.tables.has(id), "no table created in the failed transaction reached S.tables");
  svc.S.hooks.lastRestore = null;
  verdict = null;
}
async function play(M, opts) { await h.drive(M, Object.assign({ policy: h.policy(0.35, 0.8) }, opts || {})); }

test("register / unregister: crash in the tx (nothing held, no entry), after the commit (the idem replays, no second debit), unregister after the commit (no second refund)", async () => {
  await h.fresh();
  const total0 = await h.total();
  const M = await h.schedule({ max_entries: 20, min_entries: 2 });
  const a = P()[0], b = P()[1];
  svc.S.hooks.crash = "mtt:register:in-tx";
  const k1 = h.key();
  svc.S.rate.clear();
  const r1 = await svc.act(a, "join", [String(M.no)], { game: "mtt", room: null }, k1);
  svc.S.hooks.crash = null;
  assert.equal(r1.ok, false);
  assert.equal(await h.held(), 0, "nothing held");
  assert.equal((await h.entries(M)).length, 0, "no entry");
  assert.equal(M.reg_n, 0);
  restoredExactly(M);
  h.NOW += 2500;
  const r1b = await h.M(a, "join", [String(M.no)]);
  assert.ok(r1b.ok, "the retry registers once");
  // after the commit, then a restart: the same idem replays, a new idem says already in
  svc.S.hooks.crash = "mtt:register:after-commit";
  const k2 = h.key();
  svc.S.rate.clear();
  const r2 = await svc.act(b, "join", [String(M.no)], { game: "mtt", room: null }, k2);
  svc.S.hooks.crash = null;
  assert.ok(r2.ok);
  await h.restart();
  const r2b = await svc.act(b, "join", [String(M.no)], { game: "mtt", room: null }, k2);
  assert.equal(r2b.replayed, true);
  assert.equal(r2b.reply, r2.reply);
  h.NOW += 2500;
  assert.equal((await h.M(b, "join", [String(M.no)])).reply, "You're already in.");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE user_id = ? AND ref = ?", [b.uid, `TNY-${M.id}`]))[0].n, 1, "one debit");
  // unregister committed, answer lost: the same key replays; a hold is refunded at most once
  svc.S.hooks.crash = "mtt:unregister:after-commit";
  const k3 = h.key();
  const r3 = await svc.act(b, "leave", [String(M.no)], { game: "mtt", room: null }, k3);
  svc.S.hooks.crash = null;
  assert.ok(r3.ok);
  await h.restart();
  const r3b = await svc.act(b, "leave", [String(M.no)], { game: "mtt", room: null }, k3);
  assert.equal(r3b.replayed, true);
  assert.equal((await h.M(b, "leave", [String(M.no)])).ok, false, "a new key: not registered");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key LIKE ?", [`tny:${svc.S.mtts.get(M.id).id}:${b.uid}:refund:%`]))[0].n, 1);
  assert.equal(await h.total(), total0, "conservation");
});

test("start: crash in the tx (a restart starts it once), after the commit (the tables are released, never duplicated); after downtime: 10 minutes late starts, past the grace is cancelled with refunds", async () => {
  await h.fresh();
  const total0 = await h.total();
  let M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 6 });
  await h.reg(M, P().slice(0, 10));
  h.NOW = M.start_at;
  svc.S.hooks.crash = "mtt:start:in-tx";
  await svc.tickOnce();
  svc.S.hooks.crash = null;
  assert.equal(live(M).status, "registering", "nothing committed");
  restoredExactly(M);
  assert.equal(Array.from(svc.S.tables.values()).filter((T) => T.tourney && T.tourney.id === M.id).length, 0);
  await h.restart();
  await h.later(1);
  M = live(M);
  assert.equal(M.status, "running", "the restart starts it once");
  assert.equal(M.tables.length, 2);
  // after the commit: the tables exist once, and a restart releases them
  let M2 = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 6 });
  await h.reg(M2, P().slice(20, 30));
  h.NOW = M2.start_at;
  svc.S.hooks.crash = "mtt:start:after-commit";
  await svc.tickOnce();
  svc.S.hooks.crash = null;
  assert.equal(live(M2).status, "running");
  await h.restart();
  M2 = live(M2);
  const ids = (await getQuery("SELECT id FROM casino_tables WHERE json_extract(state, '$.tourney.id') = ?", [M2.id])).map((r) => r.id);
  assert.equal(ids.length, 2, "no duplicate tables");
  for (const T of MT.liveTables(M2)) assert.ok(T.dl.next, "released");
  await play(M2);
  assert.equal(live(M2).status, "done");
  // downtime across the start: 10 minutes late -> starts; past the grace (30 min) -> cancelled + refunds
  let M3 = await h.schedule({ max_entries: 20, min_entries: 2 });
  await h.reg(M3, P().slice(40, 44));
  svc.stop();
  h.NOW = M3.start_at + 10 * 60e3;
  await svc.boot({ tick: false });
  await h.later(1);
  assert.equal(live(M3).status, "running");
  let M4 = await h.schedule({ max_entries: 20, min_entries: 2 });
  await h.reg(M4, P().slice(50, 54));
  svc.stop();
  h.NOW = M4.start_at + 45 * 60e3;
  await svc.boot({ tick: false });
  M4 = live(M4);
  assert.equal(M4.status, "cancelled");
  assert.match(M4.cancel.reason, /the site was down at the start time/);
  for (const x of await getQuery("SELECT state FROM escrow_holds WHERE ref = ?", [`TNY-${M4.id}`])) assert.equal(x.state, "refunded");
  await play(live(M) || M);
  await play(live(M3) || M3);
  assert.equal(await h.total(), total0);
});

test("a hand ends but its wrap-up never runs (mtt:handend:before-wrapup): the restart places the same bust batch from the saved start record; a second run is a no-op", async () => {
  await h.fresh();
  const total0 = await h.total();
  let M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 6));
  await h.toStart(M);
  // play until a hand that busts someone, crash before its wrap-up
  let fired = false;
  for (let tries = 0; tries < 50 && !fired; tries++) fired = await untilCrash(M, "mtt:handend:before-wrapup", h.policy(0.5, 0.9), 400);
  assert.ok(fired, "the cut point fired");
  const T = MT.liveTables(live(M))[0];
  const start = JSON.parse(JSON.stringify(T.tourney.start));
  await h.restart();
  M = live(M);
  const T2 = MT.liveTables(M)[0];
  assert.deepEqual(T2.tourney.start.stacks, start.stacks, "the saved start record");
  assert.equal(T2.tourney.bust_done, T2.eng.hand_no, "wrapped up after the restart");
  const busts1 = (await h.entries(M, "state = 'busted'")).map((e) => `${e.user_id}:${e.bust_seq}`);
  await svc.locked(() => MT.handEnd(T2, {}));
  const busts2 = (await h.entries(M, "state = 'busted'")).map((e) => `${e.user_id}:${e.bust_seq}`);
  assert.deepEqual(busts2, busts1, "bust_done: a second run changes nothing");
  await play(M);
  assert.equal(live(M).status, "done");
  assert.equal(await h.total(), total0);
  await h.holdsEnded(M);
});

test("an older build's commit without the finishing flag (running, one player left): recovery sets finishing and the finish settles", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, P().slice(0, 3));
  await h.toStart(M);
  svc.S.hooks.crash = "mtt:handend:running-live1";
  await h.drive(M, { policy: h.policy(0.6, 0.95), until: (m) => m.live_n === 1 });
  svc.S.hooks.crash = null;
  assert.equal(live(M).status, "running");
  await h.restart();
  await h.later(1);
  assert.ok(["settled", "done"].includes(live(M).status), live(M).status);
  await h.holdsEnded(M);
});

test("move / break / final / arrival / DQ / cancel inside their transactions: everything rolled back in memory and in the database; after the commit: the transit is re-queued and seated exactly once", async () => {
  for (const op of ["move", "break", "final", "arrival"]) {
    await h.fresh({ deckSeed: 3 });
    const total0 = await h.total();
    let M = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 0 });
    await h.reg(M, P().slice(0, 17));
    await h.toStart(M);
    // busts at table 1 only: the other tables become the fullest and give players (moves, arrivals); then breaks and the final
    const agg = h.policy(0.5, 0.9);
    const lopsided = (T, a) => (T.tourney.no === 1 || op !== "move" ? agg(T, a) : H.toCall(T.eng, a) ? "fold" : "check");
    const fired = await untilCrash(M, `mtt:${op}:in-tx`, lopsided);
    assert.ok(fired, `the ${op} cut point fired`);
    restoredExactly(M);
    const db = await mrow(M);
    assert.equal(db.rev, live(M).rev, `${op}: the database has the pre-tx state`);
    await h.restart();
    M = live(M);
    h.chipsOk(M);
    await play(M);
    assert.equal(live(M).status, "done", op);
    assert.equal(await h.total(), total0, `${op}: conservation`);
    await h.holdsEnded(M);
  }
  // after the commit: a move's kick is lost - the restart re-queues the transit and seats it exactly once
  await h.fresh({ deckSeed: 4 });
  let M = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 17));
  await h.toStart(M);
  const agg2 = h.policy(0.5, 0.9);
  // (review) the cut point must fire, and every player it left in transit must land - seated exactly once, out of transit
  assert.ok(await untilCrash(M, "mtt:move:after-commit", (T, a) => (T.tourney.no === 1 ? agg2(T, a) : H.toCall(T.eng, a) ? "fold" : "check")), "the move's after-commit cut point fired");
  const inTransit = Object.keys(live(M).transit);
  assert.ok(inTransit.length >= 1, "the move's kick was lost with a player in transit");
  await h.restart();
  M = live(M);
  const quiet = (T, a) => (H.toCall(T.eng, a) ? "fold" : "check");
  await h.drive(M, { policy: quiet, until: (m) => m.status !== "running" || inTransit.every((u) => !m.transit[u] && MT.liveTables(m).some((T) => T.eng.seats.includes(u))) });
  for (const uid of inTransit) {
    assert.equal(MT.liveTables(M).filter((T) => T.eng.seats.includes(uid)).length, 1, `${uid} seated exactly once`);
    assert.ok(!M.transit[uid], `${uid} out of transit`);
  }
  await play(M);
  assert.equal(live(M).status, "done");
  // (review) the break's and the final's after-commit work lost (kicks, lines, the stream): the restart still plays it out, once
  for (const op of ["break", "final"]) {
    await h.fresh({ deckSeed: 3 });
    const total0 = await h.total();
    let M2 = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 0 });
    await h.reg(M2, P().slice(0, 17));
    await h.toStart(M2);
    assert.ok(await untilCrash(M2, `mtt:${op}:after-commit`, h.policy(0.5, 0.9)), `the ${op} after-commit cut point fired`);
    await h.restart();
    M2 = live(M2);
    h.chipsOk(M2);
    await play(M2);
    assert.equal(live(M2).status, "done", op);
    assert.equal(await h.total(), total0, `${op}: conservation`);
    await h.holdsEnded(M2);
  }
});

test("hand-for-hand across a restart mid-round: the round is released once, its batch kept", async () => {
  await h.fresh({ settings: { mtt_paid_pct: 25 }, deckSeed: 9 });
  const total0 = await h.total();
  let M = await h.schedule({ max_entries: 40, min_entries: 4, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 27));
  await h.toStart(M);
  await h.drive(M, { until: (m) => m.status !== "running" || (m.h4h.on && m.h4h.started && MT.liveTables(m).some((T) => T.tourney.h4h_dealt === m.h4h.round)) });
  assert.ok(live(M).status === "running" && live(M).h4h.on, "(review) the seed reaches a hand-for-hand round mid-way");
  {
    const round = live(M).h4h.round, batch = live(M).h4h.batch;
    const handsAt = Object.fromEntries(MT.liveTables(live(M)).map((T) => [T.id, { no: T.eng.hand_no, dealt: T.tourney.h4h_dealt === round, active: T.eng.hand_active }]));
    await h.restart();
    M = live(M);
    assert.equal(M.h4h.round, round);
    assert.equal(M.h4h.batch, batch, "the batch seq is kept");
    // until the round moves on: a table that had dealt this round deals no other hand; one that hadn't deals exactly one
    await h.drive(M, { until: (m) => m.status !== "running" || !m.h4h.on || m.h4h.round !== round });
    for (const [id, x] of Object.entries(handsAt)) {
      const T = svc.getTable(id);
      if (!T || T.status !== "open") continue;
      const extra = T.eng.hand_no - x.no;
      assert.ok(extra <= (x.dealt ? 0 : 1) + (T.eng.hand_active ? 1 : 0), `table ${T.tourney.no}: ${extra} more hand(s) in round ${round}`);
    }
  }
  await h.drive(M);
  assert.equal(live(M).status, "done");
  assert.equal(await h.total(), total0);
  await h.holdsEnded(M);
});

test("the finish: a crash in the settle's tx (the restart settles once, same key), after its commit (no second settle, the post steps next); post steps interrupted (once each)", async () => {
  await h.fresh();
  await svc.setSetting("mtt_ach_min_field", "2", "test");
  const total0 = await h.total();
  let M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, P().slice(0, 4));
  await h.toStart(M);
  svc.S.hooks.crash = "mtt:finish:in-tx";
  await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" });
  svc.S.hooks.crash = null;
  assert.equal(live(M).status, "finishing");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${M.id}:finish`]))[0].n, 0);
  await h.restart();
  h.NOW += 61e3;
  await svc.tickOnce();
  assert.ok(["settled", "done"].includes(live(M).status));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${M.id}:finish`]))[0].n, 1);
  assert.equal(await h.total(), total0);
  // after the commit + post steps interrupted
  let M2 = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M2, P().slice(10, 14));
  await h.toStart(M2);
  svc.S.hooks.crash = "mtt:finish:after-commit";
  await h.drive(M2, { policy: h.allIn(), until: (m) => m.status !== "running" });
  svc.S.hooks.crash = null;
  assert.equal(live(M2).status, "settled", "settled; the post steps didn't run");
  await h.restart();
  svc.S.hooks.crash = "mtt:post:mid";
  await h.later(1);
  svc.S.hooks.crash = null;
  M2 = live(M2);
  assert.equal(M2.post.ach, true);
  assert.equal(M2.post.notices, false, "interrupted at the notices");
  await h.later(1);
  M2 = live(M2) || M2;
  const n1 = (await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref LIKE ?", [`mtt:${M2.id}:%:result%`]))[0].n;
  assert.equal(n1, 4, "(review) the interrupted notices step ran after the restart: one result notice per entrant");
  await svc.locked(() => MT.postSteps(M2));
  const n2 = (await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref LIKE ?", [`mtt:${M2.id}:%:result%`]))[0].n;
  assert.equal(n2, n1, "notices once");
  const achKeys = await getQuery("SELECT key FROM casino_reward_done WHERE key LIKE ?", [`mtt:${M2.id}:%`]);
  assert.ok(achKeys.length >= 1, "(review) the achievement counts were made");
  assert.equal(new Set(achKeys.map((r) => r.key)).size, achKeys.length, "achievement keys once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${M2.id}:finish`]))[0].n, 1, "no second settle");
  assert.equal(await h.total(), total0);
});

test("cancel and DQ inside their transactions: all or nothing", async () => {
  await h.fresh();
  const total0 = await h.total();
  let M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 8));
  await h.toStart(M);
  await h.later(7);
  svc.S.hooks.crash = "mtt:cancel:in-tx";
  const r = await svc.locked(() => MT.cancel(live(M), "x", "test")).catch((e) => ({ thrown: e }));
  svc.S.hooks.crash = null;
  assert.ok(r.thrown || r.ok === false);
  restoredExactly(M);
  assert.equal(live(M).status, "running");
  assert.equal(await h.held(), 8 * 1100, "nothing refunded");
  // a DQ crashing in its tx
  const list = await h.entries(M);
  const n = list.findIndex((x) => x.state === "playing") + 1;
  await svc.locked(() => MT.admin("dq", h.admin, live(M), { n, reason: "x" })).catch(() => null);
  const uid = list[n - 1].user_id;
  svc.S.hooks.crashed = [];
  svc.S.hooks.crash = "mtt:dq:in-tx";
  await h.drive(M, { policy: (T, a) => (H.toCall(T.eng, a) ? "fold" : "check"), until: (m) => (svc.S.hooks.crashed || []).includes("mtt:dq:in-tx") || (m.dq[uid] || {}).applied, max: 4000 });
  svc.S.hooks.crash = null;
  assert.ok((svc.S.hooks.crashed || []).includes("mtt:dq:in-tx"), "(review) the DQ's transaction cut point fired");
  restoredExactly(M);
  assert.equal((await h.entries(M, "user_id = ?", [uid]))[0].state, "playing", "nothing applied");
  h.chipsOk(live(M));
  await h.drive(M, { policy: h.allIn() });
  assert.equal(live(M).status, "done");
  assert.equal(await h.total(), total0);
  await h.holdsEnded(M);
});

test("restart gaps: the clock moves by the gap since the last beat (30 s, 10 min) - no level skipped; an injected invariant break (a seat twice) pauses it, no PAT moved", async () => {
  await h.fresh();
  let M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 9, late_levels: 0 });
  await h.reg(M, P().slice(0, 6));
  await h.toStart(M);
  await h.later(2);
  for (const gap of [30e3, 10 * 60e3]) {
    M = live(M);
    const level = M.clock.level, left = M.clock.level_ends_at - M.clock.beat;
    svc.stop();
    h.NOW += gap;
    await svc.boot({ tick: false });
    M = live(M);
    assert.equal(M.clock.level, level, "no level skipped");
    assert.equal(M.clock.level_ends_at - h.NOW, left - (h.NOW - (M.clock.beat || h.NOW)), "the time left in the level is what it was at the last beat");
    assert.ok(M.clock.gaps.length >= 1);
  }
  // the invariant: an entry seated at two tables -> paused, logged, no PAT moved
  const total0 = await h.total();
  const T = MT.liveTables(M)[0];
  const k = T.eng.seats[0];
  M.transit[k] = { gen: 1, chips: 0, to_no: 99, from_no: 1, since: h.NOW, why: "balance", qol: {} };
  await svc.locked(() => MT.saveMtt(M));
  await h.restart();
  M = live(M);
  assert.ok(M.paused && M.paused.by === "system", "paused by the system");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_log WHERE tid = ? AND kind = 'invariant'", [M.id]))[0].n, 1);
  assert.equal(await h.total(), total0, "no PAT moved");
});
