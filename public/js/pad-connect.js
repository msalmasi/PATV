// pad-connect.js — the settings hub's Platform card (1.99ja, padconnect.js): get a Camfrog verification code, check it,
// opt in to Pepe joining, connect the owner's Twitch channel, disconnect. Same-site JSON; the server re-checks everything.
(function () {
  'use strict';
  var card = document.getElementById('connections');
  if (!card) return;
  var base = card.getAttribute('data-base');
  function api(path, body) {
    return fetch(base + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          return d;
        });
      });
  }
  function say(id, t, bad) { var m = document.getElementById(id); if (!m) return; m.textContent = t || ''; m.style.color = bad ? 'var(--bad, #e55)' : ''; }
  function reload(hash) { location.href = location.pathname + '?tab=address' + (hash || '#connections'); }

  var form = document.getElementById('pcnCfForm');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    say('pcnCfMsg', 'Getting a code…');
    api('/connect/camfrog', { room: form.elements.room.value, join: form.elements.join.checked })
      .then(function () { reload(); })
      .catch(function (err) { say('pcnCfMsg', err.message, true); });
  });
  var join = document.getElementById('pcnJoin');
  if (join) join.addEventListener('change', function () {
    api('/connect/camfrog/join', { on: join.checked }).then(function () { reload(); }).catch(function (err) { join.checked = !join.checked; alert(err.message); });
  });
  card.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-pcn]') : null;
    if (!b) return;
    var op = b.getAttribute('data-pcn');
    if (op === 'copy') {
      var c = document.getElementById('pcnCode');
      if (c && navigator.clipboard) navigator.clipboard.writeText(c.textContent).then(function () { b.textContent = 'Copied'; }).catch(function () {});
      return;
    }
    if (op === 'check') {
      b.disabled = true;
      say('pcnCfMsg', 'Checking the room topic…');
      api('/connect/camfrog/check', {}).then(function (d) {
        b.disabled = false;
        if (d.done) { say('pcnCfMsg', 'Verified - reloading…'); location.href = '/p/' + encodeURIComponent(d.pad) + '/settings?tab=address#connections'; return; }
        say('pcnCfMsg', d.bridged ? 'Not in the topic yet. Pepe also checks every couple of minutes.' : "The website can't see that room's topic right now - Pepe checks it every couple of minutes while he's in the room.");
      }).catch(function (err) { b.disabled = false; say('pcnCfMsg', err.message, true); });
      return;
    }
    if (op === 'twitch') {
      b.disabled = true;
      api('/connect/twitch', {}).then(function () { reload(); }).catch(function (err) { b.disabled = false; say('pcnTwMsg', err.message, true); });
      return;
    }
    if (op === 'disconnect') {
      var soft = b.getAttribute('data-soft') === '1';
      var pf = b.getAttribute('data-platform');
      if (!window.confirm(soft ? 'Cancel this request? The code stops working.' : 'Disconnect this pad from ' + (pf === 'twitch' ? 'Twitch' : 'Camfrog') + '? It becomes a site pad again.')) return;
      b.disabled = true;
      api('/disconnect', { platform: pf, confirm: true }).then(function (d) {
        location.href = d.href && /^\/(?![\/\\])/.test(d.href) ? d.href : location.pathname;
      }).catch(function (err) { b.disabled = false; alert(err.message); });
    }
  });
})();
