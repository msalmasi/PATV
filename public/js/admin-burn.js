// admin-burn.js (1.99dk) - the admin Economy page's 🔥 Burn reserve card (burns.js on the server).
// Preview -> single-use nonce -> account password (step-up) -> Pepe runs it as website action "econ.burn".
(function () {
  'use strict';
  var box = document.getElementById('burnAdm');
  if (!box) return;
  var csrf = box.getAttribute('data-csrf');
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return n == null ? '—' : Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var view = null, pending = null, nonce = null;
  function msg(t, bad) { var m = $('burnMsg'); m.textContent = t || ''; m.style.color = bad ? '#ef5350' : ''; }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: { 'x-csrf-token': csrf } };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'failed'); return j; }); });
  }
  function kv(label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); return d; }
  function render() {
    var p = view.pepe || {}, c = p.cfg || {}, rc = view.reconcile || {}, st = view.burned || {};
    var k = $('burnKv'); k.textContent = '';
    k.appendChild(kv('Burn reserve (from Pepe)', view.pepe ? fmt(p.reserve) + ' PAT' : 'not synced yet'));
    k.appendChild(kv('Mode', c.mode ? (c.mode === 'accrual' ? 'burn on accrual (every ' + c.accrual_every_min + ' min)' : 'batch (held for an admin)') : '—'));
    k.appendChild(kv('Can burn now', view.pepe ? fmt(p.max_now) + ' PAT' : '—'));
    k.appendChild(kv('Caps (manual)', c.per_burn_max != null ? fmt(c.per_burn_max) + ' per burn · ' + fmt(c.daily_max) + ' per 24 h' : '—'));
    k.appendChild(kv('Total burned (public log)', fmt(st.total) + ' PAT · 7d ' + fmt(st.d7) + ' · 30d ' + fmt(st.d30)));
    k.appendChild(kv('Reconcile', rc.ok == null ? 'Pepe not synced' : rc.ok ? 'Pepe and the log agree (' + fmt(rc.site) + ')' : 'Pepe ' + fmt(rc.pepe) + ' vs log ' + fmt(rc.site) + (rc.note ? ' - ' + rc.note : '')));
    var rows = $('burnRows'); rows.textContent = '';
    (view.log || []).forEach(function (r) {
      var tr = document.createElement('tr');
      [new Date(r.at).toISOString().slice(0, 16).replace('T', ' '), fmt(r.amount), r.reason || '', (r.actor_kind || '') + (r.actor ? ': ' + r.actor : '')].forEach(function (t, i) {
        var td = document.createElement('td'); td.textContent = t; if (i === 1) td.className = 'num'; tr.appendChild(td);
      });
      rows.appendChild(tr);
    });
    if (!(view.log || []).length) { var tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 4; td.className = 'empty'; td.textContent = 'No burns yet.'; tr.appendChild(td); rows.appendChild(tr); }
  }
  function load() { return api('/api/admin/burn').then(function (j) { view = j; render(); }).catch(function (e) { msg(e.message, true); }); }
  function cancel() { pending = null; nonce = null; $('burnConfirm').hidden = true; $('burnPw').value = ''; }
  $('burnForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    cancel();
    var amt = Math.floor(Number($('burnAmt').value) || 0);
    if (amt <= 0) { msg('Enter a positive amount.', true); return; }
    load().then(function () {
      var supply = null;
      return fetch('/api/stats/supply', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) { supply = s && s.total; }).catch(function () {}).then(function () {
        var max = view.pepe ? Number(view.pepe.max_now) || 0 : 0;
        if (amt > max) { msg('Pepe allows at most ' + fmt(max) + ' PAT right now.', true); return; }
        pending = { amount: amt, reason: $('burnWhy').value };
        $('burnWhat').textContent = 'Burn ' + fmt(amt) + ' PAT from the burn reserve for good. Total supply ' +
          (supply == null ? '(unavailable)' : fmt(supply) + ' -> ' + fmt(supply - amt)) + '. This cannot be undone.';
        $('burnConfirm').hidden = false;
        msg('');
        return api('/api/admin/burn/nonce', {}).then(function (j) { nonce = j.nonce; $('burnPw').focus(); });
      });
    }).catch(function (e) { msg(e.message, true); cancel(); });
  });
  $('burnNo').addEventListener('click', function () { cancel(); msg('Cancelled - nothing burned.'); });
  $('burnYes').addEventListener('click', function () {
    if (!pending || !nonce) { msg('Start again.', true); return; }
    var body = { amount: pending.amount, reason: pending.reason, nonce: nonce, password: $('burnPw').value };
    cancel();
    msg('Sending to Pepe…');
    api('/api/admin/burn', body).then(function (j) {
      var id = j.request.id, tries = 0;
      (function poll() {
        api('/api/admin/burn/' + id).then(function (a) {
          var s = a.action.status;
          if (s === 'done' || s === 'failed') { msg(a.action.message || s, s === 'failed'); load(); return; }
          if (++tries > 40) { msg('Queued for Pepe (#' + id + ') - he will run it when he is online.'); return; }
          msg('Waiting for Pepe… (' + s + ')');
          setTimeout(poll, 3000);
        }).catch(function (e) { msg(e.message, true); });
      })();
    }).catch(function (e) { msg(e.message, true); });
  });
  load();
})();
