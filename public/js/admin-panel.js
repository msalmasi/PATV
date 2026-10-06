// admin-panel.js — the controls that used to be inline on the one long /admin/panel page (1.99cv), now spread
// over /admin/users, /admin/economy, /admin/games and /admin/cosmetics. Each block wires its card only when the
// card is on the page. Same endpoints, same request bodies, same permission checks (all server-side) as before.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var n = function (x) { return Number(x || 0).toLocaleString('en-US'); };
  var when = function (t) { return t ? new Date(Number(t)).toISOString().slice(0, 16).replace('T', ' ') : ''; };
  function say(id, ok, text) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'adm-msg ' + (ok ? 'ok' : 'err');
  }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  // the old cards' rule: a non-2xx is a failure; a 2xx whose message says "successfully" is a success
  function legacy(p, okText, failText, statusId) {
    return p.then(function (r) { if (!r.ok) throw new Error(failText); return r.json(); })
      .then(function (d) { if (d && d.message && d.message.indexOf('successfully') >= 0) say(statusId, true, okText); else say(statusId, false, (d && d.message) || failText); return d; })
      .catch(function (e) { console.error('Admin request failed:', e); say(statusId, false, failText); });
  }
  function chip(label, extra) {
    var d = document.createElement('div');
    d.className = 'adm-chip';
    var main = document.createElement('button');
    main.type = 'button'; main.className = 'grow'; main.style.textAlign = 'left';
    main.textContent = label;
    d.appendChild(main);
    if (extra) { var s = document.createElement('span'); s.className = 'adm-help'; s.style.margin = '0'; s.textContent = extra; d.appendChild(s); }
    var del = document.createElement('button');
    del.type = 'button'; del.className = 'del'; del.textContent = '✕ Delete'; del.setAttribute('aria-label', 'Delete ' + label);
    d.appendChild(del);
    var ul = document.createElement('ul'); ul.hidden = true;
    d.appendChild(ul);
    return { el: d, open: main, del: del, list: ul };
  }
  function toggleUsers(ul, url) {
    if (!ul.hidden) { ul.hidden = true; return; }
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      ul.textContent = '';
      (data || []).forEach(function (u) { var li = document.createElement('li'); li.textContent = u.username + ' (User ID: ' + u.userId + ')'; ul.appendChild(li); });
      if (!(data || []).length) { var li = document.createElement('li'); li.textContent = 'Nobody yet.'; ul.appendChild(li); }
      ul.hidden = false;
    });
  }

  // ── Users & Accounts: assign a class ──
  var classEdit = $('classEditForm');
  if (classEdit) {
    classEdit.addEventListener('submit', function (e) {
      e.preventDefault();
      var username = $('userClassUsername').value;
      legacy(fetch(classEdit.getAttribute('action').replace('username', encodeURIComponent(username)), {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ class: $('userClass').value }), method: 'POST',
      }), 'Class edited successfully.', 'Class change failed. Check the username.', 'classEditStatus');
    });
  }
  // the class list (the select above + the list in "Manage classes")
  function loadClasses() {
    return fetch('/api/classes').then(function (r) { return r.json(); }).then(function (classes) {
      var sel = $('userClass');
      if (sel) {
        var keep = sel.value;
        while (sel.options.length > 1) sel.remove(1);
        classes.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
        sel.value = keep;
      }
      var list = $('classList');
      if (list) {
        list.textContent = '';
        classes.forEach(function (c) { var li = document.createElement('li'); li.textContent = c; list.appendChild(li); });
      }
    }).catch(function (e) { console.error('Failed to load classes:', e); });
  }
  if ($('userClass') || $('classList')) loadClasses();
  var classList = $('classListForm');
  if (classList) {
    classList.addEventListener('submit', function (e) {
      e.preventDefault();
      legacy(fetch('/api/classes/edit', {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: $('classAction').value, className: $('className').value }), method: 'POST',
      }), 'Class list edited successfully.', 'Class list change failed. Check the classname.', 'classListStatus').then(loadClasses);
    });
  }

  // ── Users & Accounts: XP ──
  var xp = $('xpTransferForm');
  if (xp) {
    xp.addEventListener('submit', function (e) {
      e.preventDefault();
      legacy(fetch('/api/admin/update-level', {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('xpUsername').value, additionalXp: $('xpAmount').value }), method: 'POST',
      }), 'XP added successfully.', 'XP adding failed. Check the username.', 'xpStatus');
    });
  }

  // ── Users & Accounts: welcome bonus (admins only - the API says so) ──
  var wHost = $('welcome-admin'), wForm = $('welcome-config');
  if (wHost && wForm) {
    var wLoad = function () {
      return fetch('/api/admin/welcome').then(function (r) {
        if (r.status === 403) { $('welcome-stats').textContent = 'Admins only.'; wForm.remove(); return null; }
        return r.json();
      }).then(function (d) {
        if (!d) return;
        Object.keys(d.config || {}).forEach(function (k) { if (wForm.elements[k]) wForm.elements[k].value = d.config[k]; });
        var c = d.counts || {};
        $('welcome-stats').textContent = 'Pending ' + (c.pending || 0) + ' · paid ' + (c.paid || 0) + ' · duplicate ' + (c.duplicate || 0)
          + ' · expired ' + (c.expired || 0) + ' · legacy ' + (c.legacy || 0) + ' — last 7 days: ' + d.paid7.n + ' paid, '
          + Number(d.paid7.total).toLocaleString() + ' PAT (' + Number(d.paid7.perDay).toLocaleString() + '/day)';
        var rows = (d.recent || []).map(function (x) {
          return '<tr><td>' + esc(x.displayname || x.username || x.userId) + ' <small>(' + esc(x.source || '') + ')</small></td><td>' + esc(x.state)
            + (x.amount ? ' ' + Number(x.amount).toLocaleString() : '') + '</td><td>' + esc(x.reason || '') + (x.dup_name ? ' → ' + esc(x.dup_name) : '') + '</td><td>' + when(x.decided || x.created) + '</td><td>'
            + (x.state === 'duplicate' || x.state === 'expired' ? '<button type="button" class="adm-btn ghost" data-pay="' + esc(x.userId) + '">Pay anyway</button>' : '') + '</td></tr>';
        });
        $('welcome-recent').innerHTML = rows.join('') || '<tr><td colspan="5" class="empty">No decisions yet.</td></tr>';
      });
    };
    wForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = {};
      Array.prototype.forEach.call(wForm.elements, function (el) { if (el.name) body[el.name] = Number(el.value); });
      postJson('/api/admin/welcome/config', body).then(function (r) { say('welcomeMsg', r.ok, r.ok ? 'Saved.' : 'Not saved.'); wLoad(); });
    });
    wHost.addEventListener('click', function (e) {
      var id = e.target && e.target.dataset && e.target.dataset.pay;
      if (!id || !confirm('Pay this account its welcome bonus anyway?')) return;
      postJson('/api/admin/welcome/pay', { userId: id }).then(function (r) { return r.json(); }).then(function (r) {
        alert(r.ok ? 'Paid ' + Number(r.amount).toLocaleString() + ' PAT.' : 'Not paid: ' + (r.why || r.error));
        wLoad();
      });
    });
    wLoad().catch(function () {});
  }

  // ── Users & Accounts: stale-account cleanup (admins only) ──
  if ($('stale-dates')) {
    fetch('/api/admin/stale').then(function (r) { return r.status === 403 ? null : r.json(); }).then(function (d) {
      var dates = $('stale-dates');
      if (!d) { dates.textContent = 'Admins only.'; return; }
      var m = d.meta;
      if (!m) { dates.textContent = 'No warning window started yet.'; return; }
      dates.innerHTML = 'Warning window <b>' + esc(m.run_id) + '</b> started ' + esc(new Date(m.started_at).toISOString().slice(0, 10))
        + ' · <b>archive on ' + esc(m.apply_on) + '</b> · <b>purge from ' + esc(m.purge_on) + '</b> (empty tier-A accounts) · tiers ' + esc((m.tiers || []).join('+'))
        + (d.archived ? ' · archived now: ' + n(d.archived.n) + ' (' + n(d.archived.pat) + ' PAT in the Reserve)' : '');
      var by = {};
      (d.rows || []).forEach(function (r) { var t = by[r.tier] || (by[r.tier] = {}); t[r.state] = r; });
      var states = ['pending', 'cleared', 'archived'];
      $('stale-counts').innerHTML = Object.keys(by).sort().map(function (t) {
        return '<tr><td>' + esc(t) + '</td>' + states.map(function (s) { return '<td class="num">' + (by[t][s] ? n(by[t][s].n) + ' <small>(' + n(by[t][s].pat) + ' PAT)</small>' : '-') + '</td>'; }).join('') + '</tr>';
      }).join('') || '<tr><td colspan="4" class="empty">No accounts in this window.</td></tr>';
      $('stale-vias').textContent = (d.vias || []).length ? 'Cleared by: ' + d.vias.map(function (v) { return (v.via || '?') + ' ' + v.n; }).join(' · ') : '';
    }).catch(function () {});
  }

  // ── Economy: PAT grants (the old "Points Panel") ──
  var grant = $('pointsTransferForm');
  if (grant) {
    grant.addEventListener('submit', function (e) {
      e.preventDefault();
      var username = $('pointsUsername').value;
      legacy(fetch(grant.getAttribute('action').replace('username', encodeURIComponent(username)), {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: $('pointsAmount').value }), method: 'POST',
      }), 'PAT transferred successfully.', 'Transfer failed. Check the username.', 'transferStatus');
    });
  }

  // ── Economy: redemption codes ──
  function loadCodes() {
    var list = $('redemptionCodesList');
    if (!list) return;
    fetch('/api/admin/redemption-codes').then(function (r) { return r.json(); }).then(function (data) {
      list.textContent = '';
      if (!Array.isArray(data) || !data.length) { list.innerHTML = '<p class="adm-help">No codes yet.</p>'; return; }
      data.forEach(function (code) {
        var c = chip(code.code, code.uses_remaining + ' left');
        c.open.addEventListener('click', function () { toggleUsers(c.list, '/api/admin/redemption-codes/' + encodeURIComponent(code.code) + '/users'); });
        c.del.addEventListener('click', function () {
          if (!confirm('Delete the code ' + code.code + '?')) return;
          fetch('/api/admin/redemption-codes/' + encodeURIComponent(code.code), { method: 'DELETE' }).then(function (r) { if (r.ok) loadCodes(); else alert('Failed to delete code'); });
        });
        list.appendChild(c.el);
      });
    });
  }
  var codes = $('redemption-codes');
  if (codes) {
    codes.addEventListener('submit', function (e) {
      e.preventDefault();
      legacy(postJson('/api/admin/redemption-codes', { code: $('code').value, points: $('points').value, uses_allowed: $('uses_allowed').value, expiration_date: $('expiration_date').value }),
        'Added redemption code successfully.', 'Failed to add the redemption code.', 'codeStatus').then(loadCodes);
    });
  }
  loadCodes();

  // ── Games: manual wheel spin + jackpot ──
  var spin = $('manualSpinForm');
  if (spin) {
    spin.addEventListener('submit', function (e) {
      e.preventDefault();
      postJson('/api/g/wheel/spin', { username: $('spinUsername').value })
        .then(function (r) { if (!r.ok) throw new Error('Spin already in progress'); return r.json(); })
        .then(function (d) { if (d.spinId !== undefined) say('spinStatus', true, 'Spinning for ' + $('spinUsername').value + '…'); })
        .catch(function (err) { console.error('Error making the POST request:', err); say('spinStatus', false, 'Spin is currently in progress...'); });
    });
  }
  var jp = $('jackpotForm');
  if (jp) {
    jp.addEventListener('submit', function (e) {
      e.preventDefault();
      legacy(postJson('/api/g/wheel/jackpot', { amount: $('jackpotAmount').value }), 'Jackpot updated successfully.', 'Failed to update the jackpot.', 'jackpotStatus');
    });
  }

  // ── Cosmetics & Achievements: badges ──
  function loadBadges() {
    var list = $('badgesList');
    if (!list) return;
    fetch('/api/badges').then(function (r) { return r.json(); }).then(function (data) {
      list.textContent = '';
      if (!Array.isArray(data) || !data.length) { list.innerHTML = '<p class="adm-help">No badges yet.</p>'; return; }
      data.forEach(function (badge) {
        fetch('/api/badges/' + badge.badgeId + '/users').then(function (r) { return r.json(); }).then(function (users) {
          var c = chip(badge.name + ' (' + (users || []).length + ' users)');
          c.open.addEventListener('click', function () { toggleUsers(c.list, '/api/badges/' + badge.badgeId + '/users'); });
          c.del.addEventListener('click', function () {
            if (!confirm('Delete the badge ' + badge.name + '?')) return;
            fetch('/api/badges/' + badge.badgeId, { method: 'DELETE' }).then(function (r) { if (r.ok) loadBadges(); else alert('Failed to delete badge'); });
          });
          list.appendChild(c.el);
        });
      });
    });
  }
  var badges = $('badges');
  if (badges) {
    badges.addEventListener('submit', function (e) {
      e.preventDefault();
      legacy(fetch(badges.action, { method: 'POST', body: new FormData(badges) }), 'Added badge successfully.', 'Failed to add the badge.', 'badgeStatus').then(loadBadges);
    });
  }
  loadBadges();
})();
