// pad-challenges.js - 1.99wu: the 🎤 Mic challenges card on a pad's About tab (views/room.ejs #challenges; economy v2 E-8).
// GET /api/rooms/:slug/challenges (challengepay.js): the last 20 judged performances Pepe reported (a name only when the
// performer wasn't incognito) and today's prize budget out of the pad vault. The card stays hidden until there is a
// performance to show. Every value goes in via textContent.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var card = document.getElementById('challenges');
  if (!card) return;
  var slug = card.getAttribute('data-slug');
  var list = card.querySelector('[data-pc="list"]');
  var budget = card.querySelector('[data-pc="budget"]');
  function fmt(n) { return Number(n || 0).toLocaleString(window.PATV_I18N && PATV_I18N.lang || undefined); }
  var EMOJI = { moan: '🫦', sing: '🎤', laugh: '😂', fart: '💨', beatbox: '🥁', impression: '🎭' };
  fetch('/api/rooms/' + encodeURIComponent(slug) + '/challenges', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !j.ok || !Array.isArray(j.runs) || !j.runs.length) return;
      var who = function (n) { return n || _t('js.padchal.someone', 'someone 🕶️'); };
      j.runs.forEach(function (r) {
        var li = document.createElement('li');
        var when = new Date(Number(r.ts) || 0);
        var head = (EMOJI[r.cat] || '🎤') + ' ' + (r.mode === 'h2h'
          ? _t('js.padchal.vs', '{a} vs {b}', { a: who(r.name), b: who(r.vs_name) }) : who(r.name));
        var score = r.score != null ? ' · ' + Number(r.score) + '/10' + (r.mode === 'h2h' && r.vs_score != null ? ' – ' + Number(r.vs_score) + '/10' : '') : '';
        var prize = ' · ' + (r.paid > 0 ? _t('js.padchal.won', '+{paid} PAT', { paid: fmt(r.paid) }) : _t('js.padchal.glory', 'for glory'));
        var fee = r.fee > 0 ? ' · ' + _t('js.padchal.fee', 'entry fee {fee} PAT', { fee: fmt(r.fee) }) : '';
        li.textContent = head + score + prize + fee + ' · ' + when.toLocaleString(window.PATV_I18N && PATV_I18N.lang || undefined, { dateStyle: 'short', timeStyle: 'short' });
        list.appendChild(li);
      });
      if (j.budget && budget) {
        budget.textContent = _t('js.padchal.budget', 'Prize budget left today: {left} PAT from the pad vault ({held} PAT held for performances being judged).',
                                { left: fmt(j.budget.left), held: fmt(j.budget.held) });
      }
      card.hidden = false;
    })
    .catch(function () { /* the card stays hidden */ });
})();
