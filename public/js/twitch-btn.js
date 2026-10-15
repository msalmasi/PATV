// twitch-btn.js — 🟣 Pepe's Twitch relay switch on his stream's player, admins only (1.99aal; restream.js). Like the
// ⚡ Low latency button: a small pill in the player's corner, shown only while the player shows Pepe's own stream.
// State from GET /api/restream/admin/main (live / starting / error / off / waiting for Pepe's stream); a click flips the
// same switch as /stage/admin's "Pepe's main stream" toggle (POST /api/restream/admin/main/toggle, audited). The server
// refuses non-admins (403) - then this script switches itself off for the page. Emergency stop stays systemctl on the VPS.
(function () {
  'use strict';
  var state = null, dead = false, btn = null, box = null, wantShown = false, busy = false, timer = null;
  function label(m) {
    if (!m) return '🟣 Twitch …';
    if (!m.dest) return '🟣 Twitch: no key';
    var s = (m.status && m.status.state) || 'off';
    if (!m.on) return '🟣 Twitch: off';
    if (!m.live) return '🟣 Twitch: on (waits for the stream)';
    return s === 'live' ? '🟣 Twitch: LIVE' : s === 'error' ? '🟣 Twitch: error' : '🟣 Twitch: ' + s;
  }
  function paint() {
    if (!btn) return;
    btn.hidden = dead || !wantShown || !state;
    if (btn.hidden) return;
    var m = state.main || {};
    btn.textContent = label(m);
    btn.setAttribute('aria-pressed', m.on ? 'true' : 'false');
    btn.className = 'twbtn' + (m.on ? ' on' : '') + (m.on && m.status && m.status.state === 'error' ? ' err' : '');
    btn.title = (m.on ? 'Pepe’s Twitch relay is ON - click to switch it off' : 'Pepe’s Twitch relay is off - click to switch it on') +
      (m.status && m.status.detail ? ' (' + m.status.detail + ')' : '') + ' · admins only';
    btn.disabled = busy || !m.dest;
  }
  function load() {
    if (dead) return;
    fetch('/api/restream/admin/main', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (r.status === 401 || r.status === 403) { dead = true; paint(); return null; }
      return r.json();
    }).then(function (j) { if (j && j.ok) { state = j; paint(); } }).catch(function () { /* next poll */ });
  }
  function make(where) {
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.hidden = true;
      btn.style.cssText = 'position:absolute;top:8px;left:8px;z-index:6;min-height:30px;padding:0 10px;border-radius:999px;font:12.5px var(--ds-font, sans-serif);' +
        'border:1px solid #9146ff;background:rgba(0,0,0,.7);color:#e5d9ff;cursor:pointer';
      btn.addEventListener('click', function () {
        var m = state && state.main;
        if (!m || busy) return;
        if (m.on && !window.confirm('Switch Pepe’s Twitch relay OFF?')) return;
        busy = true; paint();
        fetch('/api/restream/admin/main/toggle', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ on: !m.on }) })
          .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
          .then(function (j) {
            busy = false;
            if (j && j.ok) state.main = j.main; else window.alert((j && j.error) || 'Couldn’t switch it.');
            paint();
          }).catch(function () { busy = false; paint(); });
      });
      var css = document.createElement('style');
      css.textContent = '.twbtn.on{background:#9146ff;color:#fff}.twbtn.err{background:#b3261e;border-color:#b3261e;color:#fff}.twbtn[hidden]{display:none}';
      document.head.appendChild(css);
    }
    if (where && btn.parentNode !== where) {
      if (getComputedStyle(where).position === 'static') where.style.position = 'relative';
      where.appendChild(btn);
    }
  }
  window.PATVTwitchBtn = {
    /** stage-room.js on every view change: `pepe` = the player shows Pepe's own stream now. */
    sync: function (where, pepe) {
      if (dead) return;
      box = where; wantShown = !!pepe;
      make(box);
      if (!state) load();
      if (!timer) timer = setInterval(function () { if (!document.hidden && wantShown) load(); }, 15000);
      paint();
    },
  };
})();
