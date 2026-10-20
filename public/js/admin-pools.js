// admin-pools.js (1.99ns) - /admin/economy's 🏦 Protocol pools card (pools.js + econstore.js on the server).
// Read: GET /api/admin/econ/store. Edits (routing row / one !econ command): preview -> single-use nonce -> account password
// -> a website action Pepe runs with his own validation (econ.routes / econ.cmd); the result is polled and shown.
(function () {
  'use strict';
  var box = document.getElementById('poolsAdm');
  if (!box) return;
  var csrf = box.getAttribute('data-csrf');
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return n == null ? '—' : Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var when = function (ms) { return ms ? new Date(Number(ms) < 1e12 ? Number(ms) * 1000 : Number(ms)).toISOString().slice(0, 16).replace('T', ' ') : '—'; };
  var view = null, pending = null, nonce = null;
  function msg(t, bad) { var m = $('poolsMsg'); m.textContent = t || ''; m.style.color = bad ? '#ef5350' : ''; }
  function api(path, body, extra) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: { 'x-csrf-token': csrf } };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    if (extra) for (var k in extra) o.headers[k] = extra[k];
    return fetch(path, o).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'failed'); return j; }); });
  }
  function kv(label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); return d; }
  function row(tbody, cells, numIdx) {
    var tr = document.createElement('tr');
    cells.forEach(function (t, i) { var td = document.createElement('td'); td.textContent = t; if (numIdx && numIdx.indexOf(i) >= 0) td.className = 'num'; tr.appendChild(td); });
    tbody.appendChild(tr);
  }
  function empty(tbody, n, t) { var tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = n; td.className = 'empty'; td.textContent = t; tr.appendChild(td); tbody.appendChild(tr); }
  var shareText = function (sh) { return (sh || []).map(function (s) { return s[0] + ' ' + s[1] + '%'; }).join(', ') || '—'; };
  function render() {
    var p = view.pools || {};
    var k = $('poolsKv'); k.textContent = '';
    k.appendChild(kv('Where the pools live', p.live ? 'publicaccess.tv (cut over)' : 'Pepe (local) - not cut over'));
    k.appendChild(kv('Site switch', p.enabled ? 'ON (Pepe may cut over)' : 'OFF'));
    k.appendChild(kv('Total in pools', fmt(p.sum) + ' PAT in ' + fmt(p.count) + ' pools'));
    k.appendChild(kv('Turf inbox (waiting for Pepe)', fmt((p.inbox || {}).amount) + ' PAT · ' + fmt((p.inbox || {}).count) + ' legs'));
    if (p.imported) k.appendChild(kv('Cutover', (p.imported.key || '') + ' · ' + when(p.imported.at) + (p.imported.rolled_back ? ' · ROLLED BACK ' + when(p.imported.rolled_back.at) : '')));
    k.appendChild(kv('Balances sha256', String(p.digest || '').slice(0, 16) + '…'));
    var sw = $('poolsSwitch');
    sw.hidden = !!p.live;
    sw.textContent = p.enabled ? 'Switch the pools backend OFF' : 'Switch the pools backend ON (lets Pepe cut over)';
    var rows = $('poolsRows'); rows.textContent = '';
    var keys = Object.keys(p.pools || {}).sort();
    keys.forEach(function (key) { var l = (p.labels || {})[key] || {}; row(rows, [(l.label ? l.label + ' ' : '') + '(' + key + ')', fmt(p.pools[key]), when(l.updated)], [1]); });
    if (!keys.length) empty(rows, 3, 'No pools on the site yet.');
    var mv = $('poolsMoves'); mv.textContent = '';
    (p.moves || []).forEach(function (m) { row(mv, [when(m.ts), m.kind, m.flow || '', (m.legs || []).map(function (l) { return l[0] + ' ' + (l[1] > 0 ? '+' : '') + fmt(l[1]); }).join(', '), m.key]); });
    var fed = $('poolsFed'); fed.textContent = '';
    (view.fed_journal || []).forEach(function (f) { row(fed, [f.id, fmt(f.amount), f.pool || '', f.policy || '', f.state || '', f.reason || ''], [1]); });
    if (!(view.fed_journal || []).length) empty(fed, 6, 'Nothing journaled here yet.');
    var inc = $('poolsInc'); inc.textContent = '';
    // 1.99sr: a budget of -1 = the group is uncapped this week (Pepe's budget_<group> = unlimited)
    (view.incentive_groups || []).forEach(function (g) { var unc = Number(g.budget) < 0; row(inc, [g.grp, g.week || '', unc ? 'uncapped' : fmt(g.budget), fmt(g.spent), unc ? '—' : fmt(g.remaining)], [2, 3, 4]); });
    $('poolsDocs').textContent = 'Journals held here: ' + (Object.keys(view.docs || {}).map(function (d) { return d + ' (rev ' + view.docs[d].rev + ', ' + when(view.docs[d].updated) + ')'; }).join(' · ') || 'none yet');
    var cat = (view.catalog && view.catalog.routes) || {};
    var rt = $('poolsRoutes'); rt.textContent = '';
    var flows = Object.keys(cat).sort();
    var over = view.pat_routes || {};
    Object.keys(over).forEach(function (f) { if (flows.indexOf(f) < 0) flows.push(f); });
    flows.forEach(function (f) { if (over[f] || (cat[f] && !cat[f].readonly)) row(rt, [(cat[f] && cat[f].label) || f, over[f] ? shareText(over[f]) : '(default)', cat[f] ? shareText(cat[f]['default']) : '?']); });
    var sel = $('routeFlow'); var cur = sel.value; sel.textContent = '';
    flows.filter(function (f) { return !(cat[f] && cat[f].readonly); }).forEach(function (f) { var o = document.createElement('option'); o.value = f; o.textContent = ((cat[f] && cat[f].group) ? cat[f].group + ' · ' : '') + ((cat[f] && cat[f].label) || f); sel.appendChild(o); });
    if (cur) sel.value = cur;
    var cfg = $('poolsCfg'); cfg.textContent = '';
    Object.keys(view.econ_cfg || {}).sort().forEach(function (key) { row(cfg, [key, JSON.stringify(view.econ_cfg[key])]); });
    if (!Object.keys(view.econ_cfg || {}).length) empty(cfg, 2, 'Every key at its default.');
  }
  function load() { return api('/api/admin/econ/store').then(function (j) { view = j; render(); }).catch(function (e) { msg(e.message, true); }); }
  function cancel() { pending = null; nonce = null; $('poolsConfirm').hidden = true; $('poolsPw').value = ''; }
  function ask(what, body) {
    cancel();
    pending = body;
    $('poolsWhat').textContent = what;
    $('poolsConfirm').hidden = false;
    msg('');
    api('/api/admin/econ/edit/nonce', {}).then(function (j) { nonce = j.nonce; $('poolsPw').focus(); }).catch(function (e) { msg(e.message, true); cancel(); });
  }
  $('routeForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var flow = $('routeFlow').value, raw = $('routeShares').value.trim();
    if (!flow) { msg('Pick a flow.', true); return; }
    // review of PO-2: once the site owns the economy settings a routing change carries the rev this card loaded (a stale one is
    // refused - reload) and a note
    var site = !!(view && view.cfg && view.cfg.owner === 'site');
    var note = ($('routeNote') && $('routeNote').value || '').trim();
    if (site && note.length < 3) { msg('Say why in the note - every change is logged with it.', true); return; }
    var extra = site ? { base_rev: view.cfg.rev, note: note } : {};
    if (!raw) { ask('Put ' + flow + ' back to its default route.', Object.assign({ op: 'routes', flow: flow, reset: true }, extra)); return; }
    var shares = [], bad = false;
    raw.split(',').forEach(function (part) { var m = /^\s*([a-z_:]+)\s+([0-9]+(?:\.[0-9]{1,2})?)\s*%?\s*$/i.exec(part); if (!m) bad = true; else shares.push([m[1], Number(m[2])]); });
    var tot = shares.reduce(function (t, s) { return t + s[1]; }, 0);
    if (bad || !shares.length || tot > 100) { msg('Shares look like "reserve 90, room_owner 10" (at most 100% in all).', true); return; }
    ask('Route ' + flow + ': ' + shareText(shares) + (tot < 100 ? ' (the other ' + (100 - tot) + '% goes to the Federal Reserve)' : '') + '. Pepe checks it against the routing rules.', Object.assign({ op: 'routes', flow: flow, shares: shares }, extra));
  });
  $('econForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var t = $('econText').value.trim().replace(/^!?econ\s+/i, '');
    if (!t) { msg('Type an !econ command.', true); return; }
    ask('Run "!econ ' + t + '" as you, in Pepe. PAT moves only after its own confirm step.', { op: 'cmd', text: t });
  });
  $('poolsNo').addEventListener('click', function () { cancel(); msg('Cancelled - nothing sent.'); });
  $('poolsYes').addEventListener('click', function () {
    if (!pending || !nonce) { msg('Start again.', true); return; }
    var body = Object.assign({}, pending, { nonce: nonce, password: $('poolsPw').value });
    cancel();
    msg('Sending to Pepe…');
    api('/api/admin/econ/edit', body).then(function (j) {
      // PO-2: once the site owns the economy settings a routing change is applied here at once (no Pepe round trip)
      if (j.request && j.request.applied) { msg(j.request.msg || 'Saved.'); if ($('routeNote')) $('routeNote').value = ''; load(); return; }
      var id = j.request.id, tries = 0;
      (function poll() {
        api('/api/admin/econ/edit/' + id).then(function (a) {
          var s = a.action.status;
          if (s === 'done' || s === 'failed' || s === 'expired') { msg(a.action.message || s, s !== 'done'); load(); return; }
          if (++tries > 40) { msg('Queued for Pepe (#' + id + ') - he runs it when he is online.'); return; }
          msg('Waiting for Pepe… (' + s + ')');
          setTimeout(poll, 3000);
        }).catch(function (e) { msg(e.message, true); });
      })();
    }).catch(function (e) { msg(e.message, true); });
  });
  $('poolsSwitch').addEventListener('click', function () {
    var on = !(view && view.pools && view.pools.enabled);
    if (!confirm(on ? 'Let Pepe hand his pools over to the site (he still needs !econ pools backend cutover confirm)?' : 'Switch the pools backend off?')) return;
    api('/api/admin/pools-backend', { on: on }, { 'X-Requested-With': 'fetch' }).then(function () { load(); }).catch(function (e) { msg(e.message, true); });
  });
  load();
})();
