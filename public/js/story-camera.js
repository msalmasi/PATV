// Story camera (1.99alu): Story Studio opens on a live camera, like IG / Snapchat (story-studio.js calls open()).
//   tap the shutter     a photo: the current frame at the stream's own resolution, as a JPEG
//   press and hold      a video while held (with sound when the mic is allowed), stopped by itself just inside the
//                       story limit the server sends (caps.secs); let go to stop. A clip is at least MIN_MS long.
//   Space / Enter       a photo (so is a click from assistive tech)
//   🔄                  front / back camera (every open starts on the back one). The front PREVIEW is mirrored; the saved
//                       photo and video are not - they read the right way round, as everyone else sees you
//   🖼️                  the studio's own file picker (the camera stays until a file is chosen); ✕ / Escape close it
// A capture goes to the studio as a File, down the same path as a chosen file (same checks, same upload), and the studio
// offers Retake. The camera is released - every track stopped - whenever it isn't on screen: after a capture, on close,
// while the page is hidden (visibilitychange / pagehide); it starts again when the page comes back. Anything that stops
// it (no getUserMedia, not https, permission refused, no camera, a busy camera, an error) leaves the studio's picker -
// the capture input + Gallery - with a short reason. A refusal is remembered for the browser session, so it never asks
// again on every open; a refused mic means silent videos, said under the shutter.
// Recordings: Chrome / Android / Firefox write WebM (VP8 + Opus) with no length in its header - written in here before
// the hand-off (webmDuration), so the editor and ffprobe can read it; WebKit (every iPhone browser) writes MP4 (H.264 +
// AAC). The server re-encodes either (storycompose.js) and measures a header with no length from its packets.
// Review fixes (1.99alu):
//   * o.wait: the view is up at once, but the camera and mic are asked for only on go() - once the studio knows this person
//     can post (no prompt for a camera that could never post)
//   * a refusal is remembered only when it is the CAMERA's: a combined request refused while the mic is blocked and the
//     camera is still to ask gets the camera alone (silent videos). A memo is forgotten as soon as the Permissions API
//     says the site is allowed again (checked on load, on a blocked open, and on the permission's change event)
//   * no camera: a desktop (fine pointer) whose device list has no videoinput never shows the view; a NotFound is kept
//     for the page; both are tried again on devicechange. A phone always tries (its list can be empty before permission)
//   * iOS audio session: 'play-and-record' just before the mic opens, handed back the moment the camera is released -
//     inside the gesture that ends a capture (a let-go stops every track at once). On a pad page room-bridge.js owns the
//     session (PATVRoom.session: its playback / auto, the room player's volume and resume); elsewhere the old type returns
//   * a desktop webcam that names no facing faces you: its preview is mirrored too (the saved file still isn't)
(function () {
  'use strict';
  if (window.patvStoryCamera) return;
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var HOLD_MS = 250, MIN_MS = 1200, EARLY_MS = 250, JPEG_Q = 0.92, MEMO = 'patv.storycam', MEMO_MIC = 'patv.storycam.mic';
  var WEBM = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'], MP4 = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  var WEBM_SILENT = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'], MP4_SILENT = ['video/mp4;codecs=avc1', 'video/mp4'];
  var SVG = 'http://www.w3.org/2000/svg', RING = 238.76, current = null, refused = false, micRefused = false, serial = 0;
  // the page's view of its cameras: none = a NotFound this page (until devicechange); cams = videoinputs listed (null = not known yet)
  var none = false, cams = null, camsAsk = null, watching = {};
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function add(p, e) { p.appendChild(e); return e; }
  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function prevent(e) { e.preventDefault(); }
  function memo(key, value) { try { if (value === undefined) return window.sessionStorage.getItem(key); window.sessionStorage.setItem(key, value); } catch (e) { /* private mode: this page only */ } return null; }
  function unmemo(key) { try { window.sessionStorage.removeItem(key); } catch (e) { /* private mode */ } }
  function media() { var n = window.navigator, m = n && n.mediaDevices; return m && typeof m.getUserMedia === 'function' ? m : null; }
  function coarse() { try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } }
  function denial(e) { return !!e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError'); }
  function stopAll(stream) { if (stream && stream.getTracks) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* already ended */ } }); }
  function clock(secs) { var s = Math.max(0, Math.floor(secs)); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }
  function stamp() { var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  // '' when a live camera can be tried; otherwise the reason the studio shows next to its picker
  function unavailable() {
    if (window.isSecureContext === false || !media()) return _t('js.feed.cam.unsupported', 'This browser can\'t show a live camera here. Use 📷 Camera or 🖼️ Gallery instead.');
    if (refused || memo(MEMO) === 'denied') return _t('js.feed.cam.denied', 'Camera access is off for this site, so the live camera can\'t open. Use 📷 Camera or 🖼️ Gallery instead.');
    if (none || (cams === 0 && !coarse())) return _t('js.feed.cam.none', 'No camera was found. Choose a picture or video with 🖼️ Gallery.');
    return '';
  }
  // how many cameras the device list shows (no permission needed; a browser lists one per kind before it); -1 = can't tell
  function probe() {
    if (cams != null) return Promise.resolve(cams);
    if (camsAsk) return camsAsk;
    var M = media(); if (!M || typeof M.enumerateDevices !== 'function') return Promise.resolve(-1);
    var ask = camsAsk = Promise.resolve().then(function () { return M.enumerateDevices(); }).then(function (list) {
      var n = (list || []).filter(function (d) { return d && d.kind === 'videoinput'; }).length;
      if (camsAsk === ask) { cams = n; camsAsk = null; } return n;
    }, function () { if (camsAsk === ask) camsAsk = null; return -1; });
    return ask;
  }
  // the Permissions API's state for 'camera' / 'microphone' (null = can't tell); the first status of each is watched, so a
  // site allowed again in the browser's settings forgets the memo at once
  function perm(name) {
    var P = window.navigator && window.navigator.permissions;
    if (!P || typeof P.query !== 'function') return Promise.resolve(null);
    return Promise.resolve().then(function () { return P.query({ name: name }); }).then(function (st) {
      if (st && typeof st.addEventListener === 'function' && !watching[name]) { watching[name] = true; st.addEventListener('change', function () { if (st.state === 'granted') forget(name); }); }
      return st && st.state ? st.state : null;
    }, function () { return null; });
  }
  function forget(name) { if (name === 'camera') { refused = false; unmemo(MEMO); } else { micRefused = false; unmemo(MEMO_MIC); } }
  function recheck() {
    if (refused || memo(MEMO) === 'denied') perm('camera').then(function (s) { if (s === 'granted') forget('camera'); });
    if (micRefused || memo(MEMO_MIC) === 'denied') perm('microphone').then(function (s) { if (s === 'granted') forget('microphone'); });
  }
  // the recorder type: WebM where it is native (its length is fixed below), MP4 on Apple's WebKit; null = can't record here
  function recType(silent) {
    var MR = window.MediaRecorder; if (typeof MR !== 'function') return null;
    if (typeof MR.isTypeSupported !== 'function') return '';
    var apple = /Apple/.test((window.navigator && window.navigator.vendor) || ''), webm = silent ? WEBM_SILENT : WEBM, mp4 = silent ? MP4_SILENT : MP4;
    var list = apple ? mp4.concat(webm) : webm.concat(mp4);
    for (var i = 0; i < list.length; i++) { try { if (MR.isTypeSupported(list[i])) return list[i]; } catch (e) { /* next */ } }
    return null;
  }
  function button(cls, icon, label, fn) {
    var b = el('button', 'scam-btn ' + cls); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
    var ic = add(b, el('span', 'scam-ic', icon)); ic.setAttribute('aria-hidden', 'true'); b.addEventListener('click', fn); return b;
  }

  // o: { wait, draft, secs(), file(file, info), gallery(), close(), unavailable(why) }. o.wait: the view only, until go().
  function open(host, o) {
    var why = unavailable(); if (why) { recheck(); o.unavailable(why); return null; }
    if (current) close(current);
    var c = current = { id: ++serial, host: host, o: o, facing: 'environment', device: null, gen: 0, closed: false, ready: false, paused: false, busy: false,
      waiting: !!o.wait, session: false, mic: micRefused || memo(MEMO_MIC) === 'denied' ? false : true, noMic: false, restarts: 0, handled: -Infinity, on: [] };
    build(c); bind(c);
    if (c.waiting) note(c, _t('js.feed.cam.starting', 'Starting the camera…')); else start(c);
    c.shutter.focus();
    return { close: function () { close(c); }, cancel: function () { cancel(c); }, go: function () { go(c); },
      // a word over the camera (a file the studio refused, chosen with 🖼️): it stays until the next press
      say: function (text) { if (!c.closed) note(c, text, 'error'); } };
  }
  function go(c) { if (c.closed || !c.waiting) return; c.waiting = false; if (!c.paused) start(c); }
  function build(c) {
    var v = c.view = el('div', 'scam'); v.setAttribute('role', 'group'); v.setAttribute('aria-label', _t('js.feed.cam.label', 'Story camera')); v.setAttribute('data-facing', c.facing);
    var video = c.video = add(v, el('video', 'scam-video'));
    video.muted = true; video.defaultMuted = true; video.playsInline = true; video.autoplay = true; video.disablePictureInPicture = true;
    ['playsinline', 'webkit-playsinline', 'muted', 'autoplay'].forEach(function (a) { video.setAttribute(a, ''); }); video.setAttribute('aria-hidden', 'true');
    ['loadedmetadata', 'playing', 'resize'].forEach(function (type) { video.addEventListener(type, function () { ready(c); }); });
    add(v, el('div', 'scam-flash'));
    var top = add(v, el('div', 'scam-top'));
    // ✕ closes the camera; with no draft behind it, that is the whole story editor (the studio's close callback)
    var closeLabel = c.o.draft ? _t('js.feed.cam.close', 'Close the camera') : _t('js.feed.cam.close_story', 'Close story editor');
    c.closeButton = add(top, button('scam-close', '✕', closeLabel, function () { cancel(c); }));
    c.time = add(top, el('span', 'scam-time')); c.time.hidden = true; c.time.setAttribute('aria-hidden', 'true');
    c.flip = add(top, button('scam-flip', '🔄', _t('js.feed.cam.flip', 'Switch camera'), function () { flip(c); })); c.flip.hidden = true;
    c.note = add(v, el('div', 'scam-note')); c.note.setAttribute('role', 'status'); c.note.setAttribute('aria-live', 'polite'); c.note.hidden = true;
    c.noteText = add(c.note, el('p'));
    c.retry = add(c.note, el('button', 'scam-retry', _t('js.feed.cam.retry', 'Try again'))); c.retry.type = 'button'; c.retry.hidden = true;
    c.retry.addEventListener('click', function () { c.restarts = 0; start(c); });
    var foot = add(v, el('div', 'scam-foot')), row = add(foot, el('div', 'scam-row'));
    c.gallery = add(row, button('scam-gallery', '🖼️', _t('js.feed.cam.gallery', 'Choose from your gallery'), function () { if (!c.rec && !c.busy) c.o.gallery(); }));
    var s = c.shutter = add(row, el('button', 'scam-shutter')); s.type = 'button';
    var ring = add(s, document.createElementNS(SVG, 'svg')); ring.setAttribute('viewBox', '0 0 84 84'); ring.setAttribute('aria-hidden', 'true'); ring.setAttribute('focusable', 'false');
    [['scam-ring-base', 0], ['scam-ring', RING]].forEach(function (p) {
      var circle = add(ring, document.createElementNS(SVG, 'circle')); circle.setAttribute('class', p[0]); circle.setAttribute('cx', '42'); circle.setAttribute('cy', '42'); circle.setAttribute('r', '38');
      if (p[1]) { circle.setAttribute('stroke-dasharray', String(RING)); circle.setAttribute('stroke-dashoffset', String(RING)); }
    });
    add(s, el('span', 'scam-disc')).setAttribute('aria-hidden', 'true');
    add(row, el('span', 'scam-spacer'));
    c.hint = add(foot, el('p', 'scam-hint')); c.hint.id = 'scam-hint-' + c.id; s.setAttribute('aria-describedby', c.hint.id);
    c.live = add(v, el('span', 'ds-sr-only')); c.live.setAttribute('role', 'status'); c.live.setAttribute('aria-live', 'polite');
    c.host.appendChild(v); c.host.classList.add('scam-open'); paint(c);
  }
  function bind(c) {
    var s = c.shutter;
    function on(target, type, fn, opt) { target.addEventListener(type, fn, opt); c.on.push([target, type, fn, opt]); }
    on(s, 'pointerdown', function (e) { down(c, e); });
    on(s, 'pointerup', function (e) { up(c, e, true); });
    on(s, 'pointercancel', function (e) { up(c, e, false); });
    on(s, 'lostpointercapture', function (e) { up(c, e, false); });
    // keyboard: Space / Enter = a photo (the button's own click is held off); a click with no press before it = assistive tech
    on(s, 'keydown', function (e) { if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return; e.preventDefault(); if (e.repeat) return; c.handled = now(); photo(c); });
    on(s, 'click', function (e) { e.preventDefault(); if (now() - c.handled < 800) return; c.handled = now(); photo(c); });
    on(s, 'contextmenu', prevent); on(s, 'selectstart', prevent); on(s, 'dragstart', prevent);
    on(document, 'visibilitychange', function () { if (document.visibilityState === 'hidden' || document.hidden === true) away(c); else back(c); });
    on(window, 'pagehide', function () { away(c); });
    on(window, 'pageshow', function () { if (!document.hidden) back(c); });
  }
  function paint(c) {
    if (!c.view) return;
    var rec = !!c.rec, v = c.view, can = recType(c.noMic) != null;
    // let go before the shortest clip (MIN_MS), or stopped and still writing: it says so, not "Let go to stop"
    var finishing = rec && (c.rec.stopping || !!c.rec.min), finish = _t('js.feed.cam.finishing', 'Finishing the video…');
    v.classList.toggle('scam-ready', !!c.ready); v.classList.toggle('scam-recording', rec); v.setAttribute('data-facing', c.facing);
    c.shutter.setAttribute('aria-disabled', String(!c.ready || c.busy || finishing));
    c.shutter.setAttribute('aria-label', finishing ? finish : rec ? _t('js.feed.cam.recording', 'Recording. Let go to stop.') : can ? _t('js.feed.cam.shutter', 'Take a photo. Press and hold to record a video.') : _t('js.feed.cam.shutter_photo', 'Take a photo'));
    c.hint.textContent = finishing ? finish : rec ? _t('js.feed.cam.release', 'Let go to stop') : c.noMic && can ? _t('js.feed.cam.no_mic', 'No microphone: videos will have no sound.')
      : can ? _t('js.feed.cam.hint', 'Tap for a photo, hold for a video') : _t('js.feed.cam.hint_photo', 'Tap for a photo');
    c.flip.disabled = rec || c.busy; c.gallery.disabled = rec || c.busy; c.time.hidden = !rec;
  }
  // a note over the camera: 'wait' goes when the picture arrives; an error stays until the next press
  function note(c, text, kind) { c.noteKind = text ? kind || 'wait' : ''; c.noteText.textContent = text || ''; c.note.hidden = !text; c.retry.hidden = kind !== 'retry'; }
  function micOnly(e) {
    // camera + mic refused together: the camera alone is tried when the camera itself is allowed (no second prompt), or when
    // it is the MIC that is blocked and the camera is still to ask (a single camera-only prompt). Anything else is the camera's.
    if (denial(e)) return Promise.all([perm('camera'), perm('microphone')]).then(function (s) { return s[0] === 'granted' || (s[0] === 'prompt' && s[1] === 'denied'); });
    return Promise.resolve(true);    // no mic, a busy mic, a constraint: the camera alone
  }
  // iOS (Safari 17+'s Audio Session API): the page records only in a play-and-record session, and only a user gesture lets a
  // paused room player play again - so it is set just before the mic opens and handed back as the camera is released.
  function sessionBefore(c) {
    if (c.session) return; c.session = true;
    var R = c.sessionBy = window.PATVRoom && window.PATVRoom.session && typeof window.PATVRoom.session.before === 'function' ? window.PATVRoom.session : null;
    if (R) { try { R.before(); } catch (e) { /* the room's own session stays */ } return; }
    try { var A = window.navigator && window.navigator.audioSession; if (A) { c.sessionWas = A.type; A.type = 'play-and-record'; } } catch (e) { /* no Audio Session API */ }
  }
  function sessionAfter(c) {
    if (!c.session) return; c.session = false;
    var R = c.sessionBy; c.sessionBy = null;
    if (R) { try { R.after(); } catch (e) { /* the room's own session stays */ } return; }
    try {
      var A = window.navigator && window.navigator.audioSession;
      if (A && A.type === 'play-and-record') A.type = c.sessionWas && c.sessionWas !== 'play-and-record' ? c.sessionWas : 'auto';
    } catch (e) { /* no Audio Session API */ }
  }
  function start(c) {
    if (c.closed || c.waiting) return;
    var why = unavailable(); if (why) { fallback(c, why); return; }
    var n = ++c.gen, M = media(), video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (c.device) video.deviceId = { exact: c.device }; else video.facingMode = { ideal: c.facing };
    thaw(c); c.ready = false; c.paused = false; if (c.noteKind !== 'error') note(c, _t('js.feed.cam.starting', 'Starting the camera…')); paint(c);
    function ask(audio) { return Promise.resolve().then(function () { return M.getUserMedia({ video: video, audio: audio ? { echoCancellation: true, noiseSuppression: true } : false }); }); }
    function live() { return n === c.gen && !c.closed && !c.paused; }
    probe().then(function (count) {
      if (!live()) return null;
      // a desktop whose device list has no camera: nothing to ask for (a phone asks anyway - its list can be empty before permission)
      if (count === 0 && !coarse()) { var e = new Error('no camera'); e.name = 'NotFoundError'; throw e; }
      var withMic = c.mic;
      if (withMic) sessionBefore(c); else sessionAfter(c);
      return !withMic ? ask(false) : ask(true).catch(function (e) {
        return micOnly(e).then(function (retry) {
          if (!retry || n !== c.gen || c.closed) throw e;
          sessionAfter(c);
          return ask(false).then(function (stream) { c.mic = false; if (denial(e)) { micRefused = true; memo(MEMO_MIC, 'denied'); } return stream; });
        });
      });
    }).then(function (stream) { if (!stream) return; if (!live()) { stopAll(stream); return; } attach(c, stream); },
      function (e) { if (n !== c.gen || c.closed) return; failed(c, e); });
  }
  function attach(c, stream) {
    c.stream = stream; c.noMic = !(stream.getAudioTracks && stream.getAudioTracks().length);
    var track = stream.getVideoTracks ? stream.getVideoTracks()[0] : null, st = track && track.getSettings ? track.getSettings() : {};
    if (st && typeof st.facingMode === 'string' && st.facingMode) c.facing = st.facingMode === 'user' ? 'user' : 'environment';
    else if (!coarse()) c.facing = 'user';     // a desktop webcam names no facing: it faces you, so its preview is mirrored too
    c.deviceId = st && st.deviceId;
    if (track) track.addEventListener('ended', function () { if (c.stream === stream && !c.closed) ended(c); });
    try { c.video.srcObject = stream; } catch (e) { failed(c, e); return; }
    var played = c.video.play && c.video.play(); if (played && played.catch) played.catch(function () { /* muted + playsinline: the frame still arrives */ });
    paint(c); ready(c);
    var M = media();
    if (M && typeof M.enumerateDevices === 'function') {
      M.enumerateDevices().then(function (list) {
        if (c.closed) return; var cams = (list || []).filter(function (d) { return d.kind === 'videoinput'; });
        c.cams = cams.map(function (d) { return d.deviceId; }); c.flip.hidden = cams.length < 2;
      }, function () { c.flip.hidden = false; });
    } else c.flip.hidden = false;
  }
  function ready(c) {
    if (c.closed || !c.stream || c.ready || !c.video.videoWidth || !c.video.videoHeight) return;
    c.ready = true; c.restarts = 0; if (c.noteKind === 'wait') note(c, ''); paint(c);
  }
  function ended(c) {
    // the camera was taken away (another app, the system): once more by itself, then a button
    release(c);
    if (document.hidden) { c.paused = true; return; }
    if (c.restarts++ < 1) { start(c); return; }
    note(c, _t('js.feed.cam.stopped', 'The camera stopped.'), 'retry'); paint(c);
  }
  function failed(c, e) {
    var name = e && e.name, why;
    if (denial(e)) {
      // the camera's own refusal (micOnly ruled out a blocked mic): remembered for the session, watched for an allow
      refused = true; memo(MEMO, 'denied'); perm('camera'); why = _t('js.feed.cam.denied', 'Camera access is off for this site, so the live camera can\'t open. Use 📷 Camera or 🖼️ Gallery instead.');
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      none = true; why = _t('js.feed.cam.none', 'No camera was found. Choose a picture or video with 🖼️ Gallery.');     // this page, until devicechange
    } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') why = _t('js.feed.cam.busy', 'The camera is in use by another app. Use 📷 Camera or 🖼️ Gallery instead.');
    else why = _t('js.feed.cam.error', 'The camera couldn\'t start. Use 📷 Camera or 🖼️ Gallery instead.');
    fallback(c, why);
  }
  function fallback(c, why) { var o = c.o; close(c); o.unavailable(why); }
  // keep: the audio session stays (a flip: the next camera opens at once with the mic)
  function release(c, keep) {
    c.gen++; var s = c.stream; c.stream = null; c.ready = false;
    stopAll(s);
    if (c.video) { try { c.video.pause(); } catch (e) { /* not playing */ } try { c.video.srcObject = null; } catch (e) { /* old browser */ } }
    if (!keep) sessionAfter(c);
    paint(c);
  }
  // the last frame stays on screen (over the released camera) while a capture is encoded
  function freeze(c) {
    if (c.frozen) return c.frozen;
    var v = c.video, w = v && v.videoWidth, h = v && v.videoHeight; if (!w || !h) return null;
    var canvas = document.createElement('canvas'), ctx = canvas.getContext && canvas.getContext('2d'); if (!ctx) return null;
    canvas.width = w; canvas.height = h;
    try { ctx.drawImage(v, 0, 0, w, h); } catch (e) { return null; }
    canvas.className = 'scam-freeze'; canvas.setAttribute('aria-hidden', 'true'); c.view.insertBefore(canvas, c.video.nextSibling || null);
    return (c.frozen = canvas);
  }
  function thaw(c) { if (c.frozen) { c.frozen.remove(); c.frozen = null; } if (c.view) c.view.classList.remove('scam-snap'); }
  function away(c) {
    if (c.closed) return;
    if (c.press) { clearTimeout(c.press.timer); c.press = null; }
    if (c.rec) stopRec(c, 'hidden');      // what was filmed is kept: it goes to the editor
    c.paused = true; release(c);
  }
  function back(c) { if (c.closed || !c.paused || c.rec || c.busy) return; c.paused = false; c.restarts = 0; start(c); }     // (still waiting: start waits too)
  function flip(c) {
    if (c.rec || c.busy || c.closed) return;
    // a phone: the other facing mode; a desktop whose cameras have no facing: the next camera in the list
    var t = c.stream && c.stream.getVideoTracks ? c.stream.getVideoTracks()[0] : null, st = t && t.getSettings ? t.getSettings() : {};
    if (!(st && st.facingMode) && c.cams && c.cams.length > 1) c.device = c.cams[(c.cams.indexOf(c.device || c.deviceId) + 1) % c.cams.length];
    else { c.device = null; c.facing = c.facing === 'user' ? 'environment' : 'user'; }
    release(c, true); start(c);      // released first: a phone opens one camera at a time (the audio session stays)
  }
  function down(c, e) {
    if (e.button != null && e.button !== 0) return;
    if (e.isPrimary === false) return;
    e.preventDefault();
    if (c.press || c.rec || c.busy || !c.ready) return;
    if (c.noteKind && c.noteKind !== 'wait') note(c, '');
    var press = c.press = { id: e.pointerId, held: false };
    try { if (c.shutter.setPointerCapture && e.pointerId != null) c.shutter.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    c.shutter.classList.add('scam-pressed');
    press.timer = setTimeout(function () { if (c.press === press && !c.closed) { press.held = true; record(c); } }, HOLD_MS);
  }
  function up(c, e, released) {
    var p = c.press; if (!p || (p.id != null && e.pointerId != null && e.pointerId !== p.id)) return;
    c.press = null; clearTimeout(p.timer); c.handled = now(); c.shutter.classList.remove('scam-pressed');
    if (!p.held) { if (released) photo(c); return; }        // a tap; a cancelled touch takes nothing
    if (c.rec) stopRec(c, 'release');
    else if (released) photo(c);                             // this browser can't record: a hold is a photo
  }
  function photo(c) {
    if (c.closed || c.busy || c.rec || !c.ready) return;
    var v = c.video; if (!v.videoWidth || !v.videoHeight) return;
    // the frame, at the stream's own size, stays on screen while it encodes; the camera is already off (in this gesture)
    var canvas = freeze(c);
    if (!canvas || typeof canvas.toBlob !== 'function') { thaw(c); note(c, _t('js.feed.cam.failed', 'That didn\'t work. Try again.'), 'error'); return; }
    c.busy = true; c.view.classList.add('scam-snap'); release(c);
    canvas.toBlob(function (blob) {
      c.busy = false; if (c.closed) return;
      if (!blob || !blob.size) { thaw(c); note(c, _t('js.feed.cam.failed', 'That didn\'t work. Try again.'), 'error'); start(c); return; }
      hand(c, blob, 'image/jpeg', 0);
    }, 'image/jpeg', JPEG_Q);
  }
  function limitMs(c) { var secs = Number(c.o.secs && c.o.secs()) || 30; return Math.max(2, Math.min(secs, 600)) * 1000; }
  function record(c) {
    var type = recType(c.noMic), MR = window.MediaRecorder;
    if (type == null || !c.stream) return;                 // a photo on release instead
    var options = { videoBitsPerSecond: 4000000 }, r;
    if (type) options.mimeType = type; if (!c.noMic) options.audioBitsPerSecond = 128000;
    try { r = new MR(c.stream, options); } catch (e) { try { r = new MR(c.stream); } catch (e2) { return; } }
    var rec = c.rec = { r: r, chunks: [], type: type || '', began: now(), limit: limitMs(c) };
    r.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
    r.onstart = function () { if (rec.stopping) return; rec.began = now(); clearTimeout(rec.timer); rec.timer = setTimeout(function () { stopRec(c, 'limit'); }, rec.limit - EARLY_MS); };
    r.onstop = function () { done(c, rec); };
    r.onerror = function () { rec.failed = true; if (r.state === 'inactive') done(c, rec); else { try { r.stop(); } catch (e) { done(c, rec); } } };
    try { r.start(1000); } catch (e) { c.rec = null; return; }
    rec.timer = setTimeout(function () { stopRec(c, 'limit'); }, rec.limit - EARLY_MS);
    c.view.style.setProperty('--scam-secs', (rec.limit - EARLY_MS) / 1000 + 's');
    c.live.textContent = _t('js.feed.cam.recording_on', 'Recording video');
    paint(c); tick(c, rec);
  }
  function tick(c, rec) {
    if (c.rec !== rec || rec.stopping) return;
    c.time.textContent = clock((now() - rec.began) / 1000) + ' / ' + clock(rec.limit / 1000);
    rec.clock = setTimeout(function () { tick(c, rec); }, 250);
  }
  function stopRec(c, why) {
    var rec = c.rec; if (!rec || rec.stopping) return;
    var held = now() - rec.began;
    if (why === 'release' && held < MIN_MS) { if (!rec.min) { rec.min = setTimeout(function () { rec.min = 0; stopRec(c, 'min'); }, MIN_MS - held); paint(c); } return; }
    rec.stopping = true; rec.ended = now(); clearTimeout(rec.timer); clearTimeout(rec.min); clearTimeout(rec.clock);
    try { if (rec.r.state !== 'inactive') rec.r.stop(); else { done(c, rec); return; } } catch (e) { done(c, rec); return; }
    // the recorder keeps what it has; every track stops now - inside the let-go itself (iOS: the session and a paused
    // room player come back from a gesture), with the last frame left on screen until the clip is handed over
    freeze(c); release(c);
  }
  function done(c, rec) {
    if (rec.done) return; rec.done = true; if (c.rec === rec) c.rec = null;
    clearTimeout(rec.timer); clearTimeout(rec.min); clearTimeout(rec.clock);
    var secs = Math.round(Math.max(0, (rec.ended || now()) - rec.began)) / 1000;
    var type = String(rec.r.mimeType || rec.type || (rec.chunks[0] && rec.chunks[0].type) || 'video/webm').split(';')[0].trim() || 'video/webm';
    c.live.textContent = ''; release(c);
    if (c.closed || rec.discard) return;
    if (rec.failed || !rec.chunks.length) { thaw(c); note(c, _t('js.feed.cam.failed', 'That didn\'t work. Try again.'), 'error'); if (!c.paused) start(c); return; }
    var blob = new Blob(rec.chunks, { type: type });
    c.busy = true; paint(c);
    (/webm/.test(type) ? webmDuration(blob, secs).catch(function () { return blob; }) : Promise.resolve(blob)).then(function (b) { c.busy = false; hand(c, b, type, secs); });
  }
  function hand(c, blob, type, secs) {
    if (c.closed) return;
    var kind = /^image\//.test(type) ? 'image' : 'video', ext = kind === 'image' ? 'jpg' : /mp4/.test(type) ? 'mp4' : 'webm';
    var name = 'story-' + (kind === 'image' ? 'photo' : 'video') + '-' + stamp() + '.' + ext, file = blob;
    try { file = new File([blob], name, { type: type, lastModified: Date.now() }); } catch (e) { try { file.name = name; } catch (e2) { /* read-only */ } }
    var o = c.o, info = { camera: true, kind: kind, secs: kind === 'video' ? secs : 0, facing: c.facing, sound: kind === 'video' && !c.noMic };
    close(c); o.file(file, info);
  }
  function close(c) {
    if (c.closed) return; c.closed = true;
    if (c.press) { clearTimeout(c.press.timer); c.press = null; }
    if (c.rec) { var rec = c.rec; rec.discard = true; clearTimeout(rec.timer); clearTimeout(rec.min); clearTimeout(rec.clock); try { if (rec.r.state !== 'inactive') rec.r.stop(); } catch (e) { /* stopped */ } c.rec = null; }
    release(c);
    c.on.forEach(function (x) { x[0].removeEventListener(x[1], x[2], x[3]); }); c.on = [];
    var had = c.view.contains(document.activeElement);
    c.view.remove(); c.host.classList.remove('scam-open'); if (current === c) current = null;
    if (had && c.host.focus) c.host.focus();
  }
  function cancel(c) { if (c.closed) return; var o = c.o; close(c); o.close(); }

  // ── WebM length (Chrome / Android / Firefox MediaRecorder files carry none) ──
  // Writes a Duration into the Segment's Info - a float in TimecodeScale units - or fills in a zero one. Only the first
  // bytes are rewritten; the media itself is copied as it is. A SeekHead's positions after the Info move by the bytes
  // added; anything unexpected (Cues, an Info that isn't before the first Cluster, a cut-off header) leaves the file as it is.
  var EBML = 0x1A45DFA3, SEGMENT = 0x18538067, INFO = 0x1549A966, CLUSTER = 0x1F43B675, SEEKHEAD = 0x114D9B74, SEEK = 0x4DBB,
    SEEKID = 0x53AB, SEEKPOS = 0x53AC, CUES = 0x1C53BB6B, SCALE = 0x2AD7B1, DURATION = 0x4489;
  function idAt(b, at) {
    var f = b[at], len = f & 0x80 ? 1 : f & 0x40 ? 2 : f & 0x20 ? 3 : f & 0x10 ? 4 : 0;
    if (!len || at + len > b.length) return null;
    var id = 0; for (var i = 0; i < len; i++) id = id * 256 + b[at + i]; return { len: len, id: id };
  }
  function sizeAt(b, at) {
    var f = b[at], len = 1, mask = 0x80;
    if (at >= b.length || !f) return null;
    while (!(f & mask)) { len++; mask >>= 1; }
    if (at + len > b.length) return null;
    var v = f & (mask - 1), ones = v === mask - 1;
    for (var i = 1; i < len; i++) { v = v * 256 + b[at + i]; if (b[at + i] !== 0xff) ones = false; }
    return { len: len, value: v, unknown: ones };
  }
  function uint(b, at, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[at + i]; return v; }
  function putUint(b, at, n, v) { for (var i = n - 1; i >= 0; i--) { b[at + i] = v % 256; v = Math.floor(v / 256); } return v === 0; }
  function putSize(b, at, n, v) { if (v >= Math.pow(2, 7 * n) - 1) return false; putUint(b, at, n, v); b[at] |= 0x80 >> (n - 1); return true; }
  // the children of b[from, to): fn(id, at, data, end, size) - false stops the walk; a child that runs past `to` ends it unread
  function kids(b, from, to, fn) {
    for (var p = from; p < to;) {
      var id = idAt(b, p), sz = id && sizeAt(b, p + id.len); if (!id || !sz) return false;
      var data = p + id.len + sz.len, end = sz.unknown ? to : data + sz.value;
      if (end > to) return false;
      if (fn(id.id, p, data, end, sz) === false) return true;
      if (sz.unknown) return false;
      p = end;
    }
    return true;
  }
  function patch(b, ms) {
    var head = idAt(b, 0), hs = head && head.id === EBML && sizeAt(b, head.len); if (!hs || hs.unknown) return null;
    var at = head.len + hs.len + hs.value, seg = idAt(b, at), ss = seg && seg.id === SEGMENT && sizeAt(b, at + seg.len); if (!ss) return null;
    var start = at + seg.len + ss.len, info = null, seeks = [], bad = false;
    var walked = kids(b, start, b.length, function (id, p, data, end, sz) {
      if (id === CLUSTER) return false;
      if (sz.unknown) { bad = true; return false; }
      // Cues (and a second SeekHead) hold positions this doesn't rewrite
      if (id === SEEKHEAD) kids(b, data, end, function (sid, sp, sdata, send) {
        if (sid !== SEEK) return; var entry = {};
        kids(b, sdata, send, function (eid, ep, edata, eend) { if (eid === SEEKID) entry.id = uint(b, edata, eend - edata); if (eid === SEEKPOS) { entry.at = edata; entry.n = eend - edata; } });
        if (entry.id === CUES || entry.id === SEEKHEAD) bad = true; if (entry.at != null) seeks.push(entry);
      });
      if (id === INFO) { info = { at: p, idLen: idAt(b, p).len, data: data, end: end, size: sz }; return false; }
    });
    if (!walked || bad || !info) return null;
    var scale = 1000000, dur = null;
    kids(b, info.data, info.end, function (id, p, data, end) { if (id === SCALE) scale = uint(b, data, end - data) || scale; if (id === DURATION) dur = { at: data, n: end - data }; });
    var value = ms * 1000000 / scale, out, view;
    if (dur) {
      if (dur.n !== 4 && dur.n !== 8) return null;
      view = new DataView(b.buffer, b.byteOffset + dur.at, dur.n);
      if ((dur.n === 8 ? view.getFloat64(0) : view.getFloat32(0)) > 0) return null;   // it already has one
      out = new Uint8Array(b); view = new DataView(out.buffer, dur.at, dur.n);
      if (dur.n === 8) view.setFloat64(0, value); else view.setFloat32(0, value);
      return out;
    }
    // a new Duration (id 4489, size 8, float64); Info's size is rewritten as an 8-byte size
    var el = new Uint8Array(11); el[0] = 0x44; el[1] = 0x89; el[2] = 0x88; new DataView(el.buffer).setFloat64(3, value);
    var size = new Uint8Array(8); size[0] = 0x01; putUint(size, 1, 7, info.end - info.data + 11);
    var grow = 8 - info.size.len + 11, idEnd = info.at + info.idLen;
    out = new Uint8Array(b.length + grow);
    out.set(b.subarray(0, idEnd), 0); out.set(size, idEnd); out.set(b.subarray(info.data, info.end), idEnd + 8);
    out.set(el, idEnd + 8 + (info.end - info.data)); out.set(b.subarray(info.end), idEnd + 8 + (info.end - info.data) + 11);
    // the Segment's own size, when it has one, and SeekHead positions past the Info (SeekHeads sit before it)
    if (!ss.unknown && !putSize(out, at + seg.len, ss.len, ss.value + grow)) return null;
    for (var i = 0; i < seeks.length; i++) {
      var e = seeks[i], pos = uint(b, e.at, e.n);
      if (start + pos > info.at && !putUint(out, e.at, e.n, pos + grow)) return null;
    }
    return out;
  }
  function webmDuration(blob, secs) {
    if (!(secs > 0) || !blob || !blob.size) return Promise.resolve(blob);
    var headSize = Math.min(blob.size, 65536), head = blob.slice(0, headSize);
    var read = head.arrayBuffer ? head.arrayBuffer() : new Response(head).arrayBuffer();
    return Promise.resolve(read).then(function (buffer) {
      var out = patch(new Uint8Array(buffer), Math.round(secs * 1000));
      return out ? new Blob([out, blob.slice(headSize)], { type: blob.type }) : blob;
    }, function () { return blob; });
  }

  // the page's first look, no prompt: how many cameras are listed, and whether a refusal remembered in this tab still holds;
  // a camera plugged in (or out) is looked for again
  (function () {
    var M = media(); if (!M) return;
    if (typeof M.addEventListener === 'function') M.addEventListener('devicechange', function () { cams = null; camsAsk = null; none = false; });
    probe(); recheck();
  })();
  window.patvStoryCamera = { open: open, available: function () { return !unavailable(); }, _webmDuration: webmDuration, _recType: recType };
})();
