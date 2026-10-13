// admin-mktcfg.js - 1.99ur: the market close bounds card on /admin/markets (views/partials/admin-mktcfg.ejs; mktcfg.js).
(function () {
  'use strict';
  var f = document.getElementById('cbForm'), msg = document.getElementById('cbMsg');
  if (!f) return;
  function say(t) { if (msg) msg.textContent = t; }
  function show(c) {
    f.min_h.value = String(Math.round(c.close_min_secs / 36) / 100);
    f.max_d.value = String(Math.round(c.close_max_secs / 864) / 100);
  }
  fetch('/api/admin/markets-cfg', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.ok) show(j.cfg); else say('Could not load.'); }).catch(function () { say('Could not load.'); });
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { close_min_secs: Math.round(Number(f.min_h.value) * 3600), close_max_secs: Math.round(Number(f.max_d.value) * 86400) };
    say('Saving…');
    fetch('/api/admin/markets-cfg', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { show(j.cfg); say('Saved.'); } else say((j && j.error) || 'Not saved.'); })
      .catch(function () { say('Not saved.'); });
  });
})();
