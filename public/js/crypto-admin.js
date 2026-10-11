// public/js/crypto-admin.js — 1.99ks: /admin/crypto actions (cryptoweb.js). Same-site JSON POSTs, admins only server-side.
(function () {
  'use strict';
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); });
  }
  function msg(id, text, bad) { var m = document.getElementById(id); if (m) { m.textContent = text; m.style.color = bad ? '#ef9a9a' : '#81c784'; } }

  var form = document.getElementById('cxSettings');
  if (form) form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = { _bools: [] };
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') { body._bools.push(el.name); if (el.checked) body[el.name] = true; }
      else body[el.name] = el.value;
    });
    if (body.crypto_donations_enabled && !/crypto_donations_enabled/.test(form.getAttribute('data-was') || '') && !window.confirm('Turn crypto donations ON? Payments from linked wallets will mint PAT.')) return;
    post('/api/crypto/admin/settings', body).then(function (j) { msg('cxSetMsg', j.changed && j.changed.length ? 'Saved: ' + j.changed.join(', ') : 'No change.'); },
      function (e) { msg('cxSetMsg', e.message, true); });
  });
  if (form && form.elements.crypto_donations_enabled && form.elements.crypto_donations_enabled.checked) form.setAttribute('data-was', 'crypto_donations_enabled');

  // 1.99mn: the /support page extras (goal meter, total raised, recent supporters)
  var sps = document.getElementById('spsForm');
  if (sps) sps.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = { _bools: [] };
    Array.prototype.forEach.call(sps.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') { body._bools.push(el.name); if (el.checked) body[el.name] = true; }
      else body[el.name] = el.value;
    });
    post('/api/support/admin/settings', body).then(function (j) { msg('spsMsg', j.changed && j.changed.length ? 'Saved: ' + j.changed.join(', ') : 'No change.'); },
      function (e) { msg('spsMsg', e.message, true); });
  });

  var poll = document.getElementById('cxPoll');
  if (poll) poll.addEventListener('click', function () {
    poll.disabled = true; msg('cxPollMsg', 'Scanning…');
    post('/api/crypto/admin/poll', {}).then(function (j) { poll.disabled = false; msg('cxPollMsg', JSON.stringify(j.result)); setTimeout(function () { location.reload(); }, 2500); },
      function (e) { poll.disabled = false; msg('cxPollMsg', e.message, true); });
  });

  var dry = document.getElementById('cxDry');
  if (dry) dry.addEventListener('click', function () {
    dry.disabled = true; msg('cxDryMsg', 'Reading the chains…');
    post('/api/crypto/admin/dryrun', { blocks: Number(document.getElementById('cxBlocks').value), sigs: Number(document.getElementById('cxSigs').value) })
      .then(function (j) { dry.disabled = false; msg('cxDryMsg', 'Done (nothing written).'); document.getElementById('cxDryOut').textContent = JSON.stringify(j.result, null, 2); },
        function (e) { dry.disabled = false; msg('cxDryMsg', e.message, true); });
  });

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-cx]');
    if (!b) return;
    var action = b.getAttribute('data-cx');
    var note = window.prompt(action === 'approve' ? 'Approve and credit this payment? Optional note:' : action === 'reject' ? 'Reject (no PAT)? Reason:' : action === 'reverify' ? 'Ask the verifier RPC again? Note:' : 'Ignore (never credit)? Reason:', '');
    if (note === null) return;
    b.disabled = true;
    post('/api/crypto/admin/decide', { id: b.getAttribute('data-id'), action: action, note: note })
      .then(function (j) { b.textContent = j.status; setTimeout(function () { location.reload(); }, 800); }, function (e) { b.disabled = false; window.alert(e.message); });
  });
})();
