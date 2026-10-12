// pad-owner.js — the room owner's Pepe control panel (1.99qr, views/padOwner.ejs, padowner.js):
//   * Top up the vault: POST /api/rooms/:slug/vault/topup {amount, idem} - one idem per attempt (a double click or a retry of
//     the same attempt is one deposit); then the action's status (GET /api/rooms/action/:id) until Pepe answered, then the
//     vault's numbers (GET /api/rooms/:slug/owner/state).
//   * The owner's Pepe settings (snap / clip / challenge / language): POST /api/rooms/:slug/owner/setting {key, value} - the
//     control flips back until Pepe has done it.
//   * Website-bridge switches: the existing POST /api/rooms/:slug/bridge {key, on}.
// Server / Pepe text goes in via textContent.
(function () {
  'use strict';
  var root = document.getElementById('po');
  if (!root || !root.getAttribute('data-slug')) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var slug = root.getAttribute('data-slug');
  var base = '/api/rooms/' + encodeURIComponent(slug);
  function fmt(n) { return Number(n || 0).toLocaleString(window.PATV_I18N && PATV_I18N.lang || undefined); }
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  function say(el, text, kind) { if (!el) return; el.textContent = text || ''; el.className = 'po-msg' + (kind ? ' ' + kind : ''); }
  function newKey() {
    try { if (window.crypto && crypto.randomUUID) return 'po' + crypto.randomUUID().replace(/-/g, ''); } catch (e) { /* old browser */ }
    return 'po' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  /** Poll a website action until Pepe answered -> cb(ok, message). */
  function watch(id, cb, n) {
    n = n || 0;
    api('/api/rooms/action/' + encodeURIComponent(id)).then(function (a) {
      if (a && a.ok && (a.status === 'done' || a.status === 'failed' || a.status === 'expired')) return cb(a.status === 'done', a.message || '');
      if (n > 80) return cb(null, _t('js.owner.slow', 'Pepe hasn\'t answered yet - it will happen when he does.'));
      setTimeout(function () { watch(id, cb, n + 1); }, 1500);
    }).catch(function () { setTimeout(function () { watch(id, cb, n + 1); }, 3000); });
  }
  function refresh() {
    api(base + '/owner/state').then(function (d) {
      if (!d || !d.ok || !d.vault) return;
      Array.prototype.forEach.call(document.querySelectorAll('[data-po="balance"]'), function (b) { b.textContent = fmt(d.vault.balance); });
      var amt = document.getElementById('poAmt');
      if (amt) { amt.setAttribute('data-room', Math.max(0, d.vault.cap - d.vault.balance)); amt.setAttribute('data-bal', d.balance); }
    });
  }

  // ── Top up ──
  var form = document.getElementById('poTopup');
  var amt = document.getElementById('poAmt');
  if (form && amt) {
    var msg = document.getElementById('poTopMsg');
    var go = form.querySelector('button[type="submit"]');
    var key = newKey(), lastAmt = null, busy = false, armed = null, goLabel = null;
    amt.addEventListener('input', function () { if (armed !== null) { armed = null; if (goLabel) go.textContent = goLabel; say(msg, ''); } });
    Array.prototype.forEach.call(form.querySelectorAll('[data-amt]'), function (b) {
      b.addEventListener('click', function () { amt.value = b.getAttribute('data-amt'); amt.dispatchEvent(new Event('input')); amt.focus(); amt.removeAttribute('aria-invalid'); say(msg, ''); });
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var v = parseInt(String(amt.value).replace(/[,\s.]/g, ''), 10);
      var min = Number(amt.getAttribute('data-min')) || 1000, room = Number(amt.getAttribute('data-room')) || 0, bal = Number(amt.getAttribute('data-bal')) || 0;
      var err = !(v > 0) ? _t('js.owner.amt_whole', 'Type a whole number of PAT.')
        : v < min ? _t('js.owner.amt_min', 'Top up at least {n} PAT.', { n: fmt(min) })
        : v > room ? _t('js.owner.amt_room', 'The vault can take {n} PAT more.', { n: fmt(room) })
        : v > bal ? _t('js.owner.amt_bal', 'You have {n} PAT.', { n: fmt(bal) }) : '';
      if (err) { amt.setAttribute('aria-invalid', 'true'); say(msg, err, 'bad'); amt.focus(); return; }
      amt.removeAttribute('aria-invalid');
      // the confirm step, in place: the first press asks, the second (same amount) sends
      if (armed !== v) {
        armed = v;
        goLabel = goLabel || go.textContent;
        go.textContent = _t('js.owner.topup_yes', 'Yes, deposit {n} PAT', { n: fmt(v) });
        say(msg, _t('js.owner.topup_confirm', 'Deposit {n} PAT into the pad vault? Deposits can\'t be taken back out, and they never count as the pad\'s income.', { n: fmt(v) }));
        return;
      }
      armed = null; go.textContent = goLabel;
      if (lastAmt !== null && lastAmt !== v) key = newKey();           // a new amount is a new attempt
      lastAmt = v;
      busy = true; go.disabled = true; go.setAttribute('aria-busy', 'true');
      say(msg, _t('js.owner.topup_sending', 'Sending to Pepe…'));
      api(base + '/vault/topup', { amount: v, idem: key }).then(function (d) {
        if (!d || !d.ok) { busy = false; go.disabled = false; go.removeAttribute('aria-busy'); return say(msg, (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
        say(msg, _t('js.owner.topup_waiting', 'Pepe is moving it…'));
        watch(d.id, function (ok, m) {
          busy = false; go.disabled = false; go.removeAttribute('aria-busy');
          key = newKey(); lastAmt = null;                             // done: the next one is a new deposit
          say(msg, m || (ok ? _t('js.owner.topup_done', 'Deposited.') : _t('js.owner.refused', 'Pepe refused it.')), ok ? 'ok' : ok === false ? 'bad' : '');
          if (ok) { amt.value = ''; refresh(); }
        });
      }).catch(function () { busy = false; go.disabled = false; go.removeAttribute('aria-busy'); say(msg, _t('js.owner.unreachable', 'Couldn\'t reach the site - try again (it won\'t be charged twice).'), 'bad'); });
    });
  }

  // ── the owner's Pepe settings ──
  var setMsg = document.getElementById('poSetMsg');
  Array.prototype.forEach.call(document.querySelectorAll('[data-po-set]'), function (c) {
    var k = c.getAttribute('data-po-set');
    var cur = c.type === 'checkbox' ? c.checked : c.value;
    c.addEventListener('change', function () {
      var want = c.type === 'checkbox' ? c.checked : c.value;
      var value = c.type === 'checkbox' ? (want ? 'on' : 'off') : want;
      if (c.type === 'checkbox') c.checked = cur; else c.value = cur;   // only changes once Pepe has done it
      c.disabled = true;
      say(setMsg, _t('js.owner.set_sending', 'Asking Pepe…'));
      api(base + '/owner/setting', { key: k, value: value }).then(function (d) {
        if (!d || !d.ok) { c.disabled = false; return say(setMsg, (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
        watch(d.id, function (ok, m) {
          c.disabled = false;
          if (ok) { cur = want; if (c.type === 'checkbox') c.checked = want; else c.value = want; }
          say(setMsg, m || (ok ? _t('js.owner.saved', 'Done.') : _t('js.owner.refused', 'Pepe refused it.')), ok ? 'ok' : ok === false ? 'bad' : '');
        });
      }).catch(function () { c.disabled = false; say(setMsg, _t('js.owner.unreachable_set', 'Couldn\'t reach the site.'), 'bad'); });
    });
  });

  // ── website-bridge switches (the existing owner endpoint) ──
  var brMsg = document.getElementById('poBrMsg');
  Array.prototype.forEach.call(document.querySelectorAll('[data-po-bridge]'), function (c) {
    var k = c.getAttribute('data-po-bridge');
    c.addEventListener('change', function () {
      var want = c.checked;
      c.checked = !want; c.disabled = true;
      say(brMsg, _t('js.owner.set_sending', 'Asking Pepe…'));
      api(base + '/bridge', { key: k, on: want }).then(function (d) {
        if (!d || !d.ok) { c.disabled = false; return say(brMsg, (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
        watch(d.id, function (ok, m) {
          c.disabled = false;
          if (ok) c.checked = want;
          say(brMsg, m || (ok ? _t('js.owner.saved', 'Done.') : _t('js.owner.refused', 'Pepe refused it.')), ok ? 'ok' : ok === false ? 'bad' : '');
        });
      }).catch(function () { c.disabled = false; say(brMsg, _t('js.owner.unreachable_set', 'Couldn\'t reach the site.'), 'bad'); });
    });
  });
})();
