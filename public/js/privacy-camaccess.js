// /settings/privacy - 📡 who can watch my cam (1.99aar, camaccess.js): the mode, "others can ask me", the requests waiting
// for an answer (Allow this time / Always / No) and the "always allowed" list. GET / POST /api/privacy/camviewers (the
// same endpoint as the blocks card). The off switch above (privacy-livecam.js) still wins: while it's off this is hidden.
(function () {
  'use strict';
  var box = document.getElementById('pvCa');
  if (!box) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var mode = document.getElementById('pvCaMode'), ask = document.getElementById('pvCaAsk'), askRow = document.getElementById('pvCaAskRow');
  var st = document.getElementById('pvCaSt'), asksBox = document.getElementById('pvCaAsks'), asksList = document.getElementById('pvCaAskList');
  var allowList = document.getElementById('pvCaAllow'), add = document.getElementById('pvCaAdd'), off = document.getElementById('pvLc');
  var timer = null;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function say(text, kind) { st.textContent = text || ''; st.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  function post(body) {
    return fetch('/api/privacy/camviewers', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body) }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function meaning(m, a) {
    if (m === 'everyone') return _t('js.ca.st_everyone', 'Every signed-in member can watch.');
    var who = m === 'members' ? _t('js.ca.st_members', 'Verified members can watch') : m === 'followers' ? _t('js.ca.st_followers', 'Your followers can watch')
      : _t('js.ca.st_request', 'Only people you say yes to can watch');
    var rest = m === 'request' || a ? _t('js.ca.st_ask', 'anyone else can ask - Pepe tells you in Camfrog and it shows here.') : _t('js.ca.st_noask', 'nobody else can.');
    return who + ' (+ your "always" list); ' + rest;
  }
  function paint(d) {
    if (!d || !d.access) return;
    mode.value = d.access.mode;
    ask.checked = !!d.access.ask;
    askRow.hidden = d.access.mode === 'everyone' || d.access.mode === 'request';
    say(meaning(d.access.mode, d.access.ask));
    var asks = d.asks || [];
    asksBox.hidden = !asks.length;
    asksList.textContent = '';
    asks.forEach(function (r) {
      var li = el('li'), name = el('span', '', r.display && r.display !== r.username ? r.display + ' (' + r.username + ')' : r.username);
      var acts = el('span');
      [['once', _t('js.ca.once', 'Allow (6 h)')], ['always', _t('js.ca.always', 'Always')], ['no', _t('js.ca.no', 'No')]].forEach(function (x) {
        var b = el('button', 'ds-btn sm', x[1]); b.type = 'button';
        b.addEventListener('click', function () { act({ op: 'answer', target: r.id, how: x[0] }); });
        acts.appendChild(b);
      });
      li.appendChild(name); li.appendChild(acts); asksList.appendChild(li);
    });
    allowList.textContent = '';
    var list = d.allow || [];
    if (!list.length) allowList.appendChild(el('li', '', _t('js.ca.none', 'Nobody yet.')));
    list.forEach(function (u) {
      var li = el('li'), b = el('button', 'ds-btn sm', _t('js.ca.remove', 'Remove')); b.type = 'button';
      b.addEventListener('click', function () { act({ op: 'disallow', target: u.username || ('u:' + u.userId) }); });
      li.appendChild(el('span', '', u.username || u.userId)); li.appendChild(b); allowList.appendChild(li);
    });
  }
  function act(body) {
    say(_t('js.lc.saving', 'Saving…'), 'wait');
    return post(body).then(function (d) {
      if (!d || !d.ok) { say((d && d.error) || _t('js.lc.failed', 'Not saved - try again.'), 'bad'); return d; }
      paint(d);
      if (d.ended) say(_t('js.ca.ended', 'Saved - {n} live viewer(s) who no longer qualify were cut off.', { n: d.ended }), 'ok');
      return d;
    }).catch(function () { say(_t('js.lc.failed', 'Not saved - try again.'), 'bad'); });
  }
  function load() {
    return fetch('/api/privacy/camviewers', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok && d.linked) paint(d); }).catch(function () { /* the next look */ });
  }
  mode.addEventListener('change', function () { act({ op: 'mode', mode: mode.value }); });
  ask.addEventListener('change', function () { act({ op: 'mode', mode: mode.value, ask: ask.checked }); });
  add.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = add.target.value.trim();
    if (!v) return;
    act({ op: 'allow', target: v }).then(function (d) { if (d && d.ok) add.target.value = ''; });
  });
  function showIfOn() { box.hidden = !!(off && !off.checked); }
  if (off) off.addEventListener('change', function () { setTimeout(showIfOn, 0); });
  showIfOn();
  load();
  timer = setInterval(function () { if (!document.hidden) load(); }, 20000);     // new requests show up while the page is open
})();
