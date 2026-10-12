// post-boost.js — 💸 BOOST UPVOTES (2026-10-12, engagement.js). An upvote that is also a small tip to the author: the small
// 💸 under a post's vote arrows (or a long press on the upvote arrow) opens a sheet with quick amounts (the server's
// boost_quick, 100 / 500 / 1k by default; at least boost_min) and an "other amount" field. The FIRST boost asks for a confirm;
// after that a quick amount sends with one tap (remembered in this browser). POST /api/feed/posts/<id>/boost {amount,
// idempotency_key} - one key per attempt (a double tap or a network retry can't boost twice); the server upvotes and tips
// through the post-tip path (no cut). On success the card's vote column and its "💸 X boosted" total update in place.
// The regular upvote stays one tap. Hidden entirely while boosts are off (GET /api/feed/boost/config). textContent only.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var CFG = { enabled: false, min: 100, quick: [100, 500, 1000] };
  var OK_KEY = 'patv.boost.confirmed';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function short(n) {
    var v = Number(n) || 0;
    if (v < 1000) return String(v);
    if (v < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (v < 1e6) return Math.round(v / 1000) + 'k';
    return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  }
  function parseAmt(v) {
    if (window.PATVAmount) return window.PATVAmount.parse(v);
    var m = String(v == null ? '' : v).trim().toLowerCase().replace(/[, _]/g, '').match(/^(\d+(?:\.\d+)?)([km])?$/);
    return m ? Math.floor(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2]] || 1)) : NaN;
  }
  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  function confirmed() { try { return localStorage.getItem(OK_KEY) === '1'; } catch (e) { return false; } }
  function setConfirmed() { try { localStorage.setItem(OK_KEY, '1'); } catch (e) { /* private mode: ask again next time */ } }

  /** The card after a boost: the vote column shows the upvote + new score, and the "💸 X boosted" total. */
  function applyResult(card, d) {
    if (!card || !d) return;
    var v = card.querySelector('.fp-vote');
    if (v) {
      v.setAttribute('data-v', '1');
      var up = v.querySelector('.vb-up'), dn = v.querySelector('.vb-down'), vs = v.querySelector('.vs');
      if (up) up.setAttribute('aria-pressed', 'true');
      if (dn) dn.setAttribute('aria-pressed', 'false');
      if (vs && typeof d.score === 'number') vs.textContent = short(d.score);
    }
    var b = d.boosts;
    if (!b || !b.n) return;
    var s = card.querySelector('.fp-boosts');
    if (!s) {
      var bar = card.querySelector('.fp-bar');
      if (!bar) return;
      s = el('span', 'fp-boosts');
      bar.appendChild(s);
    }
    s.textContent = '';
    s.appendChild(el('span', null, '💸')).setAttribute('aria-hidden', 'true');
    s.appendChild(document.createTextNode(' '));
    s.appendChild(el('b', null, short(b.total)));
    s.appendChild(document.createTextNode(' ' + _t('feed.p.boosted', 'boosted')));
  }

  var cur = null;
  function close() {
    if (!cur) return;
    var c = cur; cur = null;
    document.removeEventListener('keydown', c.onKey, true);
    c.scrim.remove();
    if (c.from && c.from.focus) c.from.focus();
  }

  function sheet(o) {
    close();
    var who = o.name || o.to;
    var scrim = el('div', 'ds-scrim sheet ptip-scrim');
    var box = el('div', 'ds-modal ptip pboost'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'pboostH');
    var head = el('div', 'ds-modal-h');
    var h = el('h2', null, _t('js.feed.boost.title', '💸 Boost upvote')); h.id = 'pboostH';
    var x = el('button', 'ds-close', '×'); x.type = 'button'; x.setAttribute('aria-label', _t('js.feed.boost.close', 'Close')); x.addEventListener('click', close);
    head.appendChild(h); head.appendChild(x); box.appendChild(head);
    var lead = el('p', 'ds-sub', _t('js.feed.boost.lead', 'Upvote and tip {name} at the same time. {name} gets the full amount.', { name: who }));
    var quick = el('div', 'ptip-quick'); quick.setAttribute('role', 'group'); quick.setAttribute('aria-label', _t('js.feed.boost.quick', 'Boost amounts'));
    var af = el('div', 'ds-field');
    var al = el('label', 'ds-label', _t('js.feed.boost.custom', 'Other amount')); al.htmlFor = 'pboostAmt';
    var grp = el('div', 'ds-in-group');
    var amt = el('input', 'ds-in'); amt.id = 'pboostAmt'; amt.type = 'text'; amt.inputMode = 'decimal'; amt.autocomplete = 'off'; amt.placeholder = fmt(CFG.min * 25);
    grp.appendChild(amt); grp.appendChild(el('span', 'ds-in-addon', 'PAT'));
    var hint = el('p', 'ds-hint', _t('js.feed.boost.min', 'A boost is at least {n} PAT.', { n: fmt(CFG.min) })); hint.id = 'pboostHint'; hint.setAttribute('aria-live', 'polite');
    amt.setAttribute('aria-describedby', 'pboostHint');
    af.appendChild(al); af.appendChild(grp); af.appendChild(hint);
    var conf = el('div', 'ds-note warn'); conf.hidden = true;
    var err = el('div', 'ds-note danger'); err.hidden = true; err.setAttribute('role', 'alert');
    var ok = el('div', 'ds-note ok'); ok.hidden = true; ok.setAttribute('role', 'status');
    var foot = el('div', 'ds-modal-f');
    var cancel = el('button', 'ds-btn ghost', _t('js.feed.boost.cancel', 'Cancel')); cancel.type = 'button'; cancel.addEventListener('click', close);
    var go = el('button', 'ds-btn gold', _t('js.feed.boost.go', 'Boost {n} PAT', { n: fmt(CFG.min) })); go.type = 'button';
    foot.appendChild(cancel); foot.appendChild(go);
    [lead, quick, af, conf, err, ok, foot].forEach(function (n) { box.appendChild(n); });
    scrim.appendChild(box);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    cur = { scrim: scrim, from: o.from, onKey: onKey };

    var armed = null, key = newKey(), busy = false;
    function pick(n) {
      armed = null; conf.hidden = true; err.hidden = true;
      Array.prototype.forEach.call(quick.children, function (c) { c.setAttribute('aria-pressed', String(Number(c.getAttribute('data-v')) === n)); });
      go.textContent = _t('js.feed.boost.go', 'Boost {n} PAT', { n: fmt(n) });
      go.setAttribute('data-n', String(n));
    }
    function want() {
      var raw = amt.value.trim();
      var n = raw ? parseAmt(raw) : Number(go.getAttribute('data-n') || CFG.min);
      if (!isFinite(n) || n < CFG.min) { hint.textContent = _t('js.feed.boost.min', 'A boost is at least {n} PAT.', { n: fmt(CFG.min) }); amt.setAttribute('aria-invalid', 'true'); return null; }
      amt.removeAttribute('aria-invalid');
      return n;
    }
    function send(n) {
      if (busy) return;
      if (!confirmed() && armed !== n) {               // the first boost ever: ask once
        armed = n;
        conf.textContent = _t('js.feed.boost.confirm', 'Boost this post with {n} PAT? It upvotes it and sends {n} PAT to {name}. Boosts are instant and can\'t be undone. After this one, boosts send with one tap.', { n: fmt(n), name: who });
        conf.hidden = false;
        go.textContent = _t('js.feed.boost.go', 'Boost {n} PAT', { n: fmt(n) });
        go.focus();
        return;
      }
      busy = true; go.disabled = true; go.setAttribute('aria-busy', 'true'); go.textContent = _t('js.feed.boost.sending', 'Boosting…'); err.hidden = true;
      fetch('/api/feed/posts/' + encodeURIComponent(o.id) + '/boost', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': 'fetch' },
        body: JSON.stringify({ amount: n, idempotency_key: key }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, d: j || {} }; });
      }).then(function (res) {
        busy = false; go.disabled = false; go.removeAttribute('aria-busy');
        if (res.ok && res.d.ok !== false) {
          setConfirmed();
          applyResult(o.card, res.d);
          conf.hidden = true;
          ok.textContent = _t('js.feed.boost.sent', '💸 Boosted with {n} PAT.', { n: fmt(n) }); ok.hidden = false;
          go.hidden = true;
          setTimeout(close, 1400);
          return;
        }
        var m = String(res.d.error || '');
        if (res.status === 401) m = _t('js.feed.boost.signin', 'Sign in to boost.');
        else if (!m || m.length > 160) m = _t('js.feed.boost.failed', 'The boost didn\'t go through - nothing was sent.');
        err.textContent = m; err.hidden = false;
        go.textContent = _t('js.feed.boost.go', 'Boost {n} PAT', { n: fmt(n) });
        if (res.status !== 500) key = newKey();          // a refusal is final; a new try gets a new key
      }).catch(function () {
        busy = false; go.disabled = false; go.removeAttribute('aria-busy');
        go.textContent = _t('js.feed.boost.go', 'Boost {n} PAT', { n: fmt(n) });
        err.textContent = _t('js.feed.boost.network', 'Couldn\'t reach the server. Retrying is safe - it won\'t send twice.'); err.hidden = false;
      });
    }
    CFG.quick.filter(function (q) { return q >= CFG.min; }).forEach(function (q) {
      var b = el('button', 'ds-quick', short(q)); b.type = 'button'; b.setAttribute('data-v', q); b.setAttribute('aria-label', fmt(q) + ' PAT'); b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { amt.value = ''; pick(q); send(q); });
      quick.appendChild(b);
    });
    amt.addEventListener('input', function () { var n = parseAmt(amt.value); armed = null; conf.hidden = true; if (isFinite(n) && n >= CFG.min) pick(n); });
    go.addEventListener('click', function () { var n = want(); if (n != null) send(n); });
    pick(CFG.quick[0] && CFG.quick[0] >= CFG.min ? CFG.quick[0] : CFG.min);
    var first = quick.querySelector('button'); (first || amt).focus();
  }

  function open(btn) {
    var card = btn.closest('.fp');
    if (!card || !CFG.enabled) return;
    var b = card.querySelector('.vb-boost');
    if (!b) return;
    sheet({ id: card.getAttribute('data-id'), to: b.getAttribute('data-to'), name: b.getAttribute('data-name'), card: card, from: btn });
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-act="boost"]');
    if (!b) return;
    ev.preventDefault();
    open(b);
  });
  // a long press on the upvote arrow opens the boost sheet too (the tap stays a plain upvote)
  var press = null, swallow = false;
  document.addEventListener('pointerdown', function (ev) {
    var up = CFG.enabled && ev.target.closest && ev.target.closest('.fp-vote .vb-up');
    if (!up || !up.closest('.fp').querySelector('.vb-boost')) return;
    clearTimeout(press);
    press = setTimeout(function () { press = null; swallow = true; open(up); }, 550);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { document.addEventListener(t, function () { clearTimeout(press); press = null; }, true); });
  document.addEventListener('click', function (ev) {
    if (!swallow) return;
    if (ev.target.closest && ev.target.closest('.vb-up')) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    swallow = false;
  }, true);
  document.addEventListener('contextmenu', function (ev) { if (CFG.enabled && ev.target.closest && ev.target.closest('.fp-vote .vb-up')) ev.preventDefault(); });

  fetch('/api/feed/boost/config', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (!j || !j.enabled) return;
    CFG = { enabled: true, min: Number(j.min) || 100, quick: (j.quick || []).map(Number).filter(function (n) { return n > 0; }) };
    if (!CFG.quick.length) CFG.quick = [CFG.min];
    document.documentElement.classList.add('boost-on');
  }).catch(function () { /* boosts stay hidden */ });

  window.PATVPostBoost = { open: sheet, close: close, _apply: applyResult };
})();
