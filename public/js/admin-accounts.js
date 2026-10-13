// admin-accounts.js - /admin/accounts (accountsadmin.js, 1.99wl): the people search, a member's sessions + deletion status,
// and the three actions (sign out everywhere / schedule deletion / cancel deletion - each needs a reason + the username typed).
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var $ = function (id) { return document.getElementById(id); };
  var H = { 'content-type': 'application/json', 'X-Requested-With': 'fetch' };
  var cur = null;
  function when(ms) { if (!ms) return '–'; try { return new Date(Number(ms)).toLocaleString(); } catch (e) { return String(ms); } }
  function td(text) { var c = document.createElement('td'); c.textContent = text == null ? '' : String(text); return c; }
  function say(id, msg, bad) { var s = $(id); if (s) { s.textContent = msg || ''; s.className = 'adm-msg' + (bad ? ' err' : msg ? ' ok' : ''); } }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  // people search (username, display name or Camfrog login, any length)
  var q = $('aaQ'), dl = $('aaPeople'), timer = null;
  if (q) q.addEventListener('input', function () {
    clearTimeout(timer);
    var v = q.value.trim();
    if (v.length < 2) return;
    timer = setTimeout(function () {
      fetch('/api/admin/accounts/people?q=' + encodeURIComponent(v), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
        .then(function (r) { return r.json(); }).then(function (j) {
          dl.textContent = '';
          ((j && j.people) || []).forEach(function (p) {
            var o = document.createElement('option'); o.value = p.username;
            o.label = [p.display, p.camfrog ? '🐸 ' + p.camfrog : null].filter(Boolean).join(' · ');
            dl.appendChild(o);
          });
        }).catch(function () {});
    }, 200);
  });

  function render(j) {
    cur = j;
    $('aaUser').hidden = false;
    $('aaName').textContent = '@' + j.user.username + (j.user.display && j.user.display !== j.user.username ? ' (' + j.user.display + ')' : '');
    $('aaMeta').textContent = [_t('js.admacct.class', 'Class: {c}', { c: j.user.class || 'pleb' }), j.user.camfrog ? '🐸 ' + j.user.camfrog : null,
                               j.user.elevated ? _t('js.admacct.elevated', 'Admin / staff / moderator: only another admin can delete this account') : null].filter(Boolean).join(' · ');
    var tb = $('aaSessions'); tb.textContent = '';
    (j.sessions || []).forEach(function (s) {
      var tr = document.createElement('tr');
      tr.appendChild(td(s.method === 'legacy' && s.legacy_before ? _t('js.acct.legacy_device', 'Unknown device, signed in before {date}', { date: when(s.legacy_before) }) : s.device));
      tr.appendChild(td(s.method)); tr.appendChild(td([s.country, s.ip].filter(Boolean).join(' · ')));
      tr.appendChild(td(when(s.last_seen))); tr.appendChild(td(when(s.created)));
      tb.appendChild(tr);
    });
    if (!(j.sessions || []).length) { var tr = document.createElement('tr'); var c = td(_t('js.admacct.no_sessions', 'Not signed in anywhere.')); c.colSpan = 5; c.className = 'empty'; tr.appendChild(c); tb.appendChild(tr); }
    var d = j.deletion || { state: 'none' };
    var line = d.state === 'scheduled' ? _t('js.admacct.del_scheduled', 'Scheduled for {date} (asked by {by})', { date: when(d.execute_at), by: d.requested_by })
      : d.state === 'held' ? _t('js.admacct.del_held', 'On hold since {date}', { date: when(d.execute_at) })
      : d.state === 'done' ? _t('js.admacct.del_done', 'Deleted on {date}', { date: when(d.done_at) })
      : d.state === 'cancelled' ? _t('js.admacct.del_cancelled', 'None (the last request was cancelled: {via})', { via: d.cancel_via || '?' })
      : _t('js.admacct.del_none', 'None');
    $('aaDel').textContent = line;
    var bl = $('aaBlockers'); bl.textContent = '';
    (d.blockers || []).forEach(function (b) { var li = document.createElement('li'); li.textContent = b.label; bl.appendChild(li); });
    var pendingDel = d.state === 'scheduled' || d.state === 'held';
    $('aaDelBtn').hidden = pendingDel || d.state === 'done';
    $('aaCancelBtn').hidden = !pendingDel;
    var ev = $('aaEvents'); ev.textContent = '';
    (j.events || []).forEach(function (e) { var li = document.createElement('li'); li.textContent = when(e.at) + ' · ' + e.kind + (e.detail ? ' · ' + e.detail : ''); ev.appendChild(li); });
  }
  function load(u) {
    say('aaMsg', _t('js.admacct.loading', 'Loading…'));
    fetch('/api/admin/accounts/user?u=' + encodeURIComponent(u), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { $('aaUser').hidden = true; say('aaMsg', (j && j.error) || _t('js.admacct.not_found', 'No such member.'), true); return; }
        say('aaMsg', ''); render(j);
        try { history.replaceState(null, '', '/admin/accounts?u=' + encodeURIComponent(j.user.username) + '#lookup'); } catch (e) {}
      }).catch(function () { say('aaMsg', _t('js.admacct.failed', "Couldn't do that - try again."), true); });
  }
  if ($('aaFind')) $('aaFind').addEventListener('submit', function (e) { e.preventDefault(); if (q.value.trim()) load(q.value.trim()); });
  if (q && q.value.trim()) load(q.value.trim());

  function act(formId, msgId, url, body, question) {
    if (!cur) return;
    if (!window.confirm(question)) return;
    say(msgId, _t('js.admacct.working', 'Working…'));
    post(url, body).then(function (j) {
      if (j && j.ok) { say(msgId, _t('js.admacct.done', 'Done.')); load(cur.user.username); return; }
      say(msgId, (j && j.error) || _t('js.admacct.failed', "Couldn't do that - try again."), true);
    }).catch(function () { say(msgId, _t('js.admacct.failed', "Couldn't do that - try again."), true); });
  }
  if ($('aaRevoke')) $('aaRevoke').addEventListener('submit', function (e) {
    e.preventDefault();
    act('aaRevoke', 'aaRevokeMsg', '/api/admin/users/' + encodeURIComponent(cur.user.userId) + '/sessions/revoke',
        { reason: $('aaRevokeWhy').value, confirm: $('aaRevokeConfirm').value },
        _t('js.admacct.revoke_q', 'Sign @{name} out on every device?', { name: cur.user.username }));
  });
  if ($('aaDelForm')) $('aaDelForm').addEventListener('submit', function (e) {
    e.preventDefault();
    act('aaDelForm', 'aaDelMsg', '/api/admin/users/' + encodeURIComponent(cur.user.userId) + '/delete',
        { reason: $('aaDelWhy').value, confirm: $('aaDelConfirm').value },
        _t('js.admacct.delete_q', "Schedule @{name}'s account for deletion in 14 days? They are signed out everywhere now; signing in cancels it.", { name: cur.user.username }));
  });
  if ($('aaCancelBtn')) $('aaCancelBtn').addEventListener('click', function () {
    if (!cur || !cur.deletion || !cur.deletion.id) return;
    act('aaDelForm', 'aaDelMsg', '/api/admin/account-deletions/' + cur.deletion.id + '/cancel',
        { reason: $('aaDelWhy').value, confirm: $('aaDelConfirm').value },
        _t('js.admacct.cancel_q', "Cancel @{name}'s account deletion?", { name: cur.user.username }));
  });
})();
