// stage-lowlat.js — the ⚡ Low latency toggle on the stage players (1.99et). Only on the page while the stage
// setting webrtc_enabled is on; stage-room.js wraps its HLS player with it when it's there.
//
//   var p = PATVStage.rtcWrap(hlsPlayer, { wrap, reconnect, unmute, box? })
//   p.setSrc(hlsUrl, whepUrl?)   whepUrl only for a stream published over WHIP (the API's slot.whep)
//   p.start() / p.stop() / p.running() / p.src() / p.state()     same as stage-player.js
//
// The button shows only when the stream has a WHEP URL. On = play it over WebRTC (webrtc-client.js); any
// error, a timeout or a lost connection falls back to the HLS player straight away - never a dead player -
// and that stream isn't retried until the viewer presses the button again. The choice is remembered per
// browser (localStorage, wrapped: private mode / blocked storage just means "off").
//
// 1.99ey: the button auto-hides like the other video controls (.lowlat.idle = opacity 0, no pointer events, still
// focusable). On HLS it follows video.js's own state (vjs-user-inactive hides it, vjs-paused keeps it); on WebRTC
// the .rtc-video replaces video.js, so the same rule runs here: mousemove / touch / focus in the player shows it,
// it hides after video.js's inactivityTimeout, and stays while hovered, focused, paused or just after a fallback
// (the error title). A tap that only woke the controls never toggles low latency.
(function () {
  'use strict';
  var KEY = 'patv.lowLatency';
  var NOTE_MS = 6000;        // a fallback keeps the button (and its error title) up this long
  var TAP_GUARD_MS = 600;    // a click this soon after a touch that revealed the button is the same tap
  function wrap(hls, o, deps) {
    deps = deps || {};
    var doc = deps.document || document;
    var T = deps.timers || { set: function (f, ms) { return setTimeout(f, ms); }, clear: function (t) { clearTimeout(t); },
                             now: function () { return Date.now(); } };
    var vjsOpts = window.videojs && window.videojs.options;
    var DELAY = deps.inactivity || (vjsOpts && Number(vjsOpts.inactivityTimeout)) || 2000;
    var MO = deps.MutationObserver !== undefined ? deps.MutationObserver : (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    var store = deps.storage !== undefined ? deps.storage : (function () { try { return window.localStorage; } catch (e) { return null; } })();
    var rtc = deps.rtc || window.PATVRtc || null;
    function pref() { try { return !!store && store.getItem(KEY) === '1'; } catch (e) { return false; } }
    function setPref(on) { try { if (store) store.setItem(KEY, on ? '1' : '0'); } catch (e) { /* not remembered */ } }

    var hlsSrc = hls.src(), whep = null, running = false, mode = 'hls', failedFor = null, attempt = 0, sess = null, video = null, note = '';
    var btn = doc.createElement('button');
    btn.type = 'button'; btn.className = 'lowlat hide';
    btn.textContent = '⚡ Low latency';
    var box = o.box || o.wrap.parentNode || o.wrap;
    box.appendChild(btn);
    function reconnecting(on) { if (o.reconnect) o.reconnect.classList.toggle('hide', !on); }

    // ── auto-hide ──
    var act = { active: true, hover: false, focus: false, timer: null, pinUntil: 0, pinTimer: null, idle: false, touchAt: -1e9 };
    function vjsEl() { try { return o.wrap.querySelector ? o.wrap.querySelector('.video-js') : null; } catch (e) { return null; } }
    function idleNow() {
      if (act.hover || act.focus || T.now() < act.pinUntil) return false;
      if (mode === 'rtc') return !!video && !video.paused && !act.active;
      var v = vjsEl();
      if (v && v.classList) return v.classList.contains('vjs-user-inactive') && !v.classList.contains('vjs-paused');
      return false;                                        // no video.js player (stopped / not started): leave it up
    }
    function applyIdle() {
      var idle = idleNow();
      if (idle === act.idle) return;
      act.idle = idle;
      btn.classList.toggle('idle', idle);
    }
    function poke() {                                      // activity in the player (the WebRTC path's own timer)
      act.active = true;
      if (act.timer) T.clear(act.timer);
      act.timer = T.set(function () { act.timer = null; act.active = false; applyIdle(); }, DELAY);
      applyIdle();
    }
    function pin(ms) {
      act.pinUntil = T.now() + ms;
      if (act.pinTimer) T.clear(act.pinTimer);
      act.pinTimer = T.set(function () { act.pinTimer = null; applyIdle(); }, ms + 1);
      applyIdle();
    }
    function on(el, ev, f, opt) { if (el && el.addEventListener) el.addEventListener(ev, f, opt); }
    on(box, 'mousemove', poke);
    on(box, 'touchstart', function () { if (act.idle) act.touchAt = T.now(); poke(); }, { capture: true, passive: true });
    on(box, 'focusin', poke);
    on(btn, 'mouseenter', function () { act.hover = true; applyIdle(); });
    on(btn, 'mouseleave', function () { act.hover = false; poke(); });
    on(btn, 'focus', function () { act.focus = true; applyIdle(); });
    on(btn, 'blur', function () { act.focus = false; poke(); });
    if (MO) { try { new MO(applyIdle).observe(o.wrap, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); } catch (e) {} }

    function render() {
      btn.classList.toggle('hide', !whep);
      btn.classList.toggle('on', mode === 'rtc');
      btn.setAttribute('aria-pressed', String(pref()));
      btn.title = note || (pref() ? 'Low latency is on (WebRTC, about a second behind). Press for the normal stream.'
                                  : 'Watch with about a second of delay (WebRTC). Falls back to the normal stream if it can\'t connect.');
      applyIdle();
    }
    function stopRtc() {
      attempt++;
      if (sess) { try { sess.close(); } catch (e) {} sess = null; }
      if (video) { try { video.srcObject = null; if (video.parentNode) video.parentNode.removeChild(video); } catch (e) {} video = null; }
    }
    function fallback(why) {
      stopRtc();
      mode = 'hls'; failedFor = whep;
      note = 'Low latency isn\'t available right now (' + (why || 'error') + ') - playing the normal stream. Press to try again.';
      reconnecting(false);
      if (running) { hls.setSrc(hlsSrc); hls.start(); }
      pin(NOTE_MS);
      render();
      if (o.onFallback) o.onFallback(why);
    }
    function startRtc() {
      var my = ++attempt;
      mode = 'rtc'; note = '';
      hls.stop();
      video = doc.createElement('video');
      video.className = 'rtc-video'; video.muted = true; video.autoplay = true; video.playsInline = true; video.controls = true;
      video.setAttribute('playsinline', '');
      o.wrap.appendChild(video);
      on(video, 'pause', applyIdle);
      on(video, 'play', poke);
      poke();
      reconnecting(true);
      if (o.unmute) o.unmute.classList.remove('hide');
      rtc.play(whep, video, { timeout: 8000 }).then(function (s) {
        if (my !== attempt) { try { s.close(); } catch (e) {} return; }
        sess = s;
        reconnecting(false);
        s.onfail = function () { if (my === attempt) fallback('connection lost'); };
      }, function (e) { if (my === attempt) fallback((e && e.message) || 'error'); });
    }
    function begin() {
      if (whep && pref() && failedFor !== whep && rtc) startRtc();
      else { mode = 'hls'; hls.start(); }
      render();
    }
    function start() { if (running) return; running = true; begin(); }
    function stop() { running = false; stopRtc(); hls.stop(); mode = 'hls'; reconnecting(false); render(); }
    function setSrc(url, w) {
      w = w || null;
      if (url === hlsSrc && w === whep) return;
      hlsSrc = url; whep = w;
      if (!running) { hls.setSrc(url); render(); return; }
      stopRtc(); hls.stop(); hls.setSrc(url);
      begin();
    }
    btn.addEventListener('click', function (e) {
      // the tap that revealed a hidden button (touch -> the synthetic click lands on it once it's back) only wakes
      // the controls; keyboard clicks (detail 0) always count
      if (e && e.detail !== 0 && T.now() - act.touchAt < TAP_GUARD_MS) { act.touchAt = -1e9; if (e.preventDefault) e.preventDefault(); return; }
      setPref(!pref());
      failedFor = null; note = '';
      if (running) { stopRtc(); hls.stop(); begin(); } else render();
    });
    if (o.unmute) {
      o.unmute.addEventListener('click', function () {
        if (video) { video.muted = false; var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      });
    }
    function state() {
      if (mode === 'rtc' && video) {
        return { playing: !!sess && !video.paused && !video.ended, time: Number(video.currentTime) || 0, muted: !!video.muted || Number(video.volume) === 0 };
      }
      return hls.state ? hls.state() : null;
    }
    render();
    return { start: start, stop: stop, running: function () { return running; }, setSrc: setSrc, src: function () { return hlsSrc; },
             state: state, mode: function () { return mode; }, button: btn };
  }
  window.PATVStage = window.PATVStage || {};
  window.PATVStage.rtcWrap = wrap;
})();
