// policy/derived.js — PO-4 of the economy policy -> site plan ("Phase 6"): the policy state Pepe still derives and PUSHES with his
// capital config (camfrog-bot pepe_capitalstore._cap_cfg -> POST /api/capital/bot/config -> capital_meta "cfg"), derived here from
// the site's own tables instead. 1.99??: SHADOW ONLY - nothing reads these values for a decision until H2a (the loans desk keeps
// reading Pepe's push through capital/reserve.js's cfgAge guard; the cut-off keeps his flows); policy/scheduler.js derivedPass
// compares them with his push once a day (the derived dual read, policy_sims "shadow:derived:D<date>").
//
//   targets   {bank, house, mm}  pepe_vaults._vault_target (pepe_treasury._tr_target while the treasury is live, else the v1 rule)
//   fl_room   the Fed's flash / liquidity loan room - pepe_monetary._mo_flash_room = pepe_layers._loan_cap - _fl_outstanding
//   credit    the credit score's weights + the instant-limit terms - pepe_credit._credit_terms
//   flows     {vault: {in: {why: PAT}, out: {...}}} since the last cut-off - pepe_vaults._vault_flows_since over Pepe's own vault
//             flow ledger (vault_ledger.json: only the moves HE makes); the site rebuilds it best-effort from the rows those moves
//             leave here (siteLedger) - display only (the cut-off copies it into the epoch record for /staking), whitelisted in
//             the dual read (policy/scheduler.js WHITELIST "flows")
//
// The PURE part (derive and friends) is an exact port, proven by camfrog-bot tools/gen_derived_vectors.py -> test/fixtures/
// policy-derived-vectors.json.gz (test/policy-derived-vectors.test.js: Pepe's REAL functions on random state, 0 differences).
// Python semantics: int() truncates (engines.pyInt), max(int, float) keeps the float until int(), the v1 Bank target's "lent" is
// a FLOAT (never clamped nor truncated before the multiply), the flows' day is the local date of `since` in Pepe's time zone
// (naive datetime.fromtimestamp on VM 110 = America/New_York).
// The I/O part (gather) reads only the site: the config store (policy/source.js since H1; policy/config.js's snapshot for the
// two v1 keys), the capital book (capital/vaults ctx / load), the bank-lent samples (policy/gather.bankLent) and the Fed's loans
// (policy/gather.fedLoans on the Fed's own journal) - NEVER a target, fl_room, credit or flows from Pepe's push.
// Every attempt records capital_meta "derived" = {day, at, asof, push_at, values, fp} (the plan's name; display only).
"use strict";
const crypto = require("crypto");
const E = require("./engines");

const pyInt = E.pyInt;
const VAULT_NAMES = ["bank", "house", "mm"];                 // pepe_vaults.VAULT_NAMES (the push's targets order)
const FLOW_VAULTS = ["bank", "jackpot", "mm", "lotto"];      // _vault_flows_since reports these four, in this order
const TZ_DEFAULT = "America/New_York";
const LEGACY = { VAULT_HOUSE_TARGET: 20000000, VAULT_BANK_MIN_TARGET: 5000000 };   // pepe_vaults' v1 class constants
const FEDLOAN_CAP = 10000000;                                 // pepe_layers.FEDLOAN_CAP
/** pepe_credit.CREDIT_W: credit.js's DEFAULT_W without the capacity terms (_credit_terms adds those from the loan settings) -
 *  pinned to Pepe's dict by the vectors. */
const CREDIT_W = (() => {
  const w = JSON.parse(JSON.stringify(require("../credit").DEFAULT_W));
  delete w.capacity_base;
  delete w.capacity_per_level;
  return w;
})();

// ── the pure part ──
const flagsOf = (inp) => (inp && inp.flags) || {};
/** pepe_treasury._tr_live = _tr_on AND _layers_on (the push's flags: tr_live = econ_treasury, layers = econ_layers). */
const trLive = (inp) => !!(flagsOf(inp).tr_live && flagsOf(inp).layers);
const poolOf = (inp, k) => pyInt(((inp && inp.pools) || {})[k]);
/** pepe_treasury._tr_bank_lent: max(0, int(the Bank's NAV - its cash)). */
const bankLent = (inp) => Math.max(0, pyInt(Number(inp.bank_nav) - poolOf(inp, "bank")));
/** pepe_treasury._tr_bank_peak(now): the lent-out now and every sample of the last bank_peak_days (Number(t) >= the cutoff). A
 *  local copy: policy/engines.js keeps its own internal one (not on PO-4's change list) - the vectors pin both to Pepe's. */
function bankPeak(inp, now) {
  const c = E.C(inp);
  const cutoff = Number(now) - c.int("bank_peak_days", 30) * 86400;
  let m = bankLent(inp);
  for (const x of inp.bank_lent || []) {
    if (!Array.isArray(x)) continue;
    if (Number(x[0]) >= cutoff) m = Math.max(m, pyInt(x[1]));
  }
  return m;
}
/** pepe_vaults._vault_target(v): the treasury's v2 target while it is live (_tr_target = policy/engines target, force), else the
 *  v1 rule - House VAULT_HOUSE_TARGET; Bank max(VAULT_BANK_MIN_TARGET, lent x VAULT_TARGET_MULT) with lent = NAV - cash as a float;
 *  Market maker max(VAULT_MM_MIN_TARGET, the seeds committed x VAULT_TARGET_MULT) (the same in both rules). */
function vaultTarget(inp, v) {
  const c = E.C(inp);
  const now = Number(inp.now);
  if (trLive(inp)) {
    const t = E.target(inp, c, v, now);
    if (t !== null && t !== undefined) return pyInt(t);
  }
  const mult = Number(c.k("VAULT_TARGET_MULT"));
  const legacy = Object.assign({}, LEGACY, inp.legacy || {});
  if (v === "house") return pyInt(legacy.VAULT_HOUSE_TARGET);
  if (v === "bank") {
    const lent = Number(inp.bank_nav) - poolOf(inp, "bank");
    return pyInt(Math.max(pyInt(legacy.VAULT_BANK_MIN_TARGET), lent * mult));
  }
  if (v === "mm") return pyInt(Math.max(pyInt(c.k("VAULT_MM_MIN_TARGET")), pyInt(inp.mm_seeds) * mult));
  return 0;
}
const targets = (inp) => Object.fromEntries(VAULT_NAMES.map((v) => [v, vaultTarget(inp, v)]));
/** pepe_monetary._mo_flash_room: max(0, the fedloan_cap setting - every PAT the Fed has lent and not been repaid) - an open loan
 *  at its outstanding, a journaled one (pending, its PAT not landed yet) at its principal; every vault, not only the Treasury's. */
function flRoom(inp) {
  const c = E.C(inp);
  let out = 0;
  for (const r of inp.fed_loans || []) {
    if (!r || typeof r !== "object") continue;
    if (r.state === "open") out += pyInt(r.outstanding);
    else if (r.state === "pending") out += pyInt(r.principal);
  }
  return Math.max(0, c.int("fedloan_cap", FEDLOAN_CAP) - out);
}
/** pepe_credit._credit_terms: CREDIT_W + the instant-limit terms (RLOAN_BASE_LIMIT, RLOAN_PER_LEVEL). */
function credit(inp) {
  const r = (inp && inp.rloan) || {};
  return Object.assign(JSON.parse(JSON.stringify(CREDIT_W)), { capacity_base: pyInt(r.base), capacity_per_level: pyInt(r.per_level) });
}
/** The local date (YYYY-MM-DD) of `ts` (s) in `tz` - Python's naive datetime.fromtimestamp(ts).strftime("%Y-%m-%d") on a host in tz. */
function localDate(ts, tz = TZ_DEFAULT) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || TZ_DEFAULT, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = {};
  for (const x of f.formatToParts(new Date(Math.floor(Number(ts) * 1000)))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
/** Python truthiness of a ledger entry (`if not x: continue`). */
const pyFalsy = (x) => x === undefined || x === null || x === false || x === 0 || x === "" || Number.isNaN(x)
  || (Array.isArray(x) && !x.length) || (typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length);
/**
 * pepe_vaults._vault_flows_since(since) over a vault ledger {days: {YYYY-MM-DD: {vault: {in: {why: PAT}, out: {...}}}}}: every
 * day >= the local date of `since` (string compare), the vaults bank / jackpot / mm / lotto in that order, a why starting with
 * "vault " skipped (deposits / withdrawals aren't revenue), the PAT summed per why and side. A vault with an entry gets
 * {in: {}, out: {}} even when every why in it was skipped.
 */
function flowsSince(ledger, since, tz = TZ_DEFAULT) {
  const day0 = localDate(since, tz);
  const out = new Map();
  for (const [day, vs] of Object.entries((ledger && ledger.days) || {})) {
    if (day < day0) continue;
    if (!vs || typeof vs !== "object") continue;
    for (const v of FLOW_VAULTS) {
      const x = vs[v];
      if (pyFalsy(x)) continue;
      if (!out.has(v)) out.set(v, { in: new Map(), out: new Map() });
      const o = out.get(v);
      for (const side of ["in", "out"]) {
        const s = (x && typeof x === "object" ? x[side] : null) || {};
        for (const [why, a] of Object.entries(s)) {
          if (String(why).startsWith("vault ")) continue;            // deposits / withdrawals aren't revenue
          o[side].set(why, (o[side].has(why) ? o[side].get(why) : 0) + pyInt(a));
        }
      }
    }
  }
  return Object.fromEntries([...out].map(([v, o]) => [v, { in: Object.fromEntries(o.in), out: Object.fromEntries(o.out) }]));
}
/** Everything Pepe's capital push derives, from one inputs object (gather's) -> {targets, fl_room, flash_room, credit, flows, diag}. */
function derive(inp) {
  const fl = flRoom(inp);
  return { targets: targets(inp), fl_room: fl, flash_room: fl, credit: credit(inp),
           flows: flowsSince(inp.ledger || {}, Number(inp.since), inp.tz || TZ_DEFAULT),
           diag: { bank_lent: bankLent(inp), bank_peak: bankPeak(inp, Number(inp.now)), tr_live: trLive(inp) } };
}

// ── the I/O part ──
/** Canonical JSON (sorted keys) for the fingerprint. */
function canonical(x) {
  if (x === null || typeof x !== "object") return JSON.stringify(x === undefined ? null : x);
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  return "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + canonical(x[k])).join(",") + "}";
}
/** sha256 of the site's values + its inputs (without `now`): two attempts with the same fingerprint saw the same site state. */
function fingerprint(values, inputs) {
  const inp = Object.assign({}, inputs || {});
  delete inp.now;
  return crypto.createHash("sha256").update(canonical({ values, inputs: inp }), "utf8").digest("hex");
}

/**
 * A best-effort rebuild of Pepe's vault_ledger.json days for (the local day of `since`) .. asOf from the rows HIS moves leave on
 * the site (only Pepe's _vault_log calls feed his ledger - the site's own moves never did). Bucketed by local day in `tz`, the
 * sign deciding in or out; only rows at or before asOf. What maps to what (DELIVERY.md lists every _vault_log call site):
 *   bank / mm   pool_move_legs + pool_moves with via 'pepe' (his /api/pools/move, fund, charge): why = pool_moves.why for a move,
 *               the flow for a fund / charge (Pepe logs the flow there)
 *   jackpot     bot_credit_log endpoint 'jackpot-adjust' (his _heist_jackpot_adjust): why = its source (Pepe's why, cut to 64)
 *   lotto       lotto_pot rows "bot:<ref>" (his _lotto_pot_adjust): why = the row's why
 * Not reproducible: the escrow settle fee legs (pepe_escrowstore: "escrow fees (<ref>)" - the site's settle rows carry no vault
 * leg of Pepe's), a why of None (Pepe names the caller's frame), his standalone / local-pools modes. -> {days}
 * NOT CLOSE (review of PO-4, prod 11-04): prod's lotto_pot has no "bot:" rows (its moves are lt:c / lt:w / impo), so the lotto
 * source maps nothing; the jackpot-adjust rows are EVERY House adjust Pepe makes (blackjack payouts, lotto fees, ...) while his
 * _vault_log logs few of them. The site's flows differ from his (mostly {}) on most days - whitelisted, display only.
 */
const LEDGER_WARNED = new Set();
async function siteLedger(since, asOf, tz = TZ_DEFAULT) {
  const { getQuery } = require("../dbUtils");
  const days = {};
  const lo = Date.parse(localDate(since, tz) + "T00:00:00Z") - 2 * 86400e3;  // a margin: the local day starts up to 14 h off UTC
  const hi = Math.floor(Number(asOf) * 1000);
  const put = (ts, vault, why, amount) => {
    const a = pyInt(amount);
    if (!a) return;
    const day = localDate(Number(ts) / 1000, tz);
    const d = days[day] || (days[day] = {});
    const v = d[vault] || (d[vault] = { in: {}, out: {} });
    const side = a > 0 ? v.in : v.out;
    const w = String(why == null || why === "" ? "other" : why);
    side[w] = (Object.prototype.hasOwnProperty.call(side, w) ? side[w] : 0) + Math.abs(a);
  };
  // a source that can't be read gives nothing (flows is display only), said once per process (review of PO-4: not silently) -
  // except a table this database doesn't have (a test database, a site without lotto)
  const safe = async (sql, params) => {
    try { return await getQuery(sql, params); } catch (e) {
      const m = String((e && e.message) || e);
      if (!/no such table/i.test(m) && !LEDGER_WARNED.has(m)) { LEDGER_WARNED.add(m); console.warn(`[policy] derived flows: a ledger source failed (${m.slice(0, 160)}) - left out`); }
      return [];
    }
  };
  for (const r of await safe(`SELECT l.ts AS ts, l.pool AS pool, l.amount AS amount, m.kind AS kind, m.flow AS flow, m.why AS why
                              FROM pool_move_legs l JOIN pool_moves m ON m.key = l.move_key
                              WHERE m.via = 'pepe' AND l.pool IN ('bank', 'mm') AND l.ts >= ? AND l.ts <= ? ORDER BY l.ts, l.move_key, l.i`, [lo, hi])) {
    put(r.ts, r.pool, r.kind === "fund" || r.kind === "charge" ? r.flow : r.why, r.amount);
  }
  for (const r of await safe(`SELECT ts, amount, source FROM bot_credit_log WHERE endpoint = 'jackpot-adjust' AND outcome = 'ok' AND ts >= ? AND ts <= ?
                              ORDER BY ts, ref`, [lo, hi])) put(r.ts, "jackpot", r.source, r.amount);
  for (const r of await safe("SELECT created AS ts, amount, why FROM lotto_pot WHERE moveId LIKE 'bot:%' AND created >= ? AND created <= ? ORDER BY created, moveId",
                             [lo, hi])) put(r.ts, "lotto", r.why, r.amount);
  // insertion order = day order (Pepe's ledger adds each day as it opens)
  return { days: Object.fromEntries(Object.keys(days).sort().map((d) => [d, days[d]])) };
}

/** The v1 keys of the config store (vault_house_target / vault_bank_min_target, read-only "legacy" settings) or their defaults. */
async function legacyOf() {
  const out = Object.assign({}, LEGACY);
  let snap = null;
  try { snap = await require("./config").readerSnap("the derived state"); } catch (e) { snap = null; }
  const cfg = (snap && snap.cfg) || {};
  if (Number.isFinite(Number(cfg.vault_house_target)) && cfg.vault_house_target !== null && cfg.vault_house_target !== "") out.VAULT_HOUSE_TARGET = Number(cfg.vault_house_target);
  if (Number.isFinite(Number(cfg.vault_bank_min_target)) && cfg.vault_bank_min_target !== null && cfg.vault_bank_min_target !== "") out.VAULT_BANK_MIN_TARGET = Number(cfg.vault_bank_min_target);
  return out;
}
/**
 * derive()'s inputs at `asOfS` (s) from the site's tables: the engines' config (policy/source.js: policy_cfg since H1), the two v1
 * keys, the loan terms (capital/core cfg: rloan_base / rloan_per_level ONLY), the capital book (pools.bank = the Bank's cash,
 * bank_nav = its NAV, mm_seeds = the Market maker's committed seeds - Pepe's filters: bank-funded funding / active loans not
 * insured nor written off; LMSR markets seeded from mm, open / closed / settling, not paid out), the bank-lent samples (the
 * econ_treasury doc + the site's own bank_lent effects), the Fed's loans (its journal: the Fed is live), the last cut-off (since:
 * the book's newest epoch, else asOf - 1 day), the time zone and the rebuilt ledger. Throws what the config store throws
 * (E_CFG_MISSING / E_CFG_UNREADABLE) - the caller records it as a blocking attempt.
 */
async function gather(asOfS) {
  const S = require("./source");
  const G = require("./gather");
  const CC = require("../capital/core");
  const V = require("../capital/vaults");
  const asOf = Number(asOfS);
  const { push, cfg, consts, flags } = await S.config();
  const legacy = await legacyOf();
  const cc = await CC.cfg();
  const k = await V.ctx();
  const book = await V.load();
  const all = await G.docs();
  const bank_lent = await G.bankLent(G.docOf(all, "econ_treasury"));
  const fed_loans = await G.fedLoans(await G.layersOf(all));
  const last = book.epochs && book.epochs.length ? Number(book.epochs[book.epochs.length - 1].ts) : null;
  const since = Number.isFinite(last) && last !== null ? last : asOf - 86400;
  const tz = (push && push.tz) || TZ_DEFAULT;
  const ledger = await siteLedger(since, asOf, tz);
  return { now: asOf, cfg, consts, flags: { layers: !!(flags || {}).layers, tr_live: !!(flags || {}).tr_live },
           pools: { bank: Math.trunc(Number(k.cash.bank) || 0), mm: Math.trunc(Number(k.cash.mm) || 0) }, bank_nav: V.nav("bank", k),
           mm_seeds: pyInt(k.mm_book.seeds), bank_lent, fed_loans, rloan: { base: pyInt(cc.rloan_base), per_level: pyInt(cc.rloan_per_level) },
           legacy, ledger, since, tz };
}
/** A summary of the inputs for the record (no stash, account or person: amounts, counts, flags, settings read). */
function inputsSummary(inp) {
  const c = E.C(inp);
  return { flags: inp.flags, tr_live: trLive(inp), bank_cash: poolOf(inp, "bank"), mm_cash: poolOf(inp, "mm"), bank_nav: Number(inp.bank_nav),
           mm_seeds: pyInt(inp.mm_seeds), bank_lent_samples: (inp.bank_lent || []).length, fed_loans: (inp.fed_loans || []).length,
           cfg: { house_target: c.int("house_target", 15000000), bank_target: c.int("bank_target", 2000000), bank_lent_mult_pct: c.int("bank_lent_mult_pct", 200),
                  bank_peak_days: c.int("bank_peak_days", 30), fedloan_cap: c.int("fedloan_cap", FEDLOAN_CAP) },
           consts: { VAULT_MM_MIN_TARGET: c.k("VAULT_MM_MIN_TARGET"), VAULT_TARGET_MULT: c.k("VAULT_TARGET_MULT") }, legacy: inp.legacy, rloan: inp.rloan,
           since: inp.since, tz: inp.tz, ledger_days: Object.keys((inp.ledger || {}).days || {}).length };
}
/** Keeps the last attempt on capital_meta "derived" (display only; never throws). */
async function note(rec) {
  try { await require("../capital/core").setMeta("derived", rec); } catch (e) { console.error("[policy] derived note:", e.message); }
}

module.exports = { derive, gather, siteLedger, flowsSince, localDate, trLive, bankLent, bankPeak, vaultTarget, targets, flRoom, credit, fingerprint, canonical,
                   inputsSummary, note, legacyOf, CREDIT_W, VAULT_NAMES, FLOW_VAULTS, TZ_DEFAULT, LEGACY, FEDLOAN_CAP };
