// chatlog-reports.js - /feed/admin#chatlines (CL6, chatlogmod.js): reported pad chat lines, staff holding chatlog.read_all.
// "Read the line" fetches that one line (the server logs the read first); Dismiss / Dismiss · bad faith / Hide… / Delete for good…
// decide every open report on the line (POST /api/admin/chatlog/reports/:c {action, tell, why}). Text goes in with textContent.
(function () {
  'use strict';
  function api(c, body) {
    return fetch('/api/admin/chatlog/reports/' + encodeURIComponent(c), {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
    });
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function when(ms) { return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '?'; }
  function show(box, L) {
    box.textContent = '';
    var who = L.purged ? 'deleted' : (L.name || 'someone') + (L.login && L.login !== L.name ? ' (Camfrog ' + L.login + ')' : '');
    box.appendChild(el('div', 'mut', (L.k === 'tx' ? '🎙 Mic transcript' : 'Chat line') + ' by ' + who + ' · said ' + when(L.ts) +
      (L.removed ? ' · taken down ' + when(L.removed.at) + ' (' + L.removed.by + (L.removed.why ? ': ' + L.removed.why : '') + ')' : '')));
    var q = el('blockquote', 'fa-dm-text');
    // wave 2 (E.7, review fix A-tests-ux-06): a HIDDEN line's words aren't gone - only an admin can read them (Reveal on the pad's
    // line, logged); staff must not dismiss it as purged
    // 1.99?? (privacy controls, round 3 - F3): text reveal roles on (L.tr) - staff can reveal it on the pad too, with a reason
    q.textContent = L.needs_admin ? (L.tr ? 'Hidden line - reveal it on the pad (PATV admins, and staff with a reason; every reveal is logged)'
      : 'Hidden line - needs an admin (an admin can reveal it on the pad; every reveal is logged)')
      : L.text == null ? '(its text is gone)' : L.text;
    q.style.cssText = 'margin:8px 0;padding:10px 12px;border-inline-start:3px solid var(--ds-danger, #ff8a80);background:var(--ds-danger-bg, #1a1414);white-space:pre-wrap;overflow-wrap:anywhere;';
    box.appendChild(q);
    if (L.needs_admin && typeof L.link === 'string' && /^\/p\//.test(L.link)) {
      var a = el('a', 'mut', 'Open the line on its pad');
      a.href = L.link;
      a.rel = 'noreferrer';
      box.appendChild(a);
    }
    box.hidden = false;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-clfa]');
    if (!b) return;
    var card = b.closest('[data-cl]');
    if (!card) return;
    var c = card.getAttribute('data-cl'), act = b.getAttribute('data-clfa');
    var tell = card.querySelector('input[name="tell"]');
    if (act === 'read') {
      b.disabled = true;
      api(c, { action: 'read' }).then(function (d) { show(card.querySelector('.fa-cl-body'), d.line || {}); })
        .catch(function (x) { b.disabled = false; alert(x.message); });
      return;
    }
    var why = '';
    if (act === 'hide' || act === 'purge') {
      why = window.prompt(act === 'hide' ? 'Why hide it? (the pad’s owner and staff see the reason)' : 'Delete it for good - everywhere, can’t be undone. A note for the audit log:', '');
      if (why == null) return;
    }
    var btns = card.querySelectorAll('[data-clfa]');
    Array.prototype.forEach.call(btns, function (x) { x.disabled = true; });
    api(c, { action: act, tell: !tell || tell.checked, why: why }).then(function (d) {
      card.textContent = '';
      card.appendChild(el('p', 'mut', 'Done: ' + d.state + ' (' + d.resolved + ' report' + (d.resolved === 1 ? '' : 's') + (d.notified ? ', ' + d.notified + ' told' : '') + ').'));
    }).catch(function (x) { Array.prototype.forEach.call(btns, function (y) { y.disabled = false; }); alert(x.message); });
  });
})();
