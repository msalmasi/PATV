// room-bridge.js — shared pieces of the Camfrog room bridge UI, used by the room page (views/room.ejs)
// and the homepage's live room panel (views/home.ejs):
//   PATVRoom.audio(el, slug)   mini player for the room's live audio (play/pause, volume + mute,
//                              live / buffering state, jump to live, level meter, "⚡ live" / "standard"); .listen(slug, name)
//                              switches it to another pad (the homepage's 🎧 buttons). One room plays
//                              at a time across every player on the page.
//   PATVRoom.relay(el, slug)   the "say something" box (Pepe relays it into the room as "🌐 you (web)");
//                              a "!" line is a command Pepe runs as your Camfrog name (autocomplete + your private answers)
//   PATVRoom.ptt(el, slug)     hold-to-talk: a voice clip Pepe plays on the room's mic when it's free; shown only while
//                              the room's bridge_mic switch is on. Its max length is the site's (/admin/bridge "Push-to-talk
//                              clips", 30 s by default) - the live view's room.pttMax (pttlimits). Letting go keeps recording
//                              room.pttTail ms more (relaymic 1.99??: the release tail, so the last word is in the clip)
//   .useToast(fn)             (ptt and relay, ptttoast 1.99ana) the Room Dock hands in its chat card's notices: every status
//                              line under the composer goes there instead (fn(text, {id, ms, bad, busy, sticky}); '' with the id =
//                              take it down; busy = a step on the way, sticky = a state that lasts until '')
//   PATVRoom.clipStatus(job)   the clip line's text for a clip job's state (queued / waiting for the mic /
//                              playing / played / couldn't get the mic) - also used by the tests
// The player and push-to-talk share the page's audio session - see "the page's audio session" below
// for how iOS Safari's play-and-record switch is handled (1.99bk).
// All are driven by the live view JSON: call .update(d) with each poll result.
// Everything user-visible goes in via textContent.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
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
  var RTC_JITTER_MS = 200;                   // 1.99ya: the ⚡ player's jitter buffer target (webrtc-client.js listen);
                                             // 1.99yd: the ticket's jitter_ms (the site's /admin/pepe/audio setting) wins
  var RTC_REJOIN_MS = [2500, 6000, 15000];   // 1.99yd: a ⚡ session lost mid-play (Pepe restarted his publish, e.g. a
                                             // room-audio settings change) plays MP3 at once and tries ⚡ again after these
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

  // ── micvad 1.99akk: real mic bars where the page can't measure the sound (owner 2026-11-05: "Real bars on iPhone too would be nice") ──
  // iOS plays the room through a plain element (no Web Audio - the session notes above), so it has no analyser. Two other sources:
  //   * the MP3 relay (MSE): the page asks for /p/:slug/audio?...&lv=1; the site (audiolv.js, its `levels` setting on) answers with
  //     framed records - [u8 type][u24 BE length][payload]: 1 = the MP3 bytes, 2 = Pepe's levels for the record before it,
  //     {h, a, d}: one hex digit per 100 ms (camfrog-bot pepe_audiolv - the room's loudness, nothing per speaker), d[0] starting a ms
  //     after the frame whose header is at byte h. The page walks the MP3 frame headers of everything it appends (the session starts
  //     on one), so it knows each header's media time - and reads the level at <audio>.currentTime: what you hear, never early.
  //   * ⚡ (WebRTC): the browser's own received audioLevel (getStats every 100 ms), when the ticket says levels: true.
  // Any doubt (a level record no frame chain matches, a dropped append, an old Pepe, the setting off, stale numbers) falls back to
  // 1.99akf. A new encoder mid-stream (Pepe restarted, the bitrate changed: the old stream's last frame is cut short) is no doubt -
  // the walk finds its way back the way the decoder does (lvScan) and the level records are pinned again (review fix).
  var LV_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  var LV_KBPS1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  var LV_KBPS2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  var LV_REC_MAX = 1048576, LV_RING_MAX = 200, LV_RESYNC_MAX = 20;
  function lvHeader(b) {               // 4 header bytes -> {size, spf, rate} | null (pepe_audiolv.header's table)
    var h = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
    var ver = (h >>> 19) & 3, layer = (h >>> 17) & 3, bri = (h >>> 12) & 15, sri = (h >>> 10) & 3;
    if ((h >>> 21) !== 0x7ff || ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;
    var rate = LV_RATES[ver][sri], k = (ver === 3 ? LV_KBPS1 : LV_KBPS2)[bri];
    return { size: Math.floor((ver === 3 ? 144 : 72) * k * 1000 / rate) + ((h >>> 9) & 1), spf: ver === 3 ? 1152 : 576, rate: rate };
  }
  function lvSession() {
    return { part: null, skip: 0, hp: [], T: 0, first: null, tFirst: null, hs: [], hsT: [], p: null, scan: false, resyncs: 0,
      ring: [], bad: false, raw: false, recs: 0, hitT: null, t0: null };
  }
  // A decoder that loses the frame chain (a frame cut short by a new encoder) looks for the next header that 3 frames in a row
  // confirm - Chromium's MP3 parser does exactly this - and plays on at the media time it had. -> that header's offset | -1
  // (at the record's end a shorter chain that runs past it counts: the next record's walk checks the rest)
  function lvScan(p, from) {
    for (var c = Math.max(0, from); c + 4 <= p.length; c++) {
      if (p[c] !== 0xff) continue;
      var pos = c, n = 0, hd;
      while (n < 3 && pos + 4 <= p.length && (hd = lvHeader(p.subarray(pos, pos + 4)))) { pos += hd.size; n++; }
      if (n === 3 || (n && pos + 4 > p.length)) return c;
    }
    return -1;
  }
  // the MP3 bytes of one type-1 record: first = where the first header STARTING in it is (null: none), tFirst = its media time;
  // hs / hsT = every header the walk went through in it and its media time (a level record is pinned to one of them)
  function lvWalk(L, p) {
    L.first = null; L.tFirst = null; L.hs = []; L.hsT = []; L.p = p;
    if (L.bad) return;
    var i = 0, n = p.length;
    if (L.scan) {                                      // lost at the end of the last record: still looking, as the decoder is
      var r0 = lvScan(p, 0);
      if (r0 < 0) return;
      L.scan = false; L.skip = 0; L.hp = []; i = r0;
    }
    while (i < n) {
      if (L.skip) { var k = Math.min(L.skip, n - i); i += k; L.skip -= k; continue; }
      var at = i - L.hp.length;                        // (< 0: the header began in the record before)
      while (L.hp.length < 4 && i < n) L.hp.push(p[i++]);
      if (L.hp.length < 4) break;
      var hd = lvHeader(L.hp); L.hp = [];
      if (!hd) {                                       // not a header: find the way back (the media time so far stands)
        if (++L.resyncs > LV_RESYNC_MAX) { L.bad = true; return; }
        var r = lvScan(p, Math.max(0, at + 1));
        if (r < 0) { L.scan = true; return; }
        i = r; continue;
      }
      if (at >= 0) { L.hs.push(at); L.hsT.push(L.T); if (L.first === null) { L.first = at; L.tFirst = L.T; } }
      L.T += hd.spf / hd.rate; L.skip = hd.size - 4;
    }
  }
  // the media time of the frame at byte h of the last record: a header the walk went through, or - the frames a decoder skipped
  // while it found its way back (the new stream's first ones, swallowed by the cut-short frame) - counted back from the first
  // header both chains share. null: no such chain (not the stream we counted)
  function lvPin(L, h) {
    var x = L.hs.indexOf(h);
    if (x >= 0) return L.hsT[x];
    var p = L.p, pos = h, dur = 0, hd;
    for (var g = 0; p && g < 64 && pos + 4 <= p.length && (hd = lvHeader(p.subarray(pos, pos + 4))); g++) {
      dur += hd.spf / hd.rate; pos += hd.size;
      var y = L.hs.indexOf(pos);
      if (y >= 0) return L.hsT[y] - dur;
    }
    return null;
  }
  function lvText(p) {
    if (window.TextDecoder) { try { return new TextDecoder().decode(p); } catch (e) { /* below */ } }
    var s = ''; for (var i = 0; i < p.length; i++) s += String.fromCharCode(p[i]); return s;
  }
  // a type-2 record: Pepe's levels for the type-1 record just before it
  function lvLevels(L, p) {
    L.recs++;
    if (L.bad) return;
    var j = null; try { j = JSON.parse(lvText(p)); } catch (e) { j = null; }
    if (!j || typeof j !== 'object') { L.bad = true; return; }
    if (j.h == null) return;                                 // no header in that post: nothing to pin (and no digits)
    var tH = typeof j.h === 'number' ? lvPin(L, j.h) : null;
    if (tH === null || L.resyncs > LV_RESYNC_MAX) { L.bad = true; return; }   // not the stream we counted (a duplicate, an old Pepe)
    if (typeof j.d !== 'string' || !/^[0-9a-f]{1,64}$/.test(j.d) || typeof j.a !== 'number' || !isFinite(j.a)) return;
    L.ring.push({ g: tH + j.a / 1000, d: j.d });
    if (L.ring.length > LV_RING_MAX) L.ring.splice(0, L.ring.length - LV_RING_MAX);
  }
  // fetched bytes -> records (a partial one waits for the next read); mp3(bytes) gets each MP3 payload to append
  function lvFeed(L, chunk, mp3) {
    if (L.raw) { mp3(chunk); return; }
    var buf = chunk;
    if (L.part) { buf = new Uint8Array(L.part.length + chunk.length); buf.set(L.part, 0); buf.set(chunk, L.part.length); L.part = null; }
    var o = 0;
    while (buf.length - o >= 4) {
      var type = buf[o], len = (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
      if (len > LV_REC_MAX) { L.bad = true; L.raw = true; mp3(buf.subarray(o)); return; }
      if (buf.length - o - 4 < len) break;
      var p = buf.subarray(o + 4, o + 4 + len); o += 4 + len;
      if (type === 1) { lvWalk(L, p); mp3(p); } else if (type === 2) lvLevels(L, p);
    }
    if (o < buf.length) L.part = buf.slice(o);
  }
  // the level frame playing at media time t -> {v: 0..15, k: its index, end: the media time it ends} | null
  function lvAt(ring, t) {
    for (var x = ring.length - 1; x >= 0; x--) {
      var e = ring[x], i = Math.floor((t - e.g) * 10 + 1e-9);
      if (i >= 0 && i < e.d.length) return { v: parseInt(e.d.charAt(i), 16), k: Math.round(e.g * 10) + i, end: e.g + (i + 1) / 10 };
    }
    return null;
  }
  // the media time the next level after t starts | null
  function lvNext(ring, t) {
    var best = null;
    for (var x = 0; x < ring.length; x++) if (ring[x].g > t && (best === null || ring[x].g < best)) best = ring[x].g;
    return best;
  }
  // ⚡: the receiver's audioLevel (0..1, peak-ish) -> 0..15. libwebrtc lets the peak decay to a quarter per update once the sound
  // stops, so a drop to a third or less is silence at once (the stop shows ~190 ms after the audio, not ~400)
  function lvFromPeak(p, prev) {
    if (!(p >= 0.01) || (prev != null && p <= prev / 3)) return 0;
    return Math.max(1, Math.min(15, Math.round(1 + (20 * Math.log10(p) + 40) * 14 / 40)));
  }
  var LV_SHAPE = [0.55, 0.8, 1, 0.75, 0.6];
  // one value: the height is real, the left-to-right spread is cosmetic (it changes with the level frame, never per paint)
  function lvHeights(v, k) {
    return LV_SHAPE.map(function (s, i) {
      return v ? Math.max(3, Math.round(14 * v / 15 * s * (0.8 + 0.2 * ((((k * 7 + i * 3) % 5) + 5) % 5) / 4))) : 2;
    });
  }

  // ── room audio mini player ──
  // opts.showOff (the pad page): while the room's audio relay is off the player stays visible, greyed out,
  // saying why - instead of disappearing (1.99hj). The homepage keeps hiding it.
  function audio(host, slug, opts) {
    var showOff = !!(opts && opts.showOff);
    var home = slug, cur = slug, curName = null;     // the pad this player belongs to / the one it plays now
    var box = el('div', 'rb-audio hide');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', _t('js.pad.audio.room_audio', 'Room audio'));
    var play = el('button', 'rb-btn rb-play', '▶'); play.type = 'button'; play.setAttribute('aria-label', _t('js.pad.audio.listen', 'Listen live'));
    // 1.99ajf dockclean: opts.idle = the words while nobody plays it (the Room Dock: "▶ Listen to the room")
    var IDLE = opts && opts.idle ? String(opts.idle) : _t('js.pad.audio.room_audio', 'Room audio');
    var state = el('span', 'rb-state', IDLE);
    var modeEl = el('span', 'rb-mode hide');        // 1.99il: "⚡ live" (WebRTC) / "standard" (the MP3 relay)
    var meter = el('span', 'rb-meter'); meter.setAttribute('aria-hidden', 'true');
    var bars = [el('i'), el('i'), el('i'), el('i'), el('i')]; bars.forEach(function (b) { meter.appendChild(b); });
    var mute = el('button', 'rb-btn rb-mute', '🔊'); mute.type = 'button'; mute.setAttribute('aria-label', _t('js.pad.audio.mute', 'Mute'));
    var vol = el('input', 'rb-vol'); vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '5'; vol.setAttribute('aria-label', _t('js.pad.audio.volume', 'Volume'));
    var jump = el('button', 'rb-btn rb-jump hide', _t('js.pad.audio.jump', 'Jump to live')); jump.type = 'button';
    var au = el('audio'); au.preload = 'none'; au.setAttribute('playsinline', '');
    // 1.99il: the WebRTC stream plays in its own element (never routed through Web Audio - the meter only taps it)
    var rau = el('audio'); rau.setAttribute('playsinline', ''); rau.autoplay = true;
    // dock3 (owner 2026-11-05 item 2: "the mic indicator in mobile ... the one with the bars like we have in desktop") 1.99akf: iOS has no
    // real level (no Web Audio there - the session notes) - the meter is marked rb-nolvl instead of an inline hide: hidden as before
    // everywhere (room-bridge.css), but the Room Dock draws it as the "someone's on the mic" bars (pad-dock.css .rmd-talk)
    if (IOS) { meter.classList.add('rb-nolvl'); vol.style.display = 'none'; }
    [play, state, modeEl, meter, mute, vol, jump, au, rau].forEach(function (x) { box.appendChild(x); });
    host.appendChild(box);

    var playing = false, startedAt = 0, analyser = null, raf = null, available = false;
    var mode = null, rtcSess = null, rtcAnalyser = null, startGen = 0, rtcHint = null;   // 1.99il
    var mp3Sound = false, rtcSound = false;    // 1.99??: connecting/cushioning is not audible playback
    // review fix: a short mid-stream stall keeps the sync (clearing it drained every cam and re-gated the mic stage); one
    // longer than STALL_MS clears it. Pause, ended, stop and a new start still clear at once. One timer per element, so a
    // late event on the other element never cancels it.
    var STALL_MS = 4000, stallTimers = { mp3: null, rtc: null };
    function unstall(kind) { clearTimeout(stallTimers[kind]); stallTimers[kind] = null; }
    function stalled(kind) {
      unstall(kind);
      if (!(kind === 'mp3' ? mp3Sound : rtcSound)) return;
      stallTimers[kind] = setTimeout(function () {
        stallTimers[kind] = null;
        if (kind === 'mp3') mp3Sound = false; else rtcSound = false;
        syncAudio();
      }, STALL_MS);
    }
    function syncAudio() {
      if (window.PATVAvSync) window.PATVAvSync.audio({ slug: cur, playing: !!(playing && (mode === 'rtc' ? rtcSound && rtcSess : mode === 'mp3' && mp3Sound)), mode: mode, pc: rtcSess && rtcSess.pc, ahead: ahead });
    }
    function syncTitle() {
      var ms = window.PATVAvSync ? window.PATVAvSync.latency(cur, mode) : null;
      modeEl.title = ms != null && isFinite(ms) ? (mode === 'rtc' ? _t('js.pad.audio.mode_rtc_measured', 'Low latency (WebRTC): about {s} s behind the room', { s: (ms / 1000).toFixed(1) })
        : mode === 'mp3' ? _t('js.pad.audio.mode_mp3_measured', 'Standard relay: about {s} s behind the room', { s: (ms / 1000).toFixed(1) }) : '')
        : mode === 'rtc' ? _t('js.pad.audio.mode_rtc_title', 'Low latency (WebRTC): about half a second behind the room')
        : mode === 'mp3' ? _t('js.pad.audio.mode_mp3_title', 'Standard relay: about 1.5 s behind the room') : '';
    }
    if (window.PATVAvSync) { window.PATVAvSync.decorate(box); window.PATVAvSync.onChange(syncTitle); }
    var v0 = Number(store('patvRoomVol')); vol.value = isFinite(v0) && store('patvRoomVol') !== null ? Math.max(0, Math.min(100, v0)) : 80;
    // What the USER set. The only source of truth for volume / mute - see the session notes above.
    var userVol = vol.value / 100, userMuted = store('patvRoomMuted') === '1';
    // Viewer-selected recording ducking: transient attenuation never replaces the saved slider value.
    var duckOn = false, recording = false, DUCK_LEVEL = 0.2;
    function applyVolume() {
      [au, rau].forEach(function (x) {            // 1.99il: both players (MP3 relay / WebRTC) follow the user's volume + mute
        x.muted = userMuted;
        if (!IOS) { try { x.volume = userVol * (duckOn && recording ? DUCK_LEVEL : 1); } catch (e) { /* read-only */ } }
      });
    }
    function setMode(m) {
      mode = m;
      modeEl.classList.toggle('hide', !m);
      modeEl.classList.toggle('rtc', m === 'rtc');
      modeEl.textContent = m === 'rtc' ? _t('js.pad.audio.mode_rtc', '⚡ live') : m === 'mp3' ? _t('js.pad.audio.mode_mp3', 'standard') : '';
      syncAudio(); syncTitle();
    }
    applyVolume();
    function paint() {
      play.textContent = playing ? '❚❚' : '▶';
      play.setAttribute('aria-label', playing ? _t('js.pad.audio.pause', 'Pause room audio') : _t('js.pad.audio.listen', 'Listen live'));
      play.setAttribute('aria-pressed', playing ? 'true' : 'false');
      mute.textContent = userMuted || (!IOS && userVol === 0) ? '🔇' : '🔊';
      mute.setAttribute('aria-label', userMuted ? _t('js.pad.audio.unmute', 'Unmute') : _t('js.pad.audio.mute', 'Mute'));
      mute.setAttribute('aria-pressed', userMuted ? 'true' : 'false');
      box.classList.toggle('on', playing);
    }
    function setState(t, cls) { state.textContent = t; state.className = 'rb-state' + (cls ? ' ' + cls : ''); }
    // dock3 1.99akf: rb-lvl = the bars show a REAL level right now (an analyser while playing); without it the Room Dock animates them while
    // someone holds the mic (iOS, paused, no analyser - pad-dock.css). Toggled only when it changes (this runs every frame).
    var lvlOn = false;
    function lvl(on) { on = !!on; if (on === lvlOn) return; lvlOn = on; meter.classList.toggle('rb-lvl', on); }
    // micvad 1.99akk: where the level comes from right now - 'an' (an analyser), 'lv' (Pepe's levels, MP3), 'st' (⚡ getStats), ''
    var lvSrcNow = '', lvDrawn = null, auWait = false, rauWait = false, rauSoundAt = 0, stPoll = null, rtcLevels = false, lvTimer = null;
    function lvSrc(s) { if (s === lvSrcNow) return; lvSrcNow = s; meter.setAttribute('data-lv', s); }
    function lvBars(h, held) { bars.forEach(function (b) { b.style.height = h; b.style.animation = held ? 'none' : ''; b.style.transform = held ? 'none' : ''; }); }
    function lvClear() {
      if (lvDrawn === null) return;
      lvDrawn = null; lvBars('', false);
    }
    function lvDraw(r) {
      var key = r.v + ':' + (r.v ? r.k : 0);
      if (key === lvDrawn) return;                      // heights change only with the level frame
      if (lvDrawn === 'quiet') lvBars('', false);
      lvDrawn = key;
      var hs = lvHeights(r.v, r.k);
      for (var i = 0; i < bars.length; i++) bars[i].style.height = hs[i] + 'px';
    }
    // review fix: before the first real level (connecting, the first moments of sound) the bars are held flat WITHOUT rb-lvl - where
    // the Dock shows the meter (someone holds the mic) flat dots instead of a flash of 1.99akf's animation; where it hides it (iPhone,
    // nobody on the mic) it stays hidden, so nothing appears just to vanish again (the bar's words never jump)
    function lvQuiet() {
      if (lvDrawn === 'quiet') return;
      lvDrawn = 'quiet'; lvBars('2px', true);
    }
    var LV_REST = { v: 0, k: 0 };
    // is a non-analyser level on its way (so the loop runs)? 'lv' | 'st' | ''
    function lvWanted() {
      if (!playing || reduce) return '';
      if (mode === 'mp3' && mse && mse.lvReq && mse.lv !== null && !(mse.lv && mse.lv.bad)) return 'lv';
      if (mode === 'rtc' && stPoll && rtcSess) return 'st';
      return '';
    }
    function lvMs(s) { return Math.max(10, Math.min(1000, Math.ceil(s * 1000 - 1e-6) + 2)); }   // (+2 ms: past the edge, not on it)
    // Pepe's level now -> {s: 'lv' (r: the level) | 'rest' (flat, rb-lvl: a moment without one) | 'quiet' (flat, no rb-lvl: none yet)
    // | '' (1.99akf's bars), wake: ms until it can change | null (only new data can change it)}. review fix: "a moment" is MEDIA
    // time - while the audio stalls nothing is audible and its clock stops, so the bars rest however long it lasts
    function lvNow() {
      var L = mse && mse.lv;
      if (L === undefined) return { s: 'quiet', wake: 100 };          // asked for levels, the answer's headers aren't in yet
      if (!L || L.bad) return { s: '', wake: null };
      var t = au.currentTime, rate = au.playbackRate > 0 ? au.playbackRate : 1;
      while (L.ring.length && L.ring[0].g + L.ring[0].d.length / 10 < t - 1) L.ring.shift();   // (played more than 1 s ago)
      // (not audible - connecting, buffering: 'playing' kicks it; the slow wake is only a safety net)
      if (!mp3Sound || auWait) return { s: L.hitT === null ? 'quiet' : 'rest', wake: 250 };
      if (L.t0 === null) L.t0 = t;
      var r = lvAt(L.ring, t);
      if (r) { L.hitT = t; return { s: 'lv', r: r, wake: lvMs((r.end - t) / rate) }; }
      var nx = lvNext(L.ring, t), wake = nx === null ? null : lvMs((nx - t) / rate);
      if (L.hitT !== null ? t - L.hitT <= 1 : t - L.t0 <= 1.5) return { s: L.hitT === null ? 'quiet' : 'rest', wake: wake === null ? 100 : Math.min(wake, 100) };
      return { s: '', wake: wake };
    }
    // ⚡: each poll draws at once (lvKick); the wake only notices a poll that didn't come
    function stNow() {
      var P = stPoll, now = Date.now();
      if (!P) return { s: '', wake: null };
      if (rtcSound && !rauWait && P.at && now - P.at <= 400) { P.hitAt = now; return { s: 'lv', r: { v: P.v, k: P.n }, wake: 450 }; }
      var soundAt = rtcSound ? rauSoundAt : 0;
      if (P.hitAt ? now - P.hitAt <= 1000 : (!soundAt || now - soundAt <= 1500)) return { s: P.hitAt ? 'rest' : 'quiet', wake: 100 };
      return { s: '', wake: null };
    }
    // new data (a level record, a poll, the audio starting / stalling): look now. Not while an analyser's animation-frame loop runs
    function lvKick() { if (playing && raf === null) meterLoop(); }
    // review fix: the document the player shows in is hidden (a background tab; the Dock's own window has its own document -
    // ownerDocument, not the page's) - nothing to see: no drawing, no ⚡ polls (and no misses counted)
    var lvAway = false;
    function lvHidden() { var d = box.ownerDocument || document; return !!(d && d.hidden); }
    function meterLoop() {
      cancelAnimationFrame(raf); raf = null; clearTimeout(lvTimer); lvTimer = null;   // (one loop, however often it's kicked)
      var an = mode === 'rtc' ? rtcAnalyser : analyser;
      if (!an || !playing) {
        // micvad review fix: Pepe's levels change 10 times a second and a poll 10 times a second - a timer at the next change
        // (never every display frame), parked while nothing can change and while the page is hidden
        var want = lvWanted();
        if (want && lvHidden()) { lvAway = true; lvTimer = setTimeout(meterLoop, 1000); return; }   // (a slow look until it shows)
        // shown again: a fresh moment of rest until the next poll - not a flash of 1.99akf's bars for polls that couldn't come
        if (lvAway) { lvAway = false; if (stPoll && stPoll.hitAt) stPoll.hitAt = Date.now(); }
        var x = want === 'lv' ? lvNow() : want === 'st' ? stNow() : { s: '', wake: null };
        var real = x.s === 'lv' || x.s === 'rest';
        lvSrc(real ? want : ''); lvl(real);
        if (x.s === 'lv') lvDraw(x.r); else if (x.s === 'rest') lvDraw(LV_REST); else if (x.s === 'quiet') lvQuiet(); else lvClear();
        if (want && x.wake !== null) lvTimer = setTimeout(meterLoop, x.wake);
        return;
      }
      if (lvDrawn === 'quiet') lvBars('', false);
      lvSrc('an'); lvl(true); lvDrawn = 'an';
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
        // 1.99zc (Safari): createMediaElementSource routes the element THROUGH the context - a context that isn't
        // running (made / resumed outside a tap: Safari has no sticky activation for Web Audio) plays it SILENTLY,
        // for good. No meter then; the element plays straight to the speakers.
        if (c.state !== 'running' && !shared.unlocked) return;
        var src = c.createMediaElementSource(au);       // same-origin stream, so no CORS issue
        analyser = c.createAnalyser(); analyser.fftSize = 64;
        src.connect(analyser); analyser.connect(c.destination);
      } catch (e) { analyser = null; }
    }
    // The room arrives in ~0.25 s pieces in real time (1.99hp), so playing the moment the first bytes land
    // means stuttering. Fill a small cushion first (CUSHION s of audio, or give up waiting after 20 s and
    // play what there is), then play. 1.99hq: 0.75 s (was 2.5 s) + live-edge catch-up below.
    var CUSHION = 0.75, waitTimer = null;
    // Live edge. 1.99ya: the old 1.05x / 0.96x pitch-kept rate nudges (every time the buffer wandered past 1.3 s /
    // under 0.3 s) were a warble you could hear - the time-stretcher's artefacts, switched on and off all the time.
    // Now: only a real backlog is caught up - more than EDGE_HI s ahead -> 1.02x (pitch follows, no stretcher: a
    // barely-there 1/3 semitone) until back under EDGE_LO; more than EDGE_JUMP ahead -> jump to EDGE_KEEP s before
    // the newest audio. Never slowed down: a short buffer just waits for the next chunk.
    var EDGE_LO = 1.0, EDGE_HI = 2.0, EDGE_JUMP = 4, EDGE_KEEP = 0.8, RATE_UP = 1.02;
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
    function mseStart(url, lvReq) {
      // micvad 1.99akk: lvReq = asked for Pepe's levels (&lv=1); m.lv = undefined until the answer says (X-Audio-Frames: 1 -> a
      // session, else null: plain MP3 - an old site, the setting off)
      var m = mse = { ctl: window.AbortController ? new AbortController() : { abort: function () {}, signal: undefined }, q: [], sb: null,
        lvReq: !!lvReq, lv: lvReq ? undefined : null };
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
        } catch (e) { if (e && e.name === 'QuotaExceededError') { m.q.length = 0; if (m.lv) { m.lv.bad = true; lvKick(); } } }   // (frames dropped: no levels)
      }
      ms.addEventListener('sourceopen', function () {
        if (mse !== m) return;
        try { m.sb = ms.addSourceBuffer('audio/mpeg'); } catch (e) { stop(_t('js.pad.audio.cant_play', 'this browser can\'t play the room audio')); return; }
        m.sb.addEventListener('updateend', pump);
        fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: m.ctl.signal }).then(function (r) {
          if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
          var hdr = null; try { hdr = r.headers && r.headers.get ? r.headers.get('X-Audio-Frames') : null; } catch (e) { hdr = null; }
          m.lv = m.lvReq && hdr === '1' ? lvSession() : null;
          if (m.lvReq) lvKick();                          // (not framed: 1.99akf's bars at once)
          var rd = r.body.getReader();
          function append(b) { m.q.push(b); }
          function next() {
            return rd.read().then(function (x) {
              if (mse !== m) { try { rd.cancel(); } catch (e) { /* gone */ } return; }
              if (x.done) { if (playing) stop(_t('js.pad.audio.stopped', 'audio stopped — ▶ to retry')); return; }
              var L = m.lv;
              if (L) {
                var n0 = L.recs, b0 = L.bad;
                lvFeed(L, x.value, append);
                if (L.recs !== n0 || L.bad !== b0) lvKick();   // (a level record: the loop may be parked)
              } else m.q.push(x.value);
              pump();
              return next();
            });
          }
          return next();
        }).catch(function () { if (mse === m && playing) stop(_t('js.pad.audio.stopped', 'audio stopped — ▶ to retry')); });
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
    // micvad 1.99akk: ⚡ without an analyser (iPhone) - the receiver's own audioLevel every 100 ms while the ticket says levels: true.
    // No numeric level (or totalSamplesDuration stuck) 3 polls running: given up for this session (1.99akf's bars).
    function stStop() { var P = stPoll; stPoll = null; if (P) clearInterval(P.timer); }
    function stStart() {
      stStop();
      var sess = rtcSess;
      if (rtcAnalyser || reduce || !rtcLevels || !sess || !sess.pc || typeof sess.pc.getStats !== 'function') return;
      var P = stPoll = { timer: null, pending: false, prev: null, miss: 0, tsd: null, v: 0, n: 0, at: 0, hitAt: 0 };
      function miss() { if (++P.miss >= 3 && stPoll === P) { stStop(); lvKick(); } }
      function read(rep) {
        var level = null, tsd = null;
        try {
          rep.forEach(function (s) {
            var audio = s.kind === 'audio' || s.mediaType === 'audio';
            if (s.type === 'inbound-rtp' && audio && typeof s.audioLevel === 'number') {
              level = s.audioLevel; if (typeof s.totalSamplesDuration === 'number') tsd = s.totalSamplesDuration;
            } else if (level === null && s.type === 'track' && s.remoteSource && audio && typeof s.audioLevel === 'number') {
              level = s.audioLevel; if (typeof s.totalSamplesDuration === 'number') tsd = s.totalSamplesDuration;     // older WebKit
            }
          });
        } catch (e) { level = null; }
        var stuck = tsd !== null && P.tsd !== null && !(tsd > P.tsd);
        if (tsd !== null) P.tsd = tsd;
        if (level === null || !isFinite(level) || stuck) { miss(); return; }
        P.miss = 0;
        P.v = lvFromPeak(level, P.prev); P.prev = level; P.n++; P.at = Date.now();
        lvKick();
      }
      P.timer = setInterval(function () {
        if (stPoll !== P || P.pending || lvHidden()) return;
        if (rtcSess !== sess) { stStop(); return; }
        var pr = null;
        try { pr = sess.pc.getStats(); } catch (e) { pr = null; }
        if (!pr || typeof pr.then !== 'function') { miss(); return; }
        P.pending = true;
        pr.then(function (rep) { P.pending = false; if (stPoll === P) read(rep); },
          function () { P.pending = false; if (stPoll === P) miss(); });
      }, 100);
    }
    function rtcClose() {
      stStop();
      var s = rtcSess; rtcSess = null; rtcAnalyser = null;
      rtcSound = false; unstall('rtc'); syncAudio();
      if (s) { try { s.close(); } catch (e) { /* gone */ } }
      try { rau.pause(); rau.srcObject = null; } catch (e) { /* no srcObject */ }
    }
    // ⚡: ticket -> WHEP; resolves when it plays, rejects with the reason (the caller falls back to MP3)
    var rejoinTimer = null, rejoinTries = 0;
    // 1.99yd: after a lost ⚡ session the MP3 relay plays; ⚡ is tried again quietly and takes over when it connects
    function rtcRejoin(gen) {
      clearTimeout(rejoinTimer);
      if (rejoinTries >= RTC_REJOIN_MS.length) return;
      rejoinTimer = setTimeout(function () {
        if (!playing || gen !== startGen || mode !== 'mp3' || !rtcWanted()) return;
        startRtc(gen, true).then(function () {
          clearInterval(waitTimer); rejoinTries = 0;
          mseStop();
          try { au.pause(); au.removeAttribute('src'); au.load(); } catch (e) { /* gone */ }
        }).catch(function (e) {
          if (rtcWhy(e) === 'stale' || gen !== startGen || !playing) return;
          if (!rtcSess) { try { rau.pause(); rau.srcObject = null; } catch (x) { /* no srcObject */ } }
          rtcRejoin(gen);
        });
      }, RTC_REJOIN_MS[rejoinTries++]);
    }
    function startRtc(gen, quiet) {
      return fetch('/api/rooms/' + encodeURIComponent(cur) + '/audio/rtc', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: '{}' })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) {
          if (gen !== startGen || !playing) throw 'stale';
          if (!j || !j.ok || !j.whep) throw (j && j.fallback) || 'error';
          rtcLevels = j.levels === true;                // micvad 1.99akk: the site's levels setting
          if (!quiet) setState(j.ready ? _t('js.pad.audio.connecting_rtc', 'connecting ⚡…') : _t('js.pad.audio.starting_rtc', 'starting ⚡…'), 'wait');
          var jit = Number(j.jitter_ms);
          return window.PATVRtc.listen(j.whep, rau, { timeout: RTC_TIMEOUT_MS, jitterMs: isFinite(jit) && jit >= 0 && jit <= 4000 ? jit : RTC_JITTER_MS });
        })
        .then(function (sess) {
          if (gen !== startGen || !playing) { sess.close(); throw 'stale'; }
          rtcSess = sess;
          setMode('rtc'); applyVolume(); wireRtcMeter(rau.srcObject); stStart();
          if (shared.ctx && shared.ctx.state === 'suspended') shared.ctx.resume();
          startedAt = Date.now(); setState(_t('js.pad.audio.live', 'LIVE'), 'live'); meterLoop();
          sess.onfail = function () {                 // lost after it started: carry on with the MP3 relay
            if (rtcSess !== sess) return;
            rtcSess = null; noteRtcFail('lost');
            if (playing && gen === startGen) { setState(_t('js.pad.audio.reconnecting', 'reconnecting…'), 'wait'); startMp3(); rtcRejoin(gen); }
          };
        });
    }
    // 1.99zc (Safari): unlock both players and the meter's AudioContext INSIDE the tap. WebKit only lets an element
    // play sound later (the MP3 relay starts after its cushion, from a timer; the ⚡ -> MP3 fallback after a fetch)
    // once play() was called on THAT element during a user gesture - so a play() + pause() here lifts the restriction.
    // Before, Safari answered the cushioned play() with NotAllowedError ("tap ▶ to listen") on every tap, for ever.
    function unlock() {
      var gesture = !navigator.userActivation || navigator.userActivation.isActive;
      if (!gesture) return;
      [au, rau].forEach(function (x) {
        if (x.getAttribute('src') || x.srcObject || !x.paused) return;
        try { var p = x.play(); if (p && p.catch) p.catch(function () { /* nothing to play yet */ }); x.pause(); } catch (e) { /* old engine */ }
      });
      if (!IOS) {
        var c = ctx();
        if (c && c.state !== 'running' && c.state !== 'closed') { try { var r = c.resume(); if (r && r.catch) r.catch(function () {}); } catch (e) { /* resumes later */ } }
        if (c) shared.unlocked = true;
      }
    }
    function start() {
      unlock();
      clearInterval(waitTimer); startedAt = 0;
      clearTimeout(rejoinTimer); rejoinTries = 0;
      shared.players.forEach(function (p) { if (p !== me) p.halt(); });   // one room at a time on the page
      var gen = ++startGen;
      rtcClose(); mseStop(); setMode(null);
      playing = true; paint(); store('patvRoomAudio', 1);
      if (rtcWanted()) {
        try { var pp = rau.play(); if (pp && pp.catch) pp.catch(function () {}); } catch (e) { /* unlock in the gesture (iOS) */ }
        setState(_t('js.pad.audio.connecting_rtc', 'connecting ⚡…'), 'wait');
        startRtc(gen).catch(function (e) {
          var why = rtcWhy(e);
          if (gen !== startGen || !playing || why === 'stale') return;
          noteRtcFail(why);
          rtcClose();
          startMp3();
        });
        notify();       // 1.99ajh dockpop: a start is news too (the Dock tells its other windows; the Top Pads 🎧 row lights)
        return;
      }
      startMp3();
      notify();
    }
    function startMp3() {
      clearInterval(waitTimer); startedAt = 0;
      mp3Sound = false; unstall('mp3');
      rtcClose(); setMode('mp3');
      au.preload = 'auto';
      wireMeter();
      // micvad 1.99akk: no analyser here (iPhone; a context Safari won't run) -> ask for Pepe's levels in the stream (MSE only: a plain
      // src can't read records; never under reduced motion - the still eq shape stays)
      var lvReq = useMse && !analyser && !reduce;
      var url = '/p/' + encodeURIComponent(cur) + '/audio?t=' + Date.now() + (lvReq ? '&lv=1' : '');
      mseStop();
      if (useMse) mseStart(url, lvReq);
      else { au.src = url; au.load(); }
      if (shared.ctx && shared.ctx.state === 'suspended') shared.ctx.resume();
      applyVolume();
      playing = true; paint(); store('patvRoomAudio', 1);
      setState(_t('js.pad.audio.connecting', 'connecting…'), 'wait');
      if (lvReq) meterLoop();                         // (flat bars while it buffers - no animated flash before the real level)
      var t0 = Date.now(), lastGot = 0, grewAt = Date.now();
      waitTimer = setInterval(function () {
        if (!playing) { clearInterval(waitTimer); return; }
        var got = ahead();
        if (got > 0.2) setState(_t('js.pad.audio.buffering', 'buffering {pct}%', { pct: Math.min(100, Math.round(got / CUSHION * 100)) }), 'wait');
        // a paused element stops fetching after a couple of seconds - so "it stopped growing" counts as full too
        if (got > lastGot + 0.05) { lastGot = got; grewAt = Date.now(); }
        var full = got >= CUSHION || (got > 0.3 && Date.now() - grewAt > 1500);
        if (!full && Date.now() - t0 < 20000) return;
        clearInterval(waitTimer);
        if (got <= 0) { stop(_t('js.pad.audio.no_audio', 'no audio from the room right now — ▶ to retry')); return; }
        au.play().then(function () { startedAt = Date.now() - au.currentTime * 1000; meterLoop(); })
          .catch(function () { playing = false; paint(); setState(_t('js.pad.audio.tap_listen', 'tap ▶ to listen'), ''); });
      }, 250);
    }
    function stop(msg) {
      clearTimeout(rejoinTimer);
      playing = false; cancelAnimationFrame(raf); raf = null; clearTimeout(lvTimer); lvTimer = null; clearInterval(waitTimer); setRate(1);
      // (dock3 1.99akf: the last frame's inline heights go too - an inline height beats the Dock's animated bars, which run while paused)
      lvBars('', false); lvl(false);
      lvDrawn = null; lvSrc(''); auWait = false; rauWait = false;     // (micvad 1.99akk: the levels go with the fetch / the ⚡ session)
      mp3Sound = false; rtcSound = false; unstall('mp3'); unstall('rtc'); syncAudio();
      startGen++; rtcClose(); setMode(null);
      mseStop();
      au.pause(); au.removeAttribute('src'); au.load();
      jump.classList.add('hide'); paint(); setState(msg || (curName ? _t('js.pad.audio.named_audio', '{name} · audio', { name: curName }) : IDLE), '');
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
    au.addEventListener('waiting', function () { auWait = true; stalled('mp3'); if (playing) setState(_t('js.pad.audio.live_buffering', 'LIVE · buffering…'), 'wait'); lvKick(); });
    au.addEventListener('playing', function () { auWait = false; unstall('mp3'); mp3Sound = playing && mode === 'mp3'; syncAudio(); setState(_t('js.pad.audio.live', 'LIVE'), 'live'); lvKick(); });
    au.addEventListener('error', function () { if (playing && mode === 'mp3') stop(_t('js.pad.audio.stopped', 'audio stopped — ▶ to retry')); });
    rau.addEventListener('playing', function () { rauWait = false; rauSoundAt = Date.now(); unstall('rtc'); rtcSound = !!(playing && rau.srcObject); syncAudio(); if (playing && mode === 'rtc') setState(_t('js.pad.audio.live', 'LIVE'), 'live'); lvKick(); });
    ['pause', 'ended'].forEach(function (kind) {
      au.addEventListener(kind, function () { unstall('mp3'); mp3Sound = false; syncAudio(); });
      rau.addEventListener(kind, function () { unstall('rtc'); rtcSound = false; syncAudio(); });
    });
    rau.addEventListener('waiting', function () { rauWait = true; stalled('rtc'); lvKick(); });
    function setRate(r) {
      try {
        if (au.playbackRate === r) return;
        // 1.99ya: no pitch-kept time stretching (its artefacts were the warble) - a 2 % catch-up just plays faster
        try { au.preservesPitch = false; au.mozPreservesPitch = false; au.webkitPreservesPitch = false; } catch (e) { /* old engine */ }
        au.playbackRate = r;
      } catch (e) { /* fixed rate */ }
    }
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
      else if (au.playbackRate !== 1 && a <= EDGE_LO) setRate(1);
      var behind = (now - startedAt) / 1000 - au.currentTime;          // time lost to stalls (catch-up shrinks it)
      var lagging = behind >= 6 || a > EDGE_JUMP / 2;
      jump.classList.toggle('hide', behind < 6);
      if (lagging && state.textContent === _t('js.pad.audio.live', 'LIVE')) setState(_t('js.pad.audio.catching_up', 'LIVE · catching up…'), 'wait');
      else if (!lagging && state.textContent === _t('js.pad.audio.catching_up', 'LIVE · catching up…')) setState(_t('js.pad.audio.live', 'LIVE'), 'live');
    }
    var edgeTimer = setInterval(edge, 500);
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
          var rp = rau.play(); if (rp && rp.catch) rp.catch(function () { setState(_t('js.pad.audio.tap_resume', 'tap ▶ to resume'), ''); });
        } else if (playing && mode === 'mp3' && startedAt && au.paused) {          // (still cushioning: start() plays it)
          au.play().then(function () { setState(_t('js.pad.audio.live', 'LIVE'), 'live'); })
            .catch(function () { setState(_t('js.pad.audio.tap_resume', 'tap ▶ to resume'), ''); playing = false; paint(); });
        }
      },
    };
    shared.players.push(me);
    box.rbDebug = function () {                 // for diagnosing "I can't hear it" from the console
      var lvl = null;
      if (analyser) { var d = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(d); lvl = Math.max.apply(null, d); }
      var sess = null; try { sess = navigator.audioSession ? navigator.audioSession.type : null; } catch (e) { sess = null; }
      var L = mse && mse.lv;
      return { ios: IOS, mse: useMse, mode: mode, rtc: !!rtcSess, session: sess, ctx: shared.ctx ? shared.ctx.state : null, meter: !!analyser, level: lvl, t: au.currentTime,
        lv: { framed: !!L, bad: !!(L && L.bad), recs: L ? L.recs : 0, resyncs: L ? L.resyncs : 0, src: lvSrcNow, stats: !!stPoll, timer: lvTimer !== null },
        ahead: ahead(), rate: au.playbackRate, paused: au.paused, muted: au.muted, volume: au.volume, userMuted: userMuted, userVol: userVol };
    };
    var painted = false, offWhy = null;
    function offReason(d) {
      if (d && d.room && d.room.live === false) return _t('js.pad.audio.room_offline', 'room offline');
      // 1.99ia: switched on but not streaming (e.g. loopback mode streams only the audio room) - say why
      return d && d.room && d.room.audioWhy ? _t('js.pad.audio.unavailable', 'audio unavailable: {why}', { why: String(d.room.audioWhy).slice(0, 120) }) : _t('js.pad.audio.relay_off', 'audio relay off');
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
        start();                                       // (1.99ajh dockpop: start() tells the listeners now)
        if (curName) setState(_t('js.pad.audio.connecting_to', 'connecting to {name}…', { name: curName }), 'wait');
        return true;
      },
      playingSlug: function () { return playing ? cur : null; },
      // 1.99ajh dockpop: the chat window and the pad tab / homepage hand the room audio between them - pause() stops it without
      // forgetting that this viewer listens (patvRoomAudio stays 1: "▶ to resume listening"), resume() plays this player's own pad
      // again when it is idle and the relay is on (-> whether it started), isPlaying() asks
      pause: function () { if (!playing) return false; stop(); return true; },
      resume: function () {
        if (playing || !available) return false;
        if (cur !== home) { cur = home; curName = null; }
        start(); return true;
      },
      isPlaying: function () { return playing; },
      // 1.99ajq dockpol fix (review): the homepage swapping to a new front pad lets this player go - stopped, its 500 ms edge timer cleared and
      // out of the page's one-room-at-a-time list (each swap used to leave one behind)
      destroy: function () { if (playing) stop(); clearInterval(edgeTimer); var i = shared.players.indexOf(me); if (i >= 0) shared.players.splice(i, 1); listeners.length = 0; },
      duck: function (on) { if (arguments.length) { duckOn = !!on; applyVolume(); } return duckOn; },
      setRecording: function (on) { recording = !!on; applyVolume(); },
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
        play.title = on ? '' : (d && d.room && d.room.live === false ? _t('js.pad.audio.title_offline', 'The pad\'s chat room isn\'t live right now') : _t('js.pad.audio.title_relay_off', 'The room\'s audio relay is off (an admin turns it on with !bridge audio on)'));
        if (!on) { if (was) stop(); setState('🔇 ' + why, ''); }
        else if (store('patvRoomAudio') === '1') setState(_t('js.pad.audio.resume_listening', '▶ to resume listening'), '');
        else setState(IDLE, '');
      },
    };
  }

  // ── chat relay box ──
  // A line starting with "!" is a command: Pepe runs it in the room as your linked Camfrog name, with
  // the same permissions and prices as typing it there (1.99). Typing "!" opens a list of the room's
  // allowed commands (with prices); "!commands" lists them all. Answers Pepe would have PM'd show
  // here, for you only; public answers land in the room feed.
  //
  // 1.99ye: a native chat composer. With opts.feed (the page's chat list) + opts.line (the page's own line builder) a
  // message shows in the chat the moment you send it, in your own style, marked "🕓 sending…" (faded), then "✓ sent"
  // once Pepe has put it into the Camfrog room (his ack), and it is swapped for the room's own line when that comes back
  // (matched by the job's client id - never shown twice). A refusal turns it red with the reason and ↻ Retry / ✕.
  // The box never locks: type and send as many as you like - up to SAY_QUEUE wait at once; they go out in order, one
  // POST at a time (the server keeps the order, Pepe paces them for the room). A lost connection keeps them queued
  // ("waiting for connection…", the offline banner) and sends them when it's back; the client id makes a resend safe.
  // ↑ in an empty box takes back your last failed message to edit. A counter shows near Camfrog's line limit.
  var SAY_MAX = 300, SAY_QUEUE = 5, COUNT_FROM = 240, SETTLE_MS = 8000;
  function newCid() {
    var a = '', c = window.crypto || window.msCrypto;
    if (c && c.getRandomValues) { var b = new Uint8Array(12); c.getRandomValues(b); for (var i = 0; i < b.length; i++) a += ('0' + b[i].toString(16)).slice(-2); }
    else a = (Date.now().toString(16) + Math.random().toString(16).slice(2)).slice(0, 24);
    return 'c' + a;
  }
  function relay(host, slug, opts) {
    opts = opts || {};
    var feedEl = opts.feed || null, mkLine = typeof opts.line === 'function' ? opts.line : null;
    var form = el('form', 'rb-say hide'); form.setAttribute('autocomplete', 'off');
    var lab = el('label', 'rb-sr', _t('js.pad.relay.label', 'Message or !command to the chat room')); lab.htmlFor = 'rbSay' + slug;
    var wrap = el('div', 'rb-say-in');
    var inp = el('input'); inp.id = 'rbSay' + slug; inp.type = 'text'; inp.maxLength = SAY_MAX; inp.required = true;
    inp.placeholder = _t('js.pad.relay.placeholder', 'Say something — Pepe relays it as “🌐 you (web)”');
    inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-expanded', 'false');
    var list = el('ul', 'rb-ac hide'); list.id = 'rbAc' + slug; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', _t('js.pad.relay.commands', 'Commands'));
    inp.setAttribute('aria-controls', list.id);
    wrap.appendChild(inp); wrap.appendChild(list);
    var btn = el('button', 'rb-btn rb-send', _t('js.pad.relay.send', 'Send')); btn.type = 'submit';
    var count = el('span', 'rb-count hide'); count.setAttribute('aria-live', 'polite');
    var hint = el('div', 'rb-hint hide', _t('js.pad.relay.hint', 'Type !commands to see what you can run here as your linked chat name.'));
    var mine = el('div', 'rb-mine'); mine.setAttribute('aria-live', 'polite');
    var note = el('div', 'rb-note hide'); note.setAttribute('role', 'status');
    var offBar = el('div', 'rb-offline hide', _t('js.pad.relay.offline', 'You\'re offline — your messages will send when the connection is back.'));
    offBar.setAttribute('role', 'status');
    var feed = el('ul', 'rb-cmdfeed'); feed.setAttribute('aria-live', 'polite'); feed.setAttribute('aria-label', _t('js.pad.relay.your_commands', 'Your commands'));
    form.appendChild(lab); form.appendChild(wrap); form.appendChild(count); form.appendChild(btn);
    host.appendChild(offBar); host.appendChild(form); host.appendChild(note); host.appendChild(hint); host.appendChild(mine); host.appendChild(feed);
    var last = '', lastJs = [], cmds = null, local = [], acIdx = -1, acItems = [], localSeq = 0;
    // 1.99ye: the outbox - {cid, text, at, st: queue|posting|wait|sent|failed, id, off, why, code, node, stEl, settled}
    var outbox = [], meU = null, busy = false, backoff = 0, retryTimer = null, noteTimer = null;
    var optimistic = !!feedEl;
    // 1.99ajf dockclean (owner point 30): opts.people() = the names this page knows (room.ejs acPeople: {value, name, login, tag, u}) -
    // after "@" or in a "!command " line's second word the list offers them (Tab / Enter / a tap accepts); opts.avatar(u) draws one
    var people = typeof opts.people === 'function' ? opts.people : null, avatarOf = typeof opts.avatar === 'function' ? opts.avatar : null, acName = null;
    // 1.99ajf dockclean review: the commands whose first word is a PERSON (Pepe's help catalogue: "!duel [user]", "!look [user]"…) - only
    // these open the name list in their second word (a free-text "!say he…" or an amount never does), and there only named Camfrog
    // members complete (their login: what Pepe looks people up by). 🌐 web users and frog names complete after "@" only.
    var NAME_CMDS = ['!time', '!roast', '!seen', '!lastseen', '!relay', '!camok', '!camno', '!whowatching', '!blockviewer', '!unblockviewer', '!micstats',
      '!replay', '!look', '!duel', '!brawl', '!impression', '!tip', '!sheet', '!gear', '!snap', '!clip', '!autoclip', '!opencam', '!djban', '!djunban',
      '!votekick', '!voteblock', '!votedemod', '!timeout', '!untimeout', '!watchlist', '!ignore', '!strike', '!casinoban', '!casinounban',
      '!fine', '!kick', '!ban', '!unban', '!punish', '!unpunish', '!blockmic', '!unblockmic', '!admin', '!mod', '!friend', '!unrole', '!role', '!patv',
      '!msg', '!message', '!creator', '!subscribe'];

    function fmtPrice(n) { return n > 0 ? Number(n).toLocaleString('en-US') + ' PAT' : ''; }
    function closeAc() { list.classList.add('hide'); list.classList.remove('rb-ac-names'); list.textContent = ''; acItems = []; acIdx = -1; acName = null; inp.setAttribute('aria-expanded', 'false'); inp.removeAttribute('aria-activedescendant'); }
    function pick(c) { inp.value = c + ' '; closeAc(); inp.focus(); }
    function nameCtx() {
      if (!people) return null;
      var pos = typeof inp.selectionStart === 'number' && inp.selectionStart !== null ? inp.selectionStart : inp.value.length, before = inp.value.slice(0, pos);
      var m = /(^|\s)@([^\s@]{0,40})$/.exec(before);
      if (m) return { at: true, start: pos - m[2].length - 1, end: pos, q: m[2] };
      m = /^(![A-Za-z0-9_]{1,30})\s+([^\s]{0,40})$/.exec(before);
      if (m && NAME_CMDS.indexOf(m[1].toLowerCase()) >= 0) return { at: false, start: pos - m[2].length, end: pos, q: m[2] };
      return null;
    }
    // 1.99ajn padppl (owner point 24): "@" inserts the name the person shows as on PATV (p.atValue - never their Camfrog login) and remembers
    // exactly who it was (p.ref, personref.js) for the say POST's `mentions` - at most 10; the server keeps only those still in the text
    var mnPicked = [];
    function takeName(p, c) {
      var shown = c.at && p.atValue ? String(p.atValue) : p.value;
      if (c.at && p.ref) { mnPicked = mnPicked.filter(function (m) { return m.n.toLowerCase() !== shown.toLowerCase(); }); mnPicked.push({ n: shown, ref: p.ref }); if (mnPicked.length > 10) mnPicked.shift(); }
      var val = (c.at ? '@' : '') + shown, rest = inp.value.slice(c.end);
      inp.value = inp.value.slice(0, c.start) + val + (/^\s/.test(rest) ? '' : ' ') + rest;
      var at = c.start + val.length + 1; if (inp.setSelectionRange) inp.setSelectionRange(at, at);
      closeAc(); paintCount(); inp.focus();
    }
    function openNames(c) {
      var q = c.q.toLowerCase(), pre = [], mid = [];
      var all = []; try { all = people() || []; } catch (e) { all = []; }
      all.forEach(function (p) {
        if (!c.at && !p.cmd) return;
        var hay = [p.name, p.value, p.login].filter(Boolean).map(function (x) { return String(x).toLowerCase(); });
        // (a name's start, or a word's start inside it - "fa" finds Aster Fable and quill-fable - comes before a match mid-word)
        if (!q || hay.some(function (h) { var i = h.indexOf(q); return i === 0 || (i > 0 && /[\s_.-]/.test(h.charAt(i - 1))); })) pre.push(p);
        else if (hay.some(function (h) { return h.indexOf(q) > 0; })) mid.push(p);
      });
      var rows = pre.concat(mid).slice(0, 8);
      list.textContent = ''; acItems = [];
      if (!rows.length || (rows.length === 1 && String(rows[0].value).toLowerCase() === q)) { closeAc(); return; }
      acName = c; list.classList.add('rb-ac-names');
      rows.forEach(function (p, i) {
        var li = el('li', 'rb-ac-it rb-ac-p'); li.id = list.id + '-' + i; li.setAttribute('role', 'option');
        if (avatarOf && p.u) { try { var av = avatarOf(p.u); if (av) li.appendChild(av); } catch (e) { /* no picture */ } }
        var nm = el('span', 'rb-ac-n', p.name || p.value); li.appendChild(nm);
        if (p.login) li.appendChild(el('span', 'rb-ac-l', p.login));
        if (p.tag) { var tg = el('span', 'rb-ac-t', p.tag); tg.title = p.tag; li.appendChild(tg); }   // (1.99ajh dockpop: its full word when it shortens)
        // (dock3 1.99akf: no "not the Camfrog user" tag here any more - owner: "just confusing"; the row's second line (@username / the
        // Camfrog login) and its 🌐 tell two same-named people apart)
        li._pick = function () { takeName(p, c); };
        li.addEventListener('mousedown', function (e) { e.preventDefault(); takeName(p, c); });
        list.appendChild(li); acItems.push(li);
      });
      // (1.99ajf dockclean review: the first row is picked from the start - it shows what Tab / Enter will take)
      acIdx = 0; list.classList.remove('hide'); inp.setAttribute('aria-expanded', 'true'); paintAc();
    }
    function paintAc() {
      acItems.forEach(function (li, i) {
        var on = i === acIdx; li.classList.toggle('on', on); li.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) { inp.setAttribute('aria-activedescendant', li.id); if (li.scrollIntoView) li.scrollIntoView({ block: 'nearest' }); }
      });
    }
    function openAc() {
      var v = inp.value, nc = nameCtx();
      if (nc) { openNames(nc); return; }
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
        var p = c === '!commands' ? _t('js.pad.relay.list_all', 'list them all') : fmtPrice(cmds[c]);
        if (p) li.appendChild(el('span', 'rb-ac-p', p));
        li._pick = function () { pick(c); };
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(c); });
        list.appendChild(li); acItems.push(li);
      });
      acIdx = -1; list.classList.remove('hide'); inp.setAttribute('aria-expanded', 'true'); paintAc();
    }
    function paintCount() {
      var n = inp.value.length, show = n >= COUNT_FROM;
      count.classList.toggle('hide', !show);
      count.classList.toggle('full', n >= SAY_MAX);
      if (show) count.textContent = _t('js.pad.relay.chars_left', '{n} left', { n: Math.max(0, SAY_MAX - n) });
      count.title = _t('js.pad.relay.chars_title', 'A Camfrog chat line holds {max} characters from the website', { max: SAY_MAX });
    }
    inp.addEventListener('input', function () { openAc(); paintCount(); });
    inp.addEventListener('click', function () { if (people && nameCtx()) openAc(); });
    inp.addEventListener('blur', function () { setTimeout(closeAc, 100); });
    inp.addEventListener('keydown', function (e) {
      // ↑ in an empty box: take back your last failed message to fix it (Camfrog can't edit a line once it's sent)
      if (e.key === 'ArrowUp' && !inp.value && (list.classList.contains('hide') || !acItems.length)) {
        for (var i = outbox.length - 1; i >= 0; i--) {
          if (outbox[i].st === 'failed') { e.preventDefault(); inp.value = outbox[i].text; drop(outbox[i]); paintCount(); return; }
        }
      }
      // 1.99ajf dockclean: Tab in a name position with the list closed completes in place (one match, or opens the list)
      if (e.key === 'Tab' && !e.shiftKey && (list.classList.contains('hide') || !acItems.length)) {
        var nc = nameCtx(); if (nc && nc.q) { openNames(nc); if (acItems.length === 1) { e.preventDefault(); acItems[0]._pick(); return; } if (acItems.length) { e.preventDefault(); acIdx = 0; paintAc(); } return; }
      }
      if (list.classList.contains('hide') || !acItems.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); acIdx = (acIdx + 1) % acItems.length; paintAc(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); acIdx = acIdx <= 0 ? acItems.length - 1 : acIdx - 1; paintAc(); }
      else if (e.key === 'Tab' && !e.shiftKey && acName) { e.preventDefault(); acItems[acIdx >= 0 ? acIdx : 0]._pick(); }
      else if ((e.key === 'Enter' || e.key === 'Tab') && acIdx >= 0) { e.preventDefault(); acItems[acIdx]._pick(); }
      else if (e.key === 'Escape') { closeAc(); }
    });

    // 1.99ajq dockpol (owner item 22): opts.onCmd(row) - the Room Dock shows each command's state as a toast that goes away by itself
    // ({id, text, st, ok, replies}: called when a row appears or changes); the list under the composer is then hidden. The rows a page
    // had before it loaded are noted, never re-announced.
    var onCmd = typeof opts.onCmd === 'function' ? opts.onCmd : null, cmdSeen = null;
    if (onCmd) { feed.hidden = true; feed.classList.add('hide'); }
    function renderFeed(js) {
      feed.textContent = '';
      var rows = local.concat(js.filter(function (x) { return x.kind === 'cmd'; }).map(function (j) {
        var sb = /^!(?:sb|soundboard)(?:\s|$)/i.test(j.text || '');
        var st = sb ? clipStatus(j) : j.state !== 'done' ? _t('js.pad.relay.waiting_pepe', 'waiting for Pepe…') : (j.ok ? (j.replies && j.replies.length ? '' : (j.msg || _t('js.pad.relay.done', 'done'))) : _t('js.pad.relay.not_run', 'not run — {why}', { why: j.msg || _t('js.pad.relay.refused', 'refused') }));
        return { id: j.id != null ? 'j' + j.id : 'a' + j.at, at: j.at, text: j.text, st: st, ok: j.state === 'done' ? j.ok : null, replies: j.replies || [] };
      })).sort(function (a, b) { return a.at - b.at; }).slice(-4);
      if (onCmd) {
        var first = cmdSeen === null; if (first) cmdSeen = {};
        rows.forEach(function (r) {
          var id = r.id || 'a' + r.at, sig = JSON.stringify([r.st, r.ok, r.replies]);
          if (cmdSeen[id] === sig) return;
          cmdSeen[id] = sig;
          if (first && r.ok != null) return;                  // (done before this page: not news; one still waiting shows, and so will its answer)
          try { onCmd({ id: id, text: r.text, st: r.st, ok: r.ok, replies: r.replies.slice() }); } catch (e) { /* the page's own */ }
        });
        return;
      }
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

    // ── 1.99ye: the outbox ──
    // 1.99ajh dockpop review (privacy): a Room Dock page says which account it was made for (opts.vt, the viewer tag) - the site refuses a
    // line or command for another account (409 account: this browser signed in as someone else since), opts.onAccount() hears it.
    // destroy() (the chat window wiping itself) ends the outbox: nothing queued is ever posted after it, as whoever is signed in then.
    var dead = false;
    function post(body) {
      if (dead) return Promise.reject(new Error('closed'));
      var vt = typeof opts.vt === 'function' ? opts.vt() : opts.vt;
      if (typeof vt === 'string' && vt) body.vt = vt;
      return fetch('/api/rooms/' + encodeURIComponent(slug) + '/say', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }, function () { return { s: r.status, d: null }; }); });
    }
    // ptttoast 1.99ana (owner 11-08: no status lines under the Dock's tool row): useToast(fn) - the Room Dock's chat notices (pad-dock.js
    // chatToast: fn(text, {id, ms, bad, busy, sticky}); '' with the id takes one down). Then "Wait a moment…" is a notice for the 6 s the
    // line stayed, the offline bar one notice per outage, taken down when a send gets through, and an older page's message line (no chat
    // list: `mine`) one too. The character counter stays on the field (in the Dock beside it - pad-dock.css, ptttoast review F1).
    // (ptttoast review F3 1.99ana: the outage is a state, not news - its notice is sticky: no timer, never pushed out by newer notices, up
    // until the site answers again; it was an 8 s notice and then nothing said the page was offline)
    var toastFn = null, offOn = false, mineWords = null;
    var offText = _t('js.pad.relay.offline', 'You\'re offline — your messages will send when the connection is back.');
    function notice(id, text, kind, ms) {
      if (!toastFn) return false;
      var o = { id: id };
      if (text && kind === 'state') { o.bad = true; o.sticky = true; }
      else if (text) { o.ms = ms || (kind === 'busy' ? 30000 : kind === 'bad' ? 8000 : 3000); o.bad = kind === 'bad'; if (kind === 'busy') o.busy = true; }   // (review F2: busy - a step on the way)
      try { toastFn(text ? String(text) : '', o); } catch (e) { /* the Dock's own */ }
      return true;
    }
    function mineLine(text, kind) { if (!notice('rb-mine', text, kind)) mine.textContent = text; }
    function showNote(t) {
      if (toastFn) { if (t) notice('rb-note', t, 'bad', 6000); return; }
      note.textContent = t; note.classList.toggle('hide', !t);
      clearTimeout(noteTimer); if (t) noteTimer = setTimeout(function () { note.classList.add('hide'); }, 6000);
    }
    function setOffline(on) {
      var was = offOn; offOn = !!on;
      if (toastFn) { if (offOn !== was) notice('rb-offline', offOn ? offText : '', 'state'); return; }
      offBar.classList.toggle('hide', !on);
    }
    function waiting() { return outbox.filter(function (x) { return x.st === 'queue' || x.st === 'posting' || x.st === 'wait'; }).length; }
    // CL8: opts.scroller = what scrolls (the pad's chat log sits inside a scroller with scrollback's older lines)
    var scrollEl = opts.scroller || feedEl;
    function nearBottom() { return !scrollEl || scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80; }
    function toBottom() {
      if (!scrollEl) return;
      scrollEl.style.scrollBehavior = 'auto'; scrollEl.scrollTop = scrollEl.scrollHeight; scrollEl.style.scrollBehavior = '';
      if (opts.onBottom) { try { opts.onBottom(); } catch (e) { /* the page's pill */ } }
    }
    function optNode(it) {
      var u = meU || { display: _t('js.pad.relay.you', 'you'), login: '', web: true };
      var n = null;
      // 1.99ajc dockfu (D3): the sender's own pending preview of an exact sticker / GIF token draws as one (the server sends exactly such
      // a line as a media pick - sayLine - or refuses it); room lines draw media only with the server's mark (chatlog-core mediaOf)
      var CLm = window.PATVChatlog, tok = CLm && CLm.mediaToken ? CLm.mediaToken(it.text) : null;
      try { n = mkLine ? mkLine(tok ? { k: 'msg', u: u, text: it.text, ts: it.at, md: tok.type } : { k: 'msg', u: u, text: it.text, ts: it.at }) : null; } catch (e) { n = null; }
      if (!n) { n = el('div', 'rb-optline'); n.appendChild(el('b', null, u.display || '')); n.appendChild(document.createTextNode(' ' + it.text)); }
      n.classList.add('rb-opt'); n.setAttribute('data-cid', it.cid);
      n.removeAttribute('data-c'); n.removeAttribute('data-k');      // not a room line (yet): no ✂️ Clip / quote on it
      var s = el('span', 'rb-st');
      (n.querySelector('.body') || n).appendChild(s);
      it.node = n; it.stEl = s;
      return n;
    }
    function paint(it) {
      var n = it.node; if (!n) return;
      var pend = it.st !== 'sent' && it.st !== 'failed';
      n.classList.toggle('rb-opt-wait', pend);
      n.classList.toggle('rb-opt-sent', it.st === 'sent');
      n.classList.toggle('rb-opt-failed', it.st === 'failed');
      // waiting lines stay at the bottom of the chat (the page inserts new room lines above them); a sent one that
      // hasn't come back by SETTLE_MS (e.g. you're !incognito: the website never shows your lines) and a failed one
      // keep their place
      n.classList.toggle('rb-opt', pend || (it.st === 'sent' && !it.settled));
      var s = it.stEl; s.textContent = '';
      if (it.st === 'failed') {
        s.appendChild(el('span', 'rb-st-t', '⚠ ' + _t('js.pad.relay.not_sent_why', 'not sent — {why}', { why: it.why || _t('js.pad.relay.refused', 'refused') })));
        var rb = el('button', 'rb-st-b', _t('js.pad.relay.retry', 'Retry')); rb.type = 'button';
        rb.addEventListener('click', function () { retry(it); });
        var db = el('button', 'rb-st-b', '✕'); db.type = 'button'; db.title = _t('js.pad.relay.delete', 'Delete'); db.setAttribute('aria-label', db.title);
        db.addEventListener('click', function () { drop(it); });
        s.appendChild(rb); s.appendChild(db);
      } else if (it.st === 'sent') {
        s.textContent = '✓ ' + _t('js.pad.relay.sent', 'sent');
        s.title = _t('js.pad.relay.sent_title', 'Pepe posted it in the Camfrog room');
      } else {
        s.textContent = '🕓 ' + (it.off ? _t('js.pad.relay.waiting_net', 'waiting for connection…') : _t('js.pad.relay.sending', 'sending…'));
        s.title = '';
      }
    }
    function place(it) {
      if (!feedEl) return;
      var stick = nearBottom();
      var p = feedEl.firstChild;
      if (p && p.tagName === 'P') feedEl.removeChild(p);                // "Nothing said yet"
      feedEl.appendChild(it.node || optNode(it));
      paint(it);
      if (stick || it.mine) toBottom();
    }
    function drop(it) {
      var i = outbox.indexOf(it); if (i >= 0) outbox.splice(i, 1);
      if (it.node && it.node.parentNode) it.node.parentNode.removeChild(it.node);
      it.node = null;
    }
    function fail(it, why, code) { it.st = 'failed'; it.off = false; it.why = why || ''; it.code = code || ''; paint(it); }
    function retry(it) {
      if (waiting() >= SAY_QUEUE) { showNote(_t('js.pad.relay.queue_full', 'Wait a moment — {n} messages are already on their way.', { n: SAY_QUEUE })); return; }
      it.cid = newCid(); it.st = 'queue'; it.id = null; it.why = ''; it.code = ''; it.at = Date.now(); it.settled = false; it.mine = true;
      if (it.node) { it.node.setAttribute('data-cid', it.cid); if (it.node.parentNode) it.node.parentNode.removeChild(it.node); }
      place(it); pump();
    }
    function offlineRetry(it) {
      it.st = 'queue'; it.off = true; paint(it); setOffline(true);
      backoff = backoff ? Math.min(15000, backoff * 2) : 1000;
      clearTimeout(retryTimer); retryTimer = setTimeout(pump, backoff);
    }
    // One POST at a time, in order: the site queues them in the order it gets them.
    function account(x) { if (x && x.s === 409 && x.d && x.d.code === 'account' && typeof opts.onAccount === 'function') { try { opts.onAccount(); } catch (e) { /* the page's own */ } } }
    function pump() {
      if (busy || dead) return;
      var it = null;
      for (var i = 0; i < outbox.length; i++) if (outbox[i].st === 'queue') { it = outbox[i]; break; }
      if (!it) return;
      busy = true; it.st = 'posting';
      post(it.mn ? { text: it.text, cid: it.cid, mentions: it.mn } : { text: it.text, cid: it.cid }).then(function (x) {
        busy = false;
        if (dead) return;
        if (outbox.indexOf(it) < 0) { pump(); return; }                  // deleted meanwhile
        var d = x.d;
        if (!d || x.s >= 500) { offlineRetry(it); return; }
        setOffline(false); backoff = 0;
        if (d.ok) { it.st = 'wait'; it.id = d.id; it.off = false; paint(it); }      // `mine` takes it from here
        else if (d.code === 'queue_full') { it.st = 'queue'; paint(it); clearTimeout(retryTimer); retryTimer = setTimeout(pump, 1500); return; }
        else if (x.s === 401) fail(it, _t('js.pad.relay.signed_out', 'you\'re signed out — sign in again'), 'signin');
        else fail(it, d.error || _t('js.pad.relay.refused', 'refused'), d.code);
        account(x);
        pump();
      }, function () { busy = false; if (dead) return; if (outbox.indexOf(it) >= 0) offlineRetry(it); else pump(); });
    }
    window.addEventListener('online', function () { if (dead) return; if (outbox.some(function (x) { return x.st === 'queue'; })) { clearTimeout(retryTimer); backoff = 0; pump(); } });
    window.addEventListener('beforeunload', function (e) {
      if (dead) return;
      if (outbox.some(function (x) { return x.st === 'queue' || x.st === 'posting'; })) { e.preventDefault(); e.returnValue = ''; }
    });
    function sendChat(text) {
      if (dead) return false;
      if (waiting() >= SAY_QUEUE) {
        showNote(_t('js.pad.relay.queue_full', 'Wait a moment — {n} messages are already on their way.', { n: SAY_QUEUE }));
        return false;
      }
      var it = { cid: newCid(), text: text, at: Date.now(), st: 'queue', mine: true };
      // 1.99ajn padppl: the picked @mentions still in these words (the server checks again and resolves each ref exactly)
      var lowT = String(text).toLowerCase(), mn = mnPicked.filter(function (m) { return lowT.indexOf('@' + m.n.toLowerCase()) >= 0; });
      if (mn.length) it.mn = mn;
      mnPicked = [];
      outbox.push(it);
      place(it);
      pump();
      return true;
    }
    // A "!" command: sent at once (no optimistic line - its answer shows in your command list); never locks the box.
    function sendCmd(text) {
      if (dead) return;
      post({ text: text }).then(function (x) {
        if (dead) return;                                                // (an answer for a page that wiped itself shows nothing)
        var d = x.d || {};
        if (d.ok && d.local) { local.push({ id: 'l' + (++localSeq), at: Date.now(), text: text, st: '', ok: true, replies: [d.reply || ''] }); local = local.slice(-2); renderFeed(lastJs); return; }
        if (d.ok) return;
        local.push({ id: 'l' + (++localSeq), at: Date.now(), text: text, st: _t('js.pad.relay.not_sent_why', 'not sent — {why}', { why: d.error || _t('js.pad.relay.refused', 'refused') }), ok: false, replies: [] });
        local = local.slice(-2); renderFeed(lastJs);
        account(x);
      }, function () {
        if (dead) return;
        local.push({ id: 'l' + (++localSeq), at: Date.now(), text: text, st: _t('js.pad.relay.unreachable', 'couldn\'t reach the site'), ok: false, replies: [] });
        local = local.slice(-2); renderFeed(lastJs);
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (dead) return;
      closeAc();
      var text = inp.value.trim(); if (!text) return;
      if (text.charAt(0) === '!') { inp.value = ''; sendCmd(text); }
      else if (optimistic) { if (sendChat(text)) inp.value = ''; }
      else {
        // no chat list to show it in (an older page): the status line, as before
        inp.value = '';
        mineLine(_t('js.pad.relay.your_msg', '💬 your message: {status}', { status: _t('js.pad.relay.waiting_pepe', 'waiting for Pepe…') }), 'busy');
        post({ text: text, cid: newCid() }).then(function (x) { if (!x.d || !x.d.ok) mineLine('💬 ' + ((x.d && x.d.error) || _t('js.pad.relay.not_sent', 'not sent')), 'bad'); },
          function () { mineLine('💬 ' + _t('js.pad.relay.unreachable', 'couldn\'t reach the site'), 'bad'); });
      }
      paintCount();
      inp.focus();
    });

    // 1.99acb: the room lines this page has been given (feed cursors), and the ones that name one of YOUR say jobs (the site
    // tags your own relayed line with its job id + client id). A pending line is swapped out only for a room line the page
    // really has - never on the cursor's word alone: an answer whose cursor ran past a line it didn't carry used to drop the
    // pending line, and the page's next ?after= skipped the room line too (the message "didn't show up" until a reload).
    var seenC = {}, seenList = [], landed = {}, landedList = [], miss = 0;
    function land(k) { if (!landed[k]) { landed[k] = 1; landedList.push(k); } }
    function noteFeed(feed) {
      (feed || []).forEach(function (f) {
        if (!f || !f.c) return;
        if (!seenC[f.c]) { seenC[f.c] = 1; seenList.push(f.c); }
        if (f.cid) land('c:' + f.cid);
        if (f.job) land('j:' + f.job);
      });
      while (seenList.length > 1000) delete seenC[seenList.shift()];
      while (landedList.length > 200) delete landed[landedList.shift()];
    }
    function hasLanded(it) { return !!(landed['c:' + it.cid] || (it.id && landed['j:' + it.id])); }
    // The live view's `mine` (this viewer's relay jobs, 1.99ye: with cid / c / code) -> the outbox lines' states.
    function syncOutbox(js, cursor) {
      var byCid = {}, byId = {};
      js.forEach(function (j) { if (j.kind === 'say') { if (j.cid) byCid[j.cid] = j; byId[j.id] = j; } });
      outbox.slice().forEach(function (it) {
        var j = byCid[it.cid] || (it.id ? byId[it.id] : null);
        if (j) it.id = j.id;
        if (hasLanded(it)) { drop(it); return; }                      // its room line (named by the job) is in the chat now
        if (!j) return;
        if (j.c && seenC[j.c]) { drop(it); return; }                  // the room's own line is in the chat now
        // the site says the room line exists but this page never got it: keep yours (as sent - never lose a line) and ask
        // the page to fetch from just before it once (it dedupes what it already shows)
        if (j.c && j.c <= cursor && !it.refetched) { it.refetched = true; miss = miss ? Math.min(miss, j.c) : j.c; }
        if (it.st === 'queue' || it.st === 'posting') return;          // our POST's answer decides first
        var was = it.st;
        if (j.state !== 'done') it.st = 'wait';
        else if (j.ok) it.st = 'sent';
        else { it.st = 'failed'; it.why = j.msg || ''; it.code = j.code || ''; }
        if (it.st === 'sent' && was !== 'sent') {
          it.sentAt = Date.now();
          setTimeout(function () { if (outbox.indexOf(it) >= 0 && it.st === 'sent') { it.settled = true; paint(it); } }, SETTLE_MS);
        }
        if (it.st !== was) paint(it);
      });
    }
    return {
      update: function (d) {
        form.classList.toggle('hide', !(d && d.room && d.room.relay));
        cmds = d && d.room && d.room.cmds ? d.room.cmds : null;
        hint.classList.toggle('hide', !(cmds && d.room.relay));
        inp.placeholder = opts.placeholder ? String(opts.placeholder) : cmds ? _t('js.pad.relay.placeholder_cmds', 'Say something, or type ! for commands — relayed as “🌐 you (web)”') : _t('js.pad.relay.placeholder', 'Say something — Pepe relays it as “🌐 you (web)”');
        if (d && d.me) meU = d.me;
        var js = (d && d.mine) || [], k = JSON.stringify(js);
        lastJs = js;
        if (window.PATVSoundboard) window.PATVSoundboard.update(js);
        if (optimistic) { noteFeed(d && d.feed); syncOutbox(js, (d && d.cursor) || 0); }
        if (k === last) return;
        last = k;
        if (!optimistic) {
          var j = js.filter(function (x) { return x.kind === 'say'; }).pop(), words = '';
          if (j) words = _t('js.pad.relay.your_msg', '💬 your message: {status}', { status: j.state === 'done' ? (j.ok ? (j.msg || _t('js.pad.relay.sent', 'sent')) : _t('js.pad.relay.not_sent_why', 'not sent — {why}', { why: j.msg || _t('js.pad.relay.refused', 'refused') })) : _t('js.pad.relay.waiting_pepe', 'waiting for Pepe…') });
          // (ptttoast: in the Dock a notice when the words change - one done before this page's first view is not news)
          if (j && !toastFn) mine.textContent = words;
          else if (j && words !== mineWords && !(mineWords === null && j.state === 'done')) notice('rb-mine', words, j.state !== 'done' ? 'busy' : j.ok ? 'done' : 'bad');
          mineWords = words;
        }
        renderFeed(js);
      },
      // 1.99ye: where the page puts new room lines - above your lines that are still on their way (null = at the end)
      anchor: function () { return feedEl ? feedEl.querySelector('.rb-opt') : null; },
      // does the page still need to send ?me=1 (your look for the pending lines)?
      wantsMe: function () { return optimistic && !meU; },
      // 1.99acb: the feed cursor of your room line the page was told about but never given (0 = none) - the page polls from
      // just before it once (asked once per line; cleared by asking)
      refetch: function () { var m = miss; miss = 0; return m; },
      // the page cleared its chat (the site restarted): what it had been given is gone with it; your lines still on their way
      // (or not back yet) go back at the bottom of the chat instead of vanishing with it
      reset: function () {
        seenC = {}; seenList = []; landed = {}; landedList = []; miss = 0;
        if (feedEl) outbox.forEach(function (it) { if (it.node && it.node.parentNode !== feedEl) feedEl.appendChild(it.node); });
      },
      pending: function () { return outbox.slice(); },
      // 1.99ajh dockpop review: the chat window wiped itself - the outbox empties, its retry timer and 'online' retry stop, answers still on
      // their way are dropped, and nothing more is sent from this composer
      destroy: function () {
        dead = true; clearTimeout(retryTimer); clearTimeout(noteTimer); retryTimer = null;
        outbox.slice().forEach(drop); outbox.length = 0; local = []; inp.value = ''; inp.disabled = true; btn.disabled = true; closeAc();
      },
      // ptttoast 1.99ana: the Room Dock's chat notices (pad-dock.js) for the notes under the composer - null = the lines again
      useToast: function (fn) {
        toastFn = typeof fn === 'function' ? fn : null;
        [offBar, note, mine].forEach(function (n) { n.classList.toggle('rb-hide', !!toastFn); });
        if (toastFn) { clearTimeout(noteTimer); note.textContent = ''; note.classList.add('hide'); mine.textContent = ''; if (offOn) notice('rb-offline', offText, 'state'); }
        else { offBar.classList.toggle('hide', !offOn); last = ''; }
      },
      // Dock tools use the same command path / input and counter as typing; no second network path.
      sendCmd: sendCmd,
      getInput: function () { return inp; },
      insert: function (text, options) {
        var replace = !!(options && options.replace), value = String(text == null ? '' : text);
        var start = replace ? 0 : typeof inp.selectionStart === 'number' ? inp.selectionStart : inp.value.length;
        var end = replace ? inp.value.length : typeof inp.selectionEnd === 'number' ? inp.selectionEnd : start;
        var room = Math.max(0, SAY_MAX - (inp.value.length - (end - start)));
        value = value.slice(0, room);
        // Never split a Unicode surrogate pair at the 300-code-unit boundary.
        if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
        inp.value = inp.value.slice(0, start) + value + inp.value.slice(end);
        if (inp.setSelectionRange) inp.setSelectionRange(start + value.length, start + value.length);
        closeAc(); paintCount(); inp.focus();
        return value;
      },
      _send: sendChat,
    };
  }

  // ── push-to-talk clip: hold the button (or tap to start, tap again to send); up to the site's max length ──
  // pttlimits: the max length is the admin setting (/admin/bridge "Push-to-talk clips"), sent with every live view as room.pttMax -
  // the recorder stops there and the idle line says it (js.pad.ptt.upto_n). Before the first view (or from an older site): PTT_DEF.
  // Review fix 3: the recorder stops PTT_EARLY_MS before the max (a late timer / a slow onstop still lands inside Pepe's +0.5 s check),
  // and a clip that ran past max + PTT_OVER_S anyway is kept here - Pepe would refuse it as too long AND count it (bad_clip).
  var PTT_DEF = 30, PTT_LO = 3, PTT_HI = 120, PTT_EARLY_MS = 500, PTT_OVER_S = 0.5;
  function pttMaxOf(d) {
    var n = Number(d && d.room && d.room.pttMax);
    return isFinite(n) && n >= PTT_LO && n <= PTT_HI ? Math.floor(n) : PTT_DEF;
  }
  // relaymic 1.99?? (owner 11-08: "Pepe cuts out the last word or so of web relay mic ups if the speaker doesn't leave a gap before
  // hitting button to end the mic up"): the end was lost HERE - the recorder and the mic tracks stopped in the handler that ended the
  // press, so what was said as the finger lifted was never recorded (+ 30-60 ms Chrome's Opus encoder drops). The release tail, like
  // Discord's "release delay": letting go (or the tap / Enter that sends) keeps the recorder running room.pttTail ms more (pttlimits
  // tail_ms - /admin/bridge "Push-to-talk clips", 0-1000, 400 by default). The button says Sending at once and a press meanwhile is
  // ignored; after the tail the recorder stops and its onstop lets the mic go and uploads (x-clip-secs: the wall time, tail included).
  // No tail on the max-length timer (Pepe's +0.5 s check still holds), a hidden / closed page, the room's mic switched off or destroy()
  // - those stop at once, as before. iOS: only with room.pttTailIos (tail_ios, off by default) - there the release stays inside the
  // gesture (the room player only resumes from one; play-and-record holds while any track is live). A view without it (or a bad
  // value): no tail - the release as before.
  var PTT_TAIL_HI = 1000;
  function pttTailOf(d) {
    var n = Number(d && d.room && d.room.pttTail);
    return isFinite(n) && n > 0 ? Math.min(PTT_TAIL_HI, Math.floor(n)) : 0;
  }
  // What the clip line says for the user's latest clip job (mineFor). Pepe (1.99bk) acks the steps:
  // queued -> waiting (someone else holds the mic) -> playing -> done: "played", or not ok with
  // "couldn't get the mic ..." after a patient wait. Older Pepes ack once ("queued ...") then again
  // when it plays / is dropped - those messages still read right.
  // pttclip review: a clip that didn't play, by Pepe's (or the site's) code - a translated page's line ('' = not one of these)
  function clipMissLine(code) {
    if (code === 'no_mic') return _t('js.pad.ptt.s_no_mic_free', 'Pepe couldn’t get the mic — no cooldown, try again');
    if (code === 'mic_later') return _t('js.pad.ptt.s_mic_later', 'Pepe can’t get the mic here right now — it didn’t count toward your limit');
    if (code === 'audio_failed') return _t('js.pad.ptt.s_audio_failed', 'Pepe’s audio failed while playing it — no cooldown, try again');
    if (code === 'nopepe') return _t('js.pad.ptt.s_nopepe', 'Pepe isn’t taking clips right now — it didn’t count toward your limit');
    if (code === 'unconfirmed') return _t('js.pad.ptt.s_unconfirmed', 'Pepe didn’t say whether it played — it didn’t count toward your limit');
    return '';
  }
  function pageEnglish() {
    try { var l = document.documentElement && document.documentElement.lang; return !l || /^en(?:-|$)/i.test(String(l)); } catch (e) { return true; }
  }
  function clipStatus(j) {
    if (!j) return '';
    var s = j.state, m = String(j.msg || '');
    if (s === 'pending' || s === 'claimed') return _t('js.pad.ptt.s_pending', 'sent — waiting for Pepe…');
    if (s === 'queued') return _t('js.pad.ptt.s_queued', 'queued for the mic…');
    if (s === 'waiting') return _t('js.pad.ptt.s_waiting', 'waiting for the mic…');
    if (s === 'playing') return _t('js.pad.ptt.s_playing', 'playing on the mic now');
    if (j.ok) return m === 'played' ? _t('js.pad.ptt.s_played', 'played') : (m || _t('js.pad.relay.sent', 'sent'));
    // pttclip: a clip that didn't play costs no limit (the site and Pepe give it back) - Pepe's own words say why and whether to
    // try again ("Pepe couldn't get the mic (...) - no cooldown - try again" / "... - it didn't count toward your limit").
    // pttclip review: those words are English - a translated page shows its own line for the code (clipMissLine)
    var miss = clipMissLine(j.code);
    if (miss) return m && pageEnglish() ? m : miss;
    if (/couldn.t get the mic|stayed busy|dropped/i.test(m)) return _t('js.pad.ptt.s_no_mic', 'couldn’t get the mic, try again');
    return _t('js.pad.relay.not_sent_why', 'not sent — {why}', { why: m || _t('js.pad.relay.refused', 'refused') });
  }

  function ptt(host, slug) {
    var box = el('div', 'rb-ptt hide');
    var btn = el('button', 'rb-btn rb-talk', _t('js.pad.ptt.hold', '🎙 Hold to talk')); btn.type = 'button'; btn.setAttribute('aria-pressed', 'false');
    var maxS = PTT_DEF;                       // pttlimits: the site's max length (update() reads room.pttMax)
    function uptoText() { return _t('js.pad.ptt.upto_n', 'up to {n} s · Pepe plays it on the mic when it\'s free', { n: maxS }); }
    var txt = el('span', 'rb-ptt-txt rb-ptt-idle', uptoText());
    txt.setAttribute('aria-live', 'polite');
    var mine = el('div', 'rb-mine'); mine.setAttribute('aria-live', 'polite');
    // 1.99bx: which mic (shown once the browser has named them - after the first clip - and only
    // when there's more than one). The pick is an "ideal" deviceId: a stale / unplugged one quietly
    // falls back to the default, so the iOS gesture timing below is untouched.
    var micSel = el('select', 'rb-micsel hide'); micSel.setAttribute('aria-label', _t('js.pad.ptt.mic_label', 'Microphone for push-to-talk'));
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
    var opening = false, pressAt = 0, upAt = 0, tapMode = false, requestGen = 0;
    var recording = false, recordListeners = [], activeDoc = null, activeWin = null;
    var tailMs = 0, tailIos = false, tailTimer = null, ending = false;   // relaymic: the release tail (update() reads room.pttTail / pttTailIos)
    // ptttoast 1.99ana (owner 11-08, Pepe's Pad: "slow down — one every 15s" and "🎙 your clip: played" sat under the Dock's tool row - "they
    // should show up the same way the other stuff does as the modal that auto-dismisses"): useToast(fn) - the Room Dock hands in its chat
    // card's notices (pad-dock.js chatToast: fn(text, {id, ms, bad}); '' with the id takes one down). Then nothing is written under the
    // composer (both lines rb-hide): ONE notice per press, updated in place from "opening the microphone…" to the clip's "played" (the
    // upload's answer ties the clip's job to it - jobTid), with the command notices' timing: on its way 30 s, done 3 s, a refusal 8 s
    // (+ the refusal look). A clip from elsewhere (another tab, one on its way when the page opened) gets a notice of its own. Without a
    // Dock (the classic layout) the lines beside the button, as before.
    // (ptttoast review F2 1.99ana: a step on the way says so - busy - so a notice closed with its ✕ stays closed through the clip's later
    // steps, only a refusal shows again - pad-dock.js chatToast)
    // (ptttoast review F4 1.99ana: a clip's own progress - waiting for Pepe / queued / waiting / playing - stays up until its next state,
    // CLIP_OPEN_MS at most: Pepe can hold a clip minutes for the mic, and a 30 s notice left nothing on the screen while it waited; the
    // site settles every clip well inside it - bridge-relay.js clipOpenUntil: 75 s unclaimed, 8 min from Pepe's claim, playing + its
    // length + 90 s - so the next state, played or not, always replaces it)
    var toastFn = null, pressSeq = 0, pressTid = '', jobTid = {}, jobOrder = [], clipSeen = null;
    var TOAST_MS = { busy: 30000, done: 3000, bad: 8000 }, CLIP_OPEN_MS = 10 * 60 * 1000;
    function notice(tid, text, kind, ms) {
      if (!toastFn) return false;
      var o = { id: tid };
      if (text) { o.ms = ms || TOAST_MS[kind] || TOAST_MS.done; o.bad = kind === 'bad'; if (kind === 'busy') o.busy = true; }
      try { toastFn(text ? String(text) : '', o); } catch (e) { /* the Dock's own */ }
      return true;
    }
    // a recorder / upload line for the press `tid`: the Dock's notice (🎙 in front - it isn't beside the button there), else the line
    function sayFor(tid) { return function (text, kind, ms) { if (!notice(tid, text ? '🎙 ' + text : '', kind, ms)) txt.textContent = text; }; }
    function clipBusy(j) { var s = j && j.state; return s === 'pending' || s === 'claimed' || s === 'queued' || s === 'waiting' || s === 'playing'; }
    function recordState(on) {
      if (recording === on) return;
      recording = on;
      recordListeners.slice().forEach(function (fn) { try { fn(on); } catch (e) { /* one view cannot break recording */ } });
      try { host.dispatchEvent(new CustomEvent('patv:recording', { bubbles: true, detail: { recording: on } })); } catch (e) { /* callback remains available */ }
    }
    function visibility() { if (activeDoc && activeDoc.hidden) stop(); }
    function adopt(doc) {
      doc = doc || host.ownerDocument || document;
      if (doc === activeDoc) return;
      if (activeDoc && activeDoc.removeEventListener) activeDoc.removeEventListener('visibilitychange', visibility);
      if (activeWin && activeWin.removeEventListener) activeWin.removeEventListener('pagehide', stop, true);
      activeDoc = doc; activeWin = doc.defaultView || null;
      activeDoc.addEventListener('visibilitychange', visibility);
      // Stop before the Dock's pagehide handler redocks us and removes this document's listeners.
      if (activeWin && activeWin.addEventListener) activeWin.addEventListener('pagehide', stop, true);
    }
    host.addEventListener('patv:surfacechange', function () { adopt(host.ownerDocument); });
    adopt(host.ownerDocument || document);
    function idle() { ending = false; btn.setAttribute('aria-pressed', 'false'); btn.textContent = _t('js.pad.ptt.hold', '🎙 Hold to talk'); }
    // Every mic track stopped and the stream dropped (iOS keeps the page in play-and-record while any
    // track is alive), then the room player gets its playback session + the user's volume back.
    function release() {
      recordState(false);
      var s = stream; stream = null;
      if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* already ended */ } });
      recSession.after();
    }
    // Called from the gesture that ends the clip (pointerup / tap / key), so the release - and the room
    // player's resume - happen inside that gesture instead of later in MediaRecorder's onstop.
    // relaymic: these stop at ONCE - the max-length timer, a hidden / closed page, the mic switched off, destroy() - a tail on its
    // way too (cut short: the clip so far still goes)
    function stop() {
      requestGen++;                           // a late permission grant must not record after a surface closed
      clearTimeout(recTimer);
      if (tailTimer) { clearTimeout(tailTimer); tailTimer = null; }
      ending = false;
      if (rec && rec.state === 'recording') { try { rec.stop(); } catch (e) { /* onstop still runs */ } }
      if (stream) release();
    }
    // relaymic 1.99??: the end of a press - pointerup, the tap that sends, Enter. With a tail (pttTailOf; on iOS only with tail_ios) the
    // recorder runs on: Sending at once, the mic open, and after the tail rec.stop() - its onstop releases the mic and uploads. Without
    // one: stop() inside the gesture, as before.
    function finish() {
      var ms = IOS && !tailIos ? 0 : tailMs;
      if (!(ms > 0) || !rec || rec.state !== 'recording') return stop();
      if (ending) return;
      ending = true;
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = _t('js.pad.ptt.rec_sending', '🎙 Sending…');
      var r = rec;
      tailTimer = setTimeout(function () {
        tailTimer = null;
        if (rec !== r || r.state !== 'recording') return;     // (stopped some other way meanwhile)
        requestGen++;
        clearTimeout(recTimer);
        try { r.stop(); } catch (e) { stop(); }                // the mic tracks go in onstop (release)
      }, ms);
    }
    var gone = false;       // 1.99ajh dockpop review: destroy() - a clip being recorded when the chat window wiped itself is never uploaded
    function send(chunks, mimeType, secs, capS, tid) {
      if (gone) return;
      var say = sayFor(tid);          // (ptttoast: the press's own notice in the Dock)
      if (secs < 0.7) { say(_t('js.pad.ptt.too_short', 'too short — hold the button while you talk'), 'bad'); return; }
      // pttlimits review fix 3: longer than the max it was recorded under allows (+0.5 s, Pepe's own check) - never sent
      if (capS && secs > capS + PTT_OVER_S) { say(_t('js.pad.ptt.too_long', 'too long — keep it under {n} s', { n: capS }), 'bad'); return; }
      var blob = new Blob(chunks, { type: (mimeType || 'audio/webm').split(';')[0] });
      say(_t('js.pad.ptt.sending', 'sending {n}s…', { n: secs.toFixed(0) }), 'busy');
      fetch('/api/rooms/' + encodeURIComponent(slug) + '/clip', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': blob.type, 'x-clip-secs': secs.toFixed(1) }, body: blob })
        // pttlimits review fix 2: any 413 is "too big" - the site's JSON one, and nginx's own HTML page for a body over its limit (4 MB on the clip upload since 11-08)
        .then(function (r) { return r.status === 413 ? { ok: false, error: _t('js.pad.ptt.too_big', 'that recording is too big — try a shorter one') } : r.json(); })
        .then(function (d) {
          // (ptttoast: the clip's progress goes on in this press's notice - unless the live view already gave the clip one of its own)
          if (d.ok && d.id != null) {
            var key = String(d.id);
            if (toastFn && clipSeen && clipSeen[key] != null) { notice(tid, ''); return; }
            jobTid[key] = tid; jobOrder.push(key); if (jobOrder.length > 12) delete jobTid[jobOrder.shift()];
          }
          say(d.ok ? _t('js.pad.ptt.sent', 'sent — Pepe plays it when the mic is free') : (d.error || _t('js.pad.relay.not_sent', 'not sent')), d.ok ? 'busy' : 'bad');
        })
        .catch(function () { say(_t('js.pad.relay.unreachable', 'couldn\'t reach the site'), 'bad'); });
    }
    function start() {
      if (gone || ending) return;                // (relaymic: a press during the release tail is ignored)
      if (rec && rec.state === 'recording') return finish();   // the tap that sends (relaymic: with the tail)
      if (opening) return;                       // a second press while the browser is still opening the mic
      opening = true; pressAt = Date.now();
      var myRequest = ++requestGen, tid = pressTid = 'ptt:p' + (++pressSeq), say = sayFor(tid);   // (ptttoast: this press's notice)
      recSession.before();
      if (!toastFn) txt.classList.remove('rb-ptt-idle');
      say(_t('js.pad.ptt.opening', 'opening the microphone…'), 'busy');
      navigator.mediaDevices.getUserMedia({ audio: micCons() }).then(function (s) {
        opening = false;
        stream = s;
        if (micSel.classList.contains('hide') || !micSel.options.length) listMics();   // names are readable now
        // The press already ended while the browser opened the mic (first-time permission prompt, a
        // slow device). A HOLD that's over is not a recording - let the mic go at once. (Before
        // 1.99bk this recorded on for 20 s with the room ducked; the next press "fixed" it.)
        if (myRequest !== requestGen || (upAt && upAt - pressAt > 400) || (host.ownerDocument || activeDoc || document).hidden || box.classList.contains('hide')) {
          release();
          // (ptttoast: in the Dock "keep holding" is the press's notice; a press that came to nothing takes its notice down)
          if (toastFn) say(upAt ? _t('js.pad.ptt.keep_holding', 'keep holding until it says Recording, then talk') : '', 'bad');
          else {
            txt.classList.toggle('rb-ptt-idle', !upAt);
            txt.textContent = upAt ? _t('js.pad.ptt.keep_holding', 'keep holding until it says Recording, then talk') : uptoText();
          }
          return;
        }
        var type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].filter(function (t) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t); })[0] || '';
        var r, chunks = [], t0 = Date.now(), capS = maxS;   // pttlimits: the max this recording started with
        try { r = new MediaRecorder(s, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined); }
        catch (e) { release(); say(_t('js.pad.ptt.cant_record', 'this browser can\'t record a clip'), 'bad'); return; }
        rec = r; recAt = t0;
        r.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        r.onstop = function () {
          if (stream === s) release();           // stopped some other way (track ended, page hidden)
          idle();
          send(chunks, r.mimeType, (Date.now() - t0) / 1000, capS, tid);
        };
        r.start(250); recordState(true);
        tapMode = !!upAt;                        // a quick tap started it: tap again to send
        btn.setAttribute('aria-pressed', 'true');
        btn.textContent = tapMode ? _t('js.pad.ptt.rec_tap', '⏺ Recording — tap to send') : _t('js.pad.ptt.rec_release', '⏺ Recording — release to send');
        say(_t('js.pad.ptt.recording', 'recording…'), 'busy', Math.max(TOAST_MS.busy, capS * 1000 + 5000));   // (ptttoast: it stays while the clip can last)
        recTimer = setTimeout(stop, Math.max(1000, capS * 1000 - PTT_EARLY_MS));   // pttlimits: the site's max length (was a fixed 20 s), 0.5 s early
      }).catch(function () { opening = false; release(); say(_t('js.pad.ptt.denied', 'the browser didn\'t allow the microphone'), 'bad'); });
    }
    function up() {
      if (!held) return;
      held = false; upAt = Date.now();
      if (ending || !rec || rec.state !== 'recording' || tapMode) return;
      if (Date.now() - recAt > 400) finish();    // relaymic: the release tail
      else { tapMode = true; btn.textContent = _t('js.pad.ptt.rec_tap', '⏺ Recording — tap to send'); }
    }
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      if (ending) return;                        // relaymic: a press during the release tail is ignored
      held = true; upAt = 0;
      // relaymic: the pointer stays this button's until it lifts - a mouse sliding off the 40 px dock button mid-word fired pointerleave,
      // which ended the clip (pointerleave stays below for a browser without pointer capture); one it can't capture records as before
      try { if (btn.setPointerCapture && e.pointerId != null) btn.setPointerCapture(e.pointerId); } catch (x) { /* not capturable */ }
      start();
    });
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });   // iOS / Android long-press menu
    btn.addEventListener('keydown', function (e) { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); if (ending) return; upAt = 1; start(); } });
    return {
      adopt: adopt,
      destroy: function () { gone = true; stop(); box.classList.add('hide'); if (pressTid) notice(pressTid, ''); },   // (ptttoast: and the press's notice)
      listMics: listMics,      // 1.99ajf dockclean: Audio settings re-reads the device names after it asked for them
      // ptttoast 1.99ana: the Room Dock's chat notices (pad-dock.js) - fn(text, {id, ms, bad}), null = the lines beside the button again
      useToast: function (fn) {
        toastFn = typeof fn === 'function' ? fn : null;
        txt.classList.toggle('rb-hide', !!toastFn); mine.classList.toggle('rb-hide', !!toastFn);
        if (toastFn) { txt.classList.add('rb-ptt-idle'); txt.textContent = uptoText(); mine.textContent = ''; }
        else last = '';                // (the line draws the latest clip again on the next view)
      },
      onRecording: function (fn) {
        if (typeof fn !== 'function') return function () {};
        recordListeners.push(fn); fn(recording);
        return function () { var i = recordListeners.indexOf(fn); if (i >= 0) recordListeners.splice(i, 1); };
      },
      update: function (d) {
        var on = !!(d && d.room && d.room.micRelay) && can;
        box.classList.toggle('hide', !on);
        if (!on) stop();
        // pttlimits: the max length the site says now - the idle line follows (a clip being recorded keeps the timer it started with)
        if (d && d.room) {
          var mx = pttMaxOf(d);
          if (mx !== maxS) { maxS = mx; if (txt.classList.contains('rb-ptt-idle')) txt.textContent = uptoText(); }
          tailMs = pttTailOf(d); tailIos = d.room.pttTailIos === true;     // relaymic: the release tail (the next release uses it)
        }
        var js = (d && d.mine) || [], k = JSON.stringify(js);
        if (k === last) return;
        last = k;
        var clips = js.filter(function (x) { return x.kind === 'clip'; }), j = clips[clips.length - 1];
        if (!toastFn) mine.textContent = j ? _t('js.pad.ptt.your_clip', '🎙 your clip: {status}', { status: clipStatus(j) }) : '';
        // ptttoast: each clip's words - in the Dock a notice when they change (the press's own once its upload answered, else one per
        // clip); a clip done before this page's first view (or shown on the line before the Dock took over) is not news, one on its way is
        var first = clipSeen === null, seen = {};
        clips.forEach(function (c) {
          var key = String(c.id), words = _t('js.pad.ptt.your_clip', '🎙 your clip: {status}', { status: clipStatus(c) });
          seen[key] = words;
          if ((clipSeen && clipSeen[key] === words) || (first && !clipBusy(c))) return;
          notice(jobTid[key] || 'ptt:j' + key, words, clipBusy(c) ? 'busy' : c.ok ? 'done' : 'bad', clipBusy(c) ? CLIP_OPEN_MS : 0);   // (review F4)
        });
        clipSeen = seen;
      },
    };
  }

  window.PATVRoom = { audio: audio, relay: relay, ptt: ptt, clipStatus: clipStatus, _ios: IOS,
    // story camera (1.99alu, story-camera.js): the camera's mic shares this page's audio session - before() just before it
    // opens, after() once it is released (the room's playback / auto, the player's volume and resume), like push-to-talk
    session: recSession,
    // micvad 1.99akk: the pure pieces of the level path, for the tests (test/micvad-player.test.js, micvad-contract.test.js)
    _lv: { header: lvHeader, session: lvSession, walk: lvWalk, scan: lvScan, feed: lvFeed, digitAt: lvAt, next: lvNext, fromPeak: lvFromPeak, heights: lvHeights } };
})();
