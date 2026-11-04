// block-sheet.js - 1.99?? padppl: the 🚫 Block / ✅ Unblock confirm sheet (blocks.js). One modal <dialog> (the browser keeps focus inside
// it; Esc / Cancel close it and focus goes back to what opened it), used by the person menu (room-mod.js - the pad chat, the chat
// window, the casino tables' shared menu), the profile's ⋯ More and /settings/blocked. It POSTs /api/blocks {ref, on, slug} - the ref
// is exactly what was clicked (personref.js), never a typed name. Everything user-visible goes in via textContent.
//
//   PATVBlockSheet.open({ ref, slug?, name, veil?, on: true | false, anchor?, onDone(answer)? })
(function (W, D) {
  'use strict';
  var _t = typeof W.__t === 'function' ? W.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var cur = null;

  function close() {
    if (!cur) return;
    var c = cur; cur = null;
    try { if (c.d.open && c.d.close) c.d.close(); } catch (e) { /* old engine */ }
    c.d.remove();
    if (c.anchor && c.anchor.isConnected && c.anchor.focus) c.anchor.focus();
  }

  function text(o) {
    var n = String(o.name || '');
    if (o.on === false) return {
      title: _t('js.block.unblock_title', 'Unblock {name}?', { name: n }),
      body: _t('js.block.unblock_body', 'They can message, tip and mention you again, and you\'ll see each other on pads\' people lists. They aren\'t told.'),
      go: _t('js.block.unblock_go', '✅ Unblock')
    };
    if (o.veil) return {
      title: _t('js.block.veil_title', 'Block the person behind 🐸 {name}?', { name: n }),
      body: _t('js.block.veil_body', 'We block their account without telling you who it is. They can\'t message, tip, gift, mention-alert or challenge you. Nothing changes in what you see, so their frog name can\'t be traced. They aren\'t told.'),
      go: _t('js.block.go', '🚫 Block')
    };
    return {
      title: _t('js.block.title', 'Block {name}?', { name: n }),
      body: _t('js.block.body', 'They can\'t message, tip, gift, mention-alert or challenge you; you won\'t see each other on pads\' people lists; their pad-chat lines are folded for you. They aren\'t told.'),
      go: _t('js.block.go', '🚫 Block')
    };
  }

  function open(o) {
    o = o || {};
    close();
    var T = text(o);
    var d = el('dialog', 'psh psh-block'); d.setAttribute('aria-labelledby', 'pshBlockT');
    var inner = el('div', 'psh-in');
    var h = el('h3', 'psh-t', T.title); h.id = 'pshBlockT';
    var p = el('p', 'psh-p', T.body);
    var row = el('div', 'psh-row');
    var go = el('button', 'psh-btn ' + (o.on === false ? 'go' : 'danger'), T.go); go.type = 'button';
    var no = el('button', 'psh-btn', _t('js.block.cancel', 'Cancel')); no.type = 'button';
    var out = el('p', 'psh-out'); out.setAttribute('aria-live', 'polite');
    row.appendChild(go); row.appendChild(no);
    inner.appendChild(h); inner.appendChild(p);
    if (o.on !== false) inner.appendChild(el('p', 'psh-hint', o.veil ? _t('js.block.where_veil', 'Undo it from Settings → Blocked people.') : _t('js.block.where', 'Undo it from the same menu, or from Settings → Blocked people.')));
    inner.appendChild(row); inner.appendChild(out);
    d.appendChild(inner);
    d.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    no.addEventListener('click', close);
    go.addEventListener('click', function () {
      go.disabled = true; out.className = 'psh-out'; out.textContent = _t('js.block.sending', 'One moment…');
      fetch('/api/blocks', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ ref: o.ref, on: o.on !== false, slug: o.slug || null }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
        .then(function (a) {
          if (!a || !a.ok) { go.disabled = false; out.className = 'psh-out bad'; out.textContent = (a && a.error) || _t('js.block.failed', 'Not changed.'); return; }
          out.className = 'psh-out ok';
          out.textContent = a.blocked ? (o.veil ? _t('js.block.done_veil', 'Blocked. Only you know.') : _t('js.block.done', 'Blocked.')) : _t('js.block.undone', 'Unblocked.');
          if (typeof o.onDone === 'function') { try { o.onDone(a); } catch (e) { /* the page's own */ } }
          setTimeout(close, 900);
        })
        .catch(function () { go.disabled = false; out.className = 'psh-out bad'; out.textContent = _t('js.block.offline', 'Couldn\'t reach the site.'); });
    });
    D.body.appendChild(d);
    cur = { d: d, anchor: o.anchor || D.activeElement };
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    no.focus();
    return d;
  }

  W.PATVBlockSheet = { open: open, close: close, _text: text };

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
    var on = b.getAttribute('data-block-on') !== '0';
    open({ ref: ref, name: b.getAttribute('data-block-name') || '', veil: b.getAttribute('data-block-veil') === '1', on: on, anchor: b,
      onDone: function () { if (b.getAttribute('data-block-reload') !== '0') setTimeout(function () { W.location.reload(); }, 700); } });
  });
})(window, document);
