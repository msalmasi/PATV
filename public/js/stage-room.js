// stage-room.js — a room's stage on a page (1.99bi): Pepe's stream + the room's live user slots, with
// tabs to switch between them. Used by the homepage (the front room) and every room page.
//
//   PATVStage.switcher({
//     tabs, wrap, reconnect, unmute, embedHost,                elements (see home.ejs / room.ejs)
//     api: '/api/stage' | '/api/stage?room=<slug>',            what to poll (every 10 s)
//     slots: [...], pepeOn: bool, manage: bool,                first render (server-side data)
//     pepeHere: bool                                           Pepe is IN this room (default true)
//     pepeWhep: url | null                                     (1.99fd) Pepe's WHEP URL while his main stream comes
//                                                              in over WHIP - the ⚡ Low latency toggle on his stream
//     pepeSrc: {mode, embed?, label?, twitch?} | null          (1.99fv) what Pepe's stage plays (bridge.stage().pepe_src):
//                                                              'stream' = his HLS (+ ⚡), 'embed' = an admin-chosen
//                                                              YouTube / Twitch embed. Twitch being live never swaps it.
//     onAir(on, sub)                                           the page's ON AIR pill / subtitle
//     onShow(sel)                                              (1.99cr) what's selected, for the Snap / Clip
//                                                              bar (stage-capture.js): null | {stream, label, embed, capture, nsfw}
//   })
// Default view: the room's FEATURED slot when it's live, else Pepe's stream. Viewers switch freely.
// 1.99lm: a slot can be featured automatically (feature_by 'auto': it went live while nothing was featured -
// mainstage.js autoFeature) - the same default; its star says "live now". Pepe's tab gets the star while an
// admin features his stream (pepeSrc.featured; no auto-feature happens then).
// 1.99fv: no more automatic Twitch swap - Twitch is a relay of his stream (1.99fk); an admin can still pick
// a YouTube / Twitch embed for his stage on /stage/admin (pepeSrc). On air = HIS stream (pepeOn), always.
// 1.99cj: Pepe's stream (his broadcast) is part of EVERY room's stage that
// Pepe is in - the API's pepe_here - whichever room his Camfrog window shows. Not in the room: no tab.
// HLS slots play in the shared video.js player (stage-player.js); embed slots (YouTube / Twitch) are
// rendered only with the official players, from {p,t,id} re-checked here (never a raw URL).
// manage = the room owner / staff: feature / unfeature / cut buttons on the selected slot.
// 1.99zc: 🎬 a CAM slot (s.cam: someone's live Camfrog cam the pad's owner put on the stage - mainstage camOpen) has no
// HLS: the page asks for its own WHEP ticket (POST /api/stage/slots/<id>/cam, signed in + the pad's rule), plays it
// with PATVRtc.watch (muted: a cam has no sound) and beats every 15 s like a live cam (livecam.js stageWatch).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
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
  // 1.99fv: Pepe's stage source from the server (bridge.stage().pepe_src) - only known shapes get through
  function cleanSrc(x) {
    if (!x || typeof x !== 'object') return null;
    var tw = x.twitch && typeof x.twitch === 'object' && TW_LOGIN.test(String(x.twitch.login || ''))
      ? { login: String(x.twitch.login), live: x.twitch.live === true } : null;
    var feat = x.featured === true;                       // 1.99lm: an admin featured Pepe's stream (an event)
    if (x.mode === 'embed' && embedUrl(x.embed)) return { mode: 'embed', embed: { p: x.embed.p, t: x.embed.t, id: x.embed.id }, label: typeof x.label === 'string' ? x.label.slice(0, 60) : '', twitch: tw, featured: feat };
    return { mode: 'stream', twitch: tw, featured: feat };
  }
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function switcher(o) {
    var slots = Array.isArray(o.slots) ? o.slots : [];
    var pepeOn = !!o.pepeOn, pepeHere = o.pepeHere !== false, chosen = false;
    var pepeSrc = cleanSrc(o.pepeSrc), ownPepe = false;   // 1.99fv: ownPepe = this viewer chose his own stream over the embed
    var pepeWhep = typeof o.pepeWhep === 'string' && o.pepeWhep ? o.pepeWhep : null;   // 1.99fd
    var view = 'pepe';
    var player = PATVStage.player({ wrap: o.wrap, reconnect: o.reconnect, unmute: o.unmute, src: PEPE_HLS });
    // 1.99et: ⚡ Low latency (stage-lowlat.js, on the page only while webrtc_enabled is on) wraps the HLS player;
    // a slot published over WHIP carries s.whep. Without it everything below is the plain HLS player.
    if (PATVStage.rtcWrap) player = PATVStage.rtcWrap(player, { wrap: o.wrap, reconnect: o.reconnect, unmute: o.unmute });
    var embedFor = null, loaded = document.readyState === 'complete';
    // ── 1.99zc: 🎬 cam slots ──
    var camCtl = null;
    function camStop() { if (camCtl) { camCtl.stop(); camCtl = null; } }
    function camPost(id, body) {
      return fetch('/api/stage/slots/' + encodeURIComponent(id) + '/cam', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
    }
    function camShow(s) {
      if (camCtl && camCtl.id === s.id) return;
      camStop();
      var my = { id: s.id, gen: 0, sess: null, beat: null }, box = document.createElement('div'), video = document.createElement('video');
      box.className = 'cam-stage';
      video.className = 'rtc-video'; video.muted = true; video.autoplay = true; video.playsInline = true; video.setAttribute('playsinline', '');
      video.setAttribute('aria-label', _t('js.pad.live.aria', '{name}\'s cam, live', { name: s.display }));
      var msg = document.createElement('div'); msg.className = 'cam-msg'; msg.setAttribute('role', 'status');
      var tap = document.createElement('button'); tap.type = 'button'; tap.className = 'cam-tap hide'; tap.textContent = _t('js.pad.strip.tap', '▶ Tap to play');
      tap.addEventListener('click', function () { var p = video.play(); if (p && p.then) p.then(function () { tap.classList.add('hide'); }, function () {}); });
      box.appendChild(video); box.appendChild(tap); box.appendChild(msg);
      o.wrap.appendChild(box);
      if (o.unmute) o.unmute.classList.add('hide');
      function say(t) { msg.textContent = t || ''; msg.classList.toggle('hide', !t); }
      function done(t) {
        clearInterval(my.beat); my.beat = null;
        if (my.sess) { try { my.sess.close(); } catch (e) {} my.sess = null; }
        try { video.srcObject = null; } catch (e) {}
        if (o.reconnect) o.reconnect.classList.add('hide');
        say(t);
      }
      var why = window.PATVLiveCam && PATVLiveCam.why ? PATVLiveCam.why : function (c, f) { return f || _t('js.pad.live.err_failed', 'Pepe couldn\'t open their cam live - try again in a bit.'); };
      my.stop = function () { my.gen++; done(''); if (box.parentNode) box.parentNode.removeChild(box); };
      camCtl = my;
      var g = my.gen;
      if (!window.RTCPeerConnection || !window.PATVRtc || !PATVRtc.watch) { say(_t('js.pad.live.err_browser', 'This browser can\'t play live cams.')); return; }
      if (o.reconnect) o.reconnect.classList.remove('hide');
      say('');
      camPost(s.id, {}).then(function (d) {
        if (g !== my.gen) return;
        if (!d || !d.ok || !d.whep) return done(d && d.state === 'ended' ? why(d.why) : why(d && d.code, d && d.error));
        my.beat = setInterval(function () {
          camPost(s.id, { beat: true }).then(function (k) {
            if (g !== my.gen) return;
            if (k && (k.ok === false || k.state === 'ended')) done(why(k.why || k.code, k.error));
          }).catch(function () { /* a blip: the next beat */ });
        }, 15000);
        return PATVRtc.watch(d.whep, video, { timeout: 40000, cancelled: function () { return g !== my.gen; } }).then(function (ss) {
          if (g !== my.gen) { ss.close(); return; }
          my.sess = ss;
          if (o.reconnect) o.reconnect.classList.add('hide');
          if (ss.blocked) tap.classList.remove('hide');
          ss.onfail = function () { if (g === my.gen) done(why('gone')); };
        });
      }).catch(function (e) { if (g === my.gen && !(e && e.cancelled)) done(why('failed')); });
    }
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
      f.src = url; f.title = _t('js.stage.room.video_title', 'Stage video'); f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.setAttribute('allowfullscreen', ''); f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
      o.embedHost.appendChild(f);
      o.embedHost.classList.remove('hide');
    }
    // 1.99fv: the embed an admin put on Pepe's stage (null = his own stream). Re-checked like a slot's.
    function pepeEmbed() { return !ownPepe && pepeSrc && pepeSrc.mode === 'embed' && embedUrl(pepeSrc.embed) ? pepeSrc.embed : null; }
    function show() {
      var s = cur();
      if (!(s && s.cam)) camStop();
      if (s && s.cam) {
        player.stop(); setEmbed(null); camShow(s);
        o.onAir && o.onAir(true, s.title || null);
      } else if (s && s.embed) {
        player.stop(); setEmbed(s.embed);
        o.onAir && o.onAir(true, (s.title ? s.title + ' · ' : '') + _t('js.stage.room.from', 'from {platform}', { platform: s.embed.p === 'youtube' ? 'YouTube' : 'Twitch' }));
      } else if (s) {
        setEmbed(null);
        player.setSrc(s.hls, s.whep || null); if (loaded) player.start();
        o.onAir && o.onAir(true, s.title || null);
      } else if (pepeOn && pepeHere && pepeEmbed()) {
        // on air because HIS stream is; an admin chose to show it through YouTube / Twitch
        player.stop(); setEmbed(pepeEmbed());
        o.onAir && o.onAir(true, _t('js.stage.room.via', 'via {name}', { name: pepeSrc.label || (pepeSrc.embed.p === 'youtube' ? 'YouTube' : 'Twitch') }));
      } else if (pepeOn && pepeHere) {
        setEmbed(null);
        player.setSrc(PEPE_HLS, pepeWhep); if (loaded) player.start();
        o.onAir && o.onAir(true, null);
      } else {
        setEmbed(null); player.stop();
        var any = slots.length > 0;
        o.onAir && o.onAir(any, any ? (pepeHere ? _t('js.stage.room.pepe_off_pick', 'Pepe\'s stream is off air - pick a stream above') : _t('js.stage.room.pick', 'pick a stream above')) : _t('js.stage.room.nothing', 'nothing streaming right now'));
      }
      renderTabs();
      if (o.onShow) o.onShow(selection());
    }
    // 1.99cr: what's on screen, for the Snap / Clip bar (stage-capture.js). Pepe's stream is captured from
    // his HLS on the server even while the page shows an admin-chosen embed, so it counts while HLS is on air.
    function selection() {
      var s = cur();
      if (s && s.cam) return { stream: s.id, label: s.display, embed: true, capture: false, nsfw: !!s.nsfw };   // 1.99zc: no snaps / clips / watch-minutes of a cam
      if (s) return { stream: s.id, label: s.display, embed: !!s.embed, capture: !s.embed && s.capture !== false, nsfw: !!s.nsfw };
      if (pepeHere && pepeOn) return { stream: 'pepe', label: _t('js.stage.room.pepe_stream', 'Pepe\'s stream'), embed: false, capture: true, nsfw: false };
      return null;
    }
    // 1.99fv: next to Pepe's tab while he's on air and showing - subtle: "Pepe's own stream" when an admin embed
    // is up (this viewer only), "Watch on Twitch" while our relay to his Twitch runs (info + a link; nothing swaps)
    function pepeExtras() {
      if (!pepeHere || !pepeOn || cur()) return '';
      var h = '';
      if (pepeSrc && pepeSrc.mode === 'embed') {
        h += ownPepe ? '<button type="button" class="stx" data-pepe-src="embed">' + esc(_t('js.stage.room.back_to', 'Back to {name}', { name: pepeSrc.label || _t('js.stage.room.the_embed', 'the embed') })) + '</button>'
                     : '<button type="button" class="stx" data-pepe-src="own" title="' + esc(_t('js.stage.room.own_title', 'Pepe\'s own stream: lower delay, ⚡, snaps / clips')) + '">' + esc(_t('js.stage.room.own', 'Pepe\'s own stream')) + '</button>';
      }
      var tw = pepeSrc && pepeSrc.twitch, pe = pepeEmbed();
      if (tw && tw.live && TW_LOGIN.test(tw.login || '') && !(pe && pe.p === 'twitch')) {
        h += '<a class="stx" href="https://www.twitch.tv/' + esc(tw.login) + '" target="_blank" rel="noopener noreferrer" title="' + esc(_t('js.stage.room.tw_title', 'Also live on Twitch - open it there (Twitch chat)')) + '">' + esc(_t('js.stage.room.tw_watch', '🟣 Watch on Twitch ↗')) + '</a>';
      }
      return h;
    }
    function renderTabs() {
      var box = o.tabs;
      if (!box) return;
      if (!slots.length) { box.innerHTML = pepeExtras(); return; }
      var h = '';
      slots.forEach(function (s) {
        h += '<button type="button" class="stab' + (s.featured ? ' feat' : '') + '" role="tab" data-v="slot:' + esc(s.id) + '" aria-selected="' + (view === 'slot:' + s.id) + '"' +
             (s.title ? ' title="' + esc(s.title) + '"' : '') + '>' +
             '<span class="dot" aria-hidden="true"></span>' + (s.featured ? '<span class="star" aria-label="' + esc(s.feature_by === 'auto' ? _t('js.stage.room.featured_auto', 'featured while live') : _t('js.stage.room.featured', 'featured')) + '"' +
               (s.feature_by === 'auto' ? ' title="' + esc(_t('js.stage.room.featured_auto_title', 'Featured automatically: it went live while nothing else was featured')) + '"' : '') + '>★</span>' : '') +
             '<span class="n' + (s.nameCss ? ' cx-name' : '') + '" style="' + esc(s.nameCss || '') + '">' + esc(s.display) + '</span>' +
             (s.embed ? '<span class="src">' + (s.embed.p === 'youtube' ? 'YouTube' : 'Twitch') + '</span>' : '') +
             (s.cam ? '<span class="src">' + esc(_t('js.pad.strip.cam_src', '📷 cam')) + '</span>' : '') + '</button>';
      });
      var pOn = pepeOn;                                     // 1.99fv: his own stream only - Twitch never counts
      var pF = !!(pepeSrc && pepeSrc.featured);             // 1.99lm
      if (pepeHere) h += '<button type="button" class="stab' + (pOn ? '' : ' off') + (pF ? ' feat' : '') + '" role="tab" data-v="pepe" aria-selected="' + (view === 'pepe') + '">' +
           '<span class="dot" aria-hidden="true"></span>' + (pF ? '<span class="star" aria-label="' + esc(_t('js.stage.room.featured', 'featured')) + '">★</span>' : '') + esc(pOn ? _t('js.stage.room.pepe_tab', '🐸 Pepe\'s stream') : _t('js.stage.room.pepe_tab_off', '🐸 Pepe\'s stream (off air)')) + '</button>';
      h += pepeExtras();
      var s = cur();
      if (o.manage && s) {
        h += '<span class="adm">' + (s.featured ? '<button type="button" data-act="unfeature" data-id="' + esc(s.id) + '">' + esc(_t('js.stage.room.unfeature', '☆ Unfeature')) + '</button>'
                                                : '<button type="button" data-act="feature" data-id="' + esc(s.id) + '">' + esc(_t('js.stage.room.feature', '★ Feature')) + '</button>') +
             '<button type="button" data-act="cut" data-id="' + esc(s.id) + '">' + esc(_t('js.stage.room.cut', '✂ Cut')) + '</button>' +
             (s.cam ? '' : '<button type="button" data-act="cut" data-ban="1" data-id="' + esc(s.id) + '">' + esc(_t('js.stage.room.cut_ban', 'Cut + ban')) + '</button>') + '</span>';
      }
      box.innerHTML = h;
    }
    if (o.tabs) {
      o.tabs.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.hasAttribute('data-v')) { view = b.getAttribute('data-v'); chosen = true; show(); return; }
        if (b.hasAttribute('data-pepe-src')) { ownPepe = b.getAttribute('data-pepe-src') === 'own'; show(); return; }
        var act = b.getAttribute('data-act');
        if (!act) return;
        var ban = b.hasAttribute('data-ban');
        var q = act === 'cut' ? (ban ? _t('js.stage.room.q_cut_ban', 'Cut this slot AND ban them from this pad\'s stage?') : _t('js.stage.room.q_cut', 'Cut this slot? Unused PAT is refunded.'))
              : act === 'unfeature' ? _t('js.stage.room.q_unfeature', 'Stop featuring this slot? It stays on as an ordinary one.') : _t('js.stage.room.q_feature', 'Feature this slot? It becomes the pad\'s main stream.');
        if (!confirm(q)) return;
        b.disabled = true;
        fetch('/api/stage/slots/' + encodeURIComponent(b.getAttribute('data-id')) + '/' + act, { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ban: ban }) })
          .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) alert(j.error || _t('js.stage.room.e_do', 'Could not do that.')); poll(); })
          .catch(function () { alert(_t('js.stage.room.e_net', 'Could not reach the server.')); b.disabled = false; });
      });
    }
    function poll() {
      return fetch(o.api, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (g) {
        var was = cur(), wasF = featured();
        pepeOn = !!g.active;
        pepeWhep = typeof g.whep === 'string' && g.whep ? g.whep : null;            // 1.99fd: ⚡ for Pepe's WHIP stream
        if (typeof g.pepe_here === 'boolean') pepeHere = g.pepe_here;
        var ns = cleanSrc(g.pepe_src);                                              // 1.99fv: an admin switched the source
        if (!ns || !pepeSrc || ns.mode !== pepeSrc.mode || JSON.stringify(ns.embed || null) !== JSON.stringify(pepeSrc.embed || null)) ownPepe = false;
        pepeSrc = ns;
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
    var nonce = '';                       // E-4: the server's one-time nonce, echoed by the next beat
    function watchBeat() {
      var sel = selection();
      if (!sel || sel.embed || !player.running()) return;
      var st = player.state ? player.state() : null;
      fetch('/api/econ/watch/beat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream: String(sel.stream), room: roomQ, sid: sid, visible: document.visibilityState === 'visible',
                               playing: !!(st && st.playing), pos: st ? st.time : 0, muted: st ? st.muted : true, nonce: nonce }) })
        .then(function (r) {
          if (r.status === 401 || r.status === 404) { clearInterval(beats); beats = null; return null; }
          return r.ok ? r.json() : null;
        })
        .then(function (j) { nonce = j && typeof j.nonce === 'string' ? j.nonce : ''; })
        .catch(function () { nonce = ''; });
    }
    window.addEventListener('load', function () {
      loaded = true;
      show();
    });
    if (loaded) show(); else renderTabs();
    return { poll: poll, show: show, view: function () { return view; }, selection: selection };
  }
  window.PATVStage = window.PATVStage || {};
  window.PATVStage.switcher = switcher;
  window.PATVStage.embedUrl = embedUrl;
})();
