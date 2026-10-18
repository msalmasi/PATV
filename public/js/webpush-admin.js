// webpush-admin.js — the /admin/push page (1.99acd, webpush.js): save the settings, send a test to your own browsers.
(function () {
  'use strict';
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); });
  }
  function say(el, text, cls) { if (el) { el.textContent = text; el.className = 'adm-msg' + (cls ? ' ' + cls : ''); } }
  var form = document.getElementById('wpSettings');
  if (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var E = form.elements, msg = form.querySelector('.adm-msg');
      var settings = { webpush_enabled: E.webpush_enabled.checked, webpush_audience: E.webpush_audience.value, webpush_hosts_extra: E.webpush_hosts_extra.value };
      ['dm', 'mention', 'keyword'].forEach(function (k) { settings['webpush_kind_' + k] = E['webpush_kind_' + k].checked; });
      ['webpush_grace_dm_s', 'webpush_grace_mention_s', 'webpush_grace_keyword_s', 'webpush_dm_gap_s', 'webpush_hour_max', 'webpush_late_s'].forEach(function (k) { settings[k] = Number(E[k].value); });
      if (settings.webpush_enabled && !E.webpush_enabled.defaultChecked &&
          !window.confirm('Switch browser notifications ON for the audience "' + settings.webpush_audience + '"?')) return;
      if (settings.webpush_audience === 'everyone' && E.webpush_audience.querySelector('option[selected]') && E.webpush_audience.querySelector('option[selected]').value !== 'everyone' &&
          !window.confirm('Offer browser notifications to everyone?')) return;
      say(msg, 'Saving…');
      api('/api/admin/push/settings', { settings: settings }).then(function () {
        say(msg, 'Saved.', 'ok');
        setTimeout(function () { window.location.reload(); }, 600);
      }, function (e) { say(msg, e.message, 'err'); });
    });
  }
  var btn = document.getElementById('wpTest'), tmsg = document.getElementById('wpTestMsg');
  if (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      say(tmsg, 'Sending…');
      api('/api/admin/push/test', {}).then(function (d) {
        say(tmsg, 'Queued for ' + d.devices + ' browser' + (d.devices === 1 ? '' : 's') + ' - it should show up in a few seconds.', 'ok');
      }, function (e) { say(tmsg, e.message, 'err'); }).then(function () { setTimeout(function () { btn.disabled = false; }, 3000); });
    });
  }
})();
