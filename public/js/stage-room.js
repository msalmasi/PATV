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
// Default view: the room's FEATURED slot when it's live, else Pepe's stream. Viewers switch freely. (newstream 1.99ala: the 10 s poll skips its
// turn in a hidden tab only while the stage plays nothing, and asks at once when the tab comes back - tickPoll / wake.)
// 1.99lm: a slot can be featured automatically (feature_by 'auto': it went live while nothing was featured -
// mainstage.js autoFeature) - the same default; its star says "live now". Pepe's tab gets the star while an
// admin features his stream (pepeSrc.featured; no auto-feature happens then).
// 1.99fv: no more automatic Twitch swap - Twitch is a relay of his stream (1.99fk); an admin can still pick
// a YouTube / Twitch embed for his stage on /stage/admin (pepeSrc). On air = HIS stream (pepeOn), always.
// 1.99cj: Pepe's stream (his broadcast) is part of EVERY room's stage that
// Pepe is in - the API's pepe_here - whichever room his Camfrog window shows. Not in the room: no tab.
// HLS slots play in the shared video.js player (stage-player.js); embed slots (YouTube / Twitch) are
// rendered only with the official players, from {p,t,id} re-checked here (never a raw URL).
// manage = the room owner / staff: feature / unfeature / cut buttons on the selected slot - dock3 1.99akf (owner item 5: "We just need to
// add it to Pepe's stage"): and the same ★ Feature / ☆ Unfeature on Pepe's stream, featuring it on THIS pad (POST /api/stage/pepe/feature,
// the slot buttons' permission; pepeSrc.pad = this pad featured it). Not while he is off air; the site-wide event stays /stage/admin's.
// 1.99zc: 🎬 a CAM slot (s.cam: someone's live Camfrog cam the pad's owner put on the stage - mainstage camOpen) has no
// HLS: the page asks for its own WHEP ticket (POST /api/stage/slots/<id>/cam, signed in + the pad's rule), plays it
// with PATVRtc.watch (muted: a cam has no sound) and beats every 15 s like a live cam (livecam.js stageWatch).
// micfollow: 🎙 "On the mic" - the pad's mic-follows program (micfollow.js; the pad page's /live long-poll hands it over
// with setMic(stage_program)) is a third view kind, 'mic', drawn by stage-mic.js (only on the page with WebRTC on;
// without it setMic does nothing). Default view: a featured slot > Pepe's stream featured (dock3 review: while he is here and on air) > the mic stage (when someone on
// it has a picture) > Pepe's stream; the pad's default_view 'tab' keeps the mic stage a tab. A viewer who picked a tab
// keeps it until it ends. No snaps / clips / watch-minutes of it (selection: capture false).
// dock3 (owner 2026-11-05 item 6: "mic follows seems to sometimes interrupt another featured stage") 1.99akf: FEATURED MEANS
// FEATURED - automatically (1.99lm), by hand or booked, or Pepe's stream (featWins): the mic stage is never the default over
// it (an auto-feature used to yield to it - every featured stage on prod 11-03..05 was 'auto'; default_view 'after_streams'
// now reads like 'first'). A featured slot that drops out of /api/stage for a moment (📼 pause / seek, an OBS reconnect, a
// missed heartbeat) is HELD while the server still names it (g.featured) - the view, the tab and the player's reconnecting
// overlay stay; a failed / stale answer moves nothing; the 🎙 tab never grabs a viewer back off a featured stage; a viewer
// whose picked stage ended is back on the defaults (chosen reset).
// mfix (owner 2026-10-25: "the mic stage drops between mic-ups"): a mic view that goes idle (nobody on the mic stage) stays up
// MIC_GRACE_MS with "Nobody is on the mic right now" before the page goes back to its default - a short gap between two mic-ups
// no longer flips viewers to Pepe's stream and back. A viewer who picked the 🎙 tab gets it back by itself when the mic stage
// comes back (until they pick another tab).
// upnext (owner 2026-11-05: "Yes up next card sounds good. Do it a classic / retro Public Access tv style."): a featured 📼 slot whose next
// title is starting (the server's featured.next - mainstage.libraryUpNext: a fresh ▶ Play, or a queue moving on) shows a "Coming up next"
// card (public/css/stage-upnext.css) instead of the player's "Reconnecting…": the title, the poster (signed in - o.posters - through the
// site's /api/medialib/poster proxy; none on error), "STARTING", "PLEASE STAND BY" from 30 s. It IS the pad's featured stage - it beats the
// mic stage like any featured slot, even on a page that never saw the slot live (the one exception to dock3's C2: a marker WITH next) - and
// it never moves a viewer who picked a tab. The stream comes up: its player starts behind the card, which fades once it plays (the
// player's reconnect overlay hides). Not up within next.until (90 s, server time): the card goes and the defaults are back (mic follows /
// Pepe's stream). While a card is up the page asks every 3 s. No snaps / clips / watch-minutes of a card.
// upnext2 (owner 2026-11-05: "when does the 'next up' card actually show?"): the server now holds every title for a station break (medialib
// breakSec) and tells the pad's pages at once (their /live long-poll -> poll()). Here: (C) a card that came up stays at least UPNEXT_MIN_MS, even
// when the stream is up sooner; a 📼 queue's kept player (the same stream - review F1) hands over only after its old title's tail ran out
// (a stall seen under the card, then frames moving again) - it used to fade on the tail; (D) the classic TV "coming up" lower-third over a 📼
// title that plays - "UP NEXT · <title>" in its last minute with a countdown (the server's coming.ends_at) - and "COMING UP AT <time> · <title>"
// for a booked 📼 start within 5 min (12 s when it first applies, then 12 s every 2 min; ✕ hides it for the visit), and the off-air slate
// naming a booked 📼 start within the hour. Public facts only (coming: title / kind / season / episode / year / time; a poster key only signed
// in - mainstage.comingOf). While a 📼 title is on screen the page asks every LIB_POLL_MS, and every 3 s from just before its end.
// upnext2 review fixes (1.99alc): a 📼 queue's kept player shows the old title's tail to its last frame - the card goes up once it stalls (the
// UP NEXT strip until then: it covered the last 4-10 s of every title, sound on); the strip shows twice (12 s a minute before the end, then the
// last 15 s - not the subtitles' whole last minute), is announced once per title (its countdown was read out every second), never jumps
// under a pointer / finger (the Dock's controls woke on the tap that aimed at ✕), no "COMING UP AT" over someone's stream, an embed, a cam
// or Pepe's stream (the off-air slate says it); a page on the /live long-poll (stv) polls every 10 s - the wake is its fast path - spread
// over a moment after each wake; no poster key in `coming`.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var PEPE_HLS = 'https://publicaccess.tv/hls/broadcast.m3u8';
  var CAM_REWATCH_MAX = 4, CAM_REWATCH_WIN_MS = 3 * 60 * 1000;   // mfix review: a cam slot's re-watches after a dropped connection
  var YT_ID = /^[A-Za-z0-9_-]{11}$/, YT_CH = /^UC[A-Za-z0-9_-]{22}$/, TW_LOGIN = /^[A-Za-z0-9_]{3,25}$/, TW_VOD = /^[0-9]{5,12}$/;
  // 1.99ajr golive: `at` (whole seconds into the slot) starts a YouTube video / Twitch VOD there - a stage is a broadcast: a viewer
  // who opens the page late, or whose player is rebuilt (the 🎙 mic stage came and went, a reload), joins where everyone else is
  // instead of the video starting over from 0 (owner 2026-11-04: "it just replayed the last video"). Live streams have no `at`.
  var EMBED_SEEK_MIN_S = 5;
  function embedUrl(e, at) {
    if (!e) return null;
    var host = /^[a-z0-9.-]+$/i.test(location.hostname) ? location.hostname : 'publicaccess.tv';
    var q = 'autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1';
    var sec = Math.floor(Number(at) || 0), seek = sec >= EMBED_SEEK_MIN_S;
    if (e.p === 'youtube' && (e.t === 'video' || e.t === 'live') && YT_ID.test(e.id)) return 'https://www.youtube-nocookie.com/embed/' + e.id + '?' + q + (seek && e.t === 'video' ? '&start=' + sec : '');
    if (e.p === 'youtube' && e.t === 'channel' && YT_CH.test(e.id)) return 'https://www.youtube-nocookie.com/embed/live_stream?channel=' + e.id + '&' + q;
    if (e.p === 'twitch' && e.t === 'channel' && TW_LOGIN.test(e.id)) return 'https://player.twitch.tv/?channel=' + e.id + '&parent=' + host + '&autoplay=true&muted=true';
    if (e.p === 'twitch' && e.t === 'vod' && TW_VOD.test(e.id)) {
      return 'https://player.twitch.tv/?video=v' + e.id + '&parent=' + host + '&autoplay=true&muted=true' +
             (seek ? '&time=' + Math.floor(sec / 3600) + 'h' + Math.floor(sec % 3600 / 60) + 'm' + (sec % 60) + 's' : '');
    }
    return null;
  }
  // 1.99fv: Pepe's stage source from the server (bridge.stage().pepe_src) - only known shapes get through
  function cleanSrc(x) {
    if (!x || typeof x !== 'object') return null;
    var tw = x.twitch && typeof x.twitch === 'object' && TW_LOGIN.test(String(x.twitch.login || ''))
      ? { login: String(x.twitch.login), live: x.twitch.live === true } : null;
    var feat = x.featured === true;                       // 1.99lm: an admin featured Pepe's stream (an event)
    var pad = x.pad_featured === true;                    // dock3 1.99akf: ...or this pad's owner / staff did, on this pad
    if (x.mode === 'embed' && embedUrl(x.embed)) return { mode: 'embed', embed: { p: x.embed.p, t: x.embed.t, id: x.embed.id }, label: typeof x.label === 'string' ? x.label.slice(0, 60) : '', twitch: tw, featured: feat, pad: pad };
    return { mode: 'stream', twitch: tw, featured: feat, pad: pad };
  }
  // dock3 1.99akf: the server's "this pad's featured slot", live or not (mainstage.featuredOf via /api/stage `featured` and the page's
  // first render) - {id, live, by, went}; null for none, or one this page may not show (a cam slot on the homepage / past its rule)
  function cleanFeat(x) {
    if (!x || typeof x !== 'object' || x.id == null || !/^[\w-]{1,80}$/.test(String(x.id))) return null;
    return { id: String(x.id), live: x.live === true, by: typeof x.by === 'string' ? x.by : null, went: x.went === true, next: cleanNext(x.next) };
  }
  // upnext: the featured 📼 slot's title that is starting (mainstage.upNextView) - only known shapes; text is only ever set as textContent
  var UPNEXT_MS = 90000, UN_KEY = /^\d{1,12}$/;
  function unText(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : ''; }
  function unInt(v, lo, hi) { if (v == null || v === '') return null; var x = Number(v); return isFinite(x) && Math.floor(x) === x && x >= lo && x <= hi ? x : null; }
  function cleanNext(x) {
    if (!x || typeof x !== 'object') return null;
    var ep = x.kind === 'episode', title = unText(x.title, 200), show = ep ? unText(x.show, 200) : '';
    var at = Number(x.at), until = Number(x.until);
    if ((!title && !show) || !(at > 0)) return null;
    if (!(until > at && until - at <= 10 * 60000)) until = at + UPNEXT_MS;
    var key = UN_KEY.test(String(x.key == null ? '' : x.key)) ? String(x.key) : null, yr = unInt(x.year, 1000, 9999);
    return { title: title, show: show || null, kind: ep ? 'episode' : 'movie', year: yr, season: ep ? unInt(x.season, 0, 9999) : null,
             episode: ep ? unInt(x.episode, 0, 9999) : null, poster: x.poster === true && !!key, key: key, at: at, until: until,
             now: Number(x.now) > 0 ? Number(x.now) : 0 };
  }
  // upnext2 (D): what's coming on the pad's 📼 stage (mainstage.comingOf via /api/stage `coming`) - {ends, next, at} | null; text only
  function cleanComing(x) {
    if (!x || typeof x !== 'object') return null;
    var ends = Number(x.ends_at) > 0 ? Number(x.ends_at) : null, at = Number(x.at) > 0 ? Number(x.at) : null, n = null;
    if (x.next && typeof x.next === 'object') {
      var ep = x.next.kind === 'episode', title = unText(x.next.title, 200), show = ep ? unText(x.next.show, 200) : '';
      // (upnext2 review F7: text only - no poster key; the ✕ remembers a title by its name - upKey)
      if (title || show) {
        n = { title: title, show: show || null, kind: ep ? 'episode' : 'movie', year: unInt(x.next.year, 1000, 9999), season: ep ? unInt(x.next.season, 0, 9999) : null,
              episode: ep ? unInt(x.next.episode, 0, 9999) : null };
      }
    }
    return ends || n || at ? { ends: ends, next: n, at: at } : null;
  }
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function switcher(o) {
    var slots = Array.isArray(o.slots) ? o.slots : [];
    var pepeOn = !!o.pepeOn, pepeHere = o.pepeHere !== false, chosen = false;
    var pepeSrc = cleanSrc(o.pepeSrc), ownPepe = false;   // 1.99fv: ownPepe = this viewer chose his own stream over the embed
    var featHint = cleanFeat(o.featured);                 // dock3 1.99akf: the server's featured slot (see cleanFeat)
    var coming = cleanComing(o.coming);                   // upnext2 (D): what's coming on the pad's 📼 stage (the first render; then each poll)
    // server clock - this one (from the poll's `now`; upnext: from the first render's featured.next.now until the first poll)
    var skew = featHint && featHint.next && featHint.next.now ? featHint.next.now - Date.now() : 0;
    var pepeWhep = typeof o.pepeWhep === 'string' && o.pepeWhep ? o.pepeWhep : null;   // 1.99fd
    var view = 'pepe';
    var player = PATVStage.player({ wrap: o.wrap, reconnect: o.reconnect, unmute: o.unmute, src: PEPE_HLS });
    // 1.99et: ⚡ Low latency (stage-lowlat.js, on the page only while webrtc_enabled is on) wraps the HLS player;
    // a slot published over WHIP carries s.whep. Without it everything below is the plain HLS player.
    if (PATVStage.rtcWrap) player = PATVStage.rtcWrap(player, { wrap: o.wrap, reconnect: o.reconnect, unmute: o.unmute });
    var embedFor = null, loaded = document.readyState === 'complete';
    // ── micfollow: 🎙 the mic stage ──
    var mic = null, micCtl = null;
    var micSig = '', micTabSig = '';              // what setMic / renderTabs last drew (see setMic)
    // mfix: the grace after the mic stage goes idle, and "this viewer picked the 🎙 tab"
    var MIC_GRACE_MS = 45000, micIdleAt = 0, micGraceTimer = null, micWanted = false;
    function micGrace() { return !!(window.PATVStageMic && mic && micIdleAt && Date.now() - micIdleAt < MIC_GRACE_MS); }
    function micShown() { return micOn() || micManage() || (view === 'mic' && micGrace()); }
    function idleProgram() { var p = {}; for (var k in mic) p[k] = mic[k]; p.count = 0; p.pins_n = 0; p.src = []; p.speaking = null; p.idle = true; return p; }
    function micTabKey() { return micOn() ? (mic.signin ? 'in' : mic.count || pinsN() ? 'n' + mic.count + 'p' + pinsN() : 's') : micShown() ? 'g' : ''; }
    // mfix review: mic.count = the people ON THE MIC; mic.pins_n = the 📌 pinned cams (they keep the stage up with nobody on the mic)
    function pinsN() { return mic ? Math.max(0, Number(mic.pins_n) || 0) : 0; }
    function micLabel() {
      var n = mic ? Math.max(0, Number(mic.count) || 0) : 0, p = pinsN();
      var base = n ? _t('js.stage.mf.tab', '🎙 On the mic ({n})', { n: n }) : _t('js.stage.mf.tab_speaking', '🎙 On the mic');
      return p ? base + ' · ' + _t('js.stage.mf.tab_pins', '📌 {n}', { n: p }) : base;
    }
    var padSlug = o.slug || (function () { var m = /[?&]room=([^&]+)/.exec(o.api || ''); try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; } })();
    function micStop() { if (micCtl) { micCtl.stop(); micCtl = null; } }
    // (a program whose tiles gave way to the neutral "Someone is speaking" / Pepe card keeps its tab, but never as the
    // default view - mic.active is false then: a stage of only cards is never the default, DF-15)
    function micOn() { return !!(window.PATVStageMic && mic && (mic.count > 0 || pinsN() > 0 || mic.speaking === 'someone' || mic.speaking === 'pepe')); }
    // mfix staging proof: the pad's owner / site staff (mic.manage) get the 🎙 tab while the mic stage RUNS with nobody on it - the
    // only way to ⋯ Manage → 📌 Pin a cam before anyone takes the mic. Viewers don't (nothing to watch), and it's never the
    // default view (micDefault still needs a picture); paused (why_off) or off: no tab.
    function micManage() { return !!(window.PATVStageMic && mic && mic.manage && mic.on === true && !mic.why_off && !mic.signin && !mic.blocked); }
    function micDefault() {
      return micOn() && mic.active === true && mic.default !== 'tab' && !mic.signin && !mic.blocked && !featWins();
    }
    // dock3 1.99akf: something featured beats the mic stage - a featured slot in the list (auto, by hand, booked; a held one too) or Pepe's
    // stream featured (an event / this pad). dock3 review 1.99akf: only what this page can SHOW - Pepe's feature while he is in this pad and
    // on air (through a drop of up to PEPE_HOLD_MS: an OBS reconnect never hands the view to the mic stage and back), never while he is off
    // air or away (the viewer sat on "nothing streaming right now" with people on the mic); the server's marker alone (a featured slot this
    // page doesn't list - a page loaded during its drop) no longer counts: it showed Pepe's off-air slate for up to a 📼 pause
    var PEPE_HOLD_MS = 60000, pepeOffAt = 0;              // (when his stream went off air while this page watched; 0 = on air / never seen on)
    function pepeLive() { return pepeOn || (pepeOffAt > 0 && Date.now() - pepeOffAt < PEPE_HOLD_MS); }
    function featWins() { return !!(featured() || (pepeSrc && pepeSrc.featured && pepeHere && pepeLive())); }
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
        return PATVRtc.watch(d.whep, video, { timeout: 40000, cancelled: function () { return g !== my.gen; } }).then(playing);
      }).catch(function (e) { if (g === my.gen && !(e && e.cancelled)) done(why('failed')); });
      function playing(ss) {
        if (g !== my.gen) { ss.close(); return; }
        my.sess = ss;
        if (o.reconnect) o.reconnect.classList.add('hide');
        if (ss.blocked) tap.classList.remove('hide');
        ss.onfail = function () { if (g === my.gen) rewatch(); };
      }
      // mfix review: the connection dropped after it played (Pepe re-opened the relay - e.g. by the exact name for the pad's mic
      // stage - or its publisher restarted): while the slot still says the cam is connecting / live, watch again with a fresh
      // ticket - at most CAM_REWATCH_MAX times in CAM_REWATCH_WIN_MS, then "the live cam stopped"
      function rewatch() {
        var t0 = Date.now();
        my.rew = (my.rew || []).filter(function (x) { return t0 - x < CAM_REWATCH_WIN_MS; });
        if (my.rew.length >= CAM_REWATCH_MAX) return done(why('gone'));
        my.rew.push(t0);
        if (my.sess) { try { my.sess.close(); } catch (e) {} my.sess = null; }
        if (o.reconnect) o.reconnect.classList.remove('hide');
        camPost(s.id, {}).then(function (d2) {
          if (g !== my.gen) return null;
          if (!d2 || !d2.ok || !d2.whep) return done(d2 && d2.state === 'ended' ? why(d2.why) : why(d2 && d2.code, d2 && d2.error));
          return PATVRtc.watch(d2.whep, video, { timeout: 40000, cancelled: function () { return g !== my.gen; } }).then(playing);
        }).catch(function (e) { if (g === my.gen && !(e && e.cancelled)) done(why('gone')); });
      }
    }
    function featured() { for (var i = 0; i < slots.length; i++) if (slots[i].featured) return slots[i]; return null; }
    function cur() { if (view.indexOf('slot:') !== 0) return null; for (var i = 0; i < slots.length; i++) if ('slot:' + slots[i].id === view) return slots[i]; return null; }
    function pickDefault() {
      var f = featured();
      // dock3 1.99akf: a featured slot (auto too), else Pepe's stream while it is featured (dock3 review: here and on air), else the mic stage
      // (newstream review F2, 1.99ala: never an unfeatured live stream - its tab is there to pick. One that goes live is featured by the pad's
      // takeover; an unfeatured one next to nothing featured is a choice - the pad's "Feature a live stream automatically: Off", a person's
      // ☆ Unfeature, Pepe's feature - so it is not everyone's default, at load or at a poll)
      view = f ? 'slot:' + f.id : featWins() ? 'pepe' : micDefault() ? 'mic' : 'pepe';
    }
    // newstream 1.99ala (review F2): the pad page's "Live on the stage now · Watch ›" line (room.ejs) - THIS viewer's pick, as a tab click: the
    // first live stream while the stage shows nothing (Pepe's off-air slate, a pad he isn't in). Never over a stream on screen, Pepe's stream
    // or the mic stage; never a 🎬 cam (it opens a live session) or a 📼 card. -> whether it moved
    function watchLive() {
      if (dead || cur() || view === 'mic' || (pepeOn && pepeHere)) return false;
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (s && !s.cam && !s.pending && (s.hls || s.embed)) { view = 'slot:' + s.id; chosen = true; micWanted = false; show(); return true; }
      }
      return false;
    }
    // ── upnext: 📼 "Coming up next" ──
    var UPNEXT_STANDBY_MS = 30000, UPNEXT_HANDOFF_MS = 20000, UPNEXT_POLL_MS = 3000;
    // upnext2 (C): a card stays up at least UPNEXT_MIN_MS; a kept player counts as stalled once its picture stood UPNEXT_GAP_MS. review F2: a
    // kept player that never stalls (no break - the next title follows straight on) is handed over UPNEXT_TAIL_MS after the stream came up
    var UPNEXT_MIN_MS = 4000, UPNEXT_GAP_MS = 600, UPNEXT_TAIL_MS = 12000, LIB_POLL_MS = 5000, LIB_END_MS = 15000, LIB_SOON_MS = 120000;
    var upCtl = null, upGone = {}, upTimer = null, upTimerFor = '', upFastT = null;
    function srvNow() { return Date.now() + skew; }
    function upBig(n) { return n.kind === 'episode' && n.show ? n.show : n.title || n.show || ''; }
    // "Show – Title" / "Title (1968)" (the tab's title, the ON AIR line)
    function upFull(n) { return n.kind === 'episode' && n.show ? n.show + (n.title ? ' – ' + n.title : '') : (n.title || '') + (n.year ? ' (' + n.year + ')' : ''); }
    function upKey(n) { return n.key || [n.kind, n.show, n.title, n.season, n.episode, n.year].join('|'); }
    function own(x, k) { return Object.prototype.hasOwnProperty.call(x, k); }
    // the featured slot the server says is starting its next title, as a stage entry: the slot this page held (a 📼 queue between two titles)
    // tagged pending, or one it never saw (a fresh ▶ Play, a page loaded mid-gap). A listed (live) slot is the stream itself - the card hands
    // over to it. A pending entry whose up next is over (the server stopped naming it, next.until passed) goes: the defaults again.
    // upnext review (function F3): the stream published and dropped again between two polls (an encoder colliding with the one before it on
    // the ingest and retried, an ffmpeg that died right after its first publish) - goLive cleared the server's marker, so the server names the
    // slot featured with no next while the page never saw it live: the card it had stays (`carried`) until its own until, never the mic stage.
    // `base` = the ordinary hold a pending copy was made from (the slot this page had listed) - it comes back once the card is over.
    function withPending(list, h) {
      var id = h ? String(h.id) : '', srvN = h && !h.live && h.next ? h.next : null;
      function fresh(n) { return !!(n && srvNow() < n.until && !(upGone[id] >= n.at)); }
      var out = [], have = false;
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s || String(s.id) !== id) { if (!(s && s.pending)) out.push(s); continue; }
        have = true;
        if (!s.held) { out.push(s); continue; }
        var n = fresh(srvN) ? srvN : !srvN && !h.live && s.pending && fresh(s.upnext) ? s.upnext : null;
        if (n) {
          var c = {}; for (var k in s) if (own(s, k)) c[k] = s[k];
          c.base = s.pending ? s.base || null : s;
          c.featured = true; c.pending = true; c.upnext = n; c.carried = n !== srvN; c.title = upFull(n); if (h.by) c.feature_by = h.by;
          out.push(c);
        } else if (s.pending) { if (s.base) out.push(s.base); }   // (its card is over: the slot this page had, as an ordinary hold)
        else out.push(s);                                 // an ordinary hold (a 📼 pause, an OBS reconnect): as before
      }
      if (fresh(srvN) && !have) out.unshift({ id: id, featured: true, feature_by: h.by, held: true, pending: true, upnext: srvN, title: upFull(srvN),
                                              display: _t('js.stage.upnext.tab', '📼 Up next'), hls: null, nameCss: '', base: null, carried: false });
      return out;
    }
    slots = withPending(slots, featHint);
    pickDefault();
    // 1.99ajr golive: `since` (a slot's start, server ms) -> the player starts where the broadcast is (embedUrl's `at`). The iframe
    // is keyed by the video itself, so a poll never rebuilds it; the position only counts when it IS (re)built.
    // (`skew` - server clock minus this one - is set above: upnext needs it from the first render)
    function setEmbed(e, since) {
      var url = embedUrl(e);
      if (!o.embedHost) return;
      if (!url) { o.embedHost.innerHTML = ''; o.embedHost.classList.add('hide'); embedFor = null; return; }
      if (embedFor === url) return;
      embedFor = url;
      var at = Number(since) > 0 ? (Date.now() + skew - Number(since)) / 1000 : 0;
      o.embedHost.innerHTML = '';
      var f = document.createElement('iframe');
      f.src = embedUrl(e, at) || url; f.title = _t('js.stage.room.video_title', 'Stage video'); f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.setAttribute('allowfullscreen', ''); f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
      o.embedHost.appendChild(f);
      o.embedHost.classList.remove('hide');
    }
    // 1.99fv: the embed an admin put on Pepe's stage (null = his own stream). Re-checked like a slot's.
    function pepeEmbed() { return !ownPepe && pepeSrc && pepeSrc.mode === 'embed' && embedUrl(pepeSrc.embed) ? pepeSrc.embed : null; }
    // ── upnext: the card (the micCtl / camCtl pattern) - mounted as the first child of o.wrap, every server text as textContent ──
    function upOverlays(hide) {                     // the player's own overlays sit over the box: out of the way while the card is up
      [o.reconnect, o.unmute].forEach(function (x) { if (x && x.style) x.style.visibility = hide ? 'hidden' : ''; });
    }
    // upnext review (function F1): a slot this page already plays (a 📼 queue between two titles - the same stream, the same player) keeps its
    // player UNDER the card: the viewer's sound, picture-in-picture and the player's own fullscreen carry on into the next title, as the
    // 1.99akf hold did. A fresh slot (a new ▶ Play) has nothing to keep.
    function upKeep(s) { return !!(s && s.hls && player.running() && typeof player.src === 'function' && player.src() === s.hls); }
    // the stage's <video> itself is fullscreen / picture-in-picture (not the Dock's in-place fullscreen of the whole stage): nobody would see a
    // card on the page - and the Dock leaves picture-in-picture when what's showing changes - so that viewer keeps the plain hold; the card
    // comes on the next poll after they're back
    function videoAway() {
      try {
        var D = document, w = o.wrap, inW = function (x) { return !!(x && x !== w && typeof w.contains === 'function' && w.contains(x)); };
        if (inW(D.pictureInPictureElement) || inW(D.fullscreenElement) || inW(D.webkitFullscreenElement)) return true;
        var vs = typeof w.querySelectorAll === 'function' ? w.querySelectorAll('video') : [];
        for (var i = 0; i < vs.length; i++) if (vs[i].webkitDisplayingFullscreen || vs[i].webkitPresentationMode === 'picture-in-picture' || vs[i].webkitPresentationMode === 'fullscreen') return true;
      } catch (e) { /* an old engine: the card */ }
      return false;
    }
    function cardOn(s) { return !!(s && s.pending && !(upKeep(s) && videoAway())); }
    function upCard(id, n, kept) {
      // upnext2 (C): shown = when it came up (the minimum), kept = a 📼 queue's own player plays on under it (its old title's tail first).
      // review F2 (1.99alc): a kept card WAITS (wait: not on the page - the UP NEXT strip says what's next, l3Want) until that player stalls - the
      // old title's last seconds stay visible, with their sound; then it goes up (mount) and `shown` starts its minimum
      var D = document, my = { id: id, key: upKey(n), n: n, leaving: false, timers: [], handing: 0, shown: Date.now(), kept: !!kept, gap: !kept, wait: !!kept, mounted: false };
      function el(tag, cls, txt) { var x = D.createElement(tag); if (cls) x.className = cls; if (txt != null) x.textContent = txt; return x; }
      function bars(cls) { var b = el('div', cls); for (var i = 0; i < 7; i++) b.appendChild(el('i')); return b; }
      var card = el('div', 'st-upnext'), big = upBig(n);
      card.setAttribute('role', 'status'); card.setAttribute('aria-live', 'polite');
      card.setAttribute('data-len', big.length > 64 ? 'xl' : big.length > 36 ? 'l' : 's');
      card.setAttribute('data-state', 'starting');
      // (the live region goes in empty and is filled a moment later - one filled at insert is often not announced)
      var sr = el('span', 'st-un-sr'); card.appendChild(sr);
      var scr = el('div', 'st-un-screen'); scr.setAttribute('aria-hidden', 'true');
      var band = el('div', 'st-un-band'); band.appendChild(bars('st-un-bars')); band.appendChild(bars('st-un-castle')); scr.appendChild(band);
      var top = el('div', 'st-un-top'), clock = el('span', 'st-un-clock'); top.appendChild(clock); scr.appendChild(top);
      var body = el('div', 'st-un-body'), pic = null, tx = el('div', 'st-un-txt');
      tx.appendChild(el('p', 'st-un-kick', _t('js.stage.upnext.kicker', 'Coming up next')));
      tx.appendChild(el('span', 'st-un-rule'));
      tx.appendChild(el('p', 'st-un-title', big));
      var sub = el('p', 'st-un-sub');
      if (n.kind === 'episode') {
        if (n.season != null && n.episode != null) sub.appendChild(el('span', 'st-un-meta', _t('js.stage.upnext.episode', 'S{season} · E{episode}', { season: n.season, episode: n.episode })));
        if (n.show && n.title) sub.appendChild(el('span', 'st-un-ep', n.title));
      } else sub.appendChild(el('span', 'st-un-meta', (n.year ? n.year + ' · ' : '') + _t('js.stage.upnext.movie', 'Movie')));
      if (sub.children ? sub.children.length : sub.childNodes.length) tx.appendChild(sub);
      var st = el('span', 'st-un-start'), word = el('span', 'st-un-word', _t('js.stage.upnext.starting', 'Starting'));
      st.appendChild(el('i', 'st-un-play')); st.appendChild(word); st.appendChild(el('span', 'st-un-dots', '…')); st.appendChild(el('i', 'st-un-cur'));
      tx.appendChild(st);
      body.appendChild(tx); scr.appendChild(body);
      var foot = el('div', 'st-un-foot'); foot.appendChild(el('span', 'st-un-bug', 'PATV')); scr.appendChild(foot);   // (the station bug: never translated)
      scr.appendChild(el('div', 'st-un-roll'));
      card.appendChild(scr);
      // the poster: the site's own proxy (signed in), never a broken image - one that doesn't load is the plain card, for good (upnext review
      // V1: the next poll put a failed one back)
      var picFailed = false;
      function setPic(nn) {
        var want = !!(nn.poster && nn.key && o.posters) && !picFailed;
        if (want && !pic) {
          pic = el('div', 'st-un-pic'); var img = el('img');
          img.alt = ''; img.decoding = 'async';
          img.onerror = function () { picFailed = true; card.setAttribute('data-poster', '0'); };
          img.src = '/api/medialib/poster/' + encodeURIComponent(nn.key);
          pic.appendChild(img); body.insertBefore(pic, tx);
        }
        card.setAttribute('data-poster', pic && want ? '1' : '0');
      }
      setPic(n);
      var lang = (D.documentElement && D.documentElement.lang) || undefined, fmt = null;
      try { fmt = new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }); } catch (e) { fmt = null; }
      function tick() { var d = new Date(srvNow()); clock.textContent = fmt ? fmt.format(d).toUpperCase() : ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
      tick(); my.clock = setInterval(tick, 15000);
      function ariaTitle(nn) {
        if (nn.kind === 'episode' && nn.show) {
          var e = nn.season != null && nn.episode != null ? _t('js.stage.upnext.episode_aria', 'season {season}, episode {episode}', { season: nn.season, episode: nn.episode }) : '';
          return nn.show + (e ? ', ' + e : '') + (nn.title ? ', ' + nn.title : '');
        }
        return (nn.title || '') + (nn.year ? ' (' + nn.year + ')' : '');
      }
      // 30 s in and still starting: the classic "PLEASE STAND BY" (static), from the server's moment - a page loaded mid-gap is on time too
      var standbyT = null;
      function standby() {
        clearTimeout(standbyT); standbyT = null;
        var left = my.n.at + UPNEXT_STANDBY_MS - srvNow();
        if (left > 0) { standbyT = setTimeout(standby, left + 20); return; }
        card.setAttribute('data-state', 'standby'); word.textContent = _t('js.stage.upnext.standby', 'Please stand by');
      }
      standby();
      my.el = card;
      /** the card goes up: on the page, the player's overlays out of the way, announced (review F2: a kept one once its player stalled) */
      function mount() {
        if (my.mounted || my.leaving) return;
        my.mounted = true; my.wait = false; my.shown = Date.now();
        o.wrap.insertBefore(card, o.wrap.firstChild || null);
        upOverlays(true);
        my.timers.push(setTimeout(function () { sr.textContent = _t('js.stage.upnext.aria', 'Up next on the stage: {title} – starting…', { title: ariaTitle(my.n) }); }, 60));
        if (upCtl === my) l3Sync(true);                       // (the UP NEXT strip gives way to it)
      }
      my.mount = mount;
      /** a newer answer for the same title: its moment, a poster that came (signed in) */
      my.update = function (nn) { var at0 = my.n.at; my.n = nn; setPic(nn); if (nn.at !== at0 && card.getAttribute('data-state') !== 'standby') standby(); };
      /** the stream is listed live: its player started behind the card - fade once it plays, at most UPNEXT_HANDOFF_MS. "Plays" = the reconnect
       *  overlay is down AND the picture moves (upnext review F1: a kept player may sit on the last title's frame with no overlay up).
       *  upnext2 (C): a kept player (a 📼 queue's own stream) first plays out what it still had of the title before - "plays" counts only once
       *  it stalled under the card (`gap`: the overlay up, not playing, or the picture still for UPNEXT_GAP_MS - looked at from the card's first
       *  moment); and the card goes no sooner than UPNEXT_MIN_MS after it came up (outMin) */
      var gapLast = null, gapStill = 0;
      function gapSeen() { my.gap = true; clearInterval(my.gapT); if (my.wait) mount(); }
      function gapLook() {
        if (my.gap || my.leaving) return;
        var st = null;
        try { st = player.running() && player.state ? player.state() : null; } catch (e) { st = null; }
        var over = !!(o.reconnect && o.reconnect.classList && !o.reconnect.classList.contains('hide'));
        if (!st || !st.playing || over) { gapSeen(); return; }
        var tm = Number(st.time) || 0;
        if (gapLast !== null && Math.abs(tm - gapLast) < 0.05) { if (!gapStill) gapStill = Date.now(); else if (Date.now() - gapStill >= UPNEXT_GAP_MS) gapSeen(); }
        else gapStill = 0;
        gapLast = tm;
      }
      if (my.kept) { gapLook(); if (!my.gap) my.gapT = setInterval(gapLook, 200); }   // (already stalled when the card came up: that's the gap)
      else mount();
      my.outMin = function (fast) {
        if (my.leaving) return;
        var w = my.shown + UPNEXT_MIN_MS - Date.now();
        if (w > 0) { if (!my.minT) my.minT = setTimeout(function () { my.minT = null; my.out(fast); }, w); return; }
        my.out(fast);
      };
      my.handoff = function () {
        if (my.handing || my.leaving) return;
        my.handing = Date.now();
        var t0 = null;
        my.watch = setInterval(function () {
          if (my.leaving || my.minT) return;
          if (Date.now() - my.handing > UPNEXT_HANDOFF_MS) { my.out(true); return; }   // never played: the player's own "Reconnecting…" again
          if (!player.running()) return;
          if (my.kept) gapLook();
          // (review F2: a kept player that never stalled - the next title followed its tail straight on: nothing to hand over)
          if (my.wait && Date.now() - my.handing > UPNEXT_TAIL_MS) { my.out(false); return; }
          if (o.reconnect && o.reconnect.classList && !o.reconnect.classList.contains('hide')) { t0 = null; return; }
          var st = null;
          try { st = player.state ? player.state() : null; } catch (e) { st = null; }
          if (!st) { my.outMin(false); return; }                                       // (no playback state to read: the overlay is enough)
          if (!st.playing) { t0 = null; return; }
          if (!my.gap) { t0 = null; return; }                                          // (upnext2: still the title before's tail)
          var tm = Number(st.time) || 0;
          if (t0 === null) { t0 = tm; return; }
          if (Math.abs(tm - t0) >= 0.2) my.outMin(false);
        }, 250);
      };
      my.out = function (fast) {
        if (my.leaving) return;
        my.leaving = true;
        clearInterval(my.clock); clearInterval(my.watch); clearTimeout(standbyT); my.timers.forEach(clearTimeout);
        clearInterval(my.gapT); clearTimeout(my.minT); my.minT = null;                  // (upnext2)
        var was = upCtl === my;
        if (was) upCtl = null;
        var gone = function () { if (card.parentNode) card.parentNode.removeChild(card); };
        if (my.mounted) {
          upOverlays(false);
          card.classList.add('is-out');
          var rm = false;
          try { rm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { rm = false; }
          if (fast) gone(); else setTimeout(gone, rm ? 250 : 700);
        } else gone();
        if (was && my.wait) l3Sync(true);                     // (review F2: the UP NEXT strip it had goes with it)
      };
      return my;
    }
    function upShow(s) {
      var n = s.upnext, id = String(s.id);
      if (upCtl && upCtl.id === id && upCtl.key === upKey(n) && !upCtl.leaving && !upCtl.handing) { upCtl.update(n); return; }
      upHide(true);
      upCtl = upCard(id, n, upKeep(s));
    }
    function upHide(fast) { if (upCtl) upCtl.out(fast); }
    // while a card is up: the page's one poll runs every UPNEXT_POLL_MS until "PLEASE STAND BY" (upnext review F5: a second timer beside the
    // 10 s one doubled the calls; a title that slow isn't worth a 3 s poll for another minute), and the card goes at next.until (server time)
    // without waiting for a poll
    function upSync() {
      var p = null;
      for (var i = 0; i < slots.length; i++) if (slots[i] && slots[i].pending) { p = slots[i]; break; }
      if (upFastT) { clearTimeout(upFastT); upFastT = null; }
      if (!p || dead) {
        if (upTimer) { clearTimeout(upTimer); upTimer = null; }
        upTimerFor = '';
        pollAt(dead ? POLL_MS : libPoll());
        return;
      }
      var fastFor = p.upnext.at + UPNEXT_STANDBY_MS - srvNow();
      pollAt(fastFor > 0 ? UPNEXT_POLL_MS : POLL_MS);
      if (fastFor > 0) upFastT = setTimeout(function () { upFastT = null; upSync(); }, fastFor + 50);   // (back to 10 s on time, answers or not)
      var sig = p.id + '@' + p.upnext.at;
      if (upTimerFor === sig) return;
      if (upTimer) clearTimeout(upTimer);
      upTimerFor = sig;
      var id = String(p.id), at = p.upnext.at;
      upTimer = setTimeout(function () { upTimer = null; upTimerFor = ''; upExpire(id, at); }, Math.max(0, p.upnext.until - srvNow()) + 50);
    }
    function upExpire(id, at) {
      if (dead) return;
      upGone[id] = Math.max(upGone[id] || 0, at);
      if (upCtl && upCtl.id === id) upHide(false);
      var was = cur(), out = [];
      slots.forEach(function (s) {
        if (!(s && String(s.id) === id && s.pending)) { out.push(s); return; }
        // (its card was carried over a publish-and-drop the server still holds as an ordinary feature: the hold this page had before it)
        if (s.carried && s.base && featHint && featHint.id === id && !featHint.live && !featHint.next) out.push(s.base);
      });
      slots = out;
      if (was && !cur()) { chosen = false; pickDefault(); }          // (it was on screen: back on the defaults - mic follows / Pepe's stream)
      else if (!chosen) pickDefault();
      show();
    }
    // ── upnext2 (D): the 📼 "UP NEXT" lower-third, the off-air slate ──
    // review F7 (1.99alc): the strip shows twice - L3_SHOW_MS from a minute before the end, then the last L3_LAST_MS (the subtitles burned into the
    // foot of the picture were covered for the whole last minute); F6: no "COMING UP AT" strip over another stream (someone's OBS, an embed - over
    // its own controls -, a cam, Pepe's stream): a booked 📼 start is named by the off-air slate while nothing is on, and by its card when it starts
    var L3_SOON_MS = 60000, L3_SHOW_MS = 12000, L3_LAST_MS = 15000, SLATE_MS = 60 * 60000;
    var l3 = null, l3Tick = null, l3First = {}, slate = null;
    // a 📼 title is what's on screen (its stream plays - not a card)
    function libOn() { var s = cur(); return !!(s && s.lib && !s.pending && !s.cam && !s.embed && s.hls); }
    // the poll while a 📼 title is on screen. review F10 / safety F8+F9 (1.99alc): a page on the pad's /live long-poll (stvLive - it carried the
    // stage version lately) is woken at every title change: the ordinary 10 s. Without it: every 10 s until LIB_SOON_MS before the end, then
    // every LIB_POLL_MS, every 3 s from LIB_END_MS before it (the break's card) - it used to be every 5 s for a title's whole length
    var STV_LIVE_MS = 45000, STV_JITTER_MS = 750, stvSeen = null, stvAt = 0, stvT = null;
    function stvLive() { return stvAt > 0 && Date.now() - stvAt < STV_LIVE_MS; }
    function libPoll() {
      if (!libOn() || stvLive()) return POLL_MS;
      var left = coming && coming.ends ? coming.ends - srvNow() : Infinity;
      return left < LIB_END_MS && left > -UPNEXT_STANDBY_MS ? UPNEXT_POLL_MS : left < LIB_SOON_MS && left > -UPNEXT_STANDBY_MS ? LIB_POLL_MS : POLL_MS;
    }
    /** upnext2: the pad's stage version from its /live long-poll (room.ejs, the homepage Dock for the stage's own pad) - a move = something
     *  changed on the stage: ask now. review F9: every open page hears it at the same moment - each asks within STV_JITTER_MS, not all at once */
    function stv(v) {
      if (dead || v == null || v === '') return;
      stvAt = Date.now();
      var was = stvSeen; stvSeen = v;
      if (!slots.some(function (x) { return x && x.pending; })) pollAt(libPoll());
      if (was == null || was === v) return;
      if (stvT) clearTimeout(stvT);
      stvT = setTimeout(function () { stvT = null; poll(); }, Math.floor(Math.random() * STV_JITTER_MS));
    }
    function l3Title(n) { return n ? (n.kind === 'episode' && n.show ? n.show + (n.season != null && n.episode != null ? ' · S' + n.season + 'E' + n.episode : '') + (n.title ? ' · ' + n.title : '') : (n.title || '') + (n.year ? ' (' + n.year + ')' : '')) : ''; }
    function l3Time(ms) {
      try { if (window.PATVTime && window.PATVTime.format) return window.PATVTime.format(ms, 'time'); } catch (e) { /* the browser's own */ }
      try { return new Intl.DateTimeFormat((document.documentElement && document.documentElement.lang) || undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); }
      catch (e) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    }
    function l3Clock(sec) { sec = Math.max(0, Math.ceil(sec)); return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2); }
    function l3Gone(k) { try { return !!(window.sessionStorage && sessionStorage.getItem('patv.l3x.' + padSlug + '.' + k)); } catch (e) { return !!l3First['x' + k]; } }
    function l3Hide(k) { l3First['x' + k] = 1; try { if (window.sessionStorage) sessionStorage.setItem('patv.l3x.' + padSlug + '.' + k, '1'); } catch (e) { /* this visit: memory */ } }
    // what the lower-third should say now -> {mode, k, tag, title, when} | null
    function l3Want() {
      if (dead || view === 'mic') return null;
      var s = cur(), k;
      // review F2: a queue's kept player still plays its old title's tail under a card that waits for the stall - "UP NEXT · <title>" meanwhile
      if (upCtl && upCtl.wait && !upCtl.leaving && s && String(s.id) === upCtl.id) {
        k = 'n:' + l3Key(upCtl.n);
        return l3Gone(k) ? null : { mode: 'next', k: k, tag: _t('js.stage.l3.next', 'Up next'), title: l3Title(upCtl.n), when: '' };
      }
      if (!coming || !coming.next || cardOn(s) || !libOn() || !coming.ends) return null;
      var left = coming.ends - srvNow(), n = coming.next;
      if (!((left <= L3_SOON_MS && left > L3_SOON_MS - L3_SHOW_MS) || (left <= L3_LAST_MS && left > -10000))) return null;
      k = 'n:' + l3Key(n);
      return l3Gone(k) ? null : { mode: 'next', k: k, tag: _t('js.stage.l3.next', 'Up next'), title: l3Title(n), when: left > 0 ? _t('js.stage.l3.in', 'in {time}', { time: l3Clock(left / 1000) }) : '' };
    }
    // (the strip's key is the title itself - the countdown strip (`coming`, text only) and the one over a kept player's tail (the marker, with
    // its poster key) are the same strip: no second announcement, one ✕ for both)
    function l3Key(n) { return [n.kind, n.show, n.title, n.season, n.episode, n.year].join('|'); }
    function setText(el, v) { if (el && el.textContent !== v) el.textContent = v; }   // (review F1: a live region is rewritten only when it changes)
    // the off-air slate: nothing on this stage and a booked 📼 start within the hour - the stage box opens for it (onAir(true, …, {slate}): the page
    // says OFF AIR, the slate fills the player)
    function slateWant() { var t = srvNow(); return !!(coming && coming.at && coming.next && coming.at - t <= SLATE_MS && coming.at - t > -60000); }
    function idleNow() { return !cur() && view !== 'mic' && !(pepeOn && pepeHere); }
    function l3Sync(fromShow) {
      if (dead) { l3Off(); slateOff(); return; }
      if (!fromShow && (idleNow() && slateWant()) !== !!slate) { show(); return; }   // (the slate's hour came / went: the stage box follows)
      var w = l3Want();
      if (!w) l3Off();
      else {
        if (!l3 || l3.k !== w.k) {
          l3Off();
          var D = document, box = D.createElement('div'), tag = D.createElement('span'), ttl = D.createElement('span'), when = D.createElement('span'), x = D.createElement('button');
          // review F1 (1.99alc): the strip itself is no live region - its countdown was read out every second. A visually hidden status says the
          // title ONCE (filled a moment after it's on the page - one filled at insert is often not announced); the strip's own text is for eyes
          var sr = D.createElement('span');
          box.className = 'st-l3'; box.setAttribute('data-mode', w.mode);
          sr.className = 'st-l3-sr'; sr.setAttribute('role', 'status');
          tag.className = 'st-l3-tag'; ttl.className = 'st-l3-title'; when.className = 'st-l3-when';
          tag.setAttribute('aria-hidden', 'true'); ttl.setAttribute('aria-hidden', 'true'); when.setAttribute('aria-hidden', 'true');
          x.type = 'button'; x.className = 'st-l3-x'; x.textContent = '✕'; x.setAttribute('aria-label', _t('js.stage.l3.hide', 'Hide'));
          var k = w.k, said = _t('js.stage.l3.sr_next', 'Up next on the stage: {title}', { title: w.title });
          x.addEventListener('click', function () { l3Hide(k); l3Off(); });
          // review F4 (1.99alc): a tap / click on the strip never wakes the Room Dock's controls (they lifted it 48 px under the finger: the first
          // tap on ✕ hit the video), and while a pointer is over it, it stays where it is (the controls showing / hiding moved it under the cursor)
          var still = function (e) { if (e && e.stopPropagation) e.stopPropagation(); };
          box.addEventListener('pointerdown', still); box.addEventListener('focusin', still);
          box.addEventListener('pointerenter', function () {
            clearTimeout(box.fz);
            try { if (!box.style.bottom && window.getComputedStyle) box.style.bottom = window.getComputedStyle(box).bottom; } catch (e) { /* the CSS's own place */ }
          });
          box.addEventListener('pointerleave', function () { clearTimeout(box.fz); box.fz = setTimeout(function () { box.style.bottom = ''; }, 700); });
          box.appendChild(sr); box.appendChild(tag); box.appendChild(ttl); box.appendChild(when); box.appendChild(x);
          o.wrap.appendChild(box);
          l3 = { k: w.k, el: box, tag: tag, title: ttl, when: when, sr: sr };
          l3.srT = setTimeout(function () { setText(sr, said); }, 60);
        }
        setText(l3.tag, w.tag); setText(l3.title, w.title); setText(l3.when, w.when);
      }
      // the slate: nothing on this stage (the "nothing streaming" view) and a booked 📼 start within the hour
      if (idleNow() && slateWant()) {
        if (!slate) {
          var D2 = document; slate = D2.createElement('div'); slate.className = 'st-slate'; slate.setAttribute('role', 'status');
          var sk = D2.createElement('p'); sk.className = 'st-slate-kick'; var st2 = D2.createElement('p'); st2.className = 'st-slate-title';
          var bug = D2.createElement('span'); bug.className = 'st-slate-bug'; bug.textContent = 'PATV';
          slate.appendChild(sk); slate.appendChild(st2); slate.appendChild(bug);
          o.wrap.appendChild(slate);
        }
        setText(slate.children[0], _t('js.stage.slate.at', 'Coming up at {time}', { time: l3Time(coming.at) }));   // (review F1: only when it changes)
        setText(slate.children[1], l3Title(coming.next));
      } else slateOff();
      // ticking while something may come up (the countdown, the slate's hour); nothing to look for: no timer
      var need = !!(coming && (coming.ends || coming.at));
      if (need && !l3Tick) l3Tick = setInterval(function () { l3Sync(); if (!slots.some(function (x) { return x && x.pending; })) pollAt(libPoll()); }, 1000);
      else if (!need && l3Tick) { clearInterval(l3Tick); l3Tick = null; }
    }
    function l3Off() { if (l3) { clearTimeout(l3.srT); clearTimeout(l3.el.fz); if (l3.el.parentNode) l3.el.parentNode.removeChild(l3.el); l3 = null; } }
    function slateOff() { if (slate) { if (slate.parentNode) slate.parentNode.removeChild(slate); slate = null; } }
    function show() {
      if (dead) return;
      if (view === 'mic' && !micShown()) pickDefault();
      var s = cur();
      if (view !== 'mic') micStop();
      if (!(s && s.cam)) camStop();
      // upnext: the card stays while its slot is on screen (pending, or its stream just listed - the hand-over); anything else: gone
      if (upCtl && !(s && String(s.id) === upCtl.id && (cardOn(s) || (!s.pending && !s.cam && !s.embed && s.hls)))) upHide(false);
      if (view === 'mic') {                                     // micfollow: 🎙 On the mic (stage-mic.js)
        player.stop(); setEmbed(null);
        var prog = micOn() ? mic : idleProgram();               // mfix: idle during the grace - "nobody is on the mic right now"
        if (micCtl) micCtl.update(prog);
        else micCtl = PATVStageMic.render(o.wrap, prog, { slug: padSlug, onChange: function () { /* the long-poll brings the new program */ } });
        if (o.unmute) o.unmute.classList.add('hide');
        o.onAir && o.onAir(true, '🎙 ' + (prog.count || '') + (prog.pins_n ? ' 📌' + prog.pins_n : ''));
      } else if (cardOn(s)) {                                   // upnext: 📼 "Coming up next" until its stream is up
        if (!upKeep(s)) player.stop();                          // (review F1: the queue's own player stays under the card)
        setEmbed(null); upShow(s);
        o.onAir && o.onAir(true, '📼 ' + upFull(s.upnext), { pending: true });
      } else if (s && s.cam) {
        player.stop(); setEmbed(null); camShow(s);
        o.onAir && o.onAir(true, s.title || null);
      } else if (s && s.embed) {
        player.stop(); setEmbed(s.embed, s.since);
        o.onAir && o.onAir(true, (s.title ? s.title + ' · ' : '') + _t('js.stage.room.from', 'from {platform}', { platform: s.embed.p === 'youtube' ? 'YouTube' : 'Twitch' }));
      } else if (s) {
        setEmbed(null);
        player.setSrc(s.hls, s.whep || null); if (loaded) player.start();
        if (upCtl && upCtl.id === String(s.id) && loaded && !s.pending) upCtl.handoff();   // upnext: the card fades once this plays
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
        if (slateWant()) o.onAir && o.onAir(true, null, { slate: true });   // upnext2 (D): the slate names a booked 📼 start (l3Sync draws it)
        else o.onAir && o.onAir(any, any ? (pepeHere ? _t('js.stage.room.pepe_off_pick', 'Pepe\'s stream is off air - pick a stream above') : _t('js.stage.room.pick', 'pick a stream above')) : _t('js.stage.room.nothing', 'nothing streaming right now'));
      }
      renderTabs();
      // 1.99aal: 🟣 admins - Pepe's Twitch relay switch on his stream's player (twitch-btn.js, only on admins' pages)
      if (window.PATVTwitchBtn) window.PATVTwitchBtn.sync(o.wrap.parentNode || o.wrap, !s && view !== 'mic' && pepeHere && pepeOn);
      // 1.99aan: ✂ Cut / 📺 Play content here under the player (site staff; onair-bar.js)
      if (window.PATVOnAirBar && pepeHere) window.PATVOnAirBar.sync(o.wrap.parentNode || o.wrap);
      if (o.onShow) o.onShow(selection());
      upSync();
      l3Sync(true);                                            // upnext2 (D): the lower-third / the off-air slate
    }
    // 1.99cr: what's on screen, for the Snap / Clip bar (stage-capture.js). Pepe's stream is captured from
    // his HLS on the server even while the page shows an admin-chosen embed, so it counts while HLS is on air.
    function selection() {
      if (view === 'mic' && micShown()) return micCtl ? micCtl.selection() : { stream: 'mic', label: '🎙', embed: true, capture: false, nsfw: false };   // micfollow: never captured
      var s = cur();
      // upnext: a card - no snaps / clips / watch-minutes; `pending` = stage-capture.js shows its row greyed (review V3: not the YouTube note)
      if (cardOn(s)) return { stream: s.id, label: '📼', embed: true, capture: false, nsfw: false, pending: true };
      if (s && s.cam) return { stream: s.id, label: s.display, embed: true, capture: false, nsfw: !!s.nsfw };   // 1.99zc: no snaps / clips / watch-minutes of a cam
      if (s) return { stream: s.id, label: s.display, embed: !!s.embed, capture: !s.embed && s.capture !== false, nsfw: !!s.nsfw };
      if (pepeHere && pepeOn) return { stream: 'pepe', label: _t('js.stage.room.pepe_stream', 'Pepe\'s stream'), embed: false, capture: true, nsfw: false };
      return null;
    }
    // 1.99fv: next to Pepe's tab while he's on air and showing - subtle: "Pepe's own stream" when an admin embed
    // is up (this viewer only), "Watch on Twitch" while our relay to his Twitch runs (info + a link; nothing swaps)
    function pepeExtras() {
      if (!pepeHere || !pepeOn || cur() || view === 'mic') return '';
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
    // dock3 1.99akf (owner item 5): ★ Feature / ☆ Unfeature on Pepe's stream - the SAME .adm buttons a slot gets (o.manage: the pad's owner,
    // staff; the Room Dock lists them in the source chip's ▾ as it does a slot's), featuring his stream on this pad. ☆ while this pad features
    // it; nothing while only the site-wide event does (that one is /stage/admin's) or he is off air.
    // (the old homepage switcher polls without a room: the front pad's slug from the poll - dock3 review 1.99akf: from the first render on, o.front)
    var lastFront = typeof o.front === 'string' && o.front ? o.front : null;
    function featRoom() { return padSlug || lastFront || ''; }
    // dock3 review 1.99akf: o.manage was worked out for ONE pad - the pad page's, the Dock's block, the old homepage's first front pad; once the
    // old homepage shows another pad (the front page changed) its ★ / ✂ buttons go until a reload (they answered 403 there)
    var manageFor = padSlug || lastFront || '';
    function canAdm() { return !!o.manage && (!manageFor || featRoom() === manageFor); }
    function pepeAdm() {
      if (!canAdm() || !pepeHere || view !== 'pepe' || cur() || !featRoom()) return '';
      if (pepeSrc && pepeSrc.pad) return '<span class="adm"><button type="button" data-act="pepe-unfeature">' + esc(_t('js.stage.room.unfeature', '☆ Unfeature')) + '</button></span>';
      if ((pepeSrc && pepeSrc.featured) || !pepeOn) return '';
      return '<span class="adm"><button type="button" data-act="pepe-feature">' + esc(_t('js.stage.room.feature', '★ Feature')) + '</button></span>';
    }
    function pepeFeature(b, on) {
      if (!confirm(on ? _t('js.stage.room.q_pepe_feature', 'Feature Pepe\'s stream? It becomes the pad\'s main stream.') : _t('js.stage.room.q_pepe_unfeature', 'Stop featuring Pepe\'s stream on this pad?'))) return;
      b.disabled = true;
      fetch('/api/stage/pepe/feature', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ room: featRoom(), on: on }) })
        .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) alert(j.error || _t('js.stage.room.e_do', 'Could not do that.')); poll(); })
        .catch(function () { alert(_t('js.stage.room.e_net', 'Could not reach the server.')); b.disabled = false; });
    }
    function renderTabs() {
      var box = o.tabs;
      micTabSig = micTabKey();
      if (!box) return;
      if (!slots.length && !micShown() && !pepeAdm()) { box.innerHTML = pepeExtras(); return; }
      var h = '';
      slots.forEach(function (s) {
        if (s.pending) {                                    // upnext: 📼 Up next - featured, not live yet (a hollow dot; the Dock's chip reads .n)
          h += '<button type="button" class="stab feat off pending" role="tab" data-v="slot:' + esc(s.id) + '" aria-selected="' + (view === 'slot:' + s.id) + '"' +
               (s.title ? ' title="' + esc(s.title) + '"' : '') + '><span class="dot" aria-hidden="true"></span><span class="star" aria-label="' + esc(_t('js.stage.room.featured', 'featured')) + '">★</span>' +
               '<span class="n">' + esc(_t('js.stage.upnext.tab', '📼 Up next')) + '</span></button>';
          return;
        }
        h += '<button type="button" class="stab' + (s.featured ? ' feat' : '') + '" role="tab" data-v="slot:' + esc(s.id) + '" aria-selected="' + (view === 'slot:' + s.id) + '"' +
             (s.title ? ' title="' + esc(s.title) + '"' : '') + '>' +
             '<span class="dot" aria-hidden="true"></span>' + (s.featured ? '<span class="star" aria-label="' + esc(s.feature_by === 'auto' ? _t('js.stage.room.featured_auto', 'featured while live') : _t('js.stage.room.featured', 'featured')) + '"' +
               (s.feature_by === 'auto' ? ' title="' + esc(_t('js.stage.room.featured_auto_title', 'Featured automatically: it went live while nothing else was featured')) + '"' : '') + '>★</span>' : '') +
             '<span class="n' + (s.nameCss ? ' cx-name' : '') + '" style="' + esc(s.nameCss || '') + '">' + esc(s.display) + '</span>' +
             (s.embed ? '<span class="src">' + (s.embed.p === 'youtube' ? 'YouTube' : 'Twitch') + '</span>' : '') +
             (s.cam ? '<span class="src">' + esc(_t('js.pad.strip.cam_src', '📷 cam')) + '</span>' : '') + '</button>';
      });
      if (micShown()) {                                     // micfollow: 🎙 On the mic, before Pepe's tab (mfix: kept during the grace)
        var ml = mic.signin ? _t('js.stage.mf.tab_signin', '🎙 On the mic: sign in to watch')
          : micOn() ? micLabel() : _t('js.stage.mf.tab_speaking', '🎙 On the mic');
        h += '<button type="button" class="stab mf-tab" role="tab" data-v="mic" aria-selected="' + (view === 'mic') + '"><span class="dot" aria-hidden="true"></span>' + esc(ml) + '</button>';
      }
      var pOn = pepeOn;                                     // 1.99fv: his own stream only - Twitch never counts
      var pF = !!(pepeSrc && pepeSrc.featured);             // 1.99lm
      if (pepeHere) h += '<button type="button" class="stab' + (pOn ? '' : ' off') + (pF ? ' feat' : '') + '" role="tab" data-v="pepe" aria-selected="' + (view === 'pepe') + '">' +
           '<span class="dot" aria-hidden="true"></span>' + (pF ? '<span class="star" aria-label="' + esc(_t('js.stage.room.featured', 'featured')) + '">★</span>' : '') + esc(pOn ? _t('js.stage.room.pepe_tab', '🐸 Pepe\'s stream') : _t('js.stage.room.pepe_tab_off', '🐸 Pepe\'s stream (off air)')) + '</button>';
      h += pepeExtras();
      // stagefix site: 🙈 the viewer's OWN Camfrog cam is on this pad's Stage (s.mine, mainstage.slotsFor) - take it off
      slots.forEach(function (x) {
        if (x.cam && x.mine === true) h += '<button type="button" class="stx" data-act="leave" data-id="' + esc(x.id) + '" title="' + esc(_t('js.stage.room.leave_title', 'Your cam is on this pad\'s Stage - take it off (this pad can\'t put it back for an hour)')) + '">' + esc(_t('js.stage.room.leave', '🙈 Take me off this Stage')) + '</button>';
      });
      var s = cur();
      if (canAdm() && s) {
        h += '<span class="adm">' + (s.featured ? '<button type="button" data-act="unfeature" data-id="' + esc(s.id) + '">' + esc(_t('js.stage.room.unfeature', '☆ Unfeature')) + '</button>'
                                                : '<button type="button" data-act="feature" data-id="' + esc(s.id) + '">' + esc(_t('js.stage.room.feature', '★ Feature')) + '</button>') +
             '<button type="button" data-act="cut" data-id="' + esc(s.id) + '">' + esc(_t('js.stage.room.cut', '✂ Cut')) + '</button>' +
             (s.cam ? '' : '<button type="button" data-act="cut" data-ban="1" data-id="' + esc(s.id) + '">' + esc(_t('js.stage.room.cut_ban', 'Cut + ban')) + '</button>') + '</span>';
      } else h += pepeAdm();
      box.innerHTML = h;
    }
    if (o.tabs) {
      o.tabs.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.hasAttribute('data-v')) { view = b.getAttribute('data-v'); chosen = true; micWanted = view === 'mic'; show(); return; }
        if (b.hasAttribute('data-pepe-src')) { ownPepe = b.getAttribute('data-pepe-src') === 'own'; show(); return; }
        var act = b.getAttribute('data-act');
        if (!act) return;
        if (act === 'leave') { leave(b); return; }        // stagefix site: 🙈 Take me off this Stage
        if (act === 'pepe-feature' || act === 'pepe-unfeature') { pepeFeature(b, act === 'pepe-feature'); return; }   // dock3 1.99akf
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
    // stagefix site: the person whose cam it is takes it off this pad's Stage (stageleave.js; this pad can't put it back for 1 h)
    function leave(b) {
      if (!confirm(_t('js.stage.room.q_leave', 'Take your cam off this pad\'s Stage? This pad can\'t put it back for an hour.'))) return;
      b.disabled = true;
      fetch('/api/stage/leave', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ slot: b.getAttribute('data-id') }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (j) {
          if (!j || !j.ok) { b.disabled = false; alert((j && j.error) || _t('js.stage.room.e_do', 'Could not do that.')); return; }
          var until = '';
          try { until = new Date(j.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { until = ''; }
          alert(_t('js.stage.room.left', 'You\'re off this pad\'s Stage until {when}.', { when: until }));
          poll();
        })
        .catch(function () { b.disabled = false; alert(_t('js.stage.room.e_net', 'Could not reach the server.')); });
    }
    var dead = false;
    // dock3 review 1.99akf: answers are applied in the order the polls were SENT - an older one that lands after a newer one is dropped (the
    // 10 s poll in flight when ★ Feature is pressed used to land after the action's own poll and move the view back for up to 10 s)
    var pollSeq = 0, pollApplied = 0, winsSeen = featWins(), polledAt = 0;
    function poll() {
      if (dead) return Promise.resolve();
      var seq = ++pollSeq;
      polledAt = Date.now();
      return fetch(o.api, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (g) {
        if (dead) return;
        // dock3 1.99akf: a failed / stale answer (the server's catch: `stale`; a refusal: ok false) moves nothing - it used to read as
        // "nothing is live" and hand the view to the mic stage
        if (!g || typeof g !== 'object' || g.ok === false || g.stale === true) return;
        if (seq < pollApplied) return;                                              // (dock3 review: out of date)
        pollApplied = seq;
        var was = cur(), wasF = featured(), wasW = winsSeen;                        // (dock3 review: as of the last poll - a hold that ran out since counts)
        if (g.front && typeof g.front.slug === 'string' && g.front.slug) lastFront = g.front.slug;   // (dock3: Pepe's ★ on the old homepage)
        if (Number(g.now) > 0) skew = Number(g.now) - Date.now();                   // 1.99ajr golive: where a video slot is (setEmbed)
        if (pepeOn && !g.active) pepeOffAt = Date.now(); else if (g.active) pepeOffAt = 0;   // (dock3 review: the hold on his feature)
        pepeOn = !!g.active;
        pepeWhep = typeof g.whep === 'string' && g.whep ? g.whep : null;            // 1.99fd: ⚡ for Pepe's WHIP stream
        if (typeof g.pepe_here === 'boolean') pepeHere = g.pepe_here;
        var ns = cleanSrc(g.pepe_src);                                              // 1.99fv: an admin switched the source
        if (!ns || !pepeSrc || ns.mode !== pepeSrc.mode || JSON.stringify(ns.embed || null) !== JSON.stringify(pepeSrc.embed || null)) ownPepe = false;
        pepeSrc = ns;
        var fresh = Array.isArray(g.slots) ? g.slots : [], nh = cleanFeat(g.featured);
        // dock3 1.99akf: the featured slot of the last poll, not listed this second while the server still names it featured (it dropped for a
        // moment - /api/stage lists only what is live NOW) - HELD: its tab, the view, the player's reconnecting overlay (the same source is a
        // no-op for the player; a cam slot keeps its session). Dropped as soon as the server stops naming it.
        if (wasF && nh && nh.id === String(wasF.id) && !fresh.some(function (s) { return s && String(s.id) === String(wasF.id); })) {
          var hold = {}; for (var k in wasF) if (Object.prototype.hasOwnProperty.call(wasF, k)) hold[k] = wasF[k];
          hold.featured = true; hold.held = true; fresh = [hold].concat(fresh);
        }
        fresh = withPending(fresh, nh);                                             // upnext: its next title is starting - the card
        featHint = nh; slots = fresh;
        coming = cleanComing(g.coming);                                             // upnext2 (D)
        var f = featured();
        if (was && !cur()) { chosen = false; pickDefault(); }                      // that slot ended / was cut (dock3: the viewer's pick ends with it)
        else if (!chosen && ((f ? f.id : null) !== (wasF ? wasF.id : null) || featWins() !== wasW)) pickDefault();   // featured changed and the viewer never chose
        winsSeen = featWins();
        if (o.onPoll) o.onPoll(g);
        show();
      }).catch(function () {});
    }
    // newstream 1.99ala: the poll follows the tab. Back in view (visibilitychange, a page restored from the back/forward cache, the network back)
    // it asks at once - one call, not a second timer (a background tab came back showing the stage as it was up to a minute before). Hidden, it
    // skips its turn only while the stage plays NOTHING (Pepe's off-air slate, "pick a stream above"): anything playing keeps it as before
    // (review M2 / F1) - the player running (muted too: this poll is what stops an ended slot's player, its m3u8 retries and watch beats), an
    // embed, a 🎬 cam, the 🎙 mic stage, or the stage shown elsewhere (the Dock's picture-in-picture window, the video's own picture-in-picture).
    // A turn right after a poll (wake, an action's own) is skipped (review L4).
    function hiddenNow() { try { return !!(typeof document !== 'undefined' && document.hidden === true); } catch (e) { return false; } }
    function stageBusy() {
      if (embedFor || camCtl || micCtl || view === 'mic') return true;
      try { if (player.running()) return true; } catch (e) { return true; }
      try { var d = o.wrap && o.wrap.ownerDocument; if (d && d !== document) return d.hidden !== true; } catch (e) { return true; }   // (moved to another window)
      return videoAway();
    }
    function justPolled() { var d = Date.now() - polledAt; return d >= 0 && d < 1500; }   // (a clock set back never stops the poll)
    function tickPoll() { if (dead || justPolled() || (hiddenNow() && !stageBusy())) return; poll(); }
    function wake() { if (dead || hiddenNow() || justPolled()) return; poll(); }
    function onPageShow(e) { if (e && e.persisted) wake(); }
    try { if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', wake); } catch (e) { /* old engine */ }
    try { window.addEventListener('pageshow', onPageShow); window.addEventListener('online', wake); } catch (e) { /* old engine */ }
    var POLL_MS = 10000, pollEvery = POLL_MS, pollTimer = setInterval(tickPoll, POLL_MS);
    // (upnext review F5: one poll timer - faster only while a 📼 card is starting, see upSync)
    function pollAt(ms) { if (dead || ms === pollEvery) return; pollEvery = ms; clearInterval(pollTimer); pollTimer = setInterval(tickPoll, ms); }
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
    /** micfollow: the pad page's live long-poll hands over its stage_program (null = mic follows off on this pad). */
    // The live long-poll answers on every chat line / sync (several times a second in a busy room) and hands the program
    // over each time: nothing is redrawn unless it moved - the tab bar (and the owner's ★ / ✂ buttons in it) only when the
    // mic tab itself changes, so focus and clicks there are never lost (pads with mic follows off: never).
    function sigOf(p) {
      if (!p) return '';
      var m = p.manage || null;
      // (wave2 WP-4: + the dynamic template, every holder's ring, a cover's kind / hood / veil / Reveal / ✕ / self flags, and
      // whether the stage bar may offer "Dynamic" - each one repaints the mic stage)
      return JSON.stringify([p.v, p.count, p.pins_n || 0, p.signin, p.blocked, p.active, p.default, p.layout, p.frozen_until, p.speaking || null, !!p.report,
        p.dyn ? [p.dyn.n, p.dyn.t, p.dyn.main] : null,
        (Array.isArray(p.src) ? p.src : []).map(function (s) { return s ? [s.id, s.name, s.video, s.why, s.watch, s.newest, s.pos, !!s.pin, !!s.recent, !!s.mine,
                                                                          !!s.ring, s.kind || null, s.hood == null ? null : s.hood, s.veil || null, s.rv || 0, s.ex || 0, s.self || 0,
                                                                          s.avatar || null, s.ck || null] : null; }),   // 1.99ahq: + the stage cover (a new picture repaints)
        m ? [m.excluded_n, m.unproven_n, m.frozen_until, m.layout_override, m.pins_room, !!m.dyn_ok] : null]);
    }
    function setMic(p) {
      if (!window.PATVStageMic || dead) return;             // WebRTC off: no mic stage on this page
      var wasDef = micDefault();
      mic = p && typeof p === 'object' ? p : null;
      var sig = sigOf(mic);
      if (sig === micSig) return;                           // nothing moved (null -> null, the same program)
      micSig = sig;
      if (micOn()) { micIdleAt = 0; if (micGraceTimer) { clearTimeout(micGraceTimer); micGraceTimer = null; } }
      if (view === 'mic' && !micOn() && micManage()) {
        // mfix staging proof: the owner / staff on the idle mic stage stay there (⋯ Manage, 📌 Pin a cam) - no grace, no jump away
        micIdleAt = 0;
        if (micGraceTimer) { clearTimeout(micGraceTimer); micGraceTimer = null; }
        if (micCtl) micCtl.update(idleProgram());
        o.onAir && o.onAir(true, '🎙');
        if (micTabKey() !== micTabSig) { renderTabs(); if (o.onShow) o.onShow(selection()); }
        return;
      }
      if (view === 'mic' && !micOn()) {
        // mfix: it went idle - keep the view MIC_GRACE_MS ("nobody is on the mic right now"), then back to the default; mic
        // follows switched off on the pad (null) goes at once
        if (mic && !micIdleAt) {
          micIdleAt = Date.now();
          micGraceTimer = setTimeout(function () {
            micGraceTimer = null;
            if (view === 'mic' && !micOn() && !micManage()) { micIdleAt = 0; chosen = false; pickDefault(); show(); }   // (dock3: the page moved them)
          }, MIC_GRACE_MS + 50);
        }
        if (!micGrace()) { micIdleAt = 0; chosen = false; pickDefault(); show(); return; }
        if (micCtl) micCtl.update(idleProgram());
        o.onAir && o.onAir(true, '🎙');
        if (micTabKey() !== micTabSig) { renderTabs(); if (o.onShow) o.onShow(selection()); }
        return;
      }
      // mfix: the viewer picked the 🎙 tab and it came back after the grace: theirs again - dock3 1.99akf: never over a featured stage
      if (micWanted && micOn() && view !== 'mic' && !featWins()) { view = 'mic'; show(); return; }
      if (!chosen && micDefault() !== wasDef) {
        var before = view;
        pickDefault();
        if (before !== view) { show(); return; }
      }
      if (view === 'mic' && micCtl) { micCtl.update(mic); o.onAir && o.onAir(true, '🎙 ' + (mic.count || '') + (pinsN() ? ' 📌' + pinsN() : '')); }
      if (micTabKey() !== micTabSig) {                       // (renderTabs notes what it drew)
        renderTabs();
        if (o.onShow) o.onShow(selection());
      }
    }
    // 1.99ajq dockpol (owner H6): the homepage swaps to a new front pad - this switcher stops for good (its polls, beats, player, mic stage, cam)
    function destroy() {
      dead = true; clearInterval(pollTimer); if (beats) { clearInterval(beats); beats = null; }
      try { if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', wake); } catch (e) { /* gone */ }   // (newstream 1.99ala)
      try { if (typeof window.removeEventListener === 'function') { window.removeEventListener('pageshow', onPageShow); window.removeEventListener('online', wake); } } catch (e) { /* gone */ }
      if (micGraceTimer) { clearTimeout(micGraceTimer); micGraceTimer = null; }
      upSync(); try { upHide(true); } catch (e) { /* gone */ }      // (upnext: its timers and card)
      if (l3Tick) { clearInterval(l3Tick); l3Tick = null; } try { l3Off(); slateOff(); } catch (e) { /* gone */ }   // (upnext2)
      if (stvT) { clearTimeout(stvT); stvT = null; }
      try { micStop(); } catch (e) { /* gone */ } try { camStop(); } catch (e) { /* gone */ }
      try { player.stop(); } catch (e) { /* gone */ } try { setEmbed(null); } catch (e) { /* gone */ }
    }
    return { poll: poll, show: show, view: function () { return view; }, selection: selection, setMic: setMic, destroy: destroy, watchLive: watchLive, stv: stv };
  }
  window.PATVStage = window.PATVStage || {};
  window.PATVStage.switcher = switcher;
  window.PATVStage.embedUrl = embedUrl;
})();
