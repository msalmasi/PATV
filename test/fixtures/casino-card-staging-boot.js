// 1.99aoh (FAIR-1 for the card tables) - test/casino-card-staging.test.js's STAGING side, in its own process (dbUtils opens ./myapp.db):
// boots the casino on a refreshed copy of "prod" (VACUUM INTO + deploy/keep-staging-tables.js, done by the test) 11 minutes after the copy,
// then does what staging routinely does: the clock runs past every deadline (bet windows, turn clocks, the next hand, idle closes) and
// people try to bet, sit, deal and act at every copied table. Then it boots AGAIN (a restart: the retire must be idempotent). Prints one JSON
// line: which copied tables staging still has open, every round / hand of them revealed on staging that wasn't revealed in the copy, every
// casino_events row staging wrote for them, what the people's tries answered, and the conservation total (wallets + House + PAT at the open
// tables + escrow holds) before, after the first boot and after the second, plus the balances and the transactions count.
//   node test/fixtures/casino-card-staging-boot.js <dir with myapp.db> <table ids comma-separated> <prod clock ms> [tournament ids comma-separated]
"use strict";
const path = require("path");
const [dir, idsArg, nowArg, mttArg] = process.argv.slice(2);
const repo = path.resolve(__dirname, "../..");
if (require.main !== module || !dir) return;        // (a fixture: loaded on its own it does nothing)
process.chdir(dir);
process.env.STAGING = "1";
const svc = require(path.join(repo, "casino/service"));
const veil = require(path.join(repo, "casino/veil"));
const { getQuery } = require(path.join(repo, "dbUtils"));
require(path.join(repo, "casino/rewards")).hooks.updateLevel = async () => {};
const ids = idsArg.split(",").filter(Boolean);
const mtts = String(mttArg || "").split(",").filter(Boolean);
let now = Number(nowArg) + 11 * 60000;
svc.S.hooks.now = () => now;
const one = async (sql, args) => { try { return Number((await getQuery(sql, args || []))[0].n) || 0; } catch (e) { return 0; } };
const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
/** the PAT really at the open tables: blackjack / roulette escrow; a cash Hold'em table's stacks + what is in a hand IN PLAY (supply.js
 *  casinoHeld also counts the last hand's contributions between hands); a tournament's chips are not PAT (its entries are escrow holds) */
async function atTables() {
  let t = 0;
  for (const r of await getQuery("SELECT game, state FROM casino_tables WHERE status != 'closed'")) {
    let T;
    try { T = JSON.parse(r.state); } catch (e) { continue; }
    if (r.game === "holdem") {
      if (T.tourney) continue;
      const e = T.eng || {};
      for (const v of Object.values(e.chips || {})) t += n(v);
      if (e.hand_active) for (const v of Object.values(e.contrib || {})) t += n(v);
    } else for (const v of Object.values(T.escrowed || {})) t += n(v);
  }
  return t;
}
const total = async () =>
  (await one("SELECT COALESCE(SUM(points_balance), 0) AS n FROM users")) + (await one("SELECT COALESCE(SUM(amount), 0) AS n FROM jackpot_rakes")) +
  (await one("SELECT COALESCE(SUM(amount), 0) AS n FROM escrow_holds WHERE state = 'held'")) + (await atTables());
const inList = (list) => list.map(() => "?").join(",") || "''";
const revealedNow = async () =>
  (await getQuery(`SELECT table_id, round_no, server_seed FROM casino_rounds WHERE revealed IS NOT NULL AND table_id IN (${inList(ids)})`, ids))
    .map((r) => `${r.table_id}:${r.round_no}`);
const balances = async () => Object.fromEntries((await getQuery("SELECT userId, points_balance FROM users ORDER BY userId")).map((r) => [r.userId, r.points_balance]));
const statuses = async () => Object.fromEntries((await getQuery(`SELECT id, status FROM casino_tables WHERE id IN (${inList(ids)})`, ids)).map((r) => [r.id, r.status]));
const mttStatus = async () => {
  const out = {};
  for (const id of mtts) {
    const r = (await getQuery("SELECT status, state FROM casino_mtt WHERE id = ?", [id]).catch(() => []))[0];
    if (!r) continue;
    let M = {};
    try { M = JSON.parse(r.state); } catch (e) { M = {}; }
    out[id] = { status: r.status, draw_seed: (M.seed && M.seed.draw_seed) || null, revealed_at: (M.seed && M.seed.revealed_at) || null };
  }
  return out;
};
const who = (uid) => ({ uid, name: "Player" + uid, username: "player" + uid, camfrog: null, via: "web", iph: null, admin: false, veil: null });

(async () => {
  veil._hooks.kind = async () => null;
  await require(path.join(repo, "funding")).init();
  const before = await total();
  const revealedBefore = new Set(await revealedNow());
  const roundsOf = () => one(`SELECT COUNT(*) AS n FROM casino_rounds WHERE table_id IN (${inList(ids)})`, ids);
  const rounds0 = await roundsOf();
  const seq0 = await one("SELECT COALESCE(MAX(seq), 0) AS n FROM casino_events");
  const inbox0 = await one("SELECT COUNT(*) AS n FROM inbox");
  await svc.boot({ tick: false });
  const loaded = ids.filter((id) => svc.getTable(id)?.status === "open");
  const loadedMtt = mtts.filter((id) => { const M = svc.S.mtts && svc.S.mtts.get(id); return M && !["cancelled", "done"].includes(M.status); });
  // staging's routine: deadlines run out, people try to play at every copied table
  for (let i = 0; i < 8; i++) { now += 61000; await svc.tickOnce(); }
  const tries = {};
  let k = 0;
  for (const id of ids) {
    const T0 = (await getQuery("SELECT game, state FROM casino_tables WHERE id = ?", [id]))[0];
    const game = T0 ? T0.game : "bj";
    const out = [];
    for (const uid of ["u1", "u2", "u3", "u4"]) {
      svc.S.rate.clear();
      const verbs = game === "holdem" ? [["sit", ["2000"]], ["deal", []], ["check", []], ["call", []]] : [["bet", ["500"]], ["deal", []], ["hit", []], ["insurance", []]];
      for (const [verb, args] of verbs) {
        const r = await svc.act(who(uid), verb, args, { table: id, game: game === "holdem" ? "holdem" : undefined }, "stg-" + id + "-" + ++k);
        out.push(!!r.ok);
      }
    }
    tries[id] = out;
  }
  for (let i = 0; i < 4; i++) { now += 61000; await svc.tickOnce(); }
  const after = await total();
  const tx1 = await one("SELECT COUNT(*) AS n FROM transactions");
  const bal1 = await balances();
  const st1 = await statuses();
  const mtt1 = await mttStatus();
  // a restart: nothing is credited twice, nothing reopens
  svc.stop();
  now += 60000;
  await svc.boot({ tick: false });
  for (let i = 0; i < 3; i++) { now += 61000; await svc.tickOnce(); }
  const loaded2 = ids.filter((id) => svc.getTable(id)?.status === "open");
  const after2 = await total();
  const tx2 = await one("SELECT COUNT(*) AS n FROM transactions");
  const bal2 = await balances();
  const revealed = (await revealedNow()).filter((x) => !revealedBefore.has(x));
  const events = (await getQuery(`SELECT table_id, kind FROM casino_events WHERE seq > ? AND table_id IN (${inList(ids.concat(mtts))})`, [seq0].concat(ids, mtts)))
    .map((r) => `${r.table_id}:${r.kind}`);
  const inbox = (await one("SELECT COUNT(*) AS n FROM inbox")) - inbox0;
  const newRounds = (await roundsOf()) - rounds0;      // a copy never commits (or deals) a round of its own
  process.stdout.write(JSON.stringify({ loaded, loadedMtt, loaded2, revealed, events, newRounds, tries, before, after, after2, tx1, tx2, bal1, bal2,
                                        statuses: st1, statuses2: await statuses(), mtt: mtt1, mtt2: await mttStatus(), inbox,
                                        held: await atTables() }) + "\n");
  svc.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
