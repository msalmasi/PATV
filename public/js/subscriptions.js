// /settings/subscriptions — 1.99jp (subscriptions.js, plexmembers.js): cancel / resume / pay now, Prime Time & Season Pass
// auto-renew, subscribe, and linking a Plex account with Plex's own sign-in (a PIN: we open Plex's page, poll until it's
// done, then reload). Every string goes through __t (js.subs.*).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var $ = function (id) { return document.getElementById(id); };
  function say(t, c) { var m = $('sxMsg'); if (!m) return; m.textContent = t || ''; m.className = 'msg' + (c ? ' ' + c : ''); }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (d) { if (d.ok === false || d.success === false) throw new Error(d.error || d.message || _t('js.subs.error', 'Something went wrong.')); return d; });
  }
  function run(btn, p, okText) {
    btn.disabled = true;
    say(_t('js.subs.working', 'Working…'));
    p.then(function (d) { say(okText || (d && d.message) || _t('js.subs.done', 'Done.'), 'ok'); setTimeout(function () { location.reload(); }, 900); })
      .catch(function (e) { btn.disabled = false; say(e.message, 'bad'); });
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    var id;
    if ((id = b.getAttribute('data-cancel'))) {
      if (!confirm(_t('js.subs.q_cancel', 'Cancel {title}? You keep it until {date} and won’t be charged again.', { title: b.getAttribute('data-title'), date: b.getAttribute('data-date') }))) return;
      run(b, post('/api/subscriptions/' + encodeURIComponent(id) + '/cancel'));
    } else if ((id = b.getAttribute('data-resume'))) {
      run(b, post('/api/subscriptions/' + encodeURIComponent(id) + '/resume'));
    } else if ((id = b.getAttribute('data-pay'))) {
      run(b, post('/api/subscriptions/' + encodeURIComponent(id) + '/pay'));
    } else if ((id = b.getAttribute('data-start'))) {
      var price = Number(b.getAttribute('data-price'));
      if (!confirm(_t('js.subs.q_sub', 'Subscribe to {title} for {price} PAT every {days} days? The first period is charged now; cancel any time.',
        { title: '"' + b.getAttribute('data-title') + '"', price: price.toLocaleString(), days: b.getAttribute('data-days') }))) return;
      run(b, post('/api/subscriptions/start', { product: id, price: price }));
    } else if (b.hasAttribute('data-prem')) {
      var on = b.getAttribute('data-on') === '1';
      if (!on && !confirm(_t('js.subs.q_prem_off', 'Stop auto-renew? It stays on until its paid date.'))) return;
      run(b, post('/api/subscriptions/premium', { tier: b.getAttribute('data-prem'), pad: b.getAttribute('data-pad') || undefined, on: on }));
    } else if ((id = b.getAttribute('data-unlink'))) {
      if (!confirm(_t('js.subs.q_unlink', 'Unlink this Plex account from your PATV account?'))) return;
      run(b, post('/api/plex/link/unlink', { plex_id: id }));
    } else if (b.id === 'sxLink') {
      linkPlex(b);
    }
  });

  // ── Plex sign-in (PIN) ──
  var polling = null;
  function poll(pin, btn, until) {
    if (polling) clearTimeout(polling);
    post('/api/plex/link/check', { pin: pin }).then(function (d) {
      if (d.done) { say(_t('js.subs.plex_done', 'Linked! Reloading…'), 'ok'); setTimeout(function () { location.href = '/settings/subscriptions#plex'; }, 900); return; }
      if (Date.now() > until) { say(_t('js.subs.plex_expired', 'The Plex sign-in expired - try again.'), 'bad'); if (btn) btn.disabled = false; return; }
      polling = setTimeout(function () { poll(pin, btn, until); }, 2500);
    }).catch(function (e) { say(e.message, 'bad'); if (btn) btn.disabled = false; });
  }
  function linkPlex(btn) {
    btn.disabled = true;
    // open the window first (pop-up blockers allow it only straight from the click), then point it at Plex
    var w = null;
    try { w = window.open('about:blank', 'plexauth', 'width=520,height=720'); } catch (e) { w = null; }
    post('/api/plex/link/start').then(function (d) {
      try { sessionStorage.setItem('patvPlexPin', d.pin); } catch (e) { /* private mode */ }
      if (w && !w.closed) { w.location.href = d.url; say(_t('js.subs.plex_wait', 'Finish signing in to Plex in the window that opened - this page updates by itself.')); poll(d.pin, btn, Date.now() + 14 * 60000); }
      else location.href = d.url;                       // no pop-up: Plex sends them back here (?plex=<pin>)
    }).catch(function (e) { if (w) try { w.close(); } catch (x) { /* gone */ } btn.disabled = false; say(e.message, 'bad'); });
  }
  // back from Plex's page (no pop-up): finish the link
  var lb = $('sxLink');
  var back = lb && lb.getAttribute('data-pin');
  if (back) { say(_t('js.subs.working', 'Working…')); poll(back, lb, Date.now() + 60000); }
})();
