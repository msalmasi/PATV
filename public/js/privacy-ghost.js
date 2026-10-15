// /settings/privacy - 👻 ghost mode (1.99aaf, ghost.js; site staff only): cam views through the website tell nobody while
// it's on - and every one of them is still in the admins' audit.
(function () {
  'use strict';
  var box = document.getElementById('pvGh'), st = document.getElementById('pvGhSt');
  if (!box || !st) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  function say(text, kind) { st.textContent = text || ''; st.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  function paint(on) {
    box.checked = !!on;
    say(on ? _t('js.gh.st_on', 'Ghost mode is ON - cam owners aren\'t told when you open their cam. Admins can still see every view.')
           : _t('js.gh.st_off', 'Ghost mode is off.'), on ? 'ok' : '');
  }
  box.addEventListener('change', function () {
    var on = box.checked;
    box.disabled = true;
    say(_t('js.gh.saving', 'Saving…'), 'wait');
    fetch('/api/privacy/ghost', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ on: on }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        box.disabled = false;
        if (!d || !d.ok) { box.checked = !on; return say((d && d.error) || _t('js.gh.failed', 'Not saved - try again.'), 'bad'); }
        paint(d.on);
      })
      .catch(function () { box.disabled = false; box.checked = !on; say(_t('js.gh.failed', 'Not saved - try again.'), 'bad'); });
  });
})();
