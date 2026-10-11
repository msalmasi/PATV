// public/js/pad-plexq.js — 1.99lw: the pad page's 📼 PLAYER ("DJ controls") for whatever plays from Plex on this pad's
// stage (medialib.player: /api/medialib/player). Everyone who sees the pad gets the title, the progress bar and the times
// (read-only); whoever started it, the pad's owner and the admins (medialib.mayControl - checked again on the server for
// every action) also get play / pause, −30 s / −10 s / +10 s / +30 s, a scrubber to jump, previous / next, stop, the
// queue (move / remove) and the last few control actions (who paused, who seeked). Seeking restarts the encoder at the
// new time on the same slot and key: viewers see a short reconnect.
(function () {
  'use strict';
  var box = document.getElementById('rmPlexQ');
  if (!box) return;
  var room = box.getAttribute('data-room');
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function hms(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }
  function label(it) {
    if (!it) return '';
    return it.type === 'episode' && it.show ? it.show + ' — S' + (it.season == null ? 0 : it.season) + 'E' + (it.episode == null ? 0 : it.episode) + ' ' + (it.title || '')
      : (it.title || '') + (it.year ? ' (' + it.year + ')' : '');
  }
  function api(method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  var ACTIONS = { pause: _t('js.plexq.l_pause', 'paused'), resume: _t('js.plexq.l_resume', 'resumed'), seek: _t('js.plexq.l_seek', 'jumped'),
                  next: _t('js.plexq.l_next', 'skipped to'), prev: _t('js.plexq.l_prev', 'went back to'), stop: _t('js.plexq.l_stop', 'stopped'),
                  queue_add: _t('js.plexq.l_add', 'added'), queue_remove: _t('js.plexq.l_remove', 'removed'), queue_move: _t('js.plexq.l_move', 'moved') };
  var last = null, base = null, poller = null, ticker = null, dragging = false, busy = false;
  // the position now: the server's, moved on locally while it plays
  function pos() {
    if (!last || !base) return 0;
    var p = last.position || 0;
    if (last.state === 'playing') p += (Date.now() - base) / 1000;
    return last.duration ? Math.min(last.duration, p) : p;
  }
  function drawTimes() {
    if (!last || !last.on) return;
    var p = pos(), d = last.duration || 0;
    var el = box.querySelector('.pq-times');
    if (el) el.innerHTML = '<span>' + hms(p) + '</span><span class="muted">' + (d ? '−' + hms(d - p) + ' · ' + hms(d) : '') + '</span>';
    var r = box.querySelector('.pq-scrub');
    if (r && !dragging) { r.value = Math.floor(p); r.setAttribute('aria-valuetext', hms(p)); }
    var bar = box.querySelector('.pq-bar span');
    if (bar) bar.style.width = (d ? Math.min(100, 100 * p / d) : 0).toFixed(2) + '%';
  }
  function draw(j) {
    last = j; base = Date.now();
    box.hidden = !j.on;
    if (!j.on) { box.innerHTML = ''; return; }
    var q = j.queue, can = j.can_control, paused = j.state === 'paused', d = j.duration || 0;
    var h = '<div class="pq-now"><b>📼 ' + esc(j.title || _t('js.plexq.starting', 'Starting…')) + '</b>' +
      (q ? ' <span class="muted">· ' + esc(_t('js.plexq.pos', '{n} of {count}', { n: q.pos + 1, count: q.count })) + '</span>' : '') +
      (paused ? ' <span class="muted">· ' + esc(_t('js.plexq.paused', 'paused')) + '</span>' : j.state === 'waiting' ? ' <span class="muted">· ' + esc(_t('js.plexq.between', 'next title starting…')) + '</span>' : '') +
      (j.by ? ' <span class="muted">· ' + esc(_t('js.plexq.by', 'started by {name}', { name: j.by })) + '</span>' : '') + '</div>';
    h += can && d
      ? '<input type="range" class="pq-scrub" min="0" max="' + Math.floor(d) + '" step="1" value="0" aria-label="' + esc(_t('js.plexq.scrub', 'Jump to a time')) + '">'
      : '<div class="pq-bar" role="progressbar" aria-label="' + esc(_t('js.plexq.progress', 'Progress')) + '"><span></span></div>';
    h += '<div class="pq-times"></div>';
    if (can) {
      h += '<div class="pq-ctl" role="group" aria-label="' + esc(_t('js.plexq.controls', 'Playback controls')) + '">' +
        (q ? '<button type="button" class="sact" data-q="prev"' + (q.pos > 0 ? '' : ' disabled') + ' aria-label="' + esc(_t('js.plexq.prev_aria', 'Previous title')) + '">⏮</button>' : '') +
        '<button type="button" class="sact" data-skip="-30">−30s</button><button type="button" class="sact" data-skip="-10">−10s</button>' +
        (paused ? '<button type="button" class="sact primary" data-q="resume" aria-label="' + esc(_t('js.plexq.resume', '▶ Resume')) + '">▶</button>'
                : '<button type="button" class="sact" data-q="pause" aria-label="' + esc(_t('js.plexq.pause', '⏸ Pause')) + '">⏸</button>') +
        '<button type="button" class="sact" data-skip="10">+10s</button><button type="button" class="sact" data-skip="30">+30s</button>' +
        (q ? '<button type="button" class="sact" data-q="next"' + (q.pos < q.count - 1 ? '' : ' disabled') + ' aria-label="' + esc(_t('js.plexq.next_aria', 'Next title')) + '">⏭</button>' : '') +
        '<button type="button" class="sact" data-q="stop" aria-label="' + esc(_t('js.plexq.stop', '⏹ Stop the queue')) + '">⏹</button></div>' +
        '<p class="pq-msg muted" role="status" aria-live="polite"></p>';
    }
    if (q && q.next && q.next.length) {
      h += '<details class="pq-q"' + (can && q.next.length <= 5 ? ' open' : '') + '><summary>' + esc(_t('js.plexq.up_next_n', 'Up next ({count})', { count: q.next.length })) + '</summary><ol>' +
        q.next.map(function (x, k) {
          return '<li><span>' + esc(label(x)) + (x.duration ? ' <span class="muted">' + hms(x.duration) + '</span>' : '') + '</span>' + (can
            ? '<span class="pq-li"><button type="button" class="sact" data-mv="' + x.index + '" data-to="' + (x.index - 1) + '"' + (k ? '' : ' disabled') + ' aria-label="' + esc(_t('js.plex.q_up', 'Move up')) + '">↑</button>' +
              '<button type="button" class="sact" data-mv="' + x.index + '" data-to="' + (x.index + 1) + '"' + (k < q.next.length - 1 ? '' : ' disabled') + ' aria-label="' + esc(_t('js.plex.q_down', 'Move down')) + '">↓</button>' +
              '<button type="button" class="sact" data-rm="' + x.index + '" aria-label="' + esc(_t('js.plex.q_remove', 'Remove')) + '">✕</button></span>' : '') + '</li>';
        }).join('') + '</ol>' + (can ? '<a class="muted" href="/stage">' + esc(_t('js.plexq.manage', 'Edit the queue ›')) + '</a>' : '') + '</details>';
    }
    if (can && j.log && j.log.length) {
      h += '<details class="pq-log"><summary>' + esc(_t('js.plexq.log', 'Who did what')) + '</summary><ul>' + j.log.map(function (l) {
        var t = new Date(l.ts);
        return '<li><span class="muted">' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + '</span> ' +
          esc(l.username || '?') + ' ' + esc(ACTIONS[l.action] || l.action) + (l.detail ? ' <span class="muted">' + esc(l.detail) + '</span>' : '') + '</li>';
      }).join('') + '</ul></details>';
    }
    var openQ = box.querySelector('details.pq-q'), openL = box.querySelector('details.pq-log');
    var keepQ = openQ ? openQ.open : null, keepL = openL ? openL.open : null;
    box.innerHTML = h;
    if (keepQ != null && box.querySelector('details.pq-q')) box.querySelector('details.pq-q').open = keepQ;
    if (keepL != null && box.querySelector('details.pq-log')) box.querySelector('details.pq-log').open = keepL;
    drawTimes();
  }
  function poll() {
    if (document.hidden || busy || dragging) return;
    api('GET', '/api/medialib/player?room=' + encodeURIComponent(room)).then(function (j) {
      draw(j);
      clearInterval(poller);
      poller = setInterval(poll, j.on ? 4000 : 30000);
    }).catch(function () { box.hidden = true; });
  }
  function say(t) { var m = box.querySelector('.pq-msg'); if (m) m.textContent = t || ''; }
  function act(url, body, btn) {
    busy = true;
    if (btn) btn.disabled = true;
    say(_t('js.plexq.working', 'Working…'));
    return api('POST', url, Object.assign({ room: (last && last.room) || room }, body || {}))
      .then(function () { say(''); })
      .catch(function (e) { say(e.message); if (btn) btn.disabled = false; })
      .then(function () { busy = false; setTimeout(poll, 1200); });
  }
  box.addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b || !last || !last.can_control) return;
    if (b.hasAttribute('data-skip')) { act('/api/medialib/seek', { offset: Math.max(0, Math.floor(pos() + Number(b.getAttribute('data-skip')))) }, b); return; }
    if (b.hasAttribute('data-mv')) { act('/api/medialib/queue/edit', { op: 'move', index: +b.getAttribute('data-mv'), to: +b.getAttribute('data-to') }, b); return; }
    if (b.hasAttribute('data-rm')) { act('/api/medialib/queue/edit', { op: 'remove', index: +b.getAttribute('data-rm') }, b); return; }
    var a = b.getAttribute('data-q');
    if (a === 'stop' && !confirm(_t('js.plexq.q_stop', 'Stop the queue and end the library slot?'))) return;
    var url = { prev: '/api/medialib/queue/prev', next: '/api/medialib/queue/next', pause: '/api/medialib/pause', resume: '/api/medialib/resume', stop: '/api/medialib/stop' }[a];
    if (url) act(url, null, b);
  });
  box.addEventListener('input', function (ev) {
    if (!ev.target.classList.contains('pq-scrub')) return;
    dragging = true;
    var el = box.querySelector('.pq-times');
    if (el) el.innerHTML = '<span>→ ' + hms(ev.target.value) + '</span>';
  });
  box.addEventListener('change', function (ev) {
    if (!ev.target.classList.contains('pq-scrub')) return;
    var to = Math.floor(Number(ev.target.value) || 0);
    act('/api/medialib/seek', { offset: to }).then(function () { dragging = false; });
  });
  ticker = setInterval(function () { if (!document.hidden) drawTimes(); }, 1000);
  poll();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
