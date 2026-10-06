// feed-admin.js — /feed/admin (1.99bv): settings, report triage, feed bans.
(function () {
  'use strict';
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  var cfg = document.getElementById('faCfg');
  if (cfg) cfg.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var out = {};
    Array.prototype.forEach.call(cfg.elements, function (el) {
      if (!el.name) return;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    var msg = document.getElementById('faMsg');
    api('/api/feed/admin/config', out).then(function () { msg.textContent = 'Saved ✔'; msg.classList.add('ok'); }).catch(function (e) { msg.textContent = e.message; msg.classList.remove('ok'); });
  });
  var ban = document.getElementById('faBan');
  if (ban) ban.addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('/api/feed/ban', { user: ban.elements.user.value, days: ban.elements.days.value, reason: ban.elements.reason.value })
      .then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
  });
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-fa]');
    if (!b) return;
    var act = b.getAttribute('data-fa');
    var rep = b.closest('.fa-rep');
    var id = rep ? rep.getAttribute('data-id') : null;
    var done = function () { location.reload(); };
    var oops = function (e) { alert(e.message); };
    if (act === 'keep') api('/api/feed/posts/' + id + '/admin', { hidden: false }).then(function () { return api('/api/feed/admin/resolve', { post: id, action: 'kept' }); }).then(done, oops);
    else if (act === 'delete') { var why = window.prompt('Reason (the author is told):', ''); if (why !== null) api('/api/feed/posts/' + id + '/delete', { reason: why }).then(done, oops); }
    else if (act === 'nsfw') api('/api/feed/posts/' + id + '/admin', { nsfw: /^Mark/.test(b.textContent) }).then(done, oops);
    else if (act === 'ban') {
      var days = window.prompt('Ban ' + b.getAttribute('data-user') + ' from posting on the feed for how many days? (0 = forever)', '7');
      if (days !== null) api('/api/feed/ban', { user: b.getAttribute('data-user'), days: days, reason: 'reported post' }).then(done, oops);
    } else if (act === 'unban') api('/api/feed/unban', { userId: b.getAttribute('data-uid'), room: b.getAttribute('data-room') || '' }).then(done, oops);
  });
})();
