// bingo-page.js — 1.99abn: the live 🎱 Bingo page (views/bingo.ejs, bingo.js). Draws the state the page shipped with,
// then polls GET /api/bingo/state (every 3 s while a game runs, 15 s otherwise; paused while the tab is hidden).
// Everything is text-safe (textContent / esc); the viewer's cards come from the server only for their own login.
(function () {
  'use strict';
  var T = window.BINGO_T || {}, S = window.BINGO || {}, lastBall = null, timer = null;
  var L = 'BINGO';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return Number(n || 0).toLocaleString(); };
  var sub = function (s, k, v) { return String(s || '').split(k).join(v); };

  function phase(g) {
    var el = $('bgPhase'); if (!el) return;
    if (!g) { el.innerHTML = '<p class="bg-note" style="margin-top:12px">' + esc(T.none) + ' <span>' + T.none_hint + '</span></p>'; return; }
    var live = g.phase === 'lobby' || g.phase === 'running';
    var txt = T[g.phase] || g.phase;
    if (g.phase === 'lobby' && g.lobby_until) {
      var s = Math.max(0, Math.round((g.lobby_until - Date.now()) / 1000));
      if (s > 0) txt += ' · ' + sub(T.starts_in, '%S%', s);
    }
    el.innerHTML = '<span class="bg-phase' + (live ? ' live' : '') + '">' + esc(txt) + '</span> <span class="bg-note" style="display:inline">' +
      esc(sub(T.in_room, '%ROOM%', g.room || '')) + '</span>';
  }
  function ball(g) {
    var el = $('bgBall'); if (!el) return;
    var n = g && g.last;
    if (!n) { el.className = 'bg-ball empty'; el.innerHTML = '<div><b>' + esc(T.no_ball) + '</b></div>'; lastBall = null; return; }
    el.className = 'bg-ball' + (n !== lastBall && lastBall !== null ? ' pop' : '');
    el.setAttribute('aria-label', T.last_ball + ': ' + L[Math.floor((n - 1) / 15)] + ' ' + n);
    el.innerHTML = '<div><small>' + L[Math.floor((n - 1) / 15)] + '</small><b>' + n + '</b></div>';
    lastBall = n;
  }
  function pills(g) {
    var el = $('bgPills'); if (!el) return;
    if (!g) { el.innerHTML = ''; return; }
    var p = g.pot || {}, out = [];
    out.push([T.pot, fmt(p.total) + ' ' + T.pat]);
    out.push([T.line, fmt(g.prizes ? g.prizes.line : p.line)]);
    out.push([T.full, fmt(g.prizes ? g.prizes.blackout : (p.blackout || 0) + (p.rollover || 0))]);
    out.push([T.price, fmt(g.price)]);
    out.push([T.players, fmt((g.players || []).length)]);
    out.push([T.called, (g.called || []).length + ' / 75']);
    el.innerHTML = out.map(function (x) { return '<span class="bg-pill">' + esc(x[0]) + '<b>' + esc(x[1]) + '</b></span>'; }).join('');
  }
  function winners(g) {
    var el = $('bgWinners'); if (!el) return;
    var rows = [];
    if (g && g.line_winners && g.line_winners.length) rows.push(sub(T.winners_line, '%NAMES%', esc(g.line_winners.join(', '))));
    if (g && g.blackout_winners && g.blackout_winners.length) rows.push(sub(T.winners_full, '%NAMES%', esc(g.blackout_winners.join(', '))));
    if (g && g.phase === 'cancelled' && g.why) rows.push(sub(T.cancelled_why, '%WHY%', esc(g.why)));
    el.hidden = !rows.length;
    el.innerHTML = rows.length ? '<div class="bg-win">' + rows.map(function (r) { return '<p>🎉 ' + r + '</p>'; }).join('') + '</div>' : '';
  }
  function board(g) {
    var el = $('bgBoard'); if (!el) return;
    var on = {}; ((g && g.called) || []).forEach(function (n) { on[n] = 1; });
    var last = g && g.last, h = '';
    for (var r = 0; r < 5; r++) {
      h += '<div class="row r' + r + '"><span class="L r' + r + '">' + L[r] + '</span>';
      for (var i = 1; i <= 15; i++) {
        var n = r * 15 + i;
        h += '<span class="n' + (on[n] ? ' on' : '') + (n === last ? ' last' : '') + '">' + n + '</span>';
      }
      h += '</div>';
    }
    el.innerHTML = h;
    el.setAttribute('aria-label', T.called + ': ' + ((g && g.called) || []).join(', '));
  }
  function mine(st) {
    var el = $('bgMine'); if (!el) return;
    var g = st.game;
    if (!g) { el.innerHTML = '<p class="bg-note">' + T.none_hint + '</p>'; return; }
    if (!st.signedIn) { el.innerHTML = '<p class="bg-note"><a href="/login?next=/bingo">' + esc(T.sign_in) + '</a></p>'; return; }
    if (!st.linked) { el.innerHTML = '<p class="bg-note"><a href="/settings/account#connections">' + esc(T.link) + '</a></p>'; return; }
    if (!st.me || !st.me.cards.length) { el.innerHTML = '<p class="bg-note">' + esc(T.not_playing) + ' ' + (g.phase === 'lobby' ? T.join_hint : '') + '</p>'; return; }
    var on = {}; (g.called || []).forEach(function (n) { on[n] = 1; });
    el.innerHTML = '<div class="bg-cards">' + st.me.cards.map(function (c, k) {
      var ready = c.full ? T.full_ready : (c.line && !g.line_won ? T.line_ready : '');
      var h = '<article class="bg-card' + (ready && g.phase === 'running' ? ' ready' : '') + '"><h3><span>' + esc(sub(T.card_n, '%N%', k + 1)) + '</span>' +
        (ready && g.phase === 'running' ? '<em>' + esc(ready) + '</em>' : '') + '</h3><div class="bg-grid">';
      for (var col = 0; col < 5; col++) h += '<span class="h c' + col + '">' + L[col] + '</span>';
      for (var row = 0; row < 5; row++) {
        for (var cc = 0; cc < 5; cc++) {
          var v = c.card[cc][row];
          h += v === 0 ? '<span class="s fr d">' + esc(T.free) + '</span>' : '<span class="s' + (on[v] ? ' d' : '') + '">' + v + '</span>';
        }
      }
      return h + '</div></article>';
    }).join('') + '</div>';
  }
  function players(g) {
    var s = $('bgPlayersS'), el = $('bgPlayers'); if (!s || !el) return;
    var ps = (g && g.players) || [];
    s.hidden = !ps.length;
    el.innerHTML = ps.map(function (p) { return '<li>' + esc(p.name) + ' · ' + esc(sub(T.cards_n, '%N%', p.cards)) + '</li>'; }).join('');
  }
  function draw(st) {
    S = st || {};
    var g = S.game || null;
    phase(g); ball(g); pills(g); winners(g); mine(S); board(g); players(g);
  }
  function refresh() {
    clearTimeout(timer);
    fetch('/api/bingo/state', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) draw(j); })
      .catch(function () { /* next poll */ })
      .then(poll);
  }
  function poll() {
    clearTimeout(timer);
    var g = S.game, live = g && (g.phase === 'lobby' || g.phase === 'running');
    timer = setTimeout(function () { if (document.hidden) poll(); else refresh(); }, live ? 3000 : 15000);
  }
  draw(S);
  poll();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  setInterval(function () { if (S.game && S.game.phase === 'lobby') phase(S.game); }, 1000);
})();
