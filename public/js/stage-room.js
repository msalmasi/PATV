// stage-room.js — a room's stage on a page (1.99bi): Pepe's stream + the room's live user slots, with
// tabs to switch between them. Used by the homepage (the front room) and every room page.
//
//   PATVStage.switcher({
//     tabs, wrap, reconnect, unmute, embedHost, twitchHost?,   elements (see home.ejs / room.ejs)
//     api: '/api/stage' | '/api/stage?room=<slug>',            what to poll (every 10 s)
//     slots: [...], pepeOn: bool, manage: bool,                first render (server-side data)
//     pepeHere: bool                                           Pepe is IN this room (default true)
//     onAir(on, sub)                                           the page's ON AIR pill / subtitle
//     onShow(sel)                                              (1.99cr) what's selected, for the Snap / Clip
//                                                              bar (stage-capture.js): null | {stream, label, embed, capture, nsfw}
//   })
// Default view: the room's FEATURED slot when it's live, else Pepe's stream. Viewers switch freely.
// 1.99cj: Pepe's stream (his broadcast, HLS or the Twitch mirror) is part of EVERY room's stage that
// Pepe is in - the API's pepe_here - whichever room his Camfrog window shows. Not in the room: no tab.
// HLS slots play in the shared video.js player (stage-player.js); embed slots (YouTube / Twitch) are
// rendered only with the official players, from {p,t,id} re-checked here (never a raw URL).
// manage = the room owner / staff: feature / unfeature / cut buttons on the selected slot.
(function () {
  'use strict';
  var PEPE_HLS = 'https://publicaccess.tv/hls/broadcast.m3u8';
  var YT_ID = /^[A-Za-z0-9_-]{11}$/, YT_CH = /^UC[A-Za-z0-9_-]{22}$/, TW_LOGIN = /^[A-Za-z0-9_]{3,25}$/, TW_VOD = /^[0-9]{5,12}$/;
  function embedUrl(e) {
    if (!e) return null;
    var host = /^[a-z0-9.-]+$/i.test(location.hostname) ? location.hostname : 'publicaccess.tv';
    var q = 'autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1';
    if (e.p === 'youtube' && (e.t === 'video' || e.t === 'live') && YT_ID.test(e.id)) return 'https://www.youtube-nocookie.com/embed/' + e.id + '?' + q;
    if (e.p === 'youtube' && e.t === 'channel' && YT_CH.test(e.id)) return 'https://www.youtube-nocookie.com/embed/live_stream?channel=' + e.id + '&' + q;
    if (e.p === 'twitch' && e.t === 'channel' && TW_LOGIN.test(e.id)) return 'https://player.twitch.tv/?channel=' + e.id + '&parent=' + host + '&autoplay=true&muted=true';
    if (e.p === 'twitch' && e.t === 'vod' && TW_VOD.test(e.id)) return 'https://player.twitch.tv/?video=v' + e.id + '&parent=' + host + '&autoplay=true&muted=true';
    return null;
  }
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function switcher(o) {
    var slots = Array.isArray(o.slots) ? o.slots : [];
    var pepeOn = !!o.pepeOn, pepeHere = o.pepeHere !== false, twitchLive = false, chosen = false;
    var view = 'pepe';
    var player = PATVStage.player({ wrap: o.wrap, reconnect: o.reconnect, unmute: o.unmute, src: PEPE_HLS });
    // 1.99et: ⚡ Low latency (stage-lowlat.js, on the page only while webrtc_enabled is on) wraps the HLS player;
    // a slot published over WHIP carries s.whep. Without it everything below is the plain HLS player.
    if (PATVStage.rtcWrap) player = PATVStage.rtcWrap(player, { wrap: o.wrap, reconnect: o.reconnect, unmute: o.unmute });
    var embedFor = null, loaded = document.readyState === 'complete';
    function featured() { for (var i = 0; i < slots.length; i++) if (slots[i].featured) return slots[i]; return null; }
    function cur() { if (view.indexOf('slot:') !== 0) return null; for (var i = 0; i < slots.length; i++) if ('slot:' + slots[i].id === view) return slots[i]; return null; }
    function pickDefault() { var f = featured(); view = f ? 'slot:' + f.id : 'pepe'; }
    pickDefault();
    function setEmbed(e) {
      var url = embedUrl(e);
      if (!o.embedHost) return;
      if (!url) { o.embedHost.innerHTML = ''; o.embedHost.classList.add('hide'); embedFor = null; return; }
      if (embedFor === url) return;
      embedFor = url;
      o.embedHost.innerHTML = '';
      var f = document.createElement('iframe');
      f.src = url; f.title = 'Stage video'; f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.setAttribute('allowfullscreen', ''); f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
      o.embedHost.appendChild(f);
      o.embedHost.classList.remove('hide');
    }
    function show() {
      var s = cur();
      var tw = o.twitchHost;
      if (s && s.embed) {
        player.stop(); if (tw) tw.classList.add('hide'); setEmbed(s.embed);
        o.onAir && o.onAir(true, (s.title ? s.title + ' · ' : '') + 'from ' + (s.embed.p === 'youtube' ? 'YouTube' : 'Twitch'));
      } else if (s) {
        setEmbed(null); if (tw) tw.classList.add('hide');
        player.setSrc(s.hls, s.whep || null); if (loaded) player.start();
        o.onAir && o.onAir(true, s.title || null);
      } else if (twitchLive && tw && pepeHere) {
        setEmbed(null); player.stop(); tw.classList.remove('hide');
        o.onAir && o.onAir(true, 'live on Twitch');
      } else if (pepeOn && pepeHere) {
        setEmbed(null); if (tw) tw.classList.add('hide');
        player.setSrc(PEPE_HLS, null); if (loaded) player.start();
        o.onAir && o.onAir(true, null);
      } else {
        setEmbed(null); if (tw) tw.classList.add('hide'); player.stop();
        var any = slots.length > 0;
        o.onAir && o.onAir(any, any ? (pepeHere ? "Pepe's stream is off air - pick a stream above" : 'pick a stream above') : 'nothing streaming right now');
      }
      renderTabs();
      if (o.onShow) o.onShow(selection());
    }
    // 1.99cr: what's on screen, for the Snap / Clip bar (stage-capture.js). Pepe's stream is captured from
    // his HLS on the server even while the page shows the Twitch mirror, so it counts while HLS is on air.
    function selection() {
      var s = cur();
      if (s) return { stream: s.id, label: s.display, embed: !!s.embed, capture: !s.embed && s.capture !== false, nsfw: !!s.nsfw };
      if (pepeHere && pepeOn) return { stream: 'pepe', label: "Pepe's stream", embed: false, capture: true, nsfw: false };
      return null;
    }
    function renderTabs() {
      var box = o.tabs;
      if (!box) return;
      if (!slots.length) { box.innerHTML = ''; return; }
      var h = '';
      slots.forEach(function (s) {
        h += '<button type="button" class="stab' + (s.featured ? ' feat' : '') + '" role="tab" data-v="slot:' + esc(s.id) + '" aria-selected="' + (view === 'slot:' + s.id) + '"' +
             (s.title ? ' title="' + esc(s.title) + '"' : '') + '>' +
             '<span class="dot" aria-hidden="true"></span>' + (s.featured ? '<span class="star" aria-label="featured">★</span>' : '') +
             '<span class="n' + (s.nameCss ? ' cx-name' : '') + '" style="' + esc(s.nameCss || '') + '">' + esc(s.display) + '</span>' +
             (s.embed ? '<span class="src">' + (s.embed.p === 'youtube' ? 'YouTube' : 'Twitch') + '</span>' : '') + '</button>';
      });
      var pOn = pepeOn || twitchLive;
      if (pepeHere) h += '<button type="button" class="stab' + (pOn ? '' : ' off') + '" role="tab" data-v="pepe" aria-selected="' + (view === 'pepe') + '">' +
           '<span class="dot" aria-hidden="true"></span>🐸 Pepe\'s stream' + (pOn ? '' : ' (off air)') + '</button>';
      var s = cur();
      if (o.manage && s) {
        h += '<span class="adm">' + (s.featured ? '<button type="button" data-act="unfeature" data-id="' + esc(s.id) + '">☆ Unfeature</button>'
                                                : '<button type="button" data-act="feature" data-id="' + esc(s.id) + '">★ Feature</button>') +
             '<button type="button" data-act="cut" data-id="' + esc(s.id) + '">✂ Cut</button>' +
             '<button type="button" data-act="cut" data-ban="1" data-id="' + esc(s.id) + '">Cut + ban</button></span>';
      }
      box.innerHTML = h;
    }
    if (o.tabs) {
      o.tabs.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.hasAttribute('data-v')) { view = b.getAttribute('data-v'); chosen = true; show(); return; }
        var act = b.getAttribute('data-act');
        if (!act) return;
        var ban = b.hasAttribute('data-ban');
        var q = act === 'cut' ? (ban ? 'Cut this slot AND ban them from this pad\'s stage?' : 'Cut this slot? Unused PAT is refunded.')
              : act === 'unfeature' ? 'Stop featuring this slot? It stays on as an ordinary one.' : 'Feature this slot? It becomes the pad\'s main stream.';
        if (!confirm(q)) return;
        b.disabled = true;
        fetch('/api/stage/slots/' + encodeURIComponent(b.getAttribute('data-id')) + '/' + act, { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ban: ban }) })
          .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) alert(j.error || 'Could not do that.'); poll(); })
          .catch(function () { alert('Could not reach the server.'); b.disabled = false; });
      });
    }
    function poll() {
      return fetch(o.api, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (g) {
        var was = cur(), wasF = featured();
        pepeOn = !!g.active;
        if (typeof g.pepe_here === 'boolean') pepeHere = g.pepe_here;
        slots = Array.isArray(g.slots) ? g.slots : [];
        var f = featured();
        if (was && !cur()) pickDefault();                                           // that slot ended / was cut
        else if (!chosen && (f ? f.id : null) !== (wasF ? wasF.id : null)) pickDefault();   // featured changed and the viewer never chose
        if (o.onPoll) o.onPoll(g);
        show();
      }).catch(function () {});
    }
    setInterval(poll, 10000);
    // economy E-0: verified watch-minutes. Every 30 s a signed-in viewer's page says what it is showing
    // (HLS streams only - embeds can't be verified), whether the tab is visible and the video is playing,
    // and where the playhead is. The server credits only consecutive beats from one session per account
    // with the position advancing; a paused or hidden tab earns nothing. No PAT is paid for it (yet).
    var sid = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 32);
    var roomQ = (/[?&]room=([^&]+)/.exec(o.api || '') || [])[1] || '';
    try { roomQ = decodeURIComponent(roomQ); } catch (e) {}
    var beats = o.watch === false ? null : setInterval(watchBeat, 30000);
    function watchBeat() {
      var sel = selection();
      if (!sel || sel.embed || !player.running()) return;
      var st = player.state ? player.state() : null;
      fetch('/api/econ/watch/beat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream: String(sel.stream), room: roomQ, sid: sid, visible: document.visibilityState === 'visible',
                               playing: !!(st && st.playing), pos: st ? st.time : 0, muted: st ? st.muted : true }) })
        .then(function (r) { if (r.status === 401 || r.status === 404) { clearInterval(beats); beats = null; } })
        .catch(function () {});
    }
    window.addEventListener('load', function () {
      loaded = true;
      show();
      if (o.twitchHost && window.Twitch) {
        var tw = new Twitch.Player(o.twitchHost.id, { channel: 'publicaccess_ttv', width: '100%', height: '100%', muted: true, parent: [location.hostname] });
        tw.addEventListener(Twitch.Player.READY, function () {
          tw.addEventListener(Twitch.Player.ONLINE, function () { twitchLive = true; show(); });
          tw.addEventListener(Twitch.Player.OFFLINE, function () { twitchLive = false; show(); });
        });
      }
    });
    if (loaded) show(); else renderTabs();
    return { poll: poll, show: show, view: function () { return view; }, selection: selection };
  }
  window.PATVStage = window.PATVStage || {};
  window.PATVStage.switcher = switcher;
  window.PATVStage.embedUrl = embedUrl;
})();
