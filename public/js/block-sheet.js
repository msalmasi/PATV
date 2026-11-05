// block-sheet.js - 1.99ajn padppl: the 🚫 Block / ✅ Unblock confirm sheet (blocks.js). One modal <dialog> (the browser keeps focus inside
// it; Esc / ✕ / Cancel close it and focus goes back to what opened it), used by the person menu (room-mod.js - the pad chat, the chat
// window, the casino tables' shared menu), the profile's ⋯ More and /settings/blocked. It POSTs /api/blocks {ref, on, slug} - the ref
// is exactly what was clicked (personref.js), never a typed name. Everything user-visible goes in via textContent.
//
//   PATVBlockSheet.open({ ref, slug?, name, who?, veil?, on: true | false, anchor?, onDone(answer)? })
//   PATVSheet.open({ title, cls?, anchor? }) -> { d, body, close(), open() }   (review fix: the ONE sheet look - the 💸 Tip sheet's: a
//   header with the emoji title and ✕, a divider, and a bottom sheet on phones - shared by the ⛔ ban and 🎁 gift sheets; each close()
//   closes only its own sheet, so a late timer never shuts the next one)
(function (W, D) {
  'use strict';
  var _t = typeof W.__t === 'function' ? W.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  // ── the shared sheet ──
  var openSheet = null, seq = 0;
  function sheet(o) {
    o = o || {};
    if (openSheet) openSheet.close(false);
    var d = el('dialog', 'psh' + (o.cls ? ' ' + o.cls : '')), id = 'pshT' + (++seq);
    d.setAttribute('aria-labelledby', id);
    var inner = el('div', 'psh-in'), head = el('div', 'psh-h');
    var h = el('h3', 'psh-t', o.title || ''); h.id = id;
    var x = el('button', 'psh-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', _t('js.sheet.close', 'Close'));
    head.appendChild(h); head.appendChild(x);
    var body = el('div', 'psh-b');
    inner.appendChild(head); inner.appendChild(body); d.appendChild(inner);
    var S = { d: d, h: h, body: body, id: id, anchor: o.anchor || D.activeElement, done: false };
    S.close = function (refocus) {
      if (S.done) return;
      S.done = true;
      if (openSheet === S) openSheet = null;
      try { if (d.open && d.close) d.close(); } catch (e) { /* old engine */ }
      d.remove();
      if (refocus !== false && S.anchor && S.anchor.isConnected && S.anchor.focus) S.anchor.focus();
    };
    S.later = function (ms) { setTimeout(function () { S.close(); }, ms); };   // (only THIS sheet - never whichever is open by then)
    x.addEventListener('click', function () { S.close(); });
    d.addEventListener('cancel', function (e) { e.preventDefault(); S.close(); });
    d.addEventListener('click', function (e) { if (e.target === d) S.close(); });
    D.body.appendChild(d);
    openSheet = S;
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    return S;
  }
  /** The sheet's buttons row: [go] [Cancel] + a status line (aria-live). go = null: only a Close button. */
  function buttons(S, goText, kind) {
    var row = el('div', 'psh-row'), out = el('p', 'psh-out'); out.setAttribute('aria-live', 'polite');
    var go = null;
    if (goText) { go = el('button', 'psh-btn ' + (kind || 'go'), goText); go.type = 'button'; row.appendChild(go); }
    var no = el('button', 'psh-btn', goText ? _t('js.block.cancel', 'Cancel') : _t('js.sheet.close', 'Close')); no.type = 'button';
    no.addEventListener('click', function () { S.close(); });
    row.appendChild(no); S.body.appendChild(row); S.body.appendChild(out);
    return { go: go, no: no, out: out, row: row };
  }
  W.PATVSheet = { open: sheet, buttons: buttons, el: el, current: function () { return openSheet; } };

  // ── 🚫 Block / ✅ Unblock ──
  function text(o) {
    var n = String(o.name || '');
    if (o.on === false && o.veil) return {
      title: '✅ ' + _t('js.block.unblock_veil_title', 'Unblock 🐸 {name}?', { name: n }),
      body: _t('js.block.unblock_veil_body', 'Their lines under a frog name stop being folded for you, and what they do under a frog name can reach you again. They aren\'t told.'),
      go: _t('js.block.unblock_go', '✅ Unblock')
    };
    if (o.on === false) return {
      title: '✅ ' + _t('js.block.unblock_title', 'Unblock {name}?', { name: n }),
      body: _t('js.block.unblock_body', 'They can message, tip and mention you again, and you\'ll see each other among the 🌐 website people on pads. They aren\'t told.'),
      go: _t('js.block.unblock_go', '✅ Unblock')
    };
    if (o.veil) return {
      title: '🚫 ' + _t('js.block.veil_title', 'Block the person behind 🐸 {name}?', { name: n }),
      // 1.99ajw padppl rework (owner: block ANY frog name the person uses): their frog-named activity, under any frog name, in any pad
      body: _t('js.block.veil_body', 'Whatever frog name they use, in any pad: their lines are folded for you, their @mentions don\'t alert you, and they can\'t challenge, tip or gift you while they\'re incognito. We block them without telling you who it is; what they do under their own name doesn\'t change. If they bother you under their name, block that name too. They aren\'t told.'),
      note: _t('js.block.veil_note', 'Blocking can show you that two frog names are the same person - never who.'),
      go: _t('js.block.go', '🚫 Block')
    };
    return {
      title: '🚫 ' + _t('js.block.title', 'Block {name}?', { name: n }),
      body: _t('js.block.body', 'They can\'t message, tip, gift, mention-alert or challenge you; you won\'t see each other among the 🌐 website people on pads; their pad-chat lines are folded for you. They aren\'t told.'),
      go: _t('js.block.go', '🚫 Block')
    };
  }

  function open(o) {
    o = o || {};
    var T = text(o);
    var S = sheet({ title: T.title, cls: 'psh-block', anchor: o.anchor });
    // (review fix: which person this is - "PATV account @x · Camfrog login y")
    if (o.who) S.body.appendChild(el('p', 'psh-sub', String(o.who)));
    S.body.appendChild(el('p', 'psh-p', T.body));
    if (T.note) S.body.appendChild(el('p', 'psh-hint', T.note));          // (1.99ajw padppl rework: the accepted residual, said up front)
    if (o.on !== false) S.body.appendChild(el('p', 'psh-hint', o.veil ? _t('js.block.where_veil', 'Undo it from Settings → Blocked people.') : _t('js.block.where', 'Undo it from the same menu, or from Settings → Blocked people.')));
    var B = buttons(S, T.go, o.on === false ? 'go' : 'danger');
    B.go.addEventListener('click', function () {
      B.go.disabled = true; B.out.className = 'psh-out'; B.out.textContent = _t('js.block.sending', 'One moment…');
      fetch('/api/blocks', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ ref: o.ref, on: o.on !== false, slug: o.slug || null }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
        .then(function (a) {
          if (S.done) return;
          if (!a || !a.ok) { B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = (a && a.error) || _t('js.block.failed', 'Not changed.'); return; }
          B.out.className = 'psh-out ok';
          B.out.textContent = a.blocked ? (o.veil ? _t('js.block.done_veil', 'Blocked. Only you know.') : _t('js.block.done', 'Blocked.')) : _t('js.block.undone', 'Unblocked.');
          if (typeof o.onDone === 'function') { try { o.onDone(a); } catch (e) { /* the page's own */ } }
          S.later(900);
        })
        .catch(function () { if (S.done) return; B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = _t('js.block.offline', 'Couldn\'t reach the site.'); });
    });
    B.no.focus();
    return S.d;
  }

  W.PATVBlockSheet = { open: open, close: function () { if (openSheet) openSheet.close(); }, _text: text };

  // a folded line of someone you blocked (chatlog-core.js): "Show" reveals it here only (nothing is sent, nothing kept)
  D.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-blk-show]') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    var line = b.closest('.line'), body = line && line.querySelector('.blk-body'), fold = line && line.querySelector('.blk-fold');
    if (body) body.hidden = false;
    if (fold) fold.remove();
    if (line) line.classList.remove('is-blocked-fold');
  }, true);

  // the profile's ⋯ More and the settings list: <button data-block-ref='{"k":"user","v":"x"}' data-block-name="x" data-block-on="1|0">
  D.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-block-ref]') : null;
    if (!b) return;
    e.preventDefault();
    var ref = null;
    try { ref = JSON.parse(b.getAttribute('data-block-ref')); } catch (err) { ref = null; }
    if (!ref) return;
    // (review fix: the ⋯ More popover closes first - it never stays open behind the sheet)
    var pop = b.closest('[popover]'), det = b.closest('details[open]');
    if (pop && pop.hidePopover) { try { pop.hidePopover(); } catch (err) { /* already closed */ } }
    if (det) { det.open = false; var sm = det.querySelector('summary'); if (sm) pop = { id: null, sum: sm }; }
    var on = b.getAttribute('data-block-on') !== '0';
    var anchor = pop && pop.sum ? pop.sum : pop && pop.id ? (D.querySelector('[popovertarget="' + pop.id + '"]') || b) : b;
    open({ ref: ref, name: b.getAttribute('data-block-name') || '', who: b.getAttribute('data-block-who') || null, veil: b.getAttribute('data-block-veil') === '1', on: on, anchor: anchor,
      onDone: function () { if (b.getAttribute('data-block-reload') !== '0') setTimeout(function () { W.location.reload(); }, 700); } });
  });
})(window, document);
