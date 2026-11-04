// admin-safety.js - 1.99?? padppl: Users & Accounts → 👥 "Named like a Camfrog user" (cfnames.js: GET/POST /api/admin/nameclash - rename /
// mark OK / open the profile) and 🌐⛔ "Network bans" (netban.js: the switch, ban an account's recent networks / an IP / a range, who
// shares an account's networks - names only, every look logged with the reason). Text via textContent only.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.headers['x-requested-with'] = 'fetch'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.j = j; throw e; } return j; }); });
  }
  function msg(id, t, bad) { var m = $(id); if (!m) return; m.textContent = t || ''; m.className = 'adm-msg' + (t ? (bad ? ' err' : ' ok') : ''); }
  function day(ms) { try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch (e) { return ''; } }

  // ── 👥 named like a Camfrog user ──
  var nc = $('ncList');
  function loadClashes() {
    if (!nc) return;
    nc.textContent = ''; nc.appendChild(el('li', 'adm-help', 'Loading…'));
    api('/api/admin/nameclash').then(function (d) {
      nc.textContent = '';
      var badge = $('ncCount'); if (badge) badge.textContent = String(d.list.length);
      if (!d.list.length) { nc.appendChild(el('li', 'adm-help', 'No account is named like a Camfrog user it isn\'t linked to.')); return; }
      d.list.forEach(function (r) {
        var li = el('li', 'nc-row');
        var who = el('div', 'nc-who');
        var a = el('a', null, '@' + r.username); a.href = '/u/' + encodeURIComponent(r.username); who.appendChild(a);
        who.appendChild(el('span', null, ' · its ' + (r.by === 'username' ? 'username' : 'display name "' + (r.display || '') + '"') + ' is the Camfrog login '));
        who.appendChild(el('b', null, r.login));
        who.appendChild(el('small', 'adm-help', ' — that login is ' + (r.loginOwner ? 'linked to @' + r.loginOwner : 'not linked to any PATV account') + (r.linked ? '; this account is linked to ' + r.linked : '; this account has no Camfrog link') + (r.created ? ' · made ' + String(r.created).slice(0, 10) : '')));
        li.appendChild(who);
        var row = el('div', 'adm-actions');
        var nm = el('input'); nm.type = 'text'; nm.maxLength = 48; nm.placeholder = 'New username'; nm.setAttribute('aria-label', 'New username for @' + r.username);
        var rn = el('button', 'adm-btn', 'Rename'); rn.type = 'button';
        var ok = el('button', 'adm-btn ghost', 'Mark OK (same person)'); ok.type = 'button';
        var out = el('span', 'adm-msg'); out.setAttribute('role', 'status');
        rn.addEventListener('click', function () {
          if (!nm.value.trim()) { nm.focus(); return; }
          rn.disabled = true; api('/api/admin/nameclash', { op: 'rename', userId: r.userId, username: nm.value.trim() })
            .then(function (x) { out.textContent = 'Renamed to @' + x.username + ' - they were told.'; out.className = 'adm-msg ok'; })
            .catch(function (e) { rn.disabled = false; out.textContent = e.message; out.className = 'adm-msg err'; });
        });
        ok.addEventListener('click', function () {
          ok.disabled = true; api('/api/admin/nameclash', { op: 'ok', userId: r.userId, name: r.login })
            .then(function () { out.textContent = 'Marked OK - no tag, no warning.'; out.className = 'adm-msg ok'; })
            .catch(function (e) { ok.disabled = false; out.textContent = e.message; out.className = 'adm-msg err'; });
        });
        row.appendChild(nm); row.appendChild(rn); row.appendChild(ok); row.appendChild(out);
        li.appendChild(row); nc.appendChild(li);
      });
    }).catch(function (e) { nc.textContent = ''; nc.appendChild(el('li', 'adm-msg err', e.message)); });
  }
  var ncGo = $('ncLoad'); if (ncGo) ncGo.addEventListener('click', loadClashes);

  // ── 🌐⛔ network bans ──
  var nbList = $('nbList');
  function loadBans() {
    if (!nbList) return;
    api('/api/admin/netbans').then(function (d) {
      var sw = $('nbOn'); if (sw) sw.checked = !!d.on;
      $('nbForms').hidden = !d.on;
      nbList.textContent = '';
      if (!d.bans.length) { nbList.appendChild(el('li', 'adm-help', d.on ? 'No network bans.' : 'Network bans are off - nothing is recorded.')); return; }
      d.bans.forEach(function (b) {
        var li = el('li');
        li.appendChild(el('b', null, b.kind === 'range' ? 'Range ' + b.rule : b.kind === 'account' ? 'A network @' + b.from + ' used' : 'One typed IP'));
        li.appendChild(el('span', null, ' · ' + (b.scope === 'pad' ? 'pad ' + (b.room || '?') : 'site-wide') + ' · ' + (b.until ? 'until ' + day(b.until) : 'permanent') + (b.reason ? ' · ' + b.reason : '') + ' · by ' + b.by));
        var x = el('button', 'adm-btn ghost', 'Lift'); x.type = 'button';
        x.addEventListener('click', function () { x.disabled = true; api('/api/admin/netbans', { op: 'lift', id: b.id }).then(loadBans).catch(function (e) { x.disabled = false; msg('nbMsg', e.message, true); }); });
        li.appendChild(document.createTextNode(' ')); li.appendChild(x); nbList.appendChild(li);
      });
    }).catch(function (e) { msg('nbMsg', e.message, true); });
  }
  var sw = $('nbOn');
  if (sw) sw.addEventListener('change', function () {
    if (sw.checked && !confirm('Start recording a keyed code of each member\'s network (never the address), kept 90 days, for network bans? The privacy page says so from now on.')) { sw.checked = false; return; }
    api('/api/admin/netbans', { op: 'switch', on: sw.checked }).then(function () { msg('nbMsg', sw.checked ? 'On.' : 'Off.'); loadBans(); }).catch(function (e) { sw.checked = !sw.checked; msg('nbMsg', e.message, true); });
  });
  var nbF = $('nbForm');
  if (nbF) nbF.addEventListener('submit', function (e) {
    e.preventDefault();
    var kind = $('nbKind').value, val = $('nbValue').value.trim(), days = Number($('nbDays').value), reason = $('nbReason').value;
    if (!val) return;
    var body = kind === 'account' ? { op: 'account', target: val, scope: 'site', days: days, reason: reason } : { op: kind, value: val, scope: 'site', days: days, reason: reason };
    if (days === 0 && prompt('A permanent network ban - type BAN to confirm') !== 'BAN') return;
    api('/api/admin/netbans', body).then(function (d) { msg('nbMsg', kind === 'account' ? 'Banned ' + d.networks + ' network(s).' : 'Banned.'); $('nbValue').value = ''; loadBans(); })
      .catch(function (err) { msg('nbMsg', err.message, true); });
  });
  var nsF = $('nsForm');
  if (nsF) nsF.addEventListener('submit', function (e) {
    e.preventDefault();
    var who = $('nsWho').value.trim(), why = $('nsWhy').value.trim(), out = $('nsOut');
    if (!who || !why) return;
    out.textContent = '';
    // who: u:<id>, @name or cf:<login> (targets.js - a name that means two people asks which); logged with the reason
    api('/api/admin/nets/' + encodeURIComponent(who) + '?reason=' + encodeURIComponent(why)).then(function (d) {
      out.appendChild(el('li', 'adm-help', d.networks + ' network(s) in 90 days; ' + d.shared.length + ' other account(s) used one of them:'));
      d.shared.forEach(function (s) { out.appendChild(el('li', null, '@' + (s.username || '?') + (s.linked ? ' (Camfrog ' + s.linked + ')' : '') + ' · last ' + s.lastDay)); });
    }).catch(function (err) { out.appendChild(el('li', 'adm-msg err', err.message)); });
  });
  if (nbList) loadBans();
})();
