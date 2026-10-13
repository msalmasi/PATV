// admin-autoescrow.js - /admin/economy's ⏳ Chat-account escrow card (autoescrow.js on the server, docs/auto-account-escrow.md).
// Read: GET /api/admin/autoescrow. Save: POST /api/admin/autoescrow/settings {enabled, kinds, note} (audit-logged on the server).
(function () {
  'use strict';
  var box = document.getElementById('aescAdm');
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var n = function (v) { return Number(v || 0).toLocaleString('en-US'); };
  var day = function (ms) { return ms ? new Date(Number(ms)).toISOString().slice(0, 10) : '—'; };
  var when = function (ms) { return ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') : '—'; };
  function msg(t, bad) { var m = $('aescMsg'); m.textContent = t || ''; m.style.color = bad ? '#ef5350' : ''; }
  function kv(label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); return d; }
  function row(tbody, cells) {
    var tr = document.createElement('tr');
    cells.forEach(function (t) { var td = document.createElement('td'); td.textContent = t == null ? '' : String(t); tr.appendChild(td); });
    tbody.appendChild(tr);
  }
  function empty(tbody, cols, text) { var tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = cols; td.className = 'empty'; td.textContent = text; tr.appendChild(td); tbody.appendChild(tr); }
  var dirty = false;
  function render(v) {
    var k = $('aescKv'); k.textContent = '';
    k.appendChild(kv('Holding new rewards', v.enabled ? 'ON' : 'off' + (v.enabled_by ? ' (' + v.enabled_by.by + ', ' + when(v.enabled_by.at) + ')' : '')));
    k.appendChild(kv('Waiting now', 'PAT ' + n(v.held.amount) + ' · ' + n(v.held.entries) + ' rewards · ' + n(v.held.accounts) + ' accounts'));
    k.appendChild(kv('Expiring in the next 30 days', 'PAT ' + n(v.expiring_30d.amount) + ' · ' + n(v.expiring_30d.accounts) + ' accounts'));
    k.appendChild(kv('Window', v.window_months + ' months per reward · Pepe PMs at most every ' + v.notice_gap_days + ' days'));
    k.appendChild(kv('Unclaimed goes to (PAT Routing ' + v.flow + ')', (v.routing || []).map(function (s) { return s[0] + ' ' + s[1] + '%'; }).join(', ') || 'reserve 100%'));
    if (v.auto_accounts != null) k.appendChild(kv('Auto accounts', n(v.auto_accounts)));
    if (!dirty) { $('aescOn').value = v.enabled ? 'true' : 'false'; $('aescKinds').value = (v.kinds || []).join(', '); }
    var t = $('aescTop'); t.textContent = '';
    if (!(v.top || []).length) empty(t, 5, 'Nothing waiting.');
    (v.top || []).forEach(function (x) { row(t, [x.username || x.user_id, x.login || '', 'PAT ' + n(x.amount), n(x.entries), day(x.next_expiry)]); });
    var kb = $('aescKind'); kb.textContent = '';
    (v.by_kind || []).forEach(function (x) { row(kb, [x.kind, n(x.n), 'PAT ' + n(x.t)]); });
    var months = {};
    (v.history || []).forEach(function (x) { var m = months[x.month] = months[x.month] || {}; m[x.state] = x; });
    (v.earned || []).forEach(function (x) { var m = months[x.month] = months[x.month] || {}; m.held = x; });
    var h = $('aescHist'); h.textContent = '';
    Object.keys(months).sort().reverse().forEach(function (mo) {
      var m = months[mo], c = m.claimed, e = m.expired, e2 = m.held;
      row(h, [mo, c ? 'PAT ' + n(c.t) + ' (' + n(c.n) + ')' : '—', e ? 'PAT ' + n(e.t) + ' (' + n(e.n) + ')' : '—', e2 ? 'PAT ' + n(e2.t) + ' (' + n(e2.n) + ')' : '—']);
    });
    var cl = $('aescClaims'); cl.textContent = '';
    (v.claims || []).forEach(function (x) { row(cl, [when(x.at), x.username || x.user_id, 'PAT ' + n(x.amount), n(x.entries), x.via]); });
  }
  function load() {
    return fetch('/api/admin/autoescrow', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || 'failed'); render(j); })
      .catch(function (e) { msg(e.message, true); });
  }
  ['aescOn', 'aescKinds'].forEach(function (id) { $(id).addEventListener('input', function () { dirty = true; }); });
  $('aescForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var on = $('aescOn').value === 'true';
    if (on && !window.confirm('Hold new free rewards of chat-only (auto) accounts in escrow from now on?')) return;
    var body = { enabled: on, kinds: $('aescKinds').value, note: $('aescNote').value.trim() };
    msg('Saving…');
    fetch('/api/admin/autoescrow/settings', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'failed'); dirty = false; $('aescNote').value = ''; msg('Saved: holding ' + (j.enabled ? 'ON' : 'off') + ', ' + j.kinds.length + ' kinds.'); return load(); })
      .catch(function (e) { msg(e.message, true); });
  });
  load();
  setInterval(load, 60000);
})();
