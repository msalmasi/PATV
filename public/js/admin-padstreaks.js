// admin-padstreaks.js - 1.99zm: /pads/admin#padstreaks (views/partials/pads-admin-streaks.ejs; padstreaks.js).
(function () {
  'use strict';
  var f = document.getElementById('pstForm'), msg = document.getElementById('pstMsg'), inp = document.getElementById('pstMin');
  if (!f) return;
  function say(t) { if (msg) msg.textContent = t; }
  fetch('/api/admin/padstreaks/config', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.ok) { inp.value = String(j.min_users); if (!j.backfill) say('History import still to run (a few minutes after a deploy).'); } else say('Could not load.'); })
    .catch(function () { say('Could not load.'); });
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    say('Saving…');
    fetch('/api/admin/padstreaks/config', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ min_users: Math.round(Number(inp.value)) }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { inp.value = String(j.min_users); say('Saved.'); } else say((j && j.error) || 'Not saved.'); })
      .catch(function () { say('Not saved.'); });
  });
})();
