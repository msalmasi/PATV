// pad-cosmetics.js — premium pad cosmetics (1.99ew, padcosmetics.js).
//   * the pad settings hub's 🎨 Look card, "✨ Cosmetics" (#cosmetics, data-mode="manage"): the catalog with live
//     previews, what the pad owns / has equipped, equip / take off, decline a gift, buy (a confirm step with the price
//     and where the PAT goes), and the animated avatar upload once the pad owns it;
//   * the pad page's 🎁 Gift a cosmetic ([data-pad-gift]: the ⋯ menu and the About card): a dialog with the catalog and
//     the same confirm step ("50% Fort Knox · 50% this pad's vault", no refunds).
// Every buy carries a ref made when the confirm step opens: a double click / a retry is charged once (server-side).
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return Math.floor(Number(n) || 0).toLocaleString('en-US'); };
  function newRef() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return 'pc' + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function api(url, body) {
    var o = { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } };
    if (body) { o.method = 'POST'; o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status, code: 'E_INTERNAL' }; }); },
      function () { return { ok: false, error: "Couldn't reach the site - check your connection.", code: 'E_TEMPORARY', hint: 'Nothing was charged unless your balance changed.' }; });
  }
  function errHtml(j) {
    return '<span class="pc-err" role="alert">' + esc(j.error || 'That didn’t work.') + (j.hint ? ' <small>' + esc(j.hint) + '</small>' : '') +
      (j.code ? ' <small class="pc-code">' + esc(j.code) + (j.incident ? ' · incident ' + esc(j.incident) : '') + '</small>' : '') + '</span>';
  }
  var SLOT_ORDER = ['pad_frame', 'pad_glow', 'pad_badge', 'pad_avatar'];

  /** A live preview: a tiny pad header with the item applied (frame / glow / badge / animated avatar). */
  function preview(it, S) {
    var P = S.pad || {}, st = it.style || {};
    var box = 'pc-pv' + (it.kind === 'pad_frame' ? ' pfx pfx-f-' + st.fx + (it.animated ? ' is-anim' : '') : '');
    var av = P.avatar ? '<span class="pc-pv-av"><img src="' + esc(P.avatar) + '" alt=""></span>' : '<span class="pc-pv-av">' + esc((P.title || '?').replace(/^[^A-Za-z0-9]+/, '').charAt(0).toUpperCase() || '?') + '</span>';
    if (it.kind === 'pad_avatar') av = '<span class="pc-pv-av pc-anim" title="Animated">🎞️</span>';
    var name = '<b class="pc-pv-n' + (it.kind === 'pad_glow' ? ' pfx-g pfx-g-' + esc(st.fx) : '') + '">' + esc(P.title || 'Your pad') + '</b>';
    var badge = it.kind === 'pad_badge' ? '<span class="pfx-bs"><span class="pfx-b">' + (st.icon ? '<span aria-hidden="true">' + esc(st.icon) + '</span>' : '') + esc(st.text) + '</span></span>' : '';
    var vars = P.accent ? ' style="--pad-accent:' + esc(P.accent) + '"' : '';
    return '<div class="' + box + '"' + vars + ' aria-hidden="true">' + (it.kind === 'pad_frame' ? '<span class="pfx-l"></span>' : '') +
      '<div class="pc-pv-in">' + av + name + badge + '</div></div>';
  }
  function rarityChip(it, S) {
    var c = (S.rarities[it.rarity] || {}).color || '#bbb';
    return '<span class="pc-rar" style="--rc:' + esc(c) + '">' + esc(it.rarity) + '</span>' + (it.animated ? ' <span class="pc-tag">animated</span>' : '') +
      (it.season ? ' <span class="pc-tag">' + esc(it.season.label) + '</span>' : '');
  }

  // ── the confirm step (shared) ──
  function confirmHtml(it, S, gift) {
    var bal = S.viewer.balance;
    var short = bal != null && bal < it.price;
    return '<div class="pc-confirm" role="group" aria-label="Confirm">' +
      '<p><b>' + (gift ? 'Gift ' : 'Buy ') + esc(it.name) + '</b> for <b>p/' + esc(S.pad.slug) + '</b> — <b>' + fmt(it.price) + ' PAT</b></p>' +
      '<p class="pc-route">Where the PAT goes: <b>' + esc(gift ? S.routing.gift : S.routing.owner) + '</b></p>' +
      '<p class="pc-final">' + (gift ? '⚠️ The pad’s owner can equip it or decline it — <b>either way there’s no refund</b>. It belongs to the pad, not to you.'
        : '⚠️ Pad cosmetics are final: <b>no refunds</b>. It belongs to the pad.') + '</p>' +
      (bal != null ? '<p class="pc-bal' + (short ? ' short' : '') + '">Your balance: ' + fmt(bal) + ' PAT' + (short ? ' — not enough' : '') + '</p>' : '') +
      '<div class="pc-btns"><button type="button" class="btn primary" data-pc-go' + (short ? ' disabled' : '') + '>' + (gift ? '🎁 Confirm gift' : 'Confirm purchase') + '</button>' +
      '<button type="button" class="btn ghost" data-pc-cancel>Cancel</button></div><div class="pc-msg" aria-live="polite"></div></div>';
  }
  function runBuy(base, it, box, gift, done) {
    var ref = newRef(), busy = false;
    var go = box.querySelector('[data-pc-go]'), msg = box.querySelector('.pc-msg');
    go.addEventListener('click', function () {
      if (busy) return;
      busy = true; go.disabled = true; msg.textContent = gift ? 'Sending the gift…' : 'Buying…';
      api(base + '/buy', { item: it.id, ref: ref }).then(function (j) {
        busy = false;
        if (!j.ok) { go.disabled = false; msg.innerHTML = errHtml(j); return; }
        msg.innerHTML = '<span class="pc-ok">' + (gift ? '🎁 Sent! The owner has been told.' : '✅ It’s your pad’s now.') + '</span>';
        setTimeout(function () { done(j); }, gift ? 1400 : 500);
      });
    });
  }

  // ── settings: manage mode ──
  function initManage(root) {
    var base = root.getAttribute('data-url'), lookBase = root.getAttribute('data-look');
    var body = root.querySelector('.pc-body');
    var S = null;
    function load() { return api(base).then(function (j) { if (!j.ok) { body.innerHTML = errHtml(j); return; } S = j; draw(); }); }
    function ownedRow(itemId) { for (var i = 0; i < S.items.length; i++) if (S.items[i].item_id === itemId) return S.items[i]; return null; }
    function isEq(it) { var e = S.equipped || {}; return it.kind === 'pad_badge' ? (e.pad_badge || []).indexOf(it.id) >= 0 : e[it.kind] === it.id; }
    function card(it) {
      var own = ownedRow(it.id), eq = own && isEq(it);
      var stateTxt = !own ? (it.sale ? fmt(it.price) + ' PAT' : 'Not on sale') : eq ? '✅ Equipped' : own.state === 'gift' ? '🎁 Gift from ' + esc(own.from || 'someone') : 'Owned';
      var acts = '';
      if (own) {
        acts += eq ? '<button type="button" class="btn ghost" data-pc-eq="' + esc(it.id) + '" data-on="0">Take off</button>'
          : '<button type="button" class="btn" data-pc-eq="' + esc(it.id) + '" data-on="1">' + (own.state === 'gift' ? 'Accept &amp; equip' : 'Equip') + '</button>';
        if (own.state === 'gift') acts += '<button type="button" class="btn ghost" data-pc-decline="' + own.id + '">Decline</button>';
      } else if (it.sale && S.pay) acts += '<button type="button" class="btn primary" data-pc-buy="' + esc(it.id) + '">Buy · ' + fmt(it.price) + '</button>';
      return '<div class="pc-card' + (eq ? ' eq' : '') + (own && own.state === 'gift' ? ' gift' : '') + '" data-id="' + esc(it.id) + '">' + preview(it, S) +
        '<div class="pc-t"><b>' + esc(it.name) + '</b>' + rarityChip(it, S) + '</div><p class="pc-d">' + esc(it.desc) + '</p>' +
        '<div class="pc-st">' + stateTxt + '</div><div class="pc-btns">' + acts + '</div><div class="pc-slot"></div></div>';
    }
    function animBox() {
      if (!S.anim || !ownedRow('pa_animated')) return '';
      return '<div class="pc-anim-up"><span class="pl-k">Animated avatar <small>an animated WebP or GIF · up to ' + S.anim.max_frames + ' frames · re-encoded to 256 px, at most ' +
        Math.round(S.anim.max_out / 1048576) + ' MB · must be safe for work</small></span><div class="pl-btns"><label class="btn pl-file">' + (S.anim.uploaded ? 'Replace' : 'Upload') +
        ' animated avatar<input type="file" accept="image/gif,image/webp" data-pc-anim></label>' + (S.anim.uploaded ? '<button type="button" class="btn ghost" data-pc-anim-rm>Remove</button>' : '') +
        '</div>' + (S.anim.uploaded && !S.anim.url ? '<p class="ps-mini">Uploaded — equip “Animated avatar” to show it.</p>' : '') + '<div class="pc-msg" aria-live="polite"></div></div>';
    }
    function draw() {
      var gifts = S.items.filter(function (x) { return x.state === 'gift'; }).length;
      var h = '<p class="ps-mini">Bought by you: <b>' + esc(S.routing.owner) + '</b>. Others can 🎁 gift your pad one (' + esc(S.routing.gift) +
        ') — you can equip it or decline it. Purchases are final, no refunds. One frame, one glow and up to 3 badges at a time.' +
        (S.viewer.balance != null ? ' Your balance: <b>' + fmt(S.viewer.balance) + ' PAT</b>.' : '') + '</p>';
      if (!S.pay) h += '<p class="ps-mini pc-off">Pad cosmetics aren’t on sale right now — you can still equip what the pad has.</p>';
      if (gifts) h += '<p class="pc-gifts">🎁 ' + gifts + ' gift' + (gifts === 1 ? '' : 's') + ' waiting for you below.</p>';
      SLOT_ORDER.forEach(function (k) {
        var list = S.catalog.filter(function (it) { return it.kind === k && (it.sale || ownedRow(it.id)); });
        if (!list.length) return;
        var sl = S.slots[k] || {};
        h += '<h5 class="pc-sh">' + esc(sl.emoji || '') + ' ' + esc(sl.label || k) + (k === 'pad_badge' ? ' <small>up to ' + (sl.max || 3) + '</small>' : '') + '</h5>';
        h += '<div class="pc-grid">' + list.map(card).join('') + '</div>';
        if (k === 'pad_avatar') h += animBox();
      });
      body.innerHTML = h;
    }
    function msgIn(el, html) { var m = el.querySelector('.pc-msg') || el.querySelector('.pc-st'); if (m) m.innerHTML = html; }
    root.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !root.contains(b)) return;
      var cardEl = b.closest('.pc-card');
      if (b.hasAttribute('data-pc-buy')) {
        var it = S.catalog.filter(function (x) { return x.id === b.getAttribute('data-pc-buy'); })[0];
        var slot = cardEl.querySelector('.pc-slot');
        slot.innerHTML = confirmHtml(it, S, !S.viewer.owner);
        slot.querySelector('[data-pc-cancel]').addEventListener('click', function () { slot.innerHTML = ''; });
        runBuy(base, it, slot, !S.viewer.owner, function (j) { S = j.state; draw(); });
        slot.querySelector('[data-pc-go]').focus();
      } else if (b.hasAttribute('data-pc-eq')) {
        b.disabled = true;
        api(base + '/equip', { item: b.getAttribute('data-pc-eq'), on: b.getAttribute('data-on') === '1' }).then(function (j) {
          if (!j.ok) { b.disabled = false; cardEl.querySelector('.pc-slot').innerHTML = errHtml(j); return; }
          S = j.state; draw();
        });
      } else if (b.hasAttribute('data-pc-decline')) {
        var slot2 = cardEl.querySelector('.pc-slot');
        slot2.innerHTML = '<div class="pc-confirm"><p>Decline this gift? It leaves your pad and <b>nobody is refunded</b>.</p><div class="pc-btns">' +
          '<button type="button" class="btn" data-pc-yes>Decline it</button><button type="button" class="btn ghost" data-pc-cancel>Keep it</button></div></div>';
        slot2.querySelector('[data-pc-cancel]').addEventListener('click', function () { slot2.innerHTML = ''; });
        slot2.querySelector('[data-pc-yes]').addEventListener('click', function (ev) {
          ev.target.disabled = true;
          api(base + '/decline', { id: Number(b.getAttribute('data-pc-decline')) }).then(function (j) {
            if (!j.ok) { slot2.innerHTML = errHtml(j); return; }
            S = j.state; draw();
          });
        });
      } else if (b.hasAttribute('data-pc-anim-rm')) {
        b.disabled = true;
        api(lookBase + '/remove', { kind: 'avatar_anim' }).then(function (j) { if (!j.ok) { b.disabled = false; msgIn(root.querySelector('.pc-anim-up'), errHtml(j)); return; } load(); });
      }
    });
    root.addEventListener('change', function (e) {
      var inp = e.target;
      if (!inp.hasAttribute || !inp.hasAttribute('data-pc-anim')) return;
      var file = inp.files && inp.files[0], wrap = root.querySelector('.pc-anim-up');
      if (!file) return;
      var max = Number((document.getElementById('look') || root).getAttribute('data-max')) || 5242880;
      if (file.size > max) { msgIn(wrap, errHtml({ error: 'Pictures can be up to ' + Math.round(max / 1048576) + ' MB.' })); return; }
      msgIn(wrap, 'Uploading…');
      api(lookBase + '/uploads', { kind: 'avatar_anim', size: file.size }).then(function (j) {
        if (!j.ok) throw j;
        var id = j.id, chunk = j.chunk || 524288, off = 0;
        function next() {
          if (off >= file.size) return api(lookBase + '/uploads/' + id + '/finish', {});
          return fetch(lookBase + '/uploads/' + id + '?offset=' + off, { method: 'PUT', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: file.slice(off, Math.min(file.size, off + chunk)) })
            .then(function (r) { return r.json(); }).then(function (c) { if (!c.ok) throw c; off = c.received; msgIn(wrap, 'Uploading… ' + Math.round(off / file.size * 100) + '%'); return next(); });
        }
        return next();
      }).then(function (f) {
        if (!f || !f.ok) throw f || {};
        load();
      }).catch(function (j) { msgIn(wrap, errHtml(j && j.error ? j : { error: 'Upload failed.' })); inp.value = ''; });
    });
    load();
  }

  // ── pad page: the gift dialog ──
  function initGift() {
    var triggers = document.querySelectorAll('[data-pad-gift]');
    if (!triggers.length) return;
    var dlg = null, S = null, base = null;
    function open(slug) {
      base = '/api/rooms/' + encodeURIComponent(slug) + '/cosmetics';
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.className = 'pc-dlg';
        dlg.setAttribute('aria-labelledby', 'pcDlgH');
        dlg.innerHTML = '<div class="pc-dlg-in"><div class="pc-dlg-h"><h2 id="pcDlgH">🎁 Gift a cosmetic</h2><button type="button" class="pc-x" aria-label="Close">✕</button></div>' +
          '<div class="pc-body" aria-live="polite"><p>Loading…</p></div></div>';
        document.body.appendChild(dlg);
        dlg.querySelector('.pc-x').addEventListener('click', function () { dlg.close(); });
        dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
        dlg.addEventListener('click', onClick);
      }
      var body = dlg.querySelector('.pc-body');
      body.innerHTML = '<p>Loading…</p>';
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      api(base).then(function (j) { if (!j.ok) { body.innerHTML = errHtml(j); return; } S = j; draw(); });
    }
    function draw() {
      var body = dlg.querySelector('.pc-body');
      var list = S.catalog.filter(function (it) { return it.sale && S.has.indexOf(it.id) < 0; });
      var h = '<p class="pc-lede">For <b>' + esc(S.pad.title) + '</b> (p/' + esc(S.pad.slug) + ')' + (S.pad.owner ? ', owned by <b>' + esc(S.pad.owner) + '</b>' : '') +
        '. Where the PAT goes: <b>' + esc(S.routing.gift) + '</b>. The owner is told and can equip it or decline it — <b>gifts are never refunded</b>.' +
        (S.viewer.balance != null ? ' Your balance: <b>' + fmt(S.viewer.balance) + ' PAT</b>.' : '') + '</p>';
      if (!S.pay) h += '<p class="pc-off">Pad cosmetics aren’t on sale right now.</p>';
      else if (!list.length) h += '<p>This pad already has everything on sale.</p>';
      else h += '<div class="pc-grid">' + list.map(function (it) {
        return '<div class="pc-card" data-id="' + esc(it.id) + '">' + preview(it, S) + '<div class="pc-t"><b>' + esc(it.name) + '</b>' + rarityChip(it, S) + '</div>' +
          '<p class="pc-d">' + esc(it.desc) + '</p><div class="pc-btns"><button type="button" class="btn primary" data-pc-gift="' + esc(it.id) + '">🎁 Gift · ' + fmt(it.price) + '</button></div><div class="pc-slot"></div></div>';
      }).join('') + '</div>';
      body.innerHTML = h;
    }
    function onClick(e) {
      var b = e.target.closest('button[data-pc-gift]');
      if (!b) return;
      var it = S.catalog.filter(function (x) { return x.id === b.getAttribute('data-pc-gift'); })[0];
      var slot = b.closest('.pc-card').querySelector('.pc-slot');
      slot.innerHTML = confirmHtml(it, S, true);
      slot.querySelector('[data-pc-cancel]').addEventListener('click', function () { slot.innerHTML = ''; });
      runBuy(base, it, slot, true, function (j) { S = j.state; draw(); });
      var go = slot.querySelector('[data-pc-go]');
      if (go) go.focus();
    }
    Array.prototype.forEach.call(triggers, function (t) {
      t.addEventListener('click', function (e) {
        e.preventDefault();
        var m = document.getElementById('rmMore');
        if (m) m.open = false;
        open(t.getAttribute('data-pad-gift'));
      });
    });
    if (location.hash === '#gift' && triggers[0]) setTimeout(function () { triggers[triggers.length - 1].scrollIntoView({ block: 'center' }); }, 300);
  }

  var root = document.getElementById('cosmetics');
  if (root && root.getAttribute('data-mode') === 'manage') initManage(root);
  initGift();
})();
