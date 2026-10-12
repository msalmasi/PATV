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
"use strict";
const C = require("./core");
const X = require("./lmsr");

const VAULTS = ["bank", "house", "mm"];
const AUTO = "auto", PROTOCOL = "protocol";
const CASH = { bank: "bank", house: "jackpot", mm: "mm" };
const LABEL = { bank: "🏦 Bank", house: "🎰 House", mm: "📈 Market maker", auto: "🤖 Auto" };
const SITE_KEYS = ["v", "auto", "queue", "epochs", "seq", "apr_base", "next_epoch", "dividends", "rebalances", "insured", "v2_defaults", "inited"];
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
    if (amt > S.free(s)) return { ok: false, code: "insufficient", error: `${s.owner}/${s.name} only has PAT ${fmt(S.free(s))} free.` };
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
async function finishOne(d, q) {
  const key = holderKey(q.stash);
  const p = q.prices;
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
  q.state = "done";
  q.done = C.nowS();
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
      const amt = Math.trunc(Math.min(extra, gap, freeCash(src, k)));
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

/** The daily cut-off (pepe_vaults._vault_epoch minus the Casino-vault feed, which stays Pepe's policy). In ONE transaction;
 *  each top-up, dividend, queue item and rebalance move in its own savepoint (pepe_vaults ran them one by one too). */
async function epoch(t) {
  const c = await C.cfg();
  const d = await load();
  const now = t.nowS;
  let k = await ctx();
  let p = prices(d, k);
  const last = d.epochs.length ? d.epochs[d.epochs.length - 1] : null;
  const notes = { skim: {}, topup: {}, dividends: [], queue: [], rebalance: [], errors: [] };
  if (last && now - Number(last.ts) >= 43200) {
    const dtDays = Math.max(1e-3, (now - Number(last.ts)) / 86400);
    for (const v of VAULTS) {
      const pa = Number((last.price || {})[v] || 0), pb = p[v];
      if (pa <= 0) continue;
      const r = pb / pa - 1;
      const ceil = Number(c.ceil_apr);
      if (ceil > 0) {
        const st = d.v[v];
        const peak = Math.max(pa, Number(st.peak_price === undefined ? pa : st.peak_price));
        const allow = Math.pow(1 + ceil, dtDays / 365) - 1;
        const capPrice = peak * (1 + allow);
        if (pb > capPrice) notes.skim[v] = skim(d, v, capPrice / pb);
        st.peak_price = Math.max(peak, Math.min(pb, capPrice));
      }
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
                 flows: (c.flows && typeof c.flows === "object") ? c.flows : {} };
  d.epochs = d.epochs.concat([snap]).slice(-400);
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
                bank_min: Number(c.auto_bank_min), house_max: Number(c.auto_house_max), mm_max: Number(c.auto_mm_max) },
    epochs: d.epochs.slice(-120).map((e) => ({ ts: e.ts, price: e.price, nav: e.nav, staked: e.staked, flows: e.flows })),
    positions: {}, queue: [],
  };
  try {
    const lp = require("../lotto/service");
    if (await lp.potHasRows()) snap.lotto_pot = Math.trunc(await lp.potBalance());
    else snap.lotto_pot = await C.poolBalance("lotto");
  } catch (e) { /* no lotto service */ }
  const ids = new Set();
  for (const v of VAULTS) for (const hk of Object.keys((d.v[v] || {}).holders || {})) if (hk.startsWith("s")) ids.add(hk.slice(1));
  for (const hk of Object.keys(d.auto.holders || {})) if (hk.startsWith("s")) ids.add(hk.slice(1));
  for (const id of ids) {
    const [pos] = position(d, id, p);
    const sv = (await S.get(id)) || {};
    snap.positions[id] = { owner: sv.owner, name: sv.name, members: sv.members || [],
                           hold: Object.fromEntries(Object.entries(pos).map(([v, [s, val]]) => [v, { shares: s, value: Math.trunc(val) }])) };
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
                   epoch, protocol, request, act, read, READS, publish, position, apr, soFar, pyRoundN, holderKey, transfer };
