// /stage — 1.99jn: "📼 Play from Plex" in the Go-live flow (views/stageBook.ejs, medialib.js /api/medialib/*).
//   * the third "What you're putting on" choice: search the Plex library, pick a movie / an episode, see the price,
//     confirm -> it plays in a 📼 library slot on the pad picked above (the price is held, routed once it's on the
//     stage, refunded if it never gets there);
//   * the slot owner's controls in "Your slot" while their open slot is a library slot: pause / resume / ±10 min /
//     seek / stop (stage-book.js tells us about the open slot with the patv:slot event).
// 1.99jp: every string goes through __t (locales/<lang>.json, js.plex.*); Plex members play free (data-member).
// 1.99lr: 📼 QUEUES (mediaqueue.js): an episode can start "the rest of its season" / "its whole season" / "the series from
//   here"; a show can play the whole series; "+ My list" builds a hand-made queue (reorder / remove, then ▶ Play my list).
//   While a queue plays: ⏮ / ⏭, what's left (move / remove), "+ My list" adds to it, and what it has cost / will cost.
// 1.99?? casino2: the search / pick / price / play flow moved to plex-play.js (shared with the Room Dock's 📼 sheet); load it first.
(function () {
  'use strict';
  var root = document.getElementById('sb');
  if (!root || root.getAttribute('data-signed') !== '1') return;
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var $ = function (id) { return document.getElementById(id); };
  // (1.99?? casino2: the shared helpers - plex-play.js)
  var U = window.PATVPlexPlay && window.PATVPlexPlay.util;
  if (!U) return;
  var fmt = U.fmt, esc = U.esc, hms = U.hms, parseTime = U.parseTime, api = U.api, label = U.label;
  function roomId() { var o = $('room') && $('room').selectedOptions[0]; return o ? (o.getAttribute('data-id') || o.value) : ''; }
  function roomTitle() { var o = $('room') && $('room').selectedOptions[0]; return o ? o.getAttribute('data-title') : _t('js.plex.this_pad', 'this pad'); }
  var STATES = { playing: _t('js.plex.st_playing', 'playing'), paused: _t('js.plex.st_paused', 'paused'), starting: _t('js.plex.st_starting', 'starting'),
                 error: _t('js.plex.st_error', 'error'), ended: _t('js.plex.st_ended', 'ended') };
  var myQueue = null;            // my running queue (from /api/medialib/mine), or null
  var pollNow = function () {};

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

  // 1.99?? casino2: the search / pick / price / play flow is plex-play.js (PATVPlexPlay) - one copy for this panel and the Room Dock's
  // 📼 sheet; this file keeps the choice, the room picker and the slot owner's controls below
  var flow = panel && window.PATVPlexPlay ? window.PATVPlexPlay.mount(panel, {
    roomId: roomId, roomTitle: roomTitle, balance: function () { return $('bal') ? $('bal').textContent : '?'; },
    free: panel.getAttribute('data-free') === '1', member: panel.getAttribute('data-member') === '1',
    perHour: Number(panel.getAttribute('data-per-hour')) || 0, quality: Number(panel.getAttribute('data-quality')) || 720,
    queues: panel.getAttribute('data-queue') === '1', days: Number(root.getAttribute('data-days')) || 14, later: true, listId: 'plexList',
    onStarted: function () {
      if (window.PATVStageRefresh) window.PATVStageRefresh();
      var c = $('slotCard'); if (c) setTimeout(function () { c.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 1500);
    },
    pollNow: function () { pollNow(); }
  }) : null;
  var info = flow ? flow.info : function () {};
  var drawPrice = flow ? flow.drawPrice : function () {};
  if (flow) window.PATVPlexInfo = info;
  function noteQueues(j) {
    if (flow) { flow.noteQueues(j); myQueue = flow.myQueue(); return; }
    myQueue = (j.queues || []).filter(function (q) { return q.state === 'active'; })[0] || null;
  }

  // ── the slot owner's controls (a library slot open in "Your slot") ──
  var now = $('plexNow');
  var libSlot = null, timer = null;
  function drawQueue(q) {
    if (!q) return '';
    var h = '<div class="pxq"><div><b>' + esc(_t('js.plex.q_pos', '📋 Title {n} of {count}', { n: q.pos + 1, count: q.count })) + '</b>' +
      (q.left_sec ? ' <span class="muted">· ' + esc(_t('js.plex.q_left', '{time} left in the queue', { time: hms(q.left_sec) })) + '</span>' : '') + '</div>';
    if (q.per_hour) {
      h += '<div class="muted">' + esc(_t('js.plex.q_paid', '{hours} h paid ({per} PAT per started hour) · about {more} PAT more as it plays', { hours: q.paid_hours, per: fmt(q.per_hour), more: fmt(q.est_left) })) + '</div>';
      if (q.low) h += '<div class="px-warn">' + esc(_t('js.plex.q_low', 'The next title needs {need} PAT and you have {bal} - top up to keep watching, or the queue stops after this one.', { need: fmt(q.next_charge), bal: fmt(q.balance) })) +
                      ' <a href="/wallet">' + esc(_t('js.plex.q_topup', 'Top up ›')) + '</a></div>';
    }
    if (q.next && q.next.length) {
      h += '<details class="pxq-next"' + (q.next.length <= 6 ? ' open' : '') + '><summary>' + esc(_t('js.plex.q_up_next', 'Up next ({count})', { count: q.next.length })) + '</summary><ol>' +
        q.next.map(function (x, k) {
          return '<li><span>' + esc(label(x)) + (x.duration ? ' <span class="muted">' + hms(x.duration) + '</span>' : '') + '</span><span class="px-ctl">' +
            '<button type="button" class="btn sm" data-qmove="' + x.index + '" data-to="' + (x.index - 1) + '" aria-label="' + esc(_t('js.plex.q_up', 'Move up')) + '"' + (k ? '' : ' disabled') + '>↑</button>' +
            '<button type="button" class="btn sm" data-qmove="' + x.index + '" data-to="' + (x.index + 1) + '" aria-label="' + esc(_t('js.plex.q_down', 'Move down')) + '"' + (k < q.next.length - 1 ? '' : ' disabled') + '>↓</button>' +
            '<button type="button" class="btn sm" data-qrm="' + x.index + '" aria-label="' + esc(_t('js.plex.q_remove', 'Remove')) + '">✕</button></span></li>';
        }).join('') + '</ol></details>';
    }
    return h + '</div>';
  }
  function drawNow(j) {
    noteQueues(j);
    var s = (j.sessions || []).filter(function (x) { return libSlot && x.slot_id === libSlot.id; })[0] || (j.sessions || [])[0];
    var q = myQueue;
    if (!s && q) {
      // 1.99lr: between two titles
      now.setAttribute('data-room', q.room);
      now.innerHTML = '<div><b>📼 ' + esc(label(q.now)) + '</b> <span class="muted">· ' + esc(_t('js.plex.q_between', 'starting the next title…')) + '</span></div>' + drawQueue(q) +
        '<div class="row"><button type="button" class="btn danger" data-act="stop">' + esc(_t('js.plex.q_stop_q', '⏹ Stop the queue')) + '</button></div>';
      return;
    }
    if (!s) { now.innerHTML = '<p class="muted" style="margin:0">' + esc(_t('js.plex.now_starting', '📼 Starting the library stream…')) + '</p>'; return; }
    if (q && q.room !== s.room) q = null;
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
        (q ? '<button type="button" class="btn" data-act="prev"' + (q.pos > 0 ? '' : ' disabled') + '>' + esc(_t('js.plex.q_prev', '⏮ Previous')) + '</button>' : '') +
        (paused ? '<button type="button" class="btn primary" data-act="resume">' + esc(_t('js.plex.resume', '▶ Resume')) + '</button>'
                : '<button type="button" class="btn" data-act="pause">' + esc(_t('js.plex.pause', '⏸ Pause')) + '</button>') +
        (q ? '<button type="button" class="btn" data-act="next"' + (q.pos < q.count - 1 ? '' : ' disabled') + '>' + esc(_t('js.plex.q_next', 'Next ⏭')) + '</button>' : '') +
        '<button type="button" class="btn" data-act="back">' + esc(_t('js.plex.back10', '⏪ 10 min')) + '</button><button type="button" class="btn" data-act="fwd">' + esc(_t('js.plex.fwd10', '10 min ⏩')) + '</button>' +
        '<input type="text" inputmode="numeric" placeholder="h:mm:ss" aria-label="' + esc(_t('js.plex.seek_aria', 'Seek to')) + '" data-seek><button type="button" class="btn" data-act="seek">' + esc(_t('js.plex.seek', 'Seek')) + '</button>' +
        '<button type="button" class="btn danger" data-act="stop">' + esc(q ? _t('js.plex.q_stop_q', '⏹ Stop the queue') : _t('js.plex.stop', '⏹ Stop')) + '</button>' +
      '</div>' + drawQueue(q);
  }
  if (now) {
    pollNow = function () {
      if (!libSlot || document.hidden) return;
      var open = now.querySelector('details.pxq-next');
      var keepOpen = open ? open.open : null;
      api('GET', '/api/medialib/mine').then(function (j) {
        drawNow(j);
        var d = now.querySelector('details.pxq-next');
        if (d && keepOpen != null) d.open = keepOpen;
      }).catch(function () { /* next time */ });
    };
    window.addEventListener('patv:slot', function (ev) {
      var s = ev.detail;
      var was = libSlot;
      libSlot = s && s.library ? s : null;
      now.classList.toggle('hide', !libSlot);
      if (libSlot && !was) { pollNow(); timer = setInterval(pollNow, 4000); }
      if (!libSlot && timer) { clearInterval(timer); timer = null; if (panel) info(); }
    });
    now.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-act], button[data-qmove], button[data-qrm]');
      if (!b) return;
      var r = now.getAttribute('data-room'), act = b.getAttribute('data-act');
      var cur = Number(now.getAttribute('data-pos')) || 0;
      var call;
      if (b.hasAttribute('data-qmove')) call = api('POST', '/api/medialib/queue/edit', { room: r, op: 'move', index: +b.getAttribute('data-qmove'), to: +b.getAttribute('data-to') });
      else if (b.hasAttribute('data-qrm')) call = api('POST', '/api/medialib/queue/edit', { room: r, op: 'remove', index: +b.getAttribute('data-qrm') });
      else if (act === 'stop') {
        if (!confirm(myQueue ? _t('js.plex.q_stop_confirm', 'Stop the queue and end the library slot?') : _t('js.plex.q_stop', 'Stop it and end the library slot?'))) return;
        call = api('POST', '/api/medialib/stop', { room: r });
      }
      else if (act === 'next') call = api('POST', '/api/medialib/queue/next', { room: r });
      else if (act === 'prev') call = api('POST', '/api/medialib/queue/prev', { room: r });
      else if (act === 'pause') call = api('POST', '/api/medialib/pause', { room: r });
      else if (act === 'resume') call = api('POST', '/api/medialib/resume', { room: r });
      else if (act === 'back' || act === 'fwd') call = api('POST', '/api/medialib/seek', { room: r, offset: Math.max(0, cur + (act === 'fwd' ? 600 : -600)) });
      else if (act === 'seek') {
        var t = parseTime(now.querySelector('[data-seek]').value);
        if (t == null) { $('slotMsg').textContent = _t('js.plex.seek_fmt', 'Type a time like 1:02:30.'); return; }
        call = api('POST', '/api/medialib/seek', { room: r, offset: t });
      }
      if (!call) return;
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
