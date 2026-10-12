// /cosmetics?tab=stickers (1.99ta): buy, claim (🎟️ Season Pass allowance) and gift 🧸 sticker packs from the cosmetics store.
// Same API as /premium: POST /api/stickers/buy {pack, ref, allowance?, to?, anon?} (stickers.js). Strings: __t (js.cos.stk.*,
// js.premium.*). A success reloads the tab so the owned state and the allowance are fresh.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var root = document.querySelector('[data-stk-shop]');
  if (!root) return;
  var msg = root.querySelector('[data-stk-msg]');
  function ref() { var a = new Uint8Array(12); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function fmt(n) { return Math.floor(Number(n) || 0).toLocaleString('en-US'); }
  function say(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'ds-note cxs-msg ' + (ok ? 'ok' : 'danger');
    msg.hidden = false;
    try { msg.scrollIntoView({ block: 'nearest' }); } catch (e) { /* old browsers */ }
  }
  function post(body) {
    return fetch('/api/stickers/buy', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: _t('js.premium.went_wrong', 'Something went wrong.') }; }); })
      .catch(function () { return { ok: false, error: _t('js.premium.went_wrong', 'Something went wrong.') }; });
  }
  function done(j, okText) {
    if (j && j.ok) { say(okText, true); setTimeout(function () { location.reload(); }, 1100); return true; }
    say((j && j.error) || _t('js.premium.didnt_work', 'That didn’t work.'), false);
    return false;
  }
  root.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-stk]');
    if (!b || !root.contains(b) || b.disabled) return;
    var free = b.hasAttribute('data-free');
    if (!free && !confirm(_t('js.premium.confirm_stk', 'Buy this sticker pack for {price} PAT?', { price: fmt(b.getAttribute('data-price')) }))) return;
    b.disabled = true;
    post({ pack: b.getAttribute('data-stk'), ref: ref(), allowance: free }).then(function (j) {
      if (!done(j, _t('js.premium.stk_yours', 'It’s yours - find it under 🧸 in the composer.'))) b.disabled = false;
    });
  });
  root.addEventListener('submit', function (e) {
    var f = e.target.closest('form[data-stk-gift]');
    if (!f) return;
    e.preventDefault();
    var who = (f.elements.to.value || '').trim();
    if (!who) { say(_t('js.premium.type_username', 'Type a username first.'), false); return; }
    var anon = !!(f.elements.anon && f.elements.anon.checked);
    var price = fmt(f.getAttribute('data-price'));
    if (!confirm(anon ? _t('js.cos.stk.confirm_gift_anon', 'Gift this sticker pack to {user} anonymously for {price} PAT?', { user: who, price: price })
                      : _t('js.cos.stk.confirm_gift', 'Gift this sticker pack to {user} for {price} PAT?', { user: who, price: price }))) return;
    var btn = f.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    post({ pack: f.getAttribute('data-stk-gift'), ref: ref(), to: who, anon: anon }).then(function (j) {
      if (!done(j, _t('js.premium.gifted', 'Gifted to {user} 🎁', { user: who })) && btn) btn.disabled = false;
    });
  });
})();
