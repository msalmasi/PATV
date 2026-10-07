// burns.js (1.99dk) - the 🔥 Burned counter + burn log on /economy, from GET /api/burns (public, no user data).
(function () {
  'use strict';
  var stats = document.getElementById('burnStats'), log = document.getElementById('burnLog');
  if (!stats || !log) return;
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  function cell(tr, text) { var td = document.createElement('td'); td.textContent = text; tr.appendChild(td); return td; }
  fetch('/api/burns?limit=50', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    var b = (d && d.burned) || {};
    Array.prototype.forEach.call(stats.querySelectorAll('[data-b]'), function (el) { el.textContent = fmt(b[el.getAttribute('data-b')]) + ' PAT'; });
    log.textContent = '';
    var rows = (d && d.burns) || [];
    if (!rows.length) {
      var tr = document.createElement('tr');
      cell(tr, 'Nothing has been burned yet.').colSpan = 4;
      log.appendChild(tr);
      return;
    }
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      cell(tr, new Date(r.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
      cell(tr, fmt(r.amount)).className = 'n';
      cell(tr, r.sourceLabel || r.source);
      cell(tr, (r.reason || '') + (r.how ? ' (' + r.how + ')' : ''));
      log.appendChild(tr);
    });
  }).catch(function () { log.textContent = ''; var tr = document.createElement('tr'); cell(tr, "Couldn't load the burn log.").colSpan = 4; log.appendChild(tr); });
})();
