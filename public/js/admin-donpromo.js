// admin-donpromo.js (1.99tq) - the admin Economy page's 💖 Donations: promos card (donationpromo.js on the server).
// Create / edit / end a time-limited donation promo, see it live (time left, donors, $ and PAT at the promo rate vs the
// budget), past promos, the settings (ceiling, default bonus base, time zone) and the audit log. The server validates.
(function () {
  'use strict';
  var box = document.getElementById('dpAdm');
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return n == null ? '—' : Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var usd = function (c) { return '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };
  var view = null, editing = null;
  function msg(t, bad) { var m = $('dpMsg'); m.textContent = t || ''; m.className = 'adm-msg' + (t ? (bad ? ' err' : ' ok') : ''); }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  function kv(label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); return d; }
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
  }
  function render() {
    var k = $('dpKv'); k.textContent = '';
    var live = (view.promos || []).filter(function (p) { return p.status === 'live'; })[0];
    k.appendChild(kv('Normal rate (Pepe)', fmt(view.normal.rate) + ' PAT per $1 · +' + view.normal.bonus_pct + '% to incentives'));
    if (live) {
      k.appendChild(kv('Live promo', (live.label || live.id) + ' · ' + rateText(live) + ' PAT per $1 · first $' + fmt(live.cap_usd) + ' per donor'));
      k.appendChild(kv('Time left', left(live.ends - Date.now()) + ' (ends ' + when(live.ends) + ')'));
      k.appendChild(kv('So far', fmt(live.stats.donors) + ' donors · ' + usd(live.stats.promo_cents) + ' at the promo rate of ' + usd(live.stats.usd_cents) + ' · ' +
        fmt(live.stats.promo_pat) + ' PAT at the promo rate' + (live.budget_pat != null ? ' of a ' + fmt(live.budget_pat) + ' budget' : '') + ' (' + fmt(live.stats.extra_pat) + ' above the normal rate)'));
    } else k.appendChild(kv('Live promo', 'none'));
    $('dpTz').textContent = view.settings.tz;
    var rows = $('dpRows'); rows.textContent = '';
    (view.promos || []).forEach(function (p) {
      var tr = document.createElement('tr');
      var cells = [(p.label ? p.label + ' ' : '') + '(' + p.id + ')', p.status + (p.status === 'live' ? ' · ' + left(p.ends - Date.now()) + ' left' : ''),
        when(p.starts) + ' → ' + when(p.ends), rateText(p), '$' + fmt(p.cap_usd), fmt(p.stats.donors), usd(p.stats.promo_cents),
        fmt(p.stats.promo_pat) + (p.budget_pat != null ? ' / ' + fmt(p.budget_pat) : '')];
      cells.forEach(function (t, i) { var td = document.createElement('td'); td.textContent = t; if (i >= 3) td.className = 'num'; tr.appendChild(td); });
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
    if (!(view.log || []).length) { var tr2 = document.createElement('tr'), c2 = document.createElement('td'); c2.colSpan = 3; c2.className = 'empty'; c2.textContent = 'No changes yet.'; tr2.appendChild(c2); lg.appendChild(tr2); }
  }
  function openEdit(p) {
    editing = p;
    var f = $('dpEdit'); f.style.display = '';
    $('dpEditWhat').textContent = 'Editing ' + (p.label || p.id) + (p.locked ? ' - it has started, so the rate, the cap and the start are locked.' : ' - it hasn’t started: to change its rate or cap, cancel it and create a new one.');
    $('dpELabel').value = p.label || '';
    $('dpEEnds').value = toLocalInput(p.ends);
    $('dpEBudget').value = p.budget_pat != null ? p.budget_pat : '';
    $('dpEEnabled').checked = !!p.enabled;
    f.scrollIntoView({ block: 'nearest' });
  }
  function load() {
    return api('/api/admin/donpromo').then(function (j) {
      var first = !view; view = j;
      if (first) {
        fillBonus($('dpBonus'), j.settings.bonus_base); fillBonus($('dpSBonus'), j.settings.bonus_base);
        $('dpCeil').value = j.settings.ceiling_x; $('dpSTz').value = j.settings.tz;
        $('dpStarts').value = toLocalInput(j.now); $('dpEnds').value = toLocalInput(j.today_ends);
      }
      render(); preview();
    }).catch(function (e) { msg(e.message, true); });
  }
  ['dpMode', 'dpToday'].forEach(function (id) { $(id).addEventListener('change', modeUi); });
  ['dpRate', 'dpMult', 'dpCap'].forEach(function (id) { $(id).addEventListener('input', preview); });
  $('dpForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var b = { label: $('dpLabel').value, mode: $('dpMode').value, cap_usd: $('dpCap').value, budget: $('dpBudget').value, bonus_base: $('dpBonus').value,
              enabled: $('dpEnabled').checked };
    if (b.mode === 'rate') b.rate = $('dpRate').value; else b.mult = $('dpMult').value;
    if ($('dpToday').checked) b.today = true; else { b.starts = fromLocalInput($('dpStarts').value); b.ends = fromLocalInput($('dpEnds').value); }
    msg('Saving…');
    api('/api/admin/donpromo/create', b).then(function (j) { msg('Created ' + j.promo.id + '.'); $('dpForm').reset(); view = null; load().then(modeUi); },
      function (e) { msg(e.message, true); });
  });
  $('dpEdit').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!editing) return;
    var b = { label: $('dpELabel').value, ends: fromLocalInput($('dpEEnds').value), budget: $('dpEBudget').value, enabled: $('dpEEnabled').checked };
    api('/api/admin/donpromo/' + encodeURIComponent(editing.id) + '/edit', b).then(function () { msg('Saved.'); $('dpEdit').style.display = 'none'; editing = null; load(); },
      function (e) { msg(e.message, true); });
  });
  $('dpECancel').addEventListener('click', function () { $('dpEdit').style.display = 'none'; editing = null; });
  $('dpSet').addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('/api/admin/donpromo/settings', { ceiling_x: $('dpCeil').value, bonus_base: $('dpSBonus').value, tz: $('dpSTz').value })
      .then(function (j) { msg(Object.keys(j.changed).length ? 'Settings saved.' : 'Nothing changed.'); load(); }, function (e) { msg(e.message, true); });
  });
  modeUi();
  load();
  setInterval(function () { if (view && document.visibilityState === 'visible') render(); }, 30000);
})();
