// admin-heistmarket.js - 1.99xq: the GTF heist market settings card on /admin/games (views/partials/admin-heistmarket.ejs;
// heistmarket.js POST /api/admin/heist-market). Moved from the public /gtf/market page; same fields, same request.
(function () {
  'use strict';
  var af = document.getElementById('hmAdmF'), msg = document.getElementById('hmAdmMsg');
  if (!af) return;
  function say(t, ok) { if (!msg) return; msg.textContent = t; msg.className = 'adm-msg ' + (ok ? 'ok' : 'err'); }
  af.addEventListener('submit', function (e) {
    e.preventDefault();
    var g = function (n) { return af.elements[n]; }, cfg = {};
    ['fee_pct', 'min_price', 'max_price', 'list_per_hour', 'open_max', 'announce_min', 'pawn_rate'].forEach(function (k) { cfg[k] = Number(String(g(k).value).replace(/[, _]/g, '')); });
    cfg.pawn_on = g('pawn_on').checked; cfg.pawn_source = g('pawn_source').value.trim();
    cfg.untradable = g('untradable').value.split(/[\s,]+/).filter(Boolean);
    cfg.pawn_values = {};
    g('pawn_values').value.split(/[,;]+/).forEach(function (p) { var m = p.split('='); if (m.length === 2 && m[0].trim()) cfg.pawn_values[m[0].trim()] = Number(m[1].replace(/[, _]/g, '')); });
    var btn = af.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    say('…', true);
    fetch('/api/admin/heist-market', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ config: cfg }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { say(j && j.ok ? af.getAttribute('data-saved') : ((j && j.error) || af.getAttribute('data-failed')), !!(j && j.ok)); })
      .catch(function () { say(af.getAttribute('data-failed'), false); })
      .then(function () { if (btn) btn.disabled = false; });
  });
})();
