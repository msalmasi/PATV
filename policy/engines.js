// policy/engines.js — Phase 4 of the backend migration: the policy engines' PLANS, ported from Pepe expression for
// expression. Pure functions of one `inputs` object (camfrog-bot pepe_policyinputs.py builds the same object from Pepe's
// live state; policy/gather.js builds it from the site's tables):
//
//   planEpoch(inputs)     pepe_treasury._tr_plan          the Monday 04:00 UTC surplus waterfall (House, Bank, Market maker)
//   planDaily(inputs)     pepe_treasury._tr_daily_plan    the daily release: Fort Knox / Casino overflow (Fed loans first), floors
//   planMonetary(inputs)  pepe_monetary._mo_daily_plan    the Fed band (floor mint, ceiling release), the Monday guarantee,
//                                                         organic issuance, the activity group's allowance
//   planActivity(inputs, localDay, amount)  pepe_monetary._mo_activity_plan   who the day's activity rewards go to
//
// test/policy-vectors.test.js replays camfrog-bot tools/gen_policy_vectors.py (the REAL Python on random economies): every
// plan must come out the same - the same PAT to the unit, the same legs (tid, source, destination, amount) in the same order.
// What that takes, beyond the arithmetic:
//   * Python's int() truncates, // floors (ints: exact; floats: CPython's float_floor_div), round() is half-even on the
//     exact double (capital/vaults.pyRoundN);
//   * the float sums run in Python's dict order: vault holders, the Auto fund's holders and participation rows arrive as
//     ordered [key, value] lists and the stakers' map is a Map (a plain object would put "12" before "s1"-style keys);
//   * sorted() compares code points (Python), never the locale.
"use strict";
const { pyRoundN } = require("./pymath");

const FED = "reserve", FORTKNOX = "fortknox", INCENTIVES = "incentives", CASINO = "heist", PROTOCOL = "protocol", AUTO = "auto";
const TREASURY = ["house", "bank", "mm"];
const CASH = { bank: "bank", house: "jackpot", mm: "mm" };
const UNCAPPED = -1;
const BUDGETS = { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000, royalties: 300000,
                  roomgames: 3500000, turf: 500000, season: 2000000, launchpad: 1000000, activity: 0 };
const GROUPS = Object.keys(BUDGETS);
const PACED = new Set(["roomgames", "turf", "activity"]);
const UNCAPPABLE = new Set(["activity", "launchpad"]);
const CAPPED = ["issuance", "floor", "admin", "loan", "restore"];
const OWN_CAP = ["issuance", "floor", "loan", "restore"];
const SOURCES = CAPPED.concat(["donation", "seed", "cutover"]);
const POLICY_SOURCE = { loan: "loan", restore: "restore", cutover: "cutover", floor: "floor", issuance: "issuance", admin: "admin", donation: "donation", seed: "seed" };
const DEFAULTS = {
  house_target: 15000000, bank_target: 2000000, bank_lent_mult_pct: 200, bank_peak_days: 30, fortknox_floor: 2000000,
  fortknox_cap: 15000000, heist_cap_mode: "pct", fortknox_cap_pct: 60.0, casino_cap_pct: 40.0, fed_floor: 25000000,
  fed_ceiling: 150000000, fed_floor_mint_daily: 5000000, fed_ceiling_action: "burn", incentive_guarantee: true,
  incentive_guarantee_target: 0, issuance_to_guarantee: true, activity_rewards: false, issuance_mode: "off",
  issuance_pct_month: 1.0, issuance_fixed_month: 10000000, issuance_activity_scaling: true, mintcap_issuance: -1,
  mintcap_floor: 30000000, mintcap_loan: -1, mintcap_restore: -1, mintcap_total: -1, staker_share_pct: 20.0, fed_split_pct: 50.0,
  // staking fix plan P1.1 (2026-10-19): the stakers' weekly bonus cap on its own knob (% APR on the staked value, 0 = no cap) -
  // it was VAULT_CEIL_APR, the daily ceiling's knob; 25 = the same 25% as before. D2 (the owner, 2026-10-19): the cap goes -
  // the operator sets it to 0 after the deploy (time-weighted payouts, P2.1, ship in the same release)
  wf_staker_cap_pct: 25.0,
  // Q11 (ECONOMY-V3 23.2): the activity-scaled guarantee target - OFF by default (the fixed target holds)
  guarantee_scaled: false, guarantee_base: 25000000, guarantee_min: 15000000, guarantee_max: 40000000, guarantee_smooth_weeks: 3,
  guarantee_ref_weeks: 4,
};
const CONSTS = { VAULT_MIN_MOVE: 1000, VAULT_CEIL_APR: 0.25, VAULT_EPOCH_UTC_HOUR: 4, HOUSE_MIN_CASH: 5000000,
                 VAULT_MM_MIN_TARGET: 1000000, VAULT_TARGET_MULT: 1.5, HEIST_VAULT_MIN: 2000000, HEIST_VAULT_CAP: 10000000 };
// D2 (the owner, 2026-10-19): what a 25% APR weekly cap WOULD have paid is tracked on every epoch record (pepe_treasury
// TR_TRACK_CAP), and D2's safeguard pays a vault whose week isn't wholly time-weighted under that same reference cap while no
// cap is in force (TR_FALLBACK_CAP = TR_TRACK_CAP; patDaysWhole)
const TR_TRACK_CAP = 0.25;
const TR_FALLBACK_CAP = TR_TRACK_CAP;
const ACT_MIN_LINES = 10, ACT_MIN_MIC = 5, ACT_SCALE_MIN = 0.5, ACT_SCALE_MAX = 1.5, ACT_SCORE_CAP = 1000;
const GUARANTEE_WAIT = 12 * 3600;

// ── Python semantics ──
const pyInt = (x) => {                                        // int(x): bool -> 0/1, float -> truncated
  if (x === true) return 1;
  if (x === false || x === null || x === undefined) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) || 0 : 0;
};
const pyFloat = (x) => (x === true ? 1 : x === false ? 0 : Number(x));
/** a // b for integers (exact while |a| < 2^53). */
function floorDiv(a, b) {
  a = Math.trunc(a); b = Math.trunc(b);
  let q = Math.floor(a / b);
  while (q * b > a) q -= 1;
  while ((q + 1) * b <= a) q += 1;
  return q;
}
/** CPython's float_floor_div (a // b on floats). */
function floorDivF(vx, wx) {
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod) {
    if ((wx < 0) !== (mod < 0)) { mod += wx; div -= 1.0; }
  }
  let fd;
  if (div) {
    fd = Math.floor(div);
    if (div - fd > 0.5) fd += 1.0;
  } else {
    fd = 0 * Math.sign(vx / wx);
  }
  return fd;
}
const pyRound0 = (x) => Math.trunc(pyRoundN(x, 0));
const cmpPy = (a, b) => {                                    // sorted() on str: code points
  const A = Array.from(String(a)), B = Array.from(String(b));
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const x = A[i].codePointAt(0), y = B[i].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return A.length - B.length;
};
/** f"{int(n):,}" */
function fmt(n) {
  const v = pyInt(n);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return v < 0 ? "-" + s : s;
}
/** str(float) as Python prints it (1.0, 0.5, 1.237). */
function pyFloatStr(x) {
  const n = Number(x);
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return n.toFixed(1);
  return String(n);
}

// ── the clock (pepe_treasury.week_start / day_start, time.strftime) ──
function weekStart(ts, hour = 4) {
  const d = new Date(Math.floor(ts) * 1000);
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const wday = (d.getUTCDay() + 6) % 7;
  const mon = day0 - wday * 86400 + Math.trunc(hour) * 3600;
  return mon <= ts ? mon : mon - 7 * 86400;
}
function dayStart(ts, hour = 4) {
  const d = new Date(Math.floor(ts) * 1000);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.trunc(hour)) / 1000;
  return base <= ts ? base : base - 86400;
}
const ymd = (ts) => new Date(Math.floor(ts) * 1000).toISOString().slice(0, 10);
const monthOf = (ts) => new Date(Math.floor(Number(ts) || 0) * 1000).toISOString().slice(0, 7);
const epochId = (ts, hour = 4) => "W" + ymd(weekStart(ts, hour));
const dayId = (ts, hour = 4) => "D" + ymd(dayStart(ts, hour));

// ── config ──
function C(inp) {
  const c = Object.assign({}, DEFAULTS, inp.cfg || {});
  const k = Object.assign({}, CONSTS, inp.consts || {});
  return {
    raw: (key) => (key in c ? c[key] : undefined),                             // self._mo(key)
    int: (key, d) => pyInt(key in c ? c[key] : d),                             // _cfg(bot, key, default)
    share: (key, d) => (key in c ? Math.max(0.0, Math.min(1.0, pyFloat(c[key]) / 100.0)) : d),
    k: (name) => k[name],
    hour: () => pyInt(k.VAULT_EPOCH_UTC_HOUR),
  };
}
/** P1.1: the stakers' weekly bonus cap, an APR fraction on the staked value (0 = no cap) - pepe_treasury._tr_staker_cap:
 *  _share(self, "wf_staker_cap_pct", VAULT_CEIL_APR). stakerCapOf(inputs): the same from an engine's inputs. */
const stakerCap = (c) => c.share("wf_staker_cap_pct", pyFloat(c.k("VAULT_CEIL_APR")));
const stakerCapOf = (inp) => stakerCap(C(inp));
const flag = (inp, f) => !!((inp.flags || {})[f]);
const pool = (inp, k) => pyInt((inp.pools || {})[k]);

// ── the Fed's mint records: month to date, the caps, the week's issuance ──
const sourceOf = (r) => r.source || POLICY_SOURCE[String(r.policy || "")] || "admin";
function mintsMtd(inp, now) {
  const month = monthOf(now);
  const out = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  for (const r of inp.mints || []) {
    if (!["pending", "done"].includes(r.state) || monthOf(Number(r.ts) || 0) !== month) continue;
    const s = sourceOf(r);
    out[s] = (out[s] || 0) + pyInt(r.amount || 0);
  }
  return out;
}
function capOf(c, source) {
  if (source !== "total" && !OWN_CAP.includes(source)) return UNCAPPED;
  const v = c.raw("mintcap_" + source);
  return v === undefined ? UNCAPPED : pyInt(v);
}
/** PAT `source` may still mint this UTC month; null = no cap applies (pepe_monetary._mo_cap_room). */
function capRoom(inp, c, source, now) {
  if (!CAPPED.includes(source)) return null;
  const mtd = mintsMtd(inp, now);
  const rooms = [];
  const cap = capOf(c, source);
  if (cap !== UNCAPPED) rooms.push(Math.max(0, cap - pyInt(mtd[source] || 0)));
  const t = capOf(c, "total");
  if (t !== UNCAPPED) rooms.push(Math.max(0, t - CAPPED.reduce((s, x) => s + pyInt(mtd[x] || 0), 0)));
  return rooms.length ? Math.min(...rooms) : null;
}
function weekIssuance(inp, c, now) {
  if (!c.raw("issuance_to_guarantee")) return 0;
  const b = weekStart(now, c.hour());
  let s = 0;
  for (const r of inp.mints || []) {
    const ts = Number(r.ts) || 0;
    if (r.policy === "issuance" && r.state === "done" && (r.dest || FED) === FED && b - 7 * 86400 <= ts && ts < b) s += pyInt(r.amount || 0);
  }
  return s;
}
const ecBudget = (c, g) => c.int("budget_" + g, BUDGETS[g] || 0);
function budgetSum(c) {
  let t = 0;
  for (const g of GROUPS) t += Math.max(0, ecBudget(c, g));
  return t;
}
const WEEK = 7 * 86400;
/** Q11 (ECONOMY-V3 23.2, pepe_monetary.gscale): the activity-scaled guarantee target for the week that starts at the epoch
 *  boundary M. `weeks` = [[week start, gated payout participants], ...] - the site's recipe ledger (recipe_credits, slices
 *  owner / streamers / people, distinct accounts per epoch week), complete weeks only.
 *    reference  the median of the first `ref_weeks` complete weeks (none yet: "collecting", the target stays at base)
 *    raw(m)     the target computed on Monday m = clamp(int(base x n(m - 7 d) / reference), min, max); a week the list lacks
 *               (stale data) uses the latest week it has
 *    target     smoothing: the mean (//) of the last `smooth_weeks` raw targets, raw(M), raw(M - 7 d), ... (before the
 *               reference existed each one is the base) */
function gscale(weeks, M, cfgGet) {
  const base = pyInt(cfgGet("guarantee_base")), lo = pyInt(cfgGet("guarantee_min")), hi = pyInt(cfgGet("guarantee_max"));
  const S = Math.max(1, pyInt(cfgGet("guarantee_smooth_weeks"))), R = Math.max(1, pyInt(cfgGet("guarantee_ref_weeks")));
  M = pyInt(M);
  const have = new Map();
  for (const w of weeks || []) {
    if (!Array.isArray(w) || w.length < 2) continue;
    const ws = pyInt(w[0]);
    if (ws + WEEK <= M) have.set(ws, pyInt(w[1]));
  }
  const ks = [...have.keys()].sort((a, b) => a - b);
  let ref = null;
  if (ks.length >= R) {
    const ns = ks.slice(0, R).map((k) => have.get(k)).sort((a, b) => a - b);
    const mid = Math.floor(R / 2);
    ref = R % 2 ? ns[mid] : (ns[mid - 1] + ns[mid]) / 2.0;
  }
  const rawAt = (m) => {
    if (ref === null || ref <= 0) return base;
    const done = ks.filter((k) => k + WEEK <= m);
    if (done.length < R) return base;
    const n = have.has(m - WEEK) ? have.get(m - WEEK) : have.get(done[done.length - 1]);
    return Math.max(lo, Math.min(hi, Math.trunc(base * n / ref)));
  };
  const raws = [];
  for (let i = 0; i < S; i++) raws.push(rawAt(M - i * WEEK));
  const target = floorDiv(raws.reduce((t, x) => t + x, 0), S);
  return { base, min: lo, max: hi, smooth_weeks: S, ref_weeks: R, weeks_have: ks.length, collecting: ref === null,
           reference: ref, participants: have.has(M - WEEK) ? have.get(M - WEEK) : null, raw: raws[0], raws, target };
}
const gscaleOf = (inp, c, now) => gscale(inp.gweeks || [], weekStart(now, c.hour()), (k) => c.raw(k));
function guaranteeBase(c, inp, now) {
  if (inp && c.raw("guarantee_scaled")) return gscaleOf(inp, c, now).target;
  const t = pyInt(c.raw("incentive_guarantee_target"));
  return t > 0 ? t : budgetSum(c);
}
const weekTarget = (inp, c, now) => guaranteeBase(c, inp, now) + weekIssuance(inp, c, now);
/** Fort Knox ("fortknox") / the Casino vault ("casino") cap: fixed, or max(floor, pct x this week's guarantee target). */
function heistCap(inp, c, which, now) {
  let fixed, floor, pk;
  if (which === "fortknox") { fixed = pyInt(c.raw("fortknox_cap")); floor = pyInt(c.raw("fortknox_floor")); pk = "fortknox_cap_pct"; }
  else { fixed = pyInt(c.k("HEIST_VAULT_CAP")); floor = pyInt(c.k("HEIST_VAULT_MIN")); pk = "casino_cap_pct"; }
  const pct = String(c.raw("heist_cap_mode")) === "pct" && flag(inp, "layers");
  if (!pct) return fixed;
  return Math.max(floor, pyInt(weekTarget(inp, c, now) * pyFloat(c.raw(pk)) / 100.0));
}

// ── the week's grant budget record (pepe_treasury._tr_week, _tr_budget_left) ──
function budgetOf(inp, c, g, now) {
  let b = c.int("budget_" + g, BUDGETS[g] || 0);
  if (g === "activity") b += weekIssuance(inp, c, now);
  return b;
}
function resolveWeek(inp, c, now) {
  const eid = epochId(now, c.hour());
  let w = inp.week && typeof inp.week === "object" ? JSON.parse(JSON.stringify(inp.week)) : null;
  if (!w || w.id !== eid) {
    w = { id: eid, budgets: {}, spent: {}, share: null, release_per_day: null };
    for (const g of GROUPS) { w.budgets[g] = budgetOf(inp, c, g, now); w.spent[g] = 0; }
  }
  w.budgets = w.budgets || {};
  w.spent = w.spent || {};
  for (const g of GROUPS) {
    const b = budgetOf(inp, c, g, now);
    w.budgets[g] = (b < 0 && !UNCAPPABLE.has(g)) ? UNCAPPED : Math.max(0, b);
    if (!(g in w.spent)) w.spent[g] = 0;
  }
  return w;
}
const paceOf = (c, g) => c.int("pace_" + g, PACED.has(g) ? 7 : 0);
function budgetLeft(inp, c, g, now) {
  const w = resolveWeek(inp, c, now);
  let budget = pyInt(g in w.budgets ? w.budgets[g] : (BUDGETS[g] || 0));
  if (budget < 0) return Math.max(0, pool(inp, INCENTIVES));
  const pace = paceOf(c, g);
  if (pace > 0) {
    const start = weekStart(now, c.hour());
    const day = Math.max(1, Math.min(7, pyInt(floorDivF(now - start, 86400)) + 1));
    budget = floorDiv(budget * Math.min(day, pace), pace);
  }
  return Math.max(0, budget - pyInt(w.spent[g] || 0));
}

// ── Fed loans (econ_layers.fed_loans) ──
function loansByVault(inp) {
  const out = {};
  for (const r of (inp.fed_loans || []).slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))) {
    if (r.state !== "open") continue;
    out[r.vault] = (out[r.vault] || 0) + pyInt(r.outstanding);
  }
  for (const k of Object.keys(out)) if (!(out[k] > 0)) delete out[k];
  return out;
}
const poolOwed = (inp, v) => (inp.fed_loans || []).filter((r) => r.state === "open" && r.vault === v).reduce((s, r) => s + pyInt(r.outstanding), 0);

// ── the Treasury targets (pepe_treasury._tr_target, force=True) ──
function bankPeak(inp, c, now) {
  const cutoff = now - c.int("bank_peak_days", 30) * 86400;
  const lent = Math.max(0, pyInt(Number(inp.bank_nav) - pool(inp, "bank")));
  let m = lent;
  for (const [t, a] of inp.bank_lent || []) if (Number(t) >= cutoff) m = Math.max(m, pyInt(a));
  return m;
}
function target(inp, c, v, now) {
  if (v === "house") return c.int("house_target", 15000000);
  if (v === "bank") {
    const mult = c.int("bank_lent_mult_pct", 200) / 100.0;
    return pyInt(Math.max(c.int("bank_target", 2000000), mult * bankPeak(inp, c, now)));
  }
  if (v === "mm") return pyInt(Math.max(pyInt(c.k("VAULT_MM_MIN_TARGET")), pyInt(inp.mm_seeds) * pyFloat(c.k("VAULT_TARGET_MULT"))));
  return null;
}

// ── the weekly epoch ──
function holdersGet(list, k) {
  for (const [hk, sh] of list || []) if (hk === k) return Number(sh);
  return 0;
}
/**
 * P2.1 - pepe_vaults.pat_days_avg: {stash id: average staked value} = the PAT-days in the buckets (lastBoundary, boundary]
 * / days, or null when the vault has no bucket for `boundary` (the caller then uses the snapshot). lastBoundary 0 = no
 * earlier settled epoch: the boundary's own bucket only. st.pat_days is the inputs' ordered list
 * [[boundary, [[stash id, PAT-days], ...]], ...] (pepe_policyinputs / policy/gather.js); buckets in ascending order, stashes
 * in each bucket's order; an "s<digits>" key is read as the stash id <digits>.
 */
function patDaysAvg(st, boundary, lastBoundary, days) {
  const pdl = st && Array.isArray(st.pat_days) ? st.pat_days : null;
  if (!pdl || boundary === undefined || boundary === null) return null;
  const bkey = String(Math.trunc(Number(boundary)));
  if (!pdl.some((x) => Array.isArray(x) && String(x[0]) === bkey && Array.isArray(x[1]))) return null;
  if (!days || !(Number(days) > 0)) return null;
  const lb = Number(lastBoundary || 0);
  const keys = pdl.filter((x) => Array.isArray(x) && Array.isArray(x[1])
    && (String(x[0]) === bkey || (lb > 0 && lb < Number(x[0]) && Number(x[0]) < Number(boundary))));
  keys.sort((a, b) => Number(a[0]) - Number(b[0]));
  const out = new Map();
  for (const [, rows] of keys) {
    for (const [k, x] of rows) {
      let sid = String(k);
      if (/^s\d+$/.test(sid)) sid = sid.slice(1);
      out.set(sid, (out.has(sid) ? out.get(sid) : 0.0) + Number(x));
    }
  }
  const res = new Map();
  for (const [sid, x] of out) res.set(sid, x / Number(days));
  return res;
}
/**
 * D2's safeguard (camfrog-bot 31c65d0, pepe_vaults.pat_days_whole): is the epoch that settles at `boundary` WHOLLY
 * time-weighted? The bucket for `boundary` must exist AND some bucket must be older than the first one patDaysAvg sums
 * ((lastBoundary, boundary], or the boundary's own) - a bucket only gets PAT-days from a cut-off inside its week, so an older
 * one proves the PAT-days were accruing before the first of those weeks began. Without one the PAT-days began mid-way (the
 * first week after the deploy) or a week of them is missing (pruned: PD_KEEP), so a stake made before they began weighs as if
 * held from then: planEpoch then pays that vault under the reference cap (TR_FALLBACK_CAP) instead of no cap. st.pat_days is
 * the inputs' list (patDaysAvg). Python's min() of nothing would raise; it can't happen for a whole-second boundary (the
 * boundary's own bucket is always among those summed) - false (the cap) here. -> true / false
 */
function patDaysWhole(st, boundary, lastBoundary) {
  const pdl = st && Array.isArray(st.pat_days) ? st.pat_days : null;
  if (!pdl || boundary === undefined || boundary === null) return false;
  const rows = pdl.filter((x) => Array.isArray(x) && Array.isArray(x[1]));
  const bkey = String(Math.trunc(Number(boundary)));
  if (!rows.some((x) => String(x[0]) === bkey)) return false;
  const B = Number(boundary);
  const lb = Number(lastBoundary || 0);
  const keys = rows.map((x) => Number(x[0]));
  const used = keys.filter((k) => k === B || (lb > 0 && lb < k && k < B));
  if (!used.length) return false;
  const first = Math.min(...used);
  return keys.some((k) => k < first);
}
/**
 * {stash id: staked value in vault v} (a Map in Python's insertion order) - pepe_treasury._tr_stakers.
 * P2.1 (staking fix plan, required with D2 2026-10-19): with `boundary` and the vault holding a PAT-days bucket for it
 * (capital/vaults.js accruePatDays on the site's cut-off, pepe_vaults.accrue_pat_days on Pepe's local one), each stash's
 * value is its AVERAGE stake over the epoch (patDaysAvg): a stake made at the cut-off right before the payout counts 0, one
 * held all week counts in full (even if it left before Monday). The cap (planEpoch) reads the same values. Without the bucket
 * (a book from before P2.1): the holdings now, the Auto fund looked through (as before). Only stashes that still exist
 * (inputs.stashes) get a share.
 */
function stakers(inp, v, prices, boundary, lastBoundary, days) {
  const st = (inp.vaults || {})[v] || {};
  const live = inp.stashes || {};
  if (boundary !== undefined && boundary !== null) {
    const avg = patDaysAvg(st, boundary, lastBoundary, days);
    if (avg) {
      const res = new Map();
      for (const [id, val] of avg) if (val > 0 && live[id]) res.set(id, val);
      return res;
    }
  }
  const h = st.holders || [];
  const price = Number(prices[v] || 0);
  const out = new Map();
  for (const [k, sh] of h) {
    if (k === PROTOCOL || k === AUTO || !String(k).startsWith("s")) continue;
    const id = String(k).slice(1);
    out.set(id, (out.has(id) ? out.get(id) : 0.0) + Number(sh) * price);
  }
  const autoSh = holdersGet(h, AUTO);
  const a = inp.auto || {};
  const atot = Number(a.total || 0);
  if (autoSh > 0 && atot > 0) {
    for (const [k, ash] of a.holders || []) {
      if (String(k).startsWith("s") && Number(ash) > 0) {
        const id = String(k).slice(1);
        out.set(id, (out.has(id) ? out.get(id) : 0.0) + Number(ash) / atot * autoSh * price);
      }
    }
  }
  const res = new Map();
  for (const [id, val] of out) if (val > 0 && live[id]) res.set(id, val);
  return res;
}
function planEpoch(inp) {
  const c = C(inp);
  const now = Number(inp.now);
  const eid = inp.eid || epochId(now, c.hour());
  const prices = inp.prices || {};
  const fed = pool(inp, FED);
  let fedRun = fed;
  const boundary = weekStart(now, c.hour());
  const prev = (inp.journal || []).filter((r) => r.state === "done" && r.eid !== eid).map((r) => Number(r.boundary || 0));
  const lb = prev.length ? Math.max(...prev) : 0.0;
  const days = lb && boundary > lb ? Math.max(1.0, Math.min(28.0, (boundary - lb) / 86400)) : 7.0;
  const fedTarget = c.int("fed_ceiling", 150000000);
  const plan = { epoch: eid, boundary, ts: now, days, fed_before: fed, fed_target: fedTarget, fed_cap: fedTarget, vaults: {}, legs: [], totals: {} };
  const minMove = pyInt(c.k("VAULT_MIN_MOVE"));
  // P1.1: Pepe's _tr_staker_cap - the bonus cap's own knob (the daily ceiling keeps VAULT_CEIL_APR)
  const ceil = stakerCap(c);
  const loans = loansByVault(inp);
  const stakerShare = c.share("staker_share_pct", 0.20);
  const fedSplit = c.share("fed_split_pct", 0.5);
  plan.staker_share = stakerShare;
  plan.fed_split = fedSplit;
  for (const v of TREASURY) {
    const st = (inp.vaults || {})[v];
    if (!st) continue;
    const price = Number(prices[v] || 0);
    const nav = Number((inp.navs || {})[v]);
    const tgt = pyInt(target(inp, c, v, now));
    const protVal = holdersGet(st.holders, PROTOCOL) * price;
    const basis = st.basis === undefined || st.basis === null ? protVal : pyFloat(st.basis);
    const earnings = protVal - basis;
    const cash = pool(inp, CASH[v]);
    const free = Math.max(0, cash - (v === "house" ? pyInt(c.k("HOUSE_MIN_CASH")) : 0));
    const raw = pyInt(Math.max(0.0, Math.min(nav - tgt, earnings, free)));
    const surplus = raw >= minMove ? raw : 0;
    const repay = Math.min(surplus, pyInt(loans[v] || 0));
    fedRun += repay;
    const afterRepay = surplus - repay;
    const poolShare = pyInt(afterRepay * stakerShare);
    const stk = poolShare > 0 ? stakers(inp, v, prices, boundary, lb, days) : new Map();
    let staked = 0;
    for (const x of stk.values()) staked += x;
    // D2: wf_staker_cap_pct 0 = NO cap - the stakers get their full share (staker_share_pct of the surplus after any Fed loan),
    // but only on a week that is WHOLLY time-weighted: otherwise (no PAT-days bucket, or PAT-days that began mid-week - the
    // first week after the deploy) the vault is paid under the 25% reference cap (D2's safeguard, pepe_treasury._tr_plan:
    // cap_v = TR_FALLBACK_CAP when cap_v <= 0 and pool > 0 and the week's weighting isn't "pat_days")
    let capV = ceil;
    if (capV <= 0 && poolShare > 0 && !patDaysWhole(st, boundary, lb)) capV = TR_FALLBACK_CAP;
    const cap = capV > 0 ? pyInt(staked * capV * days / 365) : poolShare;
    const give = Math.min(poolShare, cap);
    const paid = [];
    if (give > 0 && staked > 0) {
      for (const [vid, val] of [...stk.entries()].sort((a, b) => cmpPy(a[0], b[0]))) {
        const amt = pyInt(give * val / staked);
        if (amt > 0) paid.push([vid, amt]);
      }
    }
    const stkPaid = paid.reduce((s, x) => s + x[1], 0);
    const rest = afterRepay - stkPaid;
    let fedPart = 0;
    const fedBeforeV = fedRun;
    if (fedRun < fedTarget && rest > 0) fedPart = Math.min(pyInt(rest * fedSplit), fedTarget - fedRun);
    const inc = rest - fedPart;
    fedRun += fedPart;
    plan.vaults[v] = { nav: pyInt(nav), target: tgt, price: pyRoundN(price, 8), protocol_value: pyInt(protVal), basis: pyInt(basis),
                       earnings: pyInt(earnings), free_cash: free, surplus, fed_loan_repaid: repay, stakers_share: poolShare,
                       staked: pyInt(staked), apr_cap: cap, stakers: stkPaid, stakers_n: paid.length, fed: fedPart, incentives: inc,
                       phase: fedBeforeV < fedTarget ? "split" : "80" };
    const src = CASH[v];
    for (const [vid, amt] of paid) plan.legs.push({ tid: `wf-${eid}-${v}-stk-${vid}`, src, dst: `stash:${vid}`, amt, why: "waterfall stakers", vault: v });
    if (repay) plan.legs.push({ tid: `wf-${eid}-${v}-loan`, src, dst: FED, amt: repay, why: "vault fed loan repaid", vault: v });
    if (fedPart) plan.legs.push({ tid: `wf-${eid}-${v}-fed`, src, dst: FED, amt: fedPart, why: "waterfall fed", vault: v });
    if (inc) plan.legs.push({ tid: `wf-${eid}-${v}-inc`, src, dst: INCENTIVES, amt: inc, why: "waterfall incentives", vault: v });
  }
  const tot = {};
  for (const k of ["surplus", "stakers", "fed", "incentives", "fed_loan_repaid"]) tot[k] = Object.values(plan.vaults).reduce((s, x) => s + x[k], 0);
  plan.totals = tot;
  plan.fed_after = fedRun;
  plan.release_per_day = floorDiv(tot.incentives, 7);
  return plan;
}

/** The last settled boundary before `eid` (pepe_treasury._tr_last_boundary; planEpoch's lb): the newest done journal record of
 *  another epoch, else 0. */
function lastBoundaryOf(inp, eid) {
  const prev = (inp.journal || []).filter((r) => r.state === "done" && r.eid !== eid).map((r) => Number(r.boundary || 0));
  return prev.length ? Math.max(...prev) : 0.0;
}
/** How planEpoch split vault v's stakers' share - pepe_treasury._tr_weighting: "pat_days" (the week is WHOLLY time-weighted,
 *  patDaysWhole), "partial" (the boundary's PAT-days bucket exists but the PAT-days began mid-way: split by them, the
 *  reference cap applies while no cap is in force) or "snapshot" (no bucket: the holdings at the settlement, the reference cap
 *  applies). */
function weightingFor(st, boundary, lb, days) {
  if (patDaysWhole(st, boundary, lb)) return "pat_days";
  return patDaysAvg(st, boundary, lb, days) !== null ? "partial" : "snapshot";
}
/** {vault: weighting} for a plan (weightingFor, the same lastBoundary / days as planEpoch) - for the payout notice's words
 *  (policy/apply.js notifyStakers); not part of the plan, which stays Pepe's _tr_plan to the PAT. */
function weightingOf(inp, plan) {
  const lb = lastBoundaryOf(inp, plan.epoch);
  const out = {};
  for (const v of Object.keys(plan.vaults || {})) out[v] = weightingFor((inp.vaults || {})[v] || {}, plan.boundary, lb, plan.days);
  return out;
}
/**
 * pepe_treasury._tr_track, kept on the epoch record next to the plan (never part of it): per vault the stakers' pool (their
 * share of the surplus), what the plan pays them, what a TR_TRACK_CAP (25%) APR cap WOULD have paid - min(pool, int(staked x
 * 25% x days / 365)) -, how the stakes were weighted (weightingFor), the cap the plan applied (cap_pct, % APR - D2's safeguard:
 * the reference cap when no cap is in force and the week isn't wholly time-weighted: fallback) and the payout's own APR on the
 * stakers' stake. -> {ref_cap_pct, cap_in_force_pct, vaults: {v: {pool, paid, cap25, would25, weighting, cap_pct, fallback,
 * payout_apr?}}, pool, paid, would25, fallback: [vaults]}
 */
function trackOf(inp, plan) {
  const c = C(inp);
  const days = Number(plan.days || 7.0);
  const lb = lastBoundaryOf(inp, plan.epoch);
  const cin = stakerCap(c);
  const out = { ref_cap_pct: pyRoundN(TR_TRACK_CAP * 100, 4), cap_in_force_pct: pyRoundN(cin * 100, 4), vaults: {}, pool: 0, paid: 0, would25: 0, fallback: [] };
  for (const [v, x] of Object.entries(plan.vaults || {})) {
    const pool = pyInt(x.stakers_share || 0), staked = pyInt(x.staked || 0), paid = pyInt(x.stakers || 0);
    const c25 = pyInt(staked * TR_TRACK_CAP * days / 365);
    const would = Math.min(pool, c25);
    const w = weightingFor((inp.vaults || {})[v] || {}, plan.boundary || 0, lb, days);
    const fb = cin <= 0 && pool > 0 && w !== "pat_days";
    const row = { pool, paid, cap25: c25, would25: would, weighting: w, cap_pct: pyRoundN((fb ? TR_FALLBACK_CAP : cin) * 100, 4), fallback: fb };
    if (paid > 0 && staked > 0) row.payout_apr = pyRoundN(paid / staked * 365 / days, 6);
    out.vaults[v] = row;
    if (fb) out.fallback.push(v);
    out.pool += pool;
    out.paid += paid;
    out.would25 += would;
  }
  return out;
}

// ── the daily release ──
function overflowLegs(inp, did, src, loanVault, over, tag) {
  const legs = [];
  if (over <= 0) return [legs, 0];
  const owed = poolOwed(inp, loanVault);
  const repay = Math.min(pyInt(over), owed);
  if (repay > 0) legs.push({ tid: `tr-${did}-${tag}-loan`, src, dst: FED, amt: repay, why: "vault fed loan repaid", vault: loanVault });
  if (over - repay > 0) legs.push({ tid: `tr-${did}-${tag}`, src, dst: INCENTIVES, amt: pyInt(over - repay), why: `${src === FORTKNOX ? "fortknox" : "casino"} overflow` });
  return [legs, repay];
}
function planDaily(inp) {
  const c = C(inp);
  const now = Number(inp.now);
  const did = inp.did || dayId(now, c.hour());
  const fk = pool(inp, FORTKNOX), heist = pool(inp, CASINO), inc = pool(inp, INCENTIVES);
  const over = Math.max(0, fk - heistCap(inp, c, "fortknox", now));
  const fkAfter = fk - over;
  const ccap = heistCap(inp, c, "casino", now);
  const cOver = ccap > 0 ? Math.max(0, heist - ccap) : 0;
  const heistAfter = heist - cOver;
  const casinoFloor = pyInt(c.k("HEIST_VAULT_MIN"));
  const need = { [FORTKNOX]: Math.max(0, c.int("fortknox_floor", 2000000) - fkAfter), [CASINO]: Math.max(0, casinoFloor - heistAfter) };
  const tot = need[FORTKNOX] + need[CASINO];
  const pay = Object.assign({}, need);
  if (tot > inc) {
    pay[FORTKNOX] = tot ? floorDiv(inc * need[FORTKNOX], tot) : 0;
    pay[CASINO] = Math.min(need[CASINO], inc - pay[FORTKNOX]);
  }
  let [legs, fkRepaid] = overflowLegs(inp, did, FORTKNOX, "fortknox", over, "fkover");
  const [cLegs, cRepaid] = overflowLegs(inp, did, CASINO, "casino", cOver, "casinoover");
  legs = legs.concat(cLegs);
  for (const [dst, tag] of [[FORTKNOX, "fk"], [CASINO, "casino"]]) {
    if (pay[dst] > 0) legs.push({ tid: `tr-${did}-floor-${tag}`, src: INCENTIVES, dst, amt: pyInt(pay[dst]), why: "floor top-up" });
  }
  const w = resolveWeek(inp, c, now);
  return { day: did, fortknox: fk, casino: heist, incentives: inc, overflow: over, overflow_to: INCENTIVES, overflow_loan_repaid: fkRepaid,
           casino_overflow: cOver, casino_overflow_loan_repaid: cRepaid, floor_need: need,
           floor_paid: { [FORTKNOX]: pyInt(pay[FORTKNOX]), [CASINO]: pyInt(pay[CASINO]) }, floor_short: pyInt(tot - (pay[FORTKNOX] + pay[CASINO])),
           release: w.release_per_day === undefined ? null : w.release_per_day,
           grant_remaining: Object.fromEntries(GROUPS.map((g) => [g, budgetLeft(inp, c, g, now)])), legs };
}

// ── the monetary day ──
/** {login: [lines, mic]} of the day's ACTIVE people (summed over rooms, in the rows' order; Pepe and bots left out). */
function activity(inp, day) {
  const skip = new Set((inp.skip || []).map((s) => String(s).toLowerCase()));
  const agg = new Map();
  for (const [d, login, lines, mic] of inp.rows || []) {
    if (d !== day) continue;
    const lg = String(login || "").toLowerCase();
    if (!lg) continue;
    if (!agg.has(lg)) agg.set(lg, [0, 0.0]);
    const a = agg.get(lg);
    a[0] += pyInt(lines || 0);
    a[1] += Number(mic || 0);
  }
  const out = new Map();
  for (const [lg, [lines, mic]] of agg) {
    if (skip.has(lg)) continue;
    if (lines >= ACT_MIN_LINES || mic >= ACT_MIN_MIC) out.set(lg, [lines, mic]);
  }
  return out;
}
function activityScale(inp, localDay) {
  const n = activity(inp, localDay).size;
  const counts = [];
  for (const d of (inp.days || []).slice(1)) {
    const k = activity(inp, d).size;
    if (k) counts.push(k);
  }
  const avg = counts.length ? counts.reduce((s, x) => s + x, 0) / counts.length : 0.0;
  if (avg <= 0) return [1.0, n, avg];
  return [Math.max(ACT_SCALE_MIN, Math.min(ACT_SCALE_MAX, n / avg)), n, avg];
}
function issuancePlan(inp, c, now, localDay) {
  const mode = String(c.raw("issuance_mode"));
  const out = { mode, amount: 0, base: 0, scale: 1.0, active: null, avg: null, supply: null, local_day: localDay };
  if (mode !== "pct" && mode !== "fixed") return out;
  let monthly;
  if (mode === "pct") {
    const supply = inp.supply === undefined ? null : inp.supply;
    out.supply = supply;
    if (!supply) { out.error = "total supply unknown (the site didn't answer) - retried"; return out; }
    monthly = supply * pyFloat(c.raw("issuance_pct_month")) / 100.0;
  } else {
    monthly = pyFloat(c.raw("issuance_fixed_month"));
  }
  const base = pyInt(monthly / 30);
  let scale = 1.0;
  if (c.raw("issuance_activity_scaling")) {
    const [s, n, avg] = activityScale(inp, localDay);
    scale = s;
    out.active = n;
    out.avg = pyRoundN(avg, 1);
  }
  let amt = pyInt(base * scale);
  const room = capRoom(inp, c, "issuance", now);
  if (room !== null && amt > room) { out.capped_from = amt; amt = room; }
  Object.assign(out, { base, scale: pyRoundN(scale, 3), amount: Math.max(0, amt) });
  return out;
}
function activityAllowance(inp, c, now, incAvail) {
  if (!c.raw("activity_rewards")) return 0;
  if (flag(inp, "ap_on")) return 0;
  const left = budgetLeft(inp, c, "activity", now);
  return Math.max(0, Math.min(left, pyInt(incAvail)));
}
function planMonetary(inp) {
  const c = C(inp);
  const now = Number(inp.now);
  const did = inp.did || dayId(now, c.hour());
  const guarantee = !!inp.guarantee;
  const fed0 = pool(inp, FED), inc0 = pool(inp, INCENTIVES);
  const floor = pyInt(c.raw("fed_floor")), ceiling = pyInt(c.raw("fed_ceiling")), daily = pyInt(c.raw("fed_floor_mint_daily"));
  const gTarget = guarantee ? weekTarget(inp, c, now) : null;
  let gBase = inc0;
  if (guarantee) {
    const e = epochId(now, c.hour());
    const j = (inp.journal || []).find((r) => r.eid === e) || {};
    if (j.state === "done" && j.incentives_after !== undefined && j.incentives_after !== null) gBase = pyInt(j.incentives_after);
  }
  const gWant = guarantee ? Math.max(0, gTarget - gBase) : 0;
  const localDay = inp.local_day;
  const iss = issuancePlan(inp, c, now, localDay);
  const issRaw = pyInt(iss.amount);
  const need = Math.max(0, floor - (fed0 + issRaw - gWant));
  const room = capRoom(inp, c, "floor", now);
  const floorMint = room === null ? Math.min(need, daily) : Math.min(need, daily, room);
  const pre = fed0 + floorMint - Math.min(gWant, fed0 + floorMint);
  if (issRaw > 0 && pre + issRaw > ceiling) { iss.ceiling_cut_from = issRaw; iss.amount = Math.max(0, ceiling - pre); }
  const gPay = Math.min(gWant, fed0 + floorMint + pyInt(iss.amount));
  const fed1 = fed0 + floorMint + pyInt(iss.amount) - gPay;
  const excess = Math.max(0, fed1 - ceiling);
  const action = String(c.raw("fed_ceiling_action"));
  const incAvail = inc0 + gPay + (action !== "burn" ? excess : 0);
  const actAmt = activityAllowance(inp, c, now, incAvail);
  const legs = [];
  if (floorMint > 0) legs.push({ kind: "mint", policy: "floor", amount: floorMint, key: `floor-${did}`, dest: FED, reason: `Fed floor: back up to ${fmt(floor)} (${did})` });
  if (iss.amount > 0) legs.push({ kind: "mint", policy: "issuance", amount: pyInt(iss.amount), key: `iss-${did}`, dest: FED,
                                  reason: `organic issuance ${did} (${iss.mode}, x${pyFloatStr(iss.scale)}) into the Fed` });
  if (gPay > 0) legs.push({ kind: "move", tid: `mo-${did}-guarantee`, src: FED, dst: INCENTIVES, amt: gPay, why: "incentive guarantee" });
  if (excess > 0) legs.push({ kind: action === "burn" ? "burn" : "move", tid: `mo-${did}-ceiling`, src: FED, dst: action === "burn" ? "burn" : INCENTIVES,
                              amt: excess, why: "fed ceiling release" });
  const apOn = flag(inp, "ap_on");
  return { day: did, ts: now, fed: fed0, incentives: inc0, floor, ceiling, floor_daily: daily, floor_need: need, floor_room: room,
           floor_mint: floorMint, guarantee, guarantee_target: gTarget, guarantee_want: gWant, guarantee_base: gBase, guarantee_paid: gPay,
           fed_after: fed1 - excess, excess, ceiling_action: action, issuance: iss,
           activity: { on: !!c.raw("activity_rewards") && !apOn, to_pads: apOn, amount: pyInt(actAmt), local_day: localDay }, legs };
}
/** pepe_monetary._mo_activity_plan: [[login, PAT], ...] in Python's sorted order. */
function planActivity(inp, localDay, amount) {
  const act = activity(inp, localDay);
  const scores = [];
  for (const [lg, [lines, mic]] of act) {
    const s = Math.min(ACT_SCORE_CAP, pyRound0(lines + 2 * mic));
    if (s > 0) scores.push([lg, s]);
  }
  const tot = scores.reduce((t, x) => t + x[1], 0);
  amount = pyInt(amount);
  if (amount <= 0 || tot <= 0) return [];
  return scores.sort((a, b) => cmpPy(a[0], b[0])).map(([lg, s]) => [lg, floorDiv(amount * s, tot)]).filter((x) => x[1] > 0);
}

module.exports = { planEpoch, planDaily, planMonetary, planActivity, weekStart, dayStart, epochId, dayId, monthOf, resolveWeek, budgetLeft,
                   capRoom, mintsMtd, weekIssuance, weekTarget, heistCap, guaranteeBase, gscale, gscaleOf, WEEK, budgetSum, loansByVault, poolOwed, target, stakers,
                   activity, patDaysAvg, patDaysWhole, weightingFor, weightingOf, lastBoundaryOf, trackOf, stakerCapOf, TR_TRACK_CAP, TR_FALLBACK_CAP, floorDiv, floorDivF, pyInt, fmt, pyFloatStr, cmpPy, C, BUDGETS, GROUPS, CAPPED, SOURCES, TREASURY, CASH, FED,
                   INCENTIVES, FORTKNOX, CASINO, GUARANTEE_WAIT, DEFAULTS, CONSTS };
