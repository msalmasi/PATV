// admin-padfines.js — 1.99yx: /pads/admin "Pad vault fines & transfers" (views/partials/pads-admin-fines.ejs, padfines.js).
// Nonce + password step-up, then the request goes to Pepe as a website action; his answer is polled and shown.
(function () {
  'use strict';
  var form = document.getElementById('pfForm');
  if (!form) return;
  var msg = document.getElementById('pfMsg');
  var op = document.getElementById('pfOp');
  var toWrap = document.getElementById('pfToWrap');
  var log = document.getElementById('pfLog');
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var esc = function (s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; };
  var LBL = { reserve: 'Federal Reserve', fortknox: 'Fort Knox', incentives: 'incentive budget', jackpot: 'the House', heist: 'Casino vault', bank: 'Bank', mm: 'Market maker' };

  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  function key() {
    var a = new Uint8Array(9);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function sync() { toWrap.hidden = op.value !== 'transfer'; }
  op.addEventListener('change', sync);
  sync();

  function load() {
    fetch('/api/admin/padvault/moves', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) { log.innerHTML = '<tr><td colspan="6" class="muted">' + esc(j.error || 'Not available.') + '</td></tr>'; return; }
      var rt = document.getElementById('pfRoute');
      if (rt && j.route && j.route.shares) {
        rt.textContent = 'now: ' + j.route.shares.map(function (s) { return (LBL[s[0]] || s[0]) + ' ' + s[1] + '%'; }).join(', ') +
          (j.route.override ? ' (an admin override)' : ' (the default)') + '; the rest, if any, to the Federal Reserve';
      } else if (rt && j.route && j.route.unavailable) {
        // the site owns the economy settings and can't read them right now: never the default shown as the route
        rt.textContent = 'now: unknown - the economy settings can\'t be read right now (a fine waits until they can)';
      }
      if (!j.moves.length) { log.innerHTML = '<tr><td colspan="6" class="muted">None yet.</td></tr>'; return; }
      log.innerHTML = j.moves.map(function (m) {
        var what = m.op === 'fine' ? '⚖️ fine ' + esc(m.room) : '🏠 ' + esc(m.room) + ' → ' + esc(m.to);
        var st = m.status === 'done' ? '✅ done' : m.status === 'failed' ? '❌ ' + esc(m.message || 'refused') : '⏳ waiting for Pepe';
        return '<tr><td>' + esc(new Date(m.done_at || m.created).toISOString().slice(0, 16).replace('T', ' ')) + ' UTC</td><td>' + what +
          '</td><td class="num">' + fmt(m.amount) + '</td><td>' + esc(m.reason) + '</td><td>' + esc(m.actor) + '</td><td>' + st + '</td></tr>';
      }).join('');
    }).catch(function () { log.innerHTML = '<tr><td colspan="6" class="muted">Could not load.</td></tr>'; });
  }
  load();

  function poll(id, n) {
    fetch('/api/rooms/action/' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.ok && j.status && j.status !== 'pending' && j.status !== 'claimed') {
        msg.textContent = (j.status === 'done' ? '✅ ' : '❌ ') + (j.message || j.status);
        setTimeout(load, 1500);
        return;
      }
      if (n > 40) { msg.textContent = 'Sent - Pepe hasn\'t answered yet; the list below updates when he does.'; return; }
      setTimeout(function () { poll(id, n + 1); }, 2000);
    }).catch(function () { setTimeout(function () { poll(id, n + 1); }, 3000); });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var b = { op: op.value, from: form.elements.from.value, to: op.value === 'transfer' ? form.elements.to.value : '',
              amount: form.elements.amount.value, reason: form.elements.reason.value.trim(), key: key() };
    if (!b.amount || Number(b.amount) < 1) { msg.textContent = 'Enter an amount.'; return; }
    if (b.reason.length < 3) { msg.textContent = 'Give a reason - the pad owner sees it.'; return; }
    if (b.op === 'transfer' && b.from === b.to) { msg.textContent = 'Pick two different pads.'; return; }
    var what = b.op === 'fine' ? 'Fine the ' + b.from + ' pad vault ' + fmt(b.amount) + ' PAT?'
                               : 'Move ' + fmt(b.amount) + ' PAT from the ' + b.from + ' pad vault to ' + b.to + '?';
    if (!window.confirm(what + '\n\nReason: ' + b.reason)) return;
    var btn = document.getElementById('pfGo');
    btn.disabled = true;
    msg.textContent = 'Sending…';
    post('/api/admin/padvault/nonce', {}).then(function (n) {
      if (!n.ok) throw new Error(n.error || 'Not allowed.');
      b.nonce = n.nonce;
      b.password = form.elements.password.value;
      return post('/api/admin/padvault/move', b);
    }).then(function (j) {
      form.elements.password.value = '';
      if (!j.ok) { msg.textContent = j.error || 'Not sent.'; return; }
      msg.textContent = 'Sent to Pepe - waiting for his answer…';
      load();
      if (j.id) poll(j.id, 0);
    }).catch(function (err) { msg.textContent = err.message || 'Not sent.'; })
      .then(function () { btn.disabled = false; });
  });
})();
