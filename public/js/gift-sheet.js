// gift-sheet.js - 1.99?? padppl: 🎁 "Send a gift" to a frog name (veilgift.js) from the person menu (room-mod.js). The shared sheet
// (block-sheet.js PATVSheet - the 💸 Tip sheet's look): the preset amounts, what happens (a private gift inbox; we never tell the sender
// who it is or whether they accepted - but an unaccepted gift comes back on day 30, so they can tell then), one confirm. POST
// /api/rooms/:slug/gift {ref, amount, key} - the ref is the row / line clicked, never a name. textContent only.
//   PATVGiftSheet.open({ ref, slug, name, anchor })
(function (W, D) {
  'use strict';
  var _t = typeof W.__t === 'function' ? W.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var AMOUNTS = [100, 500, 1000, 5000, 10000];
  function open(o) {
    o = o || {};
    var SH = W.PATVSheet; if (!SH) return;
    var S = SH.open({ title: '🎁 ' + _t('js.gift.title', 'Send a gift to 🐸 {name}', { name: o.name || '' }), cls: 'psh-gift', anchor: o.anchor });
    S.body.appendChild(el('p', 'psh-p', _t('js.gift.body', 'It waits in their private gift inbox until they accept it. You only ever see the frog name - we never tell you who it is or whether they accepted. A gift that isn\'t accepted within 30 days comes back to you.')));
    var chips = el('div', 'psh-chips psh-amounts'); chips.setAttribute('role', 'radiogroup'); chips.setAttribute('aria-label', _t('js.gift.amount', 'Amount'));
    var amount = 500;
    AMOUNTS.forEach(function (a) {
      var lab = el('label', 'psh-chip'), r = el('input'); r.type = 'radio'; r.name = S.id + 'A'; r.value = String(a); r.checked = a === amount;
      r.addEventListener('change', function () { if (r.checked) amount = a; });
      lab.appendChild(r); lab.appendChild(el('span', null, a.toLocaleString('en-US') + ' PAT')); chips.appendChild(lab);
    });
    S.body.appendChild(chips);
    var B = SH.buttons(S, '🎁 ' + _t('js.gift.go', 'Send the gift'), 'go');
    var key = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    B.go.addEventListener('click', function () {
      B.go.disabled = true; B.out.className = 'psh-out'; B.out.textContent = _t('js.gift.sending', 'One moment…');
      fetch('/api/rooms/' + encodeURIComponent(o.slug) + '/gift', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ ref: o.ref, amount: amount, key: key }) }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (a) {
          if (S.done) return;
          if (!a || !a.ok) { B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = (a && a.error) || _t('js.gift.failed', 'Not sent.'); return; }
          B.out.className = 'psh-out ok';
          B.out.textContent = _t('js.gift.done', '🎁 Gift sent to 🐸 {name}.', { name: a.label || o.name || '' }) + (a.balance != null ? ' ' + _t('js.gift.balance', 'Your balance: {n} PAT.', { n: Number(a.balance).toLocaleString('en-US') }) : '');
          S.later(1600);                       // (review fix: closes THIS sheet only - never one opened meanwhile)
        }).catch(function () { if (S.done) return; B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = _t('js.gift.offline', 'Couldn\'t reach the site.'); });
    });
    var first = chips.querySelector('input:checked'); if (first) first.focus();
  }
  W.PATVGiftSheet = { open: open, close: function () { var c = W.PATVSheet && W.PATVSheet.current(); if (c) c.close(); } };
})(window, document);
