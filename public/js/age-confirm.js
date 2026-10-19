// age-confirm.js — adultgate site: the /confirm-age page (views/ageConfirm.ejs). Ticking the box and Confirm sends a
// same-site JSON POST to /api/age/confirm (X-Requested-With: fetch - the server refuses anything else), then goes back to
// the page's local `next` path. Everything user-visible goes in via textContent.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var box = document.getElementById('ageBox'), form = document.getElementById('ageForm');
  if (!box || !form) return;
  var msg = document.getElementById('ageMsg');
  var next = box.getAttribute('data-next') || '/';
  if (next.charAt(0) !== '/' || next.charAt(1) === '/' || next.charAt(1) === '\\') next = '/';
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var ck = document.getElementById('ageCk');
    if (!ck || !ck.checked) { msg.className = 'pa-msg bad'; msg.textContent = _t('js.age.tick', 'Tick the box to confirm.'); return; }
    var b = form.querySelector('button[type=submit]');
    b.disabled = true; msg.className = 'pa-msg'; msg.textContent = _t('js.age.saving', 'Saving…');
    fetch('/api/age/confirm', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                                body: JSON.stringify({ yes: true }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error(j && j.code === 'tick' ? 'tick' : 'fail');
        location.assign(next);
      })
      .catch(function (er) {
        // the page's own (translated) words - never the server's English
        b.disabled = false; msg.className = 'pa-msg bad';
        msg.textContent = er && er.message === 'tick' ? _t('js.age.tick', 'Tick the box to confirm.') : _t('js.age.fail', 'That didn\'t work - try again.');
      });
  });
})();
