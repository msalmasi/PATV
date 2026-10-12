// public/js/support.js — 1.99mn: the /support page (views/support.ejs). The amount picker + live PAT calculator, the payment
// method tabs, the network / token picker for crypto, the card donation (Stripe Checkout), the "show my name" opt-in, live
// donation statuses (re-reads the page's own payment list while something is on its way) and the thank-you confetti.
// Rates come from the page (data-rate / data-bonus = the server's donation terms); nothing here decides an amount credited.
(function () {
  'use strict';
  var _t = window.__t || function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, x) { return v && v[x] != null ? v[x] : m; }); };
  var root = document.getElementById('support');
  if (!root) return;
  var RATE = Number(root.getAttribute('data-rate')) || 0, BONUS = Number(root.getAttribute('data-bonus')) || 0;
  var MIN = Number(root.getAttribute('data-min')) || 1, MAX = Number(root.getAttribute('data-max')) || 1000, CARDMAX = Number(root.getAttribute('data-cardmax')) || 1000;
  var lang = document.documentElement.lang || 'en';
  var nf; try { nf = new Intl.NumberFormat(lang === 'en' ? 'en-US' : lang); } catch (e) { nf = null; }
  var fmt = function (n) { return nf ? nf.format(n) : String(n); };
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); });
  }
  // 1.99tq: a live donation promo (data-promo = {rate, allowance_cents, budget_left_pat, bonus_base, ends}) - the same split as
  // the server's donationpromo.split(): the cents that fit the viewer's allowance (and the promo budget) at the promo rate, the
  // rest at the normal rate; the bonus % on the normal portion / the normal-rate equivalent / everything (bonus_base).
  var PROMO = null; try { PROMO = JSON.parse(root.getAttribute('data-promo') || 'null'); } catch (e) { PROMO = null; }
  function q(usd) {
    var cents = Math.max(0, Math.round(usd * 100)), pc = 0;
    if (PROMO && PROMO.rate > RATE) {
      var bud = PROMO.budget_left_pat == null ? Infinity : Math.floor(Math.max(0, PROMO.budget_left_pat) * 100 / PROMO.rate);
      pc = Math.max(0, Math.min(cents, PROMO.allowance_cents, bud));
    }
    var nc = cents - pc, pp = pc ? Math.floor(pc * PROMO.rate / 100) : 0, np = Math.floor(nc * RATE / 100), base = PROMO ? PROMO.bonus_base : 'all';
    var on = base === 'all' ? pp + np : base === 'equivalent' ? Math.floor(cents * RATE / 100) : np;
    return { pat: pp + np, bonus: Math.floor(on * BONUS / 100), promo_cents: pc, promo_pat: pp, normal_cents: nc, normal_pat: np };
  }
  function patOf(usd) { return q(usd).pat; }
  function bonusOf(usd) { return q(usd).bonus; }

  // ── amount ──
  var radios = root.querySelectorAll('input[name="spAmt"]'), custom = document.getElementById('spCustom');
  var sum = document.getElementById('spSum'), cPat = document.getElementById('spCustPat'), cBon = document.getElementById('spCustBon');
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
    if (cPat) {
      var cv = Number(custom.value);
      cPat.textContent = cv > 0 ? fmt(patOf(cv)) + ' PAT' : '';
      cBon.textContent = cv > 0 ? '+' + fmt(bonusOf(cv)) + ' PAT' : '';
    }
    if (sum) sum.textContent = ok ? _t('js.support.sum', 'You give ${usd} → you get {pat} PAT, and the community pot gets +{bonus} PAT.', { usd: fmt(usd), pat: fmt(patOf(usd)), bonus: fmt(bonusOf(usd)) })
      : _t('js.support.pick_amount', 'Enter an amount of at least ${min}.', { min: MIN });
    if (sum && ok && PROMO) {
      var Q = q(usd);
      if (Q.promo_cents && Q.normal_cents) sum.textContent += ' ' + _t('js.support.sum_promo_split', 'That is {promo_pat} PAT at the promo rate for ${promo_usd} + {normal_pat} PAT at the normal rate for ${normal_usd}.',
        { promo_pat: fmt(Q.promo_pat), promo_usd: fmt(Q.promo_cents / 100), normal_pat: fmt(Q.normal_pat), normal_usd: fmt(Q.normal_cents / 100) });
      else if (Q.promo_cents) sum.textContent += ' ' + _t('js.support.sum_promo_all', 'All of it at the promo rate!');
      else sum.textContent += ' ' + _t('js.support.sum_promo_none', 'Your promo allowance is used up, so this earns the normal rate.');
    }
    if (sum && ok && usd > MAX) sum.textContent += ' ' + _t('js.support.crypto_held', 'Over ${max} a transfer is credited after a quick admin check.', { max: fmt(MAX) });
    if (goTxt) goTxt.textContent = _t('js.support.card_button', 'Donate ${usd} by card', { usd: ok ? fmt(usd) : '…' });
    if (goBtn) goBtn.disabled = !ok;
    // 1.99ts: the daily donation limit (the server refuses a checkout over it; crypto over it is held for review)
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

  // ── 1.99tq: the promo countdown ──
  var pl = document.getElementById('spPromoLeft');
  if (pl) {
    var ends = Number(pl.getAttribute('data-ends')) || 0;
    var tick = function () {
      var s = Math.max(0, Math.floor((ends - Date.now()) / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
      pl.textContent = s <= 0 ? _t('js.support.promo_over', 'This promo just ended - reload for the current rate.')
        : (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm ' + (d ? '' : x + 's');
      if (s <= 0) { PROMO = null; render(); clearInterval(iv); }
    };
    var iv = setInterval(tick, 1000); tick();
  }

  // ── tabs ──
  var tabs = root.querySelectorAll('[role="tab"]');
  function pick(tab, focus) {
    Array.prototype.forEach.call(tabs, function (x) {
      var on = x === tab;
      x.setAttribute('aria-selected', on ? 'true' : 'false');
      x.tabIndex = on ? 0 : -1;
      var p = document.getElementById(x.getAttribute('aria-controls'));
      if (p) p.hidden = !on;
    });
    if (focus) tab.focus();
  }
  Array.prototype.forEach.call(tabs, function (tab, i) {
    tab.addEventListener('click', function () { pick(tab); });
    tab.addEventListener('keydown', function (ev) {
      var k = ev.key, n = tabs.length, j = k === 'ArrowRight' ? (i + 1) % n : k === 'ArrowLeft' ? (i - 1 + n) % n : k === 'Home' ? 0 : k === 'End' ? n - 1 : -1;
      if (j >= 0) { ev.preventDefault(); pick(tabs[j], true); }
    });
  });
  if (/^#(crypto|card)$/.test(location.hash)) { var tt = root.querySelector('[data-tab="' + location.hash.slice(1) + '"]'); if (tt) pick(tt); }

  // ── network / token ──
  var box = document.getElementById('pane-crypto');
  var fams = box ? String(box.getAttribute('data-families') || '').split(',').filter(Boolean) : [];
  var signed = box && box.getAttribute('data-signed') === '1';
  var hint = document.getElementById('spFamHint');
  function cryptoRender() {
    if (!box) return;
    var ch = box.querySelector('input[name="spChain"]:checked');
    if (!ch) return;
    var toks = String(ch.getAttribute('data-tokens') || '').split(',');
    Array.prototype.forEach.call(box.querySelectorAll('input[name="spToken"]'), function (tk) {
      var ok = toks.indexOf(tk.value) >= 0;
      tk.disabled = !ok;
      tk.closest('label').classList.toggle('na', !ok);
      if (!ok && tk.checked) { tk.checked = false; var first = box.querySelector('input[name="spToken"]:not(:disabled)'); if (first) first.checked = true; }
    });
    var tok = box.querySelector('input[name="spToken"]:checked');
    var sym = tok ? tok.value : toks[0];
    Array.prototype.forEach.call(box.querySelectorAll('.seg label'), function (l) { var i = l.querySelector('input'); l.classList.toggle('on', !!(i && i.checked)); });
    Array.prototype.forEach.call(box.querySelectorAll('.dest'), function (d) {
      var on = d.getAttribute('data-chain') === ch.value;
      d.hidden = !on;
      Array.prototype.forEach.call(d.querySelectorAll('.contract'), function (c) { c.hidden = c.getAttribute('data-token') !== sym; });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-send-tok]'), function (b) { b.textContent = sym; });
    if (hint) {
      var fam = ch.getAttribute('data-family');
      hint.textContent = signed && fams.indexOf(fam) < 0 ? (fam === 'sol' ? _t('js.support.need_sol', 'Link a Solana wallet first (step 1), then send from it.')
        : _t('js.support.need_evm', 'Link an Ethereum / Base wallet first (step 1), then send from it.')) : '';
    }
  }
  if (box) box.addEventListener('change', function (ev) { if (ev.target && /^sp(Chain|Token)$/.test(ev.target.name)) cryptoRender(); });

  // ── card ──
  var dmsg = document.getElementById('donateMsg');
  if (goBtn) goBtn.addEventListener('click', function () {
    var usd = amount();
    if (usd !== Math.floor(usd) || usd < 1 || usd > CARDMAX) {
      dmsg.textContent = _t('js.support.card_whole', 'Card donations are whole dollars from 1 to {max}.', { max: fmt(CARDMAX) }); dmsg.className = 'msg err'; return;
    }
    goBtn.disabled = true; dmsg.textContent = ''; dmsg.className = 'msg';
    post('/api/premium/stripe/donate', { usd: usd, back: goBtn.getAttribute('data-back') || '/support' })
      .then(function (j) { if (j.url) { location.href = j.url; return; } throw new Error(''); })
      .catch(function (e) { goBtn.disabled = false; dmsg.textContent = (e && e.message) || _t('js.donate.failed', 'Card payments aren’t available right now.'); dmsg.className = 'msg err'; });
  });

  // ── show my name ──
  var showName = document.getElementById('spShowName'), smsg = document.getElementById('spShowMsg');
  if (showName) showName.addEventListener('change', function () {
    showName.disabled = true;
    post('/api/support/prefs', { show_name: showName.checked })
      .then(function () { showName.disabled = false; smsg.textContent = _t('js.support.saved', 'Saved.'); smsg.className = 'msg ok'; },
        function () { showName.disabled = false; showName.checked = !showName.checked; smsg.textContent = _t('js.support.save_failed', 'Couldn’t save - try again.'); smsg.className = 'msg err'; });
  });

  // ── times ──
  function times(scope) {
    var rtf = null; try { rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }); } catch (e) { rtf = null; }
    Array.prototype.forEach.call((scope || root).querySelectorAll('time[data-ago]'), function (el) {
      if (!rtf) return;
      var s = (Number(el.getAttribute('data-ago')) - Date.now()) / 1000, a = Math.abs(s);
      el.textContent = a < 3600 ? rtf.format(Math.round(s / 60), 'minute') : a < 86400 ? rtf.format(Math.round(s / 3600), 'hour') : rtf.format(Math.round(s / 86400), 'day');
    });
    Array.prototype.forEach.call((scope || root).querySelectorAll('time[data-ts]'), function (el) {
      try { el.textContent = new Date(Number(el.getAttribute('data-ts'))).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { /* keep UTC */ }
    });
  }

  // ── confetti ──
  function confetti() {
    if (reduce) return;
    var c = document.createElement('canvas'), x = c.getContext && c.getContext('2d');
    if (!x) return;
    c.className = 'sp-confetti'; c.setAttribute('aria-hidden', 'true');
    document.body.appendChild(c);
    var W = c.width = innerWidth, H = c.height = innerHeight, cols = ['#ff6a9b', '#ffcf40', '#7ee2a0', '#9b5de5', '#4fc3f7', '#ff8a5c'], P = [];
    for (var i = 0; i < 160; i++) P.push({ x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
      s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[i % cols.length] });
    var t0 = performance.now();
    (function frame(now) {
      var el = now - t0;
      x.clearRect(0, 0, W, H);
      P.forEach(function (p) {
        p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.globalAlpha = Math.max(0, 1 - el / 3200); x.fillStyle = p.c; x.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); x.restore();
      });
      if (el < 3200) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }
  function toast(text) {
    var d = document.createElement('div');
    d.className = 'sp-toast'; d.setAttribute('role', 'status'); d.textContent = text;
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 7000);
  }

  // ── live statuses: re-read this page's payment list while a donation is on its way ──
  var LIVE = ['pending', 'final', 'verifying'];
  function states(scope) {
    var m = {};
    Array.prototype.forEach.call(scope.querySelectorAll('#cryptoPayments li[data-id]'), function (li) { m[li.getAttribute('data-id')] = { s: li.getAttribute('data-status'), pat: li.getAttribute('data-pat') }; });
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
        Object.keys(after).forEach(function (k) { if (after[k].s === 'credited' && (!before[k] || before[k].s !== 'credited')) won += Number(after[k].pat) || 0; });
        if (won > 0) { toast(_t('js.support.credited', 'Thank you! {pat} PAT credited to your wallet.', { pat: fmt(won) })); confetti(); }
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
