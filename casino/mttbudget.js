// casino/mttbudget.js — the ONLY module a scheduled tournament's guarantee touches the incentive budget through (hand-off 22 phase 2,
// 1.99??; docs/casino-backend.md "Guarantees and freerolls"). Guaranteed pools and freerolls are paid from the INCENTIVE budget through
// the budget service (hand-off 23 D3, PO-5: policy/budget.js), and only from H2b on - Tue 2026-12-01 14:00:00 UTC. Never from the
// House, the Fed or a player's PAT: nothing here (or in any casino/mtt*.js file) moves PAT any other way.
//
//   H2B_AT       a code constant - never a setting, never an env var (setSetting refuses anything that looks like it)
//   spendGate    may an overlay be paid now? before_h2b | budget_not_site (also 'cutting' and an H2b rollback) | budget_paused |
//                no_budget_service (policy/budget.js missing, or not exporting spendInTx + remaining + weekOf)
//   createGate   may a guarantee / freeroll be created, edited or opened for registration? the mtt_guarantees switch + spendGate
//   headroom     the group's remaining budget for the week of `at` (pacing applied)
//   payInTx      the overlay legs inside the caller's dbUtils.tx: ONE keyed budget spend (incentives pool -> the winners' wallets).
//                A terminal refusal comes back {ok:false, terminal:true, code} (recorded by PO-5 under the key); anything else throws.
// policy/budget.js is not on main yet (hand-off 23 D3): until it is, spendGate answers no_budget_service and guarantees stay unavailable.
"use strict";

const H2B_AT = Date.UTC(2026, 11, 1, 14, 0, 0, 0);
const GROUPS = Object.freeze(["roomgames", "misc"]);
const hooks = { budget: undefined, config: undefined };    // tests only: a stub budget service / policy config

function budgetModule() {
  if (hooks.budget !== undefined) return hooks.budget;
  try { return require("../policy/budget"); } catch (e) { return null; }
}
const config = () => (hooks.config !== undefined ? hooks.config : require("../policy/config"));
const hasApi = (B) => !!(B && typeof B.spendInTx === "function" && typeof B.remaining === "function" && typeof B.weekOf === "function");

/** -> {ok: true} | {ok: false, why} */
async function spendGate(now) {
  if (!(Number(now) >= H2B_AT)) return { ok: false, why: "before_h2b" };
  try {
    const C = config();
    if ((await C.owner("budget")) !== "site") return { ok: false, why: "budget_not_site" };
    const own = await C.ownership();
    if (!own || !own.budget || own.budget.paused !== 0) return { ok: false, why: "budget_paused" };
  } catch (e) {
    return { ok: false, why: "budget_not_site" };
  }
  if (!hasApi(budgetModule())) return { ok: false, why: "no_budget_service" };
  return { ok: true };
}
async function createGate(now, st) {
  if (!st || st.mtt_guarantees !== "on") return { ok: false, why: "switch_off" };
  return spendGate(now);
}
/** the group's remaining budget for the week of `at` (null when the service can't say) */
async function headroom(group, at) {
  const B = budgetModule();
  if (!hasApi(B)) return null;
  const r = await B.remaining(group, { at });
  const n = Math.floor(Number(r && typeof r === "object" ? r.remaining : r));
  return Number.isFinite(n) ? n : null;
}
/** the budget week an instant falls in: PO-5's weekOf, else Monday 04:00 UTC weeks -> {start, end} (ms) */
function weekFallback(at) {
  const d = new Date(Number(at));
  const day = (d.getUTCDay() + 6) % 7;                                   // Monday = 0
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day, 4, 0, 0, 0);
  if (start > at) start -= 7 * 86400e3;
  return { start, end: start + 7 * 86400e3 };
}
async function weekOf(at) {
  const B = budgetModule();
  if (hasApi(B)) {
    try {
      const w = await B.weekOf(at);
      if (w && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end))) return { start: Number(w.start), end: Number(w.end) };
    } catch (e) { /* the fallback below */ }
  }
  return weekFallback(at);
}
/** every budget week [from, to] touches -> [{start, end}] */
async function weeksTouched(from, to) {
  const out = [];
  let w = await weekOf(from);
  for (let i = 0; i < 60; i++) {
    out.push(w);
    if (w.end > to) break;
    w = await weekOf(w.end);
  }
  return out;
}
/** the group's weekly budget (policy cfg budget_<group>, as PO-5 reads it), or the spec default */
async function groupBudget(group) {
  try {
    const s = await config().snapshot();
    const v = Number(s && s.cfg ? s.cfg["budget_" + group] : NaN);
    if (Number.isFinite(v) && v >= 0) return Math.floor(v);
  } catch (e) { /* the defaults */ }
  try { const spec = require("../policy/cfgspec"); const p = spec.SPEC && spec.SPEC["budget_" + group]; if (p && Number.isFinite(Number(p.default))) return Number(p.default); } catch (e) { /* below */ }
  return group === "roomgames" ? 3500000 : group === "misc" ? 350000 : 0;
}

/**
 * In the caller's dbUtils.tx: pay the overlay legs. legs [{userId, amount}] (> 0 each). -> {ok: true} | {ok: false, terminal: true, code}
 * (a terminal refusal PO-5 recorded under the key); throws for anything non-terminal (paused, transient: nothing recorded).
 * With a single-destination PO-5 (no `legs`): pre-checked headroom, one spend per leg keyed <key>:<place>, all or nothing - any refusal
 * throws, so the whole transaction (and every refusal row) rolls back.
 */
async function payInTx({ key, group, legs, ref, why, no, now }) {
  const B = budgetModule();
  if (!hasApi(B)) throw Object.assign(new Error("no budget service"), { code: "no_budget_service" });
  if (!GROUPS.includes(group)) throw Object.assign(new Error("bad budget group"), { code: "bad_group" });
  const L = legs.filter((l) => l.amount > 0).map((l) => ({ userId: String(l.userId), amount: Math.floor(l.amount), reason: "tournament guarantee", cp: `tournament #${no}` }));
  if (!L.length) return { ok: true, empty: true };
  if (B.multiLeg !== false) {
    const r = await B.spendInTx({ key, group, flow: "incentives:casino_mtt", legs: L, ref, why, via: "casino", source: "incentives" });
    if (r && r.ok) return { ok: true };
    if (r && r.terminal) return { ok: false, terminal: true, code: r.code || "refused" };
    throw Object.assign(new Error("budget spend not confirmed"), { code: (r && r.code) || "unconfirmed" });
  }
  // the single-destination fallback (a deviation from "one audited spend": DELIVERY.md)
  const total = L.reduce((s, l) => s + l.amount, 0);
  const room = await headroom(group, Number(now) || Date.now());
  if (room === null || room < total) throw Object.assign(new Error("headroom"), { code: "headroom" });
  for (let i = 0; i < L.length; i++) {
    const r = await B.spendInTx({ key: `${key}:${i + 1}`, group, flow: "incentives:casino_mtt", to: L[i].userId, amount: L[i].amount, reason: L[i].reason,
                                  cp: L[i].cp, ref, why, via: "casino", source: "incentives" });
    if (!(r && r.ok)) throw Object.assign(new Error("a leg was refused"), { code: (r && r.code) || "refused" });
  }
  return { ok: true, fallback: true };
}
/** what the admin card says about the gate */
function gateText(why) {
  return ({ before_h2b: "Guarantees: locked until 2026-12-01 14:00 UTC", budget_not_site: "the incentive budget is Pepe's", budget_paused: "budget paused",
            no_budget_service: "budget service not installed", switch_off: "Guarantees are switched off" })[why] || (why ? String(why) : "available");
}

module.exports = { H2B_AT, GROUPS, spendGate, createGate, headroom, weekOf, weekFallback, weeksTouched, groupBudget, payInTx, gateText, hasApi, _hooks: hooks };
