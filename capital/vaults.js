// capital/vaults.js — Phase 3: the staking capital vaults (pepe_vaults.py) owned by the site.
//
//   🏦 bank   funds Federal Reserve loans    NAV = "bank" cash + principal still out on bank-funded loans (not insured / written off)
//   🎰 house  IS the casino jackpot          NAV = SUM(jackpot_rakes)
//   📈 mm     seeds the LMSR markets         NAV = "mm" cash + the open markets it seeded, marked to market (capital/lmsr.mmValue)
//   🤖 auto   a fund of the three            NAV = its shares in each vault x their prices
// ERC-4626-style shares: holders (the protocol, the Auto fund, each stash "s<id>") own shares; a share is worth NAV / total.
// Stake / unstake requests queue (a stake's PAT leaves the stash into "vaultfloat" at once) and run at the daily 04:00 UTC
// cut-off at that day's prices: the APR ceiling (stakers' growth above it moves to the protocol, high-water mark), the v1
// floor top-up, the v1 protocol dividend (economy v2: Pepe's weekly waterfall instead), the queue oldest first (withdrawals
// wait for free cash), the Auto rebalance, the epoch snapshot. The whole cut-off is ONE transaction.
// Pepe still runs the policy engines (Phase 4: the Fed, the treasury waterfall, flash liquidity, the Casino-vault feed); when
// they add or take protocol capital they book its shares here (op "protocol", keyed). The maths is pepe_vaults.py's,
// expression for expression; the doc keeps Pepe's vaults.json shape for the keys the site owns (SITE_KEYS).
//
// Staking fix plan (2026-10-19, P0.3 / P1.2 / P2.1 / P2.2 / §6) and the owner's decisions of that day:
//   * D1 - the daily APR ceiling: ceil_apr (Pepe's vault_ceil_apr) > 0 runs it, 0 (or anything not a positive number) means
//     NO ceiling: no skim, no give-back, the cushion untouched (ceilingOn) - but the high-water mark keeps TRACKING the price
//     (ceilingOffStep, camfrog-bot 31c65d0), so switched back on it caps only new highs. The owner turns it off ("let's see
//     where it lands naturally"); the operator flips it after the deploy.
//   * option A, built dark: ceilingStep() is pepe_vaults.ceiling_step - a gain above the cap is skimmed to the protocol as
//     before and every skim is RECORDED in the vault's cushion (st.cushion = [[ts, shares], ...], oldest first, kept
//     CUSHION_KEEP_DAYS); with the switch on (cfg.ceil_cushion, Pepe's vault_ceil_cushion; it ships
//     OFF) a losing day gives the stakers back, from the protocol's shares, up to what the last ceil_cushion_days of skims
//     took from them, and the high-water mark is re-based so the covered part is not "recovered" twice. Off: the old maths.
//   * P2.1 - the weekly payout is TIME-WEIGHTED: each cut-off adds every stash's look-through value x the days it held it
//     (the day just ended, before the queue runs) to d.v[v].pat_days[<the Monday boundary that settles it>][<stash id>]
//     (accruePatDays); the waterfall pays stakers by PAT-days, so a stake seconds before Monday's payout earns nothing.
//   * P2.2 - Auto deposits (and the Auto rebalance) obey the staker limit (staker_max) like a direct stake, behind
//     cfg.auto_staker_cap (Pepe's vault_auto_staker_cap; it ships OFF).
//   * every cut-off snapshot carries staker_index (what 1 PAT staked in a vault is worth to a staker: the price change x the
//     skim / give-back factor) - the stakers' APR on /staking and the audit read it;
//   * d.cost[stash][vault] = {in, out[, partial: 1]}: what each stash put in (deposit legs, refunds excluded) and took out
//     (withdrawal legs); partial = the stash held that vault before its cost history began (the first costed request found
//     shares already there, or the backfill couldn't explain the holding) - /staking then shows Staked and P/L as unknown;
//   * d.pd_from: when the PAT-days started (the start of the first interval ever accrued) - shown on the card / page. Whether
//     a week is wholly time-weighted is Pepe's BUCKET rule (pdWhole / pdPartial = pepe_vaults.pat_days_whole, camfrog-bot
//     31c65d0): with no weekly cap in force, a week that isn't settles under the 25% reference cap (D2's safeguard - Pepe's
//     _tr_plan and policy/engines planEpoch); capital/watch.js alerts a week paid with no cap that wasn't;
//   * every cut-off snapshot records the rule it ran with (ceil_apr: the ceiling, 0 = off; ceil_cushion 0 / 1) - Pepe's
//     pepe_stakingreplay reads them first (his local snapshots carry the same keys);
//   * audit(): the invariants of fix plan §6 (I1-I5, I8, I10), in the cut-off's notes; capital/watch.js alerts the admins.
"use strict";
const C = require("./core");
const X = require("./lmsr");

const VAULTS = ["bank", "house", "mm"];
const AUTO = "auto", PROTOCOL = "protocol";
const CASH = { bank: "bank", house: "jackpot", mm: "mm" };
const LABEL = { bank: "🏦 Bank", house: "🎰 House", mm: "📈 Market maker", auto: "🤖 Auto" };
const SITE_KEYS = ["v", "auto", "queue", "epochs", "seq", "apr_base", "next_epoch", "dividends", "rebalances", "insured", "v2_defaults", "inited", "cost"];
// a cushion entry still counts while entry_ts >= now - days x 86400 - CUSHION_SLACK (a cut-off runs a few seconds after 04:00
// UTC, so the one exactly `days` days back is in the window) - pepe_vaults.CUSHION_SLACK
const CUSHION_SLACK = 600;
const CUSHION_KEEP_DAYS = 31;            // how long a skim stays in st.cushion (pepe_vaults.CUSHION_KEEP_DAYS; the window a give-back USES is at most this)
const CUSHION_MAX_DAYS = 30;             // the admin card's (and the seed's) longest window
const PD_KEEP = 4;                       // P2.1: PAT-days buckets kept per vault (the newest by boundary)
const REPLAY_CEIL = 0.25;                // replayCeiling: the ceiling a snapshot with no recorded rule ran with (pepe_stakingreplay.DEFAULT_CEIL)
const PD_SLACK = 600;                    // the old pd_from rule's slack (a bucket was whole when pd_from <= its week's start + this) - pdPartial now follows Pepe's bucket rule
const LATE_MONDAY = 3600;                // Pepe's TR_CUTOFF_WAIT: his weekly settlement waits at most this long past the boundary for the cut-off
const fmt = C.fmt;

// ── the doc ──
async function load() {
  const d = await C.doc("vaults", null);
  const out = d && typeof d === "object" ? d : {};
  out.v = out.v || {};
  out.auto = out.auto || { total: 0.0, holders: {} };
  out.queue = out.queue || {};
  out.epochs = out.epochs || [];
  out.seq = Number(out.seq) || 0;
  out.insured = out.insured || [];
  return out;
}
const store = (d) => C.putDoc("vaults", d);
async function live() {
  const c = await C.cfg();
  if (!Number(c.vaults_enabled) || !(await C.live())) return false;
  return !!(await load()).inited;
}

// ── NAV and prices ──
/** Everything the NAVs read, at this moment (in the caller's transaction): cash, the Bank's book, the Market maker's book. */
async function ctx() {
  const cash = { bank: await C.poolBalance("bank"), mm: await C.poolBalance("mm"), jackpot: await C.houseBalance() };
  let out = 0;
  for (const ln of await C.list("loan", ["funding", "active"])) {
    if (ln.funded_by === "bank" && !ln.insured && !ln.written_off) out += Math.max(0, Math.trunc(ln.principal) - Math.trunc(ln.paid || 0));
  }
  let seeds = 0, value = 0.0;
  for (const m of await C.list("market", ["open", "closed", "settling"])) {
    if (m.seed_from !== "mm" || m.model !== "lmsr" || m.paid_out) continue;
    seeds += Math.trunc(Number(m.seed) || 0);
    value += X.mmValue(m);
  }
  return { cash, loans_out: out, mm_book: { seeds, value }, cfg: await C.cfg() };
}
function nav(v, k) {
  if (v === "bank") return k.cash.bank + k.loans_out;
  if (v === "house") return k.cash.jackpot;
  if (v === "mm") return k.cash.mm + k.mm_book.value;
  return 0.0;
}
function prices(d, k, navDelta = null) {
  const p = {};
  for (const v of VAULTS) {
    const st = d.v[v] || {};
    const tot = Number(st.total || 0);
    p[v] = tot > 0 ? (nav(v, k) + (navDelta && navDelta[v] ? navDelta[v] : 0)) / tot : 1.0;
  }
  let anav = 0;
  for (const v of VAULTS) anav += Number(((d.v[v] || {}).holders || {})[AUTO] || 0) * p[v];
  p[AUTO] = Number(d.auto.total) > 0 ? anav / Number(d.auto.total) : 1.0;
  return p;
}
const freeCash = (v, k) => Math.max(0, Math.trunc(k.cash[CASH[v]]) - (v === "house" ? Math.trunc(Number(k.cfg.house_min_cash)) : 0));
function stakerValue(d, v, p) {
  let s = 0;
  for (const [hk, sh] of Object.entries((d.v[v] || {}).holders || {})) if (hk !== PROTOCOL) s += Number(sh);
  return s * p[v];
}
const holderKey = (stashId) => `s${stashId}`;
/** Python round(x, n): the exact value rounded half-even to n decimals, then the nearest double. */
function pyRoundN(x, n) {
  x = Number(x);
  if (!Number.isFinite(x) || x === 0) return x;
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2;
  if (exp === 0) e2 = -1074; else { mant |= 1n << 52n; e2 = exp - 1075; }
  // value = mant * 2^e2 ; scaled = value * 10^n
  let num = mant * 10n ** BigInt(n), den = 1n;
  if (e2 >= 0) num <<= BigInt(e2); else den <<= BigInt(-e2);
  let q = num / den;
  const r = num - q * den;
  if (2n * r > den || (2n * r === den && q % 2n === 1n)) q += 1n;
  return Number(`${sign < 0n ? "-" : ""}${q}e-${n}`);
}
const pyRound0 = (x) => Math.trunc(pyRoundN(x, 0));

// ── the Auto fund's targets: admin bands + trailing 30-day risk-adjusted yield ──
function autoTargets(d, c) {
  const eps = d.epochs.slice(-31);
  const score = {};
  for (const v of VAULTS) {
    const rs = [];
    for (let i = 0; i + 1 < eps.length; i++) {
      const pa = (eps[i].price || {})[v], pb = (eps[i + 1].price || {})[v];
      if (pa && pb) rs.push(pb / pa - 1);
    }
    if (rs.length >= 5) {
      let s = 0; for (const r of rs) s += r;
      const mean = s / rs.length;
      let s2 = 0; for (const r of rs) s2 += (r - mean) * (r - mean);
      const sd = Math.sqrt(s2 / rs.length);
      score[v] = Math.max(0.0, mean) / (sd + 1e-4);
    } else score[v] = { bank: 1.0, house: 0.6, mm: 0.4 }[v];
  }
  const lo = { bank: Number(c.auto_bank_min), house: 0.0, mm: 0.0 };
  const hi = { bank: 1.0, house: Number(c.auto_house_max), mm: Number(c.auto_mm_max) };
  const w = Object.assign({}, lo);
  let left = 1.0 - (w.bank + w.house + w.mm);
  for (let it = 0; it < 4; it++) {
    const room = {};
    for (const v of VAULTS) if (hi[v] - w[v] > 1e-9) room[v] = hi[v] - w[v];
    const rk = Object.keys(room);
    let ss = 0; for (const v of rk) ss += score[v];
    const tot = ss || rk.length;
    if (left <= 1e-9 || !rk.length) break;
    const add = {};
    for (const v of rk) add[v] = left * (ss ? score[v] / tot : 1 / rk.length);
    for (const v of rk) { const take = Math.min(add[v], room[v]); w[v] += take; left -= take; }
  }
  if (left > 1e-9) w.bank += left;
  return w;
}
function nextEpochTs(after, hour) {
  const t = new Date(after * 1000);
  const base = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), Math.trunc(hour), 0, 0) / 1000;
  return base > after ? base : base + 86400;
}

// ── PAT legs inside the cut-off (one transaction) ──
async function stashMove(stashId, amount, key, why) {
  const S = require("../stashes");
  const r = await S.botMove({ stashId, amount, key: `cap:${key}`.slice(0, 160), kind: "vault", why: why || "vault" });
  if (!r || !r.ok) throw new C.Refuse(409, `stash ${stashId} can't cover ${fmt(-amount)}`, "E_STASH", { stash: stashId });
  return r;
}
/** pepe_vaults._vault_transfer: src -> dst (a cash vault, the House "jackpot", "vaultfloat", "reserve" or "stash:<id>"). */
async function transfer(tid, src, dst, amount, why) {
  amount = Math.trunc(amount);
  if (!amount) return;
  const pools = [];
  if (src.startsWith("stash:")) await stashMove(src.slice(6), -amount, `${tid}:out`, why); else pools.push({ pool: src, amount: -amount });
  if (dst.startsWith("stash:")) await stashMove(dst.slice(6), amount, `${tid}:in`, why); else pools.push({ pool: dst, amount });
  if (pools.length) await C.legs(`cap:vt:${tid}`, pools, { kind: "capital", flow: "vaults", why: why || "vault move" });
}

// ── requests ──
async function request(actor, a, t) {
  const c = await C.cfg();
  if (!(await live())) return { ok: false, code: "not_live", error: "🏦 vaults are launching — try again in a few minutes." };
  const S = require("../stashes");
  const s = await S.get(a.stash);
  if (!s || s.closed) return { ok: false, code: "no_stash", error: "that stash doesn't exist (or is closed)." };
  // 1.99wy: only the stash's OWNER (an account; a chat login maps to its account through the link) stakes / unstakes it.
  // Pepe's own engine calls (actor.pepe) aren't a person.
  if (!actor.pepe && (actor.userId || actor.login || actor.username)) {
    const who = await S.actorOf({ userId: actor.userId || null, username: actor.username || null, login: actor.login || null });
    if (!S.isOwner(s, who)) return { ok: false, code: "not_owner", error: "only the stash's owner can stake or unstake it." };
  }
  const kind = a.kind === "withdraw" ? "withdraw" : "deposit";
  const vault = String(a.vault || (kind === "deposit" ? AUTO : "")).toLowerCase();
  if (![...VAULTS, AUTO].includes(vault)) return { ok: false, code: "bad_vault", error: "the vaults are bank, house, mm (market maker) and auto." };
  const d = await load();
  d.seq += 1;
  const qid = `q${d.seq}`;
  const item = { id: qid, stash: String(s.id), vault, kind, ts: t.nowS, state: "pending", by: actor.login || actor.username || null };
  if (kind === "deposit") {
    const amt = Math.trunc(Number(a.amount) || 0);
    if (amt < Number(c.min_move)) return { ok: false, code: "min", error: `stake at least PAT ${fmt(c.min_move)}.` };
    if (amt > S.free(s)) return { ok: false, code: "insufficient", error: `${s.owner_name}/${s.name} only has PAT ${fmt(S.free(s))} free.` };
    item.amount = amt;
    item.tid_hold = `${qid}-hold`;
    await transfer(item.tid_hold, `stash:${s.id}`, "vaultfloat", amt, "vault deposit");
    item.held = true;
  } else {
    const k = await ctx();
    const p = prices(d, k);
    const key = holderKey(s.id);
    const have = vault === AUTO ? Number(d.auto.holders[key] || 0) : Number(((d.v[vault] || {}).holders || {})[key] || 0);
    const pend = Object.values(d.queue).filter((q) => q.stash === String(s.id) && q.kind === "withdraw" && q.vault === vault && ["pending", "moving"].includes(q.state))
      .reduce((x, q) => x + Number(q.shares || 0), 0);
    const freeSh = Math.max(0.0, have - pend);
    const sh = a.all ? freeSh : (p[vault] > 0 ? Math.min(freeSh, Math.trunc(Number(a.amount) || 0) / p[vault]) : 0);
    if (!(sh > 0)) return { ok: false, code: "nothing", error: "nothing left to unstake there (a withdrawal may already be waiting)." };
    item.shares = sh;
    item.value = Math.trunc(sh * p[vault]);
  }
  d.queue[qid] = item;
  await store(d);
  return { ok: true, item, next_epoch: d.next_epoch };
}

// ── the cut-off ──
/** P2.2: Auto deposits obey the staker limit - cfg.auto_staker_cap (Pepe's vault_auto_staker_cap, 0 / 1; it ships OFF). */
const autoCapOn = (c) => { const x = Number((c || {}).auto_staker_cap); return Number.isFinite(x) && Math.trunc(x) > 0; };
/** The most a stake of `amt` may put into vault v and stay inside the staker limit - the direct stake's own expression
 *  (executeOne): max(0, trunc(staker_max x (NAV + amt) - stakers' value)). */
const stakerRoom = (d, v, amt, p, k, c) => Math.max(0, Math.trunc(Number(c.staker_max) * (nav(v, k) + amt) - stakerValue(d, v, p)));
/**
 * P2.2, pure - pepe_vaults.auto_capped_legs, the same expressions in the same order: an Auto deposit's legs [[vault, PAT]]
 * (VAULTS order) under the staker limit `smax`. Each leg a is cut to min(a, max(0, int(smax x (nav + a) - staked))) - a
 * direct stake's formula; the PAT cut then goes, in the vaults' order, to the vaults whose leg wasn't cut, each up to the same
 * formula on its new leg; what no vault takes is refunded (executeOne: amount - the legs). -> [[vault, PAT]] (0 included)
 */
function autoCappedLegs(legs, navs, staked, smax) {
  const capOf = (v, a) => Math.min(a, Math.max(0, Math.trunc(Number(smax) * (Number(navs[v]) + a) - Number(staked[v]))));
  const out = [];
  const room = [];
  let excess = 0;
  for (const [v, a0] of legs) {
    const a = Math.trunc(Number(a0) || 0);
    const cut = capOf(v, a);
    out.push([v, cut]);
    excess += a - cut;
    if (cut === a) room.push(out.length - 1);
  }
  for (const i of room) {
    if (excess <= 0) break;
    const v = out[i][0];
    const cut = capOf(v, out[i][1] + excess);
    if (cut > out[i][1]) { excess -= cut - out[i][1]; out[i][1] = cut; }
  }
  return out;
}
/** autoCappedLegs at the cut-off's NAVs and the stakers' value at the queue's prices. */
function capAutoLegs(d, legs, p, k, c) {
  const navs = Object.fromEntries(VAULTS.map((v) => [v, nav(v, k)]));
  const staked = Object.fromEntries(VAULTS.map((v) => [v, stakerValue(d, v, p)]));
  return autoCappedLegs(legs, navs, staked, Number(c.staker_max));
}
async function executeOne(d, q, p, k, c) {
  const key = holderKey(q.stash);
  if (q.kind === "deposit") {
    if (!q.held) return;
    const amt = Math.trunc(q.amount);
    let legs;
    if (q.vault === AUTO) {
      const w = autoTargets(d, c);
      legs = VAULTS.map((v) => [v, Math.trunc(amt * w[v])]);
      legs[0][1] += amt - legs.reduce((s, x) => s + x[1], 0);
      if (autoCapOn(c)) legs = capAutoLegs(d, legs, p, k, c);   // P2.2 (off: the legs as before)
    } else {
      const v = q.vault;
      const nv = nav(v, k);
      const stak = stakerValue(d, v, p);
      const cap = Math.max(0, Math.trunc(Number(c.staker_max) * (nv + amt) - stak));
      legs = [[v, Math.min(amt, cap)]];
    }
    const refund = amt - legs.reduce((s, x) => s + x[1], 0);
    Object.assign(q, { state: "moving", legs: Object.fromEntries(legs.filter((x) => x[1] > 0)), refund, prices: Object.fromEntries([...VAULTS, AUTO].map((v) => [v, p[v]])) });
  } else {
    const v = q.vault;
    let sh, legs;
    if (v === AUTO) {
      sh = Math.min(Number(q.shares), Number(d.auto.holders[key] || 0));
      const value = sh * p[AUTO];
      const hold = Object.fromEntries(VAULTS.map((x) => [x, Number(((d.v[x] || {}).holders || {})[AUTO] || 0)]));
      let tot = 0; for (const x of VAULTS) tot += hold[x] * p[x];
      tot = tot || 1;
      legs = VAULTS.map((x) => [x, Math.trunc(value * hold[x] * p[x] / tot)]);
      if (legs.some(([x, a]) => a > freeCash(x, k))) return;                 // waits for cash
    } else {
      sh = Math.min(Number(q.shares), Number(((d.v[v] || {}).holders || {})[key] || 0));
      const value = Math.trunc(sh * p[v]);
      if (value > freeCash(v, k)) return;
      legs = [[v, value]];
    }
    if (sh <= 0) { q.state = "done"; return; }
    Object.assign(q, { state: "moving", legs: Object.fromEntries(legs.filter((x) => x[1] > 0)), burn: sh, prices: Object.fromEntries([...VAULTS, AUTO].map((x) => [x, p[x]])) });
    if (v === AUTO) {
      d.auto.holders[key] = Number(d.auto.holders[key] || 0) - sh;
      d.auto.total = Number(d.auto.total) - sh;
      for (const [x, a] of Object.entries(q.legs)) {
        const bsh = a / p[x];
        d.v[x].holders[AUTO] = Number(d.v[x].holders[AUTO] || 0) - bsh;
        d.v[x].total = Number(d.v[x].total) - bsh;
      }
    } else {
      d.v[v].holders[key] = Number(d.v[v].holders[key] || 0) - sh;
      d.v[v].total = Number(d.v[v].total) - sh;
    }
  }
  await finishOne(d, q);
}
/** A stash's own holding in a vault (its shares; for "auto" its Auto units). */
const holdingOf = (d, stashId, vault) => (vault === AUTO ? Number(((d.auto || {}).holders || {})[holderKey(stashId)] || 0)
  : Number((((d.v || {})[vault] || {}).holders || {})[holderKey(stashId)] || 0));
async function finishOne(d, q) {
  const key = holderKey(q.stash);
  const p = q.prices;
  // P0.3: did the stash hold this vault before this request (a deposit's shares are added below)? Its cost row is then partial
  const had = holdingOf(d, q.stash, q.vault) > 1e-12;
  for (const [v, a] of Object.entries(q.legs || {})) {
    if (q.kind === "deposit") await transfer(`${q.id}-${v}`, "vaultfloat", CASH[v], a, "vault deposit");
    else await transfer(`${q.id}-${v}`, CASH[v], `stash:${q.stash}`, a, "vault withdrawal");
  }
  if (q.kind === "deposit" && q.refund) await transfer(`${q.id}-refund`, "vaultfloat", `stash:${q.stash}`, q.refund, "vault deposit refund");
  if (q.kind === "deposit") {
    if (q.vault === AUTO) {
      let value = 0.0;
      for (const [v, a] of Object.entries(q.legs)) {
        const sh = a / p[v];
        const st = d.v[v];
        st.holders[AUTO] = Number(st.holders[AUTO] || 0) + sh;
        st.total = Number(st.total) + sh;
        value += a;
      }
      const ash = value / p[AUTO];
      d.auto.holders[key] = Number(d.auto.holders[key] || 0) + ash;
      d.auto.total = Number(d.auto.total) + ash;
    } else {
      for (const [v, a] of Object.entries(q.legs)) {
        const sh = a / p[v];
        const st = d.v[v];
        st.holders[key] = Number(st.holders[key] || 0) + sh;
        st.total = Number(st.total) + sh;
      }
    }
  }
  addCost(d, q, had);
  q.state = "done";
  q.done = C.nowS();
}
/** P0.3: a finished request's PAT in d.cost[stash][vault] = {in, out} - a deposit's legs in (its refund never went in), a
 *  withdrawal's legs out. Once per request (q.costed), so the backfill (backfillCost) and the live path never count twice.
 *  The live path passes `had` (the stash held the vault before this request): a row it CREATES for a stash that already held
 *  the vault - or for a withdrawal - starts partial (the older stake isn't in it; /staking shows Staked and P/L as unknown
 *  until the backfill, which re-checks it). */
function addCost(d, q, had) {
  if (q.costed) return false;
  let sum = 0;
  for (const a of Object.values(q.legs || {})) sum += Math.trunc(Number(a) || 0);
  if (sum > 0 && (q.kind === "deposit" || q.kind === "withdraw")) {
    d.cost = d.cost && typeof d.cost === "object" ? d.cost : {};
    const byStash = d.cost[String(q.stash)] = d.cost[String(q.stash)] || {};
    const existed = !!byStash[q.vault];
    const row = byStash[q.vault] = byStash[q.vault] || { in: 0, out: 0 };
    if (!existed && had !== undefined && (had || q.kind === "withdraw")) row.partial = 1;
    if (q.kind === "deposit") row.in = Math.trunc(Number(row.in) || 0) + sum;
    else row.out = Math.trunc(Number(row.out) || 0) + sum;
  }
  q.costed = 1;
  return sum > 0;
}
/** Is the vault queue's history complete - no done request pruned yet? The cut-off drops a done request 30 days after it ran,
 *  so nothing is gone while the newest snapshot is less than 30 days after the first one (and the snapshots, kept 400, still
 *  start at the first cut-off). Pepe never pruned his queue, so a book he handed over is whole. */
function queueWhole(d) {
  const eps = Array.isArray(d.epochs) ? d.epochs : [];
  if (!eps.length) return true;
  if (eps.length >= 400) return false;
  return Number(eps[eps.length - 1].ts) - 30 * 86400 < Number(eps[0].ts);
}
/** Each stash's holding as its retained requests explain it: {stash: {vault: shares (auto: units)}} - a deposit's legs at its
 *  prices (Auto: the legs' PAT / the Auto price), less a withdrawal's burn. The ceiling's skims only ever LOWER a staker's
 *  shares (the cushion and the floor top-up ship off), so a holding above this has a stake the history doesn't show. */
function impliedHoldings(d) {
  const out = {};
  for (const q of Object.values(d.queue || {})) {
    if (!q || q.state !== "done") continue;
    const row = out[String(q.stash)] = out[String(q.stash)] || {};
    const p = q.prices || {};
    let sh = 0;
    if (q.kind === "deposit") {
      if (q.vault === AUTO) { let s = 0; for (const a of Object.values(q.legs || {})) s += Number(a) || 0; sh = Number(p[AUTO]) > 0 ? s / Number(p[AUTO]) : 0; }
      else for (const [v, a] of Object.entries(q.legs || {})) sh += Number(p[v]) > 0 ? Number(a) / Number(p[v]) : 0;
    } else if (q.kind === "withdraw") sh = -Number(q.burn || 0);
    row[q.vault] = (row[q.vault] || 0) + sh;
  }
  return out;
}
/** The one-time backfill (tools/staking-backfill.js cost): every DONE request still in the queue that the live path never
 *  costed. Requests leave the queue 30 days after they ran (epoch()), so it must run within 30 days of the first stake it
 *  should see (prod: before 2026-11-04). Then every cost row is re-checked: it's whole (partial cleared) only when the queue
 *  is whole (queueWhole) AND the stash's holding there is explained by its requests (impliedHoldings); otherwise partial.
 *  -> {items, stashes, in, out, whole, partial: [[stash, vault]...]} of what it did (d changed in place). */
function backfillCost(d) {
  const out = { items: 0, stashes: new Set(), in: 0, out: 0 };
  const done = Object.values(d.queue || {}).filter((q) => q && q.state === "done" && !q.costed).sort((a, b) => Number(a.done || a.ts) - Number(b.done || b.ts));
  for (const q of done) {
    let sum = 0;
    for (const a of Object.values(q.legs || {})) sum += Math.trunc(Number(a) || 0);
    if (addCost(d, q)) {
      out.items += 1;
      out.stashes.add(String(q.stash));
      if (q.kind === "deposit") out.in += sum; else out.out += sum;
    }
  }
  const whole = queueWhole(d);
  const imp = impliedHoldings(d);
  const partial = [];
  for (const [sid, rows] of Object.entries(d.cost || {})) {
    for (const [v, row] of Object.entries(rows || {})) {
      if (!row || typeof row !== "object") continue;
      const have = holdingOf(d, sid, v), want = Number((imp[sid] || {})[v] || 0);
      const explained = have <= want * (1 + 1e-9) + 1e-6 && want > -1e-6;
      if (whole && explained) delete row.partial;
      else { row.partial = 1; partial.push([sid, v]); }
    }
  }
  return { items: out.items, stashes: out.stashes.size, in: out.in, out: out.out, whole, partial };
}
function skim(d, v, factor) {
  const h = d.v[v].holders;
  let moved = 0.0;
  for (const k of Object.keys(h)) {
    if (k !== PROTOCOL) { const nw = Number(h[k]) * factor; moved += Number(h[k]) - nw; h[k] = nw; }
  }
  h[PROTOCOL] = Number(h[PROTOCOL] || 0) + moved;
  return moved;
}
/** P1.2: the inverse of skim(): g protocol shares go to every non-protocol holder (each stash, the Auto fund) pro rata to S, their
 *  shares before. Each holding grows by g x h / S; the protocol loses exactly what they gained. -> the shares given. */
function giveBack(d, v, g, S) {
  const h = d.v[v].holders;
  let given = 0.0;
  for (const k of Object.keys(h)) {
    if (k !== PROTOCOL) { const old = Number(h[k]); const nw = old + g * old / S; given += nw - old; h[k] = nw; }
  }
  h[PROTOCOL] = Number(h[PROTOCOL] || 0) - given;
  return given;
}
/** Every non-protocol holder's shares, summed in the holders' order (Pepe sums the same dict in the same order). */
function nonProtocolShares(st) {
  let s = 0.0;
  for (const k of Object.keys((st && st.holders) || {})) if (k !== PROTOCOL) s += Number(st.holders[k]);
  return s;
}
/** The cushion switch: Pepe's vault_ceil_cushion (0 / 1, ships 0) and vault_ceil_cushion_days (8), pushed as ceil_cushion /
 *  ceil_cushion_days - read like pepe_vaults._vault_ceil_cushion: on = int(x) > 0; the window a finite number >= 0, at most
 *  CUSHION_KEEP_DAYS (anything else: 8). */
function cushionCfg(c) {
  const raw = Number((c || {}).ceil_cushion);
  const on = Number.isFinite(raw) && Math.trunc(raw) > 0;
  const x = (c || {}).ceil_cushion_days;
  let days = x === null || x === undefined || x === "" ? NaN : Number(x);
  if (!Number.isFinite(days) || days < 0) days = 8;
  return { on, days: Math.min(days, CUSHION_KEEP_DAYS) };
}
/** The oldest cushion entry a give-back at `now` may still use (pepe_vaults: now - days x 86400 - CUSHION_SLACK). */
const cushionHorizon = (now, days) => Number(now) - Number(days) * 86400 - CUSHION_SLACK;
/** The shares in v's cushion that a give-back at `now` may still use (entries inside the window). */
function cushionShares(st, now, days) {
  let s = 0.0;
  const win = cushionHorizon(now, days);
  for (const e of (st && Array.isArray(st.cushion)) ? st.cushion : []) if (Number(e[0]) >= win) s += Number(e[1]);
  return s;
}
/** One vault's high-water mark and cap at a cut-off (epoch() step 1; pepe_vaults._vault_epoch, the same expressions):
 *  peak = max(pa, peak_price), cap = peak x (1 + allow), allow = (1 + ceil)^(dt/365) - 1. Only called with ceil > 0. */
function ceilingCap(st, pa, ceil, dtDays) {
  const peak = Math.max(pa, Number(st.peak_price === undefined ? pa : st.peak_price));
  const allow = Math.pow(1 + ceil, dtDays / 365) - 1;
  return { peak, capPrice: peak * (1 + allow) };
}
/** Is the daily APR ceiling on? ceil_apr > 0 (a finite number). 0 - or anything not a positive number - means NO ceiling:
 *  no skim, no give-back, the cushion left as it is (D1, 2026-10-19: "let's see where it lands naturally"); the high-water
 *  mark keeps tracking the price meanwhile (ceilingOffStep). Pepe's local cut-off gates on the same
 *  (pepe_vaults._vault_ceil_apr). Switched back on later, the cap starts from the highest price reached while it was off:
 *  neither the gains made meanwhile nor a recovery toward them are taken back. */
const ceilingOn = (c) => { const x = Number((c || {}).ceil_apr); return Number.isFinite(x) && x > 0; };
/**
 * P1.2, one vault at a cut-off - pepe_vaults.ceiling_step, the same expressions in the same order (the shared vectors,
 * test/vault-ceiling-vectors.test.js, check holders, peak and cushion to the bit). pa = the last snapshot's price, pb = the
 * price now, peak = max(pa, peak_price), capPrice = peak x (1 + ceil)^(dt/365) (ceilingCap). Only runs while the ceiling is on.
 *   always first         st.cushion (when it is a list) keeps the entries newer than CUSHION_KEEP_DAYS with > 1e-9 left
 *   pb > capPrice        skim to the cap (x cap/pb); [now, moved] joins st.cushion (switch on or off);
 *                        peak_price = max(peak, min(pb, capPrice))                                           - as before
 *   pb < pa, switch on,  need = S x (pa - pb) / pb (S = every non-protocol share: restores the stakers' value to S x pa);
 *   a cushion, S > 0     lim = min(need, the protocol's shares); g = the entries newer than now - days x 86400 -
 *                        CUSHION_SLACK, oldest first, up to lim (each reduced in place; used-up ones dropped); g > 0:
 *                        giveBack(g), covered = g / need, peak_price = peak x pb / (pb + covered x (pa - pb)) (the covered
 *                        part of the drawdown is not recovered a second time); g = 0: as below
 *   otherwise            peak_price = max(peak, min(pb, capPrice))                                           - as before
 * -> {skim, giveback, covered, need, cushion_before (the window's shares before a give-back - the audit's I10), f (the
 *     stakers' share-count factor: cap/pb on a skim, (S+g)/S on a give-back, 1 otherwise)}
 */
function ceilingStep(d, v, { pa, pb, peak, capPrice, now, c }) {
  const st = d.v[v];
  const h = st.holders;
  const { on, days } = cushionCfg(c);
  const out = { skim: 0.0, giveback: 0.0, covered: 0.0, need: 0.0, cushion_before: 0.0, f: 1.0 };
  if (Array.isArray(st.cushion)) {
    const keep = Number(now) - CUSHION_KEEP_DAYS * 86400;
    st.cushion = st.cushion.filter((e) => Number(e[0]) >= keep && Number(e[1]) > 1e-9).map((e) => [Number(e[0]), Number(e[1])]);
  }
  if (pb > capPrice) {
    const factor = capPrice / pb;
    out.skim = skim(d, v, factor);
    out.f = factor;
    if (!Array.isArray(st.cushion)) st.cushion = [];
    st.cushion.push([Number(now), out.skim]);
    st.peak_price = Math.max(peak, Math.min(pb, capPrice));
    return out;
  }
  if (on && pb < pa && Array.isArray(st.cushion) && st.cushion.length) {
    const S = nonProtocolShares(st);
    if (S > 0) {
      const need = S * (pa - pb) / pb;
      const lim = Math.min(need, Math.max(0.0, Number(h[PROTOCOL] || 0)));
      const win = cushionHorizon(now, days);
      out.need = need;
      let cb = 0.0;
      for (const e of st.cushion) if (e[0] >= win) cb += e[1];
      out.cushion_before = cb;
      let g = 0.0;
      for (const e of st.cushion) {                            // FIFO: the oldest skims first
        if (e[0] < win) continue;
        const tk = Math.min(e[1], lim - g);
        e[1] -= tk;
        g += tk;
        if (g >= lim - 1e-9) break;
      }
      st.cushion = st.cushion.filter((e) => e[1] > 1e-9);
      if (g > 0) {
        out.giveback = giveBack(d, v, g, S);
        out.covered = g / need;
        out.f = (S + out.giveback) / S;
        st.peak_price = peak * pb / (pb + out.covered * (pa - pb));
        return out;
      }
    }
  }
  st.peak_price = Math.max(peak, Math.min(pb, capPrice));
  return out;
}
/**
 * D1, one vault at a cut-off while the ceiling is OFF - pepe_vaults.ceiling_off_step (camfrog-bot 31c65d0), the same
 * expressions: nothing is skimmed or given back and the cushion is left as it is, but the high-water mark keeps TRACKING the
 * price - peak_price = max(max(pa, peak_price), pb) - so switching the ceiling back on caps only growth above the highest
 * price reached meanwhile: a recovery toward a high made while it was off is not skimmed (3.0 -> a Monday draw to 2.9 ->
 * back on -> 3.0: nothing skimmed; a frozen peak skimmed it as new growth). -> the new peak_price
 */
function ceilingOffStep(st, pa, pb) {
  const peak = Math.max(pa, Number(st.peak_price === undefined ? pa : st.peak_price));
  st.peak_price = Math.max(peak, pb);
  return st.peak_price;
}
/**
 * The cut-off's step 1 for every vault (pepe_vaults._vault_epoch step 1, the same order; the caller checked the day is >= 12 h):
 * while the ceiling is on (ceilingOn), each vault with a last price gets ceilingCap + ceilingStep at the prices `p` the
 * cut-off opened with; while it is off, each such vault gets ceilingOffStep (only its high-water mark tracks the price - no
 * step record, F stays 1). In place on d. -> {F: {vault: the stakers' share-count factor}, steps: {vault: ceilingStep's
 * notes}, skim: {vault: shares}, giveback: {vault: {shares, need, covered, cushion_before}}, cushion: {vault: the window's
 * shares after}, peak_off: {vault: the tracked high-water mark on an off day}} (the vault_epoch event's notes)
 */
function ceilingDay(d, last, p, now, c) {
  const out = { F: {}, steps: {}, skim: {}, giveback: {}, cushion: {}, peak_off: {} };
  if (!last) return out;
  const on = ceilingOn(c);
  const dtDays = Math.max(1e-3, (Number(now) - Number(last.ts)) / 86400);
  for (const v of VAULTS) {
    const pa = Number((last.price || {})[v] || 0), pb = p[v];
    if (pa <= 0 || !d.v[v]) continue;
    const st = d.v[v];
    if (!on) { out.peak_off[v] = ceilingOffStep(st, pa, pb); continue; }
    const { peak, capPrice } = ceilingCap(st, pa, Number(c.ceil_apr), dtDays);
    const cs = ceilingStep(d, v, { pa, pb, peak, capPrice, now, c });
    out.F[v] = cs.f;
    out.steps[v] = Object.assign({ pa, pb, peak, cap: capPrice }, cs);
    if (pb > capPrice) out.skim[v] = cs.skim;
    if (cs.giveback) out.giveback[v] = { shares: cs.giveback, need: cs.need, covered: cs.covered, cushion_before: cs.cushion_before };
    if (Array.isArray(st.cushion) && st.cushion.length) out.cushion[v] = cushionShares(st, now, cushionCfg(c).days);
  }
  return out;
}
async function topup(d, v, rShort, price, k, c, t) {
  const st = d.v[v];
  const stake = Object.entries(st.holders).filter(([hk, sh]) => hk !== PROTOCOL && Number(sh) > 0).map(([hk, sh]) => [hk, Number(sh)]);
  let need = Math.trunc(stake.reduce((s, x) => s + x[1], 0) * price * rShort);
  need = Math.min(need, Math.trunc(Number(c.topup_max_day)), Math.max(0, (await C.poolBalance("reserve")) - 1000000));
  if (need <= 0 || !stake.length) return 0;
  d.seq += 1;
  await transfer(`vt${d.seq}`, "reserve", CASH[v], need, "vault top-up");
  const newSh = need / price;
  const tot = stake.reduce((s, x) => s + x[1], 0);
  for (const [hk, sh] of stake) st.holders[hk] = Number(st.holders[hk] || 0) + newSh * sh / tot;
  st.total = Number(st.total) + newSh;
  return need;
}
async function dividends(d, now, c) {
  const k0 = await ctx();
  const p = prices(d, k0);
  const out = [];
  for (const v of VAULTS) {
    const st = d.v[v];
    if (!st) continue;
    const k = await ctx();
    const nv = nav(v, k);
    const target = Number((c.targets || {})[v]);
    if (!Number.isFinite(target)) continue;
    const excess = nv - target;
    const protVal = Number(st.holders[PROTOCOL] || 0) * p[v];
    if (st.basis === undefined) st.basis = Math.trunc(protVal);
    const earnings = protVal - Number(st.basis);
    const amt = Math.trunc(Math.min(excess, earnings, freeCash(v, k)));
    if (amt < Number(c.min_move)) continue;
    const tid = `div-${v}-${Math.trunc(now)}`;
    const sh = amt / p[v];
    st.holders[PROTOCOL] = Number(st.holders[PROTOCOL] || 0) - sh;
    st.total = Number(st.total) - sh;
    d.dividends = d.dividends || {};
    d.dividends[tid] = { vault: v, amount: amt, ts: now, state: "moving" };
    await transfer(tid, CASH[v], "reserve", amt, "protocol dividend");
    d.dividends[tid].state = "done";
    out.push([v, amt]);
  }
  const keys = Object.keys(d.dividends || {}).sort();
  for (const kk of keys.slice(0, Math.max(0, keys.length - 200))) delete d.dividends[kk];
  return out;
}
async function rebalance(d, p, c) {
  const hold = Object.fromEntries(VAULTS.map((v) => [v, Number(((d.v[v] || {}).holders || {})[AUTO] || 0) * p[v]]));
  const tot = hold.bank + hold.house + hold.mm;
  const minMove = Number(c.min_move);
  if (tot < 10 * minMove) return [];
  const w = autoTargets(d, c);
  const want = Object.fromEntries(VAULTS.map((v) => [v, tot * w[v]]));
  const over = [], under = {};
  for (const v of VAULTS) if (hold[v] - want[v] > Math.max(minMove, 0.05 * tot)) over.push([v, hold[v] - want[v]]);
  for (const v of VAULTS) if (want[v] - hold[v] > 0) under[v] = want[v] - hold[v];
  const moves = [];
  for (let [src, extra] of over) {
    for (const [dst, gap] of Object.entries(Object.assign({}, under))) {
      const k = await ctx();
      let amt = Math.trunc(Math.min(extra, gap, freeCash(src, k)));
      // P2.2: with Auto under the staker limit, a rebalance can't push stakers in dst over it either
      if (autoCapOn(c)) amt = Math.min(amt, stakerRoom(d, dst, amt, p, k, c));
      if (amt < minMove) continue;
      d.seq += 1;
      const tid = `vt${d.seq}`;
      d.rebalances = d.rebalances || {};
      d.rebalances[tid] = { src, dst, amt, ps: p[src], pd: p[dst], state: "moving" };
      const s1 = d.v[src];
      const sh = amt / p[src];
      s1.holders[AUTO] = Number(s1.holders[AUTO] || 0) - sh;
      s1.total = Number(s1.total) - sh;
      await transfer(tid, CASH[src], CASH[dst], amt, "auto rebalance");
      const s2 = d.v[dst];
      const sh2 = amt / p[dst];
      s2.holders[AUTO] = Number(s2.holders[AUTO] || 0) + sh2;
      s2.total = Number(s2.total) + sh2;
      d.rebalances[tid].state = "done";
      // 1.99adk: when it ran (seconds), like a queue item's q.done - Pepe's staking audit places a rebalance on its
      // cut-off by this time first and uses ps / pd only to confirm (two cut-offs with equal prices can't place it)
      d.rebalances[tid].done = C.nowS();
      moves.push([src, dst, amt]);
      extra -= amt;
      under[dst] = gap - amt;
    }
  }
  return moves;
}
/** One step of the cut-off in its own savepoint: a throw rolls back its writes and restores the book in memory. -> ok */
async function guarded(d, label, fn, errors) {
  const snap = JSON.stringify(d);
  try {
    await C.tx(fn);
    return true;
  } catch (e) {
    const back = JSON.parse(snap);
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, back);
    errors.push([label, String((e && e.message) || e).slice(0, 200)]);
    console.error(`[capital] cut-off: ${label} failed (left for the next cut-off): ${(e && e.message) || e}`);
    return false;
  }
}

/**
 * The ceiling replayed over the stored snapshots (the cushion seed, tools/staking-backfill.js cushion): for every cut-off at
 * least 12 h after the one before, by the rule THAT cut-off ran with - its snapshot's own ceil_apr (recorded since the
 * staking fix: 0 = off), else `ceil`, by default REPLAY_CEIL = 25% (pepe_stakingreplay.rule_at reads the snapshot first the
 * same way and falls back to his DEFAULT_CEIL 0.25 - every cut-off before the snapshots recorded their rule ran with the 25%
 * ceiling; today's setting would replay them as off once the ceiling is off. The site has no ceil_log, his middle step: its
 * snapshots carry the key from the staking fix on): with the ceiling
 * on, cap = max(pa, peak) x (1 + ceil)^(dt/365) on the snapshot prices; a price above it was skimmed by f = cap / pb from
 * S = the non-protocol shares held through that day (the previous snapshot's staked value / its price). With it off, nothing
 * was skimmed and the high-water mark tracked the price (ceilingOffStep: peak = max(max(pa, peak), pb) - camfrog-bot 31c65d0,
 * as the cut-off). -> {peak: {vault: high-water mark after the last}, skims: [{ts, vault, f, shares, pat}]}. An estimate: the
 * real cut-off saw the live price (equal to the snapshot's up to rounding); the caller checks the replayed high-water mark
 * against the book's before trusting it.
 */
function replayCeiling(epochs, ceil = REPLAY_CEIL) {
  const peak = {}, skims = [];
  const eps = Array.isArray(epochs) ? epochs : [];
  for (let i = 1; i < eps.length; i++) {
    const last = eps[i - 1], e = eps[i];
    if (Number(e.ts) - Number(last.ts) < 43200) continue;
    // rule_at: a snapshot that has the key wins (null / junk = 0, off), else the caller's ceil; NaN / inf = off
    let ce = Number((Object.prototype.hasOwnProperty.call(e, "ceil_apr") ? e.ceil_apr : ceil) || 0);
    if (!Number.isFinite(ce)) ce = 0;
    const dtDays = Math.max(1e-3, (Number(e.ts) - Number(last.ts)) / 86400);
    for (const v of VAULTS) {
      const pa = Number((last.price || {})[v] || 0), pb = Number((e.price || {})[v] || 0);
      if (!(pa > 0) || !(pb > 0)) continue;
      if (!(ce > 0)) { peak[v] = Math.max(Math.max(pa, peak[v] === undefined ? pa : peak[v]), pb); continue; }   // off: the mark tracks
      const pk = Math.max(pa, peak[v] === undefined ? pa : peak[v]);
      const capPrice = pk * (1 + (Math.pow(1 + ce, dtDays / 365) - 1));
      if (pb > capPrice) {
        const f = capPrice / pb;
        const S = Number((last.staked || {})[v] || 0) / pa;
        skims.push({ ts: Number(e.ts), vault: v, f, shares: S * (1 - f), pat: S * (1 - f) * pb });
      }
      peak[v] = Math.max(pk, Math.min(pb, capPrice));
    }
  }
  return { peak, skims };
}

/** The stakers' index at this cut-off (pepe_vaults._vault_epoch's, the same expression): what 1 PAT a staker held in each
 *  vault since the first indexed cut-off is worth now = the last index x (the snapshot price / the last snapshot's price) x f,
 *  f = the ceiling step's share-count factor (cap/pb on a skim, (S+g)/S on a give-back, 1 otherwise). Rounded to 10 decimals. */
function stakerIndex(last, snapPrice, F) {
  const prevIdx = (last && last.staker_index) || {};
  const out = {};
  for (const v of VAULTS) {
    const prev = prevIdx[v] === undefined || prevIdx[v] === null ? 1.0 : Number(prevIdx[v]);
    const pa = Number(((last && last.price) || {})[v] || 0);
    const f = F && F[v] !== undefined ? Number(F[v]) : 1.0;
    out[v] = pyRoundN(prev * (pa > 0 ? Number(snapPrice[v]) / pa : 1.0) * f, 10);
  }
  return out;
}

// ── P2.1: PAT-days (the time-weighted weekly payout) ──
// WIRE (the waterfall reads it - Pepe's pepe_treasury._tr_stakers, the site's policy/engines stakers()):
//   d.v[<vault>].pat_days = {"<boundary>": {"<stash id>": PAT-days, ...}, ...}
//   <boundary> = the Monday epoch_hour UTC that settles the week, as an integer string (week_start(ts) + 7 days for a ts
//   inside the week); <stash id> = the stash id (no "s"); PAT-days = Σ look-through value x days held. At most PD_KEEP
//   buckets per vault. The waterfall for boundary B pays each stash by the PAT-days of the buckets (the last settled
//   boundary, B] / days (its average stake - pepe_vaults.pat_days_avg / policy/engines patDaysAvg) instead of the holdings
//   at that moment; no bucket for B -> the old snapshot. Pepe's scheduled waterfall waits (up to an hour) for the Monday
//   cut-off that closes the week's bucket. The policy inputs carry it as [[boundary, [[stash id, PAT-days], ...]], ...].
/** {stash id: value in vault v at `price`} - the direct holding ("s<id>") plus its slice of the Auto fund's sleeve, in the
 *  order policy/engines stakers() and pepe_treasury._tr_stakers build it (direct holders first, then the Auto holders). */
function lookThrough(d, v, price) {
  const h = ((d.v[v] || {}).holders) || {};
  const out = new Map();
  for (const [k, sh] of Object.entries(h)) {
    if (k === PROTOCOL || k === AUTO || !String(k).startsWith("s")) continue;
    const id = String(k).slice(1);
    out.set(id, (out.has(id) ? out.get(id) : 0.0) + Number(sh) * price);
  }
  const autoSh = Number(h[AUTO] || 0);
  const atot = Number((d.auto || {}).total || 0);
  if (autoSh > 0 && atot > 0) {
    for (const [k, ash] of Object.entries((d.auto || {}).holders || {})) {
      if (String(k).startsWith("s") && Number(ash) > 0) {
        const id = String(k).slice(1);
        out.set(id, (out.has(id) ? out.get(id) : 0.0) + Number(ash) / atot * autoSh * price);
      }
    }
  }
  return out;
}
/** The boundary (integer s) that settles a moment inside a week: the next Monday epoch_hour UTC strictly after the week's start. */
const settlesAt = (ts, hour) => require("../policy/engines").weekStart(ts, hour) + 7 * 86400;
/**
 * P2.1 at a cut-off, right BEFORE the queue (after the ceiling and the v1 dividend - pepe_vaults._vault_epoch step 1d, at the
 * same moment's prices): the day just ended [t0, t1) was held with the holdings the book has now, so each stash's
 * look-through value x the days goes to the bucket of the Monday that settles them (an interval across a boundary is split
 * there; a bucket the interval touches exists afterwards even if nobody held a stake). Only the PD_KEEP newest buckets stay.
 * pepe_vaults.accrue_pat_days, the same expressions in the same order (the shared vectors check every bucket to the bit).
 * A stake made at this cut-off earns from now on. -> {vault: {"<boundary>": PAT-days added}} (d changed in place)
 */
function accruePatDays(d, p, t0, t1, hour) {
  const segs = [];
  let t = Number(t0);
  const end = Number(t1);
  while (t < end) {
    const b = settlesAt(t, hour);
    const e = Math.min(end, b);
    segs.push([String(Math.trunc(b)), (e - t) / 86400]);
    t = e;
  }
  const added = {};
  if (!segs.length) return added;
  for (const v of VAULTS) {
    const st = d.v[v];
    if (st === undefined || st === null) continue;
    const vals = lookThrough(d, v, Number(p[v]));
    let pd = st.pat_days;
    if (!pd || typeof pd !== "object" || Array.isArray(pd)) pd = st.pat_days = {};
    for (const [bk, dd] of segs) {
      let row = pd[bk];
      if (!row || typeof row !== "object" || Array.isArray(row)) row = pd[bk] = {};
      for (const [sid, val] of vals) {
        if (val > 0) {
          row[sid] = Number(row[sid] || 0.0) + val * dd;
          const av = added[v] = added[v] || {};
          av[bk] = (av[bk] || 0.0) + val * dd;
        }
      }
    }
    const keys = Object.keys(pd);
    if (keys.length > PD_KEEP) for (const bk of keys.sort((x, y) => Number(x) - Number(y)).slice(0, keys.length - PD_KEEP)) delete pd[bk];
  }
  return added;
}
/** This week's PAT-days (the bucket the next Monday settles) -> {boundary, vaults: {v: {total, by: {stash id: PAT-days}}},
 *  from (d.pd_from: when the site's PAT-days began - shown only), partial (the week isn't WHOLLY time-weighted yet - pdPartial,
 *  Pepe's bucket rule; lb = the last settled boundary, lastSettled)} */
function patDaysNow(d, now, hour, lb = 0) {
  const B = settlesAt(now, hour);
  const key = String(Math.trunc(B));
  const vaults = {};
  for (const v of VAULTS) {
    const b = (((d.v[v] || {}).pat_days) || {})[key];
    if (!b) continue;
    let total = 0.0;
    for (const x of Object.values(b)) total += Number(x) || 0;
    vaults[v] = { total, by: b };
  }
  return { boundary: B, vaults, from: Number(d.pd_from) > 0 ? Number(d.pd_from) : null, partial: pdPartial(d, B, lb) };
}
/** Did the PAT-days begin inside the week that settles at boundary B (from in [B - 7 d, B))? Only then is a partial week
 *  (pdPartial, Pepe's bucket rule) the FIRST week of the time-weighting - the card's "PAT-days since ..." note and /staking's
 *  first-week sentence (views/staking.ejs pdFirst, the same test). Any other partial week (PAT-days that began in an earlier
 *  week of a longer stretch, a missing or pruned bucket) gets the plain "not fully time-weighted" wording. -> true / false */
function pdFirstWeek(from, B) {
  const f = Number(from), b = Number(B);
  return f > 0 && b > 0 && f >= b - 7 * 86400 && f < b;
}
const isPdRow = (x) => !!x && typeof x === "object" && !Array.isArray(x);
/**
 * D2's safeguard on the site's book: is vault st's week that settles at boundary B WHOLLY time-weighted, the last settled
 * boundary being lb? pepe_vaults.pat_days_whole (camfrog-bot 31c65d0) - the same rule as the waterfall's
 * (policy/engines.patDaysWhole, called here on the book's buckets): the bucket for B exists AND a bucket older than the first
 * one the week's split sums ((lb, B], or B's own). A bucket only gets PAT-days from a cut-off inside its week, so an older one
 * proves the PAT-days were accruing before the week began. -> true / false
 */
function pdWhole(st, B, lb = 0) {
  const pd = st && st.pat_days;
  if (!isPdRow(pd)) return false;
  const list = Object.keys(pd).filter((k) => isPdRow(pd[k])).map((k) => [k, Object.entries(pd[k])]);
  return require("../policy/engines").patDaysWhole({ pat_days: list }, B, lb);
}
/**
 * Is the week that settles at boundary B NOT wholly time-weighted? pepe_vaults._vault_pd_week's partial (camfrog-bot 31c65d0):
 * some vault holding a bucket for B isn't wholly time-weighted (pdWhole), or no vault has one (the snapshot). While no weekly
 * cap is in force such a week settles under the 25% reference cap (D2's safeguard: Pepe's _tr_plan, policy/engines planEpoch) -
 * the first week after the deploy is one (its PAT-days began mid-week, or at its own Monday cut-off: no older bucket), and so
 * is a week whose bucket is missing or whose oldest summed week was pruned (a settlement over more than three weeks).
 * Until 31c65d0 the site judged by d.pd_from instead (partial when the PAT-days started more than PD_SLACK after the week did) -
 * that called the week whose first interval began at its own Monday cut-off whole, a missing / pruned bucket whole and a book
 * that arrived with Pepe's older buckets partial; the bucket rule is what the payout itself applies.
 */
function pdPartial(d, B, lb = 0) {
  const key = String(Math.trunc(Number(B)));
  let any = false;
  for (const v of VAULTS) {
    const st = ((d && d.v) || {})[v];
    if (!st || !isPdRow(st.pat_days) || !isPdRow(st.pat_days[key])) continue;
    any = true;
    if (!pdWhole(st, B, lb)) return true;
  }
  return !any;
}
/** The DONE weekly records in the list Pepe pushed (his last 8, pepe_treasury._tr_public_records), whatever the epoch id ->
 *  [{epoch, boundary, state: "done", done (when it was settled, s) | null}] - capital/service.js putConfig keeps it as
 *  cfg.wf_settled for lastSettled and lateMonday. waterfallFrom (cfg.waterfall, /staking's list) keeps only the plain
 *  "W<date>" ids and drops a tagged run ("W2026-10-12-r1": the staging rehearsal's pepe_policyclient run), but Pepe's lb
 *  counts every done record in his journal, tagged ones included, and a tagged run settles its boundary's PAT-days too. */
function settledFrom(list) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : []).slice(-16)) {
    if (!r || typeof r !== "object" || r.state !== "done") continue;
    const b = Number(r.boundary);
    if (!Number.isFinite(b) || b <= 0) continue;
    const done = Number(r.done);
    out.push({ epoch: String(r.epoch || r.eid || "").slice(0, 40), boundary: b, state: "done", done: Number.isFinite(done) && done > 0 ? done : null });
  }
  return out;
}
/** The last settled boundary Pepe reported - pepe_treasury._tr_last_boundary's lb (and pepe_vaults._vault_pd_week's) as far as
 *  the site sees it: the newest DONE weekly record he pushed (his last 8) other than epoch `except`; 0 = none. A tagged
 *  re-run's "W...-r1" record counts, as in his journal: cfg.waterfall has dropped it (waterfallFrom), so it is read from
 *  cfg.wf_settled (settledFrom, every done record of the push). A record older than his last 8 is beyond what the site sees. */
function lastSettled(c, except) {
  let lb = 0;
  const recs = [].concat(Array.isArray(c && c.waterfall) ? c.waterfall : [], Array.isArray(c && c.wf_settled) ? c.wf_settled : []);
  for (const r of recs) {
    if (!r || typeof r !== "object" || r.state !== "done" || String(r.epoch || r.eid || "") === String(except)) continue;
    const b = Number(r.boundary);
    if (Number.isFinite(b) && b > lb) lb = b;
  }
  return lb;
}
/** A cut-off that crossed a Monday boundary more than LATE_MONDAY after it: {boundary, late (s), settled (the time Pepe's
 *  pushed settlement for that boundary was done, when it was - before this cut-off), lost: true when it was} | null. The
 *  settlement is looked up in cfg.waterfall and in cfg.wf_settled (settledFrom: a tagged re-run's record, which waterfallFrom
 *  drops, settles the boundary too - the earliest done time before this cut-off wins). */
function lateMonday(t0, t1, hour, c) {
  const B = settlesAt(t0, hour);
  if (!(B <= t1) || t1 - B <= LATE_MONDAY) return null;
  const recs = [].concat(Array.isArray(c && c.waterfall) ? c.waterfall : [], Array.isArray(c && c.wf_settled) ? c.wf_settled : []);
  let settled = null;
  for (const r of recs) {
    if (!r || typeof r !== "object" || r.state !== "done" || Number(r.boundary) !== B) continue;
    const t = Number(r.done);
    if (t > 0 && t <= t1 && (settled === null || t < settled)) settled = t;
  }
  return { boundary: B, late: Math.round(t1 - B), settled, lost: !!settled };
}

// ── the audit (fix plan §6): invariants checked at every cut-off; capital/watch.js sends the alerts ──
// level: "alert" (sent every cut-off it holds), "warn" (sent once a week per check and vault), "info" (kept on the admin card)
const AUDIT = Object.freeze({ I2_TOL: 1e-6, I3_TOL: 1e-9, I4_UP: 0.01, I4_DOWN: -0.02, I5_SLACK: 0.05, I4_DAYS: 7 });
const pctTxt = (x) => `${(x * 100).toFixed(2)}%`;
/**
 * -> [{code, vault, level, title, body}]. Codes (fix plan §6): I1 the Auto fund's value = its sleeves; I2 Auto's day = its
 * sleeves' stakers' days (deposits, withdrawals, rebalances are neutral; 1e-6, not the plan's 1e-7: a withdrawal's PAT is
 * truncated, which nudges a small vault's price by ~1e-7); I3 every vault's (and Auto's) holders add up to its total; I4
 * stakers vs the vault over 7 days (needs 7 days of the stakers' index); I5 stakers own at most staker_max + 5 points (info
 * while Auto deposits skip the limit, a warning with vault_auto_staker_cap on); I8 a cut-off error (alert), a deposit
 * refunded in full (info: the limit working), a Monday cut-off more than an hour late (alert, late-monday); I10 a give-back
 * bigger than its cushion (a bug), the protocol below its basis.
 */
function audit(d, { last, snap, p, autoH0, F, steps, c, notes }) {
  const out = [];
  const add = (code, vault, level, title, body) => out.push({ code, vault: vault || null, level, title, body: String(body || "").slice(0, 900) });
  const label = (v) => LABEL[v] || v;
  // I1 + I3 (Auto)
  let an = 0.0;
  for (const v of VAULTS) an += Number(((d.v[v] || {}).holders || {})[AUTO] || 0) * p[v];
  const anav = Number(d.auto.total) * p[AUTO];
  if (Math.abs(anav - an) > 1) add("I1", AUTO, "alert", "Staking: the Auto fund's value doesn't match its sleeves", `Auto total x price = ${fmt(anav)} PAT, its shares in the vaults are worth ${fmt(an)} PAT.`);
  let ah = 0.0;
  for (const sh of Object.values(d.auto.holders || {})) ah += Number(sh);
  if (Math.abs(ah - Number(d.auto.total)) > AUDIT.I3_TOL * Math.max(1, Math.abs(Number(d.auto.total)))) {
    add("I3", AUTO, "alert", "Staking: the Auto fund's holders don't add up to its total", `holders ${ah} vs total ${d.auto.total}.`);
  }
  // I3 per vault
  for (const v of VAULTS) {
    const st = d.v[v];
    if (!st) continue;
    let s = 0.0;
    for (const sh of Object.values(st.holders || {})) s += Number(sh);
    const tot = Number(st.total);
    if (Math.abs(s - tot) > AUDIT.I3_TOL * Math.max(1, Math.abs(tot))) add("I3", v, "alert", `Staking: ${label(v)}'s holders don't add up to its total`, `holders ${s} vs total ${tot}.`);
  }
  // I2: Auto's day return vs its sleeves' stakers' returns, weighted at the last prices
  const lpa = last ? Number((last.price || {})[AUTO] || 0) : 0;
  // (F holds only the vaults the ceiling ran on - with the ceiling off every factor is 1 and the check still runs)
  if (lpa > 0) {
    let w = 0.0, e = 0.0;
    for (const v of VAULTS) {
      const pa = Number((last.price || {})[v] || 0);
      if (!(pa > 0) || !(autoH0[v] > 0)) continue;
      const val = autoH0[v] * pa;
      w += val;
      e += val * (p[v] / pa) * (F[v] === undefined ? 1.0 : F[v]);
    }
    if (w > 0 && Number(d.auto.total) > 0) {
      const exp = e / w, act = p[AUTO] / lpa;
      if (Math.abs(act - exp) > AUDIT.I2_TOL) {
        add("I2", AUTO, "alert", "Staking: the Auto fund's price moved differently from its vaults", `Auto moved ${pctTxt(act - 1)} at this cut-off; its sleeves (stakers' view) moved ${pctTxt(exp - 1)} - a gap of ${(act - exp).toExponential(2)}.`);
      }
    }
  }
  // I4: stakers vs the vault over 7 days
  const then = d.epochs.slice().reverse().find((x) => x !== snap && Number(snap.ts) - Number(x.ts) >= AUDIT.I4_DAYS * 86400 * 0.95 && x.staker_index && x.price);
  if (then) {
    for (const v of VAULTS) {
      const p0 = Number(then.price[v] || 0), i0 = Number(then.staker_index[v] || 0);
      if (!(p0 > 0) || !(i0 > 0) || !(Number(snap.staker_index[v]) > 0)) continue;
      const vr = Number(snap.price[v]) / p0 - 1, ir = Number(snap.staker_index[v]) / i0 - 1;
      const body = `Over the last 7 days the ${label(v)} vault moved ${pctTxt(vr)}, its stakers ${pctTxt(ir)}.`;
      // with no daily ceiling the stakers move with the vault by design (D1): a down week is then a warning, not an alert
      if (ir < AUDIT.I4_DOWN) add("I4", v, ceilingOn(c) ? "alert" : "warn", `Staking: ${label(v)} stakers are down ${pctTxt(-ir)} this week`, body);
      else if (vr >= AUDIT.I4_UP && ir < 0) add("I4", v, "warn", `Staking: ${label(v)} is up but its stakers are down this week`, body);
    }
  }
  // I5: stakers' ownership. While Auto deposits skip the limit (vault_auto_staker_cap off, P2.2 undecided) stakers already own
  // far more than it on prod (10-19: Bank 87.8% / House 73.5% / MM 87.4%), so it's info on the owner's card, not a weekly
  // warning to every admin; with the switch on, being over it is news (a warning).
  const smax = Number(c.staker_max);
  if (Number.isFinite(smax) && smax > 0) {
    for (const v of VAULTS) {
      const nv = Number(snap.nav[v] || 0), sv = Number(snap.staked[v] || 0);
      if (nv > 0 && sv / nv > smax + AUDIT.I5_SLACK) {
        add("I5", v, autoCapOn(c) ? "warn" : "info", `Staking: stakers own ${pctTxt(sv / nv)} of the ${label(v)} vault`, `The staker limit is ${pctTxt(smax)}` + (autoCapOn(c) ? " (Auto deposits obey it too)." : " (Auto deposits don't check it while vault_auto_staker_cap is off)."));
      }
    }
  }
  // I8: the cut-off itself
  if ((notes.errors || []).length) {
    add("I8", null, "alert", `Staking: ${notes.errors.length} cut-off step(s) failed`, notes.errors.map((x) => `${x[0]}: ${x[1]}`).join("; "));
  }
  // a direct stake refunded in full at the staker limit is the rule working (info on the card, not an alert to the admins)
  const refunds = (notes.items || []).filter((x) => x.kind === "deposit" && !Object.keys(x.legs || {}).length && Number(x.refund) > 0);
  if (refunds.length) {
    add("I8", "refund", "info", `Staking: ${refunds.length} stake(s) refunded in full at the cut-off`,
        refunds.map((x) => `${x.id} ${label(x.vault)} PAT ${fmt(x.refund)}`).join("; ") + " - the vault is at its staker limit.");
  }
  // I8 late-monday: the Monday cut-off ran more than an hour late (lateMonday)
  const lm = notes.late_monday;
  if (lm) {
    const at = new Date(lm.boundary * 1000).toISOString().slice(0, 16).replace("T", " ");
    add("I8", "late-monday", "alert", `Staking: the Monday cut-off ran ${Math.round(lm.late / 60)} min late (${at} UTC)`,
        lm.lost ? `Pepe's weekly settlement for that boundary was already done (${new Date(lm.settled * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC), so `
                  + "the last day's PAT-days (Sunday to Monday) went into a week it had already paid: those stakers got nothing for that day. Check the payouts."
                : "Pepe's weekly settlement waits at most an hour for this cut-off - if it ran before it, the last day of the week wasn't in its split.");
  }
  // I10: the cushion
  for (const [v, s] of Object.entries(steps || {})) {
    if (s.giveback > s.cushion_before * (1 + 1e-9) + 1e-6) {
      add("I10", v, "alert", `Staking: ${label(v)} gave back more than its cushion`, `gave ${s.giveback} shares from a cushion of ${s.cushion_before}.`);
    }
  }
  for (const v of VAULTS) {
    const st = d.v[v];
    if (!st || st.basis === undefined || st.basis === null) continue;
    const pv = Number(st.holders[PROTOCOL] || 0) * p[v];
    if (pv < Number(st.basis) - 1) {
      add("I10", v, "info", `${label(v)}: the protocol is below its basis`, `protocol ${fmt(pv)} PAT vs basis ${fmt(st.basis)} - no weekly surplus until it refills.`);
    }
  }
  return out;
}

/** The daily cut-off (pepe_vaults._vault_epoch minus the Casino-vault feed, which stays Pepe's policy). In ONE transaction;
 *  each top-up, dividend, queue item and rebalance move in its own savepoint (pepe_vaults ran them one by one too). */
async function epoch(t) {
  const c = await C.cfg();
  const d = await load();
  const now = t.nowS;
  let k = await ctx();
  let p = prices(d, k);
  const last = d.epochs.length ? d.epochs[d.epochs.length - 1] : null;
  const notes = { skim: {}, giveback: {}, cushion: {}, topup: {}, pat_days: {}, dividends: [], queue: [], rebalance: [], errors: [] };
  // the ceiling step's share-count factor per vault (pepe_vaults' ceil_f: the stakers' index) and the Auto fund's sleeves
  // before the cut-off - for the stakers' index and the audit
  const F = {}, steps = {};
  const autoH0 = Object.fromEntries(VAULTS.map((v) => [v, Number(((d.v[v] || {}).holders || {})[AUTO] || 0)]));
  if (last && now - Number(last.ts) >= 43200) {
    const dtDays = Math.max(1e-3, (now - Number(last.ts)) / 86400);
    // D1: the ceiling runs only while ceil_apr > 0 - 0 is NO ceiling (no skim, no give-back, the cushion untouched; the
    // high-water mark tracks the price - ceilingOffStep)
    const cday = ceilingDay(d, last, p, now, c);
    Object.assign(F, cday.F);
    Object.assign(steps, cday.steps);
    Object.assign(notes, { skim: cday.skim, giveback: cday.giveback, cushion: cday.cushion });
    // an off day: each vault's tracked high-water mark (ceilingOffStep) - in the vault_epoch event's notes, as the doc says
    if (Object.keys(cday.peak_off).length) notes.peak_off = cday.peak_off;
    for (const v of VAULTS) {
      const pa = Number((last.price || {})[v] || 0), pb = p[v];
      if (pa <= 0) continue;
      const r = pb / pa - 1;
      const floor = Number(c.floor_apr);
      if (Number(c.topup) && floor > 0 && !c.layers) {
        const needR = Math.pow(1 + floor, dtDays / 365) - 1;
        if (r < needR) await guarded(d, `topup ${v}`, async () => { notes.topup[v] = await topup(d, v, needR - r, p[v], k, c, t); }, notes.errors);
      }
    }
    k = await ctx();
    p = prices(d, k);
  }
  if (Number(c.dividend) && !c.tr_live && c.targets && (await C.cfgAge()) <= 7200) {
    await guarded(d, "dividends", async () => { notes.dividends = await dividends(d, now, c); }, notes.errors);
  }
  k = await ctx();
  p = prices(d, k);
  // P2.1: the day just ended, time-weighted - each stash's look-through stake x the days since the last cut-off into the
  // week's PAT-days bucket, BEFORE the queue (a stake made at this cut-off earns from now on) - pepe_vaults step 1d
  if (last) {
    // the first accrual this book has seen here: the PAT-days start (as far as the site knows) at its interval - d.pd_from,
    // DISPLAY ONLY since the 31c65d0 port (the card / page say since when; /staking's first-week sentence). Whether a week is
    // wholly time-weighted is Pepe's bucket rule (pdWhole / pdPartial), not pd_from: a book that arrives with his older
    // buckets but no pd_from (accrued by his local path before a cutover) is whole by that rule; pd_from just starts here.
    if (!(Number(d.pd_from) > 0)) d.pd_from = Number(last.ts);
    notes.pat_days = accruePatDays(d, p, Number(last.ts), now, Number(c.epoch_hour));
    // a Monday cut-off more than an hour late: Pepe's weekly settlement (it waits at most LATE_MONDAY) may have run without
    // the last day of its week - those PAT-days just went into a bucket it already settled (the audit's I8 late-monday)
    const lm = lateMonday(Number(last.ts), now, Number(c.epoch_hour), c);
    if (lm) notes.late_monday = lm;
  }
  const pend = Object.values(d.queue).filter((q) => q.state === "pending").sort((a, b) => Number(a.ts) - Number(b.ts));
  for (const q0 of pend) {
    const id = q0.id;
    const ok = await guarded(d, `queue ${id}`, async () => { await executeOne(d, d.queue[id], p, k, c); }, notes.errors);
    const q = d.queue[id];
    if (!ok) { q.error = notes.errors[notes.errors.length - 1][1]; q.error_at = now; notes.queue.push([id, "error"]); continue; }
    notes.queue.push([q.id, q.state]);
    if (q.state === "done") (notes.items = notes.items || []).push({ id: q.id, stash: q.stash, vault: q.vault, kind: q.kind, ts: q.ts, by: q.by,
                                                                     legs: q.legs || {}, refund: q.refund || 0 });
    k = await ctx();
    p = prices(d, k);
  }
  await guarded(d, "rebalance", async () => { notes.rebalance = await rebalance(d, p, c); }, notes.errors);
  k = await ctx();
  p = prices(d, k);
  const tg = autoTargets(d, c);
  const snap = { ts: now, price: Object.fromEntries([...VAULTS, AUTO].map((v) => [v, pyRoundN(p[v], 8)])),
                 nav: Object.fromEntries(VAULTS.map((v) => [v, pyRound0(nav(v, k))])),
                 staked: Object.fromEntries(VAULTS.map((v) => [v, pyRound0(stakerValue(d, v, p))])),
                 auto_nav: pyRound0(Number(d.auto.total) * p[AUTO]),
                 targets: Object.fromEntries(VAULTS.map((v) => [v, pyRoundN(tg[v], 3)])),
                 flows: (c.flows && typeof c.flows === "object") ? c.flows : {},
                 // the rule this cut-off ran with (Pepe's local snapshots carry the same keys; pepe_stakingreplay.rule_at reads
                 // them before his ceil_log): the ceiling as an APR fraction, 0 = off; the cushion 0 / 1 and its window (days)
                 ceil_apr: ceilingOn(c) ? Number(c.ceil_apr) : 0, ceil_cushion: cushionCfg(c).on ? 1 : 0, ceil_cushion_days: cushionCfg(c).days };
  snap.staker_index = stakerIndex(last, snap.price, F);
  d.epochs = d.epochs.concat([snap]).slice(-400);
  try { notes.audit = audit(d, { last, snap, p, autoH0, F, steps, c, notes, k }); }
  catch (e) { notes.audit = [{ code: "AUDIT", vault: null, level: "alert", title: "Staking audit failed", body: String((e && e.message) || e).slice(0, 300) }]; }
  d.next_epoch = nextEpochTs(now + 60, Number(c.epoch_hour));
  for (const [qid, q] of Object.entries(d.queue)) if (["done", "failed"].includes(q.state) && Number(q.done || q.ts) < now - 30 * 86400) delete d.queue[qid];
  await store(d);
  return { snap, notes };
}

// ── the protocol's capital (Pepe's policy engines: a Fed mint / loan / grant into a vault, a flash repayment, the
//    waterfall's redemption, the seed, the lotto reseed) - shares at today's price, once per key ──
async function protocol(actor, a, t) {
  if (!actor.pepe) return { ok: false, code: "forbidden", error: "Pepe only." };
  const v = String(a.vault || "");
  if (!VAULTS.includes(v)) return { ok: false, code: "bad_vault", error: "bad vault" };
  const amount = Number(a.amount);
  if (!Number.isFinite(amount) || !amount) return { ok: false, code: "bad_amount", error: "bad amount" };
  const d = await load();
  const st = d.v[v];
  if (!st) return { ok: false, code: "no_vault", error: `${v} has no shares` };
  const k = await ctx();
  const p = prices(d, k, a.nav_delta ? { [v]: Number(a.nav_delta) } : null);
  if (!(p[v] > 0)) return { ok: false, code: "no_price", error: `${v} has no price` };
  const sh = a.shares !== undefined && a.shares !== null ? Math.sign(amount) * Math.abs(Number(a.shares)) : amount / p[v];
  if (sh < 0 && Number(st.holders[PROTOCOL] || 0) + sh < -1e-6) {
    return { ok: false, code: "short", error: `the protocol holds ${Number(st.holders[PROTOCOL] || 0)} ${v} shares - can't redeem ${-sh}` };
  }
  st.holders[PROTOCOL] = Number(st.holders[PROTOCOL] || 0) + sh;
  st.total = Number(st.total) + sh;
  const b0 = Number(st.basis || 0);
  if (a.basis === "add") st.basis = Math.trunc(b0 + amount);
  else if (a.basis === "shrink") st.basis = Math.trunc(Math.max(0.0, b0 - Math.abs(amount)));
  await store(d);
  return { ok: true, vault: v, shares: sh, price: p[v], basis: st.basis === undefined ? null : st.basis, basis_before: b0 };
}

// ── APR (the page) ──
function aprEpochs(d, v) {
  const base = Number((d.apr_base || {})[v] || 0);
  return d.epochs.filter((e) => Number(e.ts) >= base && (e.price || {})[v]);
}
function apr(d, v, days, c) {
  const eps = aprEpochs(d, v);
  if (eps.length < 2) return null;
  const nw = eps[eps.length - 1];
  const need = Number(days) * 86400 * Number(c.apr_min_cover || 0.9);
  const then = eps.slice().reverse().find((e) => Number(nw.ts) - Number(e.ts) >= need);
  if (!then) return null;
  const pa = Number(then.price[v]), pb = Number(nw.price[v]);
  const dt = (Number(nw.ts) - Number(then.ts)) / 86400;
  if (pa <= 0 || pb <= 0 || dt <= 0) return null;
  return (pb / pa - 1) * 365 / dt;
}
function soFar(d, v) {
  const eps = aprEpochs(d, v);
  if (eps.length < 2) return null;
  const pa = Number(eps[0].price[v]), pb = Number(eps[eps.length - 1].price[v]);
  if (pa <= 0) return null;
  return { r: pb / pa - 1, days: Math.round((Number(eps[eps.length - 1].ts) - Number(eps[0].ts)) / 86400 * 100) / 100 };
}
/** The stakers' APR in vault v over `days` (the staker index's change, annualised like apr()); null without the history. */
function stakerApr(d, v, days, c) {
  const eps = aprEpochs(d, v).filter((e) => e.staker_index && Number(e.staker_index[v]) > 0);
  if (eps.length < 2) return null;
  const nw = eps[eps.length - 1];
  const need = Number(days) * 86400 * Number(c.apr_min_cover || 0.9);
  const then = eps.slice().reverse().find((e) => Number(nw.ts) - Number(e.ts) >= need);
  if (!then) return null;
  const ia = Number(then.staker_index[v]), ib = Number(nw.staker_index[v]);
  const dt = (Number(nw.ts) - Number(then.ts)) / 86400;
  if (ia <= 0 || ib <= 0 || dt <= 0) return null;
  return (ib / ia - 1) * 365 / dt;
}
/** The stakers' plain return so far ({r, days}) while there's less history than the APR window. */
function stakerSoFar(d, v) {
  const eps = aprEpochs(d, v).filter((e) => e.staker_index && Number(e.staker_index[v]) > 0);
  if (eps.length < 2) return null;
  const a = eps[0], b = eps[eps.length - 1];
  return { r: Number(b.staker_index[v]) / Number(a.staker_index[v]) - 1, days: Math.round((Number(b.ts) - Number(a.ts)) / 86400 * 100) / 100 };
}
const WF_FIELDS = ["surplus", "fed_loan_repaid", "stakers_share", "staked", "apr_cap", "stakers", "stakers_n", "fed", "incentives"];
/** P0.3: the weekly settlements Pepe pushes (cfg.waterfall: his last 8 epoch records, per-vault totals only - no stash ids), cleaned,
 *  oldest first. D2 (2026-10-19): a vault may carry would_cap25 (what a 25% APR cap would have paid) and weighting (how the
 *  stakes were weighted, P2.1: "pat_days" - the week wholly time-weighted, "partial" - PAT-days that began mid-week (camfrog-bot
 *  31c65d0), "snapshot" - none); since 31c65d0 also cap_pct (the cap the plan APPLIED to that vault, % APR; 0 = none) and
 *  fallback (true = D2's safeguard: no cap in force but the week wasn't wholly time-weighted, so the 25% reference cap) - null
 *  when an older Pepe didn't send them; the record staker_cap_pct (the cap in force, % APR; 0 = none) and ref_cap_pct (25). */
const numOrNull = (x) => (x === undefined || x === null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
const WEIGHTINGS = ["pat_days", "partial", "snapshot"];
/** One vault row's D2 fields from a record Pepe sent (waterfallFrom, staking.js clean): {would_cap25, weighting, cap_pct, fallback}. */
function wfRowD2(x) {
  const cap = numOrNull(x.cap_pct);
  return { would_cap25: numOrNull(x.would_cap25), weighting: WEIGHTINGS.includes(x.weighting) ? x.weighting : null,
           cap_pct: cap, fallback: cap === null ? null : (x.fallback === true || x.fallback === 1) };
}
function waterfallFrom(c) {
  const raw = Array.isArray(c && c.waterfall) ? c.waterfall : [];
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const out = [];
  for (const r of raw.slice(-8)) {
    if (!r || typeof r !== "object") continue;
    const ep = String(r.epoch || r.eid || "").slice(0, 20);
    if (!/^W\d{4}-\d{2}-\d{2}$/.test(ep)) continue;
    const vaults = {};
    for (const v of VAULTS) {
      const x = (r.vaults || {})[v];
      if (x && typeof x === "object") {
        vaults[v] = Object.assign(Object.fromEntries(WF_FIELDS.map((f) => [f, n(x[f])])), wfRowD2(x));
      }
    }
    out.push({ epoch: ep, boundary: n(r.boundary) || null, days: n(r.days) || null, done: n(r.done) || null, state: String(r.state || "").slice(0, 12),
               staker_share: Number.isFinite(Number(r.staker_share)) ? Number(r.staker_share) : null,
               staker_cap_pct: numOrNull(r.staker_cap_pct), ref_cap_pct: numOrNull(r.ref_cap_pct), vaults });
  }
  return out.sort((a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0));
}
/** P1.1 / D2: the weekly bonus cap (econ_cfg wf_staker_cap_pct, % APR on the staked value; 0 = NO cap) as a fraction -
 *  what Pepe pushed with his capital config (c.wf_staker_cap_pct), else his policy push's econ_cfg, else the site's
 *  override, else 0 = no cap (PO-0b, D-8: the code default matches prod; it was 25%, the old shared knob's value). */
async function bonusCap(c) {
  let v;
  if (c && c.wf_staker_cap_pct !== undefined && c.wf_staker_cap_pct !== null && Number.isFinite(Number(c.wf_staker_cap_pct))) {
    return Math.max(0, Math.min(1, Number(c.wf_staker_cap_pct) / 100));
  }
  try {
    const ec = await require("../policy/source").econCfg();              // PO-1: Pepe's policy push, read through policy/source.js
    if (ec) v = ec.wf_staker_cap_pct;
    else v = ((await require("../econstore").getSettings()).econ_cfg || {}).wf_staker_cap_pct;
  } catch (e) { v = undefined; }
  const n = Number(v);
  return v !== undefined && v !== null && Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : 0;   // PO-0b (D-8): no value = no cap
}
const PAID_VIA = "(via = 'waterfall stakers' OR via LIKE 'staking correction%' OR via LIKE 'apr-bug correction%')";
const CORR_VIA = "(via LIKE 'staking correction%' OR via LIKE 'apr-bug correction%')";
/** P0.3: what each stash was PAID by staking (stash_moves into the stash: the weekly payout "waterfall stakers" + staking
 *  corrections) -> {stash id: {d7, all, corr}} (all includes the corrections; corr is that part), or null when the query
 *  failed (the page then shows "—", not a made-up 0). */
async function paidByStash(nowMs) {
  const { getQuery } = require("../dbUtils");
  const cut = Math.trunc(Number(nowMs || Date.now()) - 7 * 86400000);
  let rows;
  try {
    rows = await getQuery(`SELECT stash_id AS id, COALESCE(SUM(amount),0) AS a, COALESCE(SUM(CASE WHEN ts >= ? THEN amount ELSE 0 END),0) AS w,
                                  COALESCE(SUM(CASE WHEN ${CORR_VIA} THEN amount ELSE 0 END),0) AS c
                           FROM stash_moves WHERE amount > 0 AND ${PAID_VIA} GROUP BY stash_id`, [cut]);
  } catch (e) {
    console.error("[capital] staking payouts per stash:", e.message);
    return null;
  }
  const out = {};
  for (const r of rows) if (r.id != null) out[String(r.id)] = { d7: Number(r.w) || 0, all: Number(r.a) || 0, corr: Number(r.c) || 0 };
  return out;
}
function position(d, stashId, p) {
  const key = holderKey(stashId);
  const out = {};
  for (const v of VAULTS) {
    const sh = Number(((d.v[v] || {}).holders || {})[key] || 0);
    if (sh > 0) out[v] = [sh, sh * p[v]];
  }
  const ash = Number(d.auto.holders[key] || 0);
  if (ash > 0) out[AUTO] = [ash, ash * p[AUTO]];
  const pend = Object.values(d.queue).filter((q) => q.stash === String(stashId) && ["pending", "moving"].includes(q.state));
  return [out, pend];
}

/** The /staking page's snapshot (staking.js reads staking_state) - Pepe's _vaults_publish_soon shape, from the site's own book. */
async function publish() {
  const { runQuery } = require("../dbUtils");
  const c = await C.cfg();
  const d = await load();
  if (!d.inited) return;
  const k = await ctx();
  const p = prices(d, k);
  const S = require("../stashes");
  const pdNow = patDaysNow(d, C.nowS(), Number(c.epoch_hour), lastSettled(c));
  const snap = {
    prices: p, nav: Object.fromEntries(VAULTS.map((v) => [v, Math.trunc(nav(v, k))])), auto_nav: Math.trunc(Number(d.auto.total) * p[AUTO]),
    staked: Object.fromEntries(VAULTS.map((v) => [v, Math.trunc(stakerValue(d, v, p))])),
    apr: Object.fromEntries([...VAULTS, AUTO].map((v) => [v, { 7: apr(d, v, 7, c), 30: apr(d, v, 30, c) }])),
    so_far: Object.fromEntries([...VAULTS, AUTO].map((v) => [v, soFar(d, v)])),
    mm_book: { seeds: k.mm_book.seeds, value: Math.trunc(k.mm_book.value) }, targets: autoTargets(d, c), next_epoch: d.next_epoch,
    lotto_pot: c.lotto_pot === undefined ? 0 : Number(c.lotto_pot) || 0, heist_vault: await C.poolBalance("heist"),
    targets_size: Object.fromEntries(VAULTS.map((v) => [v, Number((c.targets || {})[v]) || 0])),
    dividends: Object.values(d.dividends || {}).filter((x) => x.state === "done").map((x) => ({ vault: x.vault, amount: x.amount, ts: x.ts }))
      .sort((a, b) => a.ts - b.ts).slice(-60),
    heist_log: Array.isArray(c.heist_log) ? c.heist_log.slice(-30) : [], heist_settings: c.heist_settings || null,
    bank_cash: k.cash.bank, mm_cash: k.cash.mm,
    settings: { ceil: Number(c.ceil_apr), floor: Number(c.floor_apr), topup: !!Number(c.topup), staker_max: Number(c.staker_max),
                bank_min: Number(c.auto_bank_min), house_max: Number(c.auto_house_max), mm_max: Number(c.auto_mm_max),
                cushion: cushionCfg(c).on, cushion_days: cushionCfg(c).days, bonus_cap: await bonusCap(c),
                // P2.2 / P2.1: Auto deposits under the staker limit; the weekly payout time-weighted (this week has a PAT-days bucket)
                auto_staker_cap: autoCapOn(c), weighted: Object.keys(pdNow.vaults).length > 0 },
    epochs: d.epochs.slice(-120).map((e) => ({ ts: e.ts, price: e.price, nav: e.nav, staked: e.staked, flows: e.flows, staker_index: e.staker_index || null })),
    positions: {}, queue: [],
    // P0.3: the stakers' own numbers next to the whole vault's, the weekly settlements, the cushion
    staker_index: Object.fromEntries(VAULTS.map((v) => { const e = d.epochs[d.epochs.length - 1]; return [v, e && e.staker_index ? Number(e.staker_index[v]) || null : null]; })),
    staker_apr: Object.fromEntries(VAULTS.map((v) => [v, { 7: stakerApr(d, v, 7, c), 30: stakerApr(d, v, 30, c) }])),
    staker_so_far: Object.fromEntries(VAULTS.map((v) => [v, stakerSoFar(d, v)])),
    waterfall: waterfallFrom(c),
    cushion: Object.fromEntries(VAULTS.map((v) => { const sh = cushionShares(d.v[v], C.nowS(), cushionCfg(c).days); return [v, { shares: sh, value: Math.trunc(sh * p[v]) }]; })),
    // P2.1: this week's PAT-days per vault (the bucket next Monday settles) - each stash's own in positions[id].pd
    // (from: when the site's PAT-days began; partial: the week isn't wholly time-weighted yet - Pepe's bucket rule, pdPartial)
    pd_week: { boundary: pdNow.boundary, total: Object.fromEntries(Object.entries(pdNow.vaults).map(([v, x]) => [v, x.total])),
               from: pdNow.from, partial: pdNow.partial },
  };
  try {
    const lp = require("../lotto/service");
    if (await lp.potHasRows()) snap.lotto_pot = Math.trunc(await lp.potBalance());
    else snap.lotto_pot = await C.poolBalance("lotto");
  } catch (e) { /* no lotto service */ }
  const ids = new Set();
  for (const v of VAULTS) for (const hk of Object.keys((d.v[v] || {}).holders || {})) if (hk.startsWith("s")) ids.add(hk.slice(1));
  for (const hk of Object.keys(d.auto.holders || {})) if (hk.startsWith("s")) ids.add(hk.slice(1));
  for (const id of Object.keys(d.cost || {})) ids.add(String(id));                // P0.3: a stash that unstaked everything keeps its P/L
  for (const x of Object.values(pdNow.vaults)) for (const id of Object.keys(x.by)) ids.add(String(id));   // ...and its PAT-days this week
  const paid = await paidByStash(Date.now());
  for (const id of ids) {
    const [pos] = position(d, id, p);
    const sv = (await S.get(id)) || {};
    snap.positions[id] = { owner: sv.owner, owner_id: sv.owner_id || null, owner_name: sv.owner_name || sv.owner, name: sv.name, members: sv.members || [],
                           member_ids: sv.member_ids || [],
                           hold: Object.fromEntries(Object.entries(pos).map(([v, [s, val]]) => [v, { shares: s, value: Math.trunc(val) }])),
                           cost: (d.cost || {})[id] || {}, paid: paid ? (paid[id] || { d7: 0, all: 0, corr: 0 }) : null,
                           pd: Object.fromEntries(Object.entries(pdNow.vaults).filter(([, x]) => Number(x.by[id]) > 0).map(([v, x]) => [v, Number(x.by[id])])) };
  }
  snap.queue = Object.values(d.queue).filter((q) => ["pending", "moving"].includes(q.state))
    .map((q) => ({ id: q.id, stash: q.stash, vault: q.vault, kind: q.kind, amount: q.amount, shares: q.shares, state: q.state, ts: q.ts }));
  await require("../staking").ready;
  const clean = require("../staking").clean(snap);
  const nowMs = Date.now();
  await runQuery(`INSERT INTO staking_state (id, data, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
                 [JSON.stringify(clean), nowMs]);
  require("../staking").setCache(clean, nowMs);
  const lastE = clean.epochs[clean.epochs.length - 1];
  if (lastE) {
    const day = new Date(lastE.ts * 1000).toISOString().slice(0, 10);
    await runQuery(`INSERT INTO staking_daily (day, ts, prices, nav, staked, updated) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(day) DO UPDATE SET ts = excluded.ts, prices = excluded.prices, nav = excluded.nav, staked = excluded.staked, updated = excluded.updated`,
                   [day, lastE.ts, JSON.stringify(lastE.price), JSON.stringify(lastE.nav), JSON.stringify(lastE.staked), nowMs]).catch(() => {});
  }
}

async function read(verb, actor, a) {
  const d = await load();
  const k = await ctx();
  const p = prices(d, k);
  if (verb === "summary" || verb === "yield") {
    const c = await C.cfg();
    return { prices: p, nav: Object.fromEntries(VAULTS.map((v) => [v, nav(v, k)])), staked: Object.fromEntries(VAULTS.map((v) => [v, stakerValue(d, v, p)])),
             auto_nav: Number(d.auto.total) * p[AUTO], apr7: Object.fromEntries([...VAULTS, AUTO].map((v) => [v, apr(d, v, 7, c)])), next_epoch: d.next_epoch };
  }
  if (verb === "position") {
    const [pos, pend] = position(d, String(a.stash), p);
    return { position: pos, pending: pend, prices: p, next_epoch: d.next_epoch };
  }
  return {};
}
async function act(verb, actor, a, t) {
  if (verb === "stake") return request(actor, Object.assign({}, a, { kind: "deposit" }), t);
  if (verb === "unstake") return request(actor, Object.assign({}, a, { kind: "withdraw" }), t);
  if (verb === "protocol") return protocol(actor, a, t);
  return { ok: false, code: "bad_verb", error: `unknown vault verb ${verb}` };
}
const READS = ["summary", "yield", "position"];

module.exports = { VAULTS, AUTO, PROTOCOL, CASH, LABEL, SITE_KEYS, load, store, live, ctx, nav, prices, freeCash, stakerValue, autoTargets, nextEpochTs,
                   epoch, protocol, request, act, read, READS, publish, position, apr, soFar, pyRoundN, holderKey, transfer,
                   // staking fix plan (2026-10-19)
                   skim, giveBack, ceilingStep, ceilingCap, ceilingOn, ceilingOffStep, ceilingDay, cushionCfg, cushionShares, cushionHorizon, nonProtocolShares, stakerIndex, audit,
                   AUDIT, CUSHION_SLACK, CUSHION_KEEP_DAYS, CUSHION_MAX_DAYS, PD_KEEP, PD_SLACK, LATE_MONDAY, lookThrough, accruePatDays, patDaysNow, pdPartial, pdWhole, pdFirstWeek, lastSettled, settledFrom,
                   lateMonday, settlesAt, autoCapOn, stakerRoom, capAutoLegs, autoCappedLegs,
                   stakerApr, stakerSoFar, waterfallFrom, wfRowD2, WEIGHTINGS, paidByStash, bonusCap, addCost, backfillCost, queueWhole, impliedHoldings, holdingOf, replayCeiling, REPLAY_CEIL,
                   PAID_VIA, CORR_VIA };
