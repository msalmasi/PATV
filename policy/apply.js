// policy/apply.js — Phase 4: running an engine's period for real (mode "live"), each in ONE dbUtils.tx.
//
//   runTreasuryEpoch   pepe_treasury._tr_run + _tr_redeem_remote + _tr_finish: plan, the bank-lent sample, the protocol's
//                      shares redeemed on the capital share book (capital_ops key "vaults:proto-wf-<epoch>-<vault>" - the
//                      key Pepe's own booking uses), then every leg (stakers' stashes, Fed loans first, the Fed, incentives)
//   runTreasuryDaily   pepe_treasury._tr_daily + _tr_daily_finish: overflows (Fed loans first), the floors
//   runMonetary        pepe_monetary._mo_daily + _mo_daily_finish + the activity payouts: the Fed's floor / issuance mints
//                      (journaled, capped), the guarantee, the ceiling release (to the burn reserve or incentives), then the
//                      day's activity rewards to its active players (one savepoint each)
//   runBurn            pepe_burn's accrual: the burn reserve, burned (pool move kind "burn", a pat_burns row)
// Every leg uses the key Pepe's own leg uses (pools.js "<tid>:out" / "<tid>:in", the stash move key, the mint's
// "fedmint-<key>:in"): if Pepe ever ran the same period, the second one is a no-op leg by leg. The run's done-key
// (policy_runs "<engine>:<period>") is checked and written in the same transaction, so a period never runs twice.
// The whole run commits or none of it does (an unexpected refusal rolls it back; the scheduler retries the period).
// What Pepe must mirror into his own books (the epoch / day records, Fed loan repayments, mint records, budget spends, the
// bank-lent samples, cap notices, burns) is written as policy_effects in the same transaction.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("../dbUtils");
const P = require("../pools");
const C = require("./core");
const E = require("./engines");
const G = require("./gather");
const { pyRoundN } = require("./pymath");

const FED_MINT_TAG = "fed-mint";
class Halt extends Error { constructor(msg, code) { super(msg); this.code = code || "E_HALT"; } }

// ── the conservation base: every protocol pool + the House + the stashes (pepe_treasury._tr_conservation_base) ──
async function base() {
  const pools = (await P.total()).amount;
  const house = await require("../capital/core").houseBalance();
  let st = 0;
  try { st = (await require("../stashes").total()).amount || 0; } catch (e) { st = 0; }
  return pools + house + st;
}

// ── legs (inside the open transaction) ──
async function poolLeg(key, pool, amount, why, kind = "move") {
  if (await P._inTx.seen(key)) return "dup";
  const a = await P._inTx.applyLegs(key, [{ pool, amount }], { kind, flow: String(why || "policy").slice(0, 64), why, via: "policy" });
  await P._inTx.recordMove(key, { kind, flow: String(why || "policy").slice(0, 64), why, via: "policy", legs: [{ pool, amount }], net: a.net, ts: a.ts,
                                  result: { ok: true, key, balances: a.after } });
  await P._inTx.bumpRev();
  return "ok";
}
async function houseLeg(key, amount, why) {
  const id = `pol-${key}`.slice(0, 190);
  if ((await getQuery("SELECT 1 FROM jackpot_rakes WHERE jackpotId = ?", [id]))[0]) return "dup";
  if (amount < 0) {
    const h = await require("../capital/core").houseBalance();
    if (h < -amount) throw new Halt(`the House holds ${h} - can't take ${-amount}`, "E_INSUFFICIENT");
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [id, `policy:${String(why || "policy").slice(0, 60)}`, null, amount]);
  return "ok";
}
/** Staking fix plan P0.2: a staking payout into a stash counts as the stash's "earned" (Pepe's _vault_leg does the same). */
const isStakingPay = (why, amount) => amount > 0 && (why === "waterfall stakers" || /^staking correction/.test(String(why || "")) || /^apr-bug correction/.test(String(why || "")));
/** PO-0b (a): a credit for a stash its owner already closed is paid to the owner's WALLET (stashes.closedCredit) - it leaves the
 *  conservation base (pools + House + OPEN stashes) without being lost. `acc` (the run's tally) counts it, so the run's
 *  `conserved` check reads before === after + to_wallet instead of flagging a legitimate payout as a leak. */
async function stashLeg(key, stashId, amount, why, acc = null) {
  const r = await require("../stashes").botMove({ stashId, amount, key, kind: "vault", why: why || "waterfall",
                                                  earned: isStakingPay(why, amount) ? amount : 0 });
  if (!r || !r.ok) throw new Halt(`stash ${stashId} refused ${amount} (${(r && r.error) || "no answer"})`, "E_STASH");
  if (acc && r.to_wallet && !r.dup) acc.to_wallet = (acc.to_wallet || 0) + Math.trunc(Number(r.amount) || amount);
  return r.dup ? "dup" : "ok";
}
async function side(key, where, amount, why, acc = null) {
  if (where.startsWith("stash:")) return stashLeg(key, where.slice(6), amount, why, acc);
  if (where === "jackpot" || where === "house") return houseLeg(key, amount, why);
  return poolLeg(key, where, amount, why);
}
/** pepe_vaults._vault_transfer(tid, src, dst, amount): both legs, keyed "<tid>:out" / "<tid>:in". `acc` (optional): the run's
 *  tally - {to_wallet} grows by a stash credit that went to a closed stash's owner's wallet. */
async function transfer(tid, src, dst, amount, why, acc = null) {
  amount = Math.trunc(amount);
  if (!amount) return "none";
  if (src === "burn") throw new Halt("nothing pays out of the burn reserve", "E_BURN_ONLY");
  const out = await side(`${tid}:out`, src, -amount, why, acc);
  const inn = await side(`${tid}:in`, dst, amount, why, acc);
  return out === "dup" && inn === "dup" ? "dup" : "ok";
}

// ── the protocol's capital on the share book (Pepe's _vault_protocol_book, the same capital_ops key) ──
async function protocolBook(v, amount, key) {
  const CC = require("../capital/core");
  const V = require("../capital/vaults");
  const opKey = `vaults:proto-${key}`.slice(0, 160);
  const dup = await CC.seen(opKey);
  if (dup) return Number(dup.shares || 0);
  const res = await V.protocol({ pepe: true, via: "policy" }, { vault: v, amount }, { nowS: CC.nowS(), key: opKey });
  if (!res || !res.ok) throw new Halt(`the share book refused ${v} ${amount}: ${(res && res.error) || "?"}`, "E_BOOK");
  await CC.record(opKey, "vaults:protocol", `${v}`, "policy", res);
  await CC.bumpRev();
  return Number(res.shares);
}

// ── a Fed mint (pepe_layers._fed_mint for the scheduler's policies: floor / issuance) ──
async function fedMint({ amount, policy, reason, actor, key, dest = "reserve", period, engine, nowS }) {
  // P4-1: once the Fed's books live on the site (fed/service.js), its journal and the monthly caps are fed/service's - ONE
  // writer for every mint, checked and journaled inside this run's transaction (dbUtils.tx: no other mint lands in between)
  const F = require("../fed/service");
  if (await F.live()) {
    const m = await F.mintInTx({ amount, policy, reason, actor: String(actor || "schedule").slice(0, 40), key, dest, via: "site" });
    if (!m.ok) return { ok: false, cap: !!m.cap, room: m.room, why: `the monthly mint cap for ${m.source} is reached (${E.fmt(m.room)} left)` };
    if (!m.dup) await C.effect(`mint:${key}`, { engine, period, kind: "fed_mint", data: { key, rec: m.rec } });
    return { ok: true, dup: !!m.dup, rec: m.rec };
  }
  const have = (await getQuery("SELECT rec FROM policy_mints WHERE key = ?", [key]))[0];
  if (have) return { ok: true, dup: true, rec: C.parse(have.rec, null) };
  const all = await G.docs();
  const L = G.docOf(all, "econ_layers");
  if ((L.fed_mints || {})[key] && (L.fed_mints[key].state === "done")) return { ok: true, dup: true, rec: L.fed_mints[key], pepe: true };
  // the monthly caps, with the freshest mint records (Pepe's doc + the site's own)
  const { cfg, consts, flags } = await G.config();
  const inp = { cfg, consts, flags, mints: await G.mints(L, nowS) };
  const c = E.C(inp);
  const source = { loan: "loan", restore: "restore", cutover: "cutover" }[policy] || policy;
  const room = E.capRoom(inp, c, source, nowS);
  if (room !== null && amount > room) return { ok: false, cap: true, room, why: `the monthly mint cap for ${source} is reached (${E.fmt(room)} left)` };
  const fedBefore = await P.balance("reserve");
  const before = await base();
  await poolLeg(`fedmint-${key}:in`, dest, amount, FED_MINT_TAG);
  const after = await base();
  const rec = { key, ts: nowS, amount, policy, source, dest, reason: String(reason).slice(0, 300), actor: String(actor || "schedule").slice(0, 40),
                state: "done", done: nowS, via: "site", fed_before: fedBefore, pools_before: before, pools_after: after,
                conserved: after - before === amount };
  await runQuery("INSERT INTO policy_mints (key, rec, ts, created) VALUES (?, ?, ?, ?)", [key, JSON.stringify(rec), nowS, Date.now()]);
  await runQuery(`INSERT INTO fed_journal (id, kind, amount, pool, policy, reason, actor, state, ts, data, updated) VALUES (?, 'mint', ?, ?, ?, ?, ?, 'done', ?, ?, ?)
                  ON CONFLICT(id) DO NOTHING`, [`mint:${key}`, amount, dest, policy, rec.reason, rec.actor, nowS, JSON.stringify(rec), Date.now()]).catch(() => {});
  await C.effect(`mint:${key}`, { engine, period, kind: "fed_mint", data: { key, rec } });
  return { ok: true, rec };
}

/** P4-1: with the Fed's books on the site, a loan repayment leg is booked against the loan book in the same transaction
 * (mark "<period>-<vault>", the mark Pepe's _fl_apply_repay uses - the effect he mirrors is then a no-op there). */
async function bookRepaid(period, vault, amount) {
  const F = require("../fed/service");
  if (await F.live()) await F.repaidInTx({ mark: `${period}-${vault}`, vault, amount, epoch: period });
}

// ── shared bits ──
async function bankSample(engine, period, inputsOrNull, nowS) {
  const V = require("../capital/vaults");
  let lent;
  if (inputsOrNull && inputsOrNull.bank_nav !== undefined) lent = Math.max(0, Math.trunc(Number(inputsOrNull.bank_nav) - Number(inputsOrNull.pools.bank)));
  else { const k = await V.ctx(); lent = Math.max(0, Math.trunc(V.nav("bank", k) - k.cash.bank)); }
  await C.effect(`bank_lent:${period}`, { engine, period, kind: "bank_lent", data: { ts: nowS, amount: lent } });
  return lent;
}
const summary = (plan, keys) => Object.fromEntries(keys.filter((k) => k in plan).map((k) => [k, plan[k]]));

// ── the weekly epoch ──
// PO-1 (D-18): `late` (the scheduler's lateOf: {why, boundary, late_s}) - a current period run late (the site was down at its
// boundary, or a resume let it run) carries it on its result and its record (the audit / digest read it there)
async function runTreasuryEpoch(eid, nowS, { actor = "schedule", via = "site", late = null } = {}) {
  const res = await tx(async () => {
    const done = await C.run("treasury", eid);
    if (done && ["done", "handed"].includes(done.state)) return { ok: true, already: true, state: done.state };
    const inputs = await G.epoch(nowS, eid);
    const plan = E.planEpoch(inputs);
    const before = await base();
    const acc = { to_wallet: 0 };                                    // PO-0b (a): closed stashes' credits paid to wallets
    await bankSample("treasury", eid, inputs, nowS);
    const redeemed = {};
    for (const [v, x] of Object.entries(plan.vaults)) {
      if (x.surplus > 0) redeemed[v] = -(await protocolBook(v, -x.surplus, `wf-${eid}-${v}`));
    }
    const doneLegs = [];
    for (const leg of plan.legs) {
      await transfer(leg.tid, leg.src, leg.dst, leg.amt, leg.why, acc);
      if (leg.tid.endsWith("-loan")) {
        await bookRepaid(eid, leg.vault, leg.amt);
        await C.effect(`loan_repay:${eid}-${leg.vault}`, { engine: "treasury", period: eid, kind: "loan_repay",
                                                           data: { mark: `${eid}-${leg.vault}`, epoch: eid, vault: leg.vault, amount: leg.amt } });
      }
      doneLegs.push(leg.tid);
    }
    const after = await base();
    const incAfter = await P.balance("incentives");
    if (E.epochId(nowS, E.C(inputs).hour()) === eid) {               // _tr_finish: the week being settled is this week
      await C.effect(`week_share:${eid}`, { engine: "treasury", period: eid, kind: "week_share",
                                            data: { week: eid, share: plan.totals.incentives, release_per_day: plan.release_per_day } });
    }
    const conserved = before === after + acc.to_wallet;
    const wal = acc.to_wallet ? { to_wallet: acc.to_wallet } : {};
    if (late) wal.late = late;
    const result = Object.assign({ boundary: plan.boundary, totals: plan.totals, release_per_day: plan.release_per_day, incentives_after: incAfter,
                     pools_before: before, pools_after: after, conserved, shares_redeemed: redeemed, done_legs: doneLegs, actor, via }, wal);
    // the owner's D2 monitoring on the record, as Pepe's own records carry it (pepe_treasury._tr_track = engines.trackOf): what a
    // 25% cap would have paid, how each vault was weighted, the cap the plan applied and whether it was D2's safeguard (fallback).
    // Monitoring only: like Pepe (try / except around _tr_track, "[TREASURY] epoch <eid>: track: ..."), an error here is logged
    // and the settlement goes on - the record then has no track and the payout notice reads the cap in force from the inputs
    let track = null;
    try {
      track = E.trackOf(inputs, plan);
    } catch (e) {
      console.error(`[policy] epoch ${eid}: track: ${e && e.message}`);
    }
    const capIn = track ? null : (() => { try { return E.stakerCapOf(inputs); } catch (e) { return 0; } })();
    const rec = Object.assign(JSON.parse(JSON.stringify(plan)), { state: "done", actor, manual: false, done_legs: doneLegs, done: nowS, incentives_after: incAfter,
                                          pools_before: before, pools_after: after, conserved, via: "site" }, wal, track ? { track } : {});
    for (const [v, sh] of Object.entries(redeemed)) if (rec.vaults[v]) rec.vaults[v].shares_redeemed = sh;
    await C.effect(`epoch_record:${eid}`, { engine: "treasury", period: eid, kind: "epoch_record", data: { eid, rec } });
    await C.putRun("treasury", eid, { state: "done", boundary: plan.boundary, via, inputs, plan, result });
    await require("../escrow/ledger").emitInTx("policy", "epoch_done", null, { eid, totals: plan.totals, release_per_day: plan.release_per_day,
                                                                              conserved });
    return { ok: true, plan, result, track, capIn };
  });
  // staking fix plan P0.1 (Pepe's _tr_notify_stakers): one notice per paid stash, after the settlement committed
  if (res && res.ok && !res.already && res.plan) await notifyStakers(eid, res.plan, res.track, res.capIn).catch((e) => console.error("[policy] payout notices:", e.message));
  return res;
}

const VLABEL = { house: "🎰 House", bank: "🏦 Bank", mm: "📈 Market maker" };
/** P0.1: "Staking payout: +n PAT" to each paid stash's owner (the sum over the vaults), ref "wf:<eid>:s<stash>" - the inbox keeps
 *  one row per (account, ref), so Pepe's own notice for the same payout and a rerun add nothing. The words are Pepe's
 *  (pepe_treasury._tr_notify_stakers, camfrog-bot 31c65d0), read from the record's track (engines.trackOf): "your part of" the
 *  stakers' share of the protocol's own weekly earnings; "shared by how much you staked and for how long" only when every vault
 *  that paid was split by PAT-days ("pat_days" or "partial"); the cap in force, else - D2's safeguard - the vaults paid under
 *  the 25% reference cap because the week wasn't wholly time-weighted (fallback). With no track (trackOf failed: the record has
 *  none, as Pepe's when his _tr_track raised) the cap is capIn, the cap in force from the settlement's inputs - Pepe's
 *  _tr_staker_cap() - and no "how long" / safeguard clause. -> notices filed */
async function notifyStakers(eid, plan, track, capIn = 0) {
  const tr = track || {};
  const cap = tr.cap_in_force_pct !== undefined && tr.cap_in_force_pct !== null ? (Number(tr.cap_in_force_pct) / 100 || 0) : (Number(capIn) || 0);
  const paidV = Object.entries(tr.vaults || {}).filter(([, x]) => Math.trunc(Number(x.paid) || 0) > 0);
  const by = new Map();
  for (const l of plan.legs || []) {
    if (l.why !== "waterfall stakers" || !String(l.dst || "").startsWith("stash:") || !(l.amt > 0)) continue;
    const id = l.dst.slice(6);
    const x = by.get(id) || { total: 0, parts: {} };
    x.total += l.amt;
    x.parts[l.vault] = (x.parts[l.vault] || 0) + l.amt;
    by.set(id, x);
  }
  const S = require("../stashes");
  const inbox = require("../inbox");
  const fmt = (n) => Math.trunc(n).toLocaleString("en-US");
  // Python's round(): half-even on the exact double (int(round(x * 100)): a 20.5% share reads 20%, 12.5% 12% - Math.round
  // said 21% / 13%), and round(cap * 100, 2) for the cap (":g" of a value with at most 2 decimals = JS's String)
  const share = Math.trunc(pyRoundN(Number(plan.staker_share || 0) * 100, 0)) || 0;
  const fb = paidV.filter(([, x]) => x.fallback).map(([v]) => v);
  let capTxt = ".";
  if (cap > 0) capTxt = `, capped at ${pyRoundN(cap * 100, 2)}% a year on your stake.`;
  else if (fb.length) {
    // D2's safeguard: no weekly cap, but this week wasn't wholly time-weighted (the first week after the change)
    const why = fb.every((v) => tr.vaults[v].weighting === "partial") ? "time-weighting started mid-week" : "this week couldn't be fully time-weighted";
    capTxt = `; this week ${fb.map((v) => VLABEL[v] || v).join(" and ")} paid at most ${E.TR_FALLBACK_CAP * 100}% a year on your stake (${why}).`;
  }
  const how = paidV.length && paidV.every(([, x]) => x.weighting === "pat_days" || x.weighting === "partial") ? " - shared by how much you staked and for how long" : "";
  let n = 0;
  for (const [id, x] of by) {
    const s = await S.get(id).catch(() => null);
    if (!s || !s.owner_id) continue;
    const parts = ["house", "bank", "mm"].filter((v) => x.parts[v] > 0).map((v) => `${VLABEL[v]} ${fmt(x.parts[v])}`).join(" · ");
    // the copy the owner approved 2026-10-19 (fix plan §5.3 rewritten for that day's rule) - Pepe's sentence, word for word
    const body = `🏦 ${s.owner_name || s.owner}/${s.name}: this week's staking payout is +${fmt(x.total)} PAT (${parts}), paid into the stash's balance. ` +
                 `It's your part of ${share}% of the protocol's own weekly earnings in each vault${how}${capTxt}`;
    if (await inbox.addSafe(s.owner_id, { kind: "staking", title: `Staking payout: +${fmt(x.total)} PAT`, body, link: "/staking", ref: `wf:${eid}:s${id}` })) n++;
  }
  return n;
}

// ── the daily release ──
async function runTreasuryDaily(did, nowS, { actor = "schedule", via = "site", late = null } = {}) {
  return tx(async () => {
    const done = await C.run("treasury", did);
    if (done && ["done", "handed"].includes(done.state)) return { ok: true, already: true, state: done.state };
    const inputs = await G.daily(nowS, did);
    const plan = E.planDaily(inputs);
    const before = await base();
    const acc = { to_wallet: 0 };                                    // PO-0b (a): closed stashes' credits paid to wallets
    await bankSample("treasury", did, null, nowS);
    const doneLegs = [];
    for (const leg of plan.legs) {
      await transfer(leg.tid, leg.src, leg.dst, leg.amt, leg.why, acc);
      if (leg.tid.endsWith("-loan") && leg.vault) {
        await bookRepaid(did, leg.vault, leg.amt);
        await C.effect(`loan_repay:${did}-${leg.vault}`, { engine: "treasury", period: did, kind: "loan_repay",
                                                           data: { mark: `${did}-${leg.vault}`, epoch: did, vault: leg.vault, amount: leg.amt } });
      }
      doneLegs.push(leg.tid);
    }
    const after = await base();
    const conserved = before === after + acc.to_wallet;
    const wal = acc.to_wallet ? { to_wallet: acc.to_wallet } : {};
    if (late) wal.late = late;
    const rec = Object.assign({}, plan, { state: "done", actor, ts: nowS, done_legs: doneLegs, pools_before: before, pools_after: after,
                                          conserved, via: "site" }, wal);
    await C.effect(`day_record:${did}`, { engine: "treasury", period: did, kind: "day_record", data: { did, rec } });
    const result = Object.assign({ totals: { overflow: plan.overflow, casino_overflow: plan.casino_overflow, floor_paid: plan.floor_paid, floor_short: plan.floor_short },
                     pools_before: before, pools_after: after, conserved, done_legs: doneLegs, actor, via }, wal);
    await C.putRun("treasury", did, { state: "done", boundary: E.dayStart(nowS), via, inputs, plan, result });
    await require("../escrow/ledger").emitInTx("policy", "release_done", null, { did, overflow: plan.overflow, casino_overflow: plan.casino_overflow,
                                                                                floor_paid: plan.floor_paid, conserved });
    return { ok: true, plan, result };
  });
}

// ── the activity payouts (pepe_monetary._mo_activity_start / _mo_activity_pay) ──
async function payActivity(did, inputs, plan, nowS) {
  const act = plan.activity || {};
  const amount = Math.trunc(Number(act.amount) || 0);
  if (amount <= 0) return null;
  const pay = E.planActivity(inputs, act.local_day, amount);
  const CC = require("../capital/core");
  const ledger = require("../ledger");
  await require("../botcredits").init();
  const state = {};
  let paid = 0;
  let stopped = false;
  for (const [lg, amt] of pay) {
    if (stopped) break;
    const ref = `act-${did}-${lg}`.slice(0, 80);
    try {
      await tx(async () => {
        const prev = (await getQuery("SELECT outcome FROM bot_credit_log WHERE ref = ?", [ref]))[0];
        if (prev && prev.outcome === "ok") { state[lg] = "paid"; return; }
        const u = await CC.account({ login: lg });
        if (!u) throw new Halt("no account", "E_TARGET_NOT_FOUND");
        if ((await P.balance("incentives")) < amt) { stopped = true; throw new Halt("the incentive budget can't cover it", "E_INSUFFICIENT"); }
        await poolLeg(`${ref}:out`, "incentives", -amt, "activity_rewards");
        const transactionId = require("uuid").v4();
        // auto-account escrow (autoescrow.js): an auto account's activity reward is held for it instead, while that switch is on
        const posted = await require("../autoescrow").credit(u.userId, amt, "bonus win", { requireCover: true, transactionId, kind: "activity-reward",
                                                                                         source: "bonus activity-reward from incentives" });
        if (!posted.ok) throw new Halt("credit refused", posted.code || "E_CREDIT");
        await runQuery("INSERT INTO bonus_winners (bonusId, type, userId, transactionId, amount) VALUES (?, ?, ?, ?, ?)",
                       [require("uuid").v4(), "activity-reward", posted.userId, transactionId, amt]);
        await runQuery(`INSERT INTO bot_credit_log (ref, ts, endpoint, userId, type, amount, source, outcome) VALUES (?, ?, 'policy', ?, 'activity-reward', ?, 'incentives', 'ok')
                        ON CONFLICT(ref) DO UPDATE SET outcome = 'ok', ts = excluded.ts`, [ref, Date.now(), posted.userId, amt]);
        state[lg] = "paid";
        paid += amt;
      });
    } catch (e) {
      state[lg] = "failed";                       // never paid here (Pepe's retry loop leaves "failed" alone)
      if (!(e instanceof Halt)) console.error(`[policy] activity ${ref}:`, e.message);
    }
  }
  const w = E.resolveWeek(Object.assign({}, inputs), E.C(inputs), nowS);
  const rec = { day: did, local_day: act.local_day, amount: paid, payouts: Object.fromEntries(pay), state, ts: nowS, paid, group: "activity",
                week: w.id, via: "site" };
  if (paid) await C.effect(`budget_spend:act-${did}`, { engine: "monetary", period: did, kind: "budget_spend", data: { week: w.id, group: "activity", amount: paid } });
  await C.effect(`activity_record:${did}`, { engine: "monetary", period: did, kind: "activity_record", data: { did, rec } });
  return rec;
}

// ── the monetary day ──
async function runMonetary(did, nowS, guarantee, { actor = "schedule", via = "site", late = null } = {}) {
  return tx(async () => {
    const done = await C.run("monetary", did);
    if (done && ["done", "handed"].includes(done.state)) return { ok: true, already: true, state: done.state };
    const inputs = await G.monetary(nowS, did, guarantee);
    const plan = E.planMonetary(inputs);
    const planned = JSON.parse(JSON.stringify(plan));       // the plan as planned (the legs below get their amounts fixed)
    if (plan.issuance.error && plan.issuance.mode === "pct") throw new Halt(plan.issuance.error, "E_SUPPLY");
    const month = E.monthOf(nowS);
    const capNote = async (source, wanted, room) => C.effect(`cap_hit:${source}-${month}`, { engine: "monetary", period: did, kind: "cap_hit",
                                                                                           data: { source, month, wanted, room } });
    if (plan.issuance.capped_from) await capNote("issuance", plan.issuance.capped_from, plan.issuance.amount);
    if (plan.floor_room !== null && plan.floor_mint < Math.min(plan.floor_need, plan.floor_daily)) await capNote("floor", Math.min(plan.floor_need, plan.floor_daily), plan.floor_room);
    const doneLegs = [], skipped = [], notes = [];
    for (const [i, leg] of plan.legs.entries()) {
      const lid = leg.key || leg.tid || String(i);
      if (leg.kind === "mint") {
        const m = await fedMint({ amount: leg.amount, policy: leg.policy, reason: leg.reason, actor, key: leg.key, dest: leg.dest, period: did, engine: "monetary", nowS });
        if (m.ok) doneLegs.push(lid);
        else { skipped.push(lid); notes.push(`${lid}: ${m.why}`.slice(0, 200)); if (m.cap) await capNote(leg.policy, leg.amount, m.room); }
        continue;
      }
      leg.amt = Math.max(0, Math.min(Math.trunc(leg.amt), await P.balance(leg.src)));
      leg.fixed = true;
      if (leg.amt <= 0) { skipped.push(lid); continue; }
      await transfer(leg.tid, leg.src, leg.dst, leg.amt, leg.why);
      doneLegs.push(lid);
    }
    const act = await payActivity(did, inputs, plan, nowS);
    const rec = Object.assign({}, plan, { state: "done", actor, done_legs: doneLegs, skipped, notes, done: nowS, via: "site" }, late ? { late } : {});
    await C.effect(`mo_day_record:${did}`, { engine: "monetary", period: did, kind: "mo_day_record", data: { did, rec } });
    const result = Object.assign({ floor_mint: plan.floor_mint, issuance: plan.issuance.amount, guarantee_paid: plan.guarantee_paid, excess: plan.excess,
                     ceiling_action: plan.ceiling_action, activity_paid: act ? act.paid : 0, activity_people: act ? Object.values(act.state).filter((s) => s === "paid").length : 0,
                     done_legs: doneLegs, skipped, notes, actor, via }, late ? { late } : {});
    await C.putRun("monetary", did, { state: "done", boundary: E.dayStart(nowS), via, inputs, plan: planned, result });
    await require("../escrow/ledger").emitInTx("policy", "monetary_done", null, Object.assign({ did }, summary(result, ["floor_mint", "issuance", "guarantee_paid", "excess", "ceiling_action", "activity_paid", "activity_people"])));
    return { ok: true, plan, result };
  });
}

// ── the burn accrual ──
async function runBurn(period, nowS, { actor = "accrual", via = "site", inflight = 0 } = {}) {
  return tx(async () => {
    const done = await C.run("burn", period);
    if (done && ["done", "handed"].includes(done.state)) return { ok: true, already: true };
    const bal = await P.balance("burn");
    const amt = Math.max(0, bal - Math.max(0, Math.trunc(Number(inflight) || 0)));
    let id = null;
    if (amt > 0) {
      const seq = Number((await C.meta("burn_seq")) || 0) + 1;
      await C.setMeta("burn_seq", seq);
      id = `S${seq}`;
      const key = `${id}-${crypto.createHash("sha256").update(period).digest("hex").slice(0, 12)}`;
      await poolLeg(`burn:${key}`, "burn", -amt, "burned", "burn");
      const B = require("../burns");
      await B.ensure();
      await runQuery(`INSERT OR IGNORE INTO pat_burns (key, id, at, source, amount, reason, actor_kind, actor, recorded_at) VALUES (?, ?, ?, 'burn', ?, ?, 'auto', ?, ?)`,
                     [key, id, Math.round(nowS * 1000), amt, "waterfall leftover (burned on accrual)", actor, Date.now()]);
      await C.effect(`burn:${key}`, { engine: "burn", period, kind: "burn", data: { id, key, ts: nowS, amount: amt, reason: "waterfall leftover (burned on accrual)",
                                                                                   actor, actor_kind: "auto" } });
      await require("../escrow/ledger").emitInTx("policy", "burned", null, { id, amount: amt });
    }
    // an empty slot isn't recorded (one row every 5 minutes for nothing); the next slot looks again
    if (amt > 0) await C.putRun("burn", period, { state: "done", via, result: { amount: amt, id, balance_before: bal, inflight } });
    return { ok: true, amount: amt, id };
  });
}

module.exports = { runTreasuryEpoch, runTreasuryDaily, runMonetary, runBurn, transfer, protocolBook, fedMint, base, Halt, notifyStakers, isStakingPay };
