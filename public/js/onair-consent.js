// onair-consent.js — 📺 the owner's on-demand OK for Pepe's main stream (1.99aag, onairconsent.js on the server).
//   * /onair/consent/<id>: the buttons in .oac-box[data-oac]
//   * the pad page (owners / staff): polls GET /api/onair/consent/mine every 20 s while the tab is visible and shows a
//     floating prompt for a pending ask (one tap: Allow this time · Allow for 6 hours · Deny, + "always")
//   * the pad's settings → Stage: #oaPadAllow[data-pad] = "always allow for my pad" (revocable)
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(text, cls) { var b = el('button', 'ds-btn sm' + (cls ? ' ' + cls : ''), text); b.type = 'button'; return b; }

  // the answer buttons for one ask, inside `box`; done(msg) when answered
  function answerRow(box, a, done) {
    var row = el('div', 'oac-row');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px';
    var always = el('label', 'oac-always');
    var cb = el('input'); cb.type = 'checkbox';
    always.appendChild(cb);
    always.appendChild(document.createTextNode(' ' + (a.kind === 'pad' ? _t('js.oac.always_pad', 'Always allow for my pad') : _t('js.oac.always_cam', 'Always allow my cam'))));
    var msg = el('span', 'oac-msg');
    function go(answer) {
      var ans = answer !== 'deny' && cb.checked ? 'always' : answer;
      [].forEach.call(row.querySelectorAll('button'), function (b) { b.disabled = true; });
      post('/api/onair/consent/' + encodeURIComponent(a.id), { answer: ans }).then(function (j) {
        if (!j || !j.ok) { msg.textContent = (j && j.error) || _t('js.oac.failed', 'That didn\'t work - try again.'); [].forEach.call(row.querySelectorAll('button'), function (b) { b.disabled = false; }); return; }
        done(ans === 'deny' ? _t('js.oac.denied', 'Denied - it stays off.') : _t('js.oac.allowed', 'Allowed - it goes on air now.'));
      });
    }
    var b1 = btn(_t('js.oac.once', 'Allow this time'), 'gold'); b1.addEventListener('click', function () { go('once'); });
    var b2 = btn(_t('js.oac.session', 'Allow for 6 hours')); b2.addEventListener('click', function () { go('session'); });
    var b3 = btn(_t('js.oac.deny', 'Deny')); b3.addEventListener('click', function () { go('deny'); });
    row.appendChild(b1); row.appendChild(b2); row.appendChild(b3); row.appendChild(always); row.appendChild(msg);
    box.appendChild(row);
  }

  // 1) the consent page
  var page = document.querySelector('.oac-box[data-oac]');
  if (page) {
    answerRow(page, { id: page.getAttribute('data-oac'), kind: page.getAttribute('data-kind') }, function (m) { page.textContent = m; });
    return;
  }

  // 2) the pad settings' "always allow"
  var pa = document.getElementById('oaPadAllow');
  if (pa && pa.getAttribute('data-pad')) {
    var pad = pa.getAttribute('data-pad');
    var lab = el('label', 'fld chk ds-check'), cb = el('input'), st = el('p', 'muted');
    cb.type = 'checkbox';
    lab.appendChild(cb); lab.appendChild(el('span', null, ' ' + _t('js.oac.pad_always', 'Admins may put this pad\'s streams on Pepe\'s main stream without asking each time')));
    pa.appendChild(lab); pa.appendChild(st);
    var paint = function (on) { cb.checked = !!on; st.textContent = on ? _t('js.oac.pad_on', 'On - admins can put this pad’s streams on Pepe’s main stream. Untick to revoke.') : _t('js.oac.pad_off', 'Off - you’re asked every time (an instant request you can allow or deny).'); };
    fetch('/api/onair/pad-allow/' + encodeURIComponent(pad), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) paint(j.always); else pa.hidden = true; }).catch(function () { pa.hidden = true; });
    cb.addEventListener('change', function () {
      cb.disabled = true;
      post('/api/onair/pad-allow/' + encodeURIComponent(pad), { always: cb.checked }).then(function (j) {
        cb.disabled = false;
        if (j && j.ok) paint(j.always); else { cb.checked = !cb.checked; st.textContent = (j && j.error) || _t('js.oac.failed', 'That didn\'t work - try again.'); }
      });
    });
  }

  // 3) the pad page prompt (owners / staff online)
  if (!document.getElementById('oacPromptOn')) return;
  var shown = {}, card = null;
  function prompt(a) {
    if (card) card.remove();
    card = el('div', 'oac-pop');
    card.setAttribute('role', 'alertdialog');
    card.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:min(420px,calc(100vw - 32px));background:var(--card,#151515);' +
      'color:var(--ds-text,#eee);border:1px solid var(--ds-line-strong,#444);border-radius:14px;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    var left = Math.max(1, Math.round((a.expires - Date.now()) / 60000));
    card.appendChild(el('b', null, '📺 ' + (a.kind === 'pad' ? _t('js.oac.prompt_pad', 'An admin wants a stream from your pad on Pepe\'s main stream:') : _t('js.oac.prompt_cam', 'An admin wants your cam on Pepe\'s main stream:'))));
    card.appendChild(el('div', null, a.label + ' · ' + _t('js.oac.left', '{n} min left', { n: left })));
    answerRow(card, a, function (m) { card.textContent = m; setTimeout(function () { if (card) card.remove(); card = null; }, 4000); });
    document.body.appendChild(card);
  }
  function poll() {
    if (document.hidden) return;
    fetch('/api/onair/consent/mine', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var a = j && j.asks && j.asks[0];
      if (a && !shown[a.id]) { shown[a.id] = 1; prompt(a); }
    }).catch(function () { /* next time */ });
  }
  poll();
  setInterval(poll, 20000);
})();
