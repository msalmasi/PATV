// policy/gather.js — Phase 4: the `inputs` object each engine plans from (policy/engines.js), built from the SITE's tables -
// the same object camfrog-bot pepe_policyinputs.py builds from Pepe's live state.
//
// Where each input comes from:
//   pools, the House               pools.js (Phase 1), SUM(jackpot_rakes)
//   prices, NAVs, the share book   capital/vaults.js (Phase 3: ctx / nav / prices, the "vaults" doc's holders IN ORDER)
//   stashes (closed or not)        stashes.js
//   econ_cfg (effective), consts,  Pepe's config push (/api/policy/bot/config, every few minutes; policy_meta.cfg) - the
//   flags, the participation tz,   numbers his own engines use; econstore's econ_cfg overrides are laid over it
//   bots to skip, his journals
//   Fed loans, mints, the week's   Pepe's econ docs (econstore econ_docs: econ_layers / econ_treasury, pushed on every change)
//   budget record, bank samples    OVERLAID with what the site did itself and Pepe's doc doesn't show yet - by content, never
//                                  by ack: a loan repayment whose mark isn't in fed_loan_repaid, a mint whose key isn't in
//                                  fed_mints, a budget spend whose key isn't in site_spends, a bank sample not in bank_lent
//   participation rows             econ_participation (Pepe's E-0 sync), the local day = Pepe's (America/New_York)
//   total supply (issuance pct)    supply.patSupply
"use strict";
const P = require("../pools");
const C = require("./core");
const E = require("./engines");

const TZ_DEFAULT = "America/New_York";
const BUDGET_KEYS = Object.keys(E.BUDGETS);

async function docs() {
  try { return await require("../econstore").getDocs(); } catch (e) { return {}; }
}
const docOf = (all, name) => ((all[name] || {}).doc) || {};
/** Pepe's econ_layers doc - or, once the Fed's books live on the site (P4-1, fed/service.js), the site's own journal. */
async function layersOf(all) {
  const F = require("../fed/service");
  if (await F.live()) return F.layersDoc();
  return docOf(all, "econ_layers");
}

/** Pepe's pushed config + the site's econ_cfg overrides. */
async function config() {
  const push = (await C.cfg()) || {};
  let over = {};
  try { over = (await require("../econstore").getSettings()).econ_cfg || {}; } catch (e) { over = {}; }
  // Pepe's EFFECTIVE values are the truth his own engines use (every key, defaults included); the overrides table only stands
  // in when he never pushed them
  const cfg = push.econ_cfg && typeof push.econ_cfg === "object" && Object.keys(push.econ_cfg).length ? Object.assign({}, push.econ_cfg)
    : Object.assign({}, E.DEFAULTS, over);
  return { push, cfg, consts: push.consts || {}, flags: push.flags || {} };
}

async function poolsNow() {
  const cap = require("../capital/core");
  const out = {};
  for (const k of ["reserve", "bank", "mm", "fortknox", "heist", "incentives", "burn"]) out[k] = await P.balance(k);
  out.jackpot = Math.max(0, await cap.houseBalance());
  return out;
}

// ── overlays ──
async function siteMints() {
  await C.init();
  const { getQuery } = require("../dbUtils");
  return (await getQuery("SELECT key, rec FROM policy_mints ORDER BY ts, key")).map((r) => C.parse(r.rec, null)).filter(Boolean);
}
async function mints(layers, nowS) {
  const recs = layers.fed_mints || {};
  const lo = nowS - 40 * 86400;
  const keep = ["key", "amount", "policy", "source", "state", "dest", "ts", "done"];
  const pick = (r) => Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]]));
  const out = Object.values(recs).filter((r) => r && typeof r === "object" && Number(r.ts || 0) >= lo).map(pick);
  for (const r of await siteMints()) if (!(r.key in recs) && Number(r.ts || 0) >= lo) out.push(pick(r));
  return out.sort((a, b) => (Number(a.ts || 0) - Number(b.ts || 0)) || (String(a.key) < String(b.key) ? -1 : 1));
}
async function fedLoans(layers) {
  const loans = Object.values(layers.fed_loans || {}).filter((r) => r && typeof r === "object").map((r) => Object.assign({}, r));
  const marks = layers.fed_loan_repaid || {};
  const reps = (await C.effectsAll(null, ["loan_repay"])).filter((e) => !(e.data.mark in marks));
  for (const e of reps) {
    let left = Math.trunc(Number(e.data.amount) || 0);
    for (const r of loans.filter((x) => x.state === "open" && x.vault === e.data.vault).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))) {
      if (left <= 0) break;
      const pay = Math.min(left, Math.trunc(Number(r.outstanding) || 0));
      if (pay <= 0) continue;
      r.outstanding = Math.trunc(Number(r.outstanding)) - pay;
      if (r.outstanding <= 0) r.state = "repaid";
      left -= pay;
    }
  }
  const keep = ["id", "vault", "principal", "outstanding", "state", "ts", "flash", "auto"];
  return loans.map((r) => Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]])));
}
async function week(treasury) {
  const w = treasury.week && typeof treasury.week === "object" ? JSON.parse(JSON.stringify(treasury.week)) : null;
  if (!w) return null;
  const seen = treasury.site_spends || {};
  for (const e of await C.effectsAll(null, ["budget_spend"])) {
    if (e.key in seen || e.data.week !== w.id) continue;
    w.spent = w.spent || {};
    w.spent[e.data.group] = Math.max(0, Math.trunc(Number(w.spent[e.data.group] || 0)) + Math.trunc(Number(e.data.amount) || 0));
  }
  for (const e of await C.effectsAll(null, ["week_share"])) {
    if (e.data.week === w.id && (w.share === null || w.share === undefined)) {
      w.share = e.data.share;
      w.release_per_day = e.data.release_per_day;
    }
  }
  return { id: w.id, budgets: w.budgets || {}, spent: w.spent || {}, share: w.share === undefined ? null : w.share,
           release_per_day: w.release_per_day === undefined ? null : w.release_per_day };
}
async function bankLent(treasury) {
  const out = (treasury.bank_lent || []).map(([t, a]) => [Number(t), Math.trunc(Number(a) || 0)]);
  const have = new Set(out.map((x) => x[0]));
  for (const e of await C.effectsAll(null, ["bank_lent"])) if (!have.has(Number(e.data.ts))) out.push([Number(e.data.ts), Math.trunc(Number(e.data.amount) || 0)]);
  return out.sort((a, b) => a[0] - b[0]);
}
/** The weekly epochs: the site's own runs + the ones Pepe ran (his config push). */
async function journal(push) {
  const out = new Map();
  for (const r of push.journal || []) if (r && r.eid) out.set(r.eid, { eid: r.eid, boundary: Number(r.boundary || 0), state: r.state, incentives_after: r.incentives_after ?? null });
  const { getQuery } = require("../dbUtils");
  await C.init();
  for (const r of await getQuery("SELECT period, state, boundary, result FROM policy_runs WHERE engine = 'treasury' AND period LIKE 'W%'")) {
    const res = C.parse(r.result, {}) || {};
    if (r.state === "done" || r.state === "handed") {
      out.set(r.period, { eid: r.period, boundary: Number(r.boundary || res.boundary || 0), state: "done", incentives_after: res.incentives_after ?? null });
    } else if (!out.has(r.period)) {
      out.set(r.period, { eid: r.period, boundary: Number(r.boundary || 0), state: r.state === "moving" ? "moving" : r.state, incentives_after: null });
    }
  }
  return [...out.values()];
}
/** Has the treasury's daily release for `did` run (here or in Pepe)? */
async function dailyDone(push, did) {
  const r = await C.run("treasury", did);
  if (r && (r.state === "done" || r.state === "handed")) return true;
  return (push.days_done || []).includes(did);
}

// ── the local (participation) day: Pepe's time.localtime(ts - 6 h) in his time zone ──
function localDay(ts, tz = TZ_DEFAULT) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = {};
  for (const x of f.formatToParts(new Date((ts - 6 * 3600) * 1000))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
function prevDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const out = [day];
  for (let i = 1; i <= n; i++) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}
async function partRows(days) {
  const { getQuery } = require("../dbUtils");
  try {
    const rows = await getQuery(`SELECT day, login, lines, mic_min FROM econ_participation WHERE day IN (${days.map(() => "?").join(",")})
                                 AND (lines > 0 OR mic_min > 0) ORDER BY day, rowid`, days);
    return rows.map((r) => [r.day, String(r.login || ""), Math.trunc(Number(r.lines) || 0), Number(r.mic_min) || 0]);
  } catch (e) { return []; }
}

// ── the inputs ──
async function epoch(nowS, eid) {
  const V = require("../capital/vaults");
  const { push, cfg, consts, flags } = await config();
  const all = await docs();
  const d = await V.load();
  const k = await V.ctx();
  const prices = V.prices(d, k);
  const book = {};
  for (const v of ["house", "bank", "mm"]) {
    const st = d.v[v];
    if (!st) continue;
    const x = { total: Number(st.total || 0), holders: Object.entries(st.holders || {}).map(([hk, sh]) => [hk, Number(sh)]) };
    if (st.basis !== undefined) x.basis = st.basis;
    book[v] = x;
  }
  const auto = { total: Number(d.auto.total || 0), holders: Object.entries(d.auto.holders || {}).map(([hk, sh]) => [hk, Number(sh)]) };
  const ids = new Set();
  for (const x of [...Object.values(book), auto]) for (const [hk] of x.holders) if (String(hk).startsWith("s")) ids.add(String(hk).slice(1));
  const S = require("../stashes");
  const stashes = {};
  for (const id of [...ids].sort()) {
    const s = await S.get(id).catch(() => null);
    if (s) stashes[id] = !s.closed;
  }
  const navs = {};
  for (const v of Object.keys(book)) navs[v] = V.nav(v, k);
  return { kind: "epoch", now: nowS, eid, cfg, consts, flags, pools: await poolsNow(),
           prices: Object.fromEntries(Object.entries(prices).map(([a, b]) => [a, Number(b)])), navs, bank_nav: V.nav("bank", k),
           mm_seeds: Math.trunc(Number(k.mm_book.seeds) || 0), vaults: book, auto, stashes, journal: await journal(push),
           bank_lent: await bankLent(docOf(all, "econ_treasury")), fed_loans: await fedLoans(await layersOf(all)) };
}
async function daily(nowS, did) {
  const { cfg, consts, flags } = await config();
  const all = await docs();
  return { kind: "daily", now: nowS, did, cfg, consts, flags, pools: await poolsNow(), fed_loans: await fedLoans(await layersOf(all)),
           mints: await mints(await layersOf(all), nowS), week: await week(docOf(all, "econ_treasury")) };
}
async function monetary(nowS, did, guarantee) {
  const { push, cfg, consts, flags } = await config();
  const all = await docs();
  const ld = localDay(nowS, push.tz || TZ_DEFAULT);
  const c = Object.assign({}, E.DEFAULTS, cfg);
  const scaling = (c.issuance_mode === "pct" || c.issuance_mode === "fixed") && !!c.issuance_activity_scaling;
  const days = scaling ? prevDays(ld, 30) : [ld];
  const rows = await partRows(days);
  const skipSet = new Set((push.skip || []).map((s) => String(s).toLowerCase()));
  const skip = [...new Set(rows.map((r) => r[1].toLowerCase()))].filter((lg) => skipSet.has(lg)).sort();
  let supply = null;
  if (c.issuance_mode === "pct") {
    try { supply = (await require("../supply").patSupply()).total || null; } catch (e) { supply = null; }
  }
  return { kind: "monetary", now: nowS, did, guarantee: !!guarantee, cfg, consts, flags, pools: await poolsNow(),
           mints: await mints(await layersOf(all), nowS), journal: await journal(push), week: await week(docOf(all, "econ_treasury")),
           local_day: ld, days, rows, skip, supply };
}

module.exports = { epoch, daily, monetary, config, poolsNow, journal, dailyDone, localDay, prevDays, partRows, fedLoans, mints, week, bankLent,
                   docs, docOf, layersOf, BUDGET_KEYS };
