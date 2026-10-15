// onair-bar.js — 📺 on Pepe's OBS from his stream player (1.99aan; onair.js decides everything). Site staff only (Admin /
// Staff - GET /api/stage/admin/onair answers 403 to anyone else and this script then does nothing). Below Pepe's player,
// on the same row as the Snap / Clip bar (1.99aao; the bar sits at the right end of it):
//   "On air: <what>" + ✂ Cut      only while something is on air (or waiting for an owner's OK); a confirm step, then the
//                                  same action as the card's Take off / !onair off (audited the same way)
//   📺 Play content here          a compact picker of everything that can go on Pepe's OBS:
//                                  🎥 go live yourself (1.99aaq): a slot on Pepe's pad - OBS key / WHIP / browser on
//                                  /stage - that goes on air the moment it's live (nothing on OBS before that),
//                                  🔗 a YouTube / Twitch link pasted straight in (1.99aao; the rights tick every time),
//                                  📼 a Plex title searched and played on Pepe's own pad (1.99aao; needs allow_library),
//                                  live pad slots (streams, embeds, 📼) and cams - with the card's rules: the rights tick
//                                  for an embed, "Ask the owner" for an Approved-only pad / a cam without an opt-in.
//                                  The server applies everything (IRL wins, the Main scene).
// stage-room.js calls PATVOnAirBar.sync(playerBox) whenever the stage view changes.
(function () {
  'use strict';
  var data = null, dead = false, row = null, bar = null, panel = null, box = null, timer = null, RIGHTS = {}, PLEX = null, plexBusy = false;
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
  function teardown() {
    if (panel) panel.remove();
    if (row) {                                      // give the Snap / Clip bar back its own place
      var cap = row.querySelector('.stcap');
      if (cap) row.parentNode.insertBefore(cap, row);
      row.remove();
    }
    row = bar = panel = null;
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.oab-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 10px;margin:10px 0 0;min-width:0}' +
      '.oab-row>.stcap{margin:0!important;flex:1 1 auto;min-width:0}' +
      '.oab{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;margin:0 0 0 auto;font:13px var(--ds-font,sans-serif);min-width:0}' +
      '.oab .oab-now{color:var(--ds-text-2,#ccc);min-width:0;overflow-wrap:anywhere}.oab .oab-now b{color:var(--ds-text-strong,#fff)}' +
      '.oab button,.oap button{min-height:36px;padding:0 12px;border-radius:999px;border:1px solid var(--ds-line-strong,#444);background:#161616;color:#eee;font:13px var(--ds-font,sans-serif);cursor:pointer}' +
      '.oab button:hover,.oap button:hover{border-color:#5fd0e6}.oab .oab-cut{border-color:#b3261e;color:#ffb4ab}.oap button:disabled{opacity:.55;cursor:default}' +
      '.oap{margin:8px 0 0;padding:10px 12px;border:1px solid var(--ds-line-strong,#333);border-radius:12px;background:var(--card,#111);font:13px var(--ds-font,sans-serif)}' +
      '.oap h4{margin:10px 0 6px;font-size:13px;color:var(--ds-text-2,#bbb)}.oap ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}' +
      '.oap li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;padding:6px 0;border-top:1px solid #222}' +
      '.oap .oap-who{min-width:0;overflow-wrap:anywhere}.oap .oap-why{color:var(--ds-text-muted,#999);font-size:12px}.oap .oap-msg{color:var(--ds-warn,#e8b);min-height:16px;margin:8px 0 0}' +
      '.oap label{font-size:12px;color:var(--ds-text-2,#ccc)}.oap .oap-top{display:flex;justify-content:space-between;align-items:center;gap:8px}' +
      '.oap form{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}' +
      '.oap input[type=url],.oap input[type=search]{flex:1 1 220px;min-width:0;min-height:36px;padding:0 12px;border-radius:999px;border:1px solid var(--ds-line-strong,#444);background:#0d0d0d;color:#eee;font:13px var(--ds-font,sans-serif)}' +
      '.oap select,.oap .oap-gl input{min-height:36px;padding:0 10px;border-radius:8px;border:1px solid var(--ds-line-strong,#444);background:#0d0d0d;color:#eee;font:13px var(--ds-font,sans-serif);max-width:100%}' +
      '.oap .oap-gl p{margin:6px 0;overflow-wrap:anywhere}.oap .oap-gl input{width:min(340px,100%)}' +
      '.oap .oap-plex li img{width:32px;height:48px;object-fit:cover;border-radius:4px;background:#222;flex:0 0 auto}' +
      '.oap .oap-plex .oap-who{display:flex;align-items:center;gap:8px;flex:1 1 200px}';
    document.head.appendChild(s);
  }
  var waiting = function (T) { return !!(T && T.start_until && !T.went_live); };   // a go-live / 📼 pick whose stream hasn't started
  function msg(text) { var m = panel && panel.querySelector('.oap-msg'); if (m) m.textContent = text || ''; }
  function act(body, done) {
    msg('Working…');
    return api(body).then(function (j) {
      if (!j.ok) {
        if (j.code === 'no_optin' || j.code === 'pad_private') { msg(j.error); done && done(j); return; }
        msg(j.error || 'Couldn’t do that.'); return;
      }
      data = j; paint();
      done && done(j);
      var T = j.target;
      msg(!T ? 'Off Pepe’s stream.' : (T.pending || []).length ? 'Asked the owner - it goes on air once they allow it.' : waiting(T) ? 'Waiting for the stream - it goes on air as soon as it’s live.' : 'On Pepe’s stream now (Pepe switches OBS in a few seconds).');
    }).catch(function () { msg('Couldn’t reach the site.'); });
  }
  // the Snap / Clip bar and this bar share one row under the player (no half-empty rows)
  function place() {
    if (!row) row = el('div', 'oab-row');
    if (row.parentNode !== box.parentNode || row.previousSibling !== box) box.parentNode.insertBefore(row, box.nextSibling);
    var cap = row.nextElementSibling && row.nextElementSibling.classList.contains('stcap') ? row.nextElementSibling : null;
    if (cap) row.insertBefore(cap, row.firstChild);
    if (bar.parentNode !== row) row.appendChild(bar);
    if (panel && panel.previousSibling !== row) row.parentNode.insertBefore(panel, row.nextSibling);
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
    place();
    var T = data.target, C = data.cfg || {};
    var h = '';
    if (T) h += '<span class="oab-now">' + ((T.pending || []).length ? '⏳ Waiting for the owner: ' : waiting(T) ? '⏳ Waiting for the stream: ' : '📺 On air: ') + '<b>' + esc(T.label) + '</b></span>' +
      '<button type="button" class="oab-cut" data-oab="cut">✂ Cut</button>';
    h += '<button type="button" data-oab="play"' + (C.enabled ? '' : ' disabled title="On-air is switched off (/stage/admin)"') + '>📺 Play content here</button>';
    bar.innerHTML = h;
    if (panel) fillPanel();
  }
  function plexList() {
    if (PLEX == null) return '';
    if (!PLEX.length) return '<li class="oap-why">Nothing found.</li>';
    return PLEX.map(function (it) {
      var sub = [it.year, it.type === 'episode' && it.show ? it.show : null, it.duration ? Math.round(it.duration / 60) + ' min' : null].filter(Boolean).join(' · ');
      var playable = it.type === 'movie' || it.type === 'episode';
      return '<li><span class="oap-who"><img alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'" src="/api/medialib/poster/' + encodeURIComponent(it.key) + '"><span>📼 ' + esc(it.title) +
        (sub ? ' <span class="oap-why">' + esc(sub) + '</span>' : '') + '</span></span>' +
        (playable ? '<button type="button" data-plex="' + esc(it.key) + '">📺 Play</button>'
          : it.type === 'show' ? '<button type="button" data-show="' + esc(it.key) + '">Episodes</button>' : '') + '</li>';
    }).join('');
  }
  function openPanel() {
    panel = el('div', 'oap');
    var C = (data && data.cfg) || {};
    panel.innerHTML = '<div class="oap-top"><b>📺 Play on Pepe’s stream + his Camfrog cam</b><button type="button" data-x="1" aria-label="Close">✕</button></div>' +
      '<h4>🎥 Go live on Pepe’s stream</h4>' +
      '<form class="oap-golive"><select name="minutes" aria-label="How long"><option value="30">30 min</option><option value="60" selected>1 hour</option>' +
      '<option value="120">2 hours</option><option value="180">3 hours</option></select>' +
      '<input type="search" name="title" placeholder="Title (optional)" aria-label="Title" maxlength="80" autocomplete="off"><button type="submit">🎥 Get my stream key</button></form>' +
      '<div class="oap-gl"></div>' +
      '<h4>🔗 YouTube / Twitch link</h4>' +
      '<form class="oap-link"><input type="url" name="url" placeholder="Paste a YouTube or Twitch link" aria-label="YouTube or Twitch link" autocomplete="off">' +
      '<label><input type="checkbox" name="rights"> I have the rights to rebroadcast this</label><button type="submit">📺 Play</button></form>' +
      '<h4>📼 Plex</h4>' +
      (C.allow_library
        ? '<form class="oap-plexq"><input type="search" name="q" placeholder="Search the library" aria-label="Search the Plex library" autocomplete="off"><button type="submit">Search</button></form>' +
          '<ul class="oap-plex"></ul>'
        : '<p class="oap-why">Plex on Pepe’s stream is switched off (Allow library plays on /stage/admin) - his stream is relayed to Twitch.</p>') +
      '<div class="oap-live"></div>' +
      '<p class="oap-msg" role="status" aria-live="polite"></p>' +
      '<p class="oap-why">Your IRL feed always wins over the pick; OBS switches to the on-air scene by itself. Settings and the log: /stage/admin.</p>';
    row.parentNode.insertBefore(panel, row.nextSibling);
    panel.addEventListener('change', function (e) { var r = e.target.closest('[data-rights]'); if (r) RIGHTS[r.getAttribute('data-rights')] = r.checked; });
    panel.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      if (f.classList.contains('oap-golive')) {
        var T0 = data && data.target;
        if (T0 && !window.confirm('This replaces “' + T0.label + '” on Pepe’s stream as soon as you go live. Continue?')) return;
        act({ action: 'golive', minutes: Number(f.minutes.value), title: f.title.value.trim() }, function (j) {
          var g = j && j.ok && j.golive, box = panel && panel.querySelector('.oap-gl');
          if (!g || !box) return;
          box.innerHTML = '<p>Stream from <b>OBS</b> (Settings → Stream → Custom), within ' + esc(g.wait_min) + ' minutes - it goes on Pepe’s stream as soon as it’s live:</p>' +
            '<p><label>Server <input type="text" readonly value="' + esc(g.rtmp ? g.rtmp.server : '') + '"></label> <button type="button" data-copy="0">Copy</button></p>' +
            '<p><label>Stream key <input type="password" readonly value="' + esc(g.rtmp ? g.rtmp.key : '') + '"></label> <button type="button" data-copy="1">Copy</button></p>' +
            '<p class="oap-why">Or use WHIP / your browser’s camera: <a href="' + esc(g.page) + '" target="_blank" rel="noopener">your slot on /stage</a>. ✂ Cut or ending the slot takes it off.</p>';
        });
      } else if (f.classList.contains('oap-link')) {
        var url = f.url.value.trim();
        if (!url) { msg('Paste a YouTube or Twitch link.'); return; }
        if (!f.rights.checked) { msg('Tick “I have the rights to rebroadcast this” first.'); return; }
        act({ action: 'embed', url: url, rights: true }, function (j) { if (j && j.ok) { f.reset(); } });
      } else if (f.classList.contains('oap-plexq')) {
        var q = f.q.value.trim();
        if (q.length < 2) { msg('Type at least 2 characters.'); return; }
        if (plexBusy) return;
        plexBusy = true; msg('Searching…');
        fetch('/api/medialib/search?q=' + encodeURIComponent(q), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); })
          .then(function (j) {
            if (!j.ok) { msg(j.error || 'Couldn’t search the library.'); return; }
            PLEX = j.results || []; msg('');
            var ul = panel && panel.querySelector('.oap-plex'); if (ul) ul.innerHTML = plexList();
          })
          .catch(function () { msg('Couldn’t reach the site.'); })
          .then(function () { plexBusy = false; });
      }
    });
    panel.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || b.type === 'submit') return;
      if (b.getAttribute('data-x') === '1') { panel.remove(); panel = null; return; }
      if (b.hasAttribute('data-copy')) {
        var inp = panel.querySelectorAll('.oap-gl input')[Number(b.getAttribute('data-copy'))];
        if (!inp) return;
        var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inp.value).then(done, function () { inp.type = 'text'; inp.select(); });
        else { inp.type = 'text'; inp.select(); }
        return;
      }
      if (b.hasAttribute('data-show')) {                     // a show: list its episodes in place of the results
        msg('Loading…');
        fetch('/api/medialib/item/' + encodeURIComponent(b.getAttribute('data-show')), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); })
          .then(function (j) {
            if (!j.ok || !j.item) { msg(j.error || 'Couldn’t load that show.'); return; }
            PLEX = (j.item.episodes || []).slice().sort(function (a, c) { return (a.season - c.season) || (a.episode - c.episode); }).map(function (e) {
              return { key: e.key, type: 'episode', show: j.item.title, duration: e.duration, title: 'S' + e.season + 'E' + e.episode + (e.title ? ' ' + e.title : '') };
            });
            msg('');
            var ul = panel && panel.querySelector('.oap-plex'); if (ul) ul.innerHTML = plexList();
          })
          .catch(function () { msg('Couldn’t reach the site.'); });
        return;
      }
      if (b.hasAttribute('data-plex')) {
        b.disabled = true;
        msg('Starting it on Pepe’s pad…');
        act({ action: 'library', key: b.getAttribute('data-plex') }).then(function () { b.disabled = false; });
        return;
      }
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
    var u = panel.querySelector('input[type=url]'); if (u) u.focus();
  }
  function line(label, sub, attrs, why, ask, rights, onNow) {
    var right;
    if (onNow) right = '<span class="oap-why">on air</span>';
    else if (why) right = '<span class="oap-why">' + esc((data.why || {})[why] || why) + '</span>';
    else right = (rights ? '<label><input type="checkbox" data-rights="' + esc(rights) + '"' + (RIGHTS[rights] ? ' checked' : '') + '> I have the rights to rebroadcast this</label> ' : '') +
      '<button type="button" ' + attrs + (ask ? ' data-ask="1"' : '') + '>' + (ask ? '📨 Ask the owner' : '📺 Play') + '</button>';
    return '<li><span class="oap-who">' + label + (sub ? ' <span class="oap-why">' + sub + '</span>' : '') + '</span><span>' + right + '</span></li>';
  }
  // only the live lists repaint on the 15 s poll; the link box and the Plex search keep what was typed
  function fillPanel() {
    var live = panel && panel.querySelector('.oap-live'); if (!live) return;
    var T = data.target;
    var slots = (data.slots || []).map(function (s) {
      var on = T && T.kind !== 'cam' && T.slot_id === s.id;
      return line(esc(s.display) + (s.title ? ' - ' + esc(s.title) : '') + (s.library ? ' 📼' : ''), esc(s.pad) + (s.embed ? ' · ' + esc(s.embed) : ''),
        'data-slot="' + esc(s.id) + '"' + (s.embed ? ' data-embed="1"' : ''), s.why, s.ask, s.embed ? s.id : null, on);
    }).join('');
    var cams = (data.cams || []).map(function (c) {
      var on = T && T.kind === 'cam' && T.room === c.room && T.login === c.login;
      return line('📷 ' + esc(c.display), esc(c.roomName), 'data-room="' + esc(c.room) + '" data-login="' + esc(c.login) + '"', c.why, c.ask, null, on);
    }).join('');
    live.innerHTML = '<h4>Live pad streams</h4><ul>' + (slots || '<li class="oap-why">No live slots.</li>') + '</ul>' +
      '<h4>Cams</h4><ul>' + (cams || '<li class="oap-why">Nobody is on cam in a live room.</li>') + '</ul>';
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
