// admin-safety.js - 1.99?? padppl: Users & Accounts → 👥 "Named like a Camfrog user" (cfnames.js: GET/POST /api/admin/nameclash - rename /
// mark OK / open the profile) and 🌐⛔ "Network bans" (netban.js: the switch, ban an account's recent networks / an IP / a range, who
// shares an account's networks - names only - and which bans hit it, with "let them through"; every look logged with the reason).
// Review fixes: rows with their buttons on the right; logins in a monospace face; the look is a POST (the reason never sits in a URL);
// an account's networks are ONE row; a member caught on a shared network is let through (exempt) instead of lifting the ban.
// Text via textContent only.
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
  function mono(t) { return el('span', 'mono', t); }

  // ── 👥 named like a Camfrog user ──
  var nc = $('ncList');
  function loadClashes() {
    if (!nc) return;
    nc.textContent = ''; nc.appendChild(el('li', 'adm-help', 'Loading…'));
    api('/api/admin/nameclash').then(function (d) {
      nc.textContent = '';
      var list = d.list || []; var badge = $('ncCount'); if (badge) badge.textContent = String(list.length);
      if (!list.length) { nc.appendChild(el('li', 'adm-help', 'No account is named like a Camfrog user it isn\'t linked to.')); return; }
      list.forEach(function (r) {
        var li = el('li', 'sfty-row');
        var who = el('div', 'sfty-who');
        var a = el('a', 'mono', '@' + r.username); a.href = '/u/' + encodeURIComponent(r.username); who.appendChild(a);
        who.appendChild(document.createTextNode(' · its ' + (r.by === 'username' ? 'username' : 'display name ')));
        if (r.by !== 'username') who.appendChild(mono('"' + (r.display || '') + '"'));
        who.appendChild(document.createTextNode(' looks like the Camfrog login '));
        who.appendChild(el('b', 'mono', r.login));
        var sm = el('small');
        sm.appendChild(document.createTextNode('that login is ' + (r.loginOwner ? 'linked to ' : 'not linked to any PATV account')));
        if (r.loginOwner) sm.appendChild(mono('@' + r.loginOwner));
        sm.appendChild(document.createTextNode(r.linked ? '; this account is linked to ' : '; this account has no Camfrog link'));
        if (r.linked) sm.appendChild(mono(r.linked));
        if (r.created) sm.appendChild(document.createTextNode(' · made ' + String(r.created).slice(0, 10)));
        who.appendChild(sm);
        li.appendChild(who);
        var row = el('div', 'sfty-btns');
        var nm = el('input'); nm.type = 'text'; nm.maxLength = 48; nm.placeholder = 'New username'; nm.className = 'mono'; nm.setAttribute('aria-label', 'New username for @' + r.username);
        var rn = el('button', 'adm-btn', 'Rename'); rn.type = 'button';
        var ok = el('button', 'adm-btn ghost', 'Mark OK'); ok.type = 'button'; ok.title = 'The same person, not linked yet - no tag, no warning';
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
      var bans = d.bans || [];
      if (!bans.length) { nbList.appendChild(el('li', 'adm-help', d.on ? 'No network bans.' : 'Network bans are off - nothing is recorded.')); return; }
      bans.forEach(function (b) {
        var li = el('li', 'sfty-row'), who = el('div', 'sfty-who');
        if (b.kind === 'range') { who.appendChild(el('b', null, 'Range ')); who.appendChild(mono(b.rule)); }
        else if (b.kind === 'account') { who.appendChild(el('b', null, (b.n > 1 ? b.n + ' networks ' : 'The network ') + 'used by ')); who.appendChild(mono('@' + (b.from || '?'))); }
        else who.appendChild(el('b', null, 'One typed IP'));
        who.appendChild(el('small', null, (b.scope === 'pad' ? 'pad ' + (b.room || '?') : 'site-wide') + ' · ' + (b.until ? 'until ' + day(b.until) : 'permanent') + (b.reason ? ' · ' + b.reason : '') + ' · by ' + b.by
          + (b.exempt ? ' · ' + b.exempt + ' let through' : '')));
        li.appendChild(who);
        var btns = el('div', 'sfty-btns');
        var x = el('button', 'adm-btn ghost', 'Lift'); x.type = 'button';
        x.addEventListener('click', function () { x.disabled = true; api('/api/admin/netbans', { op: 'lift', ids: b.ids || [b.id] }).then(loadBans).catch(function (e) { x.disabled = false; msg('nbMsg', e.message, true); }); });
        btns.appendChild(x); li.appendChild(btns); nbList.appendChild(li);
      });
    }).catch(function (e) { msg('nbMsg', e.message, true); });
  }
  var sw = $('nbOn');
  if (sw) sw.addEventListener('change', function () {
    if (sw.checked && !confirm('Start recording a keyed code of each member\'s network (never the address), kept 90 days, for network bans? The privacy page says so from now on.')) { sw.checked = false; return; }
    api('/api/admin/netbans', { op: 'switch', on: sw.checked }).then(function () { msg('nbMsg', sw.checked ? 'On.' : 'Off - nothing new is recorded; the codes already kept still go 90 days after their last use.'); loadBans(); }).catch(function (e) { sw.checked = !sw.checked; msg('nbMsg', e.message, true); });
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
  // the look: who shares an account's networks / which bans hit it (both logged with the reason; POST - never in a URL)
  var nsF = $('nsForm'), nsHit = $('nsHit');
  function look(op) {
    var who = $('nsWho').value.trim(), why = $('nsWhy').value.trim(), out = $('nsOut');
    if (!who) { $('nsWho').focus(); return; }
    if (!why) { $('nsWhy').focus(); return; }
    out.textContent = '';
    api('/api/admin/nets', { who: who, reason: why, op: op === 'hitting' ? 'hitting' : undefined }).then(function (d) {
      if (op === 'hitting') {
        var bans = d.bans || [];
        out.appendChild(el('li', 'adm-help', bans.length ? bans.length + ' ban(s) would refuse @' + d.username + ' from the networks it used lately:' : 'No active ban hits @' + d.username + '.'));
        bans.forEach(function (b) {
          var li = el('li', 'sfty-row'), w = el('div', 'sfty-who');
          w.appendChild(el('b', null, b.from ? 'Networks of @' + b.from : 'A typed IP or range'));
          w.appendChild(el('small', null, (b.scope === 'pad' ? 'pad ' + (b.room || '?') : 'site-wide') + ' · ' + (b.until ? 'until ' + day(b.until) : 'permanent')));
          li.appendChild(w); out.appendChild(li);
        });
        if (bans.length) {
          var li2 = el('li', 'sfty-row'), letGo = el('button', 'adm-btn', 'Let @' + d.username + ' through all of them'); letGo.type = 'button';
          letGo.addEventListener('click', function () {
            letGo.disabled = true;
            api('/api/admin/netbans', { op: 'exempt', target: who, ids: bans.map(function (b) { return b.id; }), reason: why })
              .then(function (r) { letGo.textContent = 'Let through ' + r.n + ' ban(s).'; loadBans(); })
              .catch(function (e) { letGo.disabled = false; msg('nbMsg', e.message, true); });
          });
          li2.appendChild(letGo); out.appendChild(li2);
        }
        return;
      }
      out.appendChild(el('li', 'adm-help', d.networks + ' network(s) in 90 days; ' + d.shared.length + ' other account(s) used one of them:'));
      d.shared.forEach(function (s) {
        var li = el('li', 'sfty-row'), w = el('div', 'sfty-who');
        w.appendChild(mono('@' + (s.username || '?')));
        w.appendChild(el('small', null, (s.linked ? 'Camfrog ' + s.linked + ' · ' : '') + 'last ' + s.lastDay));
        li.appendChild(w); out.appendChild(li);
      });
    }).catch(function (err) { out.appendChild(el('li', 'adm-msg err', err.message)); });
  }
  if (nsF) nsF.addEventListener('submit', function (e) { e.preventDefault(); look('shared'); });
  if (nsHit) nsHit.addEventListener('click', function () { look('hitting'); });
  if (nbList) loadBans();
})();
