// /settings/privacy - 📡 live cam (1.99yh, livecam.js): "Let members watch my cam live". The site owns this switch (Pepe's
// !livecam off|on writes to the same place), so a change applies at once: switching it off ends any live relay of the cam.
(function () {
  'use strict';
  var box = document.getElementById('pvLc'), st = document.getElementById('pvLcSt');
  if (!box || !st) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  function say(text, kind) { st.textContent = text || ''; st.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  function paint(off) {
    box.checked = !off;
    say(off ? _t('js.lc.st_off', 'Off - nobody can watch your cam live on the website.') : _t('js.lc.st_on', 'On - members can watch your cam live.'));
  }
  box.addEventListener('change', function () {
    var off = !box.checked;
    box.disabled = true;
    say(_t('js.lc.saving', 'Saving…'), 'wait');
    fetch('/api/privacy/livecam', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ off: off }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        box.disabled = false;
        if (!d || !d.ok) { box.checked = off; return say((d && d.error) || _t('js.lc.failed', 'Not saved - try again.'), 'bad'); }
        paint(!!d.off);
      })
      .catch(function () { box.disabled = false; box.checked = off; say(_t('js.lc.failed', 'Not saved - try again.'), 'bad'); });
  });
})();
