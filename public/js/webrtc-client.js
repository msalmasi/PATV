// webrtc-client.js — a small vanilla WHIP / WHEP client for the stages (1.99et; no build step). Only on the
// page while the stage setting webrtc_enabled is on (webrtc.js).
//
//   PATVRtc.ice()                      -> Promise<iceServers>   from /api/turn (TURN when signed in, else STUN),
//                                          cached until shortly before the credentials expire
//   PATVRtc.play(whepUrl, video, {timeout})          WHEP, receive-only. Resolves with a session once the
//                                          video is actually playing; rejects on any error or the timeout.
//   PATVRtc.publish(whipUrl, mediaStream, {token, maxKbps, timeout})   WHIP, send-only, H.264 + Opus (H.264
//                                          so MediaMTX can also make HLS of it). Resolves once connected.
//   session.close()     ends it (and DELETEs the WHIP / WHEP resource)
//   session.onfail      called once if the connection is lost after it started
//   session.setCap(kbps) / session.replace(track)     (publish) bitrate cap / swap a camera or mic live
// Non-trickle ICE: the offer goes out after candidate gathering (bounded at 1.5 s) - one request, no PATCH.
(function () {
  'use strict';
  var iceCache = null;
  function ice() {
    if (iceCache && iceCache.until > Date.now()) return Promise.resolve(iceCache.list);
    return fetch('/api/turn', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = j && Array.isArray(j.iceServers) ? j.iceServers : [];
        var until = j && j.expires ? Math.min(j.expires - 120000, Date.now() + 50 * 60000) : Date.now() + 10 * 60000;
        iceCache = { list: list, until: until };
        return list;
      })
      .catch(function () { return []; });       // no ICE servers: host candidates still reach the server's public IP
  }
  function timeout(p, ms, what) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { var e = new Error(what + ' timed out'); e.timeout = true; rej(e); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function gathered(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(function (res) {
      var t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  // offer -> POST application/sdp -> 201 + answer + Location (the session resource, for DELETE)
  function negotiate(pc, url, token) {
    return pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
      .then(function () { return gathered(pc, 1500); })
      .then(function () {
        var h = { 'Content-Type': 'application/sdp' };
        if (token) h.Authorization = 'Bearer ' + token;
        return fetch(url, { method: 'POST', headers: h, body: pc.localDescription.sdp, credentials: 'omit' });
      })
      .then(function (r) {
        if (r.status !== 201) { var e = new Error('The stage server said ' + r.status); e.status = r.status; throw e; }
        var loc = r.headers.get('Location');
        return r.text().then(function (sdp) {
          return pc.setRemoteDescription({ type: 'answer', sdp: sdp }).then(function () { return loc ? new URL(loc, url).href : null; });
        });
      });
  }
  function connected(pc) {
    return new Promise(function (res, rej) {
      if (pc.connectionState === 'connected') return res();
      pc.addEventListener('connectionstatechange', function () {
        if (pc.connectionState === 'connected') res();
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') rej(new Error('The connection failed'));
      });
    });
  }
  function drop(resource) {
    if (resource) fetch(resource, { method: 'DELETE', credentials: 'omit', keepalive: true }).catch(function () {});
  }
  function session(pc, resource) {
    var s = { pc: pc, closed: false, onfail: null }, lostT = null;
    s.close = function () { if (s.closed) return; s.closed = true; clearTimeout(lostT); try { pc.close(); } catch (e) {} drop(resource); };
    function fail() { if (s.closed) return; s.close(); if (s.onfail) s.onfail(); }
    pc.addEventListener('connectionstatechange', function () {
      var st = pc.connectionState;
      if (st === 'connected') { clearTimeout(lostT); lostT = null; }
      else if (st === 'failed' || st === 'closed') fail();
      else if (st === 'disconnected' && !lostT) lostT = setTimeout(fail, 5000);   // brief blips heal themselves
    });
    return s;
  }
  function closeQuietly(pc, resource) { try { pc.close(); } catch (e) {} drop(resource); }

  function play(url, video, o) {
    o = o || {};
    if (!window.RTCPeerConnection || !window.MediaStream) return Promise.reject(new Error('This browser has no WebRTC'));
    return ice().then(function (servers) {
      var pc = new RTCPeerConnection({ iceServers: servers }), resource = null;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      var ms = new MediaStream();
      pc.ontrack = function (e) { ms.addTrack(e.track); if (video.srcObject !== ms) video.srcObject = ms; };
      var go = negotiate(pc, url, null).then(function (loc) { resource = loc; return connected(pc); }).then(function () {
        return new Promise(function (res) {
          if (!video.paused && video.readyState >= 2) return res();
          video.addEventListener('playing', res, { once: true });
          var p = video.play(); if (p && p.catch) p.catch(function () {});
        });
      });
      return timeout(go, o.timeout || 8000, 'Low latency').then(function () { return session(pc, resource); },
        function (e) { closeQuietly(pc, resource); throw e; });
    });
  }

  function preferH264(tr) {
    if (!tr.setCodecPreferences || !window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
    var caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !caps.codecs) return;
    var h264 = caps.codecs.filter(function (c) { return /\/h264$/i.test(c.mimeType); });
    if (!h264.length) throw new Error("This browser can't send H.264 video - try Chrome, Edge, Safari or Firefox.");
    var extra = caps.codecs.filter(function (c) { return /\/(rtx|red|ulpfec)$/i.test(c.mimeType); });
    try { tr.setCodecPreferences(h264.concat(extra)); } catch (e) { /* the browser picks */ }
  }
  function setCap(pc, kbps) {
    var jobs = pc.getSenders().filter(function (s) { return s.track && s.track.kind === 'video'; }).map(function (s) {
      var p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = Math.max(300, Number(kbps) || 2500) * 1000;
      return s.setParameters(p).catch(function () {});
    });
    return Promise.all(jobs);
  }
  function publish(url, stream, o) {
    o = o || {};
    if (!window.RTCPeerConnection) return Promise.reject(new Error('This browser has no WebRTC'));
    return ice().then(function (servers) {
      var pc = new RTCPeerConnection({ iceServers: servers }), resource = null;
      try {
        stream.getTracks().forEach(function (t) {
          var tr = pc.addTransceiver(t, { direction: 'sendonly', streams: [stream] });
          if (t.kind === 'video') preferH264(tr);
        });
      } catch (e) { closeQuietly(pc, null); return Promise.reject(e); }
      var go = negotiate(pc, url, o.token).then(function (loc) { resource = loc; return setCap(pc, o.maxKbps); })
        .then(function () { return connected(pc); });
      return timeout(go, o.timeout || 10000, 'Connecting').then(function () {
        var s = session(pc, resource);
        s.setCap = function (k) { return setCap(pc, k); };
        s.replace = function (track) {
          var snd = pc.getSenders().filter(function (x) { return x.track && x.track.kind === track.kind; })[0];
          return snd ? snd.replaceTrack(track) : Promise.resolve();
        };
        return s;
      }, function (e) { closeQuietly(pc, resource); throw e; });
    });
  }
  window.PATVRtc = { ice: ice, play: play, publish: publish };
})();
