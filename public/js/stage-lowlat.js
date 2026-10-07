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
(function () {
  'use strict';
  var KEY = 'patv.lowLatency';
  function wrap(hls, o, deps) {
    deps = deps || {};
    var doc = deps.document || document;
    var store = deps.storage !== undefined ? deps.storage : (function () { try { return window.localStorage; } catch (e) { return null; } })();
    var rtc = deps.rtc || window.PATVRtc || null;
    function pref() { try { return !!store && store.getItem(KEY) === '1'; } catch (e) { return false; } }
    function setPref(on) { try { if (store) store.setItem(KEY, on ? '1' : '0'); } catch (e) { /* not remembered */ } }

    var hlsSrc = hls.src(), whep = null, running = false, mode = 'hls', failedFor = null, attempt = 0, sess = null, video = null, note = '';
    var btn = doc.createElement('button');
    btn.type = 'button'; btn.className = 'lowlat hide';
    btn.textContent = '⚡ Low latency';
    (o.box || o.wrap.parentNode || o.wrap).appendChild(btn);
    function reconnecting(on) { if (o.reconnect) o.reconnect.classList.toggle('hide', !on); }
    function render() {
      btn.classList.toggle('hide', !whep);
      btn.classList.toggle('on', mode === 'rtc');
      btn.setAttribute('aria-pressed', String(pref()));
      btn.title = note || (pref() ? 'Low latency is on (WebRTC, about a second behind). Press for the normal stream.'
                                  : 'Watch with about a second of delay (WebRTC). Falls back to the normal stream if it can\'t connect.');
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
    btn.addEventListener('click', function () {
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
