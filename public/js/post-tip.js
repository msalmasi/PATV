// post-tip.js — 💸 Tip a feed post's author (1.99pv, posttips.js). The card's Tip button (data-act="tip") opens a small
// sheet (.ds-scrim.sheet > .ds-modal: a bottom sheet on phones): quick amounts, a typed amount (2,500 / 2.5k / 1m -
// public/js/patamount.js, the same rules as the server and Pepe), an optional message (80 characters, like every web tip),
// a confirm step, then POST /api/feed/posts/<id>/tip with one idempotency key per confirmed attempt (a double click or a
// network retry can't tip twice). On success the card's "💸 N tips · X PAT" tally updates in place.
// Loaded by views/partials/feed-js.ejs for signed-in viewers: <script src=".../post-tip.js" data-me="<your username>">.
// Everything user-visible goes in with textContent.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var me = (document.currentScript && document.currentScript.getAttribute('data-me')) || '';
  var NOTE_MAX = 80;
  var QUICK = [[100, '100'], [1000, '1k'], [5000, '5k'], [10000, '10k'], [50000, '50k']];

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function short(n) {
    var v = Number(n) || 0, a = Math.abs(v);
    if (a < 1000) return String(v);
    if (a < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (a < 1e6) return Math.round(v / 1000) + 'k';
    return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  }
  function parseAmt(v) {
    if (window.PATVAmount) return window.PATVAmount.parse(v);
    var m = String(v == null ? '' : v).trim().toLowerCase().replace(/[, _]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
    return m ? Math.floor(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : NaN;
  }
  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  /** The card's tally ("💸 N tips · X PAT"), made when the post had none. */
  function setTally(card, t) {
    if (!card || !t || !t.n) return;
    var s = card.querySelector('.fp-tips');
    if (!s) {
      s = el('span', 'fp-tips');
      var btn = card.querySelector('.fp-tipb');
      var bar = card.querySelector('.fp-bar');
      if (btn && btn.parentNode) btn.parentNode.insertBefore(s, btn.nextSibling); else if (bar) bar.appendChild(s); else return;
    }
    s.textContent = '';
    s.appendChild(el('span', 'fp-tips-i', '💸')).setAttribute('aria-hidden', 'true');
    s.appendChild(el('span', 'fp-tips-n', ' ' + _t('js.feed.tip.count', '{n} tips', { count: t.n, n: fmt(t.n) }) + ' · '));
    s.appendChild(el('b', null, short(t.total)));
    s.appendChild(document.createTextNode(' PAT'));
    s.title = _t('js.feed.tip.tally_title', '{n} tips on this post, {pat} PAT in all', { count: t.n, n: fmt(t.n), pat: fmt(t.total) });
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
    var balance = null, pending = null;
    var scrim = el('div', 'ds-scrim sheet ptip-scrim');
    var box = el('div', 'ds-modal ptip'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'ptipH');
    var head = el('div', 'ds-modal-h');
    var h = el('h2', null, _t('js.feed.tip.title', '💸 Tip {name}', { name: who })); h.id = 'ptipH';
    var x = el('button', 'ds-close', '×'); x.type = 'button'; x.setAttribute('aria-label', _t('js.feed.tip.close', 'Close')); x.addEventListener('click', close);
    head.appendChild(h); head.appendChild(x); box.appendChild(head);

    // step 1: amount + message
    var form = el('form', 'ds-form ptip-f'); form.noValidate = true;
    var lead = el('p', 'ds-sub', _t('js.feed.tip.lead', 'For this post. {name} gets the full amount.', { name: who }));
    var quick = el('div', 'ptip-quick'); quick.setAttribute('role', 'group'); quick.setAttribute('aria-label', _t('js.feed.tip.quick', 'Quick amounts'));
    var af = el('div', 'ds-field');
    var al = el('label', 'ds-label', _t('js.feed.tip.amount', 'Amount')); al.htmlFor = 'ptipAmt';
    var grp = el('div', 'ds-in-group');
    var amt = el('input', 'ds-in'); amt.id = 'ptipAmt'; amt.type = 'text'; amt.inputMode = 'decimal'; amt.autocomplete = 'off';
    amt.placeholder = _t('js.feed.tip.amount_ph', 'e.g. 2,500 or 5k'); amt.setAttribute('aria-describedby', 'ptipHint');
    grp.appendChild(amt); grp.appendChild(el('span', 'ds-in-addon', 'PAT'));
    var hint = el('p', 'ds-hint', ''); hint.id = 'ptipHint'; hint.setAttribute('aria-live', 'polite');
    af.appendChild(al); af.appendChild(grp); af.appendChild(hint);
    QUICK.forEach(function (q) {
      var b = el('button', 'ds-quick', q[1]); b.type = 'button'; b.setAttribute('data-v', q[0]); b.setAttribute('aria-label', fmt(q[0]) + ' PAT'); b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { amt.value = fmt(q[0]); check(); amt.focus(); });
      quick.appendChild(b);
    });
    var nf = el('div', 'ds-field');
    var nl = el('label', 'ds-label', _t('js.feed.tip.note', 'Message (optional)')); nl.htmlFor = 'ptipNote';
    var note = el('input', 'ds-in'); note.id = 'ptipNote'; note.type = 'text'; note.maxLength = NOTE_MAX; note.autocomplete = 'off';
    note.placeholder = _t('js.feed.tip.note_ph', 'Great post, thanks…');
    nf.appendChild(nl); nf.appendChild(note);
    var f1 = el('div', 'ds-modal-f');
    var cancel = el('button', 'ds-btn ghost', _t('js.feed.tip.cancel', 'Cancel')); cancel.type = 'button'; cancel.addEventListener('click', close);
    var rev = el('button', 'ds-btn gold', _t('js.feed.tip.review', 'Review tip')); rev.type = 'submit';
    f1.appendChild(cancel); f1.appendChild(rev);
    [lead, quick, af, nf, f1].forEach(function (n) { form.appendChild(n); });

    // step 2: confirm
    var conf = el('div', 'ds-form ptip-c'); conf.hidden = true;
    var sum = el('p', 'ptip-sum');
    var cnote = el('p', 'ds-sub ptip-q');
    var warn = el('div', 'ds-note warn'); warn.hidden = true;
    var fine = el('p', 'ds-sub', _t('js.feed.tip.fine', 'Tips are instant and can\'t be undone.'));
    var err = el('div', 'ds-note danger'); err.hidden = true; err.setAttribute('role', 'alert');
    var f2 = el('div', 'ds-modal-f');
    var back = el('button', 'ds-btn ghost', _t('js.feed.tip.back', 'Back')); back.type = 'button';
    var send = el('button', 'ds-btn gold', _t('js.feed.tip.send', 'Send')); send.type = 'button';
    f2.appendChild(back); f2.appendChild(send);
    [sum, cnote, warn, fine, err, f2].forEach(function (n) { conf.appendChild(n); });

    // step 3: done
    var done = el('div', 'ds-form ptip-d'); done.hidden = true;
    var ok = el('div', 'ds-note ok'); ok.setAttribute('role', 'status');
    var f3 = el('div', 'ds-modal-f');
    var dclose = el('button', 'ds-btn', _t('js.feed.tip.done', 'Done')); dclose.type = 'button'; dclose.addEventListener('click', close);
    f3.appendChild(dclose); done.appendChild(ok); done.appendChild(f3);

    box.appendChild(form); box.appendChild(conf); box.appendChild(done);
    scrim.appendChild(box);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(box.querySelectorAll('button, input'), function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    cur = { scrim: scrim, from: o.from, onKey: onKey };
    amt.focus();
    hint.textContent = _t('js.feed.tip.bal_loading', 'Your balance: …');

    if (me) {
      fetch('/api/u/' + encodeURIComponent(me) + '/balance', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && typeof j.balance === 'number') balance = Math.floor(j.balance); check(); })
        .catch(function () { check(); });
    }

    function idle() { return balance != null ? _t('js.feed.tip.bal', 'Your balance: {n} PAT', { n: fmt(balance) }) : _t('js.feed.tip.hint', '2,500 · 2.5k · 1m all work.'); }
    function check() {
      var raw = amt.value.trim(), n = parseAmt(raw), bad = null;
      if (!raw) bad = '';
      else if (isNaN(n)) bad = _t('js.feed.tip.bad_num', 'Use a number like 2500, 25k or 1.5m.');
      else if (n < 1) bad = _t('js.feed.tip.min', 'Tip at least 1 PAT.');
      else if (balance != null && n > balance) bad = _t('js.feed.tip.over', 'That\'s more than your balance ({n} PAT).', { n: fmt(balance) });
      Array.prototype.forEach.call(quick.children, function (c) {
        c.setAttribute('aria-pressed', String(Number(c.getAttribute('data-v')) === n));
        c.disabled = balance != null && Number(c.getAttribute('data-v')) > balance;
      });
      amt.setAttribute('aria-invalid', bad ? 'true' : 'false');
      hint.classList.toggle('ptip-bad', !!bad);
      if (bad === '') { hint.textContent = idle(); return null; }
      if (bad) { hint.textContent = bad; return null; }
      hint.textContent = balance != null ? _t('js.feed.tip.calc_left', '= {n} PAT · leaves you {left} PAT', { n: fmt(n), left: fmt(balance - n) }) : _t('js.feed.tip.calc', '= {n} PAT', { n: fmt(n) });
      return n;
    }
    amt.addEventListener('input', check);
    function step(s) { form.hidden = s !== 'form'; conf.hidden = s !== 'confirm'; done.hidden = s !== 'done'; }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = check();
      if (n === null) { if (!amt.value.trim()) { hint.classList.add('ptip-bad'); hint.textContent = _t('js.feed.tip.enter', 'Enter an amount to tip.'); } amt.focus(); return; }
      var t = note.value.replace(/\s+/g, ' ').trim();
      pending = { amount: n, note: t, key: newKey() };       // one key per confirmed attempt
      sum.textContent = _t('js.feed.tip.sum', 'Send {n} PAT to {name} for this post?', { n: fmt(n), name: who });
      cnote.textContent = t ? '“' + t + '”' : ''; cnote.hidden = !t;
      var big = balance != null && n >= balance * 0.5 && n >= 10000;
      warn.hidden = !big;
      if (big) warn.textContent = n === balance ? _t('js.feed.tip.whole', 'Heads up: this is your whole balance.') : _t('js.feed.tip.pct', 'Heads up: that\'s {pct}% of your balance.', { pct: Math.round(n / balance * 100) });
      err.hidden = true; err.textContent = '';
      send.disabled = false; send.textContent = _t('js.feed.tip.send_n', 'Send {n} PAT', { n: fmt(n) });
      step('confirm'); send.focus();
    });
    back.addEventListener('click', function () { pending = null; step('form'); amt.focus(); });
    send.addEventListener('click', function () {
      if (!pending || send.disabled) return;
      send.disabled = true; send.setAttribute('aria-busy', 'true'); send.textContent = _t('js.feed.tip.sending', 'Sending…'); err.hidden = true;
      var p = pending;
      fetch('/api/feed/posts/' + encodeURIComponent(o.id) + '/tip', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': 'fetch' },
        body: JSON.stringify({ amount: p.amount, note: p.note, idempotency_key: p.key }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, ok: r.ok, d: j || {} }; });
      }).then(function (res) {
        send.removeAttribute('aria-busy');
        if (res.ok && res.d.ok !== false) {
          if (typeof res.d.balance === 'number') balance = res.d.balance;
          ok.textContent = _t('js.feed.tip.sent', '💸 Sent {n} PAT to {name}.', { n: fmt(p.amount), name: who }) + (balance != null ? ' ' + _t('js.feed.tip.sent_bal', 'Your balance: {n} PAT.', { n: fmt(balance) }) : '');
          setTally(o.card, res.d.tips);
          step('done'); dclose.focus();
          return;
        }
        send.disabled = false; send.textContent = _t('js.feed.tip.try_again', 'Try again');
        var m;
        if (res.status === 409 && res.d.error === 'in_progress') m = _t('js.feed.tip.e409', 'That tip is still going through - check your history before trying again.');
        else if (res.status === 401) m = _t('js.feed.tip.e401', 'You\'ve been signed out - sign in and try again.');
        else {
          m = String(res.d.error || '');
          if (/insufficient/i.test(m)) m = _t('js.feed.tip.insufficient', 'You don\'t have enough PAT for that any more.');
          else if (!m || m.length > 160) m = _t('js.feed.tip.failed', 'The tip didn\'t go through - nothing was sent.');
        }
        err.textContent = m; err.hidden = false;
        if (res.status !== 500 && !(res.status === 409 && res.d.error === 'in_progress')) pending.key = newKey();   // a refusal is final; a fresh try gets a fresh key
      }).catch(function () {
        // network error: it may have landed - keep the SAME key so a retry can't send twice
        send.disabled = false; send.removeAttribute('aria-busy'); send.textContent = _t('js.feed.tip.retry', 'Retry');
        err.textContent = _t('js.feed.tip.network', 'Couldn\'t reach the server. Retrying is safe - it won\'t send twice.'); err.hidden = false;
      });
    });
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-act="tip"]');
    if (!b) return;
    var card = b.closest('.fp');
    if (!card) return;
    ev.preventDefault();
    sheet({ id: card.getAttribute('data-id'), to: b.getAttribute('data-to'), name: b.getAttribute('data-name'), card: card, from: b });
  });

  window.PATVPostTip = { open: sheet, close: close, _parse: parseAmt, _setTally: setTally };
})();
