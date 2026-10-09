// room-bridge.js — shared pieces of the Camfrog room bridge UI, used by the room page (views/room.ejs)
// and the homepage's live room panel (views/home.ejs):
//   PATVRoom.audio(el, slug)   mini player for the room's live audio (play/pause, volume + mute,
//                              live / buffering state, jump to live, level meter, "⚡ live" / "standard"); .listen(slug, name)
//                              switches it to another pad (the homepage's 🎧 buttons). One room plays
//                              at a time across every player on the page.
//   PATVRoom.relay(el, slug)   the "say something" box (Pepe relays it into the room as "🌐 you (web)");
//                              a "!" line is a command Pepe runs as your Camfrog name (autocomplete + your private answers)
//   PATVRoom.ptt(el, slug)     hold-to-talk: a voice clip (20 s max) Pepe plays on the room's mic when
//                              it's free; shown only while the room's bridge_mic switch is on
//   PATVRoom.clipStatus(job)   the clip line's text for a clip job's state (queued / waiting for the mic /
//                              playing / played / couldn't get the mic) - also used by the tests
// The player and push-to-talk share the page's audio session - see "the page's audio session" below
// for how iOS Safari's play-and-record switch is handled (1.99bk).
// All are driven by the live view JSON: call .update(d) with each poll result.
// Everything user-visible goes in via textContent.
(function () {
  'use strict';
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, String(v)); } catch (e) { return null; } return null; }

  // ── the page's audio session: room player + push-to-talk (1.99bk) ──
  // iOS Safari: getUserMedia switches the page's audio session to play-and-record. Anything routed
  // through Web Audio (the player used to feed the <audio> element into an AudioContext for its
  // level meter) gets ducked / moved to the earpiece, and that AudioContext KEEPS the route after
  // the mic stops - so the room went quiet on the first press, stayed quiet, and the next press
  // flipped it the other way ("louder"). The fix, all of it known to behave on iOS 17/18 Safari:
  //   * on iOS the room audio is a plain <audio> element - never createMediaElementSource (no
  //     meter there; the volume slider is hidden too: iOS makes element.volume read-only, the
  //     hardware buttons set it). Media elements follow the session back to playback by themselves.
  //   * everywhere else ONE AudioContext per page (ctx()) feeds the meter, resumed after a clip
  //   * the Audio Session API (navigator.audioSession, Safari 17+): 'play-and-record' just before
  //     the mic opens, 'playback' (room playing) / 'auto' right after - an explicit hand-back
  //   * every mic track is stopped and the stream dropped the moment a clip ends, in the very
  //     gesture that ended it (pointerup) - iOS holds play-and-record while any track is live, and
  //     only lets the paused room player resume from a user gesture
  //   * volume + mute live in the player's own variables (what the user set - saved only from the
  //     slider / mute button) and are re-applied after each clip; nothing is read back from the
  //     element (that's how a toggle went the wrong way) and no temporary value is ever saved
  // Desktop / Android: same player as before; a clip only adds the track release + context resume.
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
  var AC = window.AudioContext || window.webkitAudioContext;
  var shared = { ctx: null, players: [] };
  function ctx() {
    if (!shared.ctx && AC && !IOS) { try { shared.ctx = new AC(); } catch (e) { shared.ctx = null; } }
    return shared.ctx;
  }
  function setSession(type) { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* no Audio Session API */ } }
  var recSession = {
    before: function () { setSession('play-and-record'); },
    after: function () {
      setSession(shared.players.some(function (p) { return p.wantsPlay(); }) ? 'playback' : 'auto');
      var c = shared.ctx;
      if (c && c.state !== 'running' && c.state !== 'closed') { try { c.resume(); } catch (e) { /* resumes on the next play */ } }
      shared.players.forEach(function (p) { try { p.afterRec(); } catch (e) { /* one player can't break another */ } });
    },
  };

  // ── 1.99il: ⚡ low-latency room audio (WebRTC / WHEP, roomrtc.js on the site) ──
  // Where the pad has it (Prime Time pads, or every pad - the site's room_rtc setting) and the page has the WebRTC
  // client (webrtc-client.js, only while the site's WebRTC is on), ▶ first asks the site for a WHEP ticket, then plays
  // the room over WebRTC (~0.5 s behind the room). ANY failure - no ticket (off / busy: the TURN cap / not eligible),
  // no WebRTC, ICE / UDP blocked, Pepe not publishing in time, a connection lost later - plays the MP3 relay instead,
  // the same way as before 1.99il. A connection failure is remembered for RTC_RETRY_MS so a network that blocks
  // WebRTC goes straight to MP3 next time. The badge says which: "⚡ live" or "standard".
  var RTC_RETRY_MS = 10 * 60 * 1000, RTC_TIMEOUT_MS = 9000;
  // reasons that are NOT this network's fault (no 10-minute "go straight to MP3" memory for them)
  var RTC_SOFT = { off: 1, 'not-eligible': 1, busy: 1, 'no-audio': 1, denied: 1, rate: 1, stale: 1, error: 1,
                   'not-published': 1, http: 1, blocked: 1, lost: 1 };   // lost: also Pepe restarting his publish
  function rtcWhy(e) {
    if (typeof e === 'string') return e;
    if (e && e.blocked) return 'blocked';                 // autoplay refused the play() - not a connection problem
    if (e && e.status === 404) return 'not-published';    // Pepe didn't start publishing in time
    if (e && e.status) return 'http';
    return 'failed';                                      // no WebRTC / ICE (UDP + TURN) didn't connect / timed out
  }
  function rtcFailedRecently() {
    var t = 0; try { t = Number(sessionStorage.getItem('patvRoomRtcFail')) || 0; } catch (e) { t = 0; }
    return t && Date.now() - t < RTC_RETRY_MS;
  }
  function noteRtcFail(why) {
    if (RTC_SOFT[why]) return;                     // the site said no (or busy) - not this network's fault
    try { sessionStorage.setItem('patvRoomRtcFail', String(Date.now())); } catch (e) { /* private mode */ }
  }

  // ── room audio mini player ──
  // opts.showOff (the pad page): while the room's audio relay is off the player stays visible, greyed out,
  // saying why - instead of disappearing (1.99hj). The homepage keeps hiding it.
  function audio(host, slug, opts) {
    var showOff = !!(opts && opts.showOff);
    var home = slug, cur = slug, curName = null;     // the pad this player belongs to / the one it plays now
    var box = el('div', 'rb-audio hide');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Room audio');
    var play = el('button', 'rb-btn rb-play', '▶'); play.type = 'button'; play.setAttribute('aria-label', 'Listen live');
    var state = el('span', 'rb-state', 'Room audio');
    var modeEl = el('span', 'rb-mode hide');        // 1.99il: "⚡ live" (WebRTC) / "standard" (the MP3 relay)
    var meter = el('span', 'rb-meter'); meter.setAttribute('aria-hidden', 'true');
    var bars = [el('i'), el('i'), el('i'), el('i'), el('i')]; bars.forEach(function (b) { meter.appendChild(b); });
    var mute = el('button', 'rb-btn rb-mute', '🔊'); mute.type = 'button'; mute.setAttribute('aria-label', 'Mute');
    var vol = el('input', 'rb-vol'); vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '5'; vol.setAttribute('aria-label', 'Volume');
    var jump = el('button', 'rb-btn rb-jump hide', 'Jump to live'); jump.type = 'button';
    var au = el('audio'); au.preload = 'none'; au.setAttribute('playsinline', '');
    // 1.99il: the WebRTC stream plays in its own element (never routed through Web Audio - the meter only taps it)
    var rau = el('audio'); rau.setAttribute('playsinline', ''); rau.autoplay = true;
    if (IOS) { meter.style.display = 'none'; vol.style.display = 'none'; }
    [play, state, modeEl, meter, mute, vol, jump, au, rau].forEach(function (x) { box.appendChild(x); });
    host.appendChild(box);

    var playing = false, startedAt = 0, analyser = null, raf = null, available = false;
    var mode = null, rtcSess = null, rtcAnalyser = null, startGen = 0, rtcHint = null;   // 1.99il
    var v0 = Number(store('patvRoomVol')); vol.value = isFinite(v0) && store('patvRoomVol') !== null ? Math.max(0, Math.min(100, v0)) : 80;
    // What the USER set. The only source of truth for volume / mute - see the session notes above.
    var userVol = vol.value / 100, userMuted = store('patvRoomMuted') === '1';
    function applyVolume() {
      [au, rau].forEach(function (x) {            // 1.99il: both players (MP3 relay / WebRTC) follow the user's volume + mute
        x.muted = userMuted;
        if (!IOS) { try { x.volume = userVol; } catch (e) { /* read-only */ } }
      });
    }
    function setMode(m) {
      mode = m;
      modeEl.classList.toggle('hide', !m);
      modeEl.classList.toggle('rtc', m === 'rtc');
      modeEl.textContent = m === 'rtc' ? '⚡ live' : m === 'mp3' ? 'standard' : '';
      modeEl.title = m === 'rtc' ? 'Low latency (WebRTC): about half a second behind the room'
        : m === 'mp3' ? 'Standard relay: about 1.5 s behind the room' : '';
    }
    applyVolume();
    function paint() {
      play.textContent = playing ? '❚❚' : '▶';
      play.setAttribute('aria-label', playing ? 'Pause room audio' : 'Listen live');
      play.setAttribute('aria-pressed', playing ? 'true' : 'false');
      mute.textContent = userMuted || (!IOS && userVol === 0) ? '🔇' : '🔊';
      mute.setAttribute('aria-label', userMuted ? 'Unmute' : 'Mute');
      mute.setAttribute('aria-pressed', userMuted ? 'true' : 'false');
      box.classList.toggle('on', playing);
    }
    function setState(t, cls) { state.textContent = t; state.className = 'rb-state' + (cls ? ' ' + cls : ''); }
    function meterLoop() {
      var an = mode === 'rtc' ? rtcAnalyser : analyser;
      if (!an || !playing) { bars.forEach(function (b) { b.style.height = ''; }); return; }
      var d = new Uint8Array(an.frequencyBinCount); an.getByteFrequencyData(d);
      var n = bars.length, span = Math.max(1, Math.floor(d.length / n));
      for (var i = 0; i < n; i++) {
        var v = 0; for (var k = i * span; k < (i + 1) * span && k < d.length; k++) v = Math.max(v, d[k]);
        bars[i].style.height = Math.max(2, Math.round(v / 255 * 14)) + 'px';
      }
      raf = requestAnimationFrame(meterLoop);
    }
    function wireMeter() {
      if (reduce || analyser || IOS) return;          // never on iOS (see the session notes)
      try {
        var c = ctx(); if (!c) return;
        var src = c.createMediaElementSource(au);       // same-origin stream, so no CORS issue
        analyser = c.createAnalyser(); analyser.fftSize = 64;
        src.connect(analyser); analyser.connect(c.destination);
      } catch (e) { analyser = null; }
    }
    // The room arrives in ~0.25 s pieces in real time (1.99hp), so playing the moment the first bytes land
    // means stuttering. Fill a small cushion first (CUSHION s of audio, or give up waiting after 20 s and
    // play what there is), then play. 1.99hq: 0.75 s (was 2.5 s) + live-edge catch-up below.
    var CUSHION = 0.75, waitTimer = null;
    // Live edge (mirrors stage-player.js): more than EDGE_HI s buffered ahead -> play at 1.05x (pitch kept)
    // until back under EDGE_LO; more than EDGE_JUMP ahead -> jump to EDGE_KEEP s before the newest audio.
    var EDGE_LO = 0.9, EDGE_HI = 1.3, EDGE_JUMP = 4, EDGE_KEEP = 0.6, RATE_UP = 1.05;
    // ...and under EDGE_DRY s ahead -> 0.96x until EDGE_LO again, easing off before the buffer runs dry
    var EDGE_DRY = 0.3, RATE_DOWN = 0.96;
    function ahead() { var b = au.buffered; return b.length ? b.end(b.length - 1) - au.currentTime : 0; }
    // 1.99hq: where the browser can, the stream is fed through Media Source Extensions: the <audio> element's
    // own progressive loader takes the MP3 in ~2-3 s gulps (so playback stalled and ran 2-3 s behind however
    // small Pepe's chunks were), while appending each chunk as it arrives keeps the buffer smooth. Browsers
    // without MSE for audio/mpeg (older iOS) keep the plain stream URL, exactly as before.
    var MS = window.MediaSource || window.ManagedMediaSource;
    var useMse = !!(MS && MS.isTypeSupported && MS.isTypeSupported('audio/mpeg') && window.fetch && window.URL && URL.createObjectURL);
    var mse = null;
    function mseStop() {
      if (!mse) return;
      var m = mse; mse = null;
      try { m.ctl.abort(); } catch (e) { /* done already */ }
      try { URL.revokeObjectURL(m.url); } catch (e) { /* revoked */ }
    }
    function mseStart(url) {
      var m = mse = { ctl: window.AbortController ? new AbortController() : { abort: function () {}, signal: undefined }, q: [], sb: null };
      var ms = new MS();
      m.url = URL.createObjectURL(ms);
      if (window.ManagedMediaSource && MS === window.ManagedMediaSource) au.disableRemotePlayback = true;
      au.src = m.url;
      function pump() {
        if (mse !== m || !m.sb || m.sb.updating || !m.q.length) return;
        try {
          var b = au.buffered;
          if (b.length && au.currentTime - b.start(0) > 30) { m.sb.remove(0, au.currentTime - 10); return; }   // keep memory small
          m.sb.appendBuffer(m.q.shift());
        } catch (e) { if (e && e.name === 'QuotaExceededError') m.q.length = 0; }
      }
      ms.addEventListener('sourceopen', function () {
        if (mse !== m) return;
        try { m.sb = ms.addSourceBuffer('audio/mpeg'); } catch (e) { stop('this browser can\'t play the room audio'); return; }
        m.sb.addEventListener('updateend', pump);
        fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: m.ctl.signal }).then(function (r) {
          if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
          var rd = r.body.getReader();
          function next() {
            return rd.read().then(function (x) {
              if (mse !== m) { try { rd.cancel(); } catch (e) { /* gone */ } return; }
              if (x.done) { if (playing) stop('audio stopped — ▶ to retry'); return; }
              m.q.push(x.value); pump();
              return next();
            });
          }
          return next();
        }).catch(function () { if (mse === m && playing) stop('audio stopped — ▶ to retry'); });
      });
    }
    function rtcWanted() {
      return !!(window.PATVRtc && window.PATVRtc.listen && window.fetch && rtcHint !== false && !rtcFailedRecently());
    }
    function wireRtcMeter(stream) {
      rtcAnalyser = null;
      if (reduce || IOS || !stream) return;
      try {
        var c = ctx(); if (!c) return;
        var src = c.createMediaStreamSource(stream);   // a tap only - the element plays it
        rtcAnalyser = c.createAnalyser(); rtcAnalyser.fftSize = 64;
        src.connect(rtcAnalyser);
      } catch (e) { rtcAnalyser = null; }
    }
    function rtcClose() {
      var s = rtcSess; rtcSess = null; rtcAnalyser = null;
      if (s) { try { s.close(); } catch (e) { /* gone */ } }
      try { rau.pause(); rau.srcObject = null; } catch (e) { /* no srcObject */ }
    }
    // ⚡: ticket -> WHEP; resolves when it plays, rejects with the reason (the caller falls back to MP3)
    function startRtc(gen) {
      return fetch('/api/rooms/' + encodeURIComponent(cur) + '/audio/rtc', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: '{}' })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) {
          if (gen !== startGen || !playing) throw 'stale';
          if (!j || !j.ok || !j.whep) throw (j && j.fallback) || 'error';
          setState(j.ready ? 'connecting ⚡…' : 'starting ⚡…', 'wait');
          return window.PATVRtc.listen(j.whep, rau, { timeout: RTC_TIMEOUT_MS });
        })
        .then(function (sess) {
          if (gen !== startGen || !playing) { sess.close(); throw 'stale'; }
          rtcSess = sess;
          setMode('rtc'); applyVolume(); wireRtcMeter(rau.srcObject);
          if (shared.ctx && shared.ctx.state === 'suspended') shared.ctx.resume();
          startedAt = Date.now(); setState('LIVE', 'live'); meterLoop();
          sess.onfail = function () {                 // lost after it started: carry on with the MP3 relay
            if (rtcSess !== sess) return;
            rtcSess = null; noteRtcFail('lost');
            if (playing && gen === startGen) { setState('reconnecting…', 'wait'); startMp3(); }
          };
        });
    }
    function start() {
      clearInterval(waitTimer); startedAt = 0;
      shared.players.forEach(function (p) { if (p !== me) p.halt(); });   // one room at a time on the page
      var gen = ++startGen;
      rtcClose(); mseStop(); setMode(null);
      playing = true; paint(); store('patvRoomAudio', 1);
      if (rtcWanted()) {
        try { var pp = rau.play(); if (pp && pp.catch) pp.catch(function () {}); } catch (e) { /* unlock in the gesture (iOS) */ }
        setState('connecting ⚡…', 'wait');
        startRtc(gen).catch(function (e) {
          var why = rtcWhy(e);
          if (gen !== startGen || !playing || why === 'stale') return;
          noteRtcFail(why);
          rtcClose();
          startMp3();
        });
        return;
      }
      startMp3();
    }
    function startMp3() {
      clearInterval(waitTimer); startedAt = 0;
      rtcClose(); setMode('mp3');
      au.preload = 'auto';
      var url = '/p/' + encodeURIComponent(cur) + '/audio?t=' + Date.now();
      mseStop();
      if (useMse) mseStart(url);
      else { au.src = url; au.load(); }
      wireMeter();
      if (shared.ctx && shared.ctx.state === 'suspended') shared.ctx.resume();
      applyVolume();
      playing = true; paint(); store('patvRoomAudio', 1);
      setState('connecting…', 'wait');
      var t0 = Date.now(), lastGot = 0, grewAt = Date.now();
      waitTimer = setInterval(function () {
        if (!playing) { clearInterval(waitTimer); return; }
        var got = ahead();
        if (got > 0.2) setState('buffering ' + Math.min(100, Math.round(got / CUSHION * 100)) + '%', 'wait');
        // a paused element stops fetching after a couple of seconds - so "it stopped growing" counts as full too
        if (got > lastGot + 0.05) { lastGot = got; grewAt = Date.now(); }
        var full = got >= CUSHION || (got > 0.3 && Date.now() - grewAt > 1500);
        if (!full && Date.now() - t0 < 20000) return;
        clearInterval(waitTimer);
        if (got <= 0) { stop('no audio from the room right now — ▶ to retry'); return; }
        au.play().then(function () { startedAt = Date.now() - au.currentTime * 1000; meterLoop(); })
          .catch(function () { playing = false; paint(); setState('tap ▶ to listen', ''); });
      }, 250);
    }
    function stop(msg) {
      playing = false; cancelAnimationFrame(raf); clearInterval(waitTimer); setRate(1);
      startGen++; rtcClose(); setMode(null);
      mseStop();
      au.pause(); au.removeAttribute('src'); au.load();
      jump.classList.add('hide'); paint(); setState(msg || (curName ? curName + ' · audio' : 'Room audio'), '');
      notify();
    }
    var listeners = [];
    function notify() { listeners.forEach(function (f) { try { f(playing ? cur : null); } catch (e) { /* a listener can't break the player */ } }); }
    play.addEventListener('click', function () { if (playing) { stop(); store('patvRoomAudio', 0); } else start(); });
    mute.addEventListener('click', function () { userMuted = !userMuted; store('patvRoomMuted', userMuted ? 1 : 0); applyVolume(); paint(); });
    vol.addEventListener('input', function () {
      userVol = vol.value / 100;
      if (userVol > 0 && userMuted) { userMuted = false; store('patvRoomMuted', 0); }
      store('patvRoomVol', vol.value); applyVolume(); paint();
    });
    jump.addEventListener('click', function () { stop(); start(); });       // a fresh connection starts at live
    au.addEventListener('waiting', function () { if (playing) setState('LIVE · buffering…', 'wait'); });
    au.addEventListener('playing', function () { setState('LIVE', 'live'); });
    au.addEventListener('error', function () { if (playing && mode === 'mp3') stop('audio stopped — ▶ to retry'); });
    rau.addEventListener('playing', function () { if (playing && mode === 'rtc') setState('LIVE', 'live'); });
    function setRate(r) { try { if (au.playbackRate !== r) au.playbackRate = r; } catch (e) { /* fixed rate */ } }
    var lastEdge = 0;
    function edge() {
      if (!playing || !startedAt || au.paused || mode !== 'mp3') { setRate(1); return; }
      var a = ahead(), now = Date.now();
      if (a > EDGE_JUMP && now - lastEdge > 3000) {
        lastEdge = now;
        var b = au.buffered, end = b.length ? b.end(b.length - 1) : 0;
        try { au.currentTime = Math.max(0, end - EDGE_KEEP); } catch (e) { stop(); start(); return; }
        startedAt = now - au.currentTime * 1000;       // the stall clock restarts at the new position
        setRate(1);
        return;
      }
      if (a > EDGE_HI) setRate(RATE_UP);
      else if (a < EDGE_DRY) setRate(RATE_DOWN);
      else if ((au.playbackRate > 1 && a <= EDGE_LO) || (au.playbackRate < 1 && a >= EDGE_LO)) setRate(1);
      var behind = (now - startedAt) / 1000 - au.currentTime;          // time lost to stalls (catch-up shrinks it)
      var lagging = behind >= 6 || a > EDGE_JUMP / 2;
      jump.classList.toggle('hide', behind < 6);
      if (lagging && state.textContent === 'LIVE') setState('LIVE · catching up…', 'wait');
      else if (!lagging && state.textContent === 'LIVE · catching up…') setState('LIVE', 'live');
    }
    setInterval(edge, 500);
    box.rbEdge = edge;                          // tests drive it directly
    paint();
    var me = {
      halt: function () { if (playing) { stop(); } },
      wantsPlay: function () { return playing; },
      // after a clip (runs inside the gesture that ended it): the user's own volume / mute again, and
      // if the system paused the room meanwhile, play it again - a gesture is what iOS needs for that
      afterRec: function () {
        applyVolume(); paint();
        if (playing && mode === 'rtc' && rau.paused) {     // 1.99il: the WebRTC player, the same way
          var rp = rau.play(); if (rp && rp.catch) rp.catch(function () { setState('tap ▶ to resume', ''); });
        } else if (playing && mode === 'mp3' && startedAt && au.paused) {          // (still cushioning: start() plays it)
          au.play().then(function () { setState('LIVE', 'live'); })
            .catch(function () { setState('tap ▶ to resume', ''); playing = false; paint(); });
        }
      },
    };
    shared.players.push(me);
    box.rbDebug = function () {                 // for diagnosing "I can't hear it" from the console
      var lvl = null;
      if (analyser) { var d = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(d); lvl = Math.max.apply(null, d); }
      var sess = null; try { sess = navigator.audioSession ? navigator.audioSession.type : null; } catch (e) { sess = null; }
      return { ios: IOS, mse: useMse, mode: mode, rtc: !!rtcSess, session: sess, ctx: shared.ctx ? shared.ctx.state : null, meter: !!analyser, level: lvl, t: au.currentTime,
        ahead: ahead(), rate: au.playbackRate, paused: au.paused, muted: au.muted, volume: au.volume, userMuted: userMuted, userVol: userVol };
    };
    var painted = false, offWhy = null;
    function offReason(d) {
      if (d && d.room && d.room.live === false) return 'room offline';
      // 1.99ia: switched on but not streaming (e.g. loopback mode streams only the audio room) - say why
      return d && d.room && d.room.audioWhy ? 'audio unavailable: ' + String(d.room.audioWhy).slice(0, 120) : 'audio relay off';
    }
    function enable(on) {
      box.classList.toggle('off', !on);
      [play, mute, vol].forEach(function (x) { x.disabled = !on; });
    }
    return {
      // play another pad's audio in this player (or stop it when that pad is already playing); returns
      // whether it is playing now. The pad's own updates are ignored while it plays someone else.
      listen: function (s, name) {
        if (playing && cur === s) { stop(); store('patvRoomAudio', 0); return false; }
        if (playing) stop();
        if (cur !== s) rtcHint = null;                 // another pad: the site's ticket decides
        cur = s; curName = s === home ? null : (name || s);
        box.classList.remove('hide'); enable(true); play.title = '';
        start();
        if (curName) setState('connecting to ' + curName + '…', 'wait');
        notify();
        return true;
      },
      playingSlug: function () { return playing ? cur : null; },
      onChange: function (f) { listeners.push(f); },
      update: function (d) {
        if (cur !== home && playing) return;          // playing another pad: that pad's state isn't this one's
        if (cur !== home) { cur = home; curName = null; painted = false; }
        var on = !!(d && d.room && d.room.audio);
        rtcHint = d && d.room && typeof d.room.rtc === 'boolean' ? d.room.rtc : null;   // 1.99il: try ⚡ first?
        var why = on ? null : offReason(d);
        if (painted && on === available && why === offWhy) return;
        var was = available;
        painted = true; available = on; offWhy = why;
        box.classList.toggle('hide', !on && !showOff);
        enable(on);
        play.title = on ? '' : (why === 'room offline' ? 'The Camfrog room isn\'t live right now' : 'The room\'s audio relay is off (an admin turns it on with !bridge audio on)');
        if (!on) { if (was) stop(); setState('🔇 ' + why, ''); }
        else if (store('patvRoomAudio') === '1') setState('▶ to resume listening', '');
        else setState('Room audio', '');
      },
    };
  }

  // ── chat relay box ──
  // A line starting with "!" is a command: Pepe runs it in the room as your linked Camfrog name, with
  // the same permissions and prices as typing it there (1.99). Typing "!" opens a list of the room's
  // allowed commands (with prices); "!commands" lists them all. Answers Pepe would have PM'd show
  // here, for you only; public answers land in the room feed.
  function relay(host, slug) {
    var form = el('form', 'rb-say hide'); form.setAttribute('autocomplete', 'off');
    var lab = el('label', 'rb-sr', 'Message or !command to the Camfrog room'); lab.htmlFor = 'rbSay' + slug;
    var wrap = el('div', 'rb-say-in');
    var inp = el('input'); inp.id = 'rbSay' + slug; inp.type = 'text'; inp.maxLength = 300; inp.required = true;
    inp.placeholder = 'Say something — Pepe relays it as “🌐 you (web)”';
    inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-expanded', 'false');
    var list = el('ul', 'rb-ac hide'); list.id = 'rbAc' + slug; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Commands');
    inp.setAttribute('aria-controls', list.id);
    wrap.appendChild(inp); wrap.appendChild(list);
    var btn = el('button', 'rb-btn rb-send', 'Send'); btn.type = 'submit';
    var hint = el('div', 'rb-hint hide', 'Type !commands to see what you can run here as your Camfrog name.');
    var mine = el('div', 'rb-mine'); mine.setAttribute('aria-live', 'polite');
    var feed = el('ul', 'rb-cmdfeed'); feed.setAttribute('aria-live', 'polite'); feed.setAttribute('aria-label', 'Your commands');
    form.appendChild(lab); form.appendChild(wrap); form.appendChild(btn);
    host.appendChild(form); host.appendChild(hint); host.appendChild(mine); host.appendChild(feed);
    var last = '', lastJs = [], cmds = null, local = [], acIdx = -1, acItems = [];

    function fmtPrice(n) { return n > 0 ? Number(n).toLocaleString('en-US') + ' PAT' : ''; }
    function closeAc() { list.classList.add('hide'); list.textContent = ''; acItems = []; acIdx = -1; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); }
    function pick(c) { inp.value = c + ' '; closeAc(); inp.focus(); }
    function paintAc() {
      acItems.forEach(function (li, i) {
        var on = i === acIdx; li.classList.toggle('on', on); li.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) { inp.setAttribute('aria-activedescendant', li.id); if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); }
      });
    }
    function openAc() {
      var v = inp.value;
      if (!cmds || v.charAt(0) !== '!' || /\s/.test(v)) { closeAc(); return; }
      var q = v.toLowerCase();
      var names = Object.keys(cmds).concat(['!commands']).filter(function (c) { return c.indexOf(q) === 0; }).sort();
      // cheap ones first in the list's natural order; just cap it
      names = names.slice(0, 8);
      list.textContent = ''; acItems = [];
      if (!names.length || (names.length === 1 && names[0] === q)) { closeAc(); return; }
      names.forEach(function (c, i) {
        var li = el('li', 'rb-ac-it'); li.id = list.id + '-' + i; li.setAttribute('role', 'option');
        li.appendChild(el('span', 'rb-ac-c', c));
        var p = c === '!commands' ? 'list them all' : fmtPrice(cmds[c]);
        if (p) li.appendChild(el('span', 'rb-ac-p', p));
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(c); });
        list.appendChild(li); acItems.push(li);
      });
      acIdx = -1; list.classList.remove('hide'); inp.setAttribute('aria-expanded', 'true'); paintAc();
    }
    inp.addEventListener('input', openAc);
    inp.addEventListener('blur', function () { setTimeout(closeAc, 100); });
    inp.addEventListener('keydown', function (e) {
      if (list.classList.contains('hide') || !acItems.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = (acIdx + 1) % acItems.length; paintAc(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); acIdx = acIdx <= 0 ? acItems.length - 1 : acIdx - 1; paintAc(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && acIdx >= 0) { e.preventDefault(); pick(acItems[acIdx].firstChild.textContent); }
      else if (e.key === 'Escape') { closeAc(); }
    });

    function renderFeed(js) {
      feed.textContent = '';
      var rows = local.concat(js.filter(function (x) { return x.kind === 'cmd'; }).map(function (j) {
        var st = j.state !== 'done' ? 'waiting for Pepe…' : (j.ok ? (j.replies && j.replies.length ? '' : (j.msg || 'done')) : 'not run — ' + (j.msg || 'refused'));
        return { at: j.at, text: j.text, st: st, ok: j.state === 'done' ? j.ok : null, replies: j.replies || [] };
      })).sort(function (a, b) { return a.at - b.at; }).slice(-4);
      rows.forEach(function (r) {
        var li = el('li', 'rb-cmd' + (r.ok === false ? ' bad' : ''));
        var head = el('div', 'rb-cmd-h');
        head.appendChild(el('span', 'rb-cmd-t', '› ' + r.text));
        if (r.st) head.appendChild(el('span', 'rb-cmd-s', r.st));
        li.appendChild(head);
        r.replies.forEach(function (t) { li.appendChild(el('div', 'rb-cmd-r', '🔒 ' + t)); });
        feed.appendChild(li);
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      closeAc();
      var text = inp.value.trim(); if (!text) return;
      var isCmd = text.charAt(0) === '!';
      btn.disabled = true;
      fetch('/api/rooms/' + encodeURIComponent(slug) + '/say', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ text: text }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.ok && d.local) { inp.value = ''; local.push({ at: Date.now(), text: text, st: '', ok: true, replies: [d.reply || ''] }); local = local.slice(-2); renderFeed(lastJs); return; }
          if (d.ok) { inp.value = ''; if (!isCmd) mine.textContent = '💬 your message: waiting for Pepe…'; return; }
          if (isCmd) { local.push({ at: Date.now(), text: text, st: 'not sent — ' + (d.error || 'refused'), ok: false, replies: [] }); local = local.slice(-2); renderFeed(lastJs); }
          else mine.textContent = '💬 ' + (d.error || 'not sent');
        })
        .catch(function () { mine.textContent = '💬 couldn\'t reach the site'; })
        .then(function () { setTimeout(function () { btn.disabled = false; }, isCmd ? 1500 : 3000); });
    });
    return {
      update: function (d) {
        form.classList.toggle('hide', !(d && d.room && d.room.relay));
        cmds = d && d.room && d.room.cmds ? d.room.cmds : null;
        hint.classList.toggle('hide', !(cmds && d.room.relay));
        inp.placeholder = cmds ? 'Say something, or type ! for commands — relayed as “🌐 you (web)”' : 'Say something — Pepe relays it as “🌐 you (web)”';
        var js = (d && d.mine) || [], k = JSON.stringify(js);
        lastJs = js;
        if (k === last) return;
        last = k;
        var j = js.filter(function (x) { return x.kind === 'say'; }).pop();
        if (j) mine.textContent = '💬 your message: ' + (j.state === 'done' ? (j.ok ? (j.msg || 'sent') : 'not sent — ' + (j.msg || 'refused')) : 'waiting for Pepe…');
        renderFeed(js);
      },
    };
  }

  // ── push-to-talk clip: hold the button (or tap to start, tap again to send); 20 s max ──
  // What the clip line says for the user's latest clip job (mineFor). Pepe (1.99bk) acks the steps:
  // queued -> waiting (someone else holds the mic) -> playing -> done: "played", or not ok with
  // "couldn't get the mic ..." after a patient wait. Older Pepes ack once ("queued ...") then again
  // when it plays / is dropped - those messages still read right.
  function clipStatus(j) {
    if (!j) return '';
    var s = j.state, m = String(j.msg || '');
    if (s === 'pending' || s === 'claimed') return 'sent — waiting for Pepe…';
    if (s === 'queued') return 'queued for the mic…';
    if (s === 'waiting') return 'waiting for the mic…';
    if (s === 'playing') return 'playing on the mic now';
    if (j.ok) return m === 'played' ? 'played' : (m || 'sent');
    if (/couldn.t get the mic|stayed busy|dropped/i.test(m)) return 'couldn’t get the mic, try again';
    return 'not sent — ' + (m || 'refused');
  }

  function ptt(host, slug) {
    var box = el('div', 'rb-ptt hide');
    var btn = el('button', 'rb-btn rb-talk', '🎙 Hold to talk'); btn.type = 'button'; btn.setAttribute('aria-pressed', 'false');
    var txt = el('span', 'rb-ptt-txt', 'up to 20 s · Pepe plays it on the mic when it\'s free');
    txt.setAttribute('aria-live', 'polite');
    var mine = el('div', 'rb-mine'); mine.setAttribute('aria-live', 'polite');
    // 1.99bx: which mic (shown once the browser has named them - after the first clip - and only
    // when there's more than one). The pick is an "ideal" deviceId: a stale / unplugged one quietly
    // falls back to the default, so the iOS gesture timing below is untouched.
    var micSel = el('select', 'rb-micsel hide'); micSel.setAttribute('aria-label', 'Microphone for push-to-talk');
    box.appendChild(btn); box.appendChild(micSel); box.appendChild(txt);
    function listMics() {
      var md = navigator.mediaDevices;
      if (!md || !md.enumerateDevices) return;
      md.enumerateDevices().then(function (all) {
        var L = all.filter(function (d) { return d.kind === 'audioinput' && d.deviceId !== 'communications' && d.label; });
        micSel.textContent = '';
        L.forEach(function (d) { var o = el('option', null, d.label); o.value = d.deviceId; micSel.appendChild(o); });
        var cur = store('patvMicId');
        if (cur && L.some(function (d) { return d.deviceId === cur; })) micSel.value = cur;
        micSel.classList.toggle('hide', L.length < 2);
      }).catch(function () { /* no list: default mic */ });
    }
    micSel.addEventListener('change', function () { if (micSel.value) store('patvMicId', micSel.value); });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listMics);
    listMics();
    function micCons() {
      var c = { echoCancellation: true, noiseSuppression: true }, id = store('patvMicId');
      if (id) c.deviceId = { ideal: id };
      return c;
    }
    host.appendChild(box); host.appendChild(mine);
    var can = !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    var rec = null, stream = null, recAt = 0, recTimer = null, held = false, last = '';
    var opening = false, pressAt = 0, upAt = 0, tapMode = false;
    function idle() { btn.setAttribute('aria-pressed', 'false'); btn.textContent = '🎙 Hold to talk'; }
    // Every mic track stopped and the stream dropped (iOS keeps the page in play-and-record while any
    // track is alive), then the room player gets its playback session + the user's volume back.
    function release() {
      var s = stream; stream = null;
      if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* already ended */ } });
      recSession.after();
    }
    // Called from the gesture that ends the clip (pointerup / tap / key), so the release - and the room
    // player's resume - happen inside that gesture instead of later in MediaRecorder's onstop.
    function stop() {
      clearTimeout(recTimer);
      if (rec && rec.state === 'recording') { try { rec.stop(); } catch (e) { /* onstop still runs */ } }
      if (stream) release();
    }
    function send(chunks, mimeType, secs) {
      if (secs < 0.7) { txt.textContent = 'too short — hold the button while you talk'; return; }
      var blob = new Blob(chunks, { type: (mimeType || 'audio/webm').split(';')[0] });
      txt.textContent = 'sending ' + secs.toFixed(0) + 's…';
      fetch('/api/rooms/' + encodeURIComponent(slug) + '/clip', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': blob.type, 'x-clip-secs': secs.toFixed(1) }, body: blob })
        .then(function (r) { return r.json(); })
        .then(function (d) { txt.textContent = d.ok ? 'sent — Pepe plays it when the mic is free' : (d.error || 'not sent'); })
        .catch(function () { txt.textContent = 'couldn\'t reach the site'; });
    }
    function start() {
      if (rec && rec.state === 'recording') return stop();
      if (opening) return;                       // a second press while the browser is still opening the mic
      opening = true; pressAt = Date.now();
      recSession.before();
      txt.textContent = 'opening the microphone…';
      navigator.mediaDevices.getUserMedia({ audio: micCons() }).then(function (s) {
        opening = false;
        stream = s;
        if (micSel.classList.contains('hide') || !micSel.options.length) listMics();   // names are readable now
        // The press already ended while the browser opened the mic (first-time permission prompt, a
        // slow device). A HOLD that's over is not a recording - let the mic go at once. (Before
        // 1.99bk this recorded on for 20 s with the room ducked; the next press "fixed" it.)
        if ((upAt && upAt - pressAt > 400) || document.hidden || box.classList.contains('hide')) {
          release();
          txt.textContent = upAt ? 'keep holding until it says Recording, then talk' : 'up to 20 s · Pepe plays it on the mic when it\'s free';
          return;
        }
        var type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].filter(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); })[0] || '';
        var r, chunks = [], t0 = Date.now();
        try { r = new MediaRecorder(s, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined); }
        catch (e) { release(); txt.textContent = 'this browser can\'t record a clip'; return; }
        rec = r; recAt = t0;
        r.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        r.onstop = function () {
          if (stream === s) release();           // stopped some other way (track ended, page hidden)
          idle();
          send(chunks, r.mimeType, (Date.now() - t0) / 1000);
        };
        r.start(250);
        tapMode = !!upAt;                        // a quick tap started it: tap again to send
        btn.setAttribute('aria-pressed', 'true');
        btn.textContent = tapMode ? '⏺ Recording — tap to send' : '⏺ Recording — release to send';
        txt.textContent = 'recording…';
        recTimer = setTimeout(stop, 20000);
      }).catch(function () { opening = false; release(); txt.textContent = 'the browser didn\'t allow the microphone'; });
    }
    function up() {
      if (!held) return;
      held = false; upAt = Date.now();
      if (!rec || rec.state !== 'recording' || tapMode) return;
      if (Date.now() - recAt > 400) stop();
      else { tapMode = true; btn.textContent = '⏺ Recording — tap to send'; }
    }
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); held = true; upAt = 0; start(); });
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });   // iOS / Android long-press menu
    btn.addEventListener('keydown', function (e) { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); upAt = 1; start(); } });
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); });
    return {
      update: function (d) {
        var on = !!(d && d.room && d.room.micRelay) && can;
        box.classList.toggle('hide', !on);
        if (!on) stop();
        var js = (d && d.mine) || [], k = JSON.stringify(js);
        if (k === last) return;
        last = k;
        var j = js.filter(function (x) { return x.kind === 'clip'; }).pop();
        mine.textContent = j ? '🎙 your clip: ' + clipStatus(j) : '';
      },
    };
  }

  window.PATVRoom = { audio: audio, relay: relay, ptt: ptt, clipStatus: clipStatus, _ios: IOS };
})();
