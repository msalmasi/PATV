// /voices/clone (1.99ri): consent -> the phrase + script to read on the mic -> live status (polls /api/voiceclone/me), and deleting
// the voice. Strings: __t (js.vc.*).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var root = document.getElementById('vcx');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) { if (!d || !d.ok) throw new Error((d && d.error) || _t('js.vc.failed', 'That didn\'t work - try again.')); return d; });
  }
  function say(el, text, cls) { if (!el) return; el.textContent = text || ''; el.className = 'vc-msg' + (cls ? ' ' + cls : ''); }
  var timer = null, lastStatus = root.getAttribute('data-status');
  function poll() {
    fetch('/api/voiceclone/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      var c = d.consent || {};
      if (c.status && c.status !== lastStatus && lastStatus === 'phrase') { location.reload(); return; }
      if (c.status === 'phrase') {
        var ch = c.checks || {};
        if (c.attempts && ch.phrase != null) say($('vcLive'), _t('js.vc.retry', 'That try didn\'t pass - read it again in one turn, alone on the mic.'), 'bad');
        else say($('vcLive'), _t('js.vc.waiting', 'Waiting for your turn on the mic…'));
      }
    }).catch(function () {});
  }
  if (lastStatus === 'phrase' && $('vcRead') && !$('vcRead').hidden) timer = setInterval(poll, 5000);
  var form = $('vcConsent');
  if (form) form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var b = { attest18: form.attest18.checked, consent: form.consent.checked, typed_login: form.typed_login.value.trim() };
    if (!b.attest18) { say($('vcMsg'), _t('js.vc.need18', 'Cloning is for adults only - confirm you\'re 18 or older.'), 'bad'); return; }
    if (!b.consent) { say($('vcMsg'), _t('js.vc.need_consent', 'Tick the consent box to go on.'), 'bad'); return; }
    say($('vcMsg'), _t('js.vc.working', 'Working…'));
    post('/api/voiceclone/consent', b).then(function (d) {
      var c = d.consent || {};
      $('vcPhrase').textContent = c.phrase || '';
      $('vcScript').textContent = c.script || '';
      $('vcForm').hidden = true;
      $('vcRead').hidden = false;
      lastStatus = 'phrase';
      if (!timer) timer = setInterval(poll, 5000);
      $('vcRead').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { say($('vcMsg'), e.message, 'bad'); });
  });
  root.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('[data-vc-revoke]') : null;
    if (!b) return;
    if (!window.confirm(_t('js.vc.confirm_delete', 'Delete your cloned voice? It stops working everywhere at once and is deleted from both voice servers. This can\'t be undone.'))) return;
    b.disabled = true;
    post('/api/voiceclone/revoke', {}).then(function () { say($('vcRevMsg'), _t('js.vc.deleted', 'Deleted. It stops at once; the servers forget it within minutes.'), 'ok'); setTimeout(function () { location.reload(); }, 1500); })
      .catch(function (e) { b.disabled = false; say($('vcRevMsg'), e.message, 'bad'); });
  });
})();
