// public/js/pad-plexq.js — 1.99lr: the pad page's Go-live card shows a 📼 queue playing on this pad's stage (mediaqueue.js
// padView): what's on, what's next; and, for whoever started it (and the library admins), ⏮ / ⏸ ▶ / ⏭ / ⏹.
(function () {
  'use strict';
  var box = document.getElementById('rmPlexQ');
  if (!box) return;
  var room = box.getAttribute('data-room');
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
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
  var timer = null, last = null;
  function draw(j) {
    last = j;
    var q = j.queue;
    box.hidden = !q;
    if (!q) return;
    var h = '<div class="pq-now"><b>' + esc(_t('js.plexq.now', '📼 Now playing: {title}', { title: label(q.now) })) + '</b> <span class="muted">· ' +
      esc(_t('js.plexq.pos', '{n} of {count}', { n: q.pos + 1, count: q.count })) + (j.state === 'paused' ? ' · ' + esc(_t('js.plexq.paused', 'paused')) : '') + '</span></div>';
    if (q.next && q.next.length) {
      h += '<div class="pq-next"><span class="muted">' + esc(_t('js.plexq.up_next', 'Up next:')) + '</span> ' +
        q.next.slice(0, 3).map(function (x) { return esc(label(x)); }).join(' · ') + (q.next.length > 3 ? ' <span class="muted">' + esc(_t('js.plexq.more', '+{n} more', { n: q.next.length - 3 })) + '</span>' : '') + '</div>';
    }
    if (j.can_control) {
      h += '<div class="pq-ctl">' +
        '<button type="button" class="sact" data-q="prev"' + (q.pos > 0 ? '' : ' disabled') + '>' + esc(_t('js.plexq.prev', '⏮ Previous')) + '</button>' +
        (j.state === 'paused' ? '<button type="button" class="sact" data-q="resume">' + esc(_t('js.plexq.resume', '▶ Resume')) + '</button>'
                              : '<button type="button" class="sact" data-q="pause">' + esc(_t('js.plexq.pause', '⏸ Pause')) + '</button>') +
        '<button type="button" class="sact" data-q="next"' + (q.pos < q.count - 1 ? '' : ' disabled') + '>' + esc(_t('js.plexq.next', 'Next ⏭')) + '</button>' +
        '<button type="button" class="sact" data-q="stop">' + esc(_t('js.plexq.stop', '⏹ Stop the queue')) + '</button>' +
        '<a class="sact" href="/stage">' + esc(_t('js.plexq.manage', 'Edit the queue ›')) + '</a></div>' +
        '<p class="pq-msg muted" role="status" aria-live="polite"></p>';
    }
    box.innerHTML = h;
  }
  function poll() {
    if (document.hidden) return;
    api('GET', '/api/medialib/queue/pad?room=' + encodeURIComponent(room)).then(function (j) {
      draw(j);
      clearInterval(timer);
      timer = setInterval(poll, j.queue ? 15000 : 60000);
    }).catch(function () { box.hidden = true; });
  }
  box.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-q]');
    if (!b || !last) return;
    var act = b.getAttribute('data-q');
    if (act === 'stop' && !confirm(_t('js.plexq.q_stop', 'Stop the queue and end the library slot?'))) return;
    var url = { prev: '/api/medialib/queue/prev', next: '/api/medialib/queue/next', pause: '/api/medialib/pause', resume: '/api/medialib/resume', stop: '/api/medialib/stop' }[act];
    var msg = box.querySelector('.pq-msg');
    b.disabled = true;
    if (msg) msg.textContent = _t('js.plexq.working', 'Working…');
    api('POST', url, { room: last.room || room }).then(function () { if (msg) msg.textContent = ''; setTimeout(poll, 1500); })
      .catch(function (e) { if (msg) msg.textContent = e.message; b.disabled = false; });
  });
  poll();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
