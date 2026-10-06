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
  if (/[?&]feature=1/.test(location.search)) setRadio('kind', 'feature');

  // ── booking form ──
  var mins = $('mins'), minsR = $('minsR');
  function price() {
    if (radio('kind') === 'feature') return PRICE;
    var o = $('room').selectedOptions[0];
    return o ? Number(o.getAttribute('data-price')) || 0 : 0;
  }
  function formCalc() {
    var o = $('room').selectedOptions[0], sp = o ? Number(o.getAttribute('data-price')) || 0 : 0;
    $('slotPriceTxt').textContent = sp ? fmt(sp) + ' PAT / live min in this room' : 'free in this room';
    $('holdAmt').textContent = fmt((Number(mins.value) || 0) * price());
    var w = radio('when'), embed = radio('mode') === 'embed';
    show('embedFld', embed); show('atFld', w === 'later');
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
    var m = Number(mins.value), w = radio('when'), feat = radio('kind') === 'feature', mode = radio('mode');
    var body = { room: $('room').value, minutes: m, feature: feat, mode: mode, embed: $('embed').value, title: $('title').value };
    if (mode === 'embed' && !$('embed').value.trim()) { $('bookMsg').textContent = 'Paste a YouTube or Twitch link.'; return; }
    var hold = m * price();
    var url = '/api/stage/book';
    if (w === 'later') {
      var at = new Date($('at').value).getTime();
      if (!at || at < Date.now() + 60000) { $('bookMsg').textContent = 'Pick a start time in the future.'; return; }
      body.start_at = at;
    } else if (w === 'queue') url = '/api/stage/queue';
    var q = w === 'queue' ? 'Join the queue for a ' + m + '-minute ' + (feat ? 'featured ' : '') + 'slot? When a slot frees up it\'s booked for you' + (hold ? ' and ' + fmt(hold) + ' PAT is held then' : '') + '.'
      : (hold ? 'Hold ' + fmt(hold) + ' PAT for a ' + m + '-minute ' + (feat ? 'featured ' : '') + 'slot? You pay only for the minutes you\'re live; the rest comes back.'
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
      else if (j.slot && (j.slot.status === 'requested')) $('bookMsg').textContent = 'Requested - the room\'s owner approves it. Your hold comes back if they don\'t.';
      else if (j.slot && j.slot.status === 'scheduled') $('bookMsg').textContent = 'Booked for ' + when(j.slot.start_at) + '. Your key works from a few minutes before.';
      else $('bookMsg').textContent = '';
      if (j.key && j.slot) { try { sessionStorage.setItem(KEY_STORE + j.slot.id, j.key); } catch (x) {} }
      refresh();
    }).catch(function () { $('bookBtn').disabled = false; $('bookMsg').textContent = 'Could not reach the server.'; });
  });

  // ── status ──
  var REASONS = { owner_ended: 'you ended it', time_up: 'your time ran out', never_live: "it never went live, so you got everything back",
    idle: 'the stream was off air too long', cut: 'it was cut back to Pepe', banned: 'an admin or the room owner cut it', deadline: 'it reached its deadline',
    restart: 'it timed out while the site restarted', cancelled: 'you cancelled it', denied: 'the room owner declined it', not_approved: "it wasn't approved in time",
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
    if (d.banned) $('roomInfo').textContent = 'You can\'t book this room\'s stage.';
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
      h += '<li><span><b>' + esc(roomTitle(q.room_id)) + '</b> · queue #' + q.position + ' · ' + q.minutes + ' min' + (q.feature ? ' · ★ featured' : '') + '</span>' +
           '<button type="button" class="btn danger" data-leave="' + esc(q.id) + '">Leave</button></li>';
    });
    $('upList').innerHTML = h;
    show('upCard', !!h);
    slot = s || null;
    if (!s) return;
    $('slotRoom').textContent = roomTitle(s.room_id);
    var o = roomOpt(s.room_id);
    $('watchLink').href = o ? '/rooms/' + encodeURIComponent(o.value) : '/';
    var embed = s.mode === 'embed';
    show('streamPanes', !embed); show('embedNote', embed);
    var st = $('slotState');
    st.className = 'state ' + (s.live ? 'live' : 'wait');
    st.innerHTML = (s.live ? '<span class="dot" aria-hidden="true"></span> LIVE' + (s.featured ? ' · ★ FEATURED' : '') : (s.went_live ? 'Off air - reconnect to continue' : 'Waiting for your stream'));
    $('liveTime').textContent = mmss(s.live_seconds);
    $('charged').textContent = fmt(s.charged) + ' PAT';
    $('held').textContent = fmt(s.held) + ' PAT';
    if (!s.went_live && !embed) {
      $('leftK').textContent = 'Go live within';
      $('leftV').textContent = mmss((s.start_by - Date.now()) / 1000);
      $('slotNote').textContent = 'Start streaming before the timer runs out, or the slot is cancelled' + (s.held ? ' and everything is refunded.' : '.');
    } else {
      $('leftK').textContent = 'Time left';
      $('leftV').textContent = mmss(s.max_minutes * 60 - s.live_seconds);
      $('slotNote').textContent = s.live ? (s.featured ? 'You\'re the featured stream in ' + roomTitle(s.room_id) + '. ' : 'You\'re on the stage in ' + roomTitle(s.room_id) + '. ') +
        (s.price_per_min && s.held > s.charged ? fmt(s.price_per_min) + ' PAT per started minute live.' : 'Viewers pick your tab to watch.') : 'Your stream dropped. Billing is paused until you are back.';
    }
    // "feature me": a free slot, nobody featured in the room
    var canFeat = !s.featured && !s.price_per_min && roomState && roomState.room.id === s.room_id && !roomState.featured;
    show('featBtn', !!canFeat);
    var k = null;
    try { k = sessionStorage.getItem(KEY_STORE + s.id); } catch (e) {}
    $('rtmpKey').value = k || '';
    $('keyNote').textContent = k ? 'Your key works only for this slot and stops working when it ends. Don\'t share it.'
      : 'This tab doesn\'t have your key - press "New key" for a fresh one (the old one stops working), or go live from the browser.';
  }
  function refresh() {
    return fetch('/api/stage/me?room=' + encodeURIComponent($('room').value), { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) render(j);
    }).catch(function () {});
  }
  refresh();
  polling = setInterval(refresh, 3000);

  $('endBtn').addEventListener('click', function () {
    if (!slot || !confirm('End your slot now?' + (slot.held > slot.charged ? ' Unused PAT is refunded right away.' : ''))) return;
    $('endBtn').disabled = true;
    stopWeb('');
    post('/api/stage/slots/' + encodeURIComponent(slot.id) + '/end').then(function (j) {
      $('endBtn').disabled = false;
      if (!j.ok) alert(j.error || 'Could not end it.');
      refresh();
    }).catch(function () { $('endBtn').disabled = false; });
  });
  $('featBtn').addEventListener('click', function () {
    if (!slot) return;
    var left = Math.max(1, slot.max_minutes - Math.ceil(slot.live_seconds / 60));
    var m = Number(prompt('Feature yourself for how many minutes? (max ' + left + ', ' + fmt(PRICE) + ' PAT per started minute live, the rest comes back)', String(Math.min(left, 15))));
    if (!m) return;
    post('/api/stage/slots/' + encodeURIComponent(slot.id) + '/upgrade', { minutes: m }).then(function (j) {
      $('slotMsg').textContent = j.ok ? '★ You\'re featured.' : (j.error || 'Could not feature you.');
      refresh();
    });
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
  }
  $('tabObs').addEventListener('click', function () { tab('obs'); });
  $('tabWeb').addEventListener('click', function () { tab('web'); });

  // ── browser streaming ──
  var media = null, extra = [], rec = null, seq = 0, queue = [], sending = false, live = false, sent = [], audioCtx = null, fails = 0;
  var MIMES = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=h264,opus', 'video/webm', 'video/mp4'];
  function mime() {
    if (!window.MediaRecorder) return null;
    for (var i = 0; i < MIMES.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(MIMES[i])) return MIMES[i];
    return '';
  }
  function webMsg(t) { $('webMsg').textContent = t || ''; }
  function srcKind() { var r = document.querySelector('input[name=src]:checked'); return r ? r.value : 'camera'; }
  function getMedia() {
    var md = navigator.mediaDevices;
    if (!md) return Promise.reject(new Error('This browser can\'t capture video here (needs HTTPS and a modern browser).'));
    if (srcKind() === 'camera') {
      return md.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    }
    if (!md.getDisplayMedia) return Promise.reject(new Error('Screen sharing isn\'t supported in this browser.'));
    return md.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true }).then(function (scr) {
      return md.getUserMedia({ audio: true }).catch(function () { return null; }).then(function (mic) {
        var out = new MediaStream(scr.getVideoTracks());
        var auds = scr.getAudioTracks().concat(mic ? mic.getAudioTracks() : []);
        extra = [scr].concat(mic ? [mic] : []);
        if (auds.length > 1 && (window.AudioContext || window.webkitAudioContext)) {
          // MediaRecorder records one audio track: mix screen audio + mic
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          var dest = audioCtx.createMediaStreamDestination();
          auds.forEach(function (t) { audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest); });
          dest.stream.getAudioTracks().forEach(function (t) { out.addTrack(t); });
          out._mic = mic;
        } else auds.forEach(function (t) { out.addTrack(t); });
        return out;
      });
    });
  }
  function releaseMedia() {
    [media].concat(extra).forEach(function (m) { if (m) m.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); });
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    media = null; extra = [];
    $('pv').srcObject = null; show('pvEmpty', true);
    $('micBtn').disabled = true; $('camBtn').disabled = true;
  }
  function preview() {
    if (live) return Promise.resolve(media);
    releaseMedia();
    webMsg('Asking for your ' + (srcKind() === 'camera' ? 'camera and mic' : 'screen') + '…');
    return getMedia().then(function (m) {
      media = m; webMsg('');
      $('pv').srcObject = m; show('pvEmpty', false);
      $('micBtn').disabled = !micTracks().length; $('camBtn').disabled = !m.getVideoTracks().length;
      setToggle('micBtn', true, '🎤 Mic'); setToggle('camBtn', true, '🎥 Video');
      m.getVideoTracks().forEach(function (t) { t.addEventListener('ended', function () { if (live) stopWeb('Your ' + (srcKind() === 'camera' ? 'camera' : 'screen share') + ' stopped.'); else releaseMedia(); }); });
      return m;
    }).catch(function (e) { webMsg(e && e.name === 'NotAllowedError' ? 'Permission denied - allow the camera/screen in your browser to stream.' : (e && e.message) || 'Could not start that source.'); throw e; });
  }
  function micTracks() { if (!media) return []; return media._mic ? media._mic.getAudioTracks() : media.getAudioTracks(); }
  function setToggle(id, on, label) { var b = $(id); b.setAttribute('aria-pressed', String(on)); b.textContent = label + (on ? ' on' : ' off'); }
  $('pvBtn').addEventListener('click', function () { preview().catch(function () {}); });
  document.querySelectorAll('input[name=src]').forEach(function (r) { r.addEventListener('change', function () { if (!live && media) preview().catch(function () {}); }); });
  $('micBtn').addEventListener('click', function () {
    var ts = micTracks(); if (!ts.length) return;
    var on = !ts[0].enabled; ts.forEach(function (t) { t.enabled = on; }); setToggle('micBtn', on, '🎤 Mic');
  });
  $('camBtn').addEventListener('click', function () {
    if (!media) return; var ts = media.getVideoTracks(); if (!ts.length) return;
    var on = !ts[0].enabled; ts.forEach(function (t) { t.enabled = on; }); setToggle('camBtn', on, '🎥 Video');
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
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) {}
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
    (media ? Promise.resolve(media) : preview()).then(function () {
      live = true; fails = 0;
      try { startRecorder(); } catch (e) { live = false; webMsg(e.message); return; }
      show('goBtn', false); show('stopBtn', true); show('onAir', true); show('pvBtn', false);
      document.querySelectorAll('input[name=src]').forEach(function (r) { r.disabled = true; });
      webMsg('Connecting to the stage… you should be live in a few seconds.');
      setTimeout(function () { if (live) webMsg(''); }, 8000);
    }).catch(function () {});
  });
  function stopWeb(msg) {
    var was = live;
    live = false;
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) {}
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
