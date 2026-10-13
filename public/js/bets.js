// bets.js - 1.99ly: small helpers shared by /markets, /wagers, /polls and /bounties (design pass).
// - [data-until="<unix s>"]: a live countdown ("2d 4h", "3h 12m", "4m 09s", "now"), once a second
// - [data-amt] buttons: put an amount into the form field named by data-amt-field (default "amount");
//   data-amt="max" uses data-max. They only fill the field: the form still posts exactly what it did.
// - 1.99ur form[data-autosubmit]: the lists' pad filter / "show voided" toggle submit on change
// - 1.99ur [data-close-pick] (a create form's close): the duration select's "custom" option shows a date/time input; on
//   submit the picked local time becomes until=<unix s> + tz=<the browser's IANA zone> (hidden fields) and the duration is
//   dropped. The input's min / max follow data-min-secs / data-max-secs (the admins' bounds, mktcfg.js).
(function () {
  if (window.__betsJs) return;
  window.__betsJs = true;
  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : d.replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function fmt(s) {
    if (s <= 0) return _t('js.bets.now', 'now');
    if (s >= 86400) return _t('js.bets.dh', '{d}d {h}h', { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600) });
    if (s >= 3600) return _t('js.bets.hm', '{h}h {m}m', { h: Math.floor(s / 3600), m: Math.floor(s % 3600 / 60) });
    var sec = s % 60;
    return _t('js.bets.ms', '{m}m {s}s', { m: Math.floor(s / 60), s: (sec < 10 ? '0' : '') + sec });
  }
  function tick() {
    var els = document.querySelectorAll('[data-until]');
    for (var i = 0; i < els.length; i++) {
      var left = Math.max(0, Math.round(Number(els[i].getAttribute('data-until')) - Date.now() / 1000));
      els[i].textContent = fmt(left);
    }
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function localInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function closePick(box) {
    var sel = box.querySelector('select'), wrap = box.querySelector('[data-close-custom]'), inp = wrap && wrap.querySelector('input[type="datetime-local"]');
    var f = box.closest('form');
    if (!sel || !wrap || !inp || !f) return;
    var lo = Number(box.getAttribute('data-min-secs')) || 3600, hi = Number(box.getAttribute('data-max-secs')) || 90 * 86400;
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { tz = ''; }
    var zl = box.querySelector('[data-close-tz]');
    if (zl) zl.textContent = tz || 'UTC';
    function bounds() { inp.min = localInput(Date.now() + lo * 1000); inp.max = localInput(Date.now() + hi * 1000); }
    function sync() {
      var on = sel.value === 'custom';
      wrap.hidden = !on;
      inp.required = on;
      if (on) { bounds(); if (!inp.value) inp.value = localInput(Date.now() + Math.max(lo, 86400) * 1000); }
    }
    sel.addEventListener('change', sync);
    sync();
    f.addEventListener('submit', function (e) {
      var u = f.querySelector('input[name="until"]'), z = f.querySelector('input[name="tz"]');
      if (sel.value !== 'custom') { if (u) u.value = ''; return; }
      var ms = new Date(inp.value).getTime();
      var secs = Math.round((ms - Date.now()) / 1000);
      if (!isFinite(ms) || secs < lo || secs > hi) {
        e.preventDefault();
        inp.setCustomValidity(box.getAttribute('data-bounds-msg') || 'Out of range');
        inp.reportValidity();
        return;
      }
      inp.setCustomValidity('');
      if (u) u.value = String(Math.floor(ms / 1000));
      if (z) z.value = tz;
      sel.disabled = true;                 // the picked date replaces the duration word
    });
    inp.addEventListener('input', function () { inp.setCustomValidity(''); });
    window.addEventListener('pageshow', function () { sel.disabled = false; sync(); });   // back to a cached page
  }
  function init() {
    var picks = document.querySelectorAll('[data-close-pick]');
    for (var i = 0; i < picks.length; i++) closePick(picks[i]);
    var auto = document.querySelectorAll('form[data-autosubmit]');
    for (var j = 0; j < auto.length; j++) {
      auto[j].addEventListener('change', function (e) { var f = e.currentTarget; if (f.requestSubmit) f.requestSubmit(); else f.submit(); });
    }
    tick();
    if (document.querySelector('[data-until]')) setInterval(tick, 1000);
    document.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-amt]') : null;
      if (!b) return;
      var f = b.form || b.closest('form');
      var el = f && f.querySelector('[name="' + (b.getAttribute('data-amt-field') || 'amount') + '"]');
      if (!el) return;
      e.preventDefault();
      var v = b.getAttribute('data-amt');
      el.value = v === 'max' ? Math.floor(Number(b.getAttribute('data-max')) || 0) : v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
