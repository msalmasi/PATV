// /stage — the "Go live" hub (1.99bi): book a slot on a room's stage now / later / in the queue, the
// live status of your open slot, your upcoming bookings, and streaming from the browser.
// Browser mode: MediaRecorder (1 s WebM chunks) -> POST /api/stage/slots/:id/relay?seq=N, one at a
// time and in order; the server pipes them through ffmpeg into the stage. Out of order / relay gone
// -> restart the recorder from chunk 0 (a fresh WebM header).
(function () {
  'use strict';
  var root = document.getElementById('sb');
  if (!root || root.getAttribute('data-signed') !== '1') return;
  var PRICE = Number(root.getAttribute('data-price')) || 0;
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var mmss = function (s) { s = Math.max(0, Math.floor(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  var when = function (ms) { var d = new Date(Number(ms)); return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  var KEY_STORE = 'stageKey:';
  var slot = null, polling = null, roomState = null, whenTouched = false;

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  function show(id, on) { $(id).classList.toggle('hide', !on); }
  function radio(name) { var r = document.querySelector('input[name=' + name + ']:checked'); return r ? r.value : null; }
  function setRadio(name, v) { var r = document.querySelector('input[name=' + name + '][value=' + v + ']'); if (r) { r.checked = true; } }
  function roomOpt(idOrSlug) {
    var opts = $('room').options;
    for (var i = 0; i < opts.length; i++) if (opts[i].value === idOrSlug || opts[i].getAttribute('data-id') === idOrSlug) return opts[i];
    return null;
  }
  function roomTitle(id) { var o = roomOpt(id); return o ? o.getAttribute('data-title') : id; }
  // featuring is never sold (1.99ee; old ?feature=1 links just open the page) - pads are 🚀 boosted instead

  // ── booking form ──
  var mins = $('mins'), minsR = $('minsR');
  function price() {
    var o = $('room').selectedOptions[0];
    return o ? Number(o.getAttribute('data-price')) || 0 : 0;
  }
  // "Use my Twitch channel" (only rendered for a signed-in user with a connected Twitch account)
  var twOffered = false;
  function twNoteOn(on) { if ($('twNote')) $('twNote').classList.toggle('hide', !on); }
  if ($('twChip')) {
    twNoteOn(false);
    $('twChip').addEventListener('click', function () {
      $('embed').value = $('twChip').getAttribute('data-url'); twNoteOn(true); $('embed').focus();
    });
    $('embed').addEventListener('input', function () { twNoteOn($('embed').value === $('twChip').getAttribute('data-url')); });
  }
  function formCalc() {
    var o = $('room').selectedOptions[0], sp = o ? Number(o.getAttribute('data-price')) || 0 : 0;
    $('slotPriceTxt').textContent = sp ? fmt(sp) + ' PAT / live min in this pad' : 'free in this pad';
    $('holdAmt').textContent = fmt((Number(mins.value) || 0) * price());
    var w = radio('when'), embed = radio('mode') === 'embed';
    show('embedFld', embed); show('atFld', w === 'later');
    if ($('twSug')) {
      show('twSug', embed);
      // the first time they pick "A video link", an empty field gets their own Twitch channel; after that
      // it's theirs - clearing it doesn't bring it back (the chip does)
      if (embed && !twOffered) { twOffered = true; if (!$('embed').value.trim()) { $('embed').value = $('twChip').getAttribute('data-url'); twNoteOn(true); } }
    }
    $('bookBtn').textContent = w === 'later' ? '📅 Book this time' : w === 'queue' ? '⏳ Join the queue' : (embed ? '▶ Put it on now' : '🎥 Go live now');
  }
  mins.addEventListener('input', function () { minsR.value = mins.value; formCalc(); });
  minsR.addEventListener('input', function () { mins.value = minsR.value; formCalc(); });
  document.querySelectorAll('#bookForm input[type=radio]').forEach(function (r) { r.addEventListener('change', formCalc); });
  document.querySelectorAll('input[name=when]').forEach(function (r) { r.addEventListener('change', function () { whenTouched = true; }); });
  $('room').addEventListener('change', function () { whenTouched = false; setRadio('when', 'now'); formCalc(); refresh(); });
  (function () {           // the time picker: from the next quarter hour, within the booking window
    var d = new Date(Date.now() + 20 * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var loc = function (x) { return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) + 'T' + pad(x.getHours()) + ':' + pad(x.getMinutes()); };
    $('at').value = loc(d); $('at').min = loc(new Date());
    var days = Number(root.getAttribute('data-days')) || 14;
    $('at').max = loc(new Date(Date.now() + days * 86400000));
  })();
  formCalc();

  $('bookForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var m = Number(mins.value), w = radio('when'), mode = radio('mode');
    if (mode === 'plex') return;                     // 1.99jn: 📼 Play from Plex has its own panel (stage-plex.js)
    var body ={ room: $('room').value, minutes: m, mode: mode, embed: $('embed').value, title: $('title').value };
    if (mode === 'embed' && !$('embed').value.trim()) { $('bookMsg').textContent = 'Paste a YouTube or Twitch link.'; return; }
    var hold = m * price();
    var url = '/api/stage/book';
    if (w === 'later') {
      var at = new Date($('at').value).getTime();
      if (!at || at < Date.now() + 60000) { $('bookMsg').textContent = 'Pick a start time in the future.'; return; }
      body.start_at = at;
    } else if (w === 'queue') url = '/api/stage/queue';
    var q = w === 'queue' ? 'Join the queue for a ' + m + '-minute slot? When a slot frees up it\'s booked for you' + (hold ? ' and ' + fmt(hold) + ' PAT is held then' : '') + '.'
      : (hold ? 'Hold ' + fmt(hold) + ' PAT for a ' + m + '-minute slot? You pay only for the minutes you\'re live; the rest comes back.'
              : 'Book a free ' + m + '-minute slot' + (w === 'later' ? ' at ' + when(body.start_at) : ' now') + '?');
    if (!confirm(q)) return;
    $('bookBtn').disabled = true; $('bookMsg').textContent = 'Booking…';
    post(url, body).then(function (j) {
      $('bookBtn').disabled = false;
      if (!j.ok) {
        $('bookMsg').textContent = j.error || 'Could not book.';
        if (/queue/i.test(j.error || '') && w === 'now') { setRadio('when', 'queue'); formCalc(); }
        return;
      }
      if (w === 'queue') $('bookMsg').textContent = 'You\'re #' + j.position + ' in the queue - we\'ll tell you (inbox + Pepe) when you\'re up.';
      else if (j.slot && (j.slot.status === 'requested')) $('bookMsg').textContent = 'Requested - the pad\'s owner approves it. Your hold comes back if they don\'t.';
      else if (j.slot && j.slot.status === 'scheduled') $('bookMsg').textContent = 'Booked for ' + when(j.slot.start_at) + '. Your key works from a few minutes before.';
      else $('bookMsg').textContent = '';
      if (j.key && j.slot) { try { sessionStorage.setItem(KEY_STORE + j.slot.id, j.key); } catch (x) {} }
      refresh();
    }).catch(function () { $('bookBtn').disabled = false; $('bookMsg').textContent = 'Could not reach the server.'; });
  });

  // ── status ──
  var REASONS = { owner_ended: 'you ended it', time_up: 'your time ran out', never_live: "it never went live, so you got everything back",
    idle: 'the stream was off air too long', cut: 'it was cut back to Pepe', banned: 'an admin or the pad owner cut it', deadline: 'it reached its deadline',
    restart: 'it timed out while the site restarted', cancelled: 'you cancelled it', denied: 'the pad owner declined it', not_approved: "it wasn't approved in time",
    no_room: 'no slot was free at its start' };
  function render(d) {
    if (d.balance != null) $('bal').textContent = fmt(d.balance);
    roomState = d.room;
    if (d.room) {
      var R = d.room, bits = [];
      bits.push('🎬 ' + R.open + '/' + R.room.slot_count + ' slot' + (R.room.slot_count === 1 ? '' : 's') + ' in use');
      if (R.featured) bits.push('★ featured: ' + R.featured.display);
      if (R.queue.length) bits.push(R.queue.length + ' in the queue');
      if (R.room.approval) bits.push('bookings for later need the owner\'s OK');
      if (R.upcoming.length) bits.push('next booking ' + when(R.upcoming[0].start_at));
      $('roomInfo').textContent = bits.join(' · ');
      $('nowTxt').textContent = R.free > 0 ? 'a slot is free' : 'all slots busy';
      if (R.free < 1 && !whenTouched && radio('when') === 'now') { setRadio('when', 'queue'); formCalc(); }
      $('queueTxt').textContent = R.queue.length ? R.queue.length + ' waiting' : 'next free slot';
    }
    if (d.banned) $('roomInfo').textContent = 'You can\'t book this pad\'s stage.';
    var list = d.slots || [];
    var s = list.find ? list.find(function (x) { return x.status === 'waiting' || x.status === 'active'; }) : null;
    show('slotCard', !!s);
    var last = d.slot && d.slot.status === 'ended' ? d.slot : null;
    show('doneCard', !s && !!last && last.ended && Date.now() - last.ended < 30 * 60000);
    if (!s && last) {
      $('doneTxt').innerHTML = 'Ended - ' + esc(REASONS[last.end_reason] || last.end_reason || 'ended') + '. Live <b>' + mmss(last.live_seconds) + '</b>, charged <b>' +
        fmt(last.charged) + '</b> PAT, refunded <b>' + fmt(last.refunded) + '</b> PAT.';
      if (slot && slot.id === last.id) { stopWeb(''); try { sessionStorage.removeItem(KEY_STORE + last.id); } catch (e) {} }
    }
    // upcoming + queue
    var up = list.filter(function (x) { return x.status === 'scheduled' || x.status === 'requested'; });
    var h = '';
    up.forEach(function (x) {
      h += '<li><span><b>' + esc(roomTitle(x.room_id)) + '</b> · ' + when(x.start_at) + ' · ' + x.max_minutes + ' min' + (x.featured ? ' · ★ featured' : '') +
           (x.embed_label ? ' · ' + esc(x.embed_label) : '') + (x.status === 'requested' ? ' · <i>waiting for the owner</i>' : '') +
           (x.held ? ' · ' + fmt(x.held) + ' PAT held' : '') + '</span>' +
           (x.mode !== 'embed' ? '<button type="button" class="btn" data-key="' + esc(x.id) + '">Key</button>' : '') +
           '<button type="button" class="btn danger" data-cancel="' + esc(x.id) + '">Cancel</button></li>';
    });
    (d.queue || []).forEach(function (q) {
      h += '<li><span><b>' + esc(roomTitle(q.room_id)) + '</b> · queue #' + q.position + ' · ' + q.minutes + ' min' + '</span>' +
           '<button type="button" class="btn danger" data-leave="' + esc(q.id) + '">Leave</button></li>';
    });
    $('upList').innerHTML = h;
    show('upCard', !!h);
    slot = s || null;
    // 1.99et: the WebRTC go-live (stage-golive-rtc.js, only on the page while webrtc_enabled is on) follows the open slot
    window.PATVStageSlot = s || null;
    try { window.dispatchEvent(new CustomEvent('patv:slot', { detail: s || null })); } catch (e) { /* old browser */ }
    if (!s) return;
    $('slotRoom').textContent = roomTitle(s.room_id);
    var o = roomOpt(s.room_id);
    $('watchLink').href = o ? '/p/' + encodeURIComponent(o.value) : '/';
    var embed = s.mode === 'embed', lib = !!s.library;     // 1.99jn: a 📼 library slot - its controls are #plexNow (stage-plex.js)
    show('streamPanes', !embed && !lib); show('embedNote', embed);
    var st = $('slotState');
    st.className = 'state ' + (s.live ? 'live' : 'wait');
    st.innerHTML = (s.live ? '<span class="dot" aria-hidden="true"></span> LIVE' + (s.featured ? ' · ★ FEATURED' : '') + (lib ? ' · 📼' : '')
      : (lib ? (s.went_live ? '📼 Paused / off air' : '📼 Starting…') : s.went_live ? 'Off air - reconnect to continue' : 'Waiting for your stream'));
    $('liveTime').textContent = mmss(s.live_seconds);
    $('charged').textContent = fmt(s.charged) + ' PAT';
    $('held').textContent = fmt(s.held) + ' PAT';
    if (lib) {
      $('leftK').textContent = 'Slot open for';
      $('leftV').textContent = mmss(s.max_minutes * 60 - s.live_seconds);
      $('slotNote').textContent = s.live ? '📼 Playing from Plex on ' + roomTitle(s.room_id) + '\'s stage.' : (s.went_live ? 'Paused - resume below.' : 'The library stream is starting - it shows on the stage within a few seconds.');
    } else if (!s.went_live && !embed) {
      $('leftK').textContent = 'Go live within';
      $('leftV').textContent = mmss((s.start_by - Date.now()) / 1000);
      $('slotNote').textContent = 'Start streaming before the timer runs out, or the slot is cancelled' + (s.held ? ' and everything is refunded.' : '.');
    } else {
      $('leftK').textContent = 'Time left';
      $('leftV').textContent = mmss(s.max_minutes * 60 - s.live_seconds);
      $('slotNote').textContent = s.live ? (s.featured ? 'You\'re the featured stream in ' + roomTitle(s.room_id) + '. ' : 'You\'re on the stage in ' + roomTitle(s.room_id) + '. ') +
        (s.price_per_min && s.held > s.charged ? fmt(s.price_per_min) + ' PAT per started minute live.' : 'Viewers pick your tab to watch.') : 'Your stream dropped. Billing is paused until you are back.';
    }
    // 1.99cr: may viewers snap / clip this stream, is it NSFW (not while a change is on its way)
    show('capOpts', !embed && !lib);
    if (!capBusy) { $('capAllow').checked = s.capture !== false; $('capNsfw').checked = !!s.nsfw; }
    var k = null;
    try { k = sessionStorage.getItem(KEY_STORE + s.id); } catch (e) {}
    $('rtmpKey').value = k || '';
    $('keyNote').textContent = k ? 'Your key works only for this slot and stops working when it ends. Don\'t share it.'
      : 'This tab doesn\'t have your key - press "New key" for a fresh one (the old one stops working), or go live from the browser.';
  }
  var capBusy = false;
  function capSave() {
    if (!slot) return;
    capBusy = true;
    fetch('/api/stage/slots/' + encodeURIComponent(slot.id) + '/capture', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ allow: $('capAllow').checked, nsfw: $('capNsfw').checked }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        capBusy = false;
        $('slotMsg').textContent = j.ok ? (j.capture ? 'Viewers can snap and clip your stream' : 'Snaps and clips of your stream are off') + (j.nsfw ? ' · marked NSFW.' : '.') : (j.error || 'Could not change that.');
        refresh();
      }).catch(function () { capBusy = false; $('slotMsg').textContent = 'Could not reach the site.'; });
  }
  $('capAllow').addEventListener('change', capSave);
  $('capNsfw').addEventListener('change', capSave);
  function refresh() {
    return fetch('/api/stage/me?room=' + encodeURIComponent($('room').value), { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) render(j);
    }).catch(function () {});
  }
  refresh();
  polling = setInterval(refresh, 3000);
  window.PATVStageRefresh = refresh;                  // 1.99jn: stage-plex.js after a play / stop

  $('endBtn').addEventListener('click', function () {
    if (!slot || !confirm(slot.library ? 'Stop the library stream and end your slot?' : 'End your slot now?' + (slot.held > slot.charged ? ' Unused PAT is refunded right away.' : ''))) return;
    $('endBtn').disabled = true;
    stopWeb('');
    // a 📼 library slot: stop the encoder too (the stage would end it on its own within seconds)
    (slot.library ? post('/api/medialib/stop', { room: slot.room_id }) : post('/api/stage/slots/' + encodeURIComponent(slot.id) + '/end')).then(function (j) {
      $('endBtn').disabled = false;
      if (!j.ok) alert(j.error || 'Could not end it.');
      refresh();
    }).catch(function () { $('endBtn').disabled = false; });
  });
  function newKey(id, then) {
    post('/api/stage/slots/' + encodeURIComponent(id) + '/key').then(function (j) {
      if (!j.ok) { alert(j.error || 'Could not make a key.'); return; }
      try { sessionStorage.setItem(KEY_STORE + id, j.key); } catch (e) {}
      if (then) then(j.key);
      refresh();
    });
  }
  $('newKey').addEventListener('click', function () {
    if (slot && confirm('Make a new stream key? The old one stops working.')) newKey(slot.id);
  });
  $('upList').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-cancel')) {
      if (!confirm('Cancel this booking? Anything held is refunded.')) return;
      post('/api/stage/slots/' + encodeURIComponent(b.getAttribute('data-cancel')) + '/end').then(function (j) { if (!j.ok) alert(j.error || 'Could not cancel.'); refresh(); });
    } else if (b.hasAttribute('data-leave')) {
      post('/api/stage/queue/' + encodeURIComponent(b.getAttribute('data-leave')) + '/leave').then(function () { refresh(); });
    } else if (b.hasAttribute('data-key')) {
      var id = b.getAttribute('data-key'), k = null;
      try { k = sessionStorage.getItem(KEY_STORE + id); } catch (x) {}
      if (k) { prompt('Your stream key for that booking (works from a few minutes before the start):', k); return; }
      if (confirm('This tab doesn\'t have that booking\'s key. Make a new one?')) newKey(id, function (key) { prompt('Your new stream key (works from a few minutes before the start):', key); });
    }
  });

  // copy / show key
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var el = $(b.getAttribute('data-copy'));
      if (!el.value) return;
      (navigator.clipboard ? navigator.clipboard.writeText(el.value) : Promise.reject()).then(function () {
        var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1200);
      }).catch(function () { el.type = 'text'; el.select(); });
    });
  });
  $('showKey').addEventListener('click', function () {
    var k = $('rtmpKey'); k.type = k.type === 'password' ? 'text' : 'password';
    $('showKey').textContent = k.type === 'password' ? 'Show' : 'Hide';
  });

  // tabs
  function tab(which) {
    var obs = which === 'obs';
    $('tabObs').setAttribute('aria-selected', String(obs)); $('tabWeb').setAttribute('aria-selected', String(!obs));
    show('paneObs', obs); show('paneWeb', !obs);
    if ($('tabRtc')) { $('tabRtc').setAttribute('aria-selected', 'false'); show('paneRtc', false); }   // 1.99et (stage-golive-rtc.js)
  }
  $('tabObs').addEventListener('click', function () { tab('obs'); });
  $('tabWeb').addEventListener('click', function () { tab('web'); });

  // ── browser streaming ──
  // 1.99bx: camera + mic pickers and "Switch camera", before and WHILE live.
  // MediaRecorder can't swap a track mid-recording (Chrome/Firefox stop or error when the recorded
  // stream's tracks change), so what it records is a PROGRAM feed whose tracks never change:
  //   * video: the camera is painted onto a <canvas> and the canvas is recorded (captureStream). The
  //     painting runs off a Web Worker clock, so a background tab doesn't freeze the picture
  //     (requestAnimationFrame stops there, main-thread timers are throttled to 1/s).
  //   * audio: mic (+ screen audio) go through one Web Audio mixer (MediaStreamAudioDestinationNode).
  // Switching a camera / mic only changes what feeds the canvas / the mixer: the recorder, the relay,
  // ffmpeg and the stage never notice. The canvas holds the last frame while the new camera opens.
  // Fallback (no canvas.captureStream / Web Audio): the tracks are recorded directly and a switch
  // restarts the recorder (seq 0 -> the server restarts its ffmpeg: a couple of seconds' gap).
  // Screen mode records the screen's own video track (no canvas) - only the mic can be switched there.
  var LS_CAM = 'patvCamId', LS_MIC = 'patvMicId', LS_FACE = 'patvCamFacing';
  function pref(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch (e) { /* private mode */ }
    return null;
  }
  var AC = window.AudioContext || window.webkitAudioContext;
  var cam = null, mic = null, scr = null;        // what we captured (cam: video only, mic: audio only)
  var prog = null;                               // the program feed while live: {ac, dest, nodes, canvas, g, vid, track, stop}
  var media = null, rec = null, seq = 0, queue = [], sending = false, live = false, sent = [], fails = 0;
  var previewing = false, switching = false, camOn = true, micOn = true, devs = { video: [], audio: [] };
  var MIMES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=h264,opus', 'video/webm', 'video/mp4'];
  function mime() {
    if (!window.MediaRecorder) return null;
    for (var i = 0; i < MIMES.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(MIMES[i])) return MIMES[i];
    return '';
  }
  function webMsg(t) { $('webMsg').textContent = t || ''; }
  function srcKind() { var r = document.querySelector('input[name=src]:checked'); return r ? r.value : 'camera'; }
  function md() { return navigator.mediaDevices || null; }
  function gum(c) { return md().getUserMedia(c); }
  function camTrack() { return cam ? cam.getVideoTracks()[0] || null : null; }
  function micTrack() { return mic ? mic.getAudioTracks()[0] || null : null; }
  function scrVideo() { return scr ? scr.getVideoTracks()[0] || null : null; }
  function settings(t) { try { return (t && t.getSettings && t.getSettings()) || {}; } catch (e) { return {}; } }
  function stopStream(s) { if (s) s.getTracks().forEach(function (t) { t.onended = null; try { t.stop(); } catch (e) { /* gone */ } }); }
  function errText(e, what) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'Permission denied - allow the ' + what + ' for this site in your browser (the lock / camera icon by the address), then try again.';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'No ' + what + ' found.';
    if (n === 'OverconstrainedError') return 'That ' + what + ' isn\'t available - pick another one.';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'Your ' + what + ' is busy - close other apps or tabs using it, then try again.';
    return (e && e.message) || ('Could not open the ' + what + '.');
  }
  // constraints: an explicit pick is exact; the remembered one is only "ideal" (a stale id never fails)
  function vCons(o) {
    var c = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    if (o && o.deviceId) c.deviceId = { exact: o.deviceId };
    else if (o && o.facing) c.facingMode = { exact: o.facing };
    else { var id = pref(LS_CAM), f = pref(LS_FACE); if (id) c.deviceId = { ideal: id }; else if (f) c.facingMode = { ideal: f }; }
    return c;
  }
  function aCons(o) {
    var c = { echoCancellation: true, noiseSuppression: true };
    if (o && o.deviceId) c.deviceId = { exact: o.deviceId };
    else { var id = pref(LS_MIC); if (id) c.deviceId = { ideal: id }; }
    return c;
  }
  function remember(kind) {
    var st = settings(kind === 'camera' ? camTrack() : micTrack());
    if (kind === 'camera') { if (st.deviceId) pref(LS_CAM, st.deviceId); if (st.facingMode) pref(LS_FACE, st.facingMode); }
    else if (st.deviceId) pref(LS_MIC, st.deviceId);
  }

  // ── opening sources ──
  function openCamera() {
    // one prompt for both; a missing / busy camera still lets the mic stream (black picture) when we can draw one
    return gum({ video: vCons(), audio: aCons() }).then(function (s) {
      cam = new MediaStream(s.getVideoTracks()); mic = new MediaStream(s.getAudioTracks());
      return '';
    }, function (e) {
      if (!e || /NotAllowed|Security|PermissionDenied/.test(e.name || '')) throw e;
      return gum({ audio: aCons() }).then(function (s) {
        cam = null; mic = s;
        return errText(e, 'camera') + ' You can still go live with your mic and a black picture, or pick another camera.';
      }, function () { throw e; });
    });
  }
  function openScreen() {
    if (!md().getDisplayMedia) return Promise.reject(new Error('Screen sharing isn\'t supported in this browser.'));
    return md().getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true }).then(function (s) {
      scr = s;
      return gum({ audio: aCons() }).then(function (m) { mic = m; return ''; }, function (e) { mic = null; return errText(e, 'microphone') + ' Streaming the screen without your mic.'; });
    });
  }
  function hookCam() {
    var t = camTrack(); if (!t) return;
    t.enabled = camOn;
    t.onended = function () { if (!switching) lost('camera'); };
  }
  function hookMic() {
    var t = micTrack(); if (!t) return;
    t.enabled = micOn;
    t.onended = function () { if (!switching) lost('microphone'); };
  }
  function hookScr() {
    var t = scrVideo(); if (!t) return;
    t.onended = function () { if (live) stopWeb('Your screen share stopped.'); else releaseMedia(); };
  }

  // ── the program feed ──
  function clock(fn, ms) {
    var w = null, iv = null, url = null;
    try {
      url = URL.createObjectURL(new Blob(['var t=null;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}'], { type: 'text/javascript' }));
      w = new Worker(url);
      w.onmessage = fn; w.postMessage(ms);
    } catch (e) { w = null; iv = setInterval(fn, ms); }
    return function () {
      if (w) { try { w.postMessage(0); w.terminate(); } catch (e) { /* gone */ } }
      if (iv) clearInterval(iv);
      if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* fine */ } }
    };
  }
  function draw() {
    var p = prog; if (!p || !p.g) return;
    var c = p.canvas, g = p.g, v = p.vid, t = camTrack();
    var cw = c.width, ch = c.height;
    if (!t || !camOn || t.readyState !== 'live') { g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch); return; }
    if (v.readyState < 2 || !v.videoWidth) return;              // the new camera is opening: hold the last frame
    var vw = v.videoWidth, vh = v.videoHeight, s = Math.min(cw / vw, ch / vh), dw = vw * s, dh = vh * s;
    if (dw < cw - 1 || dh < ch - 1) { g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch); }
    try { g.drawImage(v, (cw - dw) / 2, (ch - dh) / 2, dw, dh); } catch (e) { /* frame not ready */ }
  }
  function buildProgram(ac) {
    var p = { nodes: [] };
    if (ac && ac.createMediaStreamDestination) {
      p.ac = ac; p.dest = ac.createMediaStreamDestination();
      if (ac.state === 'suspended' && ac.resume) ac.resume().catch(function () {});
    } else if (ac) { try { ac.close(); } catch (e) { /* fine */ } }
    if (srcKind() === 'camera') {
      var c = document.createElement('canvas');
      if (typeof c.captureStream === 'function') {
        var pv = $('pv'), st = settings(camTrack());
        var w = pv.videoWidth || st.width || 1280, h = pv.videoHeight || st.height || 720;
        var k = Math.min(1, 1280 / Math.max(w, h));
        c.width = Math.max(2, Math.round(w * k / 2) * 2); c.height = Math.max(2, Math.round(h * k / 2) * 2);
        var g = c.getContext('2d');
        var track = null;
        try { track = c.captureStream(30).getVideoTracks()[0] || null; } catch (e) { track = null; }
        if (g && track) {
          g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
          var v = document.createElement('video');
          v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
          // in the page and "visible" (not display:none) so every browser keeps decoding it
          v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none;z-index:-1';
          document.body.appendChild(v);
          p.canvas = c; p.g = g; p.vid = v; p.track = track;
          p.stop = clock(draw, 33);
        }
      }
    }
    prog = p;
    rewire();
  }
  function teardownProgram() {
    var p = prog; prog = null;
    if (!p) return;
    if (p.stop) p.stop();
    if (p.track) { try { p.track.stop(); } catch (e) { /* gone */ } }
    if (p.vid) { try { p.vid.srcObject = null; p.vid.remove(); } catch (e) { /* gone */ } }
    p.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* gone */ } });
    if (p.ac) { try { p.ac.close(); } catch (e) { /* gone */ } }
  }
  // what the recorder records: the program's stable tracks, or (fallback) the sources themselves
  function recTracks() {
    var v = prog && prog.track ? prog.track : (srcKind() === 'camera' ? camTrack() : scrVideo());
    var a = prog && prog.ac ? prog.dest.stream.getAudioTracks()[0] : (micTrack() || (scr && scr.getAudioTracks()[0]) || null);
    return [v, a].filter(function (t) { return t && t.readyState !== 'ended'; });
  }
  // after any source change: feed the canvas / mixer; in the fallback, restart the recorder on new tracks
  function rewire() {
    showPreview();
    if (prog && prog.vid) {
      prog.vid.srcObject = cam || null;
      if (cam) { var pr = prog.vid.play(); if (pr && pr.catch) pr.catch(function () {}); }
    }
    if (prog && prog.ac) {
      prog.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* gone */ } });
      prog.nodes = [];
      [mic, scr].forEach(function (s) {
        var a = s ? s.getAudioTracks().filter(function (t) { return t.readyState === 'live'; }) : [];
        if (!a.length) return;
        try { var n = prog.ac.createMediaStreamSource(new MediaStream(a)); n.connect(prog.dest); prog.nodes.push(n); } catch (e) { /* no audio from it */ }
      });
    }
    $('micBtn').disabled = !micTrack(); $('camBtn').disabled = !(camTrack() || scrVideo());
    if (!live) return;
    var next = recTracks();
    if (!next.some(function (t) { return t.kind === 'video'; })) { stopWeb('Your ' + (srcKind() === 'camera' ? 'camera' : 'screen share') + ' stopped.'); return; }
    var cur = media ? media.getTracks() : [];
    var same = next.length === cur.length && next.every(function (t) { return cur.indexOf(t) >= 0; });
    if (!same) { media = new MediaStream(next); restartRecorder(); }
  }
  function showPreview() {
    var s = srcKind() === 'camera' ? cam : scr, pv = $('pv');
    if (pv.srcObject !== s) pv.srcObject = s || null;
    show('pvEmpty', !s);
    $('pvEmpty').textContent = previewing && !s ? (mic ? 'No camera - mic only' : 'No source') : 'Pick a source to preview';
  }
  function releaseMedia() {
    teardownProgram();
    stopStream(cam); stopStream(mic); stopStream(scr);
    cam = mic = scr = null; media = null; previewing = false;
    $('pv').srcObject = null; show('pvEmpty', true); $('pvEmpty').textContent = 'Pick a source to preview';
    $('micBtn').disabled = true; $('camBtn').disabled = true;
    pickers();
  }
  function preview() {
    if (live) return Promise.resolve(media);
    releaseMedia();
    if (!md() || !md().getUserMedia) {
      var e0 = new Error('This browser can\'t capture video here (needs HTTPS and a modern browser).'); webMsg(e0.message); return Promise.reject(e0);
    }
    var screen = srcKind() === 'screen';
    webMsg('Asking for your ' + (screen ? 'screen' : 'camera and mic') + '…');
    return (screen ? openScreen() : openCamera()).then(function (note) {
      previewing = true; camOn = true; micOn = true;
      hookCam(); hookMic(); hookScr();
      setToggle('micBtn', true, '🎤 Mic'); setToggle('camBtn', true, '🎥 Video');
      rewire();
      remember('camera'); remember('microphone');
      webMsg(note || '');
      listDevices();
      return media;
    }).catch(function (e) {
      releaseMedia();
      webMsg(errText(e, screen ? 'screen' : 'camera and mic'));
      throw e;
    });
  }
  // a device unplugged / taken away: fall back to another one; live, the program keeps streaming
  // (black picture / silence) until there is one
  function lost(kind) {
    var isCam = kind === 'camera';
    if (isCam) { stopStream(cam); cam = null; } else { stopStream(mic); mic = null; }
    rewire();
    if (!previewing) return;
    (isCam ? gum({ video: vCons() }) : gum({ audio: aCons() })).then(function (s) {
      if (!previewing) { stopStream(s); return; }
      if (isCam) { cam = s; hookCam(); } else { mic = s; hookMic(); }
      rewire();
      listDevices().then(function () {
        var id = settings(isCam ? camTrack() : micTrack()).deviceId, d = null;
        (isCam ? devs.video : devs.audio).forEach(function (x) { if (x.deviceId === id) d = x; });
        webMsg('Your ' + kind + ' disconnected - switched to ' + ((d && d.label) || 'another one') + '.');
      });
    }, function () {
      listDevices();
      webMsg('Your ' + kind + ' disconnected' + (live ? (isCam ? ' - viewers see a black picture until you pick another camera.' : ' - the stream is silent until you pick another mic.') : '.'));
    });
  }
  // iOS: opening one kind can end the other kind's track - reopen it quietly
  function heal() {
    var m = micTrack();
    if (mic && m && m.readyState === 'ended') gum({ audio: aCons() }).then(function (s) { stopStream(mic); mic = s; hookMic(); rewire(); }, function () { lost('microphone'); });
    var c = camTrack();
    if (cam && c && c.readyState === 'ended') gum({ video: vCons() }).then(function (s) { stopStream(cam); cam = s; hookCam(); rewire(); }, function () { lost('camera'); });
  }
  // switch to another camera / mic: open the new one first (seamless on desktop); a phone that can't
  // run two at once (busy) gets the old one stopped first. iOS ends the old track by itself.
  function switchDev(kind, o) {
    var isCam = kind === 'camera';
    if (switching || !previewing || (isCam && srcKind() !== 'camera')) return Promise.resolve(false);
    var get = isCam ? camTrack : micTrack, hook = isCam ? hookCam : hookMic;
    var cons = function (x) { return isCam ? { video: vCons(x) } : { audio: aCons(x) }; };
    var set = function (s) { if (isCam) cam = s; else mic = s; };
    var old = isCam ? cam : mic, oldId = settings(get()).deviceId;
    switching = true;
    webMsg('Switching ' + kind + '…');
    return gum(cons(o)).catch(function (e) {
      if (!old || !(e && /NotReadable|TrackStart|Abort/.test(e.name || ''))) throw e;
      stopStream(old); old = null; set(null);
      return gum(cons(o));
    }).then(function (s) {
      stopStream(old); set(s); hook();
      switching = false;
      remember(kind); rewire(); heal(); webMsg(''); listDevices();
      return true;
    }, function (e) {
      switching = false;
      webMsg(errText(e, kind));
      var t = get();
      if (t && t.readyState === 'live') { listDevices(); return false; }
      set(null);                                               // the old one is gone too: get it back
      return gum(cons(oldId ? { deviceId: oldId } : null)).then(function (s) { set(s); hook(); }, function () { /* stays without */ })
        .then(function () { rewire(); heal(); listDevices(); return false; });
    });
  }
  // "Switch camera": front <-> back on phones (facingMode); elsewhere the next camera in the list
  function flip() {
    var st = settings(camTrack());
    var nextDev = function () {
      var L = devs.video.filter(function (d) { return d.deviceId; });
      if (L.length < 2) return null;
      var i = -1; L.forEach(function (d, j) { if (d.deviceId === st.deviceId) i = j; });
      return { deviceId: L[(i + 1) % L.length].deviceId };
    };
    if (st.facingMode === 'user' || st.facingMode === 'environment') {
      return switchDev('camera', { facing: st.facingMode === 'user' ? 'environment' : 'user' }).then(function (ok) {
        var n = !ok && nextDev(); if (n) return switchDev('camera', n);
      });
    }
    var n = nextDev();
    return n ? switchDev('camera', n) : Promise.resolve(false);
  }

  // ── the pickers ──
  function fill(sel, list, noun, cur) {
    sel.textContent = '';
    var named = list.some(function (d) { return d.label; });
    if (!named) {
      var o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Default ' + noun; sel.appendChild(o0);
      sel.disabled = true; return;
    }
    list.forEach(function (d, i) {
      var o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (noun.charAt(0).toUpperCase() + noun.slice(1) + ' ' + (i + 1));
      sel.appendChild(o);
    });
    sel.disabled = false;
    if (cur && list.some(function (d) { return d.deviceId === cur; })) sel.value = cur;
  }
  function pickers() {
    var camMode = srcKind() === 'camera';
    show('camFld', camMode);
    var named = devs.video.concat(devs.audio).some(function (d) { return d.label; });
    show('flipBtn', camMode && previewing && !!camTrack() && (devs.video.length > 1 || /^(user|environment)$/.test(settings(camTrack()).facingMode || '')));
    $('flipBtn').disabled = switching;
    $('devNote').textContent = !md() ? '' : named ? (live ? 'You can switch while live - the stream keeps going.' : '')
      : 'Press Preview once and allow the camera and mic - then you can choose which ones to use.';
  }
  function listDevices() {
    if (!md() || !md().enumerateDevices) { show('devs', false); return Promise.resolve(); }
    return md().enumerateDevices().then(function (all) {
      devs.video = all.filter(function (d) { return d.kind === 'videoinput'; });
      devs.audio = all.filter(function (d) { return d.kind === 'audioinput' && d.deviceId !== 'communications'; });
      fill($('camSel'), devs.video, 'camera', settings(camTrack()).deviceId || pref(LS_CAM));
      fill($('micSel'), devs.audio, 'microphone', settings(micTrack()).deviceId || pref(LS_MIC));
      pickers();
    }).catch(function () { pickers(); });
  }
  $('camSel').addEventListener('change', function () {
    var id = $('camSel').value; if (!id) return;
    pref(LS_CAM, id); pref(LS_FACE, null);
    if (previewing && srcKind() === 'camera') switchDev('camera', { deviceId: id });
  });
  $('micSel').addEventListener('change', function () {
    var id = $('micSel').value; if (!id) return;
    pref(LS_MIC, id);
    if (previewing) switchDev('microphone', { deviceId: id });
  });
  $('flipBtn').addEventListener('click', function () { flip(); });
  if (md() && md().addEventListener) md().addEventListener('devicechange', function () { listDevices(); });
  listDevices();

  function setToggle(id, on, label) { var b = $(id); b.setAttribute('aria-pressed', String(on)); b.textContent = label + (on ? ' on' : ' off'); }
  $('pvBtn').addEventListener('click', function () { preview().catch(function () {}); });
  document.querySelectorAll('input[name=src]').forEach(function (r) {
    r.addEventListener('change', function () { pickers(); if (!live && previewing) preview().catch(function () {}); });
  });
  $('micBtn').addEventListener('click', function () {
    var t = micTrack(); if (!t) return;
    micOn = !micOn; t.enabled = micOn; setToggle('micBtn', micOn, '🎤 Mic');
  });
  $('camBtn').addEventListener('click', function () {
    var t = srcKind() === 'camera' ? camTrack() : scrVideo(); if (!t) return;
    camOn = !camOn; t.enabled = camOn; setToggle('camBtn', camOn, '🎥 Video');
  });

  function startRecorder() {
    var mt = mime();
    if (mt === null) throw new Error('This browser can\'t record video for streaming - try Chrome, Edge or Firefox, or use OBS.');
    var opts = { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
    if (mt) opts.mimeType = mt;
    seq = 0; queue = [];
    rec = new MediaRecorder(media, opts);
    var mine = rec;
    rec.ondataavailable = function (e) { if (rec === mine && live && e.data && e.data.size) { queue.push(e.data); pump(); } };
    rec.onerror = function () { if (rec === mine && live) restartRecorder(); };
    rec.start(1000);
  }
  function restartRecorder() {
    if (!live) return;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) { /* already stopped */ }
    rec = null;
    setTimeout(function () { if (live) { try { startRecorder(); } catch (e) { stopWeb(e.message); } } }, 300);
  }
  function pump() {
    if (sending || !queue.length || !live || !slot) return;
    sending = true;
    var blob = queue[0], n = seq;
    fetch('/api/stage/slots/' + encodeURIComponent(slot.id) + '/relay?seq=' + n, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob, credentials: 'same-origin',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; });
    }).then(function (res) {
      sending = false;
      if (res.status === 200) {
        fails = 0; queue.shift(); seq = n + 1;
        sent.push({ t: Date.now(), n: blob.size }); meter();
        pump(); return;
      }
      if (res.status === 409) { restartRecorder(); return; }              // relay restarted / out of order
      stopWeb((res.j && res.j.error) || ('Streaming stopped (' + res.status + ').'));
      refresh();
    }).catch(function () {
      sending = false;
      if (++fails > 5) { restartRecorder(); fails = 0; return; }
      setTimeout(pump, 700);
    });
  }
  function meter() {
    var t = Date.now();
    sent = sent.filter(function (x) { return t - x.t < 5000; });
    var bytes = sent.reduce(function (a, x) { return a + x.n; }, 0);
    var kbps = Math.round(bytes * 8 / 5000);
    $('kbps').textContent = fmt(kbps);
    $('kbpsBar').style.width = Math.min(100, kbps / 40) + '%';
  }
  setInterval(function () { if (live) meter(); }, 1000);

  $('goBtn').addEventListener('click', function () {
    if (!slot || live) return;
    // made inside the tap: iOS only lets audio start from a user gesture
    var ac = null;
    if (AC) { try { ac = new AC(); } catch (e) { ac = null; } }
    (previewing ? Promise.resolve() : preview()).then(function () {
      buildProgram(ac); ac = null;
      var tracks = recTracks();
      if (!tracks.some(function (t) { return t.kind === 'video'; })) {
        teardownProgram();
        webMsg('No camera to stream - plug one in, pick another camera, or choose Screen.');
        return;
      }
      media = new MediaStream(tracks);
      live = true; fails = 0;
      try { startRecorder(); } catch (e) { live = false; teardownProgram(); webMsg(e.message); return; }
      show('goBtn', false); show('stopBtn', true); show('onAir', true); show('pvBtn', false);
      document.querySelectorAll('input[name=src]').forEach(function (r) { r.disabled = true; });
      pickers();
      webMsg('Connecting to the stage… you should be live in a few seconds.');
      setTimeout(function () { if (live) webMsg(''); }, 8000);
    }).catch(function () { if (ac) { try { ac.close(); } catch (e) { /* fine */ } } });
  });
  function stopWeb(msg) {
    var was = live;
    live = false;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) { /* already stopped */ }
    rec = null; queue = []; sending = false; sent = [];
    $('kbps').textContent = '0'; $('kbpsBar').style.width = '0';
    show('goBtn', true); show('stopBtn', false); show('onAir', false); show('pvBtn', true);
    document.querySelectorAll('input[name=src]').forEach(function (r) { r.disabled = false; });
    if (was) releaseMedia();
    if (msg != null) webMsg(msg);
  }
  $('stopBtn').addEventListener('click', function () { stopWeb('Stopped. Your slot is still open - go live again or end it.'); });
  window.addEventListener('beforeunload', function (e) { if (live) { e.preventDefault(); e.returnValue = ''; } });
})();
