// restream.js (client) — 🟣 "Also stream to Twitch" cards (1.99fk).
//   <section id="rsCard" data-mode="me">     /stage: my saved Twitch key (masked), my open slot's toggle + status
//   <section id="rsCard" data-mode="admin">  /stage/admin: Pepe's main stream (key, toggle, status) + every relay
// The key is only ever sent (on save), never read back: the server returns ••••last4.
(function () {
  'use strict';
  var card = document.getElementById('rsCard');
  if (!card) return;
  var mode = card.getAttribute('data-mode');
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  function get(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  // "🟣 Twitch: live · 5,980 kbps" / starting / error (reason) / off
  function badge(st, on) {
    st = st || { state: 'off' };
    var s = st.state;
    var txt = s === 'live' ? 'live' + (st.kbps ? ' · ' + fmt(st.kbps) + ' kbps' : '')
      : s === 'starting' ? 'starting…' : s === 'stopping' ? 'stopping…'
      : s === 'error' ? 'error' + (st.detail ? ' (' + st.detail + ')' : '') + (st.restarts ? ' · retrying' : '')
      : on ? 'waits for you to go live' : 'off';
    return '<span class="rs-badge rs-' + esc(s) + '">🟣 Twitch: ' + esc(txt) + '</span>' + (st.warn ? ' <span class="rs-warn">⚠ ' + esc(st.warn) + '</span>' : '');
  }
  function toggle(id, on, disabled, label) {
    return '<label class="chk rs-tog"><input type="checkbox" data-rs-toggle="' + esc(id) + '"' + (on ? ' checked' : '') + (disabled ? ' disabled' : '') + '> ' + esc(label) + '</label>';
  }
  function destLine(d) {
    return d ? 'Saved key <b>' + esc(d.key) + '</b> · <code>' + esc(d.server) + '</code>' : '<span class="muted">No Twitch key saved.</span>';
  }
  function fillForm(f, d) {
    if (!f) return;
    f.key.value = '';
    f.key.placeholder = d ? 'leave blank to keep ' + d.key : 'live_…';
    if (f.server && document.activeElement !== f.server) f.server.value = d && d.server !== DEF ? d.server : '';
    if (f.auto) f.auto.checked = !!(d && d.auto);
    var del = f.querySelector('[data-rs-del]');
    if (del) del.classList.toggle('hide', !d);
  }
  var DEF = 'rtmp://live.twitch.tv/app';
  var formFilled = false;

  // ── /stage ──
  function renderMe(j) {
    DEF = j.defaultServer || DEF;
    if (!j.configured) { $('rsBody').innerHTML = '<p class="muted">Restreaming isn\'t set up on this server yet.</p>'; return; }
    $('rsSaved').innerHTML = destLine(j.dest);
    if (!formFilled) { fillForm($('rsForm'), j.dest); formFilled = true; }
    var rows = (j.slots || []).map(function (s) {
      if (s.block) return '<p class="muted">Your slot: ' + esc(s.block) + '.</p>';
      return '<div class="rs-row">' + toggle(s.id, s.on, !j.dest, 'Also stream this slot to Twitch') + ' ' + badge(s.status, s.on) + '</div>';
    });
    $('rsSlots').innerHTML = rows.length ? rows.join('') : '<p class="muted">When you have a slot open, its Twitch switch shows here (it starts ' + (j.dest && j.dest.auto ? 'ON' : 'off') + ').</p>';
  }
  // ── /stage/admin ──
  function renderAdmin(j) {
    DEF = j.defaultServer || DEF;
    var m = j.main || {};
    var w = j.worker || {};
    $('rsWorker').innerHTML = w.up ? 'Relay service: <b>running</b>' + (w.version ? ' (' + esc(w.version) + ')' : '')
      : '<b class="rs-warn">Relay service isn\'t reporting</b> - <code>systemctl status patv-restream@…</code>';
    if (!j.configured) $('rsWorker').innerHTML += ' · <b class="rs-warn">RESTREAM_SECRET missing</b>';
    $('rsMain').innerHTML = !m.available ? '<p class="muted">This site has no main stream to relay (staging).</p>'
      : '<p>' + destLine(m.dest) + '</p><div class="rs-row">' + toggle('main', m.on, !m.dest || !j.isAdmin, 'Relay Pepe\'s stream to Twitch') + ' ' +
        badge(m.status, m.on) + (m.on && !m.live ? ' <span class="muted">(Pepe is off air)</span>' : '') + '</div>';
    if (!formFilled && $('rsForm')) { fillForm($('rsForm'), m.dest); formFilled = true; }
    var s = j.slots || [];
    $('rsRows').innerHTML = s.length ? s.map(function (x) {
      return '<tr><td><a href="/u/' + encodeURIComponent(x.username) + '">' + esc(x.display) + '</a><br><span class="muted">' + esc(x.room_id || '') + '</span></td>' +
        '<td>' + (x.dest ? esc(x.dest.key) : '–') + '</td><td>' + (x.block ? '<span class="muted">' + esc(x.block) + '</span>' : badge(x.status, x.on)) + '</td>' +
        '<td>' + (x.on ? '<button type="button" class="btn danger" data-rs-off="' + esc(x.id) + '">Turn off</button>' : '') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">No streamer relays right now (' + fmt(j.saved) + ' streamer key' + (j.saved === 1 ? '' : 's') + ' saved).</td></tr>';
  }

  var API = mode === 'admin' ? '/api/restream/admin' : '/api/restream/me';
  function load() {
    return get(API).then(function (j) { if (j && j.ok) (mode === 'admin' ? renderAdmin : renderMe)(j); }).catch(function () {});
  }
  load();
  setInterval(load, 4000);

  var destUrl = mode === 'admin' ? '/api/restream/admin/main/dest' : '/api/restream/me/dest';
  var delUrl = mode === 'admin' ? '/api/restream/admin/main/delete' : '/api/restream/me/delete';
  var f = $('rsForm');
  if (f) f.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { key: f.key.value.trim(), server: f.server.value.trim() };
    if (f.auto) body.auto = f.auto.checked;
    $('rsMsg').textContent = 'Saving…';
    post(destUrl, body).then(function (j) {
      $('rsMsg').textContent = j.ok ? 'Saved - the key is stored encrypted and won\'t be shown again.' : (j.error || 'Could not save.');
      if (j.ok) { formFilled = false; f.key.value = ''; load(); }
    });
  });
  card.addEventListener('click', function (e) {
    var b = e.target.closest('[data-rs-del],[data-rs-off]');
    if (!b) return;
    if (b.hasAttribute('data-rs-del')) {
      if (!confirm('Delete the saved Twitch key? Any relay using it stops.')) return;
      post(delUrl, {}).then(function (j) { $('rsMsg').textContent = j.ok ? 'Deleted.' : (j.error || 'Could not delete.'); formFilled = false; load(); });
    } else {
      b.disabled = true;
      post('/api/restream/admin/slot/' + encodeURIComponent(b.getAttribute('data-rs-off').replace(/^slot:/, '')) + '/off', {}).then(load);
    }
  });
  card.addEventListener('change', function (e) {
    var t = e.target;
    if (!t.hasAttribute || !t.hasAttribute('data-rs-toggle')) return;
    var id = t.getAttribute('data-rs-toggle');
    var url = id === 'main' ? '/api/restream/admin/main/toggle' : '/api/restream/slot/' + encodeURIComponent(id) + '/toggle';
    t.disabled = true;
    post(url, { on: t.checked }).then(function (j) {
      t.disabled = false;
      if (!j.ok) { t.checked = !t.checked; alert(j.error || 'Could not switch it.'); }
      load();
    });
  });
})();
