// dm-admin.js — /feed/admin#dms (1.99cp): reported direct messages, site Admins only.
// "Read" fetches ONE reported message + its safety record (the server logs the read first). Text goes in with textContent only.
(function () {
  'use strict';
  function api(url, body) {
    return fetch(url, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
    });
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function when(ms) { return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '?'; }

  function showDetail(box, d) {
    box.textContent = '';
    var m = d.message || {};
    var q = el('blockquote', 'fa-dm-text');
    q.textContent = m.text || '(no text)';
    q.style.cssText = 'margin:8px 0;padding:10px 12px;border-left:3px solid #ff8a80;background:#1a1414;white-space:pre-wrap;overflow-wrap:anywhere;';
    box.appendChild(el('div', 'mut', 'From @' + (m.from || '?') + ' · sent ' + when(m.at) + (m.deleted ? ' · since deleted' + (m.deletedBy && m.deletedBy !== 'author' ? ' by ' + m.deletedBy : ' by the sender') + ' (the report kept this copy)' : '')));
    // 1.99cz: minimal context only (DM or group, its name and size - never other messages)
    var C = d.context || {};
    box.appendChild(el('div', 'mut', C.kind === 'group' ? 'In a group: "' + (C.title || '') + '" (' + (C.members || '?') + ' members)' : 'In a direct message'));
    box.appendChild(q);
    // its pictures: fetched one by one through the admin-only route (each view is logged server-side), only when clicked
    var P = m.pictures || [];
    if (P.length) {
      var row = el('div', 'fa-dm-pics');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:6px 0;';
      P.forEach(function (p) {
        var b = el('button', null, 'Show picture' + (p.nsfw ? ' (marked NSFW)' : ''));
        b.type = 'button';
        b.addEventListener('click', function () {
          b.disabled = true;
          fetch(p.url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
            .then(function (bl) { var img = document.createElement('img'); img.src = URL.createObjectURL(bl); img.alt = 'Reported picture'; img.style.cssText = 'max-width:320px;max-height:320px;border-radius:6px;'; b.replaceWith(img); })
            .catch(function (e) { b.disabled = false; alert(e.message); });
        });
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    var D = d.details || {};
    var recs = D.records || [];
    var s = D.subject || {};
    var info = el('div', 'mut');
    info.textContent = 'Sender: ' + (s.username || '?') + ' · account ' + (s.ageDays != null ? s.ageDays + ' days old' : 'age unknown') + ' · level ' + (s.level || 0) +
      ' · linked: ' + (Object.keys(s.linked || {}).filter(function (k) { return s.linked[k]; }).join(', ') || 'nothing');
    box.appendChild(info);
    recs.forEach(function (r) {
      box.appendChild(el('div', 'mut', 'Sent from ' + (r.rawPurged ? '(raw IP purged)' : (r.ip || '?')) + ' via ' + (r.via || '?') + (r.country ? ' · ' + r.country : '') +
        ' · net ' + (r.ipKey || '-') + ' · browser ' + (r.deviceKey || '-') + (r.ua ? ' · ' + r.ua : '')));
    });
    if ((D.sameIp || []).length) box.appendChild(el('div', 'mut', 'Same network (' + D.windowDays + ' d): ' + D.sameIp.map(function (x) { return x.username + ' ×' + x.count; }).join(', ')));
    if ((D.sameDevice || []).length) box.appendChild(el('div', 'mut', 'Same browser: ' + D.sameDevice.map(function (x) { return x.username + ' ×' + x.count; }).join(', ')));
    box.hidden = false;
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-dmfa]');
    if (!b) return;
    var row = b.closest('.fa-dm');
    var id = row.getAttribute('data-msg');
    var act = b.getAttribute('data-dmfa');
    if (act === 'read') {
      var why = window.prompt('Why are you opening this message? (kept in the access log)', 'reviewing the report');
      if (why === null) return;
      b.disabled = true;
      api('/api/messages/admin/report/' + encodeURIComponent(id) + '?why=' + encodeURIComponent(why)).then(function (d) { showDetail(row.querySelector('.fa-dm-body'), d); })
        .catch(function (e) { b.disabled = false; alert(e.message); });
      return;
    }
    var tell = row.querySelector('input[name=tell]');
    var body = { message: id, action: act, notify: !tell || tell.checked };
    if (act === 'ban') {
      var r = window.prompt('Remove the message and ban @' + row.getAttribute('data-user') + ' from the feed and messages.\nReason:', 'reported direct message');
      if (r === null) return;
      var d = window.prompt('Ban for how many days? (0 = forever)', '7');
      if (d === null) return;
      body.reason = r; body.days = parseInt(d, 10) || 0;
    }
    if (act === 'false' && !window.confirm('Dismiss as made in bad faith?')) return;
    b.disabled = true;
    api('/api/messages/admin/report-action', body).then(function () { location.reload(); }, function (e) { b.disabled = false; alert(e.message); });
  });
})();
