// /settings/privacy - 🧠 "Make Pepe forget me" (1.99aat, pepeforget.js): type FORGET, then the site deletes your DMs with
// Pepe at once and asks Pepe to forget the rest (his memory of you, your PM logs, his chat history with you). CL6: the
// "Also hide my past public chat lines" box (#pvPfLines) sends hide_lines. Wave 3 (design §N.4): "Keep it that way - don't remember
// me from now on" (#pvPfKeep, ticked by default; only while Pepe has the memory switch) sends keep_off - the 🧠 Pepe's memory card
// (privacy-memory.js) then waits for Pepe's report of it.
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
    // CL6: "Also hide my past public chat lines" (unticked by default)
    var lines = document.getElementById('pvPfLines');
    var keep = document.getElementById('pvPfKeep');
    fetch('/api/privacy/pepe-forget', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ confirm: v, hide_lines: !!(lines && lines.checked), keep_off: !!(keep && keep.checked) }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        b.disabled = false;
        if (!d || !d.ok) return say((d && d.error) || _t('js.lc.failed', 'Not saved - try again.'), 'bad');
        form.confirm.value = '';
        say(_t('js.pf.done', 'Done: {n} private message(s) with Pepe deleted here. Pepe forgets the rest within a minute.', { n: d.dms || 0 }), 'ok');
        if (d.memory_action) { try { window.dispatchEvent(new Event('pv-memory-request')); } catch (e) { /* old browser: the card catches up within a minute */ } }
      })
      .catch(function () { b.disabled = false; say(_t('js.lc.failed', 'Not saved - try again.'), 'bad'); });
  });
})();
