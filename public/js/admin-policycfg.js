// admin-policycfg.js (PO-2) - /admin/economy's ⚙️ Policy settings card (policy/config.js on the server).
// Read: GET /api/admin/policy/cfg (every key: value, unit, bounds, applies, engine input, last change; owner, rev, the mirror's
// diff report, the dual read, the mirror days, the run window). Until the H1 hand-over the card is READ-ONLY (Pepe owns the
// config; the site mirrors it). Once the site owns it, a Pepe owner stages changes in the table, reviews them, adds a note and
// confirms with the password: POST /api/admin/policy/cfg {changes, base_rev, note, nonce, password} (a fraction key's field is a
// percent). A stale rev answers 409 with the saved values; the run window answers 423. Change log: GET /api/admin/policy/cfg/log.
// Pause / resume a feature: POST /api/admin/policy/pause {feature, pause, note, nonce, password}.
(function () {
  'use strict';
  var box = document.getElementById('pcfgAdm');
  if (!box) return;
  var csrf = box.getAttribute('data-csrf') || '';
  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var $ = function (id) { return document.getElementById(id); };
  var view = null, staged = {};
  var when = function (ms) { return ms ? new Date(Number(ms) < 1e12 ? Number(ms) * 1000 : Number(ms)).toISOString().slice(0, 16).replace('T', ' ') : '—'; };
  function msg(t, bad) { var m = $('pcfgMsg'); m.textContent = t || ''; m.style.color = bad ? '#ef5350' : ''; }
  function kv(el, label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); el.appendChild(d); }
  function cell(tr, t) { var td = document.createElement('td'); td.textContent = t == null ? '' : String(t); tr.appendChild(td); return td; }
  function row(tbody, cells) { var tr = document.createElement('tr'); cells.forEach(function (c) { cell(tr, c); }); tbody.appendChild(tr); return tr; }
  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
                         headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch', 'x-csrf-token': csrf }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) { var e = new Error(j.error || 'failed'); e.body = j; e.status = r.status; throw e; } return j; }); });
  }
  var OWNER = { pepe: _t('js.adm.pcfg.owner_pepe', "Pepe's (the site mirrors his pushes - read-only here until the hand-over)"),
                cutting: _t('js.adm.pcfg.owner_cutting', 'frozen for the hand-over (nothing can change)'),
                site: _t('js.adm.pcfg.owner_site', "the site's (edited here; Pepe reads it)") };
  var UNIT = { pct: '%', fraction: '%', pat: 'PAT', days: _t('js.adm.pcfg.u_days', 'days'), count: '', bool: _t('js.adm.pcfg.u_bool', 'on / off'), enum: '',
               mult: 'x', minutes: _t('js.adm.pcfg.u_min', 'minutes'), text: '', list: '', routes: '' };
  function bounds(k) {
    if (k.kind === 'enum') return (k.choices || []).join(' | ');
    if (k.kind === 'bool' || k.min == null || k.max == null) return '';
    var f = function (x) { return k.unit === 'fraction' ? (Math.round(x * 1e6) / 1e4) + '%' : Number(x).toLocaleString('en-US'); };
    return f(k.min) + ' – ' + f(k.max) + (k.kind === 'cap' ? ' ' + _t('js.adm.pcfg.or_unlimited', 'or unlimited') : '');
  }
  function editor(k) {
    var el;
    if (k.kind === 'bool') {
      el = document.createElement('select');
      [['', '—'], ['on', 'on'], ['off', 'off']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; el.appendChild(op); });
    } else if (k.kind === 'enum') {
      el = document.createElement('select');
      [''].concat(k.choices || []).forEach(function (c) { var op = document.createElement('option'); op.value = c; op.textContent = c || '—'; el.appendChild(op); });
    } else {
      el = document.createElement('input');
      el.type = k.kind === 'int' || k.kind === 'cap' ? 'text' : 'number';
      if (el.type === 'number') el.step = 'any';
      el.placeholder = k.unit === 'fraction' ? _t('js.adm.pcfg.ph_pct', 'new value, %') : _t('js.adm.pcfg.ph_new', 'new value');
    }
    el.setAttribute('aria-label', _t('js.adm.pcfg.new_for', 'New value for {key}', { key: k.key }));
    el.addEventListener('change', function () {
      var v = el.value.trim();
      if (v === '') delete staged[k.key];
      else staged[k.key] = el.type === 'number' ? Number(v) : v;
      el.classList.toggle('pcfg-staged', v !== '');
      renderEdit();
    });
    return el;
  }
  function render(v) {
    view = v;
    var k = $('pcfgKv'); k.textContent = '';
    var own = v.own && v.own.cfg ? v.own.cfg : { owner: v.owner };
    kv(k, _t('js.adm.pcfg.owner', 'Who owns the settings'), OWNER[v.owner] || v.owner);
    kv(k, _t('js.adm.pcfg.rev', 'Revision'), String(v.rev) + (v.sha ? ' · ' + v.sha.slice(0, 12) : ''));
    kv(k, _t('js.adm.pcfg.pepe_rev', 'Rev Pepe has applied'), v.pepe_rev ? String(v.pepe_rev.rev) + ' · ' + when(v.pepe_rev.at) : '—');
    if (own.paused) kv(k, _t('js.adm.pcfg.paused', 'Paused'), _t('js.adm.pcfg.paused_by', 'by {by} at {when}', { by: own.paused_by || '?', when: when(own.paused_at) }) + (own.note ? ' (' + own.note + ')' : ''));
    var d = v.diff || { counts: {} };
    kv(k, _t('js.adm.pcfg.mirror_diff', 'Mirror diff'), d.empty ? _t('js.adm.pcfg.diff_empty', 'empty') : Object.keys(d.counts).filter(function (x) { return d.counts[x]; }).map(function (x) { return x + ' ' + d.counts[x]; }).join(' · '));
    var w = v.window || {};
    kv(k, _t('js.adm.pcfg.window', 'Run window (UTC)'), w.open ? _t('js.adm.pcfg.window_open', 'open - engine settings frozen until {w} settle', { w: (w.waiting || []).join(', ') }) : _t('js.adm.pcfg.window_closed', 'closed'));
    $('pcfgMode').textContent = v.can_edit ? _t('js.adm.pcfg.can_edit', 'Type a new value in a row, then review, add a note and confirm with your password. A fraction is entered as a percent.')
                                           : v.owner === 'site' ? _t('js.adm.pcfg.owner_only', 'Changing a setting is a Pepe owner\'s. Admins can look.')
                                                                : _t('js.adm.pcfg.read_only', 'Read-only: Pepe still owns these settings; the site mirrors them and compares every reader (below).');
    var secs = $('pcfgSections'); secs.textContent = '';
    (v.sections || []).forEach(function (s) {
      var keys = (v.keys || []).filter(function (x) { return x.section === s[0]; });
      if (!keys.length) return;
      var h = document.createElement('h3'); h.textContent = s[1]; secs.appendChild(h);
      var wrap = document.createElement('div'); wrap.className = 'adm-tbl';
      var tbl = document.createElement('table'); tbl.setAttribute('aria-label', s[1]);
      var th = document.createElement('thead'), trh = document.createElement('tr');
      [_t('js.adm.pcfg.col_key', 'Setting'), _t('js.adm.pcfg.col_value', 'Value'), _t('js.adm.pcfg.col_bounds', 'Unit, bounds'), _t('js.adm.pcfg.col_applies', 'Applies'),
       _t('js.adm.pcfg.col_last', 'Last change')].concat(v.can_edit ? [_t('js.adm.pcfg.col_new', 'New value')] : []).forEach(function (t) { var c = document.createElement('th'); c.textContent = t; trh.appendChild(c); });
      th.appendChild(trh); tbl.appendChild(th);
      var tb = document.createElement('tbody');
      keys.forEach(function (x) {
        var tr = document.createElement('tr');
        if (x.readonly) tr.className = 'pcfg-ro';
        var c0 = cell(tr, x.key); c0.title = x.label + (x.aliases && x.aliases.length ? ' (' + x.aliases.join(', ') + ')' : '');
        cell(tr, x.present ? x.shown + (x.suffix && x.unit !== 'fraction' && x.unit !== 'pct' ? ' ' + x.suffix : '') : _t('js.adm.pcfg.missing', 'MISSING'));
        cell(tr, [UNIT[x.unit] || '', bounds(x)].filter(Boolean).join(' · '));
        cell(tr, (x.applies === 'now' ? _t('js.adm.pcfg.now', 'now') : _t('js.adm.pcfg.next', 'next period')) + (x.engine_input ? ' · ' + _t('js.adm.pcfg.engine', 'engine input') : '') +
                 (x.readonly ? ' · ' + _t('js.adm.pcfg.readonly', 'read-only') : ''));
        cell(tr, x.last ? _t('js.adm.pcfg.last', '{by} via {via} at {when} (rev {rev})', { by: x.last.by || '?', via: x.last.via || '?', when: when(x.last.ts), rev: x.last.rev }) : '—');
        if (v.can_edit) { var td = document.createElement('td'); if (!x.readonly && x.kind !== 'routes') td.appendChild(editor(x)); tr.appendChild(td); }
        tb.appendChild(tr);
      });
      tbl.appendChild(tb); wrap.appendChild(tbl); secs.appendChild(wrap);
    });
    // the diff report
    var dk = $('pcfgDiffKv'); dk.textContent = '';
    Object.keys(d.sources || {}).forEach(function (s) { var x = d.sources[s]; kv(dk, s, x.seen ? _t('js.adm.pcfg.src_age', '{n} s ago', { n: x.age_s }) + (x.stale ? ' · ' + _t('js.adm.pcfg.stale', 'stale') : '') : _t('js.adm.pcfg.never', 'never')); });
    var dl = $('pcfgDiff'); dl.textContent = '';
    var li = function (t) { var e = document.createElement('li'); e.textContent = t; dl.appendChild(e); };
    (d.missing || []).forEach(function (x) { li(_t('js.adm.pcfg.d_missing', 'never pushed: {k}', { k: x })); });
    (d.unknown || []).forEach(function (x) { li(_t('js.adm.pcfg.d_unknown', "Pepe has it, the site doesn't: {k}", { k: x })); });
    (d.invalid || []).forEach(function (x) { li(_t('js.adm.pcfg.d_invalid', 'the site would refuse: {e}', { e: x.error })); });
    (d.whole || []).forEach(function (x) { li(_t('js.adm.pcfg.d_whole', 'the whole config: {e}', { e: x })); });
    (d.disagree || []).forEach(function (x) { li(_t('js.adm.pcfg.d_disagree', '{k}: {a} says {va}, {b} says {vb}', { k: x.key, a: x.a.path, va: JSON.stringify(x.a.value), b: x.b.path, vb: JSON.stringify(x.b.value) })); });
    if (!dl.children.length) li(_t('js.adm.pcfg.d_none', 'No differences.'));
    // the dual read
    var du = $('pcfgDual'); du.textContent = '';
    ((v.dual || {}).checks || []).forEach(function (c) { row(du, [c.day, c.consumer, c.checks, c.diffs]); });
    var dr = $('pcfgDualRows'); dr.textContent = '';
    ((v.dual || {}).diffs || []).forEach(function (c) { row(dr, [c.day, c.consumer, c.key, c.push, c.site, c.n]); });
    var mi = $('pcfgMirror'); mi.textContent = '';
    Object.keys(v.mirror_days || {}).sort().reverse().forEach(function (day) { var x = v.mirror_days[day]; row(mi, [day, x.pushes, x.changes, x.max ? JSON.stringify(x.max) : '—']); });
    renderLog(v.log || []);
    renderEdit();
  }
  function renderLog(rows) {
    var lg = $('pcfgLog'); lg.textContent = '';
    rows.forEach(function (x) { row(lg, [when(x.ts), x.key, (x.old == null ? '—' : x.old) + ' → ' + x.new, (x.actor || '?') + ' (' + (x.via || '?') + ')', x.note || '']); });
  }
  function renderEdit() {
    var keys = Object.keys(staged);
    $('pcfgEdit').hidden = !keys.length;
    var tb = $('pcfgEditRows'); tb.textContent = '';
    keys.forEach(function (key) {
      var k = (view.keys || []).filter(function (x) { return x.key === key; })[0] || {};
      row(tb, [key, k.shown, String(staged[key]) + (k.unit === 'fraction' ? '%' : ''), k.applies === 'now' ? _t('js.adm.pcfg.now', 'now') : _t('js.adm.pcfg.next', 'next period')]);
    });
  }
  function load() {
    return fetch('/api/admin/policy/cfg', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || 'failed'); render(j); })
      .catch(function (e) { msg(e.message, true); });
  }
  $('pcfgDiscard').addEventListener('click', function () { staged = {}; msg(_t('js.adm.pcfg.discarded', 'Discarded - nothing changed.')); render(view); });
  $('pcfgEditForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var note = $('pcfgNote').value.trim();
    if (note.length < 3) { msg(_t('js.adm.pcfg.need_note', 'Say why in the note first.'), true); return; }
    var pw = $('pcfgPw').value;
    $('pcfgPw').value = '';
    msg(_t('js.adm.pcfg.saving', 'Saving…'));
    post('/api/admin/econ/edit/nonce', {}).then(function (j) {
      return post('/api/admin/policy/cfg', { changes: staged, base_rev: view.rev, note: note, nonce: j.nonce, password: pw });
    }).then(function (j) {
      msg(j.unchanged ? _t('js.adm.pcfg.unchanged', 'Nothing changed (already set).') : _t('js.adm.pcfg.saved', 'Saved as rev {rev}: {msg}', { rev: j.rev, msg: j.msg }));
      staged = {}; $('pcfgNote').value = '';
      return load();
    }).catch(function (e) {
      if (e.status === 409 && e.body && e.body.code === 'stale_rev') { msg(_t('js.adm.pcfg.stale_rev', 'Someone changed the settings meanwhile (now rev {rev}) - look again; nothing changed.', { rev: e.body.rev }), true); load(); return; }
      msg(e.message, true);
    });
  });
  $('pcfgLogForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = [['key', $('pcfgLogKey').value.trim()], ['actor', $('pcfgLogActor').value.trim()], ['via', $('pcfgLogVia').value]].filter(function (x) { return x[1]; })
      .map(function (x) { return x[0] + '=' + encodeURIComponent(x[1]); }).join('&');
    fetch('/api/admin/policy/cfg/log' + (q ? '?' + q : ''), { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'failed'); renderLog(j.rows || []); }).catch(function (e) { msg(e.message, true); });
  });
  function pause(on) {
    var note = $('pcfgPauseNote').value.trim();
    if (on && note.length < 3) { msg(_t('js.adm.pcfg.need_note', 'Say why in the note first.'), true); return; }
    var pw = $('pcfgPausePw').value;
    $('pcfgPausePw').value = '';
    var feature = $('pcfgPauseFeature').value;
    post('/api/admin/econ/edit/nonce', {}).then(function (j) {
      return post('/api/admin/policy/pause', { feature: feature, pause: on, note: note, nonce: j.nonce, password: pw });
    }).then(function (j) {
      msg((j.features || []).map(function (x) { return x.feature + ': ' + (x.unchanged ? _t('js.adm.policy.state_same', 'unchanged') : x.paused ? _t('js.adm.policy.state_paused', 'paused') : _t('js.adm.policy.state_resumed', 'resumed')); }).join(' · '));
      $('pcfgPauseNote').value = '';
      return load();
    }).catch(function (e) { msg(e.message, true); });
  }
  $('pcfgPauseBtn').addEventListener('click', function () { pause(true); });
  $('pcfgResumeBtn').addEventListener('click', function () { pause(false); });
  load();
  setInterval(function () { if (!Object.keys(staged).length) load(); }, 60000);
})();
