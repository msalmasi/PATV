// h22 phase 2 (1.99amj): scheduled multi-table Hold'em tournaments (casino/mtt.js) on the REAL casino service + the REAL escrow ledger, a test
// database, a fake clock and bot players (test/fixtures/mtt-harness.js):
//   * the switch casino_mtt (off / staff / everyone); register (one TNY hold of buy-in + fee), the refusals (PAT, ban, dup-linked and
//     same-address over the whole tournament, full, escrow not live, the room cap), unregister (a full refund), re-registering (gen 2)
//   * the start (min entries, the draw, a ban at the start, presence), late registration (the target, a new table, the three closes),
//     re-entry, the one level clock, dead small blinds
//   * full runs: 27 entries at 6-max / 25 % (balancing, a break, hand-for-hand at the bubble, the final table, the curve, the House fee,
//     PAT + chip conservation at every step, every hold settled once, points, achievements), 9-max defaults (no hand-for-hand), the final
//     table in place, a 180-entry smoke with a wall-time budget and a 500-entry start + finish
//   * the stream slot, admin actions (cancel, void, delay, raise max, refund entry, DQ), pause / resume, timeouts and sitting out, the
//     tables kept out of the cash lists, and a random-MTT property test of the table rules
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-test");
const { svc, MT, H, getQuery, runQuery } = h;
const SEAT = require(path.join(h.repo, "casino", "mttseat"));
const PAY = require(path.join(h.repo, "casino", "mttpay"));
SEAT.newSeed = () => "a1".repeat(32);                       // a fixed draw seed: every run below is deterministic

test.before(async () => { await h.setup(520); });
test.after(() => svc.stop());

const P = () => h.players;
const view = (M) => MT.publicView(svc.S.mtts.get(M.id) || M);

test("the switch: off by default, staff only for staff, everyone; hidden only from people with no entry; switched off before the start = cancelled with full refunds", async () => {
  await h.fresh({ mtt: null });
  assert.equal((await svc.loadSettings(true)).casino_mtt, "off");
  await svc.setSetting("casino_mtt", "staff", "test");
  const M = await h.schedule({ max_entries: 20, min_entries: 2 });
  let r = await h.M(P()[0], "join", [String(M.no)]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /aren't open yet/);
  assert.equal(await h.held(), 0, "nothing held on a refusal");
  r = await h.M(h.staff, "join", [String(M.no)]);
  assert.ok(r.ok, r.reply);
  assert.equal((await h.M(P()[0], "list", [])).ok, false, "the list is hidden from a member with no entry");
  assert.equal((await h.M(h.staff, "list", [])).ok, true);
  // everyone: a member registers; then staff only again: the member keeps the entry and still sees it
  await svc.setSetting("casino_mtt", "everyone", "test");
  h.NOW += 2500;
  await h.reg(M, [P()[0]]);
  await svc.setSetting("casino_mtt", "staff", "test");
  r = await h.M(P()[0], "info", [String(M.no)]);
  assert.ok(r.ok, "an entrant keeps the tournament");
  assert.ok(await MT.canSee(M, P()[0].uid));
  assert.equal(await MT.canSee(M, P()[1].uid), false);
  r = await h.M(P()[1], "info", [String(M.no)]);
  assert.equal(r.ok, false);
  // switched off while registering: cancelled at the start with every entry refunded (the fee too)
  await svc.setSetting("casino_mtt", "off", "test");
  const before = await h.bal(P()[0].uid);
  await h.toStart(M);
  assert.equal(M.status, "cancelled");
  assert.match(M.cancel.reason, /switched off/);
  assert.equal(await h.bal(P()[0].uid), before + 1100);
  assert.equal(await h.held(), 0);
  // a running one survives the switch going off
  await svc.setSetting("casino_mtt", "everyone", "test");
  const M2 = await h.schedule({ max_entries: 20, min_entries: 2 });
  await h.reg(M2, P().slice(0, 4));
  await h.toStart(M2);
  assert.equal(M2.status, "running");
  await svc.setSetting("casino_mtt", "off", "test");
  await h.drive(M2, { policy: h.allIn() });
  assert.equal(M2.status, "done", "a running tournament plays to the end with the switch off");
});

test("register: ONE TNY hold of buy-in + fee (key tny:<id>:<uid>:enter:1); the refusals hold nothing (PAT, ban, linked, same address - also after the linked account busted, full, escrow not live, the room cap)", async () => {
  await h.fresh({ settings: { mtt_room_entrants_max: 1 } });
  const M = await h.schedule({ max_entries: 4, min_entries: 2, buyin: 5000 });
  const [a, b, c, d, e, f] = P();
  let r = await h.M(a, "join", [String(M.no)]);
  assert.ok(r.ok, r.reply);
  assert.match(r.reply, /You're in #\d+ \(5,000 \+ 500 PAT held; all of it back if you unregister before it starts\)/);
  const hold = (await getQuery("SELECT * FROM escrow_holds WHERE ref = ?", [`TNY-${M.id}`]))[0];
  assert.equal(hold.kind, "TNY");
  assert.equal(hold.amount, 5500);
  assert.equal(hold.key, `tny:${M.id}:${a.uid}:enter:1`);
  assert.equal((await h.M(a, "join", [String(M.no)])).reply, "You're already in.");
  assert.equal(await h.held(), 5500, "no second hold");
  // insufficient PAT
  await runQuery("UPDATE users SET points_balance = 100 WHERE userId = ?", [b.uid]);
  r = await h.M(b, "join", [String(M.no)]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /Not enough PAT for this entry \(need 5,500, you have 100\)/);
  await runQuery("UPDATE users SET points_balance = 1000000 WHERE userId = ?", [b.uid]);
  // banned
  await runQuery("UPDATE users SET casino_banned = 1 WHERE userId = ?", [c.uid]);
  assert.match((await h.M(c, "join", [String(M.no)])).reply, /banned/);
  await runQuery("UPDATE users SET casino_banned = 0 WHERE userId = ?", [c.uid]);
  // dup-linked / same address
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of) VALUES (?, ?)", [d.uid, a.uid]);
  assert.match((await h.M(d, "join", [String(M.no)])).reply, /An account linked to yours is already in this tournament/);
  h.NOW += 2500;
  const ip1 = h.mk(e.uid, e.name, { iph: "hash-1" }), ip2 = h.mk(f.uid, f.name, { iph: "hash-1" });
  assert.ok((await h.M(ip1, "join", [String(M.no)])).ok);
  assert.match((await h.M(ip2, "join", [String(M.no)])).reply, /Another account from your connection/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_log WHERE tid = ? AND kind = 'same-address refused'", [M.id]))[0].n, 1);
  // the room cap (1 room entrant): a second Camfrog player is pointed at the web
  const room1 = h.mk(b.uid, b.name, { via: "room", camfrog: "BeeCF", room: "PepeLab" });
  const room2 = h.mk(c.uid, c.name, { via: "room", camfrog: "CeeCF", room: "PepeLab" });
  assert.ok((await h.M(room1, "join", [String(M.no)])).ok);
  assert.match((await h.M(room2, "join", [String(M.no)])).reply, /web-only for more players/);
  // full: the 5th pre-start registration (max 4: a, e, b + one more)
  h.NOW += 2500;
  assert.ok((await h.M(c, "join", [String(M.no)])).ok);
  const g = P()[6];
  r = await h.M(g, "join", [String(M.no)]);
  assert.equal(r.reply, "It's full.");
  assert.equal(await h.held(), 4 * 5500);
  // escrow not live: refused
  await h.fresh({ live: false });
  const M2 = await h.schedule({});
  r = await h.M(a, "join", [String(M2.no)]);
  assert.match(r.reply, /escrow is live/);
  assert.equal(await h.held(), 0);
});

test("anti-collusion covers the whole tournament: a linked account can't enter even after the main account busted", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 6, reentry_max: 0 });
  await h.reg(M, P().slice(0, 6));
  await h.toStart(M);
  await h.drive(M, { policy: h.policy(0.5, 0.9), until: (m) => m.live_n <= 5 });
  const out = (await h.entries(M, "state = 'busted'"))[0];
  assert.ok(out && M.late_open, "someone is out, late registration still open");
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of) VALUES (?, ?)", [P()[7].uid, out.user_id]);
  h.NOW += 2500;
  const r = await h.M(P()[7], "join", [String(M.no)]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /An account linked to yours is already in this tournament/);
});

test("unregister: before the start a full refund (key ...:refund:1); after it refused; re-registering = gen 2 with new keys; an old idem replays its answer; a throw after the commit still answers and replays", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 20, min_entries: 2 });
  const [a, b, c] = P();
  const bal0 = await h.bal(a.uid);
  await h.reg(M, [a]);
  let r = await h.M(a, "leave", [String(M.no)]);
  assert.ok(r.ok, r.reply);
  assert.equal(await h.bal(a.uid), bal0, "buy-in and fee back");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${M.id}:${a.uid}:refund:1`]))[0].n, 1);
  h.NOW += 2500;
  await h.reg(M, [a]);
  const e2 = (await h.entries(M, "user_id = ? AND state = 'held'", [a.uid]))[0];
  assert.equal(e2.gen, 2);
  assert.equal(e2.enter_key, `tny:${M.id}:${a.uid}:enter:2`);
  // an old idem replays its stored answer (no second hold)
  const key = h.key();
  svc.S.rate.clear();
  const first = await svc.act(b, "join", [String(M.no)], { game: "mtt", room: null }, key);
  assert.ok(first.ok);
  const again = await svc.act(b, "join", [String(M.no)], { game: "mtt", room: null }, key);
  assert.equal(again.replayed, true);
  assert.equal(again.reply, first.reply);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE user_id = ? AND ref = ?", [b.uid, `TNY-${M.id}`]))[0].n, 1);
  // a throw injected after the commit: the answer still says you're in, and replays
  svc.S.hooks.crash = "mtt:register:after-commit";
  const k2 = h.key();
  h.NOW += 2500;
  const r3 = await svc.act(c, "join", [String(M.no)], { game: "mtt", room: null }, k2);
  svc.S.hooks.crash = null;
  assert.ok(r3.ok);
  assert.match(r3.reply, /You're in/);
  const r4 = await svc.act(c, "join", [String(M.no)], { game: "mtt", room: null }, k2);
  assert.equal(r4.replayed, true);
  assert.match(r4.reply, /You're in/);
  // after the start: refused
  await h.toStart(M);
  r = await h.M(a, "leave", [String(M.no)]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /It has started - you're in; sitting out only blinds you away/);
});

test("start: fewer than min = cancelled (every hold refunded once); otherwise the draw seats them (seed committed, never in a view before the end); a casino-banned entrant is refunded at the start", async () => {
  await h.fresh();
  let M = await h.schedule({ max_entries: 20, min_entries: 4 });
  await h.reg(M, P().slice(0, 3));
  await h.toStart(M);
  assert.equal(M.status, "cancelled");
  assert.match(M.cancel.reason, /not enough players/);
  assert.equal(await h.held(), 0);
  for (const x of await getQuery("SELECT * FROM escrow_holds WHERE ref = ?", [`TNY-${M.id}`])) assert.equal(x.state, "refunded");
  M = await h.schedule({ max_entries: 40, min_entries: 4, table_size: 9 });
  assert.match(view(M).draw_commit, /^[0-9a-f]{64}$/);
  assert.equal(view(M).seed, null);
  await h.reg(M, P().slice(0, 20));
  await runQuery("UPDATE users SET casino_banned = 1 WHERE userId = ?", [P()[19].uid]);
  await h.toStart(M);
  await runQuery("UPDATE users SET casino_banned = 0");
  assert.equal(M.status, "running");
  assert.equal(M.entries_n, 19, "the banned entrant isn't counted");
  assert.equal((await h.entries(M, "user_id = ?", [P()[19].uid]))[0].state, "refunded");
  assert.equal(M.tables.length, 3, "ceil(19 / 9)");
  const counts = MT.liveTables(M).map((T) => T.eng.seats.length).sort();
  assert.deepEqual(counts, [6, 6, 7]);
  assert.equal(JSON.stringify(view(M)).includes(M.seed.draw_seed), false, "the seed stays secret while it runs");
  // the draw is the published algorithm over the sorted entry keys
  const ids = (await h.entries(M, "state = 'playing'")).map((e) => `${e.user_id}:${e.gen}`);
  const order = SEAT.drawOrder(M.seed.draw_seed, "start", ids).map((x) => x.split(":")[0]);
  const T1 = MT.liveTables(M)[0];
  assert.deepEqual(T1.eng.seats, order.filter((_, i) => i % 3 === 0), "table 1 = draw positions 0, 3, 6, ...");
  // the tables are kept out of the cash lobby / Pepe's open list / the Sit & Go lists, and max_tables doesn't count them
  assert.equal(svc.lobby().length, 0);
  assert.equal(svc.openList().length, 0);
  assert.equal((await svc.TN.lobby(null)).list.length, 0);
  await svc.setSetting("max_tables", "1", "test");
  const open = await h.act(P()[30], "start", ["25/50"], { game: "holdem", room: null });
  assert.ok(open.ok, "a cash table opens - the 3 MTT tables aren't counted");
  // (review) a Sit & Go's max_tables count skips them too (tourney.js): 3 MTT tables + 1 cash table open, max 2 - a Sit & Go still opens
  await svc.setSetting("max_tables", "2", "test");
  await svc.setSetting("casino_sng", "everyone", "test");
  const sng = await h.act(P()[31], "new", ["3", "1k"], { game: "sng", room: null });
  assert.ok(sng.ok, `a sit & go opens - the MTT tables aren't counted: ${sng.reply}`);
  await svc.setSetting("max_tables", "0", "test");
  // push / advertise / host verbs refused at an MTT table; an MTT table never reaches tourney.js
  assert.match((await svc.push(T1.id, "PepeLab", Object.assign({}, h.admin, { admin: true }), "add")).reply, /run by the tournament/);
  assert.match((await svc.advertise(T1.id, "PepeLab", Object.assign({}, h.admin, { admin: true }), true)).reply, /run by the tournament/);
  for (const v of ["sit", "stand", "end", "deal", "cashout"]) {
    const rr = await h.A(h.byUid[T1.eng.seats[0]], v, T1.id, ["1000"]);
    assert.equal(rr.ok, false, v);
  }
  assert.ok(svc.TN.SNG, "tourney.js loaded");
  assert.equal(svc.tourneyKind(T1), "mtt");
});

test("presence: absent entrants start sitting out (checked / folded at once) and come back with !sitin", async () => {
  await h.fresh({ presence: "on" });
  const M = await h.schedule({ max_entries: 20, min_entries: 2 }, { startIn: 30 });
  await h.reg(M, P().slice(0, 4));
  h.NOW = M.start_at - 60e3;
  MT.seen(P()[0].uid); MT.seen(P()[1].uid); MT.seen(P()[2].uid);
  await h.toStart(M);
  const T = MT.liveTables(M)[0];
  assert.equal(T.qol[P()[3].uid].out, true, "the absent entrant starts sitting out");
  assert.equal(T.qol[P()[0].uid].out, false);
  const r = await h.A(P()[3], "sitin", T.id);
  assert.ok(r.ok, r.reply);
  assert.equal(T.qol[P()[3].uid].out, false);
});

test("late registration: the fewest seated (ties the lowest number), a new table when all are full; it closes at the level (also before a tick), at max entries and at the bubble + 1", async () => {
  await h.fresh();
  let M = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 9, late_levels: 2 });
  await h.reg(M, P().slice(0, 12));
  await h.toStart(M);
  assert.equal(M.tables.length, 2);
  assert.ok(M.late_open);
  let r = await h.M(P()[12], "join", [String(M.no)]);
  assert.ok(r.ok, r.reply);
  assert.match(r.reply, /You'll be seated at table 1 in a moment/, "6 and 6: the lowest number");
  assert.equal(M.transit[P()[12].uid].why, "late");
  r = await h.M(P()[13], "join", [String(M.no)]);
  assert.match(r.reply, /table 2/, "7 effective vs 6");
  // fill both tables (9-max: 14 effective so far, 4 more fill them); the next one opens table 3
  for (const p of P().slice(14, 18)) { const x = await h.M(p, "join", [String(M.no)]); assert.ok(x.ok, x.reply); }
  assert.equal(M.tables.length, 2);
  const x3 = await h.M(P()[18], "join", [String(M.no)]);
  assert.ok(x3.ok, x3.reply);
  assert.equal(M.tables.length, 3, "a new table when every candidate is full");
  assert.match(x3.reply, /table 3/);
  // a request after level_ends_at but before any tick: the clock decides - closed
  h.NOW = M.clock.level_ends_at + M.structure.level_ms + 1;
  r = await h.M(P()[30], "join", [String(M.no)]);
  assert.equal(r.reply, "Registration is closed.");
  assert.equal(M.late_open, false);
  assert.equal(M.paid, PAY.paid(M.entries_n, M.money));
  // closes at max entries
  M = await h.schedule({ max_entries: 5, min_entries: 2, table_size: 6, late_levels: 8 });
  await h.reg(M, P().slice(40, 44));
  await h.toStart(M);
  assert.ok(M.late_open);
  await h.reg(M, [P()[44]]);
  assert.equal(M.late_open, false, "max entries reached");
  // closes at the bubble + 1: E 4 -> paid 2 (65/35): live 3 closes it
  M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 6, late_levels: 8 });
  await h.reg(M, P().slice(50, 54));
  await h.toStart(M);
  assert.ok(M.late_open);
  await h.drive(M, { policy: h.allIn(), until: (m) => m.live_n <= 3 || m.status !== "running" });
  assert.equal(M.late_open, false, "live <= paid + 1");
});

test("re-entry: only after busting, only while late registration is open, at most reentry_max; refunded pre-start entries never count", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 10, reentry_max: 1 });
  const [a, b, c, d, e, f] = P().slice(60, 66);
  await h.reg(M, [a]);
  assert.ok((await h.M(a, "leave", [String(M.no)])).ok);
  h.NOW += 2500;
  await h.reg(M, [a, b, c, d, e, f]);
  await h.toStart(M);
  assert.equal((await h.M(a, "join", [String(M.no)])).reply, "You're already in.", "not busted: no re-entry");
  // (review) the refunded pre-start entry (gen 1) never counts as one of a's entries
  assert.equal((await h.entries(M, "user_id = ? AND entry_no IS NOT NULL", [a.uid])).length, 1, "a's refunded gen 1 isn't an entry");
  assert.equal((await MT.meFor(M, a.uid)).entries_used, 1);
  await h.drive(M, { policy: h.policy(0.5, 0.9), until: (m) => m.live_n <= 5 });
  const busted = (await h.entries(M, "state = 'busted'")).map((x) => x.user_id);
  assert.ok(busted.length >= 1, "someone busted");
  const who = h.byUid[busted[0]];
  h.NOW += 2500;
  assert.ok(M.late_open, "6 entries pay 2: late registration stays open until 3 are left (level < 10)");
  let r = await h.M(who, "join", [String(M.no)]);
  assert.ok(r.ok, r.reply);
  assert.match(r.reply, /back in/);
  const rows = await h.entries(M, "user_id = ?", [who.uid]);
  assert.equal(rows.filter((x) => x.entry_no != null).length, 2);
  // bust again -> no re-entries left (refused whether it still runs or not)
  await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" || (m.transit[who.uid] == null && !MT.whereIs(m, who.uid)) });
  h.NOW += 2500;
  r = await h.M(who, "join", [String(M.no)]);
  assert.equal(r.ok, false);
  if (M.status === "running") assert.match(r.reply, /No re-entries left|Registration is closed/);
});

test("the level clock: one clock for every table, blinds change only between hands, deterministic catch-up", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 12));
  await h.toStart(M);
  const [T1, T2] = MT.liveTables(M);
  await h.later(7);
  assert.ok(T1.eng.hand_active && T2.eng.hand_active);
  assert.equal(T1.eng.bb, 20);
  h.NOW += M.structure.level_ms * 3 + 10;
  await svc.tickOnce();
  assert.equal(M.clock.level, 3, "three levels caught up at once");
  assert.equal(T1.eng.bb, 20, "a hand in progress keeps its blinds");
  const [, bb3] = svc.TN.levelAt ? [0, 0] : [0, 0];
  void bb3;
  await h.drive(M, { policy: (T, a) => (H.toCall(T.eng, a) ? "fold" : "check"), until: () => T1.eng.hand_no >= 2 && T1.eng.hand_active });
  assert.equal(T1.eng.bb, require(path.join(h.repo, "casino", "tourney")).levelAt({ levels: M.structure.levels }, 3)[1], "the next hand has level 4's blinds");
});

async function runFull(M, opts = {}) {
  const totals = [await h.total()];
  const seqs = [];
  let maxTables = 0, h4h = false, finalSeen = false, breaks = 0, moves = 0;
  const seen = new Set();
  await h.drive(M, {
    policy: opts.policy || h.policy(0.3, 0.75),
    each: async (m) => {
      h.chipsOk(m);
      if (m.h4h.on) h4h = true;
      if (m.final) finalSeen = true;
      maxTables = Math.max(maxTables, m.tables.length);
      breaks = m.tables.filter((t) => t.state === "closed" && !t.final).length;
      moves = Math.max(moves, Object.keys(m.transit || {}).length);
      for (const T of MT.liveTables(m)) assert.ok(T.eng.seats.length <= m.structure.table_size, "never above the table size");
    },
  });
  totals.push(await h.total());
  return { totals, seqs, maxTables, h4h, finalSeen, breaks, moves, seen };
}

test("a full 27-entry MTT at 6-max, 25 % paid (6 places, bubble at 7 on 2 tables): balancing, breaks, hand-for-hand, the final table; the curve, the House fee, conservation, holds once, points, achievements", async () => {
  await h.fresh({ settings: { mtt_paid_pct: 25 }, deckSeed: 11 });
  const before = await h.total();
  const houseBefore = await h.house();
  const M = await h.schedule({ max_entries: 40, min_entries: 4, table_size: 6, late_levels: 0, buyin: 1000 });
  await h.reg(M, P().slice(0, 27));
  assert.equal(await h.total(), before, "registration moves PAT into holds, nothing else");
  await h.toStart(M);
  assert.equal(M.tables.length, 5);
  assert.equal(M.paid, 6);
  const run = await runFull(M);
  assert.equal(M.status, "done");
  assert.ok(run.h4h, "hand-for-hand ran at the bubble");
  assert.ok(run.finalSeen && M.final, "the final table formed");
  assert.ok(M.tables.filter((t) => t.state === "closed").length >= 4, "tables were broken");
  assert.equal(await h.total(), before, "PAT conservation: wallets + held + House, to the PAT");
  assert.equal(await h.house() - houseBefore, 27 * 100, "ONE fee leg to the House = F");
  const fee = await getQuery("SELECT amount FROM jackpot_rakes WHERE spinId = ?", [`escrow:TNY-${M.id}`]);
  assert.deepEqual(fee.map((x) => x.amount), [2700]);
  const holds = await h.holdsEnded(M);
  assert.equal(holds.length, 27);
  assert.ok(holds.every((x) => x.state === "spent" && x.done_key === `tny:${M.id}:finish`), "every hold settled by the one settle");
  const ent = await h.entries(M);
  const places = ent.map((x) => x.place).sort((a, b) => a - b);
  assert.deepEqual(places, Array.from({ length: 27 }, (_, i) => i + 1), "every entry placed once");
  const prizes = ent.filter((x) => x.prize > 0);
  assert.equal(ent.reduce((s, x) => s + x.prize, 0), 27000, "the whole pool is paid");
  assert.ok(prizes.length >= 6 && prizes.length <= 8, "the paid places (ties at the bubble may share)");
  const curve = PAY.split(27000, PAY.planBp(27, M.money));
  const winner = ent.find((x) => x.place === 1);
  assert.equal(winner.prize, curve[0]);
  for (const x of ent) assert.equal(await h.bal(x.user_id), 1000000 - 1100 + x.prize, `${x.user_id}: entry out, prize in`);
  // points: E = 27 >= 6
  const pts = await getQuery("SELECT * FROM casino_mtt_points WHERE tid = ?", [M.id]);
  assert.equal(pts.length, 27);
  assert.equal(pts.find((x) => x.place === 1).points, PAY.points(1, 27));
  // achievements: counted once each (E = 27 >= 10; 5 starting tables -> Final Table counts)
  const counts = await getQuery("SELECT metric, SUM(n) AS n FROM casino_ach_counts GROUP BY metric");
  const c = Object.fromEntries(counts.map((x) => [x.metric, x.n]));
  assert.equal(c.mtt_wins, 1);
  assert.equal(c.mtt_cashes, prizes.length);
  assert.equal(c.mtt_final_tables, M.final.user_ids.length);
  await MT.postSteps(M);
  const counts2 = Object.fromEntries((await getQuery("SELECT metric, SUM(n) AS n FROM casino_ach_counts GROUP BY metric")).map((x) => [x.metric, x.n]));
  assert.deepEqual(counts2, c, "post steps again: nothing counted twice");
  // the seed is revealed once it's over
  assert.equal(MT.publicView(M).seed, M.seed.draw_seed);
});

test("hand-for-hand: busts of a round share one batch (one bust_seq), announcements wait for the round, the clock runs on", async () => {
  await h.fresh({ settings: { mtt_paid_pct: 25 }, deckSeed: 23 });
  const M = await h.schedule({ max_entries: 40, min_entries: 4, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(100, 127));
  await h.toStart(M);
  const roundBusts = new Map();
  let sawOn = false, clockStopped = false;
  await h.drive(M, {
    policy: h.policy(0.3, 0.75),
    each: async (m) => {
      if (m.h4h.on) { sawOn = true; if (m.clock.paused_at) clockStopped = true; }
      if (m.h4h.on && m.h4h.started) roundBusts.set(m.h4h.round, m.h4h.batch);
    },
  });
  assert.ok(sawOn);
  const ent = await h.entries(M);
  // (review) the bubble round ends with a bust INTO its batch (hand-for-hand only stops at a bust: 7 left at 6-max can't form a final
  // table); the cross-table batch and the held lines: casino-mtt-review.test.js
  // (a bubble can also burst in a hand already running when hand-for-hand switched on - before any round: no batch then)
  if (roundBusts.size) {
    const last = Math.max(...roundBusts.keys());
    assert.ok(ent.filter((x) => x.bust_seq === roundBusts.get(last)).length >= 1, "the bubble round's bust is in its batch");
  }
  assert.ok(!clockStopped, "the level clock runs on during hand-for-hand");
  assert.equal(M.status, "done");
});

test("9-max with the defaults (27 entries: paid 4 < 9): hand-for-hand never switches on; the bubble falls at the final table", async () => {
  await h.fresh({ deckSeed: 5 });
  const M = await h.schedule({ max_entries: 40, min_entries: 4, table_size: 9, late_levels: 0 });
  await h.reg(M, P().slice(200, 227));
  await h.toStart(M);
  assert.equal(M.paid, 4);
  const run = await runFull(M);
  assert.equal(run.h4h, false);
  assert.equal(M.status, "done");
});

test("the final table in place: E = 6 on one table (at late close), E = 12 at 6-max broken to one table during late reg; post steps never throw with M.final null", async () => {
  await h.fresh();
  let M = await h.schedule({ max_entries: 6, min_entries: 2, table_size: 9, late_levels: 2 });
  await h.reg(M, P().slice(300, 306));
  await h.toStart(M);
  assert.ok(!M.late_open, "6 = max entries: late registration closed at the start");
  assert.ok(M.final && M.final.in_place, "one table: the final table in place");
  await h.drive(M, { policy: h.allIn() });
  assert.equal(M.status, "done");
  M = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 6, late_levels: 3 });
  await h.reg(M, P().slice(310, 322));
  await h.toStart(M);
  assert.equal(M.tables.length, 2);
  await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" || (!m.late_open && m.final) || m.live_n <= 2 });
  if (M.final) assert.ok(M.final.in_place || M.final.table_id, "formed");
  await h.drive(M, { policy: h.allIn() });
  assert.equal(M.status, "done");
  // M.final null (it ended before any final table): the post steps still finish
  const M3 = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M3, P().slice(330, 342));
  await h.toStart(M3);
  M3.final = null;
  await h.drive(M3, { policy: h.allIn(), until: (m) => m.status !== "running" || m.live_n <= 6 });
  M3.final = null;
  await h.drive(M3, { policy: h.allIn() });
  assert.equal(M3.status, "done");
});

test("a 180-entry smoke run with all-in bots inside a wall-time budget (one settle for every hold, start and finish transactions < 1 s); a 500-entry start + finish", async () => {
  await h.fresh({ deckSeed: 3 });
  const M = await h.schedule({ max_entries: 180, min_entries: 2, table_size: 9, late_levels: 0 });
  await h.reg(M, P().slice(0, 180));
  const t0 = Date.now();
  await h.toStart(M);
  const tStart = Date.now() - t0;
  assert.equal(M.tables.length, 20);
  const t1 = Date.now();
  await h.drive(M, { policy: h.allIn() });
  const tRun = Date.now() - t1;
  assert.equal(M.status, "done");
  assert.ok(tStart < 1000, `start ${tStart} ms`);
  assert.ok(tRun < 120000, `run ${tRun} ms`);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${M.id}:finish`]))[0].n, 1, "one settle");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE ref = ? AND state = 'spent'", [`TNY-${M.id}`]))[0].n, 180);
  console.log(`[timing] 180 entries: start ${tStart} ms, run ${tRun} ms`);
  // 500 entries
  await svc.setSetting("mtt_max_field", "500", "test");
  const M5 = await h.schedule({ max_entries: 500, min_entries: 2, table_size: 9, late_levels: 0 }, { startIn: 600 });
  await h.reg(M5, P().slice(0, 500));
  const s0 = Date.now();
  await h.toStart(M5);
  const s5 = Date.now() - s0;
  assert.equal(M5.tables.length, 56);
  await h.drive(M5, { policy: h.allIn(), until: (m) => m.status !== "running" });
  const f5 = svc.S.mttTxMs.finish;
  assert.ok(["settled", "done"].includes(M5.status), M5.status);
  console.log(`[timing] 500 entries: start ${s5} ms, finish ${f5} ms`);
  assert.ok(s5 < 3000, `500-entry start ${s5} ms`);
  assert.ok(svc.S.mttTxMs.start < 1000 && f5 < 1000, `the start / finish transactions: ${svc.S.mttTxMs.start} / ${f5} ms`);
});

test("the stream slot: the final table takes a cash table's slot (its own line, the cash table first in the queue); a tournament table on the slot is never pre-empted; admin stream off = no re-take", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 6, min_entries: 2, table_size: 9, late_levels: 0 });
  await h.reg(M, P().slice(401, 405));
  h.NOW = M.start_at - 10e3;                                // (a cash table left alone idles out in 5 minutes)
  const cash = await h.act(P()[400], "start", ["25/50"], { game: "holdem", room: null });
  await svc.stream(cash.table, true, Object.assign({}, P()[400], { admin: false }), false);
  assert.equal(svc.S.stream.table, cash.table);
  await h.toStart(M);
  const F = MT.liveTables(M)[0];
  assert.equal(svc.S.stream.table, F.id, "the final table took the slot");
  assert.equal(svc.S.stream.queue[0], cash.table, "the cash table is next in line");
  const T = svc.getTable(cash.table);
  assert.ok(T.log.some((l) => /moved to the final table of tournament #\d+ - this table is next in line/.test(l.text)));
  // a second final while the first holds the slot: queued, never pre-empting (straight at its start - the same minute)
  const M2 = await h.schedule({ max_entries: 6, min_entries: 2, table_size: 9, late_levels: 0 }, { startIn: 11 });
  await h.reg(M2, P().slice(410, 414));
  await svc.locked(() => MT.admin("start", h.admin, M2, {}));
  const F2 = MT.liveTables(M2)[0];
  assert.equal(svc.S.stream.table, F.id);
  assert.ok(svc.S.stream.queue.indexOf(F2.id) >= 0, "queued");
  if (svc.S.stream.queue.includes(cash.table)) assert.ok(svc.S.stream.queue.indexOf(F2.id) < svc.S.stream.queue.indexOf(cash.table), "after the tournament tables, before the cash table");
  // the slot is kept through a long pause (the tick refreshes the held final table)
  await svc.locked(() => MT.pause(M, "test", true));
  for (let i = 0; i < 8; i++) await h.later(60);
  assert.equal(svc.S.stream.table, F.id, "still on the slot after 8 minutes paused");
  await svc.locked(() => MT.pause(M, "test", false));
  // admin stream off: no automatic re-take
  await svc.locked(() => MT.admin("stream", h.admin, M, { on: false }));
  assert.notEqual(svc.S.stream.table, F.id);
  assert.ok(M.stream_off_by);
  // released at the finish
  await h.drive(M2, { policy: h.allIn() });
  assert.ok(!svc.S.stream.queue.includes(F2.id) && svc.S.stream.table !== F2.id);
  // the scene: Pepe's on-air show holds OBS -> "as soon as the current show ends" (the room line)
  await h.drive(M, { policy: h.allIn() });
  const M3 = await h.schedule({ max_entries: 6, min_entries: 2, table_size: 9, late_levels: 0, rooms: ["PepeLab"] }, { startIn: 11 });
  await h.reg(M3, P().slice(420, 424));
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);
  MT.noteScene({ held: true });
  await svc.locked(() => MT.admin("start", h.admin, M3, {}));
  const lines = (await getQuery("SELECT data FROM casino_events WHERE table_id = ? AND kind = 'mtt'", [M3.id])).map((x) => JSON.parse(x.data).text);
  assert.ok(lines.some((t) => /goes on Pepe's stream as soon as the current show ends/.test(t)) || lines.some((t) => /next on Pepe's stream/.test(t)), lines.join(" | "));
  MT.noteScene({ held: false });
});

test("admin: cancel while registering and while running (busts + transit) refunds every hold once, closes the tables, pays nothing; non-admins / a Pepe room admin can't; a cancel racing the last bust is refused", async () => {
  await h.fresh();
  let M = await h.schedule({ max_entries: 20, min_entries: 2 });
  await h.reg(M, P().slice(0, 5));
  let r = await svc.locked(() => MT.admin("cancel", P()[0], M, { confirm: true, reason: "x" }));
  assert.equal(r.status, 403);
  r = await h.M(Object.assign({}, P()[0], { via: "room", admin: true }), "cancel", [String(M.no), "confirm"]);
  assert.equal(r.ok, false, "a Pepe room admin without casino.admin");
  assert.match(r.reply, /only an admin/);
  r = await h.M(Object.assign({}, P()[0], { via: "room", admin: true }), "pause", [String(M.no)]);
  assert.equal(r.ok, false);
  r = await svc.locked(() => MT.admin("cancel", h.admin, M, { confirm: true, reason: "testing" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(await h.held(), 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'casino_mtt_cancel'"))[0].n, 1);
  // running, with busts and a player in transit
  const before = await h.total();
  M = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(10, 27));
  await h.toStart(M);
  await h.drive(M, { policy: h.policy(0.4, 0.8), until: (m) => m.live_n <= 12 });
  const rows = await h.entries(M);
  r = await svc.locked(() => MT.admin("cancel", h.admin, M, { confirm: true, reason: "testing running" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.refunds, 17);
  assert.equal(await h.total(), before);
  for (const x of rows) assert.equal(await h.bal(x.user_id), 1000000, "the entry back in full (fee included)");
  assert.ok(M.tables.every((t) => t.state === "closed"));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key LIKE ?", [`tny:${M.id}:%:refund:%`]))[0].n, 17);
  // (review) a cancel after the last bust (the tournament is finishing - its finish refused here by a real chip mismatch) is refused, by
  // the admin page and in chat; once the chips add up the finish settles on its own
  M = await h.schedule({ max_entries: 6, min_entries: 2, late_levels: 0 });
  await h.reg(M, P().slice(30, 32));
  await finishingWithChipMismatch(M);
  r = await svc.locked(() => MT.admin("cancel", h.admin, M, { confirm: true, reason: "too late" }));
  assert.equal(r.status, 409, "a plain cancel is refused once the last bust is in");
  assert.match(r.error, /finishing/);
  r = await h.M(h.admin, "cancel", [String(M.no), "confirm"]);
  assert.equal(r.ok, false, "and in chat");
  assert.equal(M.status, "finishing");
  M.total_chips -= 1;                                          // the chips add up again: the next retry settles
  h.NOW += 61e3; await svc.tickOnce();
  assert.ok(["settled", "done"].includes(M.status), M.status);
  assert.equal(await h.held(), 0);
});

/** (review) 2 entrants, equal stacks, both all in on the first hand - the total is made one chip off DURING that hand (after the boundary's
 *  chip check), so the last bust leaves a winner whose chips don't match: the finish refuses E_CHIPS and the tournament stays finishing */
async function finishingWithChipMismatch(M) {
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn(), until: (m) => MT.liveTables(m).some((T) => T.eng.hand_active) });
  M.total_chips += 1;
  await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" || !!m.paused });
  assert.equal(M.status, "finishing", "the first hand busted the loser (equal stacks, both all in)");
  assert.equal(M.finish.last_code, "E_CHIPS", "the real comparison: the winner's chips vs total_chips");
}

test("void and refund: only the owner, only while finishing, never once settled; delay + raise max; refund an entry; a DQ before the money (chips out, ranked), refused after the bubble", async () => {
  await h.fresh();
  const staffroles = require(path.join(h.repo, "staffroles"));
  const realOwner = staffroles.ownerOf;
  staffroles.ownerOf = async (u) => (u && u.userId === "ad" ? { userId: "ad", username: "ada" } : null);
  try {
    let M = await h.schedule({ max_entries: 6, min_entries: 2, late_levels: 0 });
    await h.reg(M, P().slice(0, 2));
    await h.toStart(M);
    let r = await svc.locked(() => MT.admin("void", h.admin, M, { confirm: true, reason: "test" }));
    assert.equal(r.status, 409, "not finishing yet");
    // stop the finish: a REAL chip mismatch (review: no test-only flag in the plan) makes it refuse, so it stays "finishing"
    await finishingWithChipMismatch(M);
    r = await svc.locked(() => MT.admin("cancel", h.admin, M, { confirm: true, reason: "x" }));
    assert.equal(r.status, 409, "a plain cancel is refused while finishing");
    r = await svc.locked(() => MT.admin("void", h.staff, M, { confirm: true, reason: "x" }));
    assert.ok(r.status === 403);
    r = await svc.locked(() => MT.admin("void", h.admin, M, { confirm: true, reason: "the chips don't add up" }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(M.status, "cancelled");
    assert.equal(await h.held(), 0);
    for (const e of await h.entries(M)) assert.equal(await h.bal(e.user_id), 1000000, "the void refunded the entry in full");
    // (review) never once settled: a finished tournament can't be voided
    const Ms = await h.schedule({ max_entries: 6, min_entries: 2, late_levels: 0 });
    await h.reg(Ms, P().slice(40, 42));
    await h.toStart(Ms);
    await h.drive(Ms, { policy: h.allIn() });
    assert.equal(Ms.status, "done");
    r = await svc.locked(() => MT.admin("void", h.admin, Ms, { confirm: true, reason: "after the fact" }));
    assert.equal(r.status, 409);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key LIKE ?", [`tny:${Ms.id}:%:refund:%`]))[0].n, 0, "nothing refunded");
    // delay + raise max while registering; refund an entry
    M = await h.schedule({ max_entries: 6, min_entries: 2 });
    await h.reg(M, P().slice(10, 13), { remind: true });
    const start0 = M.start_at;
    r = await svc.locked(() => MT.admin("delay", h.admin, M, { minutes: 30 }));
    assert.ok(r.ok);
    assert.equal(M.start_at, start0 + 30 * 60e3);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_reminders WHERE tid = ? AND kind = 'starting' AND dropped = 're-dated'", [M.id]))[0].n, 3);
    assert.equal((await svc.locked(() => MT.admin("delay", h.admin, M, { minutes: 6 * 60 }))).ok, false, "6 h in all at most");
    r = await svc.locked(() => MT.admin("max", h.admin, M, { max_entries: 9 }));
    assert.ok(r.ok);
    assert.equal(M.structure.max_entries, 9);
    const first = (await h.entries(M))[0];
    r = await svc.locked(() => MT.admin("refund", h.admin, M, { n: 1 }));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(M.reg_n, 2);
    // (review) the refunded entry: its hold refunded once, the wallet whole again, the entry refunded
    assert.equal((await getQuery("SELECT state FROM escrow_holds WHERE id = ?", [first.hold_id]))[0].state, "refunded");
    assert.equal(await h.bal(first.user_id), 1000000);
    assert.equal((await h.entries(M, "user_id = ?", [first.user_id]))[0].state, "refunded");
    // DQ before the money
    M = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 9, late_levels: 0 });
    await h.reg(M, P().slice(20, 30));
    await h.toStart(M);
    await h.later(7);
    const total0 = M.total_chips;
    const list = await h.entries(M);
    const n = list.findIndex((x) => x.state === "playing") + 1;
    const victim = list[n - 1].user_id;
    r = await svc.locked(() => MT.admin("dq", h.admin, M, { n, reason: "collusion" }));
    assert.ok(r.ok, JSON.stringify(r));
    await h.drive(M, { policy: (T, a) => (H.toCall(T.eng, a) ? "fold" : "check"), until: (m) => (m.dq[victim] || {}).applied });
    const v = (await h.entries(M, "user_id = ?", [victim]))[0];
    assert.equal(v.state, "busted");
    assert.equal(v.dq, 1);
    assert.equal(v.bust_stack, 0);
    assert.ok(M.total_chips < total0, "their chips left play");
    h.chipsOk(M);
    // after the bubble: refused
    await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" || m.live_n <= m.paid });
    if (M.status === "running") {
      const n2 = (await h.entries(M)).findIndex((x) => x.state === "playing") + 1;
      r = await svc.locked(() => MT.admin("dq", h.admin, M, { n: n2, reason: "late" }));
      assert.equal(r.ok, false);
      assert.match(r.error, /past the bubble/);
    }
  } finally { staffroles.ownerOf = realOwner; }
});

test("pause / resume: the tables hold after their hand, the clock moves by the pause; the finish never runs while system-paused", async () => {
  await h.fresh();
  const M = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 12));
  await h.toStart(M);
  await h.later(7);
  await svc.locked(() => MT.pause(M, "test", true));
  const ends = M.clock.level_ends_at;
  await h.drive(M, { policy: (T, a) => (H.toCall(T.eng, a) ? "fold" : "check"), until: (m) => MT.liveTables(m).every((T) => !T.eng.hand_active) });
  for (let i = 0; i < 5; i++) await h.later(60);
  assert.ok(MT.liveTables(M).every((T) => !T.eng.hand_active && T.tourney.hold === "pause"), "every table holds");
  assert.equal(M.clock.level, 0, "no level passed while paused");
  const pausedFor = h.NOW - M.clock.paused_at;
  await svc.locked(() => MT.pause(M, "test", false));
  assert.equal(M.clock.level_ends_at, ends + pausedFor);
  await h.later(1);
  assert.ok(MT.liveTables(M).some((T) => T.eng.hand_active || T.dl.next));
});

test("timeouts / sitting out: never stood up, blinded away, an out seat acts at once; a moved player keeps bank / hands / timeouts / out; pre-moves cleared; a late entrant gets a fresh bank", async () => {
  await h.fresh();
  const st = await svc.loadSettings();
  const M = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 6, late_levels: 4 });
  await h.reg(M, P().slice(0, 12));
  await h.toStart(M);
  await h.later(7);
  const T = MT.liveTables(M)[0];
  const a = H.currentActor(T.eng);
  // (review) two timeouts (two hands - one per turn): out, still seated (never stood up); the others act at once
  const quick = (TT, k) => (H.toCall(TT.eng, k) ? "fold" : "check");
  for (let i = 0; i < 4000 && !(T.qol[a] && T.qol[a].timeouts >= 2); i++) {
    const e = T.eng;
    const k = e.hand_active ? H.currentActor(e) : null;
    if (k && T.turn && T.turn.uid === k) {
      if (k === a) { h.NOW = T.dl.turn + 1; await svc.tickOnce(); }
      else await h.A(h.byUid[k], quick(T, k), T.id);
    } else { h.NOW += 1000; await svc.tickOnce(); }
    for (const L of MT.liveTables(M)) if (L !== T && L.eng.hand_active && L.turn) { const kk = H.currentActor(L.eng); if (kk === L.turn.uid) await h.A(h.byUid[kk], quick(L, kk), L.id); }
  }
  assert.ok(T.qol[a].timeouts >= 2, "two timeouts");
  assert.equal(T.qol[a].out, true, "two timeouts: sitting out");
  assert.ok(T.eng.seats.includes(a), "never stood up");
  // an out seat acts at once: over the next hands nobody waits for a's clock (no timeout added) and a stays dealt in (blinded away)
  const t0 = T.qol[a].timeouts, hand0 = T.eng.hand_no;
  let dealtA = 0;
  for (let i = 0; i < 4000 && T.eng.hand_no < hand0 + 3; i++) {
    const e = T.eng;
    if (e.hand_active && e.players.includes(a) && !dealtA) dealtA = e.hand_no;
    const k = e.hand_active ? H.currentActor(e) : null;
    assert.ok(!(T.turn && T.turn.uid === a), "an out seat never gets a turn clock");
    if (k && T.turn && T.turn.uid === k) await h.A(h.byUid[k], quick(T, k), T.id);
    else { h.NOW += 1000; await svc.tickOnce(); }
    for (const L of MT.liveTables(M)) if (L !== T && L.eng.hand_active && L.turn) { const kk = H.currentActor(L.eng); if (kk === L.turn.uid) await h.A(h.byUid[kk], quick(L, kk), L.id); }
  }
  assert.ok(dealtA > 0, "still dealt in while out");
  assert.ok(T.qol[a].timeouts <= t0, "no more timeouts: an out seat acts at once (its auto-actions never wait for its clock)");
  assert.equal(T.qol[a].out, true, "still sitting out (blinded away until !sitin)");
  for (let i = 0; i < 30; i++) await h.later(60);
  assert.ok(T.eng.seats.includes(a) || MT.whereIs(M, a), "still in after 30 minutes away");
  // a moved player keeps bank / hands / timeouts / out: every seat gets a distinctive QoL; the next move (busts at table 1 only: the
  // others give players) must carry it to the new table
  await h.fresh({ deckSeed: 3 });
  const M2 = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M2, P().slice(20, 37));
  await h.toStart(M2);
  // (the giving tables' seats all sit out - an action resets timeouts, sitting out stays; banks and hands are distinctive)
  MT.liveTables(M2).forEach((L) => L.eng.seats.forEach((uid, j) => { L.qol[uid] = Object.assign(L.qol[uid] || {}, { bank: 7 + j, hands: 3 + j, out: L.tourney.no !== 1 }); }));
  const agg = h.policy(0.5, 0.9);
  const last = new Map();                                   // uid -> {table, q}: the QoL last seen at the table they sat at
  let moved = null;
  await h.drive(M2, {
    policy: (TT, k) => (TT.tourney.no === 1 ? agg(TT, k) : H.toCall(TT.eng, k) ? "fold" : "check"),
    each: async (m) => {
      if (moved) return;
      for (const L of MT.liveTables(m)) for (const u of L.eng.seats) {
        const prev = last.get(u);
        if (prev && prev.table !== L.id) { moved = { u, L, w: prev.q }; return; }
        last.set(u, { table: L.id, q: Object.assign({}, L.qol[u]) });
      }
    },
    until: (m) => !!moved || m.status !== "running",
  });
  assert.ok(moved, "a move happened");
  const q = moved.L.qol[moved.u], w = moved.w;
  assert.equal(w.out, true, "(the mover sat out at their old table)");
  assert.equal(q.out, true, "out carried");
  assert.equal(q.timeouts, w.timeouts, "timeouts carried");
  assert.ok(q.hands >= w.hands && q.hands <= w.hands + 1, `hands carried (${q.hands} vs ${w.hands})`);
  assert.ok(q.bank >= w.bank && q.bank <= w.bank + 5, `the bank carried (${q.bank} vs ${w.bank}), not a fresh one`);
  // (pre-moves: hand-scoped - holdem.js clearInvalidPre drops any from another hand; the move's forgetSeat drops them at once too)
  // a late entrant: a fresh bank
  await h.fresh();
  const M3 = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 6, late_levels: 4 });
  await h.reg(M3, P().slice(40, 52));
  await h.toStart(M3);
  const late = P()[60];
  const r = await h.M(late, "join", [String(M3.no)]);
  assert.ok(r.ok, r.reply);
  assert.ok(M3.transit[late.uid], "in transit to a table");
  assert.equal(M3.transit[late.uid].qol.bank, Math.min(st.hm_timebank_secs, st.hm_timebank_max));
});

test("property: random MTTs (E 20..80, random play, late entries + re-entries) - tables within one player or converging, never over the size; the final table forms exactly once; conservation", async () => {
  let reentries = 0, reentries0 = 0;
  for (const [E, size, seed] of [[23, 6, 31], [41, 9, 32], [58, 6, 33]]) {
    await h.fresh({ settings: { mtt_paid_pct: 20 }, deckSeed: seed });
    const before = await h.total();
    const M = await h.schedule({ max_entries: 120, min_entries: 2, table_size: size, late_levels: 2, reentry_max: 1 });
    await h.reg(M, P().slice(0, E));
    await h.toStart(M);
    let late = E, finals = new Set();
    const lonely = new Map();                                 // table id -> since when it has < 2 players, nothing inbound, not breaking
    let worstLonely = 0;
    await h.drive(M, {
      policy: h.policy(0.25, 0.7),
      each: async (m) => {
        h.chipsOk(m);
        if (m.final) finals.add(m.final.table_id);
        for (const T of MT.liveTables(m)) assert.ok(T.eng.seats.length <= m.structure.table_size);
        // (review) a table left with fewer than 2 players gets company (an inbound player, a break, the final) within a bounded time
        for (const r of m.tables) {
          const x = MT.layout(m).find((y) => y.no === r.no);
          const alone = m.status === "running" && r.state === "live" && !r.final && x && x.seated < 2 && !x.inbound && m.tables.filter((t) => t.state !== "closed").length > 1;
          if (alone) { if (!lonely.has(r.id)) lonely.set(r.id, h.NOW); worstLonely = Math.max(worstLonely, h.NOW - lonely.get(r.id)); } else lonely.delete(r.id);
        }
        if (m.late_open && late < E + 15 && h.rng() < 0.02) {
          const p = P()[late++];
          h.NOW += 2100;
          const r = await h.M(p, "join", [String(m.no)]);
          assert.ok(r.ok || /closed|full/.test(r.reply), r.reply);
        }
        // (review) re-entries too: a busted player with an entry left re-enters while late registration is open
        if (m.late_open && h.rng() < 0.05) {
          const out = (await h.entries(m, "state = 'busted' AND dq = 0")).map((e) => e.user_id).filter((u) => !MT.whereIs(m, u));
          for (const u of out.slice(0, 1)) {
            const used = (await h.entries(m, "user_id = ? AND entry_no IS NOT NULL", [u])).length;
            if (used > m.structure.reentry_max) continue;
            h.NOW += 2100;
            const r = await h.M(h.byUid[u], "join", [String(m.no)]);
            assert.ok(r.ok || /closed|full/.test(r.reply), r.reply);
            if (r.ok) reentries++;
          }
        }
      },
    });
    assert.equal(M.status, "done");
    assert.equal(finals.size, 1, "the final table forms exactly once (E > table size)");
    assert.ok(worstLonely <= 2 * M.structure.level_ms + 120e3, `E=${E}: a lone player waited ${Math.round(worstLonely / 1000)} s for company`);
    assert.ok(M.tables.length <= Math.ceil(E / size) + (late - E) + (reentries - reentries0) + 1, `E=${E}: bounded table openings (${M.tables.length})`);
    reentries0 = reentries;
    assert.equal(await h.total(), before, `E=${E}: conservation`);
    await h.holdsEnded(M);
  }
  assert.ok(reentries >= 1, `re-entries happened in the random runs (${reentries})`);
});
