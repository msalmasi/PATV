// admin-backends.js - /admin/backends (backends.js, owner answers 2026-10-20): one hand-over switch at a time. A same-origin
// POST /api/admin/backends/:feature {on} (X-Requested-With: fetch), checked on the server (Admins; a Pepe owner on the rows
// that hold members' PAT) and audited; the page reloads to show the result. Messages go in with textContent only.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function say(el, msg, bad) { if (el) { el.textContent = msg || ''; el.className = 'adm-msg' + (bad ? ' err' : msg ? ' ok' : ''); } }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-bk]') : null;
    if (!b) return;
    var key = b.getAttribute('data-bk'), on = b.getAttribute('data-on') === '1', name = b.getAttribute('data-name') || key;
    var q = on ? _t('js.admbk.confirm_on', 'Move {name} to publicaccess.tv? Pepe runs the hand-over when he sees the switch.', { name: name })
      : _t('js.admbk.confirm_off', 'Bring {name} back to Pepe? Pepe runs the way back when he sees the switch.', { name: name });
    if (!window.confirm(q)) return;
    var msg = b.parentNode ? b.parentNode.querySelector('.adm-msg') : null;
    say(msg, _t('js.admbk.working', 'Saving…'));
    fetch('/api/admin/backends/' + encodeURIComponent(key), { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ on: on }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false }; })
      .then(function (j) {
        if (!j || !j.ok) return say(msg, (j && j.error) || _t('js.admbk.failed', 'That did not work - try again.'), true);
        say(msg, _t('js.admbk.saved', 'Saved.'));
        setTimeout(function () { location.reload(); }, 500);
      });
  });
})();
