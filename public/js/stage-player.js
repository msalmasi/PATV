// stage-player.js — the main stage's HLS player, shared by the homepage stage (views/home.ejs) and the
// stage room's live page (views/room.ejs).
//
//   var p = PATVStage.player({ wrap, reconnect, unmute, src })
//     wrap       element the <video-js> goes into (created on demand, disposed on stop)
//     reconnect  overlay shown while the stream is starting / reconnecting (toggled with .hide)
//     unmute     the tap-to-unmute button (autoplay has to start muted)
//     src        the playlist (default https://publicaccess.tv/hls/broadcast.m3u8)
//     id         optional id for the <video-js> element
//   p.start() / p.stop() / p.running()
//   p.setSrc(url) switch playlists (restarts the player if it's running) / p.src() the current one
//   p.live()      1.99fd: the live-latency controller's numbers {rebuffers, jumps, margin, rate, lead, low, td} or null
//
// Resilient on purpose: any error or stall shows "reconnecting" and re-points the player at the
// playlist every 10 s (cache-busted) until a frame plays again. Needs video.js (vjs.zencdn.net 8.x).
//
// 1.99fd: live latency. video.js's VHS starts a live stream 3 target durations (TD) behind the newest segment -
// with Pepe's 2 s segments that was ~8 s glass to glass. Now VHS may play inside that window
// (allowSeeksWithinUnsafeLiveWindow) and liveSync keeps the playhead just far enough behind the end of the buffer
// (= the newest segment VHS has downloaded) that the next segment always lands in time:
//   lead    bufferedEnd - currentTime, sampled every 250 ms; low = the smallest lead over the last 2 TD + 1 s,
//           i.e. the lead just before a segment lands - where a stall would happen
//   goal    low sits at `margin` (1.0 s to start; +0.5 s after every rebuffer, up to 2 TD - a shaky connection
//           settles further back by itself)
//   start   the first sample after playback starts jumps to bufferedEnd - (TD + margin) (VHS starts ~3 TD back)
//   low > margin + 0.6 s     -> playbackRate 1.05 (pitch is kept) until low <= margin + 0.2 s
//   low < margin / 2         -> playbackRate 0.96 until low >= margin (ease off before it runs dry)
//   low > margin + TD + 2 s  -> jump again (a tab that was in the background, a long stall); one jump per 5 s at most
// Only for live playlists; VOD / ended streams are left alone.
(function () {
  'use strict';
  var LIVE = { tick: 250, margin0: 1.0, marginStep: 0.5, fast: 1.05, slow: 0.96, jumpEvery: 5000 };

  // one tick of the controller (pure, so it can be tested): st = liveState(), o = the sample
  //   o = { now, td, lead, bufEnd, playing } -> { rate, seekTo } (seekTo null = no jump)
  function liveStep(st, o) {
    var td = o.td > 0 ? Math.min(o.td, 10) : 2;
    var out = { rate: st.rate, seekTo: null };
    st.td = td; st.lead = o.lead;
    if (!o.playing) return out;
    function jump() {
      st.lastJump = o.now; st.jumps++; st.samples = []; st.low = null;
      out.seekTo = o.bufEnd - (td + st.margin);
      out.rate = st.rate = 1;
      return out;
    }
    if (!st.primed) {                                      // start-up: VHS put us ~3 TD back
      st.primed = true;
      if (o.lead > td + st.margin + 1) return jump();
    }
    st.samples.push([o.now, o.lead]);
    var win = (2 * td + 1) * 1000;
    while (st.samples.length && o.now - st.samples[0][0] > win) st.samples.shift();
    // the window has to be (nearly) full before `low` means anything: a segment has to have landed in it
    if (o.now - st.samples[0][0] < win - 2 * LIVE.tick) return out;
    var low = Infinity;
    for (var i = 0; i < st.samples.length; i++) if (st.samples[i][1] < low) low = st.samples[i][1];
    st.low = low;
    if (low > st.margin + td + 2 && o.now - st.lastJump >= LIVE.jumpEvery) return jump();
    if (st.rate === 1) {
      if (low > st.margin + 0.6) st.rate = LIVE.fast;
      else if (low < st.margin / 2) st.rate = LIVE.slow;
    } else if (st.rate > 1) {
      if (low <= st.margin + 0.2) st.rate = 1;
    } else if (low >= st.margin) st.rate = 1;
    out.rate = st.rate;
    return out;
  }
  function liveState() {
    return { samples: [], rate: 1, margin: LIVE.margin0, rebuffers: 0, jumps: 0, lastJump: -1e12, primed: false, low: null, lead: null, td: null };
  }
  /** a rebuffer: count it and sit a bit further back from now on */
  function rebuffered(st) {
    st.rebuffers++;
    st.margin = Math.min(st.margin + LIVE.marginStep, 2 * (st.td || 2));
    st.rate = 1;
    st.samples = [];
  }

  // drive one video.js player with liveStep (deps.timers for tests)
  function liveSync(p, deps) {
    deps = deps || {};
    var T = deps.timers || { set: function (f, ms) { return setInterval(f, ms); }, clear: function (t) { clearInterval(t); },
                             now: function () { return Date.now(); } };
    var st = liveState(), timer = null, started = false, ourSeek = false;
    function vhsMedia() {
      try { var t = p.tech({ IWillNotUseThisInPlugins: true }); var v = t && t.vhs; return v && v.playlists && v.playlists.media(); } catch (e) { return null; }
    }
    function sample() {
      var m = vhsMedia();
      if (!m || m.endList) return;                       // not loaded yet, or not live
      var cur = Number(p.currentTime()) || 0, b = p.buffered(), end = null;
      for (var i = 0; b && i < b.length; i++) if (cur >= b.start(i) - 0.5 && cur <= b.end(i) + 0.5) end = b.end(i);
      if (end === null) return;
      var r = liveStep(st, { now: T.now(), td: Number(m.targetDuration) || 2, lead: Math.max(0, end - cur), bufEnd: end,
                             playing: started && !p.paused() });
      if (r.seekTo !== null && r.seekTo > cur) { ourSeek = true; p.currentTime(r.seekTo); }
      if (Number(p.playbackRate()) !== r.rate) p.playbackRate(r.rate);
    }
    p.on('playing', function () { started = true; ourSeek = false; });
    p.on('seeked', function () { ourSeek = false; });
    p.on('waiting', function () {
      if (!started || ourSeek || p.seeking()) return;    // start-up / our own jump isn't a rebuffer
      rebuffered(st);
    });
    timer = T.set(sample, LIVE.tick);
    p.on('dispose', function () { if (timer) T.clear(timer); timer = null; });
    return { stats: function () { return { rebuffers: st.rebuffers, jumps: st.jumps, margin: st.margin, rate: st.rate, lead: st.lead, low: st.low, td: st.td }; } };
  }

  function player(o) {
    var SRC = o.src || 'https://publicaccess.tv/hls/broadcast.m3u8';
    var p = null, retry = null, sync = null;
    function reconnecting(on) { if (o.reconnect) o.reconnect.classList.toggle('hide', !on); }
    function scheduleRetry() {
      reconnecting(true);
      clearTimeout(retry);
      retry = setTimeout(function () {
        if (!p) return;
        try { p.src({ src: SRC + '?r=' + Date.now(), type: 'application/x-mpegURL' }); p.play().catch(function () {}); } catch (e) {}
        scheduleRetry();                                   // cleared again by 'playing'
      }, 10000);
    }
    function start() {
      if (p || !window.videojs) return;
      var v = document.createElement('video-js');
      if (o.id) v.id = o.id;
      v.className = 'video-js vjs-default-skin';
      v.setAttribute('playsinline', ''); v.setAttribute('controls', ''); v.setAttribute('muted', '');
      o.wrap.appendChild(v);
      p = videojs(v, { muted: true, autoplay: true, liveui: true, fluid: false, preload: 'auto',
                       // 1.99fd: VHS may play inside the last 3 segments; liveSync decides how close
                       html5: { vhs: { overrideNative: true, enableLowInitialPlaylist: true, allowSeeksWithinUnsafeLiveWindow: true } } });
      sync = liveSync(p);
      p.src({ src: SRC, type: 'application/x-mpegURL' });
      p.on('error', scheduleRetry);
      p.on('stalled', function () { if (!retry) scheduleRetry(); });
      p.on('playing', function () { clearTimeout(retry); retry = null; reconnecting(false); });
      p.play().catch(function () {});
      if (o.unmute) o.unmute.classList.remove('hide');
      reconnecting(true);                                  // until the first frame plays
    }
    function stop() {
      clearTimeout(retry); retry = null; reconnecting(false);
      if (o.unmute) o.unmute.classList.add('hide');
      if (p) { try { p.dispose(); } catch (e) {} p = null; }
      sync = null;
    }
    if (o.unmute) {
      o.unmute.addEventListener('click', function () {
        if (p) { p.muted(false); p.play().catch(function () {}); }
        o.unmute.classList.add('hide');
      });
    }
    function setSrc(url) {
      if (!url || url === SRC) return;
      SRC = url;
      if (p) { stop(); start(); }
    }
    // economy E-0: what the viewer is actually getting, for the watch-minute heartbeat (stage-room.js)
    function state() {
      if (!p) return null;
      try {
        return { playing: !p.paused() && !p.ended() && !retry, time: Number(p.currentTime()) || 0,
                 muted: !!p.muted() || Number(p.volume()) === 0 };
      } catch (e) { return null; }
    }
    return { start: start, stop: stop, running: function () { return !!p; }, setSrc: setSrc, src: function () { return SRC; }, state: state,
             live: function () { return sync ? sync.stats() : null; } };
  }
  window.PATVStage = window.PATVStage || {};
  window.PATVStage.player = player;
  window.PATVStage.liveSync = liveSync;
  window.PATVStage._live = { step: liveStep, state: liveState, rebuffered: rebuffered, LIVE: LIVE };   // tests
})();
