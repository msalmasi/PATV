// admin-oracle.js - 1.99uc: /admin/oracle (views/admin/oracle.ejs, oracleadmin.js).
//  - the dispute-window countdowns (.oa-cd[data-until] in ms)
//  - the actions: an in-page confirm dialog (#oaModal, the .ds-scrim.sheet recipe - no confirm()), then
//    POST /api/admin/oracle/act with ONE idempotency key per opened dialog (a double click or a network retry is one action)
// Everything user-visible goes in with textContent; the dialog's text is rendered (escaped) by the server.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ── countdowns ──
  var cds = Array.prototype.slice.call(document.querySelectorAll('.oa-cd[data-until]'));
  function tickCd() {
    var now = Date.now();
    cds.forEach(function (el) {
      var s = Math.round((Number(el.getAttribute('data-until')) - now) / 1000), txt;
      if (s <= 0) txt = el.getAttribute('data-closed') || _t('js.oadm.closed', 'window over');
      else if (s >= 86400) txt = _t('js.oadm.dur_dh', '{d}d {h}h', { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600) });
      else if (s >= 3600) txt = _t('js.oadm.dur_hm', '{h}h {m}m', { h: Math.floor(s / 3600), m: pad(Math.floor(s % 3600 / 60)) });
      else txt = _t('js.oadm.dur_ms', '{m}m {s}s', { m: Math.floor(s / 60), s: pad(s % 60) });
      if (el.textContent !== txt) el.textContent = txt;
    });
  }
  if (cds.length) { tickCd(); setInterval(tickCd, 1000); }

  // ── actions ──
  var card = document.getElementById('proposal');
  var scrim = document.getElementById('oaModal');
  if (!card || !scrim) return;
  var key = card.getAttribute('data-key');
  var form = document.getElementById('oaForm');
  var head = document.getElementById('oaModalH');
  var err = document.getElementById('oaErr');
  var go = document.getElementById('oaGo');
  var reason = document.getElementById('oaReason');
  var outcome = document.getElementById('oaOutcome');
  var minutes = document.getElementById('oaMinutes');
  var NEED_REASON = { override: 1, 'void': 1 };
  var cur = null, opener = null, busy = false;

  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 40);
  }
  function toast(msg) {
    var box = document.getElementById('oaToasts');
    if (!box) return;
    var el = document.createElement('div'); el.className = 'ds-toast'; el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
  }
  function open(btn) {
    var action = btn.getAttribute('data-oa-action');
    cur = { action: action, login: btn.getAttribute('data-login') || '', idem: newKey() };
    opener = btn;
    var title = '';
    scrim.querySelectorAll('[data-for]').forEach(function (el) {
      var on = el.getAttribute('data-for') === action;
      el.hidden = !on;
      if (on && el.getAttribute('data-title')) title = el.getAttribute('data-title');
    });
    head.textContent = title + (cur.login ? ' · ' + cur.login : '');
    var req = !!NEED_REASON[action];
    scrim.querySelector('[data-reason-req]').hidden = !req;
    scrim.querySelector('[data-reason-opt]').hidden = req;
    reason.required = req;
    reason.value = '';
    if (outcome) outcome.value = '';
    err.textContent = '';
    go.disabled = false;
    go.className = 'ds-btn' + (action === 'void' ? ' danger' : '');
    scrim.hidden = false;
    document.addEventListener('keydown', onKey);
    setTimeout(function () { (action === 'override' && outcome ? outcome : action === 'extend' && minutes ? minutes : reason).focus(); }, 0);
  }
  function close() {
    if (busy) return;
    scrim.hidden = true;
    document.removeEventListener('keydown', onKey);
    if (opener) opener.focus();
    cur = null;
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.querySelectorAll('[data-oa-action]').forEach(function (b) { b.addEventListener('click', function () { if (!b.disabled) open(b); }); });
  scrim.querySelectorAll('[data-oa-close]').forEach(function (b) { b.addEventListener('click', close); });
  scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!cur || busy) return;
    var why = reason.value.trim();
    if (NEED_REASON[cur.action] && why.length < 4) { err.textContent = _t('js.oadm.need_reason', 'Say why (a few words).'); reason.focus(); return; }
    if (cur.action === 'override' && outcome && !outcome.value.trim()) { err.textContent = _t('js.oadm.need_outcome', 'Pick the outcome.'); outcome.focus(); return; }
    var body = { key: key, action: cur.action, idem: cur.idem, reason: why };
    if (cur.action === 'override') body.outcome = outcome.value.trim();
    if (cur.action === 'extend') body.minutes = Number(minutes.value);
    if (cur.action === 'reject_dispute') body.login = cur.login;
    busy = true; go.disabled = true; err.textContent = '';
    fetch('/api/admin/oracle/act', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (j) {
        busy = false;
        if (!j || !j.ok) { go.disabled = false; err.textContent = (j && j.error) || _t('js.oadm.failed', 'That did not work - nothing changed.'); return; }
        close();
        toast(_t('js.oadm.done', 'Done.'));
        setTimeout(function () { location.reload(); }, 700);
      })
      .catch(function () { busy = false; go.disabled = false; err.textContent = _t('js.oadm.network', 'No answer from the site - try again (it will not run twice).'); });
  });
})();
