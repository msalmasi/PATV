// gift-sheet.js - 1.99?? padppl: 🎁 "Send a gift" to a frog name (veilgift.js) from the person menu (room-mod.js). A modal <dialog>: the
// preset amounts, what happens (a private gift inbox; the sender only ever sees the frog name; back after 30 days if not accepted), one
// confirm. POST /api/rooms/:slug/gift {ref, amount, key} - the ref is the row / line clicked, never a name. textContent only.
//   PATVGiftSheet.open({ ref, slug, name, anchor })
(function (W, D) {
  'use strict';
  var _t = typeof W.__t === 'function' ? W.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var AMOUNTS = [100, 500, 1000, 5000, 10000], cur = null, seq = 0;
  function close() { if (!cur) return; var c = cur; cur = null; try { if (c.d.open && c.d.close) c.d.close(); } catch (e) { /* old engine */ } c.d.remove(); if (c.anchor && c.anchor.isConnected && c.anchor.focus) c.anchor.focus(); }
  function open(o) {
    o = o || {}; close();
    var d = el('dialog', 'psh psh-gift'), id = 'pshGiftT' + (++seq); d.setAttribute('aria-labelledby', id);
    var inner = el('div', 'psh-in'), h = el('h3', 'psh-t', _t('js.gift.title', 'Send a gift to 🐸 {name}', { name: o.name || '' })); h.id = id;
    inner.appendChild(h);
    inner.appendChild(el('p', 'psh-p', _t('js.gift.body', 'It waits in their private gift inbox until they accept it. You only ever see the frog name - never who it is or whether they accepted. If it isn\'t accepted within 30 days, it comes back to you.')));
    var chips = el('div', 'psh-chips'); chips.setAttribute('role', 'radiogroup'); chips.setAttribute('aria-label', _t('js.gift.amount', 'Amount'));
    var amount = 500;
    AMOUNTS.forEach(function (a) {
      var lab = el('label', 'psh-chip'), r = el('input'); r.type = 'radio'; r.name = 'pshGift' + seq; r.value = String(a); r.checked = a === amount;
      r.addEventListener('change', function () { if (r.checked) amount = a; });
      lab.appendChild(r); lab.appendChild(el('span', null, a.toLocaleString('en-US') + ' PAT')); chips.appendChild(lab);
    });
    inner.appendChild(chips);
    var row = el('div', 'psh-row'), go = el('button', 'psh-btn go', '🎁 ' + _t('js.gift.go', 'Send the gift')), no = el('button', 'psh-btn', _t('js.gift.cancel', 'Cancel'));
    go.type = 'button'; no.type = 'button'; no.addEventListener('click', close);
    var out = el('p', 'psh-out'); out.setAttribute('aria-live', 'polite');
    row.appendChild(go); row.appendChild(no); inner.appendChild(row); inner.appendChild(out); d.appendChild(inner);
    var key = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    go.addEventListener('click', function () {
      go.disabled = true; out.className = 'psh-out'; out.textContent = _t('js.gift.sending', 'One moment…');
      fetch('/api/rooms/' + encodeURIComponent(o.slug) + '/gift', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ ref: o.ref, amount: amount, key: key }) }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (a) {
          if (!a || !a.ok) { go.disabled = false; out.className = 'psh-out bad'; out.textContent = (a && a.error) || _t('js.gift.failed', 'Not sent.'); return; }
          out.className = 'psh-out ok';
          out.textContent = _t('js.gift.done', '🎁 Gift sent to 🐸 {name}.', { name: a.label || o.name || '' }) + (a.balance != null ? ' ' + _t('js.gift.balance', 'Your balance: {n} PAT.', { n: Number(a.balance).toLocaleString('en-US') }) : '');
          setTimeout(close, 1600);
        }).catch(function () { go.disabled = false; out.className = 'psh-out bad'; out.textContent = _t('js.gift.offline', 'Couldn\'t reach the site.'); });
    });
    d.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    D.body.appendChild(d); cur = { d: d, anchor: o.anchor || D.activeElement };
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    var first = chips.querySelector('input:checked'); if (first) first.focus();
  }
  W.PATVGiftSheet = { open: open, close: close };
})(window, document);
