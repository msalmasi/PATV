// admin-pvpcfg.js - 1.99yc: the duels & brawls card on /admin/games#pvp (views/partials/admin-pvpcfg.ejs; pvpcfg.js).
(function () {
  'use strict';
  var f = document.getElementById('pvpForm'), msg = document.getElementById('pvpMsg');
  if (!f) return;
  var KEYS = ['accept_quiet_secs', 'replace_max', 'replace_window_secs'];
  function say(t) { if (msg) msg.textContent = t; }
  function show(c) { KEYS.forEach(function (k) { if (f[k] && c && c[k] !== undefined) f[k].value = String(c[k]); }); }
  fetch('/api/admin/pvp-cfg', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.ok) show(j.cfg); else say('Could not load.'); }).catch(function () { say('Could not load.'); });
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {};
    KEYS.forEach(function (k) { body[k] = Math.round(Number(f[k].value)); });
    say('Saving…');
    fetch('/api/admin/pvp-cfg', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { show(j.cfg); say('Saved.'); } else say((j && j.error) || 'Not saved.'); })
      .catch(function () { say('Not saved.'); });
  });
})();
