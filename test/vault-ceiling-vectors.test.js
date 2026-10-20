// Staking fix plan (2026-10-19) P1.2 + P2.1: the site's daily cut-off maths replays Pepe's REAL cut-off
// (camfrog-bot tools/gen_vault_vectors.py: pepe_vaults._vault_epoch on random books -> test/fixtures/vault-ceiling-vectors.json.gz).
// Every cut-off must leave the SAME book, to the bit:
//   * the daily APR ceiling (capital/vaults.js ceilingDay -> ceilingCap + ceilingStep = pepe_vaults.ceiling_step): every
//     holder's shares, the high-water mark, the protocol cushion, and the step's own numbers (pa, pb, peak, cap, skim,
//     give-back, covered, need, cushion_before, f); ceil_apr 0 = the ceiling OFF is in the vectors too (nothing skimmed or
//     given back, but the high-water mark TRACKS the price - ceilingOffStep = pepe_vaults.ceiling_off_step, camfrog-bot
//     31c65d0), and cases that switch it off / on part-way (a step's "cfg": the config in force from that step on);
//   * the PAT-days buckets (accruePatDays = pepe_vaults.accrue_pat_days): every bucket, every stash, every float;
//   * the snapshot price (rounded to 8 like the book).
//   NODE_PATH=G:/PATV/node_modules node --test test/vault-ceiling-vectors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const V = require(path.join(__dirname, "..", "capital", "vaults"));

const FIX = path.join(__dirname, "fixtures", "vault-ceiling-vectors.json.gz");
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX)).toString("utf8"));
const CASH = { bank: "bank", house: "jackpot", mm: "mm" };

function bookOf(start) {
  const d = { v: {}, auto: { total: 0.0, holders: {} }, queue: {}, epochs: [] };
  for (const [v, b] of Object.entries(start.v)) {
    const st = { total: b.total, holders: Object.fromEntries(b.holders.map(([k, x]) => [k, x])) };
    if (b.peak_price !== undefined) st.peak_price = b.peak_price;
    if (b.cushion !== undefined) st.cushion = b.cushion.map((e) => [e[0], e[1]]);
    d.v[v] = st;
  }
  if (start.auto) d.auto = { total: start.auto.total, holders: Object.fromEntries(start.auto.holders.map(([k, x]) => [k, x])) };
  return d;
}
/** a NAV context the site's prices() reads: the vault's cash only (no loans, no market book - as the generator) */
const ctxOf = (nav) => ({ cash: { bank: nav.bank, mm: nav.mm, jackpot: nav.house }, loans_out: 0, mm_book: { seeds: 0, value: 0 }, cfg: {} });
/** the PAT-days buckets as {bucket: {stash: PAT-days}} (JS orders integer-like keys numerically; the floats are what count) */
const pdMap = (list) => Object.fromEntries((list || []).map(([bk, rows]) => [String(bk), Object.fromEntries(rows.map(([k, x]) => [String(k), x]))]));
function pdOfBook(st) {
  const out = {};
  for (const [bk, row] of Object.entries((st && st.pat_days) || {})) out[bk] = Object.assign({}, row);
  return out;
}
function sameJSON(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sortedObj(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return o;
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortedObj(o[k])]));
}

test("the vectors cover the ceiling on and off, switched part-way, skims, give-backs, off-day peaks and PAT-days", () => {
  let on = 0, off = 0, skims = 0, gives = 0, pd = 0, switched = 0, offMoved = 0;
  for (const c of data.cases) {
    if (Number(c.cfg.ceil_apr) > 0) on++; else off++;
    if (c.steps.some((s) => s.cfg)) switched++;
    let ceil = Number(c.cfg.ceil_apr);
    let prev = c.start.v;
    for (const s of c.steps) {
      if (s.cfg && s.cfg.ceil_apr !== undefined) ceil = Number(s.cfg.ceil_apr);
      for (const x of Object.values(s.ceiling || {})) { if (x.skim > 0) skims++; if (x.giveback > 0) gives++; }
      for (const l of Object.values(s.pat_days || {})) pd += l.length;
      // an off day whose high-water mark moved (the tracking the bot's 31c65d0 added)
      if (!(ceil > 0)) for (const [v, a] of Object.entries(s.after)) if (a.peak_price !== undefined && a.peak_price !== (prev[v] || {}).peak_price) offMoved++;
      prev = s.after;
    }
  }
  assert.ok(data.cases.length >= 100 && on > 50 && off > 10 && skims > 100 && gives > 50 && pd > 100 && switched > 20 && offMoved > 50,
            JSON.stringify({ on, off, skims, gives, pd, switched, offMoved }));
});

test("every cut-off leaves the book Pepe's cut-off leaves - holders, peak, cushion, PAT-days, prices - to the bit", () => {
  const bad = [];
  let n = 0;
  for (const [ci, c] of data.cases.entries()) {
    const d = bookOf(c.start);
    let last = { ts: c.start.epoch.ts, price: c.start.epoch.price };
    const cfg = { ceil_apr: c.cfg.ceil_apr, ceil_cushion: c.cfg.ceil_cushion, ceil_cushion_days: c.cfg.ceil_cushion_days, epoch_hour: 4 };
    for (const [si, s] of c.steps.entries()) {
      n++;
      const where = `case ${ci} step ${si}`;
      if (s.cfg) Object.assign(cfg, s.cfg);                          // the ceiling switched off / on from this step on
      const k = ctxOf(s.nav);
      let p = V.prices(d, k);
      let cday = { steps: {} };
      if (s.now - Number(last.ts) >= 43200) cday = V.ceilingDay(d, last, p, s.now, cfg);
      // the ceiling's own numbers (only the vaults whose ceiling ran)
      const want = s.ceiling || {};
      if (!sameJSON(Object.keys(cday.steps).sort(), Object.keys(want).sort())) bad.push(`${where}: ceiling ran for ${Object.keys(cday.steps)} vs ${Object.keys(want)}`);
      for (const [v, w] of Object.entries(want)) {
        const got = cday.steps[v] || {};
        for (const f of ["pa", "pb", "peak", "cap", "skim", "giveback", "covered", "need", "cushion_before", "f"]) {
          if (w[f] !== undefined && got[f] !== w[f]) bad.push(`${where} ${v}.${f}: ${got[f]} !== ${w[f]}`);
        }
      }
      p = V.prices(d, k);
      V.accruePatDays(d, p, Number(last.ts), s.now, 4);
      for (const [v, a] of Object.entries(s.after)) {
        const st = d.v[v];
        if (!sameJSON(Object.entries(st.holders), a.holders)) bad.push(`${where} ${v} holders: ${JSON.stringify(Object.entries(st.holders)).slice(0, 200)} vs ${JSON.stringify(a.holders).slice(0, 200)}`);
        if ((st.peak_price === undefined ? null : st.peak_price) !== (a.peak_price === undefined ? null : a.peak_price)) bad.push(`${where} ${v} peak ${st.peak_price} vs ${a.peak_price}`);
        if (!sameJSON(st.cushion === undefined ? null : st.cushion, a.cushion === undefined ? null : a.cushion)) bad.push(`${where} ${v} cushion ${JSON.stringify(st.cushion)} vs ${JSON.stringify(a.cushion)}`);
        if (st.total !== a.total) bad.push(`${where} ${v} total ${st.total} vs ${a.total}`);
      }
      for (const [v, l] of Object.entries(s.pat_days || {})) {
        if (!sameJSON(sortedObj(pdOfBook(d.v[v])), sortedObj(pdMap(l)))) bad.push(`${where} ${v} PAT-days ${JSON.stringify(pdOfBook(d.v[v])).slice(0, 200)} vs ${JSON.stringify(pdMap(l)).slice(0, 200)}`);
      }
      const price = {};
      for (const v of V.VAULTS) price[v] = V.pyRoundN(p[v], 8);
      for (const v of V.VAULTS) if (price[v] !== s.price[v]) bad.push(`${where} ${v} price ${price[v]} vs ${s.price[v]}`);
      last = { ts: s.now, price };
      if (bad.length > 20) break;
    }
    if (bad.length > 20) break;
  }
  assert.equal(bad.length, 0, `${bad.length} differences in ${n} cut-offs:\n${bad.slice(0, 12).join("\n")}`);
});
