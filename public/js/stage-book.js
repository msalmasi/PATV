// /stage/book — booking a paid Main Stage slot, its live status, and streaming from the browser.
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
  var mmss = function (s) { s = Math.max(0, Math.floor(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  var KEY_STORE = 'stageKey:';
  var slot = null, polling = null, again = false;

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  function show(id, on) { $(id).classList.toggle('hide', !on); }

  // ── booking form ──
  var mins = $('mins'), minsR = $('minsR');
  function holdCalc() { $('holdAmt').textContent = fmt((Number(mins.value) || 0) * PRICE); }
  mins.addEventListener('input', function () { minsR.value = mins.value; holdCalc(); });
  minsR.addEventListener('input', function () { mins.value = minsR.value; holdCalc(); });
  holdCalc();
  $('bookForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var m = Number(mins.value);
    if (!confirm('Hold ' + fmt(m * PRICE) + ' PAT for a ' + m + '-minute stage slot? You pay only for the minutes you are live; the rest comes back.')) return;
    $('bookBtn').disabled = true; $('bookMsg').textContent = 'Booking…';
    post('/api/stage/book', { minutes: m }).then(function (j) {
      $('bookBtn').disabled = false;
      if (!j.ok) { $('bookMsg').textContent = j.error || 'Could not book.'; return; }
      $('bookMsg').textContent = ''; again = false;
      try { sessionStorage.setItem(KEY_STORE + j.slot.id, j.key); } catch (e) {}
      render({ slot: j.slot });
      refresh();
    }).catch(function () { $('bookBtn').disabled = false; $('bookMsg').textContent = 'Could not reach the server.'; });
  });

  // ── status ──
  var REASONS = { owner_ended: 'you ended it', time_up: 'your time ran out', never_live: "it never went live, so you got everything back",
    idle: 'the stream was off air too long', cut: 'an admin cut it back to Pepe', banned: 'an admin cut it', deadline: 'it reached its deadline', restart: 'it timed out while the site restarted' };
  function render(d) {
    if (d.balance != null) $('bal').textContent = fmt(d.balance);
    var s = d.slot;
    var open = s && s.status !== 'ended';
    if (d.banned && !open) { show('bookCard', false); show('busyCard', true); $('busyMsg').textContent = "You can't book the stage right now."; }
    else if (d.busy && !open) { show('bookCard', false); show('busyCard', true); $('busyMsg').textContent = 'Someone else has the stage right now - check back when their slot ends.'; }
    else { show('busyCard', false); show('bookCard', !open && (again || !(s && s.status === 'ended'))); }
    show('slotCard', !!open);
    show('doneCard', !!(s && s.status === 'ended') && !open && !again);
    if (s && s.status === 'ended') {
      $('doneTxt').innerHTML = 'Ended - ' + (REASONS[s.end_reason] || s.end_reason || 'ended') + '. Live <b>' + mmss(s.live_seconds) + '</b>, charged <b>' +
        fmt(s.charged) + '</b> PAT (' + s.billed_minutes + ' min), refunded <b>' + fmt(s.refunded) + '</b> PAT.';
      stopWeb('');
      if (slot && slot.id === s.id) { try { sessionStorage.removeItem(KEY_STORE + s.id); } catch (e) {} }
    }
    slot = s;
    if (!open) return;
    var st = $('slotState');
    st.className = 'state ' + (s.live ? 'live' : 'wait');
    st.innerHTML = s.live ? '<span class="dot" aria-hidden="true"></span> LIVE on the stage' : (s.went_live ? 'Off air - reconnect to continue' : 'Waiting for your stream');
    $('liveTime').textContent = mmss(s.live_seconds);
    $('charged').textContent = fmt(s.charged) + ' PAT';
    $('held').textContent = fmt(s.held) + ' PAT';
    if (!s.went_live) {
      $('leftK').textContent = 'Go live within';
      $('leftV').textContent = mmss((s.start_by - Date.now()) / 1000);
      $('slotNote').textContent = 'Start streaming before the timer runs out, or the slot is cancelled and everything is refunded.';
    } else {
      $('leftK').textContent = 'Live time left';
      $('leftV').textContent = mmss(s.max_minutes * 60 - s.live_seconds);
      $('slotNote').textContent = s.live ? 'You are on the main stage. ' + fmt(s.price_per_min) + ' PAT per started minute.' : 'Your stream dropped. Billing is paused until you are back.';
    }
    var k = null;
    try { k = sessionStorage.getItem(KEY_STORE + s.id); } catch (e) {}
    $('rtmpKey').value = k || '';
    $('keyNote').textContent = k ? 'Your key works only for this slot and stops working when it ends. Don\'t share it.'
      : 'Your key was shown in the tab you booked from. Lost it? End this slot (unused PAT comes back) and book again - or go live from the browser instead.';
  }
  function refresh() {
    return fetch('/api/stage/me', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) render(j);
    }).catch(function () {});
  }
  refresh();
  polling = setInterval(refresh, 3000);

  $('endBtn').addEventListener('click', function () {
    if (!slot || !confirm('End your slot now? Unused PAT is refunded right away.')) return;
    $('endBtn').disabled = true;
    stopWeb('');
    post('/api/stage/slots/' + encodeURIComponent(slot.id) + '/end').then(function (j) {
      $('endBtn').disabled = false;
      if (!j.ok) alert(j.error || 'Could not end it.');
      refresh();
    }).catch(function () { $('endBtn').disabled = false; });
  });
  $('againBtn').addEventListener('click', function () { again = true; show('doneCard', false); show('bookCard', true); });

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
