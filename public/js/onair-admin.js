// onair-admin.js — /stage/admin "📺 On Pepe's OBS" card (1.99yt POC, onair.js): put one live slot or cam on Pepe's main
// stream (+ his Camfrog cam), take it off, the kill switch + settings, the log. Admins only (the server checks too).
(function () {
  'use strict';
  var card = document.getElementById('oaCard');
  if (!card) return;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var when = function (ms) { if (!ms) return '–'; var d = new Date(Number(ms)); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  var WHY = {};
  var cfgFilled = false;
  function post(body) {
    return fetch('/api/stage/admin/onair', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  function load() {
    return fetch('/api/stage/admin/onair', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) render(j); else $('oaNow').textContent = (j && j.error) || 'Could not load.'; })
      .catch(function () { $('oaNow').textContent = 'Could not load.'; });
  }
  function pepeLine(P) {
    if (!P || !P.online) return ' <span class="muted">Pepe hasn\'t checked in (is he running with OBS?).</span>';
    var s = P.state || {};
    var bits = [];
    bits.push('OBS ' + esc(s.obs || '?'));
    if (s.irl) bits.push('<b>the IRL feed is live - it wins, the pick is hidden</b>');
    else if (s.shown) bits.push('showing it');
    if (s.scene) bits.push('scene ' + esc(s.scene) + (s.switched_from ? ' (switched from ' + esc(s.switched_from) + ')' : ''));
    if (s.cam) bits.push('cam ' + esc(s.cam));
    bits.push(s.irl_watch === 'on' ? 'IRL auto-switch watching' + (s.irl_switched_from ? ' (switched from ' + esc(s.irl_switched_from) + ')' : '')
      : s.irl_watch === 'setup' ? '<b>IRL auto-switch needs !onair setup irl</b>' : 'IRL auto-switch off');
    if (!s.source_ok) bits.push('<b>no on-air source in OBS - run !onair setup</b>');
    if (s.err) bits.push('<span class="rs-warn">⚠ ' + esc(s.err) + '</span>');
    return ' <span class="muted">Pepe: ' + bits.join(' · ') + '.</span>';
  }
  function render(j) {
    WHY = j.why || WHY;
    var C = j.cfg || {}, T = j.target;
    $('oaNow').innerHTML = (!C.enabled ? '<b>Switched OFF</b> - nothing goes on Pepe\'s OBS.'
      : T ? 'On Pepe\'s main stream: <b>' + esc(T.label) + '</b> since ' + esc(when(T.at)) + ' (by ' + esc(T.by) + ').'
      : 'Nothing is on Pepe\'s main stream.') + pepeLine(j.pepe);
    $('oaOff').disabled = !T;
    var pick = function (attrs, why, onNow) {
      if (onNow) return '<span class="muted">on air</span>';
      if (why) return '<span class="muted">' + esc(WHY[why] || why) + '</span>';
      return '<button type="button" class="btn" ' + attrs + (C.enabled ? '' : ' disabled') + '>📺 Put on Pepe\'s OBS</button>';
    };
    $('oaSlots').innerHTML = (j.slots || []).map(function (s) {
      var on = T && T.kind === 'slot' && T.slot_id === s.id;
      return '<tr><td>' + esc(s.display) + (s.title ? ' <span class="muted">' + esc(s.title) + '</span>' : '') + (s.library ? ' 📼' : '') + '</td><td>' + esc(s.pad) +
        '</td><td>' + pick('data-oa-slot="' + esc(s.id) + '"', s.why, on) + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">No live slots.</td></tr>';
    $('oaCams').innerHTML = (j.cams || []).map(function (c) {
      var on = T && T.kind === 'cam' && T.room === c.room && T.login === c.login;
      return '<tr><td>' + esc(c.display) + (c.display !== c.login ? ' <span class="muted">' + esc(c.login) + '</span>' : '') + '</td><td>' + esc(c.roomName) +
        '</td><td>' + pick('data-oa-room="' + esc(c.room) + '" data-oa-login="' + esc(c.login) + '"', c.why, on) + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">Nobody is on cam in a live bridged room.</td></tr>';
    $('oaLog').innerHTML = (j.log || []).map(function (r) {
      return '<tr><td>' + esc(when(r.at)) + '</td><td>' + esc(r.what) + '</td><td>' + esc(r.by) + '</td><td>' + esc(r.label || r.ref || '') + '</td><td>' + esc(r.detail || '') + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">Nothing yet.</td></tr>';
    var f = $('oaCfg');
    if (f && !cfgFilled) {
      cfgFilled = true;
      ['enabled', 'cam_optin', 'allow_library', 'auto_scene', 'irl_switch'].forEach(function (k) { if (f[k]) f[k].checked = !!C[k]; });
      ['scene', 'irl_scene', 'irl_source', 'source', 'cam_fps', 'cam_kbps', 'irl_from'].forEach(function (k) { if (f[k]) f[k].value = C[k] == null ? '' : C[k]; });
    }
  }
  function act(body, msgEl) {
    var m = $(msgEl || 'oaMsg');
    m.textContent = 'Working…';
    return post(body).then(function (j) {
      if (!j.ok) { m.textContent = j.error || 'Could not do that.'; return; }
      m.textContent = 'Done - Pepe picks it up within a few seconds.';
      render(j);
    }).catch(function () { m.textContent = 'Could not reach the site.'; });
  }
  card.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.id === 'oaOff') return act({ action: 'off' });
    if (b.hasAttribute('data-oa-slot')) return act({ action: 'slot', slot_id: b.getAttribute('data-oa-slot') });
    if (b.hasAttribute('data-oa-login')) return act({ action: 'cam', room: b.getAttribute('data-oa-room'), login: b.getAttribute('data-oa-login') });
  });
  $('oaCfg').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, cfg = {};
    ['enabled', 'cam_optin', 'allow_library', 'auto_scene', 'irl_switch'].forEach(function (k) { cfg[k] = !!f[k].checked; });
    ['scene', 'irl_scene', 'irl_source', 'source', 'irl_from'].forEach(function (k) { cfg[k] = f[k].value.trim(); });
    ['cam_fps', 'cam_kbps'].forEach(function (k) { cfg[k] = Number(f[k].value); });
    act({ action: 'config', cfg: cfg }, 'oaCfgMsg');
  });
  load();
  setInterval(function () { if (!document.hidden) load(); }, 10000);
})();
