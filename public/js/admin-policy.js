// admin-policy.js (Phase 4) - /admin/economy's ⏱️ Policy scheduler card (policy/scheduler.js on the server).
// Read: GET /api/admin/policy. Switch: POST /api/admin/policy/mode {engine, mode: off|dry|shadow, note} (audit-logged on the
// server; "live" is only Pepe's cutover handshake, so it isn't offered here).
// PO-1: Pause / Resume (a Pepe owner): POST /api/admin/policy/pause {engine|all, pause, note, nonce, password} - the
// /admin/economy step-up (a single-use nonce from /api/admin/econ/edit/nonce + the account's password). The missed periods
// (D-18) and the shadow comparison's whitelist are listed; a shadow row says whether it compared against Pepe's boundary.
(function () {
  'use strict';
  var box = document.getElementById('policyAdm');
  if (!box) return;
  var csrf = box.getAttribute('data-csrf') || '';
  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var $ = function (id) { return document.getElementById(id); };
  var when = function (s) {
    if (!s) return '—';
    var ms = Number(s) < 1e12 ? Number(s) * 1000 : Number(s);
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  };
  function msg(t, bad) { var m = $('policyMsg'); m.textContent = t || ''; m.style.color = bad ? '#ef5350' : ''; }
  function kv(label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); return d; }
  function row(tbody, cells) {
    var tr = document.createElement('tr');
    cells.forEach(function (t) { var td = document.createElement('td'); td.textContent = t == null ? '' : String(t); tr.appendChild(td); });
    tbody.appendChild(tr);
  }
  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
                         headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch', 'x-csrf-token': csrf }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || 'failed'); return j; }); });
  }
  var MODE = { off: _t('js.adm.policy.mode_off', 'off (Pepe runs it)'), dry: _t('js.adm.policy.mode_dry', 'dry run (records what would move)'),
               shadow: _t('js.adm.policy.mode_shadow', 'shadow (compared with Pepe every period)'), live: _t('js.adm.policy.mode_live', 'LIVE on the site') };
  function diffText(d) {
    if (!d) return '—';
    // PO-1 review: whitelisted / blocking are {plan, inputs, decision} (D-15 counts the inputs and the site's own decisions too)
    var white = d.whitelisted || {}, bl = d.blocking || null;
    var nWhite = (white.plan || []).length + (white.inputs || []).length + (white.decision || []).length;
    var blocking = bl ? (bl.plan || []).concat((bl.inputs || []).map(function (x) { return _t('js.adm.policy.part_inputs', 'inputs') + ' · ' + x; }),
                                               (bl.decision || []).map(function (x) { return _t('js.adm.policy.part_decision', 'decision') + ' · ' + x; }))
                      : (d.total_diff || []).filter(function (x) { return (white.plan || []).indexOf(x) < 0; });
    var t;
    if (d.ok === true) {
      t = nWhite ? _t('js.adm.policy.diff_white', '{period}: clean ({n} whitelisted)', { period: d.period, n: nWhite })
                 : _t('js.adm.policy.diff_ok', '{period}: no differences', { period: d.period });
    } else if (d.ok === false) {
      var n = (d.engine_diff || []).length + blocking.length;
      if (!n && !d.boundary) t = _t('js.adm.policy.diff_noboundary', '{period}: not clean - no boundary snapshot from Pepe', { period: d.period });
      else t = _t('js.adm.policy.diff_bad', '{period}: {n} difference(s) - {first}', { period: d.period, n: n, first: ((d.engine_diff || [])[0] || blocking[0] || '') });
    } else {
      t = _t('js.adm.policy.diff_dry', '{period}: planned (no report from Pepe yet)', { period: d.period });
    }
    return d.truncated ? _t('js.adm.policy.truncated', '{text} (more than 400: the list is cut)', { text: t }) : t;
  }
  function nextText(n) {
    if (!n) return '—';
    if (typeof n === 'object') return _t('js.adm.policy.next_tr', 'daily {daily} · epoch {epoch}', { daily: when(n.daily), epoch: when(n.epoch) });
    return when(n);
  }
  function modeText(e) {
    var t = MODE[e.mode] || e.mode;
    if (e.paused) t += ' · ⏸ ' + _t('js.adm.policy.paused_row', 'PAUSED by {by} at {when}', { by: e.paused_by || '?', when: when(e.paused_at) }) + (e.pause_note ? ' (' + e.pause_note + ')' : '');
    return t;
  }
  function render(v) {
    var k = $('policyKv'); k.textContent = '';
    k.appendChild(kv(_t('js.adm.policy.lease', 'Scheduler lease'), v.lease ? (v.lease.holder + ' · ' + when(v.lease.expires)) : '—'));
    k.appendChild(kv(_t('js.adm.policy.cfg_age', "Pepe's last config push"), v.cfg_age_s == null || v.cfg_age_s > 1e9 ? _t('js.adm.policy.never', 'never') : _t('js.adm.policy.secs_ago', '{n} s ago', { n: v.cfg_age_s })));
    k.appendChild(kv(_t('js.adm.policy.flags', 'Economy flags (from Pepe)'), v.flags ? ('layers ' + (v.flags.layers ? 'on' : 'off') + ' · treasury ' + (v.flags.tr_live ? 'live' : 'off')) : '—'));
    k.appendChild(kv(_t('js.adm.policy.effects', "Updates waiting for Pepe's books"), String(v.effects_open || 0)));
    if (v.test_clock) k.appendChild(kv(_t('js.adm.policy.test_clock', 'Test clock (staging)'), String(v.test_clock.offset_ms) + ' ms'));
    var rows = $('policyRows'); rows.textContent = '';
    (v.engines || []).forEach(function (e) {
      var last = e.last_run ? (e.last_run.period + ' · ' + e.last_run.state + ' · ' + when(e.last_run.done || e.last_run.created) + (e.last_run.error ? ' · ' + e.last_run.error : '')) : '—';
      row(rows, [e.engine, modeText(e), last, nextText(e.next_run), diffText(e.last_diff)]);
    });
    var ul = $('policyRetired'); ul.textContent = '';
    Object.keys(v.retired || {}).concat(Object.keys(v.stays || {})).forEach(function (key) {
      var li = document.createElement('li'); li.textContent = key + ': ' + ((v.retired || {})[key] || (v.stays || {})[key]); ul.appendChild(li);
    });
    var mi = $('policyMissed'); mi.textContent = '';
    (v.missed || []).forEach(function (x) { row(mi, [when(x.created), x.engine, x.period, x.error || '']); });
    var wl = $('policyWhite'); wl.textContent = '';
    (v.whitelist || []).forEach(function (w) {
      var part = w.on === 'inputs' ? _t('js.adm.policy.part_inputs', 'inputs') + ' · ' : w.on === 'decision' ? _t('js.adm.policy.part_decision', 'decision') + ' · ' : '';
      row(wl, [w.engine + ' ' + w.kind + (w.monday ? ' (Monday)' : '') + (w.mode ? ' · ' + w.mode : ''), part + w.field, w.why, w.test]);
    });
    var r = $('policyRuns'); r.textContent = '';
    (v.runs || []).forEach(function (x) { row(r, [when(x.done || x.created), x.engine, x.period, x.state + (x.error ? ' (' + x.error + ')' : ''), x.via]); });
    var a = $('policyAudit'); a.textContent = '';
    (v.audit || []).forEach(function (x) { row(a, [when(x.ts), x.engine, (x.old || '') + ' → ' + (x.new || ''), (x.by || '') + ' (' + (x.via || '') + ')', x.note || '']); });
  }
  function load() {
    return fetch('/api/admin/policy', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw new Error(j.error || 'failed'); render(j); })
      .catch(function (e) { msg(e.message, true); });
  }
  $('policyForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = { engine: $('policyEngine').value, mode: $('policyMode').value, note: $('policyNote').value.trim() };
    msg(_t('js.adm.policy.saving', 'Saving…'));
    fetch('/api/admin/policy/mode', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'failed'); msg(_t('js.adm.policy.saved', '{engine}: {from} → {to}', { engine: j.engine, from: j.was, to: j.mode })); $('policyNote').value = ''; return load(); })
      .catch(function (e) { msg(e.message, true); });
  });
  // ── PO-1: pause / resume with the password step-up ──
  var pending = null, nonce = null;
  function cancel() { pending = null; nonce = null; $('policyConfirm').hidden = true; $('policyPw').value = ''; }
  function ask(pause) {
    cancel();
    var engine = $('policyPauseEngine').value;
    var note = $('policyPauseNote').value.trim();
    if (pause && note.length < 3) { msg(_t('js.adm.policy.need_note', 'Say why in the note first.'), true); return; }
    var name = engine === 'all' ? _t('js.adm.policy.all', 'all engines') : engine;
    pending = { engine: engine, pause: pause, note: note };
    $('policyWhat').textContent = pause ? _t('js.adm.policy.pause_what', "Pause {engine}: nothing runs for it on the site until it is resumed. A live engine's due periods are recorded as missed.", { engine: name })
                                        : _t('js.adm.policy.resume_what', 'Resume {engine}: only the current period may still run (late); older ones stay missed.', { engine: name });
    $('policyConfirm').hidden = false;
    msg('');
    post('/api/admin/econ/edit/nonce', {}).then(function (j) { nonce = j.nonce; $('policyPw').focus(); }).catch(function (e) { msg(e.message, true); cancel(); });
  }
  $('policyPauseBtn').addEventListener('click', function () { ask(true); });
  $('policyResumeBtn').addEventListener('click', function () { ask(false); });
  $('policyNo').addEventListener('click', function () { cancel(); msg(_t('js.adm.policy.cancelled', 'Cancelled - nothing changed.')); });
  $('policyYes').addEventListener('click', function () {
    if (!pending || !nonce) { msg(_t('js.adm.policy.start_again', 'Start again.'), true); return; }
    var body = { engine: pending.engine, pause: pending.pause, note: pending.note, nonce: nonce, password: $('policyPw').value };
    cancel();
    msg(_t('js.adm.policy.saving', 'Saving…'));
    post('/api/admin/policy/pause', body).then(function (j) {
      msg((j.engines || []).map(function (x) {
        var st = x.unchanged ? _t('js.adm.policy.state_same', 'unchanged') : x.paused ? _t('js.adm.policy.state_paused', 'paused') : _t('js.adm.policy.state_resumed', 'resumed');
        return _t('js.adm.policy.pause_done', '{engine}: {state}', { engine: x.engine, state: st });
      }).join(' · '));
      $('policyPauseNote').value = '';
      return load();
    }).catch(function (e) { msg(e.message, true); });
  });
  load();
  setInterval(load, 30000);
})();
