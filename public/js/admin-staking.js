// admin-staking.js (staking fix plan, 2026-10-19) - /admin/economy's 🏦 Staking card (views/partials/econ-staking.ejs,
// capital/watch.js). Read: GET /api/admin/econ/staking (the ceiling, the cushion switch + its size per vault, the weekly payout
// cap, the time-weighting (PAT-days, since when, partial or not), Auto under the staker limit, the stakers' index, the 25%-cap
// tracker, the round trips around Monday's draw, the last audit, recent changes). Change (a Pepe owner only - the server
// re-checks): the weekly payout cap only, through the /admin/economy step-up - a single-use nonce from
// POST /api/admin/econ/edit/nonce + the account password - then POST /api/admin/econ/staking {nonce, password, op: "bonus_cap",
// value}; the answer is a website action Pepe runs (!econ set wf_staker_cap_pct <n>), polled at GET /api/admin/econ/edit/:id.
// The ceiling, the cushion and Auto's limit are shown with the admin-panel knob that sets them. Setting the cap to 0 while
// this week isn't wholly time-weighted (the first week after the deploy, or a later one with a missing / pruned PAT-days
// bucket) says that week still settles under the 25% reference cap (D2's safeguard, Pepe 31c65d0 - automatic, nothing to do by
// hand). Everything from the server is shown as text (textContent).
(function () {
  'use strict';
  var box = document.getElementById('stkAdm');
  if (!box) return;
  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var $ = function (id) { return document.getElementById(id); };
  var csrf = box.getAttribute('data-csrf');
  var canEdit = box.getAttribute('data-edit') === '1';
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var pct = function (f, dp) { return f == null ? '—' : (Number(f) * 100).toFixed(dp == null ? 1 : dp) + '%'; };
  var when = function (ms) { return ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') : '—'; };
  var LBL = { bank: '🏦 Bank', house: '🎰 House', mm: '📈 Market maker', auto: '🤖 Auto' };
  var st = null, pending = null, nonce = null, poll = null;

  function msg(t, bad) { var m = $('stkMsg'); m.textContent = t || ''; m.className = 'adm-msg stk-out' + (bad ? ' stk-bad' : ''); }
  function kv(el, label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); el.appendChild(d); }
  function row(tbody, cells, cls) {
    var tr = document.createElement('tr');
    cells.forEach(function (c, i) { var td = document.createElement('td'); td.textContent = c == null ? '' : String(c); if (cls && cls[i]) td.className = cls[i]; tr.appendChild(td); });
    tbody.appendChild(tr);
  }
  function empty(tbody, cols, text) { tbody.textContent = ''; var tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = cols; td.className = 'empty'; td.textContent = text; tr.appendChild(td); tbody.appendChild(tr); }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: { 'x-csrf-token': csrf, 'X-Requested-With': 'fetch' } };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); });
  }

  function render() {
    var c = st.cfg || {}, k = $('stkKv');
    k.textContent = '';
    var P = st.panel || {};
    var panel = function (op) { return ' · ' + _t('js.admstk.panel_v', "set on Pepe's admin panel ({knob})", { knob: P[op] || op }); };
    kv(k, _t('js.admstk.ceil_k', 'Daily APR ceiling'), (c.ceil_apr > 0 ? _t('js.admstk.ceil_v', "{p} a year: stakers' share-price growth above it goes to the protocol; losses are not capped", { p: pct(c.ceil_apr, 1) }) : _t('js.admstk.ceil_off', 'off')) + panel('ceiling'));
    kv(k, _t('js.admstk.cushion_k', 'Protocol cushion'), (c.cushion ? _t('js.admstk.cushion_on', 'ON - a losing day is covered from the last {days} days of skims', { days: c.cushion_days })
      : _t('js.admstk.cushion_off', 'OFF - skims are recorded ({days}-day window) but nothing is given back', { days: c.cushion_days })) + panel('cushion'));
    kv(k, _t('js.admstk.cap_k', 'Weekly payout cap'), c.bonus_cap > 0 ? _t('js.admstk.cap_v', '{p} a year on the staked value', { p: pct(c.bonus_cap, 1) }) : _t('js.admstk.cap_none', 'no cap'));
    kv(k, _t('js.admstk.weighted_k', 'Weekly payout split'), c.weighted ? _t('js.admstk.weighted_on', 'by PAT-days (how much each stash held and for how long) - this week settles {when} UTC', { when: when(Number(c.pd_boundary) * 1000) })
      : _t('js.admstk.weighted_off', 'by the stakes at the settlement (no PAT-days recorded yet)'));
    if (st.live) {
      kv(k, _t('js.admstk.pd_from_k', 'Time-weighting since'), !c.pd_from ? _t('js.admstk.pd_none', 'not started yet (the first cut-off after the deploy starts it)')
        : c.pd_partial ? _t('js.admstk.pd_from_partial', "{when} UTC - this week isn't fully time-weighted: with no weekly cap, its settlement on {settle} UTC is held to the 25% reference cap", { when: when(Number(c.pd_from) * 1000), settle: when(Number(c.pd_boundary) * 1000) })
        : _t('js.admstk.pd_from_v', '{when} UTC', { when: when(Number(c.pd_from) * 1000) }));
    }
    kv(k, _t('js.admstk.staker_max_k', 'Staker limit'), pct(c.staker_max, 0) + ' · ' + (c.auto_staker_cap ? _t('js.admstk.autocap_on', 'Auto deposits and rebalances obey it') : _t('js.admstk.autocap_off', 'Auto deposits skip it (direct stakes obey it)')) + panel('auto_cap'));
    var age = Number(st.cfg_age);
    kv(k, _t('js.admstk.pushed_k', "Pepe's settings"), isFinite(age) ? _t('js.admstk.pushed_v', 'pushed {m} min ago', { m: Math.round(age / 60) }) : _t('js.admstk.never', 'never pushed'));
    if (!st.live) kv(k, _t('js.admstk.where_k', 'Vault book'), _t('js.admstk.local', 'in Pepe (the capital backend is off here) - the cut-off runs there'));
    $('stkCap').value = String(c.bonus_cap == null ? 25 : Math.round(c.bonus_cap * 1000) / 10);
    var V = $('stkVaults'), ks = Object.keys(st.vaults || {});
    if (!ks.length) empty(V, 9, _t('js.admstk.no_book', 'No vault book on the site.'));
    else {
      V.textContent = '';
      ks.forEach(function (v) {
        var x = st.vaults[v], cu = x.cushion || {}, pd = x.pat_days;
        var prot = x.basis == null ? fmt(x.protocol_value) : _t('js.admstk.prot_v', '{v} (basis {b})', { v: fmt(x.protocol_value), b: fmt(x.basis) });
        row(V, [LBL[v] || v, (Number(x.price) || 0).toFixed(6), x.peak_price == null ? '—' : Number(x.peak_price).toFixed(6),
          _t('js.admstk.cushion_cell', '{pat} PAT ({n} skims)', { pat: fmt(cu.value), n: cu.entries || 0 }), prot,
          x.nav > 0 ? pct(x.staked / x.nav, 1) : '—',
          pd ? _t('js.admstk.pd_cell', '{pd} ({n} stashes)', { pd: fmt(pd.total), n: pd.stashes }) : '—',
          pct(x.staker_apr7, 1), pct(x.vault_apr7, 1)], ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num', 'num']);
      });
    }
    // D2: what a 25% APR cap would have paid, week by week (the newest first)
    var T = $('stkTrack'), tr = (st.track || []).slice().reverse();
    if (!tr.length) empty(T, 6, _t('js.admstk.track_none', 'No settled week reported by Pepe yet.'));
    else {
      T.textContent = '';
      tr.forEach(function (w) {
        var tot = w.total || {};
        var split = ['house', 'bank', 'mm'].filter(function (v) { return w.vaults && w.vaults[v] && w.vaults[v].pool > 0; })
          .map(function (v) {
            var x = w.vaults[v];
            // D2's safeguard (Pepe 31c65d0): no cap in force, the week not wholly time-weighted -> paid under the 25% reference cap
            return (LBL[v] || v) + ' ' + fmt(x.paid) + ' / ' + fmt(x.would25)
              + (x.fallback ? ' (' + _t('js.admstk.track_fb', '25% reference cap: {w}', { w: x.weighting || '?' }) + ')' : '');
          }).join(' · ');
        row(T, [String(w.eid || '').slice(1), fmt(tot.pool), fmt(tot.paid), fmt(tot.would25), fmt(tot.over), split || '—'], ['', 'num', 'num', 'num', 'num', '']);
      });
    }
    // the round trips around Monday's draw (the newest first)
    var R = $('stkRt'), rt = (st.roundtrips || []).slice().reverse();
    if (!rt.length) empty(R, 6, _t('js.admstk.rt_none', 'No round trips seen yet.'));
    else {
      R.textContent = '';
      rt.forEach(function (w) {
        row(R, [String(w.eid || '').slice(1), fmt(w.pairs), (w.stashes || []).slice(0, 12).join(', ') || '—', fmt(w.out), fmt(w.in), fmt(w.dodged)], ['', 'num', '', 'num', 'num', 'num']);
      });
    }
    var A = $('stkAudit');
    A.textContent = '';
    var w = st.watch, items = [];
    if (w && (w.findings || []).length) w.findings.forEach(function (f) { items.push([f.level, (w.day || '') + ' · ' + f.title + (f.body ? ' - ' + f.body : '')]); });
    (st.weekly || []).slice(-2).forEach(function (x) { (x.findings || []).forEach(function (f) { items.push([f.level, x.eid + ' · ' + f.title + (f.body ? ' - ' + f.body : '')]); }); });
    if (!items.length) { var li = document.createElement('li'); li.textContent = w ? _t('js.admstk.audit_clean', 'The last cut-off ({day}) audited clean.', { day: w.day }) : _t('js.admstk.audit_none', 'No audited cut-off yet.'); A.appendChild(li); }
    items.forEach(function (it) { var li = document.createElement('li'); li.className = it[0]; li.textContent = '[' + it[0] + '] ' + it[1]; A.appendChild(li); });
    var G = $('stkActs');
    if (!(st.actions || []).length) empty(G, 4, _t('js.admstk.no_changes', 'No changes from this card yet.'));
    else {
      G.textContent = '';
      st.actions.forEach(function (a) { row(G, [when(a.created), a.username || '?', a.label || '', (a.status || '') + (a.message ? ': ' + a.message : '')]); });
    }
    if (canEdit && st.can_edit !== true) {        // the server's answer wins (a role changed since the page loaded)
      canEdit = false;
      Array.prototype.forEach.call($('stkForm').querySelectorAll('input, select, button'), function (el) { el.disabled = true; });
    }
  }
  function load() {
    return api('/api/admin/econ/staking').then(function (r) {
      if (r.status !== 200 || !r.j.ok) throw new Error(r.j.error || _t('js.admstk.failed', 'That did not work - try again.'));
      st = r.j; render();
    }).catch(function (e) { msg(e.message, true); });
  }
  function cancel() { pending = null; nonce = null; $('stkConfirm').hidden = true; $('stkPw').value = ''; }
  function ask(op, value, what) {
    if (!st || !canEdit) return;
    cancel();
    pending = { op: op, value: value };
    $('stkWhat').textContent = what;
    $('stkConfirm').hidden = false;
    msg('');
    api('/api/admin/econ/edit/nonce', {}).then(function (x) {
      if (!x.j.nonce) throw new Error(x.j.error || _t('js.admstk.failed', 'That did not work - try again.'));
      nonce = x.j.nonce; $('stkPw').focus();
    }).catch(function (e) { msg(e.message, true); cancel(); });
  }
  function follow(id, n) {
    if (poll) clearTimeout(poll);
    poll = setTimeout(function () {
      api('/api/admin/econ/edit/' + encodeURIComponent(id)).then(function (r) {
        var a = (r.j || {}).action;
        if (!a) return;
        if (a.status === 'pending' || a.status === 'claimed') {
          if (n < 40) follow(id, n + 1); else msg(_t('js.admstk.slow', "Pepe hasn't run it yet - it stays queued; check back later."));
          return;
        }
        msg((a.status === 'done' ? _t('js.admstk.done', 'Pepe: {m}', { m: a.message || 'done' }) : _t('js.admstk.not_done', 'Pepe refused it: {m}', { m: a.message || a.status })), a.status !== 'done');
        load();
      });
    }, 3000);
  }

  $('stkSetCap').addEventListener('click', function () {
    var v = String($('stkCap').value).trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(v) || Number(v) > 100) { msg(_t('js.admstk.bad_cap', 'The cap is 0 to 100 (% a year; 0 = no cap).'), true); return; }
    var c = (st && st.cfg) || {};
    var what = _t('js.admstk.ask_cap', "Set the weekly payout cap to {cap}% a year on the staked value (0 = no cap) from the next weekly settlement. The daily ceiling doesn't change. Pepe runs !econ set wf_staker_cap_pct {cap}.", { cap: v });
    // D2's safeguard (Pepe 31c65d0): with no cap, a week that isn't wholly time-weighted (pd_partial, Pepe's bucket rule) still
    // settles under the 25% reference cap. The "PAT-days since ..." note only for the FIRST week (pd_first: they began inside
    // it); any other partial week (a missing or pruned bucket, a longer stretch) gets the plain one - no stale date
    if (Number(v) === 0 && c.pd_partial) {
      what = (c.pd_first && c.pd_from
        ? _t('js.admstk.ask_cap_partial', "Note: this is the first week of the time-weighting (PAT-days since {when} UTC), so it isn't fully time-weighted: a stake made just before they began weighs as if held since then. With no cap, Pepe still holds this week's settlement on {settle} UTC to the 25% reference cap, automatically; the stakers' full share applies from the first fully time-weighted week.",
          { when: when(Number(c.pd_from) * 1000), settle: when(Number(c.pd_boundary) * 1000) })
        : _t('js.admstk.ask_cap_partial_gap', "Note: this week isn't fully time-weighted - the PAT-days don't cover all of the time since the last settlement. With no cap, Pepe still holds this week's settlement on {settle} UTC to the 25% reference cap, automatically; the stakers' full share applies again from the next fully time-weighted week.",
          { settle: when(Number(c.pd_boundary) * 1000) })) + ' ' + what;
    }
    ask('bonus_cap', v, what);
  });
  $('stkNo').addEventListener('click', function () { cancel(); msg(_t('js.admstk.cancelled', 'Cancelled - nothing changed.')); });
  $('stkYes').addEventListener('click', function () {
    if (!pending || !nonce) { msg(_t('js.admstk.start_again', 'Start again.'), true); return; }
    var body = { nonce: nonce, password: $('stkPw').value, op: pending.op, value: pending.value };
    cancel();
    msg(_t('js.admstk.sending', 'Sending to Pepe…'));
    api('/api/admin/econ/staking', body).then(function (r) {
      var j = r.j || {};
      if (r.status === 200 && j.ok) { msg(_t('js.admstk.queued', 'Queued for Pepe: {cmd}', { cmd: j.command })); follow(j.request.id, 0); return load(); }
      msg(j.error || _t('js.admstk.failed', 'That did not work - try again.'), true);
      return null;
    }).catch(function (e) { msg(e.message, true); });
  });
  load();
})();
