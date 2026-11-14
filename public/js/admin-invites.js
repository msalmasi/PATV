// admin-invites.js - 1.99anv: Users & Accounts → 🎟️ "Sign-ups & invites" (invites.js). The switch (open / invite-only), the expiry,
// the shop price, the level tiers (rows: level + invites, or unlimited on the last), "invites while open"; issue invites to a member;
// a house invite; every invite with a Revoke for the pending ones; issued / bought invites and the admin log.
// GET /api/admin/invites, POST /api/admin/invites/{settings,grant,house,<id>/revoke} - same-origin fetches. Text via textContent only.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  if (!$('invForm')) return;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.headers['x-requested-with'] = 'fetch'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  function msg(id, t, bad) { var m = $(id); if (!m) return; m.textContent = t || ''; m.className = 'adm-msg' + (t ? (bad ? ' err' : ' ok') : ''); }
  function day(ms) { try { return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : ''; } catch (e) { return ''; } }
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-US'); };

  // ── the tiers editor ──
  var tiersBox = $('invTiers');
  function tierRow(t) {
    var row = el('div', 'adm-form');
    row.setAttribute('data-tier', '');
    row.style.cssText = 'border:1px solid var(--ds-line, #2a2a2a);border-radius:10px;padding:8px 10px';
    var l = el('label', null, 'From level');
    var li = el('input'); li.type = 'number'; li.min = '0'; li.max = '1000'; li.step = '1'; li.inputMode = 'numeric'; li.value = t && t.level != null ? t.level : '';
    li.setAttribute('data-k', 'level'); l.appendChild(li);
    var g = el('label', null, 'Invites (adds up)');
    var gi = el('input'); gi.type = 'number'; gi.min = '0'; gi.max = '1000'; gi.step = '1'; gi.inputMode = 'numeric'; gi.value = t && !t.unlimited && t.grant != null ? t.grant : '';
    gi.setAttribute('data-k', 'grant'); g.appendChild(gi);
    var u = el('label', 'ck');
    var ui = el('input'); ui.type = 'checkbox'; ui.checked = !!(t && t.unlimited); ui.setAttribute('data-k', 'unlimited');
    u.appendChild(ui); u.appendChild(document.createTextNode(' Unlimited (last tier only)'));
    ui.addEventListener('change', function () { gi.disabled = ui.checked; });
    gi.disabled = ui.checked;
    var acts = el('div', 'adm-actions');
    var rm = el('button', 'adm-btn ghost', 'Remove'); rm.type = 'button';
    rm.addEventListener('click', function () { row.remove(); });
    acts.appendChild(rm);
    row.appendChild(l); row.appendChild(g); row.appendChild(u); row.appendChild(acts);
    return row;
  }
  function paintTiers(tiers) {
    tiersBox.textContent = '';
    (tiers || []).forEach(function (t) { tiersBox.appendChild(tierRow(t)); });
  }
  function readTiers() {
    return Array.prototype.map.call(tiersBox.querySelectorAll('[data-tier]'), function (row) {
      var v = function (k) { return row.querySelector('[data-k="' + k + '"]'); };
      if (v('unlimited').checked) return { level: Number(v('level').value), unlimited: true };
      return { level: Number(v('level').value), grant: Number(v('grant').value) };
    });
  }
  $('invTierAdd').addEventListener('click', function () { tiersBox.appendChild(tierRow(null)); });

  // ── the state ──
  var S = null;
  function paint(d) {
    S = d;
    var st = d.settings;
    $('invSignups').value = st.signups;
    $('invExpiry').value = st.expiry_days;
    $('invWhenOpen').checked = !!st.invites_when_open;
    $('invPrice').value = d.price != null ? d.price : '';
    paintTiers(st.tiers);
    var pill = $('invMode');
    pill.textContent = st.signups === 'invite' ? 'invite-only' : 'open';
    pill.className = 'adm-pill ' + (st.signups === 'invite' ? 'bad' : 'ok');
    var s = d.stats;
    $('invStats').textContent = 'Right now: sign-ups ' + (st.signups === 'invite' ? 'INVITE-ONLY' : 'open') + ' · tiers ' + st.tiers_text +
      ' · ' + fmt(s.pending) + ' pending, ' + fmt(s.used) + ' used, ' + fmt(s.expired) + ' expired, ' + fmt(s.revoked) + ' revoked (' + fmt(s.house) + ' house)' +
      ' · ' + fmt(s.bought) + ' bought, ' + fmt(s.issued) + ' issued by staff' + (d.price != null ? ' · shop price ' + fmt(d.price) + ' PAT' + (d.prize_status && d.prize_status !== 'active' ? ' (' + d.prize_status + ')' : '') : ' · shop item not made yet');
    paintRows(d.invites || []);
    var gl = $('invGrants'); gl.textContent = '';
    if (!(d.grants || []).length) gl.appendChild(el('li', null, 'None yet.'));
    (d.grants || []).forEach(function (g) {
      gl.appendChild(el('li', null, day(g.at) + ' · ' + (g.amount > 0 ? '+' : '') + g.amount + ' to @' + (g.username || '?') + ' · ' +
        (g.kind === 'bought' ? 'bought' : 'issued' + (g.by_name ? ' by @' + g.by_name : '')) + (g.note ? ' · ' + g.note : '')));
    });
    var al = $('invAudit'); al.textContent = '';
    if (!(d.audit || []).length) al.appendChild(el('li', null, 'Nothing yet.'));
    (d.audit || []).forEach(function (a) {
      var what = a.action === 'signups' ? 'sign-ups ' + (a.detail && a.detail.from) + ' → ' + (a.detail && a.detail.to)
        : a.action === 'invite_settings' ? 'settings: ' + Object.keys((a.detail && a.detail.changes) || {}).join(', ')
        : a.action === 'invite_grant' ? 'issued ' + (a.detail && a.detail.amount) + ' to @' + (a.target || '?')
        : a.action === 'invite_house' ? 'house invite #' + (a.detail && a.detail.invite_id)
        : a.action === 'invite_revoke' ? 'revoked #' + (a.detail && a.detail.invite_id) + (a.target ? ' (@' + a.target + ')' : '') : a.action;
      al.appendChild(el('li', null, day(a.at) + ' · @' + (a.admin || '?') + ' · ' + what + (a.reason ? ' · ' + a.reason : '')));
    });
  }
  function paintRows(list) {
    var tb = $('invRows'); tb.textContent = '';
    if (!list.length) { var tr0 = el('tr'); var td0 = el('td', 'adm-help', 'No invites match.'); td0.colSpan = 8; tr0.appendChild(td0); tb.appendChild(tr0); return; }
    list.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num', String(r.id)));
      var code = el('td', 'mono', r.code); if (r.link) code.title = r.link; tr.appendChild(code);
      tr.appendChild(el('td', null, r.house ? 'PATV (house' + (r.inviter ? ', @' + r.inviter : '') + ')' : r.inviter ? '@' + r.inviter : '?'));
      tr.appendChild(el('td', null, r.invitee ? '@' + r.invitee : ''));
      tr.appendChild(el('td', null, r.state));
      tr.appendChild(el('td', null, day(r.created)));
      tr.appendChild(el('td', null, day(r.expires)));
      var act = el('td');
      if (r.state === 'pending') {
        var b = el('button', 'adm-btn ghost', 'Revoke'); b.type = 'button';
        b.addEventListener('click', function () {
          var why = window.prompt('Revoke invite #' + r.id + '? The link stops working and the invite goes back to its owner. Reason (for the log):', '');
          if (why === null) return;
          b.disabled = true;
          api('/api/admin/invites/' + encodeURIComponent(r.id) + '/revoke', { reason: why }).then(load).catch(function (e) { b.disabled = false; window.alert(e.message); });
        });
        act.appendChild(b);
        if (r.link) {
          var c = el('button', 'adm-btn ghost', 'Copy link'); c.type = 'button';
          c.addEventListener('click', function () { if (navigator.clipboard) navigator.clipboard.writeText(r.link).then(function () { c.textContent = 'Copied'; }, function () {}); });
          act.appendChild(c);
        }
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    });
  }
  function load() {
    var q = $('invQ').value.trim(), s = $('invStatus').value;
    return api('/api/admin/invites?q=' + encodeURIComponent(q) + '&status=' + encodeURIComponent(s)).then(paint).catch(function (e) { $('invStats').textContent = e.message; });
  }
  $('invLoad').addEventListener('click', load);

  $('invSave').addEventListener('click', function () {
    var body = { signups: $('invSignups').value, expiry_days: Number($('invExpiry').value), invites_when_open: $('invWhenOpen').checked,
                 tiers: readTiers(), reason: $('invReason').value.trim() };
    if ($('invPrice').value !== '') body.price = Number($('invPrice').value);
    if (S && S.settings.signups !== body.signups &&
        !window.confirm(body.signups === 'invite' ? 'Close sign-ups? New accounts will need an invite from now on.' : 'Open sign-ups? Anyone can make an account again.')) return;
    msg('invMsg', 'Saving…');
    api('/api/admin/invites/settings', body).then(function (d) {
      msg('invMsg', d.changed && d.changed.length ? 'Saved: ' + d.changed.join(', ') + '.' : 'Nothing changed.');
      $('invReason').value = '';
      return load();
    }).catch(function (e) { msg('invMsg', e.message, true); });
  });

  $('invGrant').addEventListener('click', function () {
    var u = $('invGrantUser').value.trim(), n = $('invGrantN').value, why = $('invGrantWhy').value.trim();
    if (!u) { $('invGrantUser').focus(); return; }
    msg('invGrantMsg', 'Issuing…');
    api('/api/admin/invites/grant', { username: u, amount: Number(n), reason: why }).then(function (d) {
      msg('invGrantMsg', (d.amount > 0 ? 'Issued ' + d.amount : 'Took back ' + (-d.amount)) + ' for @' + d.username + ' (staff-issued total ' + d.admin_total + ').');
      $('invGrantWhy').value = '';
      return load();
    }).catch(function (e) { msg('invGrantMsg', e.message, true); });
  });

  $('invHouse').addEventListener('click', function () {
    var why = $('invHouseWhy').value.trim();
    if (!why) { $('invHouseWhy').focus(); return; }
    msg('invHouseMsg', 'Making…');
    api('/api/admin/invites/house', { reason: why }).then(function (d) {
      msg('invHouseMsg', 'Made invite #' + d.invite.id + ' - copy the link below.');
      var out = $('invHouseOut'); out.hidden = false; out.textContent = d.invite.link;
      $('invHouseWhy').value = '';
      return load();
    }).catch(function (e) { msg('invHouseMsg', e.message, true); });
  });

  load();
})();
