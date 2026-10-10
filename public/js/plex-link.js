// Edit profile → Connections → 📼 Plex — 1.99jr (plexmembers.js self-link): link a Plex account with Plex's own sign-in
// (a PIN: open Plex's page, poll until it's done, reload) or unlink it. The same endpoints as /subscriptions
// (/api/plex/link/start|check|unlink); Plex sends a no-pop-up visitor back here with ?plex=<pin>. Strings: js.subs.*.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var $ = function (id) { return document.getElementById(id); };
  function say(t, c) { var m = $('plexStatus'); if (!m) return; m.textContent = t || ''; m.className = 'status' + (c ? ' ' + c : ''); }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (d) { if (d.ok === false) throw new Error(d.error || _t('js.subs.error', 'Something went wrong.')); return d; });
  }
  function reload() {
    if (location.search) { location.href = location.pathname + '#connections'; return; }
    location.hash = 'connections';
    location.reload();
  }
  function done() {
    say(_t('js.subs.plex_done', 'Linked! Reloading…'), 'ok');
    setTimeout(reload, 900);
  }
  var polling = null;
  function poll(pin, btn, until) {
    if (polling) clearTimeout(polling);
    post('/api/plex/link/check', { pin: pin }).then(function (d) {
      if (d.done) return done();
      if (Date.now() > until) { say(_t('js.subs.plex_expired', 'The Plex sign-in expired - try again.'), 'err'); if (btn) btn.disabled = false; return; }
      polling = setTimeout(function () { poll(pin, btn, until); }, 2500);
    }).catch(function (e) { say(e.message, 'err'); if (btn) btn.disabled = false; });
  }
  function link(btn) {
    btn.disabled = true;
    var w = null;                  // opened straight from the click (pop-up blockers), then pointed at Plex
    try { w = window.open('about:blank', 'plexauth', 'width=520,height=720'); } catch (e) { w = null; }
    post('/api/plex/link/start', { back: btn.getAttribute('data-back') || '' }).then(function (d) {
      if (w && !w.closed) { w.location.href = d.url; say(_t('js.subs.plex_wait', 'Finish signing in to Plex in the window that opened - this page updates by itself.')); poll(d.pin, btn, Date.now() + 14 * 60000); }
      else location.href = d.url;
    }).catch(function (e) { if (w) try { w.close(); } catch (x) { /* gone */ } btn.disabled = false; say(e.message, 'err'); });
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button');
    if (!b) return;
    var id = b.getAttribute('data-plex-unlink');
    if (id) {
      if (!confirm(_t('js.subs.q_unlink', 'Unlink this Plex account from your PATV account?'))) return;
      b.disabled = true;
      say(_t('js.subs.working', 'Working…'));
      post('/api/plex/link/unlink', { plex_id: id }).then(function () { say(_t('js.subs.done', 'Done.'), 'ok'); setTimeout(reload, 700); })
        .catch(function (e) { b.disabled = false; say(e.message, 'err'); });
    } else if (b.id === 'plexLinkBtn') {
      link(b);
    }
  });
  var lb = $('plexLinkBtn');
  var back = lb && lb.getAttribute('data-pin');
  if (back) { say(_t('js.subs.working', 'Working…')); poll(back, lb, Date.now() + 60000); }
})();
