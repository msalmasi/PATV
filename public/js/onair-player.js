// onair-player.js — 📺 the embed on Pepe's OBS (1.99aag, views/onairPlayer.ejs; onair.js on the server). The official players
// only: YouTube IFrame API (videos, lives, a channel's live stream) and the Twitch embed player (channels, VODs), sound on.
// Every 5 s the player's state goes to POST /api/onair/player/state {t, state, detail}; the server answers {on:false} once
// this pick is no longer on air (or the token is stale) -> the player is removed and the page stays empty.
(function () {
  'use strict';
  var box = document.getElementById('oaPlayer');
  if (!box) return;
  var P = box.getAttribute('data-p'), T = box.getAttribute('data-t'), ID = box.getAttribute('data-id');
  var TOKEN = box.getAttribute('data-token'), PARENT = box.getAttribute('data-parent') || location.hostname;
  var state = 'loading', detail = '', stopped = false, player = null;
  function set(s, d) { state = s; if (d != null) detail = String(d).slice(0, 120); }
  function report() {
    if (stopped) return;
    fetch('/api/onair/player/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ t: TOKEN, state: state, detail: detail }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.on === false) stop(); })
      .catch(function () { /* the next report */ });
  }
  function stop() {
    stopped = true;
    try { if (player && player.destroy) player.destroy(); } catch (e) { /* gone */ }
    box.remove();
  }
  function load(src, cb) { var s = document.createElement('script'); s.src = src; s.async = true; s.onload = cb; s.onerror = function () { set('error', 'player script failed'); }; document.head.appendChild(s); }

  if (P === 'youtube') {
    // an iframe the API attaches to: works for a video, a live and a channel's live_stream alike
    var q = 'autoplay=1&mute=0&playsinline=1&rel=0&modestbranding=1&controls=0&iv_load_policy=3&enablejsapi=1&origin=' + encodeURIComponent(location.origin);
    var f = document.createElement('iframe');
    f.id = 'oaYt';
    f.allow = 'autoplay; encrypted-media';
    f.src = T === 'channel' ? 'https://www.youtube-nocookie.com/embed/live_stream?channel=' + encodeURIComponent(ID) + '&' + q
                            : 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(ID) + '?' + q;
    box.appendChild(f);
    var YTS = { '-1': 'unstarted', '0': 'ended', '1': 'playing', '2': 'paused', '3': 'buffering', '5': 'cued' };
    window.onYouTubeIframeAPIReady = function () {
      player = new YT.Player('oaYt', {
        events: {
          onReady: function (e) { try { e.target.unMute(); e.target.setVolume(100); e.target.playVideo(); } catch (x) { /* autoplay */ } },
          onStateChange: function (e) {
            set(YTS[String(e.data)] || 'loading');
            if (e.data === 2) { try { player.playVideo(); } catch (x) { /* resume */ } }
          },
          onError: function (e) { set('error', 'youtube error ' + e.data); }   // 100/101/150: removed / not embeddable
        }
      });
    };
    load('https://www.youtube.com/iframe_api');
    // the API only says "playing" - an ad also plays; the clock in the player tells a real program from a stuck one
    var lastT = -1;
    setInterval(function () {
      try {
        if (!player || !player.getCurrentTime) return;
        var ct = player.getCurrentTime(), st = player.getPlayerState();
        if (st === 1) set(lastT >= 0 && ct === lastT ? 'buffering' : 'playing', lastT >= 0 && ct === lastT ? 'clock stuck' : '');
        lastT = ct;
      } catch (x) { /* not ready */ }
    }, 4000);
  } else if (P === 'twitch') {
    load('https://player.twitch.tv/js/embed/v1.js', function () {
      var o = { width: '100%', height: '100%', parent: [PARENT], autoplay: true, muted: false };
      if (T === 'vod') o.video = 'v' + ID; else o.channel = ID;
      player = new Twitch.Player('oaPlayer', o);
      player.addEventListener(Twitch.Player.READY, function () { try { player.setMuted(false); player.setVolume(1); player.play(); } catch (x) { /* autoplay */ } });
      player.addEventListener(Twitch.Player.PLAYING, function () { set('playing'); });
      player.addEventListener(Twitch.Player.PAUSE, function () { set('paused'); try { player.play(); } catch (x) { /* resume */ } });
      player.addEventListener(Twitch.Player.ENDED, function () { set('ended'); });
      player.addEventListener(Twitch.Player.OFFLINE, function () { set('offline'); });
      player.addEventListener(Twitch.Player.ONLINE, function () { set('loading', 'online'); });
      if (Twitch.Player.PLAYBACK_BLOCKED) player.addEventListener(Twitch.Player.PLAYBACK_BLOCKED, function () { set('error', 'playback blocked'); });
    });
    // Twitch shows ads inside its own player and doesn't say so in the embed API: a paused / non-advancing clock = not playing
    var lastTw = -1;
    setInterval(function () {
      try {
        if (!player || !player.getCurrentTime) return;
        var ct = player.getCurrentTime();
        var paused = player.isPaused && player.isPaused();
        if (paused) set('paused');
        else if (lastTw >= 0 && state !== 'offline' && state !== 'ended') set(ct === lastTw ? 'buffering' : 'playing', ct === lastTw ? 'clock stuck' : '');
        lastTw = ct;
      } catch (x) { /* not ready */ }
    }, 4000);
  } else {
    set('error', 'unknown embed');
  }
  report();
  setInterval(report, 5000);
})();
