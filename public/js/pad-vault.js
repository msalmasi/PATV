// pad-vault.js - the 💰 Pad vault card on a pad's About tab (views/partials/pad-vault-card.ejs; roomvaults.js on the server).
//   * 1.99sn: "Donate to this pad's vault" - any signed-in account. POST /api/rooms/:slug/vault/donate {amount, idem, anon}:
//     one idem per attempt (a double click or a retry of the same attempt is one donation), a confirm step in place (the
//     first press asks, the second - same amount - sends), then the action's status (GET /api/rooms/action/:id) until Pepe
//     answered. Pepe re-checks the minimum, the cap and the balance under his escrow.
//   * The pad owner's daily payout rate: POST /api/rooms/:slug/vault/rate {rate} (2-15%, once a week).
// Server / Pepe text goes in via textContent.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function fmt(n) { return Number(n || 0).toLocaleString(window.PATV_I18N && PATV_I18N.lang || undefined); }
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  function newKey() {
    try { if (window.crypto && crypto.randomUUID) return 'pv' + crypto.randomUUID().replace(/-/g, ''); } catch (e) { /* old browser */ }
    return 'pv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function watch(id, cb, n) {
    n = n || 0;
    api('/api/rooms/action/' + encodeURIComponent(id)).then(function (a) {
      if (a && a.ok && (a.status === 'done' || a.status === 'failed' || a.status === 'expired')) return cb(a.status === 'done', a.message || '');
      if (n > 80) return cb(null, _t('js.padvault.slow', 'Pepe hasn\'t answered yet - it will happen when he does.'));
      setTimeout(function () { watch(id, cb, n + 1); }, 1500);
    }).catch(function () { setTimeout(function () { watch(id, cb, n + 1); }, 3000); });
  }

  // ── Donate ──
  var form = document.getElementById('rvDonate');
  var amt = document.getElementById('rvAmt');
  if (form && amt) {
    var slug = form.getAttribute('data-slug');
    var msg = document.getElementById('rvDonateMsg');
    var go = form.querySelector('button[type="submit"]');
    var lbl = go.querySelector('.lbl') || go;
    var goLabel = lbl.textContent;
    var anon = document.getElementById('rvAnon');
    var key = newKey(), last = null, busy = false, armed = null;
    var say = function (t, kind) { msg.textContent = t || ''; msg.className = 'rv-msg' + (kind ? ' ' + kind : ''); };
    var disarm = function () { if (armed !== null) { armed = null; lbl.textContent = goLabel; say(''); } };
    amt.addEventListener('input', disarm);
    if (anon) anon.addEventListener('change', disarm);
    Array.prototype.forEach.call(form.querySelectorAll('[data-amt]'), function (b) {
      b.addEventListener('click', function () { amt.value = b.getAttribute('data-amt'); disarm(); amt.removeAttribute('aria-invalid'); amt.focus(); });
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var v = parseInt(String(amt.value).replace(/[,\s.]/g, ''), 10);
      var min = Number(amt.getAttribute('data-min')) || 1000, room = Number(amt.getAttribute('data-room')) || 0, bal = Number(amt.getAttribute('data-bal')) || 0;
      var err = !(v > 0) ? _t('js.padvault.amt_whole', 'Type a whole number of PAT.')
        : v < min ? _t('js.padvault.amt_min', 'Donate at least {n} PAT.', { n: fmt(min) })
        : v > room ? _t('js.padvault.amt_room', 'The vault can take {n} PAT more.', { n: fmt(room) })
        : v > bal ? _t('js.padvault.amt_bal', 'You have {n} PAT.', { n: fmt(bal) }) : '';
      if (err) { amt.setAttribute('aria-invalid', 'true'); say(err, 'err'); amt.focus(); return; }
      amt.removeAttribute('aria-invalid');
      var an = !!(anon && anon.checked);
      if (armed !== v) {                                        // the confirm step: ask first
        armed = v;
        lbl.textContent = _t('js.padvault.yes', 'Yes, donate {n} PAT', { n: fmt(v) });
        say(_t('js.padvault.confirm', 'Donate {n} PAT to this pad\'s vault? A donation can\'t be taken back.', { n: fmt(v) }), 'ask');
        return;
      }
      armed = null; lbl.textContent = goLabel;
      var sig = v + (an ? 'a' : '');
      if (last !== null && last !== sig) key = newKey();        // a new amount / choice is a new attempt
      last = sig;
      busy = true; go.disabled = true; go.setAttribute('aria-busy', 'true');
      say(_t('js.padvault.sending', 'Sending to Pepe…'));
      var done = function () { busy = false; go.disabled = false; go.removeAttribute('aria-busy'); };
      api('/api/rooms/' + encodeURIComponent(slug) + '/vault/donate', { amount: v, idem: key, anon: an }).then(function (d) {
        if (!d || !d.ok) { done(); return say((d && d.error) || _t('js.padvault.not_sent', 'Not sent.'), 'err'); }
        say(_t('js.padvault.waiting', 'Pepe is moving it…'));
        if (!d.id) { done(); return; }
        watch(d.id, function (ok, m) {
          done();
          key = newKey(); last = null;                          // finished: the next one is a new donation
          say(m || (ok ? _t('js.padvault.done', 'Thank you! It\'s in the vault.') : _t('js.padvault.refused', 'Pepe refused it.')), ok === false ? 'err' : '');
          if (ok) {
            amt.value = '';
            amt.setAttribute('data-room', Math.max(0, room - v));
            amt.setAttribute('data-bal', Math.max(0, bal - v));
            var b = document.querySelector('[data-rv="balance"]');
            if (b) b.textContent = fmt(Number(String(b.textContent).replace(/[^0-9]/g, '')) + v);
          }
        });
      }).catch(function () { done(); say(_t('js.padvault.unreachable', 'Couldn\'t reach the site - try again (it won\'t be charged twice).'), 'err'); });
    });
  }

  // ── the owner's daily payout rate ──
  var rform = document.getElementById('rvRate');
  if (!rform) return;
  var rslug = rform.getAttribute('data-slug');
  var input = rform.querySelector('input[name="rate"]');
  var submit = rform.querySelector('button[type="submit"]');
  var rmsg = document.getElementById('rvRateMsg');
  var rbusy = false;
  function rsay(t, err) { rmsg.textContent = t || ''; rmsg.className = 'rv-msg' + (err ? ' err' : ''); }
  rform.addEventListener('submit', function (e) {
    e.preventDefault();
    if (rbusy) return;
    var rate = Number(input.value);
    if (!(rate > 0)) { rsay('Pick a rate.', true); return; }
    rbusy = true; submit.disabled = true; rsay('Saving...');
    fetch('/api/rooms/' + encodeURIComponent(rslug) + '/vault/rate', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rate: rate })
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Unexpected answer from the site.' }; }); })
      .then(function (d) {
        if (!d || !d.ok) { rsay((d && d.error) || 'Not saved.', true); return; }
        input.value = d.rate;
        var v = d.vault || {};
        if (v.rate_locked_until) { input.disabled = true; submit.disabled = true; }
        rsay(d.changed ? 'Saved: ' + d.rate + '% a day, used when payouts start. You can change it again in a week.'
                       : 'That is already the rate.');
      })
      .catch(function () { rsay('Couldn\'t reach the site - try again.', true); })
      .then(function () { rbusy = false; if (!input.disabled) submit.disabled = false; });
  });
})();
