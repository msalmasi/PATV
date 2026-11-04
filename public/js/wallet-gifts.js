// wallet-gifts.js - 1.99?? padppl: the wallet's 🎁 Gifts card (veilgift.js) - gifts sent to you while you were under a frog name. Nothing
// is credited until you accept one (Accept / Accept all); Decline sends it back (on its due day). Accepting adds it to your balance,
// which shows on your profile and the rankings - the card says so. GET /api/gifts; POST /api/gifts/:id/accept|decline, /accept-all.
// Review fixes: each gift is its own row with its buttons on the right; Decline is a quiet outline button, never a second green one.
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
  if (!document.getElementById('giftsCss')) {
    var st = el('style'); st.id = 'giftsCss';
    st.textContent = '#giftsList .gift-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--ds-line,#262626);border-radius:10px;min-width:0}' +
      '#giftsList .gift-row.done{opacity:.7}#giftsList .gift-what{min-width:0;overflow-wrap:anywhere}#giftsList .gift-what small{display:block;color:var(--ds-text-muted,#9a9a9a);font-size:12px}' +
      '#giftsList .gift-btns{display:flex;gap:6px;flex:none}' +
      '#giftsList .gift-no{background:transparent!important;border:1px solid var(--ds-line-strong,#333)!important;color:var(--ds-text,#e6e6e6)!important;box-shadow:none!important}' +
      '@media (max-width:520px){#giftsList .gift-row{flex-wrap:wrap}#giftsList .gift-btns{width:100%}#giftsList .gift-btns .btn{flex:1 1 0}}';
    document.head.appendChild(st);
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
        var li = el('li', 'gift-row' + (g.state === 'pending' ? '' : ' done')), what = el('span', 'gift-what');
        what.appendChild(el('b', null, '🎁 ' + fmt(g.amount) + ' PAT'));
        what.appendChild(el('small', null, _t('js.wallet.gifts.from', 'from @{from}, while you were 🐸 {label} · {day}', { from: g.from || '?', label: g.label, day: day(g.at) })
          + (g.state === 'pending' ? '' : ' · ' + (g.state === 'accepted' ? _t('js.wallet.gifts.st_accepted', 'accepted') : _t('js.wallet.gifts.st_declined', 'declined')))));
        li.appendChild(what);
        if (g.state === 'pending') {
          var btns = el('span', 'gift-btns');
          var a = el('button', 'btn', _t('js.wallet.gifts.accept', 'Accept')); a.type = 'button';
          var x = el('button', 'btn gift-no', _t('js.wallet.gifts.decline', 'Decline')); x.type = 'button';
          a.addEventListener('click', function () { a.disabled = x.disabled = true; api('/api/gifts/' + g.id + '/accept', {}).then(function () { msg.textContent = _t('js.wallet.gifts.accepted', 'Added to your balance.'); load(); }).catch(function (e) { a.disabled = x.disabled = false; msg.textContent = e.message; }); });
          x.addEventListener('click', function () { a.disabled = x.disabled = true; api('/api/gifts/' + g.id + '/decline', {}).then(function () { msg.textContent = _t('js.wallet.gifts.declined', 'Declined - it goes back to them on its due day.'); load(); }).catch(function (e) { a.disabled = x.disabled = false; msg.textContent = e.message; }); });
          btns.appendChild(a); btns.appendChild(x); li.appendChild(btns);
        }
        list.appendChild(li);
      });
    }).catch(function () { box.hidden = true; });
  }
  if (all) all.addEventListener('click', function () { all.disabled = true; api('/api/gifts/accept-all', {}).then(function (r) { all.disabled = false; msg.textContent = _t('js.wallet.gifts.all_done', 'Accepted {n} gifts.', { n: r.n }); load(); }).catch(function (e) { all.disabled = false; msg.textContent = e.message; }); });
  load();
})();
