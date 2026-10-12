// admin-policy.js (Phase 4) - /admin/economy's ⏱️ Policy scheduler card (policy/scheduler.js on the server).
// Read: GET /api/admin/policy. Switch: POST /api/admin/policy/mode {engine, mode: off|dry|shadow, note} (audit-logged on the
// server; "live" is only Pepe's cutover handshake, so it isn't offered here).
(function () {
  'use strict';
  var box = document.getElementById('policyAdm');
  if (!box) return;
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
  var MODE = { off: _t('js.adm.policy.mode_off', 'off (Pepe runs it)'), dry: _t('js.adm.policy.mode_dry', 'dry run (records what would move)'),
               shadow: _t('js.adm.policy.mode_shadow', 'shadow (compared with Pepe every period)'), live: _t('js.adm.policy.mode_live', 'LIVE on the site') };
  function diffText(d) {
    if (!d) return '—';
    if (d.ok === true) return _t('js.adm.policy.diff_ok', '{period}: no differences', { period: d.period });
    if (d.ok === false) return _t('js.adm.policy.diff_bad', '{period}: {n} difference(s) - {first}', { period: d.period, n: (d.engine_diff || []).length + (d.total_diff || []).length, first: ((d.engine_diff || [])[0] || (d.total_diff || [])[0] || '') });
    return _t('js.adm.policy.diff_dry', '{period}: planned (no report from Pepe yet)', { period: d.period });
  }
  function nextText(n) {
    if (!n) return '—';
    if (typeof n === 'object') return _t('js.adm.policy.next_tr', 'daily {daily} · epoch {epoch}', { daily: when(n.daily), epoch: when(n.epoch) });
    return when(n);
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
      row(rows, [e.engine, MODE[e.mode] || e.mode, last, nextText(e.next_run), diffText(e.last_diff)]);
    });
    var ul = $('policyRetired'); ul.textContent = '';
    Object.keys(v.retired || {}).concat(Object.keys(v.stays || {})).forEach(function (key) {
      var li = document.createElement('li'); li.textContent = key + ': ' + ((v.retired || {})[key] || (v.stays || {})[key]); ul.appendChild(li);
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
  load();
  setInterval(load, 30000);
})();
