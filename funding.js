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
};

let ready = runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (
    claimId TEXT PRIMARY KEY,
    flow TEXT NOT NULL,
    userId TEXT,
    type TEXT,
    amount INTEGER NOT NULL,
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    settled INTEGER DEFAULT 0
  )`).catch((e) => console.error("[funding] table:", e));

function vaultFor(flow) {
  const v = state.flows[flow];
  return v === "jackpot" ? "jackpot" : "reserve";
}

async function unsettledReserve() {
  await ready;
  const r = await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims WHERE settled = 0");
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
  if (state.reserve === null) return false;
  return state.reserve - (await unsettledReserve()) >= amount;
}

// Take `amount` for `flow` out of its vault and record it. Does NOT credit the user - the caller
// does that (so it can keep its own transaction/bonus bookkeeping). Returns true when funded.
async function takeFunds(flow, amount, userId, type) {
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return true;
  if (!(await canFund(flow, amount))) {
    console.log(`[funding] ${flow}: ${vaultFor(flow)} can't cover ${amount} for ${userId} - skipped`);
    return false;
  }
  if (vaultFor(flow) === "jackpot") {
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                   [uuidv4(), null, userId || null, -amount]);
  } else {
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                   [uuidv4(), flow, userId || null, type || flow, amount]);
  }
  return true;
}

// Fund AND credit: the usual "pay this user a reward" path, with a logged transaction row.
async function fundPayout(userId, amount, flow, type) {
  amount = Math.floor(Number(amount) || 0);
  if (!userId || amount <= 0) return false;
  if (!(await takeFunds(flow, amount, userId, type))) return false;
  await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]);
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                 [uuidv4(), userId, type || flow, amount]);
  return true;
}

function sync(body) {
  if (typeof body.reserve === "number" && isFinite(body.reserve)) state.reserve = Math.floor(body.reserve);
  if (body.flows && typeof body.flows === "object") {
    for (const [k, v] of Object.entries(body.flows)) state.flows[k] = v === "jackpot" ? "jackpot" : "reserve";
  }
  state.fortknox = typeof body.fortknox === "number" && isFinite(body.fortknox) ? Math.max(0, Math.floor(body.fortknox)) : null;
  state.syncedAt = Date.now();
}
const fortknoxLive = () => state.fortknox !== null;

async function claims() {
  await ready;
  return getQuery("SELECT claimId, flow, type, amount, created FROM reserve_claims WHERE settled = 0 ORDER BY created LIMIT 500");
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

module.exports = { fundPayout, takeFunds, canFund, sync, claims, settle, state, fortknoxLive };
