// /settings/privacy - 🧠 "Make Pepe forget me" (1.99aat, pepeforget.js): type FORGET, then the site deletes your DMs with
// Pepe at once and asks Pepe to forget the rest (his memory of you, your PM logs, his chat history with you).
(function () {
  'use strict';
  var form = document.getElementById('pvPf'), st = document.getElementById('pvPfSt');
  if (!form || !st) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function say(text, kind) { st.textContent = text || ''; st.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = form.confirm.value.trim();
    if (v.toLowerCase() !== 'forget') return say(_t('js.pf.type', 'Type FORGET to confirm.'), 'bad');
    var b = form.querySelector('button');
    b.disabled = true;
    say(_t('js.lc.saving', 'Saving…'), 'wait');
    fetch('/api/privacy/pepe-forget', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ confirm: v }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        b.disabled = false;
        if (!d || !d.ok) return say((d && d.error) || _t('js.lc.failed', 'Not saved - try again.'), 'bad');
        form.confirm.value = '';
        say(_t('js.pf.done', 'Done: {n} private message(s) with Pepe deleted here. Pepe forgets the rest within a minute.', { n: d.dms || 0 }), 'ok');
      })
      .catch(function () { b.disabled = false; say(_t('js.lc.failed', 'Not saved - try again.'), 'bad'); });
  });
})();
