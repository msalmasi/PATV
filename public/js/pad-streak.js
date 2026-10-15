// pad-streak.js - 1.99zm: the 🔥 pad streak card on a pad's About tab (views/partials/pad-streak-card.ejs; padstreaks.js).
(function () {
  'use strict';
  var card = document.getElementById('padstreak');
  if (!card) return;
  var L = {};
  try { L = JSON.parse(card.querySelector('[data-ps="labels"]').textContent || '{}'); } catch (e) { L = {}; }
  var q = function (k) { return card.querySelector('[data-ps="' + k + '"]'); };
  var fill = function (s, o) { return String(s || '').replace(/\{(\w+)\}/g, function (m, k) { return o[k] != null ? o[k] : m; }); };
  var fmt = function (n) { return (Number(n) || 0).toLocaleString(document.documentElement.lang || 'en'); };
  fetch('/api/rooms/' + encodeURIComponent(card.getAttribute('data-slug')) + '/streak', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok || !j.pad) return;
      var p = j.pad;
      q('cur').textContent = '🔥 ' + fmt(p.current);
      q('cur_l').textContent = fill(L.days, { n: fmt(p.current) });
      q('best').textContent = p.best ? fill(L.best, { n: fmt(p.best) }) : '';
      q('note').textContent = !p.current ? fill(L.none, { n: j.min_users }) : p.todayDone ? L.today_done : p.atRisk ? L.at_risk : '';
      var me = q('me');
      if (j.me) {
        me.textContent = j.me.current ? fill(L.mine, { n: fmt(j.me.current), b: fmt(j.me.best) }) : L.mine_none;
        if (j.me.next) me.textContent += ' · ' + fill(L.next, { n: j.me.next });
      } else me.hidden = true;
      q('rule').textContent = fill(L.rule, { n: j.min_users }) + ' ' + (L.badges || '');
      card.hidden = false;
    })
    .catch(function () {});
})();
