// feed-roommod.js — a room owner's feed tools page (/rooms/:slug/feed/mod, 1.99bx). Same-site JSON fetches;
// the server checks that the viewer owns this room (or is site staff) on every action.
(function () {
  'use strict';
  var root = document.querySelector('.fd-rmod');
  if (!root) return;
  var slug = root.getAttribute('data-slug');
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) { if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  var mod = function (body) { return api('/api/rooms/' + encodeURIComponent(slug) + '/feed/mod', body); };
  var reload = function () { location.reload(); };
  var oops = function (e) { alert(e.message); };

  root.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-op]');
    if (!b) return;
    var op = b.getAttribute('data-op');
    var item = b.closest('.rm-item');
    var post = item ? item.getAttribute('data-post') : null;
    var comment = item ? item.getAttribute('data-comment') : null;
    if (op === 'cdelete') {
      var why = window.prompt('Remove this comment. Reason (optional, the author is told):', '');
      if (why === null) return;
      api('/api/feed/comments/' + encodeURIComponent(comment) + '/delete', { reason: why }).then(reload, oops);
      return;
    }
    if (op === 'unban') { api('/api/feed/unban', { userId: b.getAttribute('data-user'), room: slug }).then(reload, oops); return; }
    if (op === 'member-remove') { mod({ op: op, userId: b.getAttribute('data-user') }).then(reload, oops); return; }
    var body = { op: op, post: post, comment: comment };
    if (op === 'reject') { var r = window.prompt('Reject this post? Reason (optional, the author is told):', ''); if (r === null) return; body.reason = r; }
    if (op === 'remove' && !window.confirm('Take this post out of your pad? (It stays anywhere else it was posted.)')) return;
    b.disabled = true;
    mod(body).then(reload, function (e) { b.disabled = false; oops(e); });
  });

  function form(id, fn) {
    var f = document.getElementById(id);
    if (!f) return;
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = f.querySelector('.fc-err'); if (err) err.textContent = '';
      fn(f).then(reload, function (e) { if (err) err.textContent = e.message; else oops(e); });
    });
  }
  form('rmSettings', function (f) {
    return mod({ op: 'settings', settings: { who: f.elements.who.value, approval: f.elements.approval.checked, per_day: f.elements.per_day.value } });
  });
  form('rmMember', function (f) { return mod({ op: 'member-add', user: f.elements.user.value }); });
  form('rmBan', function (f) {
    return api('/api/feed/ban', { user: f.elements.user.value, room: slug, days: parseInt(f.elements.days.value, 10) || 0, reason: f.elements.reason.value });
  });
})();
