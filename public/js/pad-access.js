// pad-access.js — 1.99fu pad visibility (padaccess.js) in the browser:
//   * the locked pad card (views/padLocked.ejs): "Request access" -> POST /api/pads/<slug>/access/request
//   * pad settings → General → "Who can see this pad" (#access): the level (Public / Members / Approved), the
//     requests waiting (Approve / Deny) and the approved members (Remove). GET /api/pads/<slug>/access reads it;
//     every change is a same-site JSON POST and the server re-checks that the viewer manages the pad.
// Everything user-visible goes in via textContent.
(function () {
  'use strict';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(url, body) {
    var o = body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' };
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Something went wrong.');
        return j;
      });
    });
  }
  function when(ms) { if (!ms) return ''; var d = new Date(ms); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }

  // ── the locked card ──
  var lock = document.getElementById('paLock');
  var form = document.getElementById('paReq');
  if (lock && form) {
    var slug = lock.getAttribute('data-slug');
    var msg = document.getElementById('paMsg');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var b = form.querySelector('button[type=submit]');
      b.disabled = true; msg.className = 'pa-msg'; msg.textContent = 'Sending…';
      api('/api/pads/' + encodeURIComponent(slug) + '/access/request', { note: form.note.value }).then(function () {
        var p = el('p', 'pa-st', '⏳ Request sent. The pad\'s owner gets a notice; you\'ll get one when they decide.');
        p.setAttribute('role', 'status');
        form.replaceWith(p);
      }).catch(function (er) { b.disabled = false; msg.className = 'pa-msg bad'; msg.textContent = er.message; });
    });
  }

  // ── the settings card ──
  var card = document.getElementById('access');
  if (!card || !card.getAttribute('data-slug')) return;
  var base = '/api/pads/' + encodeURIComponent(card.getAttribute('data-slug')) + '/access';
  var levelsBox = card.querySelector('.pa-levels'), out = card.querySelector('.pa-out');
  var pendBox = card.querySelector('[data-pa=pending]'), memBox = card.querySelector('[data-pa=members]');
  var reqWrap = card.querySelector('[data-pa=approvedOnly]');
  function say(t, bad) { out.className = 'pa-msg pa-out' + (bad ? ' bad' : ''); out.textContent = t || ''; }

  function row(m, kind) {
    var li = el('li');
    var who = m.username ? el('a', 'pa-who', m.display || m.username) : el('span', 'pa-who', m.display || '[gone]');
    if (m.username) who.href = '/u/' + encodeURIComponent(m.username);
    li.appendChild(who);
    li.appendChild(el('span', 'pa-when', kind === 'pending' ? 'asked ' + when(m.requested_at) : 'approved ' + when(m.decided_at) + (m.decided_by ? ' by ' + m.decided_by : '')));
    var acts = el('span', 'pa-acts');
    function act(label, cls, path, body, confirmTxt) {
      var b = el('button', 'pa-s ' + cls, label); b.type = 'button';
      b.addEventListener('click', function () {
        if (confirmTxt && !window.confirm(confirmTxt)) return;
        b.disabled = true; say('Saving…');
        api(base + path, body).then(function (j) { paint(j.manage); say(''); }).catch(function (er) { b.disabled = false; say(er.message, true); });
      });
      acts.appendChild(b);
    }
    if (kind === 'pending') {
      act('✓ Approve', 'ok', '/decide', { userId: m.userId, approve: true });
      act('✕ Deny', 'no', '/decide', { userId: m.userId, approve: false });
    } else {
      act('Remove', 'no', '/remove', { userId: m.userId }, 'Remove ' + (m.display || m.username || 'them') + '? They lose access right away and can ask again tomorrow.');
    }
    li.appendChild(acts);
    if (m.note) li.appendChild(el('span', 'pa-note', '“' + m.note + '”'));
    return li;
  }
  function list(box, items, kind, empty) {
    box.textContent = '';
    if (!items.length) { box.appendChild(el('p', 'pa-empty', empty)); return; }
    var ul = el('ul', 'pa-list');
    items.forEach(function (m) { ul.appendChild(row(m, kind)); });
    box.appendChild(ul);
  }
  function paint(M) {
    if (!M) return;
    Array.prototype.forEach.call(levelsBox.querySelectorAll('input[name=paLevel]'), function (i) { i.checked = i.value === M.level; });
    reqWrap.hidden = M.level !== 'approved' && !M.pending.length && !M.members.length;
    list(pendBox, M.pending, 'pending', 'Nobody is waiting.');
    list(memBox, M.members, 'members', M.level === 'approved' ? 'No approved members yet - you, the site admins and staff always have access.' : 'No approved members.');
  }
  levelsBox.addEventListener('change', function (e) {
    var i = e.target;
    if (!i || i.name !== 'paLevel') return;
    say('Saving…');
    Array.prototype.forEach.call(levelsBox.querySelectorAll('input'), function (x) { x.disabled = true; });
    api(base + '/level', { level: i.value }).then(function (j) { paint(j.manage); say('✓ Saved: ' + i.getAttribute('data-label') + '.'); })
      .catch(function (er) { say(er.message, true); load(); })
      .then(function () { Array.prototype.forEach.call(levelsBox.querySelectorAll('input'), function (x) { x.disabled = false; }); });
  });
  function load() { api(base).then(function (j) { if (j.manage) paint(j.manage); }).catch(function (er) { say(er.message, true); }); }
  load();
})();
