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
//
// Resilient on purpose: any error or stall shows "reconnecting" and re-points the player at the
// playlist every 10 s (cache-busted) until a frame plays again. Needs video.js (vjs.zencdn.net 8.x).
(function () {
  'use strict';
  function player(o) {
    var SRC = o.src || 'https://publicaccess.tv/hls/broadcast.m3u8';
    var p = null, retry = null;
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
                       html5: { vhs: { overrideNative: true, enableLowInitialPlaylist: true } } });
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
    }
    if (o.unmute) {
      o.unmute.addEventListener('click', function () {
        if (p) { p.muted(false); p.play().catch(function () {}); }
        o.unmute.classList.add('hide');
      });
    }
    return { start: start, stop: stop, running: function () { return !!p; } };
  }
  window.PATVStage = { player: player };
})();
