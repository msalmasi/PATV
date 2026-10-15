// twitch-btn.js — 🟣 Pepe's Twitch relay switch on his stream's player, admins only (1.99aal; restream.js). Like the
// ⚡ Low latency button: a small pill in the player's corner, shown only while the player shows Pepe's own stream.
// State from GET /api/restream/admin/main (live / starting / error / off / waiting for Pepe's stream); a click flips the
// same switch as /stage/admin's "Pepe's main stream" toggle (POST /api/restream/admin/main/toggle, audited). The server
// refuses non-admins (403) - then this script switches itself off for the page. Emergency stop stays systemctl on the VPS.
// 1.99aan: it AUTO-HIDES like ⚡ Low latency (stage-lowlat.js): fades out after the player's inactivity delay (video.js's
// inactivityTimeout, 2 s), comes back on mouse / touch / focus in the player, stays while hovered / focused / the video is
// paused, and pops up for NOTE_MS whenever the relay's state changes (off -> live, an error...).
(function () {
  'use strict';
  var NOTE_MS = 6000;
  var state = null, dead = false, btn = null, box = null, wantShown = false, busy = false, timer = null;
  var act = { hover: false, focus: false, pinUntil: 0, hideT: null, last: '' };
  var vjsOpts = window.videojs && window.videojs.options;
  var DELAY = (vjsOpts && Number(vjsOpts.inactivityTimeout)) || 2000;
  function label(m) {
    if (!m) return '🟣 Twitch …';
    if (!m.dest) return '🟣 Twitch: no key';
    var s = (m.status && m.status.state) || 'off';
    if (!m.on) return '🟣 Twitch: off';
    if (!m.live) return '🟣 Twitch: on (waits for the stream)';
    return s === 'live' ? '🟣 Twitch: LIVE' : s === 'error' ? '🟣 Twitch: error' : '🟣 Twitch: ' + s;
  }
  function paused() {
    try { var v = box && box.querySelector('video'); return !!(v && v.paused); } catch (e) { return false; }
  }
  function idleNow() { return !(act.hover || act.focus || Date.now() < act.pinUntil || paused()); }
  function wake(ms) {                       // show now, hide again after the delay unless something keeps it up
    if (!btn) return;
    btn.classList.remove('idle');
    clearTimeout(act.hideT);
    act.hideT = setTimeout(function check() {
      if (idleNow()) btn.classList.add('idle');
      else act.hideT = setTimeout(check, 500);
    }, Math.max(DELAY, ms || 0));
  }
  function paint() {
    if (!btn) return;
    btn.hidden = dead || !wantShown || !state;
    if (btn.hidden) return;
    var m = state.main || {};
    var text = label(m);
    btn.textContent = text;
    btn.setAttribute('aria-pressed', m.on ? 'true' : 'false');
    var idle = btn.classList.contains('idle');
    btn.className = 'twbtn' + (m.on ? ' on' : '') + (m.on && m.status && m.status.state === 'error' ? ' err' : '') + (idle ? ' idle' : '');
    btn.title = (m.on ? 'Pepe’s Twitch relay is ON - click to switch it off' : 'Pepe’s Twitch relay is off - click to switch it on') +
      (m.status && m.status.detail ? ' (' + m.status.detail + ')' : '') + ' · admins only';
    btn.disabled = busy || !m.dest;
    if (text !== act.last) {                 // a state change pops it up (like a low-latency fallback note)
      act.last = text;
      act.pinUntil = Date.now() + NOTE_MS;
      wake(NOTE_MS);
    }
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
        if (btn.classList.contains('idle')) { wake(); return; }      // a tap that only woke the controls never toggles
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
      btn.addEventListener('mouseenter', function () { act.hover = true; wake(); });
      btn.addEventListener('mouseleave', function () { act.hover = false; wake(); });
      btn.addEventListener('focus', function () { act.focus = true; wake(); });
      btn.addEventListener('blur', function () { act.focus = false; wake(); });
      var css = document.createElement('style');
      css.textContent = '.twbtn{opacity:1;transition:opacity .15s ease}.twbtn.idle{opacity:0;pointer-events:none;transition-duration:1s}' +
        '.twbtn.idle:focus-visible{opacity:1;pointer-events:auto}' +
        '.twbtn.on{background:#9146ff !important;color:#fff !important}.twbtn.err{background:#b3261e !important;border-color:#b3261e !important;color:#fff !important}.twbtn[hidden]{display:none}';
      document.head.appendChild(css);
    }
    if (where && btn.parentNode !== where) {
      if (getComputedStyle(where).position === 'static') where.style.position = 'relative';
      where.appendChild(btn);
      ['mousemove', 'touchstart', 'focusin'].forEach(function (ev) {
        where.addEventListener(ev, function (e) { if (e.target !== btn) wake(); }, { passive: true });
      });
    }
  }
  window.PATVTwitchBtn = {
    /** stage-room.js on every view change: `pepe` = the player shows Pepe's own stream now. */
    sync: function (where, pepe) {
      if (dead) return;
      var was = wantShown;
      box = where; wantShown = !!pepe;
      make(box);
      if (!state) load();
      if (!timer) timer = setInterval(function () { if (!document.hidden && wantShown) load(); }, 15000);
      paint();
      if (wantShown && !was) wake();
    },
  };
})();
