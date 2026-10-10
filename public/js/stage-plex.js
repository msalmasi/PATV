// /stage — 1.99jn: "📼 Play from Plex" in the Go-live flow (views/stageBook.ejs, medialib.js /api/medialib/*).
//   * the third "What you're putting on" choice: search the Plex library, pick a movie / an episode, see the price,
//     confirm -> it plays in a 📼 library slot on the pad picked above (the price is held, routed once it's on the
//     stage, refunded if it never gets there);
//   * the slot owner's controls in "Your slot" while their open slot is a library slot: pause / resume / ±10 min /
//     seek / stop (stage-book.js tells us about the open slot with the patv:slot event).
(function () {
  'use strict';
  var root = document.getElementById('sb');
  if (!root || root.getAttribute('data-signed') !== '1') return;
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
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
  // -> resolves the JSON; rejects with an Error carrying .data (the JSON: error, price…)
  function api(method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }).then(function (j) {
        if (!r.ok || j.ok === false) { var e = new Error(j.error || ('HTTP ' + r.status)); e.data = j; throw e; }
        return j;
      });
    });
  }
  function roomId() { var o = $('room') && $('room').selectedOptions[0]; return o ? (o.getAttribute('data-id') || o.value) : ''; }
  function roomTitle() { var o = $('room') && $('room').selectedOptions[0]; return o ? o.getAttribute('data-title') : 'this pad'; }

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
    var PER_HOUR = Number(panel.getAttribute('data-per-hour')) || 0;
    var QUALITY = Number(panel.getAttribute('data-quality')) || 720;
    var picked = null, quote = null;
    var say = function (t, good) { $('plexMsg').textContent = t || ''; $('plexMsg').style.color = good ? '#9ccc65' : ''; };
    // the same rule as the server (medialib.priceFor): per started hour of what's left from the start point, >= 1 h
    var priceAt = function (dur, off) {
      if (FREE || !PER_HOUR) return 0;
      var left = Math.max(0, (Number(dur) || 0) - Math.max(0, off || 0));
      return PER_HOUR * Math.max(1, Math.ceil(left / 3600));
    };
    var info = function () {
      api('GET', '/api/medialib/mine?room=' + encodeURIComponent(roomId())).then(function (j) {
        var bits = [];
        if (j.streams && j.streams.max) bits.push('📼 ' + j.streams.used + ' of ' + j.streams.max + ' library streams in use right now');
        if (j.daily_left != null) bits.push(j.daily_left + ' of ' + j.daily_cap + ' plays left today');
        if (j.access && j.access.until) bits.push('your Plex access runs until ' + new Date(j.access.until).toLocaleDateString());
        $('plexInfo').textContent = bits.join(' · ');
      }).catch(function (e) { $('plexInfo').textContent = e.message; });
    };
    window.PATVPlexInfo = info;
    var card = function (it) {
      var sub = it.type === 'episode' ? (esc(it.show) + ' · S' + it.season + 'E' + it.episode) : it.type === 'show' ? 'Show' + (it.leafs ? ' · ' + it.leafs + ' episodes' : '') : (it.year || 'Movie');
      return '<button type="button" class="px-it" data-key="' + esc(it.key) + '">' +
        (it.poster ? '<img loading="lazy" alt="" src="/api/medialib/poster/' + encodeURIComponent(it.key) + '">' : '<span class="px-ph"></span>') +
        '<b>' + esc(it.title) + '</b><small>' + sub + (it.duration ? ' · ' + hms(it.duration) : '') + '</small></button>';
    };
    $('plexSearch').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = $('plexSearch').q.value.trim();
      if (q.length < 2) { say('Type at least 2 characters.'); return; }
      say('Searching…', true);
      $('plexPick').classList.add('hide');
      api('GET', '/api/medialib/search?q=' + encodeURIComponent(q)).then(function (j) {
        $('plexResults').innerHTML = (j.results || []).map(card).join('') || '<p class="muted">Nothing found.</p>';
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
      var left = Math.max(0, (picked.duration || 0) - off);
      $('plexPick').querySelector('[data-price]').innerHTML = quote
        ? 'Price: <b>' + fmt(quote) + ' PAT</b> <span class="muted">· ' + Math.max(1, Math.ceil(left / 3600)) + ' started hour' + (left > 3600 ? 's' : '') + ' × ' + fmt(PER_HOUR) + ' · you have ' + esc($('bal') ? $('bal').textContent : '?') + '</span>'
        : '<b>Free</b> <span class="muted">(site admin)</span>';
      $('plexPick').querySelector('[data-play]').textContent = '▶ Play on ' + roomTitle() + (quote ? ' for ' + fmt(quote) + ' PAT' : '');
    };
    var openItem = function (key) {
      say('Loading…', true);
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
          var su = '<option value="">None</option>' + (it.subs || []).filter(function (s) { return s.burnable; }).map(function (s) {
            return '<option value="' + s.index + '">' + esc(s.label) + (s.forced ? ' (forced)' : '') + '</option>';
          }).join('');
          h += '<div class="row">' +
            '<label>Quality <select data-q>' + q + '</select></label>' +
            (au ? '<label>Audio <select data-a>' + au + '</select></label>' : '') +
            '<label>Subtitles (burnt in) <select data-s>' + su + '</select></label>' +
            '<label>Start at <input type="text" data-o value="0:00" inputmode="numeric" aria-label="Start at (h:mm:ss)"></label>' +
            '</div>' +
            (it.hdr ? '<p class="muted" style="margin:0">HDR: shown in SDR, at up to 720p.</p>' : '') +
            '<div class="px-price" data-price></div>' +
            '<div class="row"><button type="button" class="btn primary" data-play>▶ Play</button></div>';
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
      if (off == null) { say('Type the start time like 1:02:30.'); return; }
      var a = pk.querySelector('[data-a]'), s = pk.querySelector('[data-s]');
      var price = confirmed != null ? confirmed : priceAt(picked.duration, off);
      var what = (picked.type === 'episode' ? picked.show + ' S' + picked.season + 'E' + picked.episode : picked.title);
      if (!confirm('Play "' + what + '" on ' + roomTitle() + '\'s stage' + (off ? ' from ' + hms(off) : '') + '?\n\n' +
                   (price ? 'It costs ' + fmt(price) + ' PAT, taken now. If it never gets on the stage, it all comes back.\n\n' : '') +
                   'Only show what we have the rights to show - every play is logged.')) return;
      var body = { room: roomId(), key: picked.key, quality: Number(pk.querySelector('[data-q]').value), offset: off,
                   audio: a ? a.value : null, sub: s && s.value !== '' ? s.value : null };
      if (price) body.price = price;
      btn.disabled = true;
      say('Starting… (opening a library slot and the encoder)', true);
      api('POST', '/api/medialib/play', body).then(function (j) {
        say('▶ ' + j.title + ' is starting on ' + roomTitle() + ' - it shows on the stage within a few seconds.' + (j.price ? ' ' + fmt(j.price) + ' PAT paid.' : ''), true);
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
    if (!s) { now.innerHTML = '<p class="muted" style="margin:0">📼 Starting the library stream…</p>'; return; }
    var pct = s.duration ? Math.min(100, 100 * (s.position || 0) / s.duration) : 0;
    var paused = s.state === 'paused';
    now.setAttribute('data-room', s.room);
    now.setAttribute('data-pos', Math.floor(s.position || 0));
    now.innerHTML = '<div><b>📼 ' + esc(s.title) + '</b> <span class="muted">· ' + esc(s.state) + (s.price ? ' · ' + fmt(s.price) + ' PAT' + (s.charge === 'held' ? ' (held until it\'s on the stage)' : '') : '') + '</span></div>' +
      '<div class="px-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
      '<div class="muted">' + hms(s.position) + (s.duration ? ' / ' + hms(s.duration) : '') + (s.error ? ' · <span style="color:#ff8a80">' + esc(s.error) + '</span>' : '') +
        (paused ? ' · paused: it ends if it stays paused ' + esc(root.querySelector('#plexPanel') ? root.querySelector('#plexPanel').getAttribute('data-pause') : '30') + ' min' : '') + '</div>' +
      '<div class="row">' +
        (paused ? '<button type="button" class="btn primary" data-act="resume">▶ Resume</button>' : '<button type="button" class="btn" data-act="pause">⏸ Pause</button>') +
        '<button type="button" class="btn" data-act="back">⏪ 10 min</button><button type="button" class="btn" data-act="fwd">10 min ⏩</button>' +
        '<input type="text" inputmode="numeric" placeholder="h:mm:ss" aria-label="Seek to" data-seek><button type="button" class="btn" data-act="seek">Seek</button>' +
        '<button type="button" class="btn danger" data-act="stop">⏹ Stop</button>' +
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
      if (act === 'stop') { if (!confirm('Stop it and end the library slot?')) return; call = api('POST', '/api/medialib/stop', { room: r }); }
      else if (act === 'pause') call = api('POST', '/api/medialib/pause', { room: r });
      else if (act === 'resume') call = api('POST', '/api/medialib/resume', { room: r });
      else if (act === 'back' || act === 'fwd') call = api('POST', '/api/medialib/seek', { room: r, offset: Math.max(0, cur + (act === 'fwd' ? 600 : -600)) });
      else if (act === 'seek') {
        var t = parseTime(now.querySelector('[data-seek]').value);
        if (t == null) { $('slotMsg').textContent = 'Type a time like 1:02:30.'; return; }
        call = api('POST', '/api/medialib/seek', { room: r, offset: t });
      }
      b.disabled = true;
      $('slotMsg').textContent = 'Working…';
      call.then(function () { $('slotMsg').textContent = act === 'stop' ? 'Stopped.' : 'Done.'; pollNow(); if (window.PATVStageRefresh) window.PATVStageRefresh(); })
        .catch(function (e) { $('slotMsg').textContent = e.message; })
        .then(function () { b.disabled = false; });
    });
    if (window.PATVStageSlot) { try { window.dispatchEvent(new CustomEvent('patv:slot', { detail: window.PATVStageSlot })); } catch (e) { /* old browser */ } }
  }
  onMode();
})();
