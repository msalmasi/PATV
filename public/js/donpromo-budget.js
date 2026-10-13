// donpromo-budget.js (1.99vi) - the donation promo BUDGET arithmetic + wording, shared by the admin form
// (public/js/admin-donpromo.js, as window.DPBudget) and the server (donationpromo.js, require) so the warning the admin sees
// and the server's refusal can't disagree.
//
// A promo's budget is stored as PAT at the promo rate (donation_promos.budget_pat): the most PAT credited at the promo
// rate across every donor. On prod an admin typed 1000 meaning $1,000 - it was 1,000 PAT, so every donation fell back to
// the normal rate. So: the form shows what the budget is worth in dollars as you type, can take it in dollars, and a budget
// smaller than ONE donor's full promo allowance (cap x promo rate) is warned about and refused unless confirmed.
// rate = the promo's PAT per $1 (for a multiplier promo: floor(normal x mult)); cents = US cents.
(function (root, factory) {
  var M = factory();
  if (typeof module === 'object' && module.exports) module.exports = M; else root.DPBudget = M;
})(this, function () {
  'use strict';
  var num = function (v) { var n = Number(v); return Number.isFinite(n) ? n : 0; };
  /** PAT at the promo rate -> the US cents of donations it covers (rounded down). */
  function centsOf(pat, rate) { pat = num(pat); rate = num(rate); return rate > 0 && pat > 0 ? Math.floor((pat * 100) / rate) : 0; }
  /** Dollars at the promo rate -> PAT (what a $-entered budget is stored as). */
  function patOfUsd(usd, rate) { usd = num(usd); rate = num(rate); return usd > 0 && rate > 0 ? Math.floor(usd * rate) : 0; }
  /** One donor's full promo allowance in PAT: the per-donor cap at the promo rate. */
  function allowance(capCents, rate) { return Math.floor((num(capCents) * num(rate)) / 100); }
  /**
   * Is this budget smaller than one donor's full allowance? null = fine (or no budget / no rate yet), otherwise
   * {budget_pat, budget_cents (the $ of promo donations it covers), allowance_pat, cap_cents, rate, suggest_pat (the budget
   * read as dollars: what the admin probably meant)}.
   */
  function check(budgetPat, capCents, rate) {
    if (budgetPat === null || budgetPat === undefined || budgetPat === '') return null;
    var b = Math.floor(num(budgetPat)), r = Math.floor(num(rate)), cap = Math.floor(num(capCents));
    if (!(b > 0) || !(r > 0) || !(cap > 0)) return null;
    var a = allowance(cap, r);
    if (b >= a) return null;
    // a number that looks like dollars (at most $1M) read as dollars, if that covers an allowance; else one allowance
    var asUsd = b <= 1000000 ? b * r : 0;
    return { budget_pat: b, budget_cents: centsOf(b, r), allowance_pat: a, cap_cents: cap, rate: r, suggest_pat: asUsd >= a ? asUsd : a };
  }
  var fmt = function (n) { return Math.floor(num(n)).toLocaleString('en-US'); };
  /** Cents -> "1,234.50" (always two decimals; the "$" is in the sentence). */
  var usd = function (c) { return (num(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var plain = function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  /**
   * The live helper under the budget field. raw = what's typed, unit 'pat' | 'usd', rate = promo PAT per $1.
   * -> "= about $X of donations at the promo rate." / "= N PAT at the promo rate (stored as PAT)." + "Blank = no budget limit."
   */
  function helperText(t, raw, unit, rate) {
    t = t || plain;
    var blank = t('js.adm.dp.budget_blank', 'Blank = no budget limit.');
    if (raw === null || raw === undefined || String(raw).trim() === '') return blank;
    if (!(num(rate) > 0)) return t('js.adm.dp.budget_norate', 'Set the promo rate to see what this budget is worth.') + ' ' + blank;
    if (unit === 'usd') return t('js.adm.dp.budget_as_pat', '= {pat} PAT at the promo rate (stored as PAT).', { pat: fmt(patOfUsd(raw, rate)) }) + ' ' + blank;
    return t('js.adm.dp.budget_about', '= about ${usd} of donations at the promo rate.', { usd: usd(centsOf(Math.floor(num(raw)), rate)) }) + ' ' + blank;
  }
  /** The too-small warning for check()'s result: "This budget runs out after $0.00 of promo donations ... Did you mean ...?" */
  function warnText(t, w) {
    t = t || plain;
    if (!w) return '';
    return t('js.adm.dp.budget_small', 'This budget runs out after ${usd} of promo donations - less than one donor’s full promo allowance (${cap} = {allowance} PAT). Did you mean {suggest} PAT?',
      { usd: usd(w.budget_cents), cap: usd(w.cap_cents), allowance: fmt(w.allowance_pat), suggest: fmt(w.suggest_pat) });
  }
  return { centsOf: centsOf, patOfUsd: patOfUsd, allowance: allowance, check: check, helperText: helperText, warnText: warnText, usd: usd, fmt: fmt };
});
