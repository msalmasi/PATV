// 1.99aoe (review FAIR-1) - test/casino-rl-staging.test.js's STAGING side, in its own process (dbUtils opens ./myapp.db):
// boots the casino on a refreshed copy of "prod" (VACUUM INTO + deploy/keep-staging-tables.js, done by the test) 11 minutes
// after the copy (room wheels are past rl_idle_close_mins), then does what staging routinely does: someone bets on every open
// wheel, the wheels spin, an admin switches roulette off. Prints one JSON line: every server seed staging's public
// /api/casino/fair/:id/:round would return for the given table ids, which of them staging loaded open, and the conservation total.
//   node test/fixtures/casino-rl-staging-boot.js <dir with myapp.db> <ids comma-separated> <prod clock ms>
"use strict";
const path = require("path");
const [dir, idsArg, nowArg] = process.argv.slice(2);
const repo = path.resolve(__dirname, "../..");
if (require.main !== module || !dir) return;        // (a fixture: loaded on its own it does nothing)
process.chdir(dir);
process.env.STAGING = "1";
const svc = require(path.join(repo, "casino/service"));
const veil = require(path.join(repo, "casino/veil"));
const { getQuery } = require(path.join(repo, "dbUtils"));
const held = require(path.join(repo, "supply")).casinoHeld;
require(path.join(repo, "casino/rewards")).hooks.updateLevel = async () => {};
const ids = idsArg.split(",");
let now = Number(nowArg) + 11 * 60000;
svc.S.hooks.now = () => now;
const total = async () =>
  (await getQuery("SELECT SUM(points_balance) AS n FROM users"))[0].n + (await held()) +
  (await getQuery("SELECT SUM(amount) AS n FROM jackpot_rakes"))[0].n;
(async () => {
  veil._hooks.kind = async () => null;
  await require(path.join(repo, "funding")).init();
  const before = await total();
  await svc.boot({ tick: false });
  const loaded = ids.filter((id) => svc.getTable(id)?.status === "open");
  await svc.tickOnce();
  const who = { uid: "d", name: "Playerd", username: "playerd", camfrog: "Frogd", via: "web", iph: null, admin: false, veil: null };
  const tables = [...svc.S.tables.values()].filter((T) => T.game === "roulette" && T.status === "open");
  for (const T of tables) await svc.act(who, "bet", ["red 100"], { table: T.id }, "stg-" + T.id);
  for (const ms of [26000, 9000, 6000]) { now += ms; await svc.tickOnce(); }
  await svc.setSetting("casino_roulette", "off", "staging-admin");
  for (let i = 0; i < 4; i++) { now += 1000; await svc.tickOnce(); }
  const revealed = [];
  for (const id of ids) {
    for (const r of await getQuery("SELECT round_no FROM casino_rounds WHERE table_id = ? ORDER BY round_no", [id])) {
      const rec = await svc.fairRecord(id, r.round_no);
      if (rec && rec.server_seed) revealed.push({ id, round: r.round_no, seed: rec.server_seed });
    }
  }
  const fresh = tables.filter((T) => !ids.includes(T.id)).map((T) => T.id);
  process.stdout.write(JSON.stringify({ loaded, revealed, fresh, before, after: await total(), held: await held() }) + "\n");
  svc.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
