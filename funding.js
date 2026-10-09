// funding.js — rewards the website pays are FUNDED, never minted (Pepe 1.63).
//
// Each reward belongs to a "payout flow" (levelup, new_account, connect_bonus, redeem_codes,
// platform_rewards, wheel_shortfall). Pepe's PAT Routing table says which vault pays each flow and
// syncs that here (POST /api/g/funding-sync) together with the Federal Reserve's balance, which
// lives in Pepe, not in this database.
//
//   casino jackpot -> paid here directly (a negative jackpot_rakes row)
//   Federal Reserve -> paid here and recorded as a reserve_claims row; Pepe settles the claims by
//                      draining his Reserve (GET /api/g/reserve-claims, POST .../settle)
//
// If the vault can't cover the reward it is SKIPPED: fundPayout() returns false and the caller
// carries on without paying.
//
// Economy v2 E-2 (Pepe's pepe_treasury.py, flag econ_treasury): while Pepe reports an incentive budget
// (sync body.incentives), the grant flows (welcome = new_account, levelup, achievements, and the "misc"
// group: connect_bonus, redeem_codes, platform_rewards) settle against it as "incentives:<flow>" claims,
// each group within its weekly budget (camfrog-bot docs/ECONOMY-V2.md 6.5). A grant paid through
// fundPayout / queueClaim that the budget can't cover right now is QUEUED instead of skipped: a claim row
// with queued = 1 (the user is not credited yet), paid FIFO per group by drainQueue() once a sync shows
// room (credited through ledger.post with a deterministic transaction id, so a crash mid-pay is
// recovered, never paid twice). takeFunds() callers (redeem codes, Discord/Twitch rewards) keep their
// refuse-when-short behaviour. Pepe only ever sees claims with queued = 0.
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");

const state = {
  reserve: null,          // Federal Reserve balance last synced from Pepe (null = never synced)
  syncedAt: 0,
  flows: {},              // flow -> "reserve" | "jackpot"
  // economy v2 E-1 (Pepe's pepe_layers.py): Fort Knox's balance while Pepe's layers are ON, else null.
  // Every sync sets it (a sync without it - an older Pepe, or the layers off - turns it back to null),
  // so the site books the Fort Knox half of a boost / slot fee as a "fortknox:<flow>" claim only while
  // the Pepe settling the claims credits those to Fort Knox (boosts.routeInTx).
  fortknox: null,
  // economy v2 E-2: the incentive budget while Pepe's treasury is live, else null (grants stay on the Reserve).
  // {balance, week, remaining: {group: PAT left this week}, budgets, groups: {flow: group}, share, release_per_day}
  incentives: null,
};
const INC = "incentives:";

let ready = runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (
    claimId TEXT PRIMARY KEY,
    flow TEXT NOT NULL,
    userId TEXT,
    type TEXT,
    amount INTEGER NOT NULL,
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    settled INTEGER DEFAULT 0
  )`).then(async () => {
    // E-2: queued grants. queued: 0 = paid to the user (Pepe settles it), 1 = waiting for budget,
    // 2 = being paid right now (crash recovery looks for its transaction), 9 = dropped (account gone)
    const cols = (await getQuery("SELECT name FROM pragma_table_info('reserve_claims')")).map((r) => r.name);
    if (!cols.includes("queued")) await runQuery("ALTER TABLE reserve_claims ADD COLUMN queued INTEGER DEFAULT 0");
    if (!cols.includes("paid_at")) await runQuery("ALTER TABLE reserve_claims ADD COLUMN paid_at INTEGER");
    await runQuery("CREATE INDEX IF NOT EXISTS reserve_claims_queue ON reserve_claims (queued, created)");
  }).catch((e) => console.error("[funding] table:", e));

const treasuryLive = () => state.incentives !== null;
const groupOf = (flow) => (state.incentives && state.incentives.groups && state.incentives.groups[flow]) || null;

function vaultFor(flow) {
  const v = state.flows[flow];
  if (v === "incentives" && treasuryLive() && groupOf(flow)) return "incentives";
  return v === "jackpot" ? "jackpot" : "reserve";
}

// PAT the website has paid out of the incentive budget that Pepe hasn't settled yet (all groups / one group)
async function unsettledIncentives(group) {
  await ready;
  const rows = await getQuery(`SELECT flow, COALESCE(SUM(amount),0) AS t FROM reserve_claims
                               WHERE settled = 0 AND COALESCE(queued,0) IN (0,2) AND flow LIKE 'incentives:%' GROUP BY flow`);
  let t = 0;
  for (const r of rows) if (!group || groupOf(r.flow.slice(INC.length)) === group) t += r.t || 0;
  return t;
}
async function queuedCount(group) {
  await ready;
  const rows = await getQuery("SELECT flow, COUNT(*) AS n FROM reserve_claims WHERE queued = 1 GROUP BY flow");
  let n = 0;
  for (const r of rows) if (!group || groupOf(String(r.flow).slice(INC.length)) === group) n += r.n;
  return n;
}
// Can the incentive budget pay `amount` for `flow` now? (headOfQueue: the queue drain asking for its own head)
async function canFundIncentives(flow, amount, headOfQueue) {
  const inc = state.incentives;
  if (!inc) return false;
  const g = groupOf(flow);
  if (!g) return false;
  if (!headOfQueue && (await queuedCount(g)) > 0) return false;        // FIFO: nobody jumps the group's queue
  const left = Number((inc.remaining || {})[g]) || 0;
  if (left - (await unsettledIncentives(g)) < amount) return false;     // the group's weekly budget
  return (Number(inc.balance) || 0) - (await unsettledIncentives()) >= amount;   // the budget's balance
}

async function unsettledReserve() {
  await ready;
  // E-2: the incentive budget's claims (and queued grants) aren't the Reserve's
  const r = await getQuery(`SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims
                            WHERE settled = 0 AND COALESCE(queued,0) = 0 AND flow NOT LIKE 'incentives:%'`);
  return (r[0] && r[0].t) || 0;
}

async function jackpotPot() {
  const r = await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes");
  return (r[0] && r[0].t) || 0;
}

// Can `flow`'s vault cover `amount` right now? (A Reserve that was never synced covers nothing.)
async function canFund(flow, amount) {
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return true;
  if (vaultFor(flow) === "jackpot") return (await jackpotPot()) >= amount;
  if (vaultFor(flow) === "incentives") return canFundIncentives(flow, amount, false);
  if (state.reserve === null) return false;
  return state.reserve - (await unsettledReserve()) >= amount;
}

// Take `amount` for `flow` out of its vault and record it. Does NOT credit the user - the caller
// does that (so it can keep its own transaction/bonus bookkeeping). Returns true when funded.
async function takeFunds(flow, amount, userId, type) {
  return (await takeFundsRef(flow, amount, userId, type)).ok;
}

// takeFunds() that also says how to put the money back ({ok, undo}) - for a credit that then fails.
async function takeFundsRef(flow, amount, userId, type) {
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return { ok: true, undo: async () => {} };
  if (!(await canFund(flow, amount))) {
    console.log(`[funding] ${flow}: ${vaultFor(flow)} can't cover ${amount} for ${userId} - skipped`);
    return { ok: false, undo: async () => {} };
  }
  const id = uuidv4();
  if (vaultFor(flow) === "jackpot") {
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                   [id, null, userId || null, -amount]);
    return { ok: true, undo: () => runQuery("DELETE FROM jackpot_rakes WHERE jackpotId = ?", [id]) };
  }
  const claimFlow = vaultFor(flow) === "incentives" ? INC + flow : flow;
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                 [id, claimFlow, userId || null, type || flow, amount]);
  return { ok: true, undo: () => runQuery("DELETE FROM reserve_claims WHERE claimId = ? AND settled = 0", [id]) };
}

// E-2: record a grant the incentive budget can't pay yet. The user is NOT credited now; drainQueue pays it.
async function queueClaim(userId, amount, flow, type) {
  await ready;
  amount = Math.floor(Number(amount) || 0);
  if (!userId || amount <= 0 || vaultFor(flow) !== "incentives") return null;
  const id = uuidv4();
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, queued) VALUES (?, ?, ?, ?, ?, 1)",
                 [id, INC + flow, String(userId), type || flow, amount]);
  console.log(`[funding] ${flow}: ${amount} for ${userId} queued (incentive budget) - ${id}`);
  setImmediate(() => drainQueue().catch((e) => console.error("[funding] drain:", e.message)));
  return id;
}

// Fund AND credit: the usual "pay this user a reward" path, with a logged transaction row.
// 1.99ga: the account must exist (ledger.post) - a payout to a deleted / merged-away account used to
// take the funds, credit nobody (0-row UPDATE) and still log a transaction row. Now it is followed to
// the account it was merged into (resolveMerged), else nothing is taken and false is returned.
// -> true (paid now), "queued" (E-2: owed - the incentive budget pays it later; truthy, so callers that
// only test truthiness treat it as handled and never retry it) or false (skipped).
async function fundPayout(userId, amount, flow, type) {
  const r = await fundPayoutEx(userId, amount, flow, type);
  return r.ok ? (r.queued ? "queued" : true) : false;
}

// fundPayout() that also says whether the grant was QUEUED (E-2: ok but not credited yet - it pays when the
// incentive budget can). -> {ok, queued, claimId?}
async function fundPayoutEx(userId, amount, flow, type) {
  amount = Math.floor(Number(amount) || 0);
  if (!userId || amount <= 0) return { ok: false, queued: false };
  const ledger = require("./ledger");
  const target = await ledger.resolveUserId(userId);
  if (!target) {
    console.warn(`[funding] ${flow}: ${amount} for missing account ${userId} - skipped (E_TARGET_NOT_FOUND)`);
    return { ok: false, queued: false };
  }
  const take = await takeFundsRef(flow, amount, target, type);
  if (!take.ok) {
    if (vaultFor(flow) === "incentives") {
      const claimId = await queueClaim(target, amount, flow, type);
      return { ok: !!claimId, queued: !!claimId, claimId };
    }
    return { ok: false, queued: false };
  }
  const r = await ledger.post(target, amount, type || flow, { resolveMerged: true, source: `funding:${flow}` });
  if (!r.ok) {
    try { await take.undo(); } catch (e) { console.error(`[funding] ${flow}: undo failed:`, e.message); }
    return { ok: false, queued: false };
  }
  return { ok: true, queued: false };
}

// E-2: pay queued grants, oldest first, each group strictly FIFO (a group stops at the first grant it
// can't cover; other groups carry on). One drain at a time.
let draining = null;
let drainAgain = false;
function drainQueue() {
  // a drain asked for while one runs (a fresh sync) runs again right after it, with the new numbers
  if (draining) { drainAgain = true; return draining.then(() => (draining ? draining : drainQueue())); }
  draining = (async () => {
    await ready;
    const ledger = require("./ledger");
    // crash recovery: a claim caught mid-pay is paid if its transaction exists, else it waits again
    for (const c of await getQuery("SELECT claimId FROM reserve_claims WHERE queued = 2")) {
      const tx = await getQuery("SELECT 1 FROM transactions WHERE transactionId = ?", ["iq-" + c.claimId]);
      await runQuery("UPDATE reserve_claims SET queued = ?, paid_at = COALESCE(paid_at, ?) WHERE claimId = ? AND queued = 2",
                     [tx.length ? 0 : 1, tx.length ? Date.now() : null, c.claimId]);
    }
    if (!treasuryLive()) return { paid: 0 };
    const blocked = new Set();
    let paid = 0;
    const rows = await getQuery("SELECT claimId, flow, userId, type, amount FROM reserve_claims WHERE queued = 1 ORDER BY created, rowid LIMIT 500");
    for (const c of rows) {
      const flow = String(c.flow).slice(INC.length);
      const g = groupOf(flow);
      if (!g || blocked.has(g)) continue;
      if (!(await canFundIncentives(flow, c.amount, true))) { blocked.add(g); continue; }
      const take = await runQuery("UPDATE reserve_claims SET queued = 2 WHERE claimId = ? AND queued = 1", [c.claimId]);
      if (!take || take.changes !== 1) continue;
      const r = await ledger.post(c.userId, c.amount, c.type || flow, { resolveMerged: true, transactionId: "iq-" + c.claimId,
                                                                       source: `funding:${flow} (queued)` });
      if (!r.ok) {
        await runQuery("UPDATE reserve_claims SET queued = 9 WHERE claimId = ?", [c.claimId]);
        console.warn(`[funding] queued ${flow} ${c.amount} for ${c.userId} dropped (${r.code})`);
        continue;
      }
      await runQuery("UPDATE reserve_claims SET queued = 0, paid_at = ? WHERE claimId = ?", [Date.now(), c.claimId]);
      paid++;
      try {
        await require("./inbox").addSafe(r.userId, { kind: "system", title: `Paid: PAT ${Number(c.amount).toLocaleString("en-US")}`,
          body: `${c.type || flow} - it waited for the weekly incentive budget and is in your wallet now.`, link: "/wallet",
          ref: `grantq:${c.claimId}` });
      } catch (e) { /* a notice never blocks a payment */ }
    }
    if (paid) console.log(`[funding] paid ${paid} queued grant(s) from the incentive budget`);
    return { paid };
  })().finally(() => {
    draining = null;
    if (drainAgain) { drainAgain = false; drainQueue().catch((e) => console.error("[funding] drain:", e.message)); }
  });
  return draining;
}

// The queue for the admin page: per group, and the oldest waiting grants.
async function queueSummary(limit = 25) {
  await ready;
  const rows = await getQuery("SELECT flow, COUNT(*) AS n, COALESCE(SUM(amount),0) AS t, MIN(created) AS oldest FROM reserve_claims WHERE queued = 1 GROUP BY flow");
  const groups = {};
  for (const r of rows) {
    const g = groupOf(String(r.flow).slice(INC.length)) || "other";
    const x = groups[g] || (groups[g] = { n: 0, t: 0, oldest: null });
    x.n += r.n; x.t += r.t;
    if (!x.oldest || r.oldest < x.oldest) x.oldest = r.oldest;
  }
  const items = await getQuery(`SELECT c.claimId, c.flow, c.type, c.amount, c.created, u.username FROM reserve_claims c
                                LEFT JOIN users u ON u.userId = c.userId WHERE c.queued = 1 ORDER BY c.created, c.rowid LIMIT ?`, [limit]);
  const unsettled = await unsettledIncentives().catch(() => 0);
  return { live: treasuryLive(), incentives: state.incentives, unsettled, groups, items };
}

function cleanIncentives(x) {
  if (!x || typeof x !== "object" || typeof x.balance !== "number" || !isFinite(x.balance)) return null;
  const num = (o) => {
    const out = {};
    for (const [k, v] of Object.entries(o && typeof o === "object" ? o : {})) {
      if (typeof v === "number" && isFinite(v)) out[String(k).slice(0, 32)] = Math.max(0, Math.floor(v));
    }
    return out;
  };
  const groups = {};
  for (const [k, v] of Object.entries(x.groups && typeof x.groups === "object" ? x.groups : {})) {
    if (typeof v === "string") groups[String(k).slice(0, 32)] = v.slice(0, 32);
  }
  return { balance: Math.max(0, Math.floor(x.balance)), week: String(x.week || "").slice(0, 16), remaining: num(x.remaining),
           budgets: num(x.budgets), groups, share: typeof x.share === "number" ? Math.floor(x.share) : null,
           release_per_day: typeof x.release_per_day === "number" ? Math.floor(x.release_per_day) : null };
}

function sync(body) {
  if (typeof body.reserve === "number" && isFinite(body.reserve)) state.reserve = Math.floor(body.reserve);
  if (body.flows && typeof body.flows === "object") {
    for (const [k, v] of Object.entries(body.flows)) {
      state.flows[k] = v === "jackpot" ? "jackpot" : v === "incentives" ? "incentives" : "reserve";
    }
  }
  state.fortknox = typeof body.fortknox === "number" && isFinite(body.fortknox) ? Math.max(0, Math.floor(body.fortknox)) : null;
  // E-2: every sync sets it - a sync without it (an older Pepe, the treasury off) puts the grants back on the Reserve
  state.incentives = cleanIncentives(body.incentives);
  state.syncedAt = Date.now();
  if (state.incentives) drainQueue().catch((e) => console.error("[funding] drain:", e.message));
}
const fortknoxLive = () => state.fortknox !== null;

async function claims() {
  await ready;
  // E-2: only claims the website has actually paid (queued = 0); a queued grant reaches Pepe once it's paid
  return getQuery("SELECT claimId, flow, type, amount, created FROM reserve_claims WHERE settled = 0 AND COALESCE(queued,0) = 0 ORDER BY created LIMIT 500");
}

async function settle(ids) {
  await ready;
  let n = 0;
  for (const id of (ids || []).slice(0, 500)) {
    const r = await runQuery("UPDATE reserve_claims SET settled = 1 WHERE claimId = ? AND settled = 0", [String(id)]);
    n += (r && r.changes) || 0;
  }
  return n;
}

module.exports = { fundPayout, fundPayoutEx, takeFunds, takeFundsRef, canFund, sync, claims, settle, state, fortknoxLive,
                   treasuryLive, vaultFor, queueClaim, drainQueue, queueSummary, groupOf };
