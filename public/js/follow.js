// follow.js — Follow / Following buttons (rooms, people, post authors) and the "tell me when someone I
// follow posts" switch (1.99bz). Buttons: [data-follow-kind][data-follow-id], aria-pressed = following.
// Signed-out buttons are plain links to the sign-in page. Same-site JSON with X-Requested-With: fetch.
(function () {
  'use strict';
  if (window.__patvFollow) return;
  window.__patvFollow = true;
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) { if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  function paint(b, on) {
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('on', on);
    var lbl = b.querySelector('.fw-l') || b;
    lbl.textContent = on ? (b.getAttribute('data-on-label') || 'Following') : (b.getAttribute('data-off-label') || '+ Follow');
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-follow-kind]');
    if (!b) return;
    ev.preventDefault();
    var kind = b.getAttribute('data-follow-kind'), id = b.getAttribute('data-follow-id');
    var on = b.getAttribute('aria-pressed') !== 'true';
    b.disabled = true;
    api('/api/follow', { kind: kind, id: id, on: on }).then(function (d) {
      // every button for the same target (an author can appear on several cards)
      document.querySelectorAll('button[data-follow-kind="' + kind + '"]').forEach(function (x) { if (x.getAttribute('data-follow-id') === id) paint(x, d.following); });
      document.querySelectorAll('[data-follower-count-kind="' + kind + '"]').forEach(function (x) {
        if (x.getAttribute('data-follower-count-id') === id) x.textContent = d.followers.toLocaleString('en-US');
      });
    }).catch(function (e) { alert(e.message); }).then(function () { b.disabled = false; });
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!t.matches || !t.matches('input[data-follow-notify]')) return;
    t.disabled = true;
    api('/api/follow/prefs', { notify: t.checked }).catch(function (e) { alert(e.message); t.checked = !t.checked; }).then(function () { t.disabled = false; });
  });
})();
