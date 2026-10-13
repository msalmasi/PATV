// chat-signin-setting.js - Settings -> Security: the "Sign in from chat" (!signin) switch and the account's recent chat sign-ins
// (chatsignin.js: GET / POST /api/settings/chat-signin).
(function () {
  'use strict';
  var box = document.getElementById('csToggle');
  if (!box) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  var label = document.getElementById('csToggleL'), st = document.getElementById('csStatus'), list = document.getElementById('csLog');
  var KIND = { issued: 'link sent by PM', used: 'signed in', refused: 'refused', 'setting-on': 'turned on', 'setting-off': 'turned off' };
  function say(t, bad) { st.textContent = t || ''; st.className = 'status ' + (bad ? 'err' : 'ok'); }
  function show(on) { box.checked = !!on; label.textContent = on ? _t('js.settings.cs_on', 'On') : _t('js.settings.cs_off', 'Off'); }
  function render(j) {
    show(j.enabled);
    box.disabled = false;
    list.textContent = '';
    (j.log || []).forEach(function (x) {
      var li = document.createElement('li');
      li.textContent = new Date(Number(x.at)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC · ' + (KIND[x.kind] || x.kind) +
        (x.why ? ' (' + x.why + ')' : '') + (x.ip ? ' · ' + x.ip : '') + (x.agent ? ' · ' + x.agent : '');
      list.appendChild(li);
    });
    if (!(j.log || []).length) { var li = document.createElement('li'); li.textContent = _t('js.settings.cs_none', 'No chat sign-ins yet.'); list.appendChild(li); }
  }
  fetch('/api/settings/chat-signin', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) render(j); }).catch(function () {});
  box.addEventListener('change', function () {
    var on = box.checked;
    box.disabled = true;
    fetch('/api/settings/chat-signin', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' },
                                         body: JSON.stringify({ enabled: on }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j || !j.ok) throw new Error('failed'); show(j.enabled); say(_t('js.settings.cs_saved', 'Saved.')); })
      .catch(function () { show(!on); say(_t('js.settings.cs_failed', "Couldn't save - try again."), true); })
      .then(function () { box.disabled = false; });
  });
})();
