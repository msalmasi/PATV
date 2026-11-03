// pad-clip-settings.js — 1.99?? cliplink: the pad settings' Camfrog room tab, "Clips from the website need a linked Camfrog name"
// (cliplink.js; views/padSettings.ejs #padClipSet). One switch, saved when it changes (same-site JSON); the server checks who may
// change it (the pad's owner, site staff and admins) on every request and answers the saved value.
(function () {
  'use strict';
  var root = document.getElementById('padClipSet');
  var box = document.getElementById('pclLink');
  var msg = document.getElementById('pclMsg');
  if (!root || !box || !msg) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var slug = root.getAttribute('data-slug');
  function say(t, err) { msg.textContent = t || ''; msg.className = 'msg' + (err ? ' err' : ''); }
  // the server's refusals in the viewer's language, by their code (cliplink.js); an unknown one keeps the server's text
  function errText(code, fallback) {
    switch (code) {
      case 'signin': return _t('js.pad.clipset.err_signin', 'Sign in first.');
      case 'no_pad': return _t('js.pad.clipset.err_no_pad', 'No such pad.');
      case 'not_camfrog': return _t('js.pad.clipset.err_not_camfrog', 'This pad has no Camfrog room, so it has no clips from the bridge.');
      case 'not_owner': return _t('js.pad.clipset.err_not_owner', 'Only this pad’s owner (and site staff) can change its clip settings.');
      case 'bad_value': return _t('js.pad.clipset.err_bad_value', 'That setting is on or off.');
      case 'rate': return _t('js.pad.clipset.err_rate', 'That’s a lot of changes at once - try again in a minute.');
      case 'security': return _t('js.pad.clipset.err_security', 'Security check failed - reload the page.');
      case 'error': return _t('js.pad.clipset.err_error', 'Something went wrong - nothing was changed.');
      default: return fallback || _t('js.pad.clipset.err_error', 'Something went wrong - nothing was changed.');
    }
  }
  box.addEventListener('change', function () {
    var want = !!box.checked;
    box.disabled = true;
    say(_t('js.pad.clipset.saving', 'Saving…'));
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/clip-settings', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ need_link: want })
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (d) {
        if (!r.ok || !d || d.ok === false) { var e = new Error((d && d.error) || ''); e.code = d && d.code; throw e; }
        return d;
      });
    }).then(function (d) {
      box.checked = !!d.need_link;
      say(d.need_link ? _t('js.pad.clipset.saved_on', 'Saved: clips from the website need a linked Camfrog name.')
        : _t('js.pad.clipset.saved_off', 'Saved: members without a linked Camfrog name can clip here too, and the clip is charged to their PATV account.'));
    }).catch(function (e) {
      box.checked = !want;
      say(errText(e && e.code, e && e.message), true);
    }).then(function () { box.disabled = false; });
  });
})();
