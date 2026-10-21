// admin-backends.js - /admin/backends (backends.js, owner answers 2026-10-20): one hand-over switch at a time. A same-origin
// POST /api/admin/backends/:feature {on} (X-Requested-With: fetch), checked on the server (Admins; a Pepe owner on the rows
// that hold members' PAT) and audited; the page reloads to show the result. Messages go in with textContent only.
// The review of the owner answers: the confirm says what really happens - Pepe moves it himself only when he follows the
// switch (data-follows="1"); otherwise the switch sets the site's side and a Pepe owner runs the chat command (data-cmd).
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
    var follows = b.getAttribute('data-follows') === '1', cmd = b.getAttribute('data-cmd') || '';
    var q = follows
      ? (on ? _t('js.admbk.confirm_on', 'Move {name} to publicaccess.tv? Pepe follows this switch: he runs the hand-over at his next quiet moment.', { name: name })
        : _t('js.admbk.confirm_off', 'Bring {name} back to Pepe? Pepe follows this switch: he runs the way back at his next quiet moment.', { name: name }))
      : (on ? _t('js.admbk.confirm_on_chat', "Set the site's side of {name} to take it over? Pepe doesn't follow this switch yet: nothing moves until a Pepe owner runs {cmd} in chat.", { name: name, cmd: cmd })
        : _t('js.admbk.confirm_off_chat', "Set the site's side of {name} back? Pepe doesn't follow this switch yet: it comes back only when a Pepe owner runs {cmd} in chat.", { name: name, cmd: cmd }));
    if (!window.confirm(q)) return;
    var msg = b.parentNode ? b.parentNode.querySelector('.adm-msg') : null;
    say(msg, _t('js.admbk.working', 'Saving…'));
    fetch('/api/admin/backends/' + encodeURIComponent(key), { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ on: on }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false }; })
      .then(function (j) {
        if (!j || !j.ok) return say(msg, (j && j.error) || _t('js.admbk.failed', 'That did not work - try again.'), true);
        say(msg, j.chat ? _t('js.admbk.saved_chat', 'Saved. Now a Pepe owner runs {cmd} in chat to move it.', { cmd: j.chat }) : _t('js.admbk.saved', 'Saved.'));
        setTimeout(function () { location.reload(); }, j.chat ? 2500 : 500);
      });
  });
})();
