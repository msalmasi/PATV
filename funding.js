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
//
// 1.99gq (the user's E-2 decisions, 2026-10-09; Pepe's routing `v2` defaults while his econ_layers is on):
//   * pad owner royalties (room_owner) settle against the incentive budget too - group "royalties", and the
//     sync carries the budget whenever Pepe's layers are on (incentives.treasury = false while only the layers
//     are on: then the E-2 grants stay on the Reserve, only room_owner is routed to "incentives").
//     royalties.js asks fundable() first and releases at most what the group can pay now (the rest waits).
//   * the wheel shortfall is backstopped by the HOUSE: Pepe routes "wheel_shortfall" to "jackpot". The wheel's
//     pot and the House are the same money (jackpot_rakes), so wheelDraw() pays a prize from the House up to
//     its whole balance and refuses only what the House can't cover - never a Reserve claim; wheelReseed()
//     doesn't top the pot back up to its 100k floor (that would move House money into the House).
//
// Economy v2 E-3 (Pepe's pepe_roomvault.py, flag econ_room_vaults): while Pepe reports room vaults live (sync body
// room_vaults = {on, cap}), boosts.routeInTx books the ROOM half of a boost / slot fee / pad cosmetic / challenge fee
// as a "room:<flow>:<room id>" claim (negative: the site collected it) that Pepe credits to that pad's vault. Those
// claims are neither the Reserve's nor the incentive budget's.
//
// 1.99jw (Economy v3, PAT monetary policy - "the Reserve only funds the protocol"):
//   * every sync carries Pepe's `monetary` policy (state.monetary, null when absent): flash-liquidity switches, the
//     Fed loan room, the House hard floor, the donation rate, the weekly staff-grant cap and the budget week.
//   * a flow Pepe routes to "incentives" never falls back to the Reserve (vaultFor): with no budget synced it is
//     refused / queued until one is.
//   * the staff PAT grant is paid by the incentive budget (takeIncentivesRef, claim "incentives:staff_grant").
//   * House flash liquidity (houseFlashCover): while the House is houseBacked and monetary.flash.house is on, a House
//     payout that would take it below its hard floor is paid in full and the gap is a "flash:house:<flow>" claim
//     (Pepe opens a Fed flash loan to the House for it), within the Fed loan room net of unsettled flash claims.
//   * "mint:donation" claims (Stripe donations, stripebilling.js) are mints Pepe journals - not the Reserve's money,
//     so unsettledReserve() leaves "mint:%" out; "flash:%" and "house_adjust" are the Reserve's.
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
  // economy v2 E-3: {on: true, cap} while Pepe's room vaults are live, else null (room halves stay in the site escrow)
  room_vaults: null,
  // the pad launchpad: Pepe's {on, live, room_vaults, cfg, budget, spendable, matched, paid} (launchpad.cleanState), else null
  launchpad: null,
  // 1.99jw: Pepe's monetary policy (cleanMonetary), else null. Every sync sets it.
  monetary: null,
  // 1.99ne: when the state above was restored from funding_state at start (0 = it came from a live sync)
  restoredAt: 0,
};
const INC = "incentives:";
const DONATION_RATE = 500000;          // 1.99jw: PAT per $1 while Pepe never synced a rate
const DONATION_BONUS_PCT = 20;         // 1.99jw: % extra minted into the incentive budget
const HOUSE_HARD_FLOOR = 5000000;

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
    // 1.99jw: free-form JSON for Pepe (a donation mint's {bonus, usd_cents, rate, bonus_pct, event}, a flash claim's ref)
    if (!cols.includes("meta")) await runQuery("ALTER TABLE reserve_claims ADD COLUMN meta TEXT");
    await runQuery("CREATE INDEX IF NOT EXISTS reserve_claims_queue ON reserve_claims (queued, created)");
    // 1.99ne: the last sync survives a site restart (restored below while Pepe hasn't synced since the start)
    await runQuery("CREATE TABLE IF NOT EXISTS funding_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER)");
    await restore();
  }).catch((e) => console.error("[funding] table:", e));

// ── 1.99ne: the synced state is persisted ──
// Everything above lived only in memory, so a site restart (every deploy) while Pepe was down - or until his next
// 30 s sync - ran the economy on the "never synced" defaults: fortknoxLive() / roomVaultsLive() false (boosts.routeInTx
// booked the Fort Knox half as a plain Reserve claim and kept the room half in the site escrow), flash liquidity off,
// the launchpad off, Reserve-routed grants refused. Now every sync is saved (funding_state 'last_sync') and a start
// restores it until Pepe's next sync replaces it: exactly the state a site that never restarted would still hold
// (nothing in it expires while Pepe is away either). state.syncedAt keeps the ORIGINAL sync time, so "Reserve not
// synced for 30 min" alerts still fire; state.restoredAt says it came from the database.
const PERSIST_KEYS = ["reserve", "syncedAt", "flows", "fortknox", "incentives", "room_vaults", "launchpad", "monetary"];
let persistChain = Promise.resolve();
function persist() {
  const snap = {};
  for (const k of PERSIST_KEYS) snap[k] = state[k];
  const text = JSON.stringify(snap);
  // in order: a slow write never lands after a newer one
  persistChain = persistChain.then(() => ready).then(() => runQuery(`INSERT INTO funding_state (key, value, updated) VALUES ('last_sync', ?, ?)
                                                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`,
                                                   [text, Date.now()]))
    .catch((e) => console.error("[funding] couldn't save the synced state:", e.message));
  return persistChain;
}
async function restore() {
  if (state.syncedAt) return false;                 // Pepe already synced since this start: his state wins
  const row = (await getQuery("SELECT value, updated FROM funding_state WHERE key = 'last_sync'"))[0];
  if (!row) return false;
  let snap;
  try { snap = JSON.parse(row.value); } catch (e) { console.error("[funding] saved state unreadable - not restored"); return false; }
  if (!snap || typeof snap !== "object" || state.syncedAt) return false;
  for (const k of PERSIST_KEYS) {
    if (!(k in snap)) continue;
    if (k === "flows") state.flows = snap.flows && typeof snap.flows === "object" ? { ...snap.flows } : {};
    else if (k === "reserve") state.reserve = typeof snap.reserve === "number" && isFinite(snap.reserve) ? Math.floor(snap.reserve) : null;
    else if (k === "syncedAt") state.syncedAt = Number(snap.syncedAt) || 0;
    else state[k] = snap[k] === undefined ? null : snap[k];
  }
  state.restoredAt = Date.now();
  console.log(`[funding] restored Pepe's last sync (${new Date(state.syncedAt || row.updated).toISOString()}): fortknox ${state.fortknox !== null ? "live" : "off"}, ` +
              `room vaults ${state.room_vaults ? "live" : "off"}, flash.house ${state.monetary && state.monetary.flash ? state.monetary.flash.house : "-"}, ` +
              `incentives ${state.incentives ? "live" : "off"}, ${Object.keys(state.flows).length} flows`);
  return true;
}

// the budget is reported (routing / queue); treasuryOn = the E-2 Treasury itself is live (display)
const treasuryLive = () => state.incentives !== null;
const treasuryOn = () => treasuryLive() && state.incentives.treasury !== false;
const groupOf = (flow) => (state.incentives && state.incentives.groups && state.incentives.groups[flow]) || null;

function vaultFor(flow) {
  const v = state.flows[flow];
  // 1.99jw: routed to the incentive budget = the incentive budget, even while its state is missing (a sync hiccup, an
  // older Pepe): canFund / fundable / takeFunds then refuse and fundPayout queues it - never a Reserve claim, which Pepe
  // would settle out of the Fed ("the Reserve only funds the protocol").
  if (v === "incentives") return "incentives";
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
  // E-2: the incentive budget's claims (and queued grants) aren't the Reserve's; 1.99jw: nor are mints ("mint:%" nets to
  // zero for the Fed - Pepe journals it and it never leaves the Reserve). Flash claims and house_adjust are the Reserve's.
  const r = await getQuery(`SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims
                            WHERE settled = 0 AND COALESCE(queued,0) = 0 AND flow NOT LIKE 'incentives:%' AND flow NOT LIKE 'room:%'
                              AND flow NOT LIKE 'mint:%'`);
  return (r[0] && r[0].t) || 0;
}

// 1.99ns Phase 1: once the pools live on the site (pools.js) the Reserve's balance is read from its table - fresh, and
// still known after a site restart while Pepe is away (audit 3.1) - instead of Pepe's last sync. null = unknown.
async function reserveNow() {
  try {
    const P = require("./pools");
    if (await P.live()) return await P.balance("reserve");
  } catch (e) { /* no pools tables yet */ }
  return state.reserve;
}

async function jackpotPot() {
  const r = await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes");
  return (r[0] && r[0].t) || 0;
}

// 1.99gq: how much `flow` could be paid right now (incentive flows: what its group and the budget can cover,
// 0 while the group has a queue; the House: its balance; the Reserve: its balance net of unsettled claims)
async function fundable(flow) {
  const v = vaultFor(flow);
  if (v === "jackpot") return Math.max(0, await jackpotPot());
  if (v === "incentives") {
    const inc = state.incentives;
    const g = groupOf(flow);
    if (!inc || !g || (await queuedCount(g)) > 0) return 0;
    const left = (Number((inc.remaining || {})[g]) || 0) - (await unsettledIncentives(g));
    const bal = (Number(inc.balance) || 0) - (await unsettledIncentives());
    return Math.max(0, Math.floor(Math.min(left, bal)));
  }
  const rv = await reserveNow();
  if (rv === null) return 0;
  return Math.max(0, rv - (await unsettledReserve()));
}

// 1.99gq: is the wheel shortfall backstopped by the House (Pepe's economy v2 layers) instead of the Reserve?
const houseBacked = () => vaultFor("wheel_shortfall") === "jackpot";

// Pay a wheel prize out of the House (the casino pot). -> {paid, fromHouse, short, refused, backstop}
// v1: what the pot can't cover is a "wheel_shortfall" claim on the Reserve (or refused if it can't cover it).
// v2 (houseBacked): the pot IS the House, so the prize is drawn from the House up to its whole balance and only
// what the House can't cover is refused - nothing is drawn from the Reserve. Never minted either way.
async function wheelDraw(payout, spinId, userId) {
  payout = Math.max(0, Math.floor(Number(payout) || 0));
  const out = { paid: 0, fromHouse: 0, short: 0, refused: 0, backstop: houseBacked() ? "house" : "reserve", flash: 0 };
  if (!payout) return out;
  // 1.99jw: House flash liquidity - a prize that would take the House below its hard floor is paid in full; the Fed
  // lends the House the gap (a flash:house:wheel claim). Off / no room: exactly as before.
  const fl = await houseFlashCover("wheel", payout, userId, "wheel prize", spinId ? "spin:" + spinId : null);
  if (fl.used) {
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                   [uuidv4(), spinId || null, userId || null, -payout]);
    Object.assign(out, { paid: payout, fromHouse: payout - fl.gap, flash: fl.gap });
    return out;
  }
  const fromPot = Math.min(payout, Math.max(0, await jackpotPot()));
  if (fromPot > 0) {
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                   [uuidv4(), spinId || null, userId || null, -fromPot]);
  }
  out.fromHouse = fromPot;
  out.short = payout - fromPot;
  if (out.short <= 0) { out.paid = payout; return out; }
  if (out.backstop === "house") {
    out.refused = out.short;                     // the House is empty: nothing else may pay it
    out.paid = fromPot;
    console.log(`[funding] wheel_shortfall: the House can't cover ${out.short} of a ${payout} prize (spin ${spinId}) - refused`);
    return out;
  }
  const ok = await takeFunds("wheel_shortfall", out.short, userId, "wheel prize shortfall");
  out.refused = ok ? 0 : out.short;
  out.paid = ok ? payout : fromPot;
  return out;
}

// 1.99jw: PAT the site booked as House flash liquidity that Pepe hasn't settled (turned into Fed loans) yet
async function unsettledFlash() {
  await ready;
  const r = await getQuery(`SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims
                            WHERE settled = 0 AND COALESCE(queued,0) = 0 AND flow LIKE 'flash:%'`);
  return (r[0] && r[0].t) || 0;
}

// 1.99jw: would a House payout of `payout` need the Fed's flash liquidity, and can it have it? -> {need, gap, room, reason}
//   need = the House can't pay it without dropping below monetary.house_hard_floor; gap = payout - max(0, House - floor)
//   (never more than the payout); ok = it may be booked (houseBacked, flash.house on, gap within the Fed loan room net of
//   unsettled flash claims). `house` = the House balance BEFORE this payout (defaults to the pot now).
async function houseFlashPlan(payout, house) {
  payout = Math.max(0, Math.floor(Number(payout) || 0));
  const m = state.monetary;
  if (!payout || !m || !m.flash || m.flash.house !== true || !houseBacked()) return { ok: false, need: false, gap: 0, reason: "off" };
  const h = house === undefined ? await jackpotPot() : Math.floor(Number(house) || 0);
  const above = Math.max(0, h - m.house_hard_floor);
  if (payout <= above) return { ok: false, need: false, gap: 0, reason: "covered" };
  const gap = Math.min(payout, payout - above);
  const room = m.fedloan_room - (await unsettledFlash());
  if (gap > room) return { ok: false, need: true, gap, room, house: h, reason: "room" };
  return { ok: true, need: true, gap, room, house: h, reason: "flash" };
}

// 1.99jw: book the House flash liquidity for a payout the caller is about to make out of the House (the caller writes
// the -payout jackpot_rakes row itself). -> {used, gap, reason}; used = a "flash:house:<flow>" claim of `gap` was booked
// (Pepe opens a Fed flash loan of `gap` to the House). Logged either way when the House was short.
async function houseFlashCover(flow, payout, userId, type, ref) {
  await ready;
  const p = await houseFlashPlan(payout);
  if (!p.need) return { used: false, gap: 0, reason: p.reason };
  if (!p.ok) {
    console.log(`[funding] flash:house:${flow}: ${payout} would take the House (${p.house}) below its hard floor; gap ${p.gap} > Fed loan room ${p.room} - no flash`);
    return { used: false, gap: p.gap, reason: p.reason };
  }
  const id = uuidv4();
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES (?, ?, ?, ?, ?, ?)",
                 [id, "flash:house:" + flow, userId || null, type || flow, p.gap,
                  JSON.stringify({ payout: Math.floor(Number(payout) || 0), house: p.house, floor: state.monetary.house_hard_floor, ref: ref || null })]);
  console.log(`[funding] flash:house:${flow}: paid ${payout} in full; the House (${p.house}) is short of its hard floor by ${p.gap} - Fed flash liquidity claim ${id}`);
  return { used: true, gap: p.gap, claimId: id, reason: "flash" };
}

// Top the wheel's pot back up to `floor` after a jackpot win. v1: from the Reserve (a "wheel_shortfall" claim).
// v2 (houseBacked): the pot is the House - a top-up from the House into the House moves nothing, so none is made.
async function wheelReseed(spinId, userId, floor) {
  const left = await jackpotPot();
  if (left >= floor) return 0;
  if (houseBacked()) return 0;
  const amt = floor - left;
  if (!(await takeFunds("wheel_shortfall", amt, userId, "wheel jackpot reseed"))) return 0;
  // the reseed comes from the Reserve (a claim Pepe settles), not from nowhere
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                 [uuidv4(), spinId || null, userId || null, amt]);
  return amt;
}

// Can `flow`'s vault cover `amount` right now? (A Reserve that was never synced covers nothing.)
async function canFund(flow, amount) {
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return true;
  if (vaultFor(flow) === "jackpot") return (await jackpotPot()) >= amount;
  if (vaultFor(flow) === "incentives") return canFundIncentives(flow, amount, false);
  const rv = await reserveNow();
  if (rv === null) return false;
  return rv - (await unsettledReserve()) >= amount;
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
                   [id, "fund:" + flow, userId || null, -amount]);     // 1.99gx: tagged (jackpotflows.js)
    return { ok: true, undo: () => runQuery("DELETE FROM jackpot_rakes WHERE jackpotId = ?", [id]) };
  }
  const claimFlow = vaultFor(flow) === "incentives" ? INC + flow : flow;
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                 [id, claimFlow, userId || null, type || flow, amount]);
  return { ok: true, undo: () => runQuery("DELETE FROM reserve_claims WHERE claimId = ? AND settled = 0", [id]) };
}

// 1.99jt: what the Federal Reserve could pay right now (its synced balance net of unsettled claims), or null
// when Pepe has never synced it.
async function reserveAvailable() {
  const rv = await reserveNow();
  if (rv === null) return null;
  return Math.max(0, rv - (await unsettledReserve()));
}

// 1.99jt: a Reserve claim for `flow` that ignores the PAT Routing table (the staff PAT grant is ALWAYS the
// Reserve's). amount > 0 = paid out of the Reserve (refused when it can't cover it); amount < 0 = collected for it
// (Pepe credits the Reserve). Does NOT move the user's balance. -> {ok, available, undo}
async function takeReserveRef(flow, amount, userId, type) {
  await ready;
  amount = Math.trunc(Number(amount) || 0);
  const none = async () => {};
  if (amount === 0) return { ok: true, undo: none };
  const available = await reserveAvailable();
  if (amount > 0 && (available === null || available < amount)) return { ok: false, available, undo: none };
  const id = uuidv4();
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                 [id, flow, userId || null, type || flow, amount]);
  return { ok: true, available, claimId: id, undo: () => runQuery("DELETE FROM reserve_claims WHERE claimId = ? AND settled = 0", [id]) };
}

// 1.99jw: the staff PAT grant's claim on the INCENTIVE BUDGET ("incentives:<flow>"), outside every weekly group budget.
// amount > 0 = paid out of the budget: refused while the budget isn't known (reason "unknown"), when its balance net of
// unsettled incentive claims can't cover it ("short"), or when monetary.grant_weekly_cap >= 0 and this budget week's
// positive claims for the flow + amount would pass it ("cap"). amount < 0 = returned to the budget (always booked).
// Never queued. Does NOT move the user's balance. -> {ok, available, reason, cap?, used?, claimId?, undo}
async function takeIncentivesRef(flow, amount, userId, type) {
  await ready;
  amount = Math.trunc(Number(amount) || 0);
  const none = async () => {};
  const claimFlow = INC + flow;
  const inc = state.incentives;
  const available = inc ? Math.max(0, (Number(inc.balance) || 0) - (await unsettledIncentives())) : null;
  if (amount === 0) return { ok: true, available, undo: none };
  if (amount > 0) {
    if (!inc) return { ok: false, available: null, reason: "unknown", undo: none };
    if (available < amount) return { ok: false, available, reason: "short", undo: none };
    const m = state.monetary;
    const cap = m && Number.isFinite(m.grant_weekly_cap) ? m.grant_weekly_cap : -1;
    if (cap >= 0) {
      const since = m.week_start || 0;
      const r = await getQuery(`SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims
                                WHERE flow = ? AND amount > 0 AND created >= datetime(?, 'unixepoch')`, [claimFlow, since]);
      const used = (r[0] && r[0].t) || 0;
      if (used + amount > cap) return { ok: false, available, reason: "cap", cap, used, undo: none };
    }
  }
  const id = uuidv4();
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                 [id, claimFlow, userId || null, type || flow, amount]);
  return { ok: true, available, claimId: id, undo: () => runQuery("DELETE FROM reserve_claims WHERE claimId = ? AND settled = 0", [id]) };
}

// 1.99jw: the donation terms Pepe synced (or the defaults while he never has)
function donationTerms() {
  const d = state.monetary && state.monetary.donation;
  return { rate: d ? d.rate : DONATION_RATE, bonus_pct: d ? d.bonus_pct : DONATION_BONUS_PCT };
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
           treasury: x.treasury !== false,           // 1.99gq: false = only Pepe's layers are on (royalties use it)
           budgets: num(x.budgets), groups, share: typeof x.share === "number" ? Math.floor(x.share) : null,
           release_per_day: typeof x.release_per_day === "number" ? Math.floor(x.release_per_day) : null };
}

// 1.99jw: Pepe's monetary policy from the sync. Anything that isn't an object -> null; missing / bad fields -> defaults.
function cleanMonetary(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const int = (v, dflt) => { const n = Number(v); return v !== null && v !== "" && typeof v !== "boolean" && Number.isFinite(n) ? Math.floor(n) : dflt; };
  const f = x.flash && typeof x.flash === "object" ? x.flash : {};
  const sw = (v) => (typeof v === "boolean" ? v : true);          // default: on
  const d = x.donation && typeof x.donation === "object" ? x.donation : {};
  const pct = Number(d.bonus_pct);
  const b = x.band && typeof x.band === "object" ? x.band : null;
  const cap = int(x.grant_weekly_cap, -1);
  return {
    flash: { house: sw(f.house), bank: sw(f.bank), mm: sw(f.mm) },
    fedloan_room: Math.max(0, int(x.fedloan_room, 0)),
    house_hard_floor: Math.max(0, int(x.house_hard_floor, HOUSE_HARD_FLOOR)),
    donation: { rate: Math.max(0, int(d.rate, DONATION_RATE)),
                bonus_pct: typeof d.bonus_pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(1000, pct)) : DONATION_BONUS_PCT },
    grant_weekly_cap: cap < 0 ? -1 : cap,
    week_start: Math.max(0, int(x.week_start, 0)),
    band: b ? { fed: int(b.fed, null), floor: int(b.floor, null), ceiling: int(b.ceiling, null) } : null,
  };
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
  // 1.99jw: every sync sets it - a sync without it (an older Pepe) turns flash liquidity off and the defaults back on
  state.monetary = cleanMonetary(body.monetary);
  // the pad launchpad (launchpad.js / Pepe's pepe_launchpad.py): every sync sets it - null = off (no welcomes, no
  // launch progress, no boost credit)
  try { state.launchpad = require("./launchpad").cleanState(body.launchpad); } catch (e) { state.launchpad = null; }
  // E-3: every sync sets it - a sync without it (an older Pepe, room vaults off) keeps the room halves in the escrow
  const rv = body.room_vaults;
  state.room_vaults = rv && typeof rv === "object" && rv.on === true
    ? { on: true, cap: Number.isFinite(Number(rv.cap)) ? Math.max(0, Math.floor(Number(rv.cap))) : null } : null;
  state.syncedAt = Date.now();
  state.restoredAt = 0;
  persist();                                         // 1.99ne: survives a site restart (restore())
  if (state.incentives) drainQueue().catch((e) => console.error("[funding] drain:", e.message));
}
const fortknoxLive = () => state.fortknox !== null;
const roomVaultsLive = () => state.room_vaults !== null;

async function claims() {
  await ready;
  // E-2: only claims the website has actually paid (queued = 0); a queued grant reaches Pepe once it's paid
  // 1.99jw: + userId, username (Pepe names the member in his journal) and meta (JSON text, e.g. a donation's terms)
  try {
    return await getQuery(`SELECT c.claimId, c.flow, c.type, c.amount, c.created, c.userId, u.username, c.meta FROM reserve_claims c
                           LEFT JOIN users u ON u.userId = c.userId
                           WHERE c.settled = 0 AND COALESCE(c.queued,0) = 0 ORDER BY c.created, c.rowid LIMIT 500`);
  } catch (e) {        // no users table (a bare test database)
    return getQuery(`SELECT claimId, flow, type, amount, created, userId, NULL AS username, meta FROM reserve_claims
                     WHERE settled = 0 AND COALESCE(queued,0) = 0 ORDER BY created, rowid LIMIT 500`);
  }
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

module.exports = { fundPayout, fundPayoutEx, takeFunds, takeFundsRef, canFund, sync, claims, settle, state, fortknoxLive, roomVaultsLive,
                   treasuryLive, treasuryOn, vaultFor, queueClaim, drainQueue, queueSummary, groupOf, fundable, unsettledIncentives,
                   houseBacked, wheelDraw, wheelReseed, reserveAvailable, takeReserveRef,
                   // 1.99jw
                   init: () => ready, cleanMonetary, takeIncentivesRef, houseFlashPlan, houseFlashCover, unsettledFlash, unsettledReserve,
                   donationTerms, jackpotPot,
                   // 1.99ne
                   persist, restore, _persisted: () => persistChain,
                   // 1.99ns
                   reserveNow };
