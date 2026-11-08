// h22 phase 2 review (1.99amj): the scheduled tournaments' play rules the first build got wrong - on the REAL casino service + escrow ledger
// (test/fixtures/mtt-harness.js):
//   * hand-for-hand: the bubble round's busts at DIFFERENT tables share the round's batch (ranked by their starting stacks, ties split) even
//     after the first bust bursts the bubble, and the round's bust lines wait until every table of the round has finished its hand
//   * a hand's wrap-up (handEnd) that fails is run again by the tick before that table deals again - the tournament still finishes
//   * a disqualification queued during a hand is re-checked at the boundary (never applied past the bubble); during a hand-for-hand round it
//     ranks below the round's busts; a disqualified entry earns no leaderboard points and can't re-enter
//   * breaking: a start table (opened_level null) isn't protected as "opened in the last 2 levels"
//   * reminders: off and on again re-arms the reminder; a reminder on a tournament that has started is refused
//   * the lobby row's "my table" and the table view's result for a busted / finished entrant
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-review");
const { svc, MT, H, getQuery, runQuery } = h;
const SEAT = require(path.join(h.repo, "casino", "mttseat"));
SEAT.newSeed = () => "f7".repeat(32);
const opsalerts = require(path.join(h.repo, "opsalerts"));
const alerts = [];
opsalerts.alert = async (a) => { alerts.push(a); return { ok: true }; };

test.before(async () => { await h.setup(60); });
test.after(() => svc.stop());
const P = () => h.players;
const live = (M) => svc.S.mtts.get(M.id) || M;
const refresh = () => svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);
const lines = async (M) => (await getQuery("SELECT data FROM casino_events WHERE table_id = ? AND kind = 'mtt' ORDER BY seq", [M.id])).map((r) => JSON.parse(r.data));
const roundOpen = (m, round) => MT.liveTables(m).some((T) => T.eng.hand_active && T.tourney.start && T.tourney.start.h4h_round === round);

/** 27 entries, 6-max, 25 % paid (6 places): to the first hand-for-hand round, released -> {M, round, batch} */
async function toBubbleRound(seed) {
  await h.fresh({ settings: { mtt_paid_pct: 25, mtt_room_lines_per_min: 30 }, deckSeed: seed });
  refresh();
  const M = await h.schedule({ max_entries: 40, min_entries: 4, table_size: 6, late_levels: 0, rooms: ["PepeLab"] });
  await h.reg(M, P().slice(0, 27));
  await h.toStart(M);
  await h.drive(M, { policy: h.policy(0.3, 0.75), each: refresh, until: (m) => m.status !== "running" || (m.h4h.on && m.h4h.started) });
  assert.equal(M.status, "running");
  assert.ok(M.h4h.on && M.h4h.started, "the bubble round is released");
  assert.equal(M.live_n, M.paid + 1);
  return { M, round: M.h4h.round, batch: M.h4h.batch };
}

test("hand-for-hand: the bubble round's busts at different tables share the round's batch even after the first one bursts the bubble; ranked by starting stack; the round's lines wait for the round", async () => {
  let crossed = 0;
  for (const seed of [2, 3, 5]) {
    const { M, round, batch } = await toBubbleRound(seed);
    const roundTables = new Set();
    let earlyLines = 0;
    const seenBefore = (await lines(M)).length;
    await h.drive(M, {
      policy: h.allIn(),
      each: async (m) => {
        refresh();
        for (const T of MT.liveTables(m)) if (T.tourney.start && T.tourney.start.h4h_round === round) roundTables.add(T.tourney.no);
        // while a hand of the round still runs somewhere, no bust line of the round is out yet
        if (roundOpen(m, round)) earlyLines += (await lines(M)).slice(seenBefore).filter((l) => l.bust).length;
      },
      until: (m) => m.status !== "running" || (roundTables.size > 0 && !roundOpen(m, round)),
    });
    const busts = await h.entries(M, "bust_seq >= ?", [batch]);
    assert.ok(busts.length >= 1, `seed ${seed}: the round busted someone`);
    for (const b of busts) assert.equal(b.bust_seq, batch, `seed ${seed}: ${b.user_id} (table ${b.bust_table_no}) has the round's batch`);
    if (new Set(busts.map((b) => b.bust_table_no)).size >= 2) crossed++;
    assert.equal(earlyLines, 0, `seed ${seed}: no bust line of the round before every table of the round finished`);
    // the lines that name them state the places they finally get
    await h.drive(M, { policy: h.allIn(), each: refresh });
    assert.equal(live(M).status, "done");
    const fin = await h.entries(M, "user_id IN (" + busts.map(() => "?").join(",") + ")", busts.map((b) => b.user_id));
    const byStack = fin.slice().sort((a, b) => b.bust_stack - a.bust_stack);
    for (let i = 1; i < byStack.length; i++) {
      if (byStack[i].bust_stack === byStack[i - 1].bust_stack) assert.equal(byStack[i].place === byStack[i - 1].place || Math.abs(byStack[i].place - byStack[i - 1].place) <= 1, true);
      else assert.ok(byStack[i].place > byStack[i - 1].place, `seed ${seed}: a bigger starting stack ranks higher (${byStack[i - 1].bust_stack} vs ${byStack[i].bust_stack})`);
    }
    const all = (await lines(M)).map((l) => l.text);
    for (const e of fin) {
      const nm = (live(M).people[e.user_id] || {}).name;
      const said = all.filter((t) => t.includes(nm) && /finish/.test(t));
      assert.ok(said.length >= 1, `seed ${seed}: a line names ${nm}`);
      for (const t of said) {
        const m = /(\d+)(?:st|nd|rd|th)(?:-(\d+)(?:st|nd|rd|th))?/.exec(t);
        const lo = Number(m[1]), hi = Number(m[2] || m[1]);
        assert.ok(e.place >= lo && e.place <= hi, `seed ${seed}: "${t}" vs place ${e.place}`);
      }
    }
    await h.holdsEnded(M);
  }
  assert.ok(crossed >= 2, `the seeds bust players at two tables in one round (${crossed})`);
});

test("a failed hand wrap-up (handEnd) is run again by the tick before that table deals again: heads-up, the last bust's wrap-up fails once and the tournament still finishes", async () => {
  // the final hand
  await h.fresh({ deckSeed: 9 });
  let M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 2));
  await h.toStart(M);
  const T = MT.liveTables(M)[0];
  const shove = h.allIn();
  svc.S.hooks.crashed = [];
  svc.S.hooks.crash = "mtt:handend:in-tx";            // ONE failed hand-end transaction (a transient database error), no restart
  for (let i = 0; i < 5000 && !(svc.S.hooks.crashed || []).length; i++) {
    if (T.eng.hand_active && T.turn) { const a = H.currentActor(T.eng); await h.A(h.byUid[a], shove(T, a), T.id); }
    else { h.NOW += 1000; await svc.tickOnce(); }
  }
  svc.S.hooks.crash = null;
  assert.ok((svc.S.hooks.crashed || []).length, "the hand-end transaction failed once");
  assert.ok(T.eng.seats.some((k) => !(T.eng.chips[k] > 0)), "that hand busted the loser (equal stacks, all in)");
  for (let i = 0; i < 120 && !["settled", "done"].includes(live(M).status); i++) { h.NOW += 1000; await svc.tickOnce(); }
  assert.ok(["settled", "done"].includes(live(M).status), `the tournament finished on its own (${live(M).status}, live ${live(M).live_n})`);
  const ent = await h.entries(M);
  assert.deepEqual(ent.map((e) => e.state).sort(), ["spent", "spent"]);
  assert.deepEqual(ent.map((e) => e.place).sort(), [1, 2]);
  await h.holdsEnded(M);
  // mid-tournament (12 at 6-max, everyone all in): the first table's bust hand fails its wrap-up once; its busted seats are placed
  // before that table deals again (a 0-chip seat is never dealt on, live_n is right)
  await h.fresh({ deckSeed: 4 });
  M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 12));
  await h.toStart(M);
  svc.S.hooks.crashed = [];
  svc.S.hooks.crash = "mtt:handend:in-tx";
  let FT = null;
  for (let i = 0; i < 5000 && !FT; i++) {
    let acted = false;
    for (const L of MT.liveTables(M)) {
      if (!L.eng.hand_active || !L.turn) continue;
      const a = H.currentActor(L.eng);
      await h.A(h.byUid[a], shove(L, a), L.id);
      acted = true;
      if ((svc.S.hooks.crashed || []).length) { svc.S.hooks.crash = null; FT = L; break; }
    }
    if (!acted) { h.NOW += 1000; await svc.tickOnce(); }
  }
  svc.S.hooks.crash = null;
  assert.ok(FT, "a hand-end transaction failed");
  const failedHand = FT.eng.hand_no;
  const zero = FT.eng.seats.filter((k) => !(FT.eng.chips[k] > 0));
  assert.ok(zero.length >= 1, "that hand busted someone");
  for (let i = 0; i < 60 && FT.tourney.bust_done !== failedHand && FT.eng.hand_no === failedHand; i++) { h.NOW += 1000; await svc.tickOnce(); }
  assert.equal(FT.tourney.bust_done, failedHand, "the failed hand was wrapped up");
  assert.equal(FT.eng.hand_no, failedHand, "before that table dealt again");
  for (const uid of zero) {
    const e = (await h.entries(M, "user_id = ?", [uid]))[0];
    assert.equal(e.state, "busted", `${uid}: placed`);
    assert.ok(!FT.eng.seats.includes(uid), `${uid}: no longer seated`);
  }
  assert.equal(live(M).live_n, 12 - (await h.entries(M, "state = 'busted'")).length, "live_n counts the busted");
  h.chipsOk(M);
  await h.drive(M, { policy: h.allIn() });
  assert.equal(live(M).status, "done");
  await h.holdsEnded(M);
});

test("a disqualification queued during a hand is re-checked at the boundary: never applied once the bubble has burst (dropped, logged, an ops alert)", async () => {
  let checked = 0;
  for (const seed of [3, 5, 7, 9, 11, 13]) {
    await h.fresh({ deckSeed: seed });
    alerts.length = 0;
    const M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 9, late_levels: 0 });
    await h.reg(M, P().slice(0, 7));
    await h.toStart(M);
    assert.equal(M.paid, 3, "7 entries: 50 / 30 / 20");
    const T = MT.liveTables(M)[0];
    await h.drive(M, { policy: h.policy(0.4, 0.8), until: (m) => m.status !== "running" || (m.live_n === m.paid + 1 && T.eng.hand_active && T.eng.players.length === 4) });
    if (M.status !== "running") continue;
    const D = T.eng.players.find((k) => !T.eng.folded.includes(k) && !T.eng.allin.includes(k));
    if (!D) continue;
    const n = (await h.entries(M)).findIndex((e) => e.user_id === D) + 1;
    const r = await svc.locked(() => MT.admin("dq", h.admin, M, { n, reason: "collusion" }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(M.dq[D] && !M.dq[D].applied, "queued until the hand ends");
    const hand = T.eng.hand_no;
    await h.drive(M, { policy: (TT, a) => (a === D ? (H.toCall(TT.eng, a) ? "fold" : "check") : h.allIn()(TT, a)), until: () => !T.eng.hand_active || T.eng.hand_no !== hand });
    if (M.live_n > M.paid) { await h.drive(M, { policy: h.allIn() }); continue; }       // nobody busted in that hand: not this case
    for (let i = 0; i < 15; i++) { h.NOW += 1000; await svc.tickOnce(); }                // the boundary
    const e = (await h.entries(M, "user_id = ?", [D]))[0];
    assert.equal(e.dq, 0, `seed ${seed}: past the bubble - not disqualified`);
    assert.ok(["playing", "busted", "spent"].includes(e.state));
    assert.ok(!M.dq[D] || !M.dq[D].applied, "never applied");
    assert.ok((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_log WHERE tid = ? AND kind = 'dq dropped'", [M.id]))[0].n === 1, "logged");
    assert.ok(alerts.some((a) => /disqualif/i.test(a.title) && /bubble/i.test(a.title + " " + a.body)), "the admins are told");
    await h.drive(M, { policy: h.allIn() });
    assert.equal(live(M).status, "done");
    checked++;
    break;
  }
  assert.ok(checked >= 1, "a seed reached a bust during the queued DQ's hand");
});

test("a DQ during a hand-for-hand round ranks below the round's busts (never paid); a disqualified entry earns no points and can't re-enter", async () => {
  let checked = 0;
  for (const seed of [2, 3, 5, 6, 7, 9, 10, 11]) {
    const { M, round, batch } = await toBubbleRound(seed);
    // one table folds its round hand at once (no bust), the others play slowly - then a player at the finished table is disqualified
    const tables = MT.liveTables(M).sort((a, b) => a.tourney.no - b.tourney.no);
    const A = tables[0];
    const slow = (T, a) => (H.toCall(T.eng, a) ? "call" : "check");
    const fold = (T, a) => (H.toCall(T.eng, a) ? "fold" : "check");
    await h.drive(M, { policy: (T, a) => (T === A ? fold(T, a) : slow(T, a)), each: refresh,
                       until: (m) => m.status !== "running" || (A.tourney.h4h_dealt === round && !A.eng.hand_active && A.tourney.bust_done === A.eng.hand_no && roundOpen(m, round)) });
    if (M.status !== "running" || !roundOpen(M, round) || M.live_n !== M.paid + 1) { await h.drive(M, { policy: h.allIn() }); continue; }
    const D = H.seatedWithChips(A.eng)[0];
    const n = (await h.entries(M)).findIndex((e) => e.user_id === D) + 1;
    const r = await svc.locked(() => MT.admin("dq", h.admin, M, { n, reason: "chip dumping" }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((await h.entries(M, "user_id = ?", [D]))[0].dq, 1, "applied at once (their table is between hands)");
    await h.drive(M, { policy: h.allIn(), each: refresh, until: (m) => m.status !== "running" || !roundOpen(m, round) });
    const roundBusts = (await h.entries(M, "bust_seq >= ? AND dq = 0", [batch]));
    if (!roundBusts.length) { await h.drive(M, { policy: h.allIn() }); continue; }
    await h.drive(M, { policy: h.allIn() });
    const d = (await h.entries(M, "user_id = ?", [D]))[0];
    for (const x of await h.entries(M, "user_id IN (" + roundBusts.map(() => "?").join(",") + ")", roundBusts.map((b) => b.user_id))) {
      assert.ok(d.place > x.place, `seed ${seed}: the disqualified entry (${d.place}) ranks below the round's bust ${x.user_id} (${x.place})`);
    }
    assert.equal(d.prize, 0, "never paid");
    assert.equal(d.points, 0, "no leaderboard points");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_points WHERE tid = ? AND user_id = ?", [M.id, D]))[0].n, 0, "no points row");
    checked++;
    break;
  }
  assert.ok(checked >= 1, "a seed had a bust at another table in the DQ's round");
  // re-entry: refused for a disqualified player while late registration is open
  await h.fresh();
  const M2 = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 6, late_levels: 8, reentry_max: 1 });
  await h.reg(M2, P().slice(30, 42));
  await h.toStart(M2);
  const n2 = 3, D2 = (await h.entries(M2))[n2 - 1].user_id;
  assert.ok((await svc.locked(() => MT.admin("dq", h.admin, M2, { n: n2, reason: "multi-accounting" }))).ok);
  await h.drive(M2, { policy: (T, a) => (H.toCall(T.eng, a) ? "fold" : "check"), until: (m) => (m.dq[D2] || {}).applied });
  assert.ok(M2.late_open);
  h.NOW += 2500;
  const rr = await h.M(h.byUid[D2], "join", [String(M2.no)]);
  assert.equal(rr.ok, false);
  assert.match(rr.reply, /disqualified/);
  assert.equal((await h.entries(M2, "user_id = ?", [D2])).length, 1, "no new entry");
});

test("breaking: start tables (opened_level null) aren't 'opened in the last 2 levels' - while late registration is open a 2 / 2 / 1 split breaks one", () => {
  const lay = [{ no: 1, state: "live", final: false, opened_level: null, seated: 2, inbound: 0 },
               { no: 2, state: "live", final: false, opened_level: null, seated: 2, inbound: 0 },
               { no: 3, state: "live", final: false, opened_level: null, seated: 1, inbound: 0 }];
  assert.ok(SEAT.shouldBreak(5, lay, 9, 3));
  assert.equal(SEAT.breaker(lay, { lateOpen: true, level: 0 }), 3, "the start table with the fewest players");
  assert.equal(SEAT.breaker(lay, { lateOpen: true, level: 1 }), 3);
  // a late-registration table opened at level 1 is still protected at levels 1-2
  const lay2 = lay.concat([{ no: 4, state: "live", final: false, opened_level: 1, seated: 1, inbound: 0 }]);
  assert.notEqual(SEAT.breaker(lay2, { lateOpen: true, level: 2 }), 4);
  assert.equal(SEAT.breaker(lay2, { lateOpen: true, level: 3 }), 4);
  assert.equal(SEAT.breaker(lay2, { lateOpen: false, level: 1 }), 4, "after late registration nothing is protected");
});

test("reminders: off and on again re-arms the reminder (an entrant's and a watcher's); a reminder on a tournament that has started or ended is refused", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2 }, { startIn: 60 });
  const [a, b] = P();
  await h.reg(M, [a], { remind: true });
  for (const [who, on] of [[a, "off"], [a, "on"], [b, "on"], [b, "off"], [b, "on"]]) {
    h.NOW += 2100;
    const r = await h.act(who, "remind", [String(M.no), on], { game: "mtt", room: null });
    assert.ok(r.ok, r.reply);
  }
  const rows = await getQuery("SELECT user_id, dropped, sent_at FROM casino_mtt_reminders WHERE tid = ? AND kind = 'starting'", [M.id]);
  for (const u of [a.uid, b.uid]) assert.ok(rows.some((x) => x.user_id === u && x.dropped === null && x.sent_at === null), `${u}: re-armed (${JSON.stringify(rows)})`);
  h.NOW = M.start_at - 15 * 60e3 + 1000;
  await svc.tickOnce();
  h.NOW += 31e3; await svc.tickOnce();
  for (const u of [a.uid, b.uid]) assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND ref LIKE ?", [u, `mtt:${M.id}:%:starting%`]))[0].n, 1, `${u}: the reminder came`);
  // started: refused (for a watcher and an entrant alike)
  await h.reg(M, [P()[2]]);
  await h.toStart(M);
  assert.equal(M.status, "running");
  h.NOW += 2100;
  let r = await h.act(P()[5], "remind", [String(M.no), "on"], { game: "mtt", room: null });
  assert.equal(r.ok, false, "a tournament under way has nothing to remind of");
  assert.match(r.reply, /started|under way/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_watch WHERE tid = ? AND user_id = ?", [M.id, P()[5].uid]))[0].n, 0, "no watch row");
  await h.drive(M, { policy: h.allIn() });
  h.NOW += 2100;
  r = await h.act(P()[5], "remind", [String(M.no), "on"], { game: "mtt", room: null });
  assert.equal(r.ok, false);
});

test("the lobby row carries the viewer's own table (\"Take me to my table\"); a busted / finished entrant's table view carries their result", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 8));
  await h.toStart(M);
  const T = MT.liveTables(M).find((x) => x.eng.seats.includes(P()[0].uid));
  const lob = await MT.lobby(P()[0].uid);
  const row = lob.running.find((x) => x.id === M.id);
  assert.equal(row.me, true);
  assert.equal(row.my_table, T.id, "the seated entrant's table");
  assert.equal((await MT.lobby(P()[20].uid)).running.find((x) => x.id === M.id).my_table, undefined, "nobody else's");
  // a bust: the table view says out (the place comes at the finish)
  let out = null;
  await h.drive(M, { policy: h.allIn(), until: (m) => { out = out || Object.keys(m.people).find((u) => !MT.whereIs(m, u)); return !!out || m.status !== "running"; } });
  assert.ok(out, "someone is out");
  const OT = MT.liveTables(M)[0];
  let mv = (await svc.meView(OT, out)).tourney;
  assert.equal(mv.registered, false);
  assert.ok(mv.result && mv.result.out === true, JSON.stringify(mv));
  await h.drive(M, { policy: h.allIn() });
  mv = (await svc.meView(OT, out)).tourney;
  const e = (await h.entries(M, "user_id = ?", [out]))[0];
  assert.equal(mv.result.place, e.place, "the place once it's over");
  assert.equal(mv.result.prize, e.prize + e.overlay + e.overlay_due);
  const w = (await h.entries(M, "place = 1"))[0];
  const wv = (await svc.meView(OT, w.user_id)).tourney;
  assert.equal(wv.result.place, 1, "the winner's result");
  assert.ok(!JSON.stringify(mv).includes(`"${out}"`), "no account id");
  void runQuery;
});

test("the blind planner at real MTT tables (27 entries, 6-max: moves, breaks, arrivals, the final): the big blind moves forward one seat, an arrival posts it first, heads-up never twice in a row, a dead small blind posts 0 and shows the level's; a player who just arrived is never moved before a hand there", async () => {
  const TNCFG = require(path.join(h.repo, "casino", "tourney"));
  let checked = 0, arrivals = 0, dead = 0, moves = 0;
  for (const seed of [11, 4]) {
    await h.fresh({ settings: { mtt_paid_pct: 25 }, deckSeed: seed });
    const M = await h.schedule({ max_entries: 40, min_entries: 4, table_size: 6, late_levels: 0 });
    await h.reg(M, P().slice(0, 27));
    await h.toStart(M);
    const prev = new Map();                // table id -> the last hand looked at {hand_no, order, bb_key, sb_key}
    const dealt = new Map();               // `${uid}@${table id}` -> hands dealt to them there
    const seenMove = new Set();
    const each = async (m) => {
      for (const T of MT.liveTables(m)) {
        const e = T.eng;
        if (!e.hand_active) continue;
        const p = prev.get(T.id);
        if (p && p.hand_no === e.hand_no) continue;
        // a new hand, seen right after its deal (deals only happen in ticks, and drive() looks after every tick, before anyone acts)
        const st = T.tourney.start || {};
        if (p) {
          const order = e.players, n = order.length;
          const came = order.filter((k) => !p.order.includes(k));
          if (came.length) { assert.ok(came.includes(e.bb_key), `seed ${seed} table ${T.tourney.no} hand ${e.hand_no}: an arrival posts the big blind first (${e.bb_key}; arrived ${came})`); arrivals++; }
          else {
            const bi = p.order.indexOf(p.bb_key);
            let nbb = null;
            for (let o = 1; o <= p.order.length && nbb === null; o++) { const k = p.order[(bi + o) % p.order.length]; if (order.includes(k)) nbb = k; }
            let want = nbb;
            if (n === 2 && want === p.bb_key) want = order.find((k) => k !== want);
            assert.equal(e.bb_key, want, `seed ${seed} table ${T.tourney.no} hand ${e.hand_no}: the big blind moves forward one seat`);
          }
          if (n === 2) assert.notEqual(e.bb_key, p.bb_key, "heads-up: never the big blind twice in a row");
          if (st.dead_sb) {
            dead++;
            assert.equal(e.contrib[e.sb_key] || 0, 0, "a dead small blind posts nothing");
            const lv = Array.from({ length: 60 }, (_, i) => TNCFG.levelAt({ levels: m.structure.levels }, i)).find((l) => l[1] === e.bb);
            assert.equal(e.sb, lv[0], "the level's small blind is shown");
            assert.equal(e.sb_key, p.sb_key, "dead: it would have been last hand's small blind again");
          }
          checked++;
        }
        prev.set(T.id, { hand_no: e.hand_no, order: e.players.slice(), bb_key: e.bb_key, sb_key: e.sb_key });
        for (const k of e.players) dealt.set(`${k}@${T.id}`, (dealt.get(`${k}@${T.id}`) || 0) + 1);
      }
      for (const [uid, x] of Object.entries(m.transit || {})) {
        if (x.why !== "balance" || seenMove.has(`${uid}:${x.since}`)) continue;
        seenMove.add(`${uid}:${x.since}`);
        const rec = m.tables.find((r) => r.no === x.from_no);
        assert.ok((dealt.get(`${uid}@${rec.id}`) || 0) >= 1, `seed ${seed}: ${uid} was dealt a hand at table ${x.from_no} before being moved`);
        moves++;
      }
    };
    await h.drive(M, { policy: h.policy(0.3, 0.75), each });
    assert.equal(live(M).status, "done");
  }
  console.log(`[blinds] hands ${checked}, arrivals ${arrivals}, moves ${moves}, dead small blinds ${dead}`);
  assert.ok(checked > 100, `hands checked: ${checked}`);
  assert.ok(arrivals >= 3, `arrivals checked: ${arrivals}`);
  assert.ok(moves >= 2, `balance moves checked: ${moves}`);
  assert.ok(dead >= 1, `dead small blinds seen: ${dead}`);
  // a player who just arrived (seated at a boundary that didn't deal) is never the one moved - the next big blind after them is
  await h.fresh({ deckSeed: 6 });
  const M = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 12));
  await h.toStart(M);
  const [T1, T2] = MT.liveTables(M).sort((a, b) => a.tourney.no - b.tourney.no);
  let marked = null, mover = null;
  const from1 = new Set(T1.eng.seats);
  const quiet = (T, a) => (H.toCall(T.eng, a) ? "fold" : "check");
  await h.drive(M, {
    policy: (T, a) => (T === T2 ? h.allIn()(T, a) : quiet(T, a)),
    each: async (m) => {
      if (mover) return;
      // (a move lands within the same tick - the target is kicked - so it is seen as a table 1 player now seated at table 2)
      const x = T2.eng.seats.find((u) => from1.has(u)) || Object.entries(m.transit || {}).filter(([, t]) => t.from_no === T1.tourney.no).map(([u]) => u)[0];
      if (x) { mover = x; return; }
      if (!T1.eng.hand_active && H.seatedWithChips(T2.eng).length <= 4) {
        marked = SEAT.bbOrder(H.seatedWithChips(T1.eng), T1.tourney.last)[0];
        T1.tourney.arrived[marked] = T1.eng.hand_no;              // as if seated at this boundary (no hand dealt to them here yet)
      }
    },
    until: (m) => !!mover || m.status !== "running",
  });
  assert.ok(mover && marked, "table 1 gave a player to the short table");
  assert.notEqual(mover, marked, "never the player who just arrived");
});
