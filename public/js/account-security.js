// account-security.js - Settings -> Account: "Your devices" (sessions.js: GET /api/account/sessions, POST .../revoke,
// .../revoke-others, .../revoke-all) and "Your data" (accountexport.js: GET / POST /api/account/export). 1.99wj.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var H = { 'content-type': 'application/json', 'X-Requested-With': 'fetch' };
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (j) { j.status = r.status; return j; }); });
  }
  function when(ms) {
    if (!ms) return '';
    try { return new Date(Number(ms)).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' '); }
  }
  var METHOD = {
    password: _t('js.acct.m_password', 'Password'), google: 'Google', apple: 'Apple', plex: 'Plex', telegram: 'Telegram', discord: 'Discord', twitch: 'Twitch',
    chat: _t('js.acct.m_chat', 'Chat sign-in link'), claim: _t('js.acct.m_claim', 'Claim link'), legacy: _t('js.acct.m_legacy', 'Signed in before devices were listed')
  };

  // ── your devices ──
  var list = document.getElementById('devList'), st = document.getElementById('devStatus');
  var bOthers = document.getElementById('devOthers'), bAll = document.getElementById('devAll');
  function say(msg, bad) { if (st) { st.textContent = msg || ''; st.className = 'status ' + (bad ? 'err' : 'ok'); } }
  function row(s) {
    var div = document.createElement('div');
    div.className = 'conn-row dev-row';
    var ic = document.createElement('span'); ic.className = 'conn-ico'; ic.setAttribute('aria-hidden', 'true'); ic.style.background = '#1d2a3a';
    ic.textContent = /iOS|Android/.test(s.device || '') ? '📱' : '💻';
    var nm = document.createElement('span'); nm.className = 'conn-name';
    var b = document.createElement('b');
    b.textContent = s.method === 'legacy' && s.legacy_before
      ? _t('js.acct.legacy_device', 'Unknown device, signed in before {date}', { date: when(s.legacy_before) })
      : (s.device || _t('js.acct.unknown_device', 'Unknown device'));
    if (s.current) { var here = document.createElement('span'); here.className = 'dev-here'; here.textContent = _t('js.acct.this_device', 'This device'); b.appendChild(here); }
    var sm = document.createElement('small');
    var bits = [METHOD[s.method] || s.method];
    var where = [s.country, s.ip].filter(Boolean).join(' · ');
    if (where) bits.push(where);
    bits.push(_t('js.acct.last_active', 'Last active {when}', { when: when(s.last_seen || s.created) }));
    bits.push(_t('js.acct.signed_in', 'Signed in {when}', { when: when(s.created) }));
    sm.textContent = bits.join(' · ');
    nm.appendChild(b); nm.appendChild(sm);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn';
    btn.textContent = _t('js.acct.signout', 'Sign out');
    btn.addEventListener('click', function () {
      if (s.current && !window.confirm(_t('js.acct.signout_here_q', 'Sign out on this device?'))) return;
      btn.disabled = true;
      post('/api/account/sessions/revoke', { id: s.id }).then(function (j) {
        if (j && j.ok && j.signedOut) { location.href = '/login'; return; }
        if (j && j.ok) { say(_t('js.acct.signed_out_one', 'That device is signed out.')); load(); return; }
        btn.disabled = false; say(_t('js.acct.failed', "Couldn't do that - try again."), true);
      }).catch(function () { btn.disabled = false; say(_t('js.acct.failed', "Couldn't do that - try again."), true); });
    });
    div.appendChild(ic); div.appendChild(nm); div.appendChild(btn);
    return div;
  }
  function load() {
    if (!list) return;
    fetch('/api/account/sessions', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        list.textContent = '';
        var ss = (j && j.sessions) || [];
        ss.forEach(function (s) { list.appendChild(row(s)); });
        if (!ss.length) { var p = document.createElement('p'); p.className = 'hint'; p.textContent = _t('js.acct.none', 'No devices to show.'); list.appendChild(p); }
        if (bOthers) bOthers.disabled = ss.filter(function (s) { return !s.current; }).length === 0;
      })
      .catch(function () { list.textContent = ''; say(_t('js.acct.load_failed', "Couldn't load your devices."), true); });
  }
  if (bOthers) bOthers.addEventListener('click', function () {
    if (!window.confirm(_t('js.acct.others_q', 'Sign out every other device? This one stays signed in.'))) return;
    bOthers.disabled = true;
    post('/api/account/sessions/revoke-others').then(function (j) {
      if (j && j.ok) { say(_t('js.acct.others_done', 'Signed out {count} other device(s).', { count: j.revoked })); load(); return; }
      bOthers.disabled = false; say((j && j.error) || _t('js.acct.failed', "Couldn't do that - try again."), true);
    }).catch(function () { bOthers.disabled = false; say(_t('js.acct.failed', "Couldn't do that - try again."), true); });
  });
  if (bAll) bAll.addEventListener('click', function () {
    if (!window.confirm(_t('js.acct.all_q', 'Sign out everywhere, including this device?'))) return;
    bAll.disabled = true;
    post('/api/account/sessions/revoke-all').then(function (j) {
      if (j && j.ok) { location.href = '/login'; return; }
      bAll.disabled = false; say(_t('js.acct.failed', "Couldn't do that - try again."), true);
    }).catch(function () { bAll.disabled = false; say(_t('js.acct.failed', "Couldn't do that - try again."), true); });
  });
  load();

  // ── your data ──
  var eb = document.getElementById('expBtn'), es = document.getElementById('expStatus'), el = document.getElementById('expList');
  function esay(msg, bad) { if (es) { es.textContent = msg || ''; es.className = 'status ' + (bad ? 'err' : 'ok'); } }
  var STATE = { queued: _t('js.acct.exp_queued', 'Being prepared…'), running: _t('js.acct.exp_queued', 'Being prepared…'),
                ready: _t('js.acct.exp_ready', 'Ready'), failed: _t('js.acct.exp_failed', 'Failed'), expired: _t('js.acct.exp_expired', 'Expired') };
  function exports_() {
    if (!el) return;
    fetch('/api/account/export', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      el.textContent = '';
      var busy = false;
      ((j && j.exports) || []).forEach(function (x) {
        var li = document.createElement('li');
        li.appendChild(document.createTextNode(when(x.created) + ' · ' + (STATE[x.state] || x.state)));
        if (x.state === 'queued' || x.state === 'running') busy = true;
        if (x.state === 'ready' && x.expires > Date.now()) {
          li.appendChild(document.createTextNode(' · '));
          var a = document.createElement('a'); a.href = '/settings/account/export/' + encodeURIComponent(x.id);
          a.textContent = _t('js.acct.exp_download', 'Download (until {date})', { date: when(x.expires) });
          li.appendChild(a);
        }
        el.appendChild(li);
      });
      if (busy) setTimeout(exports_, 5000);
    }).catch(function () {});
  }
  if (eb) eb.addEventListener('click', function () {
    eb.disabled = true;
    post('/api/account/export').then(function (j) {
      if (j && j.ok) { esay(_t('js.acct.exp_started', "We're preparing your data. You'll get a notice when it's ready.")); exports_(); return; }
      eb.disabled = false;
      if (j && j.code === 'E_RATE') esay(_t('js.acct.exp_rate', 'One export a day - try again after {when}.', { when: when(j.retry_at) }), true);
      else esay(_t('js.acct.failed', "Couldn't do that - try again."), true);
    }).catch(function () { eb.disabled = false; esay(_t('js.acct.failed', "Couldn't do that - try again."), true); });
  });
  exports_();

  // ── CL10: your chat-log downloads (chatlogexport.js: GET /api/account/chatlog-downloads) - what you asked for in the last 90 days
  // (the pad, the range, the format, how many lines, how it ended), never the files: PATV doesn't keep them. The card stays hidden
  // until there is one, or downloads are on.
  var cldl = document.getElementById('chatlogdl'), cldlList = document.getElementById('cldlList');
  var tp = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    if (d && typeof d === 'object') d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var CLST = { streaming: _t('js.acct.cldl_streaming', 'being made'), failed: _t('js.acct.cldl_failed', 'didn’t finish'),
               aborted: _t('js.acct.cldl_aborted', 'stopped'), unused: _t('js.acct.cldl_unused', 'link not used') };
  var CLFMT = { html: 'HTML', txt: 'TXT', jsonl: 'JSONL' };
  function day(ms) {
    try { return new Date(Number(ms)).toLocaleDateString(document.documentElement.lang || undefined, { dateStyle: 'medium' }); }
    catch (e) { return new Date(Number(ms)).toISOString().slice(0, 10); }
  }
  function cldls() {
    if (!cldl || !cldlList) return;
    fetch('/api/account/chatlog-downloads', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) return;
      var rows = j.downloads || [];
      if (!rows.length && !j.on) return;
      cldl.hidden = false;
      cldlList.textContent = '';
      if (!rows.length) { cldlList.appendChild(document.createElement('li')).textContent = _t('js.acct.cldl_none', 'No chat-log downloads in the last 90 days.'); return; }
      rows.forEach(function (x) {
        var li = document.createElement('li');
        li.appendChild(document.createTextNode(when(x.created) + ' · '));
        if (x.pad && x.pad.slug) {
          var a = document.createElement('a'); a.href = '/p/' + encodeURIComponent(x.pad.slug); a.textContent = x.pad.title || x.pad.slug;
          li.appendChild(a);
        } else li.appendChild(document.createTextNode(x.pad && x.pad.title ? x.pad.title : _t('js.acct.cldl_gone', 'a pad that’s gone')));
        var bits = [];
        if (x.from && x.to) bits.push(day(x.from) + ' → ' + day(Number(x.to) - 1));
        bits.push(CLFMT[x.fmt] || String(x.fmt || '').toUpperCase());
        if (x.items != null) bits.push(tp('js.acct.cldl_lines', { one: '{n} line', other: '{n} lines' }, { count: x.items, n: Number(x.items).toLocaleString(document.documentElement.lang || undefined) }));
        if (x.sys) bits.push(_t('js.acct.cldl_sys', 'with joins, leaves and mic'));
        if (CLST[x.state]) bits.push(CLST[x.state]);
        li.appendChild(document.createTextNode(' · ' + bits.join(' · ')));
        cldlList.appendChild(li);
      });
    }).catch(function () {});
  }
  cldls();
})();
