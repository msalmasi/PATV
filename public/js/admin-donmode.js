// admin-donmode.js (1.99aor) - the admin Economy page's donations switch (donationmode.js on the server).
// Pick a state, enter the account password: a single-use step-up nonce (POST /api/admin/stepup/nonce {for: "donations_mode"}), then
// POST /api/admin/donations/mode with the state this page shows (from: a page left open can't undo a newer change, it gets 409 "stale" and
// the current state). A Pepe owner only: the server checks that and the password again. The promo card re-reads afterwards.
(function () {
  'use strict';
  var box = document.getElementById('dmAdm');
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var form = $('dmForm');
  var FETCH = { 'content-type': 'application/json', 'X-Requested-With': 'fetch' };
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var utc = function (ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); };
  var current = (box.querySelector('input[name="dmMode"]:checked') || {}).value || 'perks';
  function msg(t, bad) { var m = $('dmMsg'); m.textContent = t || ''; m.className = 'adm-msg' + (t ? (bad ? ' err' : ' ok') : ''); }
  function row(tb, vals, numFrom) {
    var tr = document.createElement('tr');
    vals.forEach(function (v, i) { var td = document.createElement('td'); td.textContent = v == null ? '' : String(v); if (numFrom != null && i >= numFrom) td.className = 'num'; tr.appendChild(td); });
    tb.appendChild(tr);
  }
  function empty(tb, n, text) { var tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = n; td.className = 'empty'; td.textContent = text; tr.appendChild(td); tb.appendChild(tr); }
  function render(D) {
    current = D.mode;
    var O = D.describe[D.mode], pill = $('dmPill');
    pill.textContent = O.label;
    pill.className = 'adm-pill ' + (D.mode === 'on' ? 'ok' : D.mode === 'off' ? 'bad' : 'admin');
    $('dmNow').textContent = O.text;
    $('dmWho').textContent = (D.readable ? '' : 'The saved setting can\'t be read, so the site is treating it as Perks only. ') +
      (D.updated ? 'Last changed ' + utc(D.updated) + ' UTC by ' + (D.actor || '?') + '.' : 'Never changed: this is the default.');
    Array.prototype.forEach.call(box.querySelectorAll('input[name="dmMode"]'), function (r) { r.checked = r.value === D.mode; });
    $('dmCredits').textContent = fmt(D.credits.n) + ' · ' + fmt(D.credits.pat) + ' PAT · +' + fmt(D.credits.bonus) + ' bonus';
    $('dmOpen').textContent = fmt(D.open_quotes);
    $('dmClawed').textContent = fmt(D.credits.clawed) + ' PAT' + (D.credits.short ? ' · ' + fmt(D.credits.short) + ' PAT could not be taken (already spent)' : '') +
      (D.credits.owed ? ' · ' + fmt(D.credits.owed) + ' PAT still owed back (the account can\'t be credited)' : '');
    // the rest of the page that speaks about the state
    $('dmRate').textContent = fmt(D.normal.rate) + ' PAT per $1 · +' + D.normal.bonus_pct + '% to incentives' + (D.mode === 'on' ? '' : ' (not applied in this state)');
    var mono = $('dmMono');
    if (mono) {
      var inKv = !!(mono.closest && mono.closest('#monetaryKv'));
      mono.textContent = D.mode === 'on' ? (inKv ? 'applied (switch on)' : 'on (PAT at the default rate)') : D.mode === 'off' ? (inKv ? 'not applied (paused)' : 'paused') : (inKv ? 'not applied (perks only)' : 'perks only');
    }
    var rb = $('dmRb'), rows = (D.rollback.card || []).map(function (r) { return ['card', r]; }).concat((D.rollback.crypto || []).map(function (r) { return ['crypto', r]; }));
    rb.textContent = '';
    rows.forEach(function (x) { row(rb, [x[0], x[1].username || x[1].user_id, (Number(x[1].usd_cents || 0) / 100).toFixed(2), x[1].ref]); });
    $('dmRbBox').hidden = !rows.length;
    var lg = $('dmLog'); lg.textContent = '';
    (D.history || []).forEach(function (h) { var d = h.detail || {}; row(lg, [utc(h.at), h.admin, d.before, d.after, h.reason]); });
    if (!(D.history || []).length) empty(lg, 5, 'No changes yet.');
    var rv = $('dmRev'); rv.textContent = '';
    (D.reversals || []).forEach(function (r) { row(rv, [utc(r.at), r.username || r.user_id, r.kind, (r.cents / 100).toFixed(2), fmt(r.pat_delta), fmt(r.bonus_delta), fmt(r.short_pat)], 3); });
    if (!(D.reversals || []).length) empty(rv, 7, 'None.');
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: FETCH, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.code; e.detail = j.detail; throw e; }
        return j;
      }); });
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pick = (box.querySelector('input[name="dmMode"]:checked') || {}).value;
    if (!pick || pick === current) { msg('That is already the current state.', true); return; }
    var pw = $('dmPw').value;
    if (!pw) { msg('Enter your account password first.', true); $('dmPw').focus(); return; }
    var go = $('dmGo');
    go.disabled = true;
    msg('');
    post('/api/admin/stepup/nonce', { for: 'donations_mode' })
      .then(function (n) { return post('/api/admin/donations/mode', { mode: pick, from: current, note: $('dmNote').value, nonce: n.nonce, password: pw }); })
      .then(function (j) {
        $('dmPw').value = ''; $('dmNote').value = '';
        render(j.donations);
        msg('Saved. Donations are now: ' + j.donations.describe[j.donations.mode].label + '.');
        document.dispatchEvent(new CustomEvent('donmode:changed'));
      })
      .catch(function (e) {
        $('dmPw').value = '';
        if (e.code === 'stale' && e.detail) { render(e.detail); document.dispatchEvent(new CustomEvent('donmode:changed')); }   // someone moved it: show what is true now
        msg(e.message, true);
      })
      .then(function () { go.disabled = false; });
  });
})();
