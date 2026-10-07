// stage-golive-rtc.js — "Go live from your browser (camera / screen) — ultra-low latency" on /stage (1.99et).
// Only on the page while the stage setting webrtc_enabled is on. WHIP from getUserMedia / getDisplayMedia
// (webrtc-client.js) to the slot's MediaMTX path, with a preview, camera / mic pickers, a bitrate cap and
// Stop. The page never sees the stream key: POST /api/stage/slots/:id/whip gives the owner the WHIP URL and
// a 10-minute token. Also fills the OBS 30+ WHIP server URL on the OBS tab. Follows the open slot from
// stage-book.js (window event 'patv:slot').
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var pane = $('paneRtc');
  if (!pane || !window.PATVRtc) return;
  var BASE = pane.getAttribute('data-base') || '';
  var LS_CAM = 'stageRtcCam', LS_MIC = 'stageRtcMic', LS_KBPS = 'stageRtcKbps';
  var slot = null, media = null, mic = null, sess = null, live = false, busy = false, retried = false;

  function pref(k, v) {
    try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch (e) { /* not remembered */ }
    return '';
  }
  function msg(t) { $('rtcMsg').textContent = t || ''; }
  function show(id, on) { $(id).classList.toggle('hide', !on); }
  function md() { return navigator.mediaDevices || null; }
  function srcKind() { var r = document.querySelector('input[name=rtcSrc]:checked'); return r ? r.value : 'camera'; }
  function stopAll(s) { if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* gone */ } }); }
  function errText(e, what) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'You blocked the ' + what + ' - allow it in the address bar, then try again.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No ' + what + ' found - plug one in or pick another.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'Your ' + what + ' is busy (another app or tab has it) - close that and try again.';
    return 'Couldn\'t open the ' + what + (e && e.message ? ': ' + e.message : '.');
  }
  function liveErr(e) {
    if (e && e.status === 401 || e && e.status === 403) return 'The stage refused the stream - your slot may have ended. Refresh the page.';
    if (e && e.status === 404) return 'Ultra-low latency isn\'t available right now - use "Go live from browser" or OBS.';
    if (e && e.timeout) return 'Couldn\'t connect to the stage server (your network may block WebRTC) - try "Go live from browser" or OBS instead.';
    return (e && e.message) || 'Something went wrong.';
  }

  // tabs: stage-book.js owns OBS / browser; this one shows its own pane
  $('tabRtc').addEventListener('click', function () {
    ['tabObs', 'tabWeb'].forEach(function (id) { $(id).setAttribute('aria-selected', 'false'); });
    $('tabRtc').setAttribute('aria-selected', 'true');
    show('paneObs', false); show('paneWeb', false); show('paneRtc', true);
  });

  // devices
  function fill(sel, list, noun, cur) {
    var h = '<option value="">Default ' + noun + '</option>';
    list.forEach(function (d, i) {
      h += '<option value="' + String(d.deviceId).replace(/"/g, '') + '">' + String(d.label || (noun + ' ' + (i + 1))).replace(/[<&]/g, '') + '</option>';
    });
    sel.innerHTML = h;
    if (cur && list.some(function (d) { return d.deviceId === cur; })) sel.value = cur;
  }
  function listDevices() {
    if (!md() || !md().enumerateDevices) return Promise.resolve();
    return md().enumerateDevices().then(function (all) {
      fill($('rtcCam'), all.filter(function (d) { return d.kind === 'videoinput'; }), 'camera', pref(LS_CAM));
      fill($('rtcMic'), all.filter(function (d) { return d.kind === 'audioinput' && d.deviceId !== 'communications'; }), 'microphone', pref(LS_MIC));
    }).catch(function () {});
  }
  function vCons() {
    var id = $('rtcCam').value;
    return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, deviceId: id ? { exact: id } : undefined };
  }
  function aCons() {
    var id = $('rtcMic').value;
    return { echoCancellation: true, noiseSuppression: true, deviceId: id ? { exact: id } : undefined };
  }
  function openMedia() {
    if (!md() || !md().getUserMedia) return Promise.reject(new Error('This browser can\'t use a camera here (it needs HTTPS and a modern browser).'));
    if (srcKind() === 'screen') {
      if (!md().getDisplayMedia) return Promise.reject(new Error('Screen sharing isn\'t supported in this browser.'));
      return md().getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true }).then(function (scr) {
        return md().getUserMedia({ audio: aCons() }).then(function (m) { mic = m; return [scr, m]; },
          function (e) { mic = null; msg(errText(e, 'microphone') + ' Streaming the screen without your mic.'); return [scr, null]; });
      }, function (e) { throw new Error(errText(e, 'screen share')); }).then(function (pair) {
        var out = new MediaStream(pair[0].getVideoTracks());
        var a = (pair[1] && pair[1].getAudioTracks()[0]) || pair[0].getAudioTracks()[0];
        if (a) out.addTrack(a);
        pair[0].getVideoTracks()[0].onended = function () { if (live) stop('Your screen share stopped.'); };
        return out;
      });
    }
    return md().getUserMedia({ video: vCons(), audio: aCons() }).catch(function (e) { throw new Error(errText(e, 'camera or microphone')); });
  }
  function preview() {
    msg('');
    var old = media;
    return openMedia().then(function (s) {
      if (live && sess) {                              // switching a camera / mic while live: swap the tracks in place
        s.getTracks().forEach(function (t) { sess.replace(t).catch(function () {}); });
      }
      stopAll(old);
      media = s;
      $('rtcPv').srcObject = s;
      var p = $('rtcPv').play(); if (p && p.catch) p.catch(function () {});
      show('rtcPvEmpty', false);
      return listDevices();
    }, function (e) { msg(e.message); throw e; });
  }
  function release() {
    stopAll(media); stopAll(mic); media = null; mic = null;
    $('rtcPv').srcObject = null; show('rtcPvEmpty', true);
  }

  function ui() {
    show('rtcGo', !live); show('rtcStop', live); show('rtcOnAir', live); show('rtcPvBtn', !live);
    $('rtcGo').disabled = busy || !slot;
    document.querySelectorAll('input[name=rtcSrc]').forEach(function (r) { r.disabled = live; });
  }
  function go() {
    if (!slot) { msg('Book a slot first - it opens here when it\'s yours.'); return; }
    busy = true; ui();
    var kbps = Number($('rtcKbps').value) || 2500;
    (media ? Promise.resolve() : preview()).then(function () {
      if (!media || !media.getVideoTracks().length) throw new Error('Pick a camera or screen first.');
      msg('Connecting…');
      return fetch('/api/stage/slots/' + encodeURIComponent(slot.id) + '/whip', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: '{}' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) { var e = new Error(j.error || ('Server error (' + r.status + ')')); e.status = r.status === 404 ? 404 : 0; throw e; } return j; }); });
    }).then(function (j) {
      return PATVRtc.publish(j.url, media, { token: j.token, maxKbps: kbps, timeout: 12000 });
    }).then(function (s) {
      sess = s; live = true; busy = false; retried = false;
      s.onfail = function () {
        sess = null;
        if (!live) return;
        if (!retried) { retried = true; live = false; msg('Connection lost - reconnecting…'); setTimeout(go, 1500); ui(); return; }
        live = false; ui(); msg('Connection lost. Press ⚡ Go live to try again.');
      };
      msg('You\'re live ⚡ - it can take a few seconds to show on the stage.');
      setTimeout(function () { if (live && /You're live/.test($('rtcMsg').textContent)) msg(''); }, 8000);
      ui();
    }).catch(function (e) {
      busy = false; ui();
      msg(e && e.message && !e.status && !e.timeout && !/^The stage server said/.test(e.message) ? e.message : liveErr(e));
    });
  }
  function stop(why) {
    live = false; busy = false;
    if (sess) { try { sess.close(); } catch (e) {} sess = null; }
    release();
    ui();
    msg(why || 'Stopped. Your slot is still open - go live again or end it.');
  }

  $('rtcPvBtn').addEventListener('click', function () { preview().catch(function () {}); });
  $('rtcGo').addEventListener('click', go);
  $('rtcStop').addEventListener('click', function () { stop(); });
  $('rtcKbps').addEventListener('change', function () { pref(LS_KBPS, $('rtcKbps').value); if (sess && sess.setCap) sess.setCap(Number($('rtcKbps').value)); });
  ['rtcCam', 'rtcMic'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      pref(id === 'rtcCam' ? LS_CAM : LS_MIC, $(id).value);
      if (media) preview().catch(function () {});
    });
  });
  document.querySelectorAll('input[name=rtcSrc]').forEach(function (r) { r.addEventListener('change', function () { if (media && !live) preview().catch(function () {}); }); });
  if (pref(LS_KBPS)) $('rtcKbps').value = pref(LS_KBPS);
  if (md() && md().addEventListener) md().addEventListener('devicechange', listDevices);
  window.addEventListener('beforeunload', function (e) { if (live) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pagehide', function () { if (sess) sess.close(); });

  function onSlot(s) {
    var was = slot;
    slot = s && s.mode !== 'embed' ? s : null;
    if ($('whipUrl')) $('whipUrl').value = slot ? BASE + '/whip/' + slot.stream : '';
    if (!slot && live) stop('Your slot ended.');
    else if (!slot && was) release();
    ui();
  }
  window.addEventListener('patv:slot', function (e) { onSlot(e.detail || null); });
  onSlot(window.PATVStageSlot || null);
})();
