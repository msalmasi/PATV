// bets.js - 1.99ly: small helpers shared by /markets, /wagers, /polls and /bounties (design pass).
// - [data-until="<unix s>"]: a live countdown ("2d 4h", "3h 12m", "4m 09s", "now"), once a second
// - [data-amt] buttons: put an amount into the form field named by data-amt-field (default "amount");
//   data-amt="max" uses data-max. They only fill the field: the form still posts exactly what it did.
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
  function init() {
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
