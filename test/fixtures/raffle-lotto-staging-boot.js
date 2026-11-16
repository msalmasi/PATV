// roulette2 WP7 (FAIR-1 for raffles and the lotto) - test/raffle-lotto-staging.test.js's STAGING side, in its own process (dbUtils opens
// ./myapp.db): boots raffles (raffles.js register - what index.js does) and the lotto (lotto/service.js boot - what lotto/routes.js does) on a
// refreshed copy of "prod" (VACUUM INTO + deploy/keep-staging-tables.js, done by the test) 11 minutes after the copy, runs their clocks
// (raffles' tick, the lotto's tick) past a few minutes, and tries to buy tickets in every copied raffle and draw one. Then it boots AGAIN (a
// restart: the retire must be idempotent). Prints one JSON line: the copied raffles' and lotto draws' rows, the seeds revealed (raffle
// detail / the lotto's fair record), every raffle_events / lotto_events row and inbox notice written, what the tries answered, and the
// conservation total (wallets + House + escrow holds + the lotto pot + the pools) before, after the first boot and after the second, with
// the balances and the transactions count.
//   node test/fixtures/raffle-lotto-staging-boot.js <dir with myapp.db> <raffle ids comma-separated> <lotto draw> <prod clock ms>
"use strict";
const path = require("path");
const [dir, idsArg, drawArg, nowArg] = process.argv.slice(2);
const repo = path.resolve(__dirname, "../..");
if (require.main !== module || !dir) return;        // (a fixture: loaded on its own it does nothing)
process.chdir(dir);
process.env.STAGING = "1";
process.env.RAFFLES_NO_TIMER = "1";
const { getQuery } = require(path.join(repo, "dbUtils"));
const RF = require(path.join(repo, "raffles"));
const LS = require(path.join(repo, "lotto/service"));
const ids = idsArg.split(",").filter(Boolean).map(Number);
const draw = Number(drawArg);
let now = Number(nowArg) + 11 * 60000;
RF._setClock(() => now);
LS._S.hooks.now = () => now;
LS._S.hooks.updateLevel = async () => {};
const one = async (sql, args) => { try { return Number((await getQuery(sql, args || []))[0].n) || 0; } catch (e) { return 0; } };
const total = async () =>
  (await one("SELECT COALESCE(SUM(points_balance), 0) AS n FROM users")) + (await one("SELECT COALESCE(SUM(amount), 0) AS n FROM jackpot_rakes")) +
  (await one("SELECT COALESCE(SUM(amount), 0) AS n FROM escrow_holds WHERE state = 'held'")) + (await one("SELECT COALESCE(SUM(amount), 0) AS n FROM lotto_pot")) +
  (await one("SELECT COALESCE(SUM(balance), 0) AS n FROM pools"));
const inList = (list) => list.map(() => "?").join(",") || "''";
const balances = async () => Object.fromEntries((await getQuery("SELECT userId, points_balance FROM users ORDER BY userId")).map((r) => [r.userId, r.points_balance]));
const raffles = async () => Object.fromEntries((await getQuery(`SELECT id, status, server_seed, tickets_digest, close_reason, winning_no FROM raffles WHERE id IN (${inList(ids)})`, ids))
  .map((r) => [r.id, { status: r.status, seed: r.server_seed, digest: r.tickets_digest, reason: r.close_reason, winning_no: r.winning_no }]));
const draws = async () => (await getQuery("SELECT draw, state, server_seed, commitment, flags, white, next_at FROM lotto_draws ORDER BY draw"))
  .map((d) => ({ draw: d.draw, state: d.state, seed: d.server_seed, commitment: d.commitment, flags: JSON.parse(d.flags || "{}"), white: d.white, next_at: d.next_at }));
let app = null;
function boot() {
  // raffles.js register: what index.js calls at the site's start (its boot retires the copies); the lotto's boot (lotto/routes.js)
  const express = require(require.resolve("express", { paths: [repo] }));
  app = express();
  RF.register(app, { isBotToken: () => false, addUser: (req, res, next) => next(), noTimers: true });
  return LS.boot({ tick: false });
}

(async () => {
  await require(path.join(repo, "funding")).init();
  const before = await total();
  const ev0 = await one("SELECT COALESCE(MAX(id), 0) AS n FROM raffle_events");
  const lev0 = await one("SELECT COALESCE(MAX(seq), 0) AS n FROM lotto_events");
  const inbox0 = await one("SELECT COUNT(*) AS n FROM inbox");
  await boot();
  // raffles' boot retires the copies on its own (register: init, then retireCopies) - waited for here, not called
  let bootRetired = false;
  for (let i = 0; i < 200 && !bootRetired; i++) {
    bootRetired = !(await one("SELECT COUNT(*) AS n FROM raffles WHERE status = 'open' AND server_seed = ''"));
    if (!bootRetired) await new Promise((r) => setTimeout(r, 20));
  }
  await RF.retireCopies();                          // (the boot's own run, if still in flight - or a second one that finds nothing)
  const raffles0 = await raffles();
  const draws0 = await draws();
  // staging's routine: the clocks run, people try to buy into every copied raffle (and to draw one)
  for (let i = 0; i < 8; i++) { now += 61000; await RF.tick(); await LS.tick(); }
  const tries = {};
  let k = 0;
  for (const id of ids) {
    const out = [];
    for (const uid of ["u_ann", "u_bob", "u_cat"]) {
      const r = await RF.buy(uid, { id, qty: 1, idem: "stgbuy" + String(++k).padStart(6, "0"), via: "web" }).then((x) => ({ ok: !!x.ok }), (e) => ({ ok: false, code: e.code || e.message }));
      out.push(r);
    }
    const d = await RF.draw(id).catch((e) => ({ error: e.message }));
    tries[id] = { buys: out, draw: d };
  }
  for (let i = 0; i < 4; i++) { now += 61000; await RF.tick(); await LS.tick(); }
  const after = await total();
  const tx1 = await one("SELECT COUNT(*) AS n FROM transactions");
  const bal1 = await balances();
  const raffles1 = await raffles();
  const draws1 = await draws();
  // a restart: nothing is refunded twice, nothing reopens
  LS.stop();
  now += 60000;
  await boot();
  await RF.retireCopies();
  for (let i = 0; i < 3; i++) { now += 61000; await RF.tick(); await LS.tick(); }
  const after2 = await total();
  const tx2 = await one("SELECT COUNT(*) AS n FROM transactions");
  const bal2 = await balances();
  const revealed = {};
  for (const id of ids) { const v = await RF.detail(id); revealed[id] = { seed: v && v.server_seed !== undefined ? v.server_seed : null, tickets: v ? v.tickets : null }; }
  const fair = await LS.fairRecord(draw);
  const events = (await getQuery(`SELECT raffle_id, kind FROM raffle_events WHERE id > ? AND raffle_id IN (${inList(ids)})`, [ev0].concat(ids))).map((r) => `R${r.raffle_id}:${r.kind}`);
  const lotto = (await getQuery("SELECT kind, data FROM lotto_events WHERE seq > ? ORDER BY seq", [lev0])).map((r) => ({ kind: r.kind, draw: JSON.parse(r.data).draw }));
  const inbox = (await one("SELECT COUNT(*) AS n FROM inbox")) - inbox0;
  const refundKeys = (await getQuery("SELECT transactionId FROM transactions WHERE transactionId LIKE '%:refund'")).map((r) => r.transactionId);
  process.stdout.write(JSON.stringify({ bootRetired, raffles0, raffles1, raffles2: await raffles(), draws0, draws1, draws2: await draws(), tries, before, after, after2, tx1, tx2,
                                        bal1, bal2, revealed, fair, events, lotto, inbox, refundKeys,
                                        held: await one("SELECT COALESCE(SUM(amount), 0) AS n FROM escrow_holds WHERE state = 'held'"),
                                        info: await LS.info(null) }) + "\n");
  LS.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
