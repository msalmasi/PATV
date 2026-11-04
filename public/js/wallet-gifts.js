// wallet-gifts.js - 1.99?? padppl: the wallet's 🎁 Gifts card (veilgift.js) - gifts sent to you while you were under a frog name. Nothing
// is credited until you accept one (Accept / Accept all); Decline sends it back (on its due day). Accepting adds it to your balance,
// which shows on your profile and the rankings - the card says so. GET /api/gifts; POST /api/gifts/:id/accept|decline, /accept-all.
(function () {
  'use strict';
  var box = document.getElementById('gifts');
  if (!box) return;
  var list = document.getElementById('giftsList'), msg = document.getElementById('giftsMsg'), all = document.getElementById('giftsAll');
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-US'); };
  function day(ms) { try { return new Date(ms).toISOString().slice(0, 10); } catch (e) { return ''; } }
  function load() {
    api('/api/gifts').then(function (d) {
      var gifts = d.gifts || [];
      box.hidden = !d.on && !gifts.length;
      list.textContent = '';
      var pending = gifts.filter(function (g) { return g.state === 'pending'; });
      if (all) all.hidden = pending.length < 2;
      if (!gifts.length) { list.appendChild(el('li', 'info', _t('js.wallet.gifts.none', 'No gifts waiting.'))); return; }
      gifts.forEach(function (g) {
        var li = el('li', 'gift-row' + (g.state === 'pending' ? '' : ' done'));
        li.appendChild(el('b', null, '🎁 ' + fmt(g.amount) + ' PAT'));
        li.appendChild(el('span', 'info', ' ' + _t('js.wallet.gifts.from', 'from @{from}, while you were 🐸 {label} · {day}', { from: g.from || '?', label: g.label, day: day(g.at) })));
        if (g.state === 'pending') {
          var a = el('button', 'btn', _t('js.wallet.gifts.accept', 'Accept')); a.type = 'button';
          var x = el('button', 'btn ghost', _t('js.wallet.gifts.decline', 'Decline')); x.type = 'button';
          a.addEventListener('click', function () { a.disabled = x.disabled = true; api('/api/gifts/' + g.id + '/accept', {}).then(function () { msg.textContent = _t('js.wallet.gifts.accepted', 'Added to your balance.'); load(); }).catch(function (e) { a.disabled = x.disabled = false; msg.textContent = e.message; }); });
          x.addEventListener('click', function () { a.disabled = x.disabled = true; api('/api/gifts/' + g.id + '/decline', {}).then(function () { msg.textContent = _t('js.wallet.gifts.declined', 'Declined - it goes back to them on its due day.'); load(); }).catch(function (e) { a.disabled = x.disabled = false; msg.textContent = e.message; }); });
          li.appendChild(document.createTextNode(' ')); li.appendChild(a); li.appendChild(document.createTextNode(' ')); li.appendChild(x);
        } else li.appendChild(el('span', 'info', ' · ' + (g.state === 'accepted' ? _t('js.wallet.gifts.st_accepted', 'accepted') : _t('js.wallet.gifts.st_declined', 'declined'))));
        list.appendChild(li);
      });
    }).catch(function () { box.hidden = true; });
  }
  if (all) all.addEventListener('click', function () { all.disabled = true; api('/api/gifts/accept-all', {}).then(function (r) { all.disabled = false; msg.textContent = _t('js.wallet.gifts.all_done', 'Accepted {n} gifts.', { n: r.n }); load(); }).catch(function (e) { all.disabled = false; msg.textContent = e.message; }); });
  load();
})();
