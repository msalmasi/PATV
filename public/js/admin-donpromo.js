// admin-donpromo.js (1.99tq) - the admin Economy page's 💖 Donations: promos card (donationpromo.js on the server).
// Create / edit / end a time-limited donation promo, see it live (time left, donors, $ and PAT at the promo rate vs the
// budget), past promos, the settings (ceiling, default bonus base, time zone) and the audit log. The server validates.
// 1.99vi: the budget is PAT at the promo rate - the form shows what it's worth in dollars as you type, can take it in
// dollars (stored as PAT), and warns (the server refuses unless confirmed) when it is smaller than ONE donor's full promo
// allowance; the card shows budget used / exhausted and how many donations fell back to the normal rate because of it.
(function () {
  'use strict';
  var box = document.getElementById('dpAdm');
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var B = window.DPBudget;
  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var fmt = function (n) { return n == null ? '—' : Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var usd = function (c) { return '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };
  var view = null, editing = null;
  function msg(t, bad) { var m = $('dpMsg'); m.textContent = t || ''; m.className = 'adm-msg' + (t ? (bad ? ' err' : ' ok') : ''); }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok || !j.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.code || null; e.detail = j.detail || null; throw e; }
      return j;
    }); });
  }
  function kv(label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); return d; }
  function pill(text, cls) { var s = document.createElement('span'); s.className = 'adm-pill ' + cls; s.textContent = text; return s; }
  // 1.99vi: the budget line + the exhausted flag (red) + the budget fallbacks
  function budgetUsed(p) {
    var g = p.budget;
    return _t('js.adm.dp.budget_used', '{used} of {total} PAT (≈ ${used_usd} of ${total_usd})',
      { used: fmt(g.used_pat), total: fmt(g.pat), used_usd: B.usd(g.used_cents), total_usd: B.usd(g.cents) });
  }
  function budgetKv(p) {
    var d = kv(_t('js.adm.dp.budget_used_l', 'Budget used'), budgetUsed(p)), s = d.lastChild;
    if (p.budget.exhausted_live) { s.appendChild(document.createTextNode(' ')); s.appendChild(pill(_t('js.adm.dp.budget_exhausted', 'BUDGET EXHAUSTED - donations now get the normal rate'), 'bad')); }
    else if (p.budget.small) { s.appendChild(document.createTextNode(' ')); s.appendChild(pill(_t('js.adm.dp.budget_small_flag', 'smaller than one donor’s allowance'), 'bad')); }
    return d;
  }
  function fallbackKv(p) {
    return kv(_t('js.adm.dp.fallbacks_l', 'Normal rate (budget ran out)'), _t('js.adm.dp.fallbacks', '{n} donations · ${usd} that would have earned the promo rate',
      { n: fmt(p.stats.budget_fallbacks || 0), usd: B.usd(p.stats.budget_short_cents || 0) }));
  }
  // the promo rate the create form describes (0 = not above the normal rate yet)
  function formRate() {
    if (!view) return 0;
    var N = view.normal.rate, m = $('dpMode').value;
    var r = m === 'rate' ? Math.floor(Number($('dpRate').value) || 0) : Math.floor(N * (Number($('dpMult').value) || 0));
    return r > N ? Math.min(r, Math.floor(N * view.settings.ceiling_x)) : 0;
  }
  // the budget field (pre = 'dp' create / 'dpE' edit) -> PAT ('' = none, NaN = can't tell yet)
  function budgetPat(pre, rate) {
    var raw = String($(pre + 'Budget').value || '').trim();
    if (raw === '') return '';
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) return raw;                                   // the server says what's wrong
    if ($(pre + 'BudgetUnit').value === 'usd') return rate > 0 ? B.patOfUsd(n, rate) : NaN;
    return Math.floor(n);
  }
  function budgetCtx(pre) { return pre === 'dp' ? { rate: formRate(), cap: (Number($('dpCap').value) || 0) * 100 } : { rate: editing ? editing.effective_rate : 0, cap: editing ? editing.cap_cents : 0 }; }
  function budgetUi(pre) {
    var c = budgetCtx(pre), pat = budgetPat(pre, c.rate);
    $(pre + 'BudgetHelp').textContent = B.helperText(_t, $(pre + 'Budget').value, $(pre + 'BudgetUnit').value, c.rate);
    var w = typeof pat === 'number' && isFinite(pat) ? B.check(pat, c.cap, c.rate) : null;
    if (pre === 'dpE' && editing && pat === editing.budget_pat) w = null;      // unchanged: the server doesn't re-ask either
    var el = $(pre + 'BudgetWarn'); el.textContent = B.warnText(_t, w); el.hidden = !w;
    return { pat: pat, warn: w };
  }
  // switching PAT <-> $ converts what's typed
  function unitSwitch(pre) {
    var c = budgetCtx(pre), el = $(pre + 'Budget'), raw = String(el.value || '').trim(), n = Number(raw);
    if (raw !== '' && isFinite(n) && n > 0 && c.rate > 0) el.value = $(pre + 'BudgetUnit').value === 'usd' ? B.centsOf(Math.floor(n), c.rate) / 100 : B.patOfUsd(n, c.rate);
    budgetUi(pre);
  }
  function confirmSmall(w) { return confirm(_t('js.adm.dp.budget_confirm', '{warning} Keep this budget anyway?', { warning: B.warnText(_t, w) })); }
  // send; a too-small budget is confirmed first (and again if the server, with the rate it sees now, disagrees)
  function sendBudgeted(path, b, w) {
    if (w) { if (!confirmSmall(w)) { msg(''); return Promise.reject(null); } b.confirm_budget = true; }
    return api(path, b).catch(function (e) {
      if (e && e.code === 'budget_small' && !b.confirm_budget && confirmSmall(e.detail)) { b.confirm_budget = true; return api(path, b); }
      throw e;
    });
  }
  function left(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
  }
  var when = function (ms) { return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  // datetime-local <-> ms in the admin's own time zone
  function toLocalInput(ms) { var d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
  function fromLocalInput(v) { if (!v) return null; var t = new Date(v).getTime(); return isNaN(t) ? null : t; }
  function rateText(p) { return p.mode === 'mult' ? '×' + p.mult + ' (' + fmt(p.effective_rate) + ')' : fmt(p.rate); }
  function fillBonus(sel, val) {
    sel.textContent = '';
    Object.keys(view.bonus_bases).forEach(function (k) {
      var o = document.createElement('option'); o.value = k; o.textContent = k + ' - ' + view.bonus_bases[k]; if (k === val) o.selected = true; sel.appendChild(o);
    });
  }
  function modeUi() {
    var m = $('dpMode').value;
    $('dpRateL').style.display = m === 'rate' ? '' : 'none';
    $('dpMultL').style.display = m === 'mult' ? '' : 'none';
    var today = $('dpToday').checked;
    $('dpStarts').disabled = today; $('dpEnds').disabled = today;
    preview();
  }
  function preview() {
    if (!view) return;
    var N = view.normal.rate, ceil = view.settings.ceiling_x, m = $('dpMode').value;
    var r = m === 'rate' ? Math.floor(Number($('dpRate').value) || 0) : Math.floor(N * (Number($('dpMult').value) || 0));
    var cap = Number($('dpCap').value) || 0, out = 'Normal rate: ' + fmt(N) + ' PAT per $1 (+' + view.normal.bonus_pct + '% to incentives). Ceiling: ' + ceil + '× = ' + fmt(N * ceil) + ' PAT per $1.';
    if (r > N) out += ' Promo: ' + fmt(r) + ' PAT per $1 (×' + (Math.round(r / N * 100) / 100) + ') for the first $' + fmt(cap) + ' per donor = up to ' + fmt(r * cap) + ' PAT each' + (r > N * ceil ? ' - OVER THE CEILING, it will be refused.' : '.');
    if ($('dpToday').checked) out += ' Ends ' + when(view.today_ends) + ' (' + view.settings.tz + ' midnight).';
    $('dpPreview').textContent = out;
    budgetUi('dp');
  }
  function render() {
    var k = $('dpKv'); k.textContent = '';
    var live = (view.promos || []).filter(function (p) { return p.status === 'live'; })[0];
    k.appendChild(kv('Normal rate (Pepe)', fmt(view.normal.rate) + ' PAT per $1 · +' + view.normal.bonus_pct + '% to incentives'));
    if (live) {
      k.appendChild(kv('Live promo', (live.label || live.id) + ' · ' + rateText(live) + ' PAT per $1 · first $' + fmt(live.cap_usd) + ' per donor'));
      k.appendChild(kv('Time left', left(live.ends - Date.now()) + ' (ends ' + when(live.ends) + ')'));
      k.appendChild(kv('So far', fmt(live.stats.donors) + ' donors · ' + usd(live.stats.promo_cents) + ' at the promo rate of ' + usd(live.stats.usd_cents) + ' · ' +
        fmt(live.stats.promo_pat) + ' PAT at the promo rate (' + fmt(live.stats.extra_pat) + ' above the normal rate)'));
      if (live.budget) { k.appendChild(budgetKv(live)); k.appendChild(fallbackKv(live)); }
    } else k.appendChild(kv('Live promo', 'none'));
    $('dpTz').textContent = view.settings.tz;
    var rows = $('dpRows'); rows.textContent = '';
    (view.promos || []).forEach(function (p) {
      var tr = document.createElement('tr');
      var cells = [(p.label ? p.label + ' ' : '') + '(' + p.id + ')', p.status + (p.status === 'live' ? ' · ' + left(p.ends - Date.now()) + ' left' : ''),
        when(p.starts) + ' → ' + when(p.ends), rateText(p), '$' + fmt(p.cap_usd), fmt(p.stats.donors), usd(p.stats.promo_cents),
        fmt(p.stats.promo_pat) + (p.budget_pat != null ? ' / ' + fmt(p.budget_pat) : '')];
      cells.forEach(function (t, i) {
        var td = document.createElement('td'); td.textContent = t; if (i >= 3) td.className = 'num';
        if (i === 7 && p.budget) {
          td.title = budgetUsed(p);
          if (p.budget.exhausted_live) { td.appendChild(document.createElement('br')); td.appendChild(pill(_t('js.adm.dp.budget_exhausted', 'BUDGET EXHAUSTED - donations now get the normal rate'), 'bad')); }
          if (p.stats.budget_fallbacks) { td.appendChild(document.createElement('br')); td.appendChild(document.createTextNode(_t('js.adm.dp.fallbacks', '{n} donations · ${usd} that would have earned the promo rate', { n: fmt(p.stats.budget_fallbacks), usd: B.usd(p.stats.budget_short_cents) }))); }
        }
        tr.appendChild(td);
      });
      var td = document.createElement('td');
      if (['live', 'paused', 'scheduled', 'draft'].indexOf(p.status) >= 0) {
        var e = document.createElement('button'); e.type = 'button'; e.className = 'adm-btn ghost sm'; e.textContent = 'Edit';
        e.addEventListener('click', function () { openEdit(p); });
        var x = document.createElement('button'); x.type = 'button'; x.className = 'adm-btn danger sm'; x.textContent = p.status === 'scheduled' || p.status === 'draft' ? 'Cancel' : 'End now';
        x.addEventListener('click', function () {
          if (!confirm((x.textContent === 'End now' ? 'End ' : 'Cancel ') + (p.label || p.id) + ' now?')) return;
          api('/api/admin/donpromo/' + encodeURIComponent(p.id) + '/end', {}).then(function () { msg('Done.'); load(); }, function (er) { msg(er.message, true); });
        });
        td.appendChild(e); td.appendChild(document.createTextNode(' ')); td.appendChild(x);
      }
      tr.appendChild(td);
      rows.appendChild(tr);
    });
    if (!(view.promos || []).length) { var tr = document.createElement('tr'), c = document.createElement('td'); c.colSpan = 9; c.className = 'empty'; c.textContent = 'No promos yet.'; tr.appendChild(c); rows.appendChild(tr); }
    var lg = $('dpLog'); lg.textContent = '';
    (view.log || []).forEach(function (r) {
      var tr = document.createElement('tr'), d = r.detail || {};
      var what = (d.what || '') + ' ' + (d.id || '') + (d.changed ? ' ' + JSON.stringify(d.changed) : '');
      [new Date(r.at).toISOString().slice(0, 16).replace('T', ' '), r.admin || '', what].forEach(function (t) { var td = document.createElement('td'); td.textContent = t; tr.appendChild(td); });
      lg.appendChild(tr);
    });
    renderLimit();
    if (!(view.log || []).length) { var tr2 = document.createElement('tr'), c2 = document.createElement('td'); c2.colSpan = 3; c2.className = 'empty'; c2.textContent = 'No changes yet.'; tr2.appendChild(c2); lg.appendChild(tr2); }
  }
  // 1.99ts: the daily donation limit
  function cellRow(tb, vals, numFrom) {
    var tr = document.createElement('tr');
    vals.forEach(function (t, i) { var td = document.createElement('td'); td.textContent = t; if (numFrom != null && i >= numFrom && i < numFrom + 2) td.className = 'num'; tr.appendChild(td); });
    tb.appendChild(tr);
  }
  function emptyRow(tb, n, text) { var tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = n; td.className = 'empty'; td.textContent = text; tr.appendChild(td); tb.appendChild(tr); }
  // 1.99uh: the global daily donation cap
  function renderGlobal() {
    var G = view.global || {}, k = $('dgKv'); k.textContent = '';
    if (!G.on) { k.appendChild(kv('Status', 'off')); return; }
    k.appendChild(kv('Mode', G.mode === 'pct' ? view.settings.global_pct + '% of the supply frozen today (' + fmt(G.supply) + ' PAT)' : G.mode === 'fixed' ? 'fixed' : 'USD cap only'));
    if (G.cap_pat != null) k.appendChild(kv('PAT minted today', fmt(G.used_pat) + ' of ' + fmt(G.cap_pat) + ' (' + fmt(G.left_pat) + ' left)'));
    if (G.cap_cents != null) k.appendChild(kv('Dollars today', usd(G.used_cents) + ' of ' + usd(G.cap_cents) + ' (' + usd(G.left_cents) + ' left)'));
    k.appendChild(kv('Day', G.day + ' (New York) - resets ' + when(G.resets_at)));
    k.appendChild(kv('Over the cap', fmt(G.flagged_count) + ' credited anyway (races / approved holds) · ' + fmt(G.crypto_held) + ' crypto held'));
  }
  function renderLimit() {
    renderGlobal();
    var L = view.limit || {};
    $('dlTz').textContent = L.tz || view.settings.tz;
    var k = $('dlKv'); k.textContent = '';
    k.appendChild(kv('Default limit', L.default_usd ? '$' + fmt(L.default_usd) + ' per member per day' : 'none (0)'));
    k.appendChild(kv('Credited over the limit', fmt(L.flagged_count) + ' donation' + (L.flagged_count === 1 ? '' : 's') + ' (card races / approved crypto holds)'));
    k.appendChild(kv('Crypto held for the limit', fmt(L.crypto_held) + ' waiting on /admin/crypto'));
    var f = $('dlFlagged'); f.textContent = '';
    (L.flagged || []).forEach(function (r) { cellRow(f, [new Date(r.paid_at).toISOString().slice(0, 16).replace('T', ' '), r.username || r.user_id, r.via, usd(r.usd_cents), r.limit_cents ? usd(r.limit_cents) : '—'], 3); });
    if (!(L.flagged || []).length) emptyRow(f, 5, 'Nothing over the limit.');
    var o = $('dlOverrides'); o.textContent = '';
    (L.overrides || []).forEach(function (r) { cellRow(o, [r.username || r.user_id, r.limit_usd ? '$' + fmt(r.limit_usd) : 'no limit', r.actor || '', r.note || ''], 1); });
    if (!(L.overrides || []).length) emptyRow(o, 4, 'No overrides.');
  }
  function openEdit(p) {
    editing = p;
    var f = $('dpEdit'); f.style.display = '';
    $('dpEditWhat').textContent = 'Editing ' + (p.label || p.id) + (p.locked ? ' - it has started, so the rate, the cap and the start are locked.' : ' - it hasn’t started: to change its rate or cap, cancel it and create a new one.');
    $('dpELabel').value = p.label || '';
    $('dpEEnds').value = toLocalInput(p.ends);
    $('dpEBudget').value = p.budget_pat != null ? p.budget_pat : '';
    $('dpEBudgetUnit').value = 'pat';
    $('dpEEnabled').checked = !!p.enabled;
    budgetUi('dpE');
    f.scrollIntoView({ block: 'nearest' });
  }
  function load() {
    return api('/api/admin/donpromo').then(function (j) {
      var first = !view; view = j;
      if (first) {
        fillBonus($('dpBonus'), j.settings.bonus_base); fillBonus($('dpSBonus'), j.settings.bonus_base);
        $('dpCeil').value = j.settings.ceiling_x; $('dpSTz').value = j.settings.tz; $('dpDaily').value = j.settings.daily_limit_usd || 0;
        $('dgMode').value = j.settings.global_mode || 'off'; $('dgPat').value = j.settings.global_pat || 0; $('dgPct').value = j.settings.global_pct || 0; $('dgUsd').value = j.settings.global_usd || 0;
        $('dpStarts').value = toLocalInput(j.now); $('dpEnds').value = toLocalInput(j.today_ends);
      }
      render(); preview(); budgetUi('dp');
    }).catch(function (e) { msg(e.message, true); });
  }
  ['dpMode', 'dpToday'].forEach(function (id) { $(id).addEventListener('change', modeUi); });
  ['dpRate', 'dpMult', 'dpCap'].forEach(function (id) { $(id).addEventListener('input', preview); });
  ['dp', 'dpE'].forEach(function (pre) {
    $(pre + 'Budget').addEventListener('input', function () { budgetUi(pre); });
    $(pre + 'BudgetUnit').addEventListener('change', function () { unitSwitch(pre); });
  });
  $('dpForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var bu = budgetUi('dp');
    if (typeof bu.pat === 'number' && !isFinite(bu.pat)) { msg(_t('js.adm.dp.budget_norate', 'Set the promo rate to see what this budget is worth.'), true); return; }
    var b = { label: $('dpLabel').value, mode: $('dpMode').value, cap_usd: $('dpCap').value, budget: bu.pat, bonus_base: $('dpBonus').value,
              enabled: $('dpEnabled').checked };
    if (b.mode === 'rate') b.rate = $('dpRate').value; else b.mult = $('dpMult').value;
    if ($('dpToday').checked) b.today = true; else { b.starts = fromLocalInput($('dpStarts').value); b.ends = fromLocalInput($('dpEnds').value); }
    msg('Saving…');
    sendBudgeted('/api/admin/donpromo/create', b, bu.warn).then(function (j) { msg('Created ' + j.promo.id + '.'); $('dpForm').reset(); view = null; load().then(modeUi); },
      function (e) { if (e) msg(e.message, true); });
  });
  $('dpEdit').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!editing) return;
    var bu = budgetUi('dpE');
    if (typeof bu.pat === 'number' && !isFinite(bu.pat)) { msg(_t('js.adm.dp.budget_norate', 'Set the promo rate to see what this budget is worth.'), true); return; }
    var b = { label: $('dpELabel').value, ends: fromLocalInput($('dpEEnds').value), budget: bu.pat, enabled: $('dpEEnabled').checked };
    sendBudgeted('/api/admin/donpromo/' + encodeURIComponent(editing.id) + '/edit', b, bu.warn).then(function () { msg('Saved.'); $('dpEdit').style.display = 'none'; editing = null; load(); },
      function (e) { if (e) msg(e.message, true); });
  });
  $('dpECancel').addEventListener('click', function () { $('dpEdit').style.display = 'none'; editing = null; });
  $('dpSet').addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('/api/admin/donpromo/settings', { ceiling_x: $('dpCeil').value, bonus_base: $('dpSBonus').value, tz: $('dpSTz').value, daily_limit_usd: $('dpDaily').value === '' ? 0 : $('dpDaily').value,
      global_mode: $('dgMode').value, global_pat: $('dgPat').value || 0, global_pct: $('dgPct').value || 0, global_usd: $('dgUsd').value || 0 })
      .then(function (j) { msg(Object.keys(j.changed).length ? 'Settings saved.' : 'Nothing changed.'); load(); }, function (e) { msg(e.message, true); });
  });
  modeUi();
  load();
  setInterval(function () { if (view && document.visibilityState === 'visible') render(); }, 30000);
})();
