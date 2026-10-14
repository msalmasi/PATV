// admin-bridgebans.js (1.99zf) - Users & Accounts → "Web bridge restrictions (one member)": look up an account, tick the web
// bridge features it can't use in EVERY room (bridgeblocks.js global rows, one per feature), with a length and a reason; untick
// to lift. GET/POST /api/admin/bridge/blocks (site Admins; admin_audit "bridge_block"). Text via textContent only.
(function () {
  'use strict';
  var form = document.getElementById('bbUserForm');
  if (!form) return;
  var $ = function (id) { return document.getElementById(id); };
  var LABEL = { all: 'Everything (all of the below)', chat: 'Chat (relay lines)', commands: 'Commands + the Pepe menu', soundboard: 'Soundboard',
    voice: 'Voice clips (push-to-talk)', snapshots: 'Cam snapshots', livecams: 'Live cams', clips: 'Cam + mic clips' };
  var state = null;      // {target, blocks, features}
  function msg(t, bad) { var m = $('bbMsg'); m.textContent = t || ''; m.className = 'adm-msg' + (t ? (bad ? ' err' : ' ok') : ''); }
  function utc(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.headers['x-requested-with'] = 'fetch'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  function draw() {
    var list = $('bbFeatList'); list.textContent = '';
    var glob = {};
    (state.blocks || []).forEach(function (b) { if (b.global) glob[b.feature || 'all'] = b; });
    (state.features || Object.keys(LABEL)).forEach(function (f) {
      var lab = document.createElement('label'); lab.className = 'ck';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.name = 'f'; cb.value = f; cb.checked = !!glob[f];
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + (LABEL[f] || f)));
      var b = glob[f];
      if (b) {
        var st = document.createElement('span'); st.className = 'adm-msg';
        st.textContent = ' - ' + (b.until ? 'until ' + utc(b.until) : 'until lifted') + (b.reason ? ' · ' + b.reason : '') + (b.by ? ' · by ' + b.by : '');
        lab.appendChild(st);
      }
      list.appendChild(lab);
    });
    var rooms = $('bbRooms'); rooms.textContent = '';
    (state.blocks || []).filter(function (b) { return !b.global; }).forEach(function (b) {
      var li = document.createElement('li');
      li.textContent = 'Room ' + b.room + ': ' + (LABEL[b.feature] || b.feature) + ' - ' + (b.until ? 'until ' + utc(b.until) : 'until lifted') + (b.reason ? ' · ' + b.reason : '') + (b.by ? ' · by ' + b.by : '') + ' ';
      var x = document.createElement('button'); x.type = 'button'; x.className = 'adm-btn ghost'; x.textContent = 'Lift';
      x.addEventListener('click', function () {
        x.disabled = true;
        api('/api/admin/bridge/blocks', { op: 'unblock', room: b.room, target: 'u:' + state.target.userId, feature: b.feature })
          .then(function (j) { state.blocks = j.blocks || []; draw(); msg('Lifted in ' + b.room + '.'); }, function (e) { x.disabled = false; msg(e.message, true); });
      });
      li.appendChild(x);
      rooms.appendChild(li);
    });
    $('bbFeats').hidden = false;
  }
  function look() {
    var u = $('bbUser').value.trim();
    if (!u) return;
    msg('Looking up…');
    api('/api/admin/bridge/blocks?target=' + encodeURIComponent(u)).then(function (j) {
      state = { target: j.target, blocks: j.blocks || [], features: j.features };
      msg(j.target.username + (j.target.login ? ' (chat ' + j.target.login + ')' : '') + ': ' + ((j.blocks || []).length ? (j.blocks.length + ' active block(s)') : 'no bridge blocks'));
      draw();
    }, function (e) { state = null; $('bbFeats').hidden = true; msg(e.message, true); });
  }
  $('bbLook').addEventListener('click', look);
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!state) return look();
    var want = [], had = {};
    (state.blocks || []).forEach(function (b) { if (b.global) had[b.feature || 'all'] = true; });
    Array.prototype.forEach.call(form.querySelectorAll('input[name="f"]'), function (cb) { if (cb.checked) want.push(cb.value); });
    var lift = Object.keys(had).filter(function (f) { return want.indexOf(f) < 0; });
    var who = 'u:' + state.target.userId, hours = $('bbHours').value, reason = $('bbReason').value.trim();
    msg('Saving…');
    var p = Promise.resolve(null);
    if (lift.length) p = p.then(function () { return api('/api/admin/bridge/blocks', { op: 'unblock', room: '', target: who, features: lift }); });
    // the ticked ones are (re)applied with this length + reason
    if (want.length) p = p.then(function () { return api('/api/admin/bridge/blocks', { op: 'block', room: '', target: who, features: want, hours: hours, reason: reason }); });
    p.then(function (j) {
      if (j) state.blocks = j.blocks || [];
      msg('Saved: ' + (want.length ? want.map(function (f) { return LABEL[f] || f; }).join(', ') + ' blocked' : 'no bridge restrictions') + (lift.length ? '; lifted ' + lift.join(', ') : '') + '.');
      draw();
    }, function (e) { msg(e.message, true); });
  });
})();
