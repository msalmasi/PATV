// pad-tip.js — 💸 Tip without leaving the pad (1.99il): the roster ⋯ menu's Tip (room-mod.js) opens this modal on the
// pad page instead of the separate /u/<name>/tip page. Amount (presets or typed: 2500 / 2.5k / 1m), an optional note
// (80 characters, like the tip page), a confirm step, then the SAME POST the tip page makes (/u/<name>/tip: atomic
// ledger move, idempotency key per attempt, same refusals) plus `room` = this pad's slug - the site then asks Pepe to
// announce it in the Camfrog room when the recipient is in it (bridge.js tipAnnounce; never for hidden people).
//
//   PATVRoom.tipModal({ to: <PATV username>, display, slug, me: <your PATV username> })
// Everything user-visible goes in with textContent.
(function () {
  'use strict';
  var P = window.PATVRoom = window.PATVRoom || {};
  var NOTE_MAX = 80;
  var CHIPS = [[100, '100'], [1000, '1k'], [5000, '5k'], [10000, '10k'], [50000, '50k']];

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  /** "2500", "2,500", "2.5k", "1m" -> an integer, else NaN (the tip page's rule). */
  function parseAmt(v) {
    var m = String(v == null ? '' : v).trim().toLowerCase().replace(/[, _]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/);
    if (!m) return NaN;
    return Math.floor(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
  }
  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  var open = null;
  function close() { if (open) { var d = open; open = null; if (d.open && d.close) d.close(); d.remove(); } }

  function tipModal(o) {
    o = o || {};
    if (!o.to) return;
    close();
    var who = o.display || o.to;
    var balance = null, pending = null;
    var d = el('dialog', 'pm-dlg tipm'); d.setAttribute('aria-label', 'Tip ' + who);
    var inner = el('div', 'pm-dlg-in');
    var top = el('div', 'pm-dlg-h');
    top.appendChild(el('h3', null, '💸 Tip ' + who));
    var x = el('button', 'pm-btn pm-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.addEventListener('click', close);
    top.appendChild(x);
    var body = el('div', 'pm-dlg-b');
    inner.appendChild(top); inner.appendChild(body); d.appendChild(inner);

    // step 1: amount + note
    var form = el('form', 'tipm-f'); form.noValidate = true;
    var bal = el('p', 'tipm-bal', 'Your balance: …');
    var lab = el('label', 'tipm-l', 'Amount'); lab.htmlFor = 'tipmAmt';
    var amt = el('input'); amt.id = 'tipmAmt'; amt.type = 'text'; amt.inputMode = 'decimal'; amt.autocomplete = 'off'; amt.placeholder = 'e.g. 5k'; amt.setAttribute('aria-describedby', 'tipmHint');
    var chips = el('div', 'tipm-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Quick amounts');
    CHIPS.forEach(function (c) {
      var b = el('button', 'pm-btn', c[1]); b.type = 'button'; b.setAttribute('data-v', c[0]); b.setAttribute('aria-label', fmt(c[0]) + ' PAT');
      b.addEventListener('click', function () { amt.value = fmt(c[0]); check(); amt.focus(); });
      chips.appendChild(b);
    });
    var hint = el('p', 'tipm-hint', 'k = thousand, m = million (2.5k = 2,500).'); hint.id = 'tipmHint'; hint.setAttribute('aria-live', 'polite');
    var nlab = el('label', 'tipm-l', 'Note (optional)'); nlab.htmlFor = 'tipmNote';
    var note = el('input'); note.id = 'tipmNote'; note.type = 'text'; note.maxLength = NOTE_MAX; note.autocomplete = 'off'; note.placeholder = 'Say thanks, GG, for the set…';
    var acts = el('div', 'pm-acts');
    var rev = el('button', 'pm-btn tipm-go', 'Review tip'); rev.type = 'submit';
    var cancel = el('button', 'pm-btn', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    acts.appendChild(rev); acts.appendChild(cancel);
    [bal, lab, amt, chips, hint, nlab, note, acts].forEach(function (n) { form.appendChild(n); });

    // step 2: confirm
    var conf = el('div', 'tipm-c'); conf.hidden = true;
    var sum = el('p', 'tipm-sum');
    var cnote = el('p', 'tipm-note');
    var warn = el('p', 'pm-note warn'); warn.hidden = true;
    var fine = el('p', 'tipm-hint', 'Tips are instant and can\'t be undone. ' + who + ' gets the full amount.');
    var err = el('p', 'tipm-err'); err.setAttribute('role', 'status');
    var cacts = el('div', 'pm-acts');
    var send = el('button', 'pm-btn tipm-go', 'Send'); send.type = 'button';
    var back = el('button', 'pm-btn', 'Back'); back.type = 'button';
    cacts.appendChild(send); cacts.appendChild(back);
    [sum, cnote, warn, fine, err, cacts].forEach(function (n) { conf.appendChild(n); });

    // step 3: done
    var done = el('div', 'tipm-d'); done.hidden = true;
    var dmsg = el('p', 'tipm-ok'); dmsg.setAttribute('role', 'status');
    var dacts = el('div', 'pm-acts');
    var dclose = el('button', 'pm-btn', 'Close'); dclose.type = 'button'; dclose.addEventListener('click', close);
    dacts.appendChild(dclose);
    done.appendChild(dmsg); done.appendChild(dacts);

    body.appendChild(form); body.appendChild(conf); body.appendChild(done);
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    d.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    document.body.appendChild(d);
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    open = d;
    amt.focus();

    if (o.me) {
      fetch('/api/u/' + encodeURIComponent(o.me) + '/balance', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && typeof j.balance === 'number') { balance = Math.floor(j.balance); bal.textContent = 'Your balance: ' + fmt(balance) + ' PAT'; check(); } else bal.textContent = ''; })
        .catch(function () { bal.textContent = ''; });
    } else bal.textContent = '';

    function check() {
      var raw = amt.value.trim(), n = parseAmt(raw), bad = null;
      if (!raw) bad = '';
      else if (isNaN(n)) bad = 'Use a number like 2500, 25k or 1.5m.';
      else if (n < 1) bad = 'Tip at least 1 PAT.';
      else if (balance != null && n > balance) bad = 'That\'s more than your balance (' + fmt(balance) + ' PAT).';
      Array.prototype.forEach.call(chips.children, function (c) {
        c.setAttribute('aria-pressed', String(Number(c.getAttribute('data-v')) === n));
        c.disabled = balance != null && Number(c.getAttribute('data-v')) > balance;
      });
      hint.classList.toggle('bad', !!bad);
      if (bad === '') { hint.textContent = 'k = thousand, m = million (2.5k = 2,500).'; return null; }
      if (bad) { hint.textContent = bad; return null; }
      hint.textContent = '= ' + fmt(n) + ' PAT' + (balance != null ? ' · leaves you ' + fmt(balance - n) + ' PAT' : '');
      return n;
    }
    amt.addEventListener('input', check);
    function step(s) { form.hidden = s !== 'form'; conf.hidden = s !== 'confirm'; done.hidden = s !== 'done'; }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = check();
      if (n === null) { if (!amt.value.trim()) { hint.classList.add('bad'); hint.textContent = 'Enter an amount to tip.'; } amt.focus(); return; }
      var t = note.value.replace(/\s+/g, ' ').trim();
      pending = { amount: n, note: t, key: newKey() };       // one key per confirmed attempt: a double click / retry can't send twice
      sum.textContent = 'Send ' + fmt(n) + ' PAT to ' + who + '?';
      cnote.textContent = t ? '“' + t + '”' : '';
      cnote.hidden = !t;
      var big = balance != null && n >= balance * 0.5 && n >= 10000;
      warn.hidden = !big;
      if (big) warn.textContent = n === balance ? 'Heads up: this is your whole balance.' : 'Heads up: that\'s ' + Math.round(n / balance * 100) + '% of your balance.';
      err.textContent = '';
      send.disabled = false; send.textContent = 'Send ' + fmt(n) + ' PAT';
      step('confirm');
      send.focus();
    });
    back.addEventListener('click', function () { pending = null; step('form'); amt.focus(); });
    send.addEventListener('click', function () {
      if (!pending || send.disabled) return;
      send.disabled = true; send.textContent = 'Sending…'; err.textContent = '';
      var p = pending;
      fetch('/u/' + encodeURIComponent(o.to) + '/tip', {
        method: 'POST', credentials: 'same-origin', redirect: 'manual',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ amount: p.amount, note: p.note, idempotency_key: p.key, room: o.slug || '' }),
      }).then(function (r) {
        if (r.type === 'opaqueredirect' || r.status === 0) return { status: 401, ok: false, d: {} };    // signed out: the route redirects to /login
        var ct = r.headers.get('content-type') || '';
        return (ct.indexOf('json') >= 0 ? r.json() : r.text().then(function (t) { return { message: t }; }))
          .then(function (j) { return { status: r.status, ok: r.ok, d: j || {} }; });
      }).then(function (res) {
        if (res.ok) {
          if (typeof res.d.balance === 'number') balance = res.d.balance;
          dmsg.textContent = '💸 Sent ' + fmt(p.amount) + ' PAT to ' + who + '.' + (balance != null ? ' Your balance: ' + fmt(balance) + ' PAT.' : '')
            + (res.d.announce ? ' Pepe will say it in the room.' : '');
          step('done'); dclose.focus();
          return;
        }
        send.disabled = false; send.textContent = 'Try again';
        if (res.status === 409) { err.textContent = 'That tip is still going through - check your history before trying again.'; return; }
        if (res.status === 401) { err.textContent = 'You\'ve been signed out - sign in and try again.'; return; }
        var m = String(res.d.message || res.d.error || '');
        if (/insufficient/i.test(m)) m = 'You don\'t have enough PAT for that any more.';
        else if (!m || m.length > 160) m = 'The tip didn\'t go through - nothing was sent.';
        err.textContent = m;
        if (res.status !== 500) pending.key = newKey();     // a refused attempt is final; a fresh try gets a fresh key
      }).catch(function () {
        // network error: it may have landed - keep the SAME key so a retry can't send twice
        send.disabled = false; send.textContent = 'Retry';
        err.textContent = 'Couldn\'t reach the server. Retrying is safe - it won\'t send twice.';
      });
    });
  }

  P.tipModal = tipModal;
  P._tipParse = parseAmt;          // tests
})();
