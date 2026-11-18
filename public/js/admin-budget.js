// admin-budget.js (1.99aop) - /admin/economy's incentive week card (views/partials/econ-budget.ejs). Read-only: GET /api/admin/policy/budget.
(function () {
  'use strict';
  var box = document.getElementById('budgetAdm');
  if (!box) return;
  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var when = function (s) {
    if (!s) return '—';
    var ms = Number(s) < 1e12 ? Number(s) * 1000 : Number(s);
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  };
  function kv(host, label, value) {
    var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span');
    b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); host.appendChild(d);
  }
  function row(tbody, cells) {
    var tr = document.createElement('tr');
    cells.forEach(function (t) { var td = document.createElement('td'); td.textContent = t == null ? '' : String(t); tr.appendChild(td); });
    tbody.appendChild(tr);
  }
  function empty(tbody, cols, text) {
    tbody.textContent = '';
    var tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = cols; td.className = 'empty'; td.textContent = text; tr.appendChild(td); tbody.appendChild(tr);
  }
  var verdict = function (ok) { return ok === true ? _t('adm.budget.clean', 'clean') : ok === false ? _t('adm.budget.not_clean', 'NOT clean') : _t('adm.budget.open', 'open'); };
  function render(v) {
    var k = $('budgetKv');
    k.textContent = '';
    var who = v.owner === 'site' ? _t('adm.budget.owner_site', 'The site owns the week') : v.owner === 'cutting' ? _t('adm.budget.owner_cutting', 'Being handed over')
      : _t('adm.budget.owner_pepe', 'Pepe owns the week; the site is checking it');
    kv(k, _t('adm.budget.owner', 'Owner'), who + (v.paused ? ' · ' + _t('adm.budget.paused', 'paused') : ''));
    kv(k, _t('adm.budget.week', 'Week'), (v.week && v.week.id) || '—');
    kv(k, _t('adm.budget.streak', 'Clean days in a row'), String(v.streak || 0));
    if (v.latest) kv(k, _t('adm.budget.last_read', 'Last comparison'), v.latest.day + ' · ' + verdict(v.latest.ok) + ' · ' + when(v.latest.at));
    var g = $('budgetGroups');
    g.textContent = '';
    (v.groups || []).forEach(function (x) {
      row(g, [x.group, x.budget < 0 ? _t('adm.budget.uncapped', 'no cap') : fmt(x.budget), fmt(x.pepe_spent), fmt(x.site_spent), fmt(x.drift), fmt(x.left)]);
    });
    if (!(v.groups || []).length) empty(g, 6, _t('adm.budget.none', 'No comparison yet.'));
    var d = $('budgetDays');
    d.textContent = '';
    (v.days || []).concat(v.weeks || []).forEach(function (x) {
      row(d, [x.period, verdict(x.ok), x.attempts || '', (x.final ? x.final + ' ' : '') + (x.blocking || []).slice(0, 3).join(' | ') + ((x.notes || []).length ? ' ' + x.notes.join(' | ') : '')]);
    });
    if (!(v.days || []).length && !(v.weeks || []).length) empty(d, 4, _t('adm.budget.none', 'No comparison yet.'));
    var site = v.owner === 'site';
    $('budgetSite').hidden = !site;
    if (site) {
      var r = $('budgetRecent');
      r.textContent = '';
      (v.recent || []).forEach(function (x) { row(r, [when(x.ts), x.flow, fmt(x.amount), x.status + (x.code ? ' ' + x.code : '')]); });
    }
  }
  fetch('/api/admin/policy/budget', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.ok) render(j); else $('budgetMsg').textContent = (j && j.error) || _t('adm.budget.failed', "Couldn't read it."); })
    .catch(function () { $('budgetMsg').textContent = _t('adm.budget.failed', "Couldn't read it."); });
})();
