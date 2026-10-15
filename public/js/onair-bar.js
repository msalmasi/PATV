// onair-bar.js — 📺 on Pepe's OBS from his stream player (1.99aan; onair.js decides everything). Site staff only (Admin /
// Staff - GET /api/stage/admin/onair answers 403 to anyone else and this script then does nothing). Below Pepe's player, at
// the lower right:
//   "On air: <what>" + ✂ Cut      only while something is on air (or waiting for an owner's OK); a confirm step, then the
//                                  same action as the card's Take off / !onair off (audited the same way)
//   📺 Play content here          a compact picker of everything that can go on Pepe's OBS - live pad slots (streams,
//                                  embeds, 📼 Plex when allowed) and cams - with the card's rules: the "I have the rights to
//                                  rebroadcast this" tick for an embed, "Ask the owner" for an Approved-only pad / a cam
//                                  without an opt-in. The server applies everything (IRL wins, the Main scene).
// stage-room.js calls PATVOnAirBar.sync(playerBox) whenever the stage view changes.
(function () {
  'use strict';
  var data = null, dead = false, bar = null, panel = null, box = null, timer = null, RIGHTS = {};
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function api(body) {
    return fetch('/api/stage/admin/onair', body ? { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) } : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { if (!body) dead = true; }
        return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; });
      });
  }
  function load() {
    if (dead) return;
    api().then(function (j) { if (j && j.ok) { data = j; paint(); } else if (dead) teardown(); }).catch(function () { /* next poll */ });
  }
  function teardown() { if (bar) bar.remove(); if (panel) panel.remove(); bar = panel = null; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.oab{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;margin:8px 0 0;font:13px var(--ds-font,sans-serif)}' +
      '.oab .oab-now{color:var(--ds-text-2,#ccc);min-width:0;overflow-wrap:anywhere}.oab .oab-now b{color:var(--ds-text-strong,#fff)}' +
      '.oab button,.oap button{min-height:36px;padding:0 12px;border-radius:999px;border:1px solid var(--ds-line-strong,#444);background:#161616;color:#eee;font:13px var(--ds-font,sans-serif);cursor:pointer}' +
      '.oab button:hover,.oap button:hover{border-color:#5fd0e6}.oab .oab-cut{border-color:#b3261e;color:#ffb4ab}' +
      '.oap{margin:8px 0 0;padding:10px 12px;border:1px solid var(--ds-line-strong,#333);border-radius:12px;background:var(--card,#111);font:13px var(--ds-font,sans-serif)}' +
      '.oap h4{margin:6px 0;font-size:13px;color:var(--ds-text-2,#bbb)}.oap ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}' +
      '.oap li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;padding:6px 0;border-top:1px solid #222}' +
      '.oap .oap-who{min-width:0;overflow-wrap:anywhere}.oap .oap-why{color:var(--ds-text-muted,#999);font-size:12px}.oap .oap-msg{color:var(--ds-warn,#e8b);min-height:16px}' +
      '.oap label{font-size:12px;color:var(--ds-text-2,#ccc)}.oap .oap-top{display:flex;justify-content:space-between;align-items:center;gap:8px}';
    document.head.appendChild(s);
  }
  function msg(text) { var m = panel && panel.querySelector('.oap-msg'); if (m) m.textContent = text || ''; }
  function act(body, done) {
    msg('Working…');
    return api(body).then(function (j) {
      if (!j.ok) {
        if (j.code === 'no_optin' || j.code === 'pad_private') { msg(j.error); done && done(j); return; }
        msg(j.error || 'Couldn’t do that.'); return;
      }
      data = j; paint();
      var T = j.target;
      msg(!T ? 'Off Pepe’s stream.' : (T.pending || []).length ? 'Asked the owner - it goes on air once they allow it.' : 'On Pepe’s stream now (Pepe switches OBS in a few seconds).');
    }).catch(function () { msg('Couldn’t reach the site.'); });
  }
  function paint() {
    if (!data || !box) return;
    if (!bar) {
      bar = el('div', 'oab');
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Pepe’s OBS (staff)');
      bar.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        if (b.getAttribute('data-oab') === 'cut') {
          var T = data && data.target;
          if (!T || !window.confirm('Take “' + T.label + '” off Pepe’s stream?')) return;
          api({ action: 'off' }).then(function (j) { if (j.ok) { data = j; paint(); } else window.alert(j.error || 'Couldn’t take it off.'); });
        }
        if (b.getAttribute('data-oab') === 'play') { if (panel) { panel.remove(); panel = null; } else openPanel(); }
      });
    }
    if (bar.parentNode !== box.parentNode || bar.previousSibling !== box) box.parentNode.insertBefore(bar, box.nextSibling);
    var T = data.target, C = data.cfg || {};
    var h = '';
    if (T) h += '<span class="oab-now">' + ((T.pending || []).length ? '⏳ Waiting for the owner: ' : '📺 On air: ') + '<b>' + esc(T.label) + '</b></span>' +
      '<button type="button" class="oab-cut" data-oab="cut">✂ Cut</button>';
    h += '<button type="button" data-oab="play"' + (C.enabled ? '' : ' disabled title="On-air is switched off (/stage/admin)"') + '>📺 Play content here</button>';
    bar.innerHTML = h;
    if (panel) fillPanel();
  }
  function openPanel() {
    panel = el('div', 'oap');
    bar.parentNode.insertBefore(panel, bar.nextSibling);
    panel.addEventListener('change', function (e) { var r = e.target.closest('[data-rights]'); if (r) RIGHTS[r.getAttribute('data-rights')] = r.checked; });
    panel.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.getAttribute('data-x') === '1') { panel.remove(); panel = null; return; }
      var ask = b.getAttribute('data-ask') === '1';
      if (b.hasAttribute('data-slot')) {
        var id = b.getAttribute('data-slot');
        if (b.hasAttribute('data-embed') && !RIGHTS[id]) { msg('Tick “I have the rights to rebroadcast this” first.'); return; }
        act({ action: 'slot', slot_id: id, rights: !!RIGHTS[id], ask: ask });
      } else if (b.hasAttribute('data-login')) {
        act({ action: 'cam', room: b.getAttribute('data-room'), login: b.getAttribute('data-login'), ask: ask });
      }
    });
    fillPanel();
    load();
  }
  function row(label, sub, attrs, why, ask, rights, onNow) {
    var right;
    if (onNow) right = '<span class="oap-why">on air</span>';
    else if (why) right = '<span class="oap-why">' + esc((data.why || {})[why] || why) + '</span>';
    else right = (rights ? '<label><input type="checkbox" data-rights="' + esc(rights) + '"' + (RIGHTS[rights] ? ' checked' : '') + '> I have the rights to rebroadcast this</label> ' : '') +
      '<button type="button" ' + attrs + (ask ? ' data-ask="1"' : '') + '>' + (ask ? '📨 Ask the owner' : '📺 Play') + '</button>';
    return '<li><span class="oap-who">' + label + (sub ? ' <span class="oap-why">' + sub + '</span>' : '') + '</span><span>' + right + '</span></li>';
  }
  function fillPanel() {
    var T = data.target;
    var slots = (data.slots || []).map(function (s) {
      var on = T && T.kind !== 'cam' && T.slot_id === s.id;
      return row(esc(s.display) + (s.title ? ' - ' + esc(s.title) : '') + (s.library ? ' 📼' : ''), esc(s.pad) + (s.embed ? ' · ' + esc(s.embed) : ''),
        'data-slot="' + esc(s.id) + '"' + (s.embed ? ' data-embed="1"' : ''), s.why, s.ask, s.embed ? s.id : null, on);
    }).join('');
    var cams = (data.cams || []).map(function (c) {
      var on = T && T.kind === 'cam' && T.room === c.room && T.login === c.login;
      return row('📷 ' + esc(c.display), esc(c.roomName), 'data-room="' + esc(c.room) + '" data-login="' + esc(c.login) + '"', c.why, c.ask, null, on);
    }).join('');
    panel.innerHTML = '<div class="oap-top"><b>📺 Play on Pepe’s stream + his Camfrog cam</b><button type="button" data-x="1" aria-label="Close">✕</button></div>' +
      '<h4>Live pad streams</h4><ul>' + (slots || '<li class="oap-why">No live slots.</li>') + '</ul>' +
      '<h4>Cams</h4><ul>' + (cams || '<li class="oap-why">Nobody is on cam in a live room.</li>') + '</ul>' +
      '<p class="oap-msg" role="status" aria-live="polite"></p>' +
      '<p class="oap-why">Your IRL feed always wins over the pick; OBS switches to the on-air scene by itself. Settings and the log: /stage/admin.</p>';
  }
  window.PATVOnAirBar = {
    sync: function (where) {
      if (dead || !where || !where.parentNode) return;
      if (!bar && !panel && !timer) css();
      box = where;
      if (!data) load(); else paint();
      if (!timer) timer = setInterval(function () { if (!document.hidden) load(); }, 15000);
    },
  };
})();
