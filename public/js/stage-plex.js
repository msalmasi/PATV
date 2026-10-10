// /stage — 1.99jn: "📼 Play from Plex" in the Go-live flow (views/stageBook.ejs, medialib.js /api/medialib/*).
//   * the third "What you're putting on" choice: search the Plex library, pick a movie / an episode, see the price,
//     confirm -> it plays in a 📼 library slot on the pad picked above (the price is held, routed once it's on the
//     stage, refunded if it never gets there);
//   * the slot owner's controls in "Your slot" while their open slot is a library slot: pause / resume / ±10 min /
//     seek / stop (stage-book.js tells us about the open slot with the patv:slot event).
// 1.99jp: every string goes through __t (locales/<lang>.json, js.plex.*); Plex members play free (data-member).
(function () {
  'use strict';
  var root = document.getElementById('sb');
  if (!root || root.getAttribute('data-signed') !== '1') return;
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var LANG = (window.PATV_I18N && window.PATV_I18N.lang) || 'en';
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { var x = Math.round(Number(n) || 0); try { return x.toLocaleString(LANG === 'en' ? 'en-US' : LANG); } catch (e) { return x.toLocaleString('en-US'); } };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function hms(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }
  function parseTime(v) {
    var p = String(v || '').trim().split(':').map(Number);
    if (!p.length || p.some(function (n) { return !isFinite(n) || n < 0; })) return null;
    var t = 0;
    for (var i = 0; i < p.length; i++) t = t * 60 + p[i];
    return Math.floor(t);
  }
  function day(ms) { try { return new Date(ms).toLocaleDateString(LANG === 'en' ? undefined : LANG); } catch (e) { return new Date(ms).toLocaleDateString(); } }
  // -> resolves the JSON; rejects with an Error carrying .data (the JSON: error, price…)
  function api(method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: _t('js.stage.e_server', 'Server error ({status})', { status: r.status }) }; }).then(function (j) {
        if (!r.ok || j.ok === false) { var e = new Error(j.error || ('HTTP ' + r.status)); e.data = j; throw e; }
        return j;
      });
    });
  }
  function roomId() { var o = $('room') && $('room').selectedOptions[0]; return o ? (o.getAttribute('data-id') || o.value) : ''; }
  function roomTitle() { var o = $('room') && $('room').selectedOptions[0]; return o ? o.getAttribute('data-title') : _t('js.plex.this_pad', 'this pad'); }
  var STATES = { playing: _t('js.plex.st_playing', 'playing'), paused: _t('js.plex.st_paused', 'paused'), starting: _t('js.plex.st_starting', 'starting'),
                 error: _t('js.plex.st_error', 'error'), ended: _t('js.plex.st_ended', 'ended') };

  // ── the choice ──
  var panel = $('plexPanel');
  var form = $('bookForm');
  function mode() { var r = document.querySelector('input[name=mode]:checked'); return r ? r.value : null; }
  function onMode() {
    var on = mode() === 'plex' && !!panel;
    if (form) form.classList.toggle('plex-mode', on);
    if (panel) panel.classList.toggle('hide', !on);
    if (on) info();
  }
  document.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', onMode); });
  if ($('room') && panel) $('room').addEventListener('change', function () { if (mode() === 'plex') info(); drawPrice(); });

  if (panel) {
    var FREE = panel.getAttribute('data-free') === '1';
    var MEMBER = panel.getAttribute('data-member') === '1';
    var PER_HOUR = Number(panel.getAttribute('data-per-hour')) || 0;
    var QUALITY = Number(panel.getAttribute('data-quality')) || 720;
    var picked = null, quote = null;
    var say = function (t, good) { $('plexMsg').textContent = t || ''; $('plexMsg').style.color = good ? '#9ccc65' : ''; };
    // the same rule as the server (medialib.priceFor): per started hour of what's left from the start point, >= 1 h
    var hoursAt = function (dur, off) { return Math.max(1, Math.ceil(Math.max(0, (Number(dur) || 0) - Math.max(0, off || 0)) / 3600)); };
    var priceAt = function (dur, off) { return FREE || !PER_HOUR ? 0 : PER_HOUR * hoursAt(dur, off); };
    var info = function () {
      api('GET', '/api/medialib/mine?room=' + encodeURIComponent(roomId())).then(function (j) {
        var bits = [];
        if (j.streams && j.streams.max) bits.push(_t('js.plex.streams_used', '📼 {used} of {max} library streams in use right now', { used: j.streams.used, max: j.streams.max }));
        if (j.daily_left != null) bits.push(_t('js.plex.plays_left', '{left} of {cap} plays left today', { left: j.daily_left, cap: j.daily_cap }));
        if (j.access && j.access.until) bits.push(_t('js.plex.access_until', 'your Plex access runs until {date}', { date: day(j.access.until) }));
        $('plexInfo').textContent = bits.join(' · ');
      }).catch(function (e) { $('plexInfo').textContent = e.message; });
    };
    window.PATVPlexInfo = info;
    var card = function (it) {
      var sub = it.type === 'episode' ? (esc(it.show) + ' · S' + it.season + 'E' + it.episode)
        : it.type === 'show' ? esc(_t('js.plex.show', 'Show')) + (it.leafs ? ' · ' + esc(_t('js.plex.episodes', '{count} episodes', { count: it.leafs })) : '')
        : (it.year || esc(_t('js.plex.movie', 'Movie')));
      return '<button type="button" class="px-it" data-key="' + esc(it.key) + '">' +
        (it.poster ? '<img loading="lazy" alt="" src="/api/medialib/poster/' + encodeURIComponent(it.key) + '">' : '<span class="px-ph"></span>') +
        '<b>' + esc(it.title) + '</b><small>' + sub + (it.duration ? ' · ' + hms(it.duration) : '') + '</small></button>';
    };
    $('plexSearch').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = $('plexSearch').q.value.trim();
      if (q.length < 2) { say(_t('js.plex.type_2', 'Type at least 2 characters.')); return; }
      say(_t('js.plex.searching', 'Searching…'), true);
      $('plexPick').classList.add('hide');
      api('GET', '/api/medialib/search?q=' + encodeURIComponent(q)).then(function (j) {
        $('plexResults').innerHTML = (j.results || []).map(card).join('') || '<p class="muted">' + esc(_t('js.plex.nothing', 'Nothing found.')) + '</p>';
        say('');
      }).catch(function (e) { say(e.message); });
    });
    $('plexResults').addEventListener('click', function (ev) {
      var b = ev.target.closest('.px-it');
      if (b) openItem(b.getAttribute('data-key'));
    });
    $('plexPick').addEventListener('click', function (ev) {
      var ep = ev.target.closest('[data-ep]');
      if (ep) { openItem(ep.getAttribute('data-ep')); return; }
      var go = ev.target.closest('[data-play]');
      if (go) play(go);
    });
    $('plexPick').addEventListener('input', function (ev) { if (ev.target.hasAttribute('data-o')) drawPrice(); });
    var drawPrice = function () {
      if (!picked || !$('plexPick').querySelector('[data-o]')) return;
      var off = parseTime($('plexPick').querySelector('[data-o]').value) || 0;
      quote = priceAt(picked.duration, off);
      var hours = hoursAt(picked.duration, off);
      var bal = $('bal') ? $('bal').textContent : '?';
      $('plexPick').querySelector('[data-price]').innerHTML = quote
        ? esc(_t('js.plex.price', 'Price:')) + ' <b>' + fmt(quote) + ' PAT</b> <span class="muted">· ' +
          esc(_t('js.plex.price_detail', '{count} started hours × {per} · you have {bal}', { count: hours, per: fmt(PER_HOUR), bal: bal })) + '</span>'
        : '<b>' + esc(_t('js.plex.free', 'Free')) + '</b> <span class="muted">' + esc(MEMBER ? _t('js.plex.free_member', '(Plex member)') : _t('js.plex.free_admin', '(site admin)')) + '</span>';
      $('plexPick').querySelector('[data-play]').textContent = quote
        ? _t('js.plex.play_on_for', '▶ Play on {pad} for {price} PAT', { pad: roomTitle(), price: fmt(quote) })
        : _t('js.plex.play_on', '▶ Play on {pad}', { pad: roomTitle() });
    };
    var openItem = function (key) {
      say(_t('js.plex.loading', 'Loading…'), true);
      api('GET', '/api/medialib/item/' + encodeURIComponent(key)).then(function (j) {
        var it = j.item;
        picked = it;
        var h = '<div><b>' + esc(it.type === 'episode' ? it.show + ' · S' + it.season + 'E' + it.episode + ' · ' + it.title : it.title) + '</b>' +
                (it.year ? ' (' + it.year + ')' : '') + (it.duration ? ' <span class="muted">· ' + hms(it.duration) + '</span>' : '') + '</div>';
        if (it.summary) h += '<p class="muted" style="margin:0">' + esc(it.summary) + '</p>';
        if (it.type === 'show') {
          h += '<div class="px-eps">' + (it.episodes || []).map(function (e) {
            return '<button type="button" class="btn" data-ep="' + esc(e.key) + '">S' + e.season + 'E' + e.episode + ' · ' + esc(e.title) + (e.duration ? ' <span class="muted">' + hms(e.duration) + '</span>' : '') + '</button>';
          }).join('') + '</div>';
        } else {
          var q = [1080, 720, 480].map(function (v) { return '<option value="' + v + '"' + (v === QUALITY ? ' selected' : '') + '>' + v + 'p</option>'; }).join('');
          var au = (it.audio || []).map(function (a) { return '<option value="' + a.index + '"' + (a['default'] ? ' selected' : '') + '>' + esc(a.label) + '</option>'; }).join('');
          var su = '<option value="">' + esc(_t('js.plex.none', 'None')) + '</option>' + (it.subs || []).filter(function (s) { return s.burnable; }).map(function (s) {
            return '<option value="' + s.index + '">' + esc(s.label) + (s.forced ? ' ' + esc(_t('js.plex.forced', '(forced)')) : '') + '</option>';
          }).join('');
          h += '<div class="row">' +
            '<label>' + esc(_t('js.plex.quality', 'Quality')) + ' <select data-q>' + q + '</select></label>' +
            (au ? '<label>' + esc(_t('js.plex.audio', 'Audio')) + ' <select data-a>' + au + '</select></label>' : '') +
            '<label>' + esc(_t('js.plex.subs', 'Subtitles (burnt in)')) + ' <select data-s>' + su + '</select></label>' +
            '<label>' + esc(_t('js.plex.start_at', 'Start at')) + ' <input type="text" data-o value="0:00" inputmode="numeric" aria-label="' + esc(_t('js.plex.start_aria', 'Start at (h:mm:ss)')) + '"></label>' +
            '</div>' +
            (it.hdr ? '<p class="muted" style="margin:0">' + esc(_t('js.plex.hdr', 'HDR: shown in SDR, at up to 720p.')) + '</p>' : '') +
            '<div class="px-price" data-price></div>' +
            '<div class="row"><button type="button" class="btn primary" data-play>' + esc(_t('js.plex.play', '▶ Play')) + '</button></div>';
        }
        $('plexPick').innerHTML = h;
        $('plexPick').classList.remove('hide');
        drawPrice();
        say('');
        $('plexPick').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }).catch(function (e) { say(e.message); });
    };
    var play = function (btn, confirmed) {
      if (!picked) return;
      var pk = $('plexPick');
      var off = parseTime(pk.querySelector('[data-o]').value);
      if (off == null) { say(_t('js.plex.time_fmt', 'Type the start time like 1:02:30.')); return; }
      var a = pk.querySelector('[data-a]'), s = pk.querySelector('[data-s]');
      var price = confirmed != null ? confirmed : priceAt(picked.duration, off);
      var what = (picked.type === 'episode' ? picked.show + ' S' + picked.season + 'E' + picked.episode : picked.title);
      var q = off ? _t('js.plex.q_play_from', 'Play “{what}” on {pad}’s stage from {time}?', { what: what, pad: roomTitle(), time: hms(off) })
                  : _t('js.plex.q_play', 'Play “{what}” on {pad}’s stage?', { what: what, pad: roomTitle() });
      if (!confirm(q + '\n\n' + (price ? _t('js.plex.q_cost', 'It costs {price} PAT, taken now. If it never gets on the stage, it all comes back.', { price: fmt(price) }) + '\n\n' : '') +
                   _t('js.plex.q_rights', 'Only show what we have the rights to show - every play is logged.'))) return;
      var body = { room: roomId(), key: picked.key, quality: Number(pk.querySelector('[data-q]').value), offset: off,
                   audio: a ? a.value : null, sub: s && s.value !== '' ? s.value : null };
      if (price) body.price = price;
      btn.disabled = true;
      say(_t('js.plex.starting', 'Starting… (opening a library slot and the encoder)'), true);
      api('POST', '/api/medialib/play', body).then(function (j) {
        say(_t('js.plex.started', '▶ {title} is starting on {pad} - it shows on the stage within a few seconds.', { title: j.title, pad: roomTitle() }) +
            (j.price ? ' ' + _t('js.plex.paid', '{price} PAT paid.', { price: fmt(j.price) }) : ''), true);
        info();
        if (window.PATVStageRefresh) window.PATVStageRefresh();
        var c = $('slotCard'); if (c) setTimeout(function () { c.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 1500);
      }).catch(function (e) {
        // the price moved (or wasn't confirmed): show the server's and ask again
        if (e.data && e.data.price && e.data.price !== price) {
          say(e.message);
          btn.disabled = false;
          quote = e.data.price;
          play(btn, e.data.price);
          return;
        }
        say(e.message);
      }).then(function () { btn.disabled = false; });
    };
  }

  // ── the slot owner's controls (a library slot open in "Your slot") ──
  var now = $('plexNow');
  var libSlot = null, timer = null;
  function drawNow(j) {
    var s = (j.sessions || []).filter(function (x) { return libSlot && x.slot_id === libSlot.id; })[0] || (j.sessions || [])[0];
    if (!s) { now.innerHTML = '<p class="muted" style="margin:0">' + esc(_t('js.plex.now_starting', '📼 Starting the library stream…')) + '</p>'; return; }
    var pct = s.duration ? Math.min(100, 100 * (s.position || 0) / s.duration) : 0;
    var paused = s.state === 'paused';
    var pauseMin = root.querySelector('#plexPanel') ? root.querySelector('#plexPanel').getAttribute('data-pause') : '30';
    now.setAttribute('data-room', s.room);
    now.setAttribute('data-pos', Math.floor(s.position || 0));
    now.innerHTML = '<div><b>📼 ' + esc(s.title) + '</b> <span class="muted">· ' + esc(STATES[s.state] || s.state) +
      (s.price ? ' · ' + fmt(s.price) + ' PAT' + (s.charge === 'held' ? ' ' + esc(_t('js.plex.held', '(held until it’s on the stage)')) : '') : '') + '</span></div>' +
      '<div class="px-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
      '<div class="muted">' + hms(s.position) + (s.duration ? ' / ' + hms(s.duration) : '') + (s.error ? ' · <span style="color:#ff8a80">' + esc(s.error) + '</span>' : '') +
        (paused ? ' · ' + esc(_t('js.plex.paused_note', 'paused: it ends if it stays paused {min} min', { min: pauseMin })) : '') + '</div>' +
      '<div class="row">' +
        (paused ? '<button type="button" class="btn primary" data-act="resume">' + esc(_t('js.plex.resume', '▶ Resume')) + '</button>'
                : '<button type="button" class="btn" data-act="pause">' + esc(_t('js.plex.pause', '⏸ Pause')) + '</button>') +
        '<button type="button" class="btn" data-act="back">' + esc(_t('js.plex.back10', '⏪ 10 min')) + '</button><button type="button" class="btn" data-act="fwd">' + esc(_t('js.plex.fwd10', '10 min ⏩')) + '</button>' +
        '<input type="text" inputmode="numeric" placeholder="h:mm:ss" aria-label="' + esc(_t('js.plex.seek_aria', 'Seek to')) + '" data-seek><button type="button" class="btn" data-act="seek">' + esc(_t('js.plex.seek', 'Seek')) + '</button>' +
        '<button type="button" class="btn danger" data-act="stop">' + esc(_t('js.plex.stop', '⏹ Stop')) + '</button>' +
      '</div>';
  }
  function pollNow() {
    if (!libSlot || document.hidden) return;
    api('GET', '/api/medialib/mine').then(drawNow).catch(function () { /* next time */ });
  }
  if (now) {
    window.addEventListener('patv:slot', function (ev) {
      var s = ev.detail;
      var was = libSlot;
      libSlot = s && s.library ? s : null;
      now.classList.toggle('hide', !libSlot);
      if (libSlot && !was) { pollNow(); timer = setInterval(pollNow, 4000); }
      if (!libSlot && timer) { clearInterval(timer); timer = null; }
    });
    now.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-act]');
      if (!b) return;
      var r = now.getAttribute('data-room'), act = b.getAttribute('data-act');
      var cur = Number(now.getAttribute('data-pos')) || 0;
      var call;
      if (act === 'stop') { if (!confirm(_t('js.plex.q_stop', 'Stop it and end the library slot?'))) return; call = api('POST', '/api/medialib/stop', { room: r }); }
      else if (act === 'pause') call = api('POST', '/api/medialib/pause', { room: r });
      else if (act === 'resume') call = api('POST', '/api/medialib/resume', { room: r });
      else if (act === 'back' || act === 'fwd') call = api('POST', '/api/medialib/seek', { room: r, offset: Math.max(0, cur + (act === 'fwd' ? 600 : -600)) });
      else if (act === 'seek') {
        var t = parseTime(now.querySelector('[data-seek]').value);
        if (t == null) { $('slotMsg').textContent = _t('js.plex.seek_fmt', 'Type a time like 1:02:30.'); return; }
        call = api('POST', '/api/medialib/seek', { room: r, offset: t });
      }
      b.disabled = true;
      $('slotMsg').textContent = _t('js.plex.working', 'Working…');
      call.then(function () { $('slotMsg').textContent = act === 'stop' ? _t('js.plex.stopped', 'Stopped.') : _t('js.plex.done', 'Done.'); pollNow(); if (window.PATVStageRefresh) window.PATVStageRefresh(); })
        .catch(function (e) { $('slotMsg').textContent = e.message; })
        .then(function () { b.disabled = false; });
    });
    if (window.PATVStageSlot) { try { window.dispatchEvent(new CustomEvent('patv:slot', { detail: window.PATVStageSlot })); } catch (e) { /* old browser */ } }
  }
  onMode();
})();
