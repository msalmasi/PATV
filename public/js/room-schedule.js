// room-schedule.js — the schedule half of a pad's Go live card (1.99bx, views/partials/room-schedule.ejs; 1.99dx:
// merged into the Stage card; 1.99ee: its own Go live card under the Stage card) - it also keeps the card's slot
// status line, #rmSlotsTxt, and the 🚀 boost line, #rmBoostTxt, current.
// Puts every time in the viewer's local timezone and refreshes the card every 30 s from
// GET /api/rooms/:slug/stage (its `schedule`: mainstage.roomSchedule - pending requests only for the
// room's managers and the person who asked). Everything from the server goes in via textContent.
(function () {
  'use strict';
  var box = document.getElementById('rmSched');
  if (!box) return;
  var slug = box.getAttribute('data-slug');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function day(d) {
    var t = new Date(), y = new Date(Date.now() + 86400000);
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function hm(d) { return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  function localize(root) {
    root.querySelectorAll('time[data-ts]').forEach(function (t) {
      var d = new Date(Number(t.getAttribute('data-ts')));
      if (isNaN(d)) return;
      if (t.getAttribute('data-fmt') === 't') { t.textContent = hm(d); return; }
      var m = Number(t.getAttribute('data-min')) || 0;
      t.textContent = day(d) + ' ' + hm(d) + (m ? '–' + hm(new Date(d.getTime() + m * 60000)) : '');
    });
  }
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) document.getElementById('rsTz').textContent = ' (' + tz.replace(/_/g, ' ') + ')';
  } catch (e) { /* no Intl */ }
  localize(box);

  function tags(r, pend) {
    var s = el('span', 'tags');
    s.appendChild(el('span', 'tg' + (r.featured ? ' feat' : ''), r.featured ? '★ Featured' : 'Ordinary slot'));
    s.appendChild(el('span', 'tg', r.mode === 'embed' ? '▶ ' + (r.embed_label || 'Video link') : '🎥 Stream'));
    if (pend) s.appendChild(el('span', 'tg pend', '⏳ Waiting for the owner\'s OK'));
    if (r.mine) s.appendChild(el('span', 'tg you', 'You'));
    return s;
  }
  function who(r) {
    var s = el('span', 'who'), b = el('b');
    // 1.99dt: the booker's PATV profile (the server only sends a same-site /u/<name> href - 1.99dv; was /u/<name>/profile)
    if (r.href && /^\/u\/[^/]+(\/profile)?$/.test(r.href)) { var a = el('a', 'ulink', r.display); a.href = r.href; if (r.username) a.title = r.username; b.appendChild(a); }
    else b.textContent = r.display;
    s.appendChild(b);
    if (r.title) s.appendChild(el('span', 'ttl', r.title));
    return s;
  }
  function time(ms, min, fmt) {
    var t = el('time'); t.setAttribute('data-ts', String(ms)); t.dateTime = new Date(ms).toISOString();
    if (min) t.setAttribute('data-min', String(min));
    if (fmt) t.setAttribute('data-fmt', fmt);
    return t;
  }
  function list(id, rows, empty, make) {
    var ul = document.getElementById(id);
    ul.textContent = '';
    if (!rows.length) { ul.appendChild(empty()); return; }
    rows.forEach(function (r) { ul.appendChild(make(r)); });
  }
  function bookLink(text) { var a = el('a', null, text); a.href = '/stage?room=' + encodeURIComponent(slug) + '#whenSet'; return a; }
  function render(S) {
    list('rsLive', S.live || [], function () { return el('li', 'empty', 'Nothing on this stage right now.'); }, function (r) {
      var li = el('li', 'srow' + (r.live ? ' live' : '') + (r.mine ? ' mine' : ''));
      var w = el('span', 'when', (r.live ? '● LIVE' : 'Starting') + ' · until '); w.appendChild(time(r.ends_by, 0, 't'));
      li.appendChild(w); li.appendChild(who(r)); li.appendChild(tags(r, false));
      return li;
    });
    list('rsUp', S.upcoming || [], function () {
      var li = el('li', 'empty', 'Nothing booked yet — '); li.appendChild(bookLink('book the first slot')); li.appendChild(document.createTextNode('.')); return li;
    }, function (r) {
      var pend = r.status === 'requested';
      var li = el('li', 'srow' + (pend ? ' pend' : '') + (r.mine ? ' mine' : ''));
      var w = el('span', 'when'); w.appendChild(time(r.start_at, r.minutes)); w.appendChild(document.createTextNode(' · ' + r.minutes + ' min'));
      li.appendChild(w); li.appendChild(who(r)); li.appendChild(tags(r, pend));
      return li;
    });
    list('rsQ', S.queue || [], function () { return el('li', 'empty', 'Nobody waiting — a free slot goes to the next in line.'); }, function (r) {
      var li = el('li', 'srow' + (r.mine ? ' mine' : ''));
      li.appendChild(el('span', 'when', '#' + r.position + ' · ' + r.minutes + ' min'));
      li.appendChild(who(r)); li.appendChild(tags(r, false));
      return li;
    });
    localize(box);
  }
  // the Go live card's status line: "🎬 1/2 slots in use · 3 waiting · free slots" (same words as views/room.ejs)
  function slots(d) {
    var t = document.getElementById('rmSlotsTxt');
    if (t && d.room) {
      var n = Number(d.room.slot_count) || 1, q = d.queue && d.queue.length ? d.queue.length : 0, price = Number(d.room.slot_price) || 0;
      t.textContent = '🎬 ' + (Number(d.open) || 0) + '/' + n + ' slot' + (n === 1 ? '' : 's') + ' in use' + (q ? ' · ' + q + ' waiting' : '')
        + (price ? ' · ' + price.toLocaleString('en-US') + ' PAT/min' : ' · free slots');
    }
    // 1.99ee: the boost line ("🚀 boosted · N PAT in the last hour"; hidden at 0) - "Get featured" is gone
    var bt = document.getElementById('rmBoostTxt');
    if (bt && d.boost) {
      var n = Number(d.boost.last_hour) || 0;
      bt.hidden = n <= 0;
      var bb = bt.querySelector('b');
      if (bb) bb.textContent = n.toLocaleString('en-US');
    }
  }
  var timer = null;
  function poll() {
    clearTimeout(timer); timer = null;
    if (document.hidden) return;
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/stage', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok && d.schedule) render(d.schedule); if (d && d.ok) slots(d); })
      .catch(function () { /* keep what's shown */ })
      .then(function () { timer = setTimeout(poll, 30000); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !timer) poll(); });
  timer = setTimeout(poll, 30000);
})();
