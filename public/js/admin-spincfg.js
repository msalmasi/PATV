// admin-spincfg.js - 1.99yz: the chat spins card on /admin/games#chatspin (views/partials/admin-spincfg.ejs; spincfg.js).
(function () {
  'use strict';
  var f = document.getElementById('spinCfgForm'), msg = document.getElementById('spinCfgMsg');
  if (!f) return;
  function say(t) { if (msg) msg.textContent = t; }
  function show(c) { if (c) f.chat_private.value = c.chat_private === false ? 'public' : 'private'; }
  fetch('/api/admin/spin-cfg', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.ok) show(j.cfg); else say('Could not load.'); }).catch(function () { say('Could not load.'); });
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    say('Saving…');
    fetch('/api/admin/spin-cfg', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ chat_private: f.chat_private.value !== 'public' }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { show(j.cfg); say('Saved - applies to the next !spin.'); } else say((j && j.error) || 'Not saved.'); })
      .catch(function () { say('Not saved.'); });
  });
})();
