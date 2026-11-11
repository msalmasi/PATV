// public/js/support.js — 1.99mn: the /support page (views/support.ejs). The amount picker, the payment method tabs, the
// network / token picker for crypto, the card donation (Stripe Checkout), the "show my name" opt-in, live donation statuses
// (re-reads the page's own payment list while something is on its way) and the thank-you confetti.
// 1.99ans: no PAT for dollars (nopat.js) - no rate, no PAT calculator, no promo: a donation gives the supporter perks.
(function () {
  'use strict';
  var _t = window.__t || function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, x) { return v && v[x] != null ? v[x] : m; }); };
  var root = document.getElementById('support');
  if (!root) return;
  var MIN = Number(root.getAttribute('data-min')) || 1, MAX = Number(root.getAttribute('data-max')) || 1000, CARDMAX = Number(root.getAttribute('data-cardmax')) || 1000;
  var lang = document.documentElement.lang || 'en';
  var nf; try { nf = new Intl.NumberFormat(lang === 'en' ? 'en-US' : lang); } catch (e) { nf = null; }
  var fmt = function (n) { return nf ? nf.format(n) : String(n); };
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); });
  }

  // ── amount ──
  var radios = root.querySelectorAll('input[name="spAmt"]'), custom = document.getElementById('spCustom');
  var sum = document.getElementById('spSum');
  var goBtn = document.getElementById('donateGo'), goTxt = document.getElementById('donateGoTxt');
  function amount() {
    var r = root.querySelector('input[name="spAmt"]:checked');
    if (!r) return 0;
    if (r.value !== 'custom') return Number(r.value);
    var v = Number(String(custom.value || '').replace(',', '.'));
    return isFinite(v) && v > 0 ? Math.floor(v * 100) / 100 : 0;
  }
  function render() {
    Array.prototype.forEach.call(radios, function (r) { r.closest('.tier').classList.toggle('on', r.checked); });
    var usd = amount(), ok = usd >= MIN;
    if (sum) sum.textContent = ok ? _t('js.support.sum_perks', 'You give ${usd} → you get the Supporter perks. Donations never add PAT.', { usd: fmt(usd) })
      : _t('js.support.pick_amount', 'Enter an amount of at least ${min}.', { min: MIN });
    if (sum && ok && usd > MAX) sum.textContent += ' ' + _t('js.support.crypto_held', 'Over ${max} a transfer is counted after a quick admin check.', { max: fmt(MAX) });
    if (goTxt) goTxt.textContent = _t('js.support.card_button', 'Donate ${usd} by card', { usd: ok ? fmt(usd) : '…' });
    if (goBtn) goBtn.disabled = !ok;
    // 1.99ts: the daily donation limit (the server refuses a checkout over it; crypto over it is held for review)
    var pool = document.getElementById('spPool');
    if (pool && pool.getAttribute('data-full') === '1' && goBtn) goBtn.disabled = true;   // 1.99uh: donations are full for today
    var dl = document.getElementById('spDaily');
    if (dl && ok) {
      var left = Number(dl.getAttribute('data-left')) || 0;
      if (Math.round(usd * 100) > left) {
        if (sum) sum.textContent += ' ' + _t('js.support.daily_over', 'That is more than you can donate today (${left}) - by card it won’t go through, and a bigger crypto transfer waits for an admin.', { left: fmt(Math.floor(left / 100)) });
        if (goBtn) goBtn.disabled = true;
      }
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-send-amt]'), function (b) { b.textContent = ok ? String(usd) : '…'; });
  }
  Array.prototype.forEach.call(radios, function (r) {
    r.addEventListener('change', function () { if (r.value === 'custom' && custom) custom.focus(); render(); });
  });
  if (custom) {
    custom.addEventListener('input', function () { var c = root.querySelector('input[name="spAmt"][value="custom"]'); if (c) c.checked = true; render(); });
    custom.addEventListener('focus', function () { var c = root.querySelector('input[name="spAmt"][value="custom"]'); if (c && !c.checked) { c.checked = true; render(); } });
  }

  var LIVE = ['pending', 'final', 'verifying'];
  function states(scope) {
    var m = {};
    Array.prototype.forEach.call(scope.querySelectorAll('#cryptoPayments li[data-id]'), function (li) { m[li.getAttribute('data-id')] = { s: li.getAttribute('data-status') }; });
    return m;
  }
  function anyLive() { var s = states(document); return Object.keys(s).some(function (k) { return LIVE.indexOf(s[k].s) >= 0; }); }
  var timer = null;
  function poll() {
    timer = null;
    if (document.hidden) { timer = setTimeout(poll, 15000); return; }
    var before = states(document);
    fetch(location.pathname, { credentials: 'same-origin', headers: { Accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (!html) return;
        var doc = new DOMParser().parseFromString(html, 'text/html'), fresh = doc.getElementById('payBox'), cur = document.getElementById('payBox');
        if (!fresh || !cur) return;
        cur.innerHTML = fresh.innerHTML;
        times(cur);
        var after = states(document), won = 0;
        Object.keys(after).forEach(function (k) { if (after[k].s === 'credited' && (!before[k] || before[k].s !== 'credited')) won++; });
        // 1.99ans: a donation that just counted - the perks are on (no PAT for dollars)
        if (won > 0) { toast(_t('js.support.counted', 'Thank you! Your donation is in, and your Supporter perks are on.')); confetti(); }
      })
      .catch(function () { /* try again next round */ })
      .then(function () { if (anyLive()) timer = setTimeout(poll, 15000); });
  }
  if (document.getElementById('payBox') && anyLive()) timer = setTimeout(poll, 15000);

  render();
  cryptoRender();
  times();
  if (root.querySelector('[data-celebrate]')) setTimeout(confetti, 250);
})();
