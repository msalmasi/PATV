// pad-camstrip.js — 📌 the cam strip on a pad's live room (1.99zc; livecam.js on the server, pad-livecam.js = the popover).
// The cam popover shows ONE cam at a time; "📌 Pin to strip" there moves a cam here, where a viewer keeps up to their live-cam
// slots (1, or 4 with a Season Pass - the same slots the popover uses; the server counts them) side by side. Each tile: the
// cam live over WebRTC (muted - a cam has no sound; the room's audio is the 🔊 button), its name, ⚡ LIVE, ⤢ bigger, ✕ (frees
// the slot at once). Stills / previews never count. A cam that ends says why and offers ↻ Retry.
// The strip is remembered per pad and account in this browser (localStorage, wrapped: blocked storage = not remembered) and comes back
// after a reload: fresh tickets are asked for each remembered cam, up to the viewer's slots.
//
//   var strip = PATVCamStrip.init(host, slug, {audioHost})     host = views/partials/cam-strip.ejs's #rmStrip
//   strip.update(info)         the live view's room.livecams (null = live cams off here) - every poll
//   strip.add(who) / strip.adopt(who, {sess, stream})    pin a cam (adopt = the popover hands over a cam already playing)
//   strip.has(key) / strip.full() / strip.focus(key)      key = the login (lower case) - or a frog-name cam's opaque id
// 1.99aid (privacy controls, round 3 - F2; owner Q4: every cam feature works for an incognito person's cam under the frog name): a
//   frog-name cam ({id: "v-…", alias} - the people list's entry, never a login) is pinned by its id: its tile shows the frog name,
//   asks / beats / stops by {id} and is remembered as {id, display}; once that frog-name session ends the id opens nothing.
// The page beats every 15 s per tile (the server drops a slot without beats after 45 s). All text via textContent.
// mfix review: a tile whose connection drops after it played is watched again while the site still says the cam is connecting /
// live ("reconnecting…") - a few times, then "the live cam stopped" with ↻ Retry.
// pubswitch (owner 2026-11-05: Players Lounge "lost the room dock layout" for him signed in, through reloads, a sign-out and the pad's
//   level switch, until he cleared the site's data): every broken load restored a remembered pin while the page was still being read,
//   and the page's own start-up (its deferred scripts, the Room Dock's DOMContentLoaded start) came 16-61 s late or never - even on a
//   load whose restore was refused at once (22:41:58Z: not_on_cam, nothing connected), so it was the tile made while the page was read,
//   not the cam's connect. How that held the page up is not reproduced (no failing test for the stall itself). So:
//   - remembered cams come back only after the page has finished loading (window load, or DOMContentLoaded + SETTLE_MS - always after
//     DOMContentLoaded itself, never on a bare timer while deferred scripts still run) and without scrolling the page to the strip;
//   - a page with remembered cams reports its start-up once (POST <base>/boot: DOMContentLoaded / load times, whether the restore ran -
//     at the restore, or at pagehide when it never did), numbers only, so a recurrence can be proven from the site's log;
//   - a remembered cam that ends for a reason about THE CAM (FORGET_ON: left cam, opted out, ended, no access, the relay never came up,
//     this browser can't play it...) is forgotten: it stays on the page as an "off" tile with ↻ Retry but the next load doesn't start
//     it again. Anything else - a full strip, capacity, Pepe away or offline, a site restart's "unwatched", a deploy's 502, beats that
//     lapsed (an iPhone in the background), a relay restart, a network blip, a code this page doesn't know - keeps it remembered;
//   - the memory is per ACCOUNT (opts.viewer, the partial's signed-in viewer): another account signed in on this browser never
//     gets the first one's cams; the old per-browser key (patv.camstrip.<slug>) is dropped the first time a viewer's page loads.
//     The key's tag is a hash of the username - not a secret (it can be matched against usernames): the first page after a sign-out
//     drops every patv.camstrip.* key of the browser (partials/chat-sweep.ejs);
//   - a pin made while the page loads keeps the remembered cams not brought back yet, and the restore reads the memory when it runs
//     (another tab of the pad may have changed it meanwhile).
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var BEAT_MS = 15000, KEEP = 8, SETTLE_MS = 4000;
  // (pubswitch review) why a tile ended that FORGETS it: about this cam - they left cam / closed it / opted out / are unavailable or went
  // incognito, it was ended, no access to it or this pad's live room, Pepe couldn't open it, the relay never came up / never had a frame,
  // the watch failed with the site answering, this browser can't play it. Any other end (or none, or one this page doesn't know) keeps it.
  var FORGET_ON = { not_on_cam: 1, cam_closed: 1, opted_out: 1, unavailable: 1, veil_changed: 1, ended_by: 1, ended_by_admin: 1, blocked: 1,
                    pad_access: 1, open_failed: 1, not_that_cam: 1, spawn_failed: 1, start_timeout: 1, no_video: 1, failed: 1, browser: 1 };
  var REWATCH_MAX = 4, REWATCH_WIN_MS = 3 * 60 * 1000;   // mfix review: re-watches after a dropped connection (rewatch)
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function post(url, body, keep) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: !!keep, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function why(code, msg) {
    return window.PATVLiveCam && PATVLiveCam.why ? PATVLiveCam.why(code, msg) : (msg || _t('js.pad.live.err_failed', 'Pepe couldn\'t open their cam live - try again in a bit.'));
  }
  var FROG_RE = /^v-[A-Za-z0-9_-]{12}$/;
  /** 1.99aid (round 3 - F2): a frog-name cam's opaque id (no login) - else null */
  function frogId(w) { return w && !w.login && typeof w.id === 'string' && FROG_RE.test(w.id) ? w.id : null; }
  /** a cam's key in the strip: its login (lower case), or a frog-name cam's id (as it is - ids are case-sensitive) */
  function keyOf(w) { if (!w) return null; var f = frogId(w); return f || (typeof w.login === 'string' && w.login ? String(w.login).toLowerCase() : null); }
  function normKey(k) { k = String(k == null ? '' : k); return FROG_RE.test(k) ? k : k.toLowerCase(); }
  function load(key) {
    try { var a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return x && ((typeof x.login === 'string' && /^[\w.\-$]{1,40}$/.test(x.login)) || frogId(x)); }).slice(0, KEEP) : []; }
    catch (e) { return []; }
  }
  function save(key, tiles) {
    tiles = tiles.filter(function (t) { return !t.forget; });          // (pubswitch: a cam that ended isn't brought back)
    try { localStorage.setItem(key, JSON.stringify(tiles.map(function (t) { return t.id ? { id: t.id, display: String(t.display || '').slice(0, 60) } : { login: t.login, display: String(t.display || t.login).slice(0, 60) }; }))); } catch (e) { /* not remembered */ }
  }
  /** pubswitch: a short tag of the signed-in viewer for the storage key (keeps the memory per account; a hash of the username, not a
   *  secret - the sign-out sweep drops these keys) */
  function viewerTag(v) {
    var s = String(v).toLowerCase(), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  // pubswitch review: has the page's DOMContentLoaded fired? (readyState 'interactive' comes BEFORE it - deferred scripts still run then)
  var DCL = false;
  try {
    if (window.document && window.document.readyState === 'complete') DCL = true;
    else if (window.document && window.document.addEventListener) window.document.addEventListener('DOMContentLoaded', function () { DCL = true; });
  } catch (e) { /* no document */ }
  function navTiming() {
    try { var P = window.performance; return P && P.getEntriesByType ? P.getEntriesByType('navigation')[0] || null : null; } catch (e) { return null; }
  }
  function dclFired() {
    if (DCL || window.document.readyState === 'complete') return true;
    var n = navTiming();
    return !!(n && n.domContentLoadedEventEnd > 0);          // (this script read after it: the page's own timing says)
  }
  /** pubswitch: fn(via) once the page has finished loading (its own start-up first) - at once ('now') where there is no loading page;
   *  'load' = the window's load event, 'timer' = DOMContentLoaded + SETTLE_MS (the load event can wait on a slow picture or the
   *  stage's stream) - never before DOMContentLoaded itself */
  function settled(fn) {
    var D = window.document;
    if (!D || typeof D.readyState !== 'string' || D.readyState === 'complete') return fn('now');
    var done = false;
    function go(via) { if (done) return; done = true; setTimeout(function () { fn(via); }, 0); }
    window.addEventListener('load', function () { go('load'); });
    function arm() { setTimeout(function () { go('timer'); }, SETTLE_MS); }
    if (dclFired()) arm(); else if (D.addEventListener) D.addEventListener('DOMContentLoaded', arm);
  }

  function init(host, slug, opts) {
    opts = opts || {};
    var api = { update: function () {}, add: function () { return false; }, adopt: function () { return false; }, has: function () { return false; },
                full: function () { return true; }, focus: function () {}, count: function () { return 0; } };
    if (!host) return api;
    var KEY = 'patv.camstrip.' + slug;
    if (opts.viewer) {          // (pubswitch: per account; the old per-browser memory may be anyone's who used this browser - dropped)
      try { localStorage.removeItem(KEY); } catch (e) { /* blocked storage */ }
      KEY += '.' + viewerTag(opts.viewer);
    }
    var base = '/api/rooms/' + encodeURIComponent(slug) + '/livecam';
    // (restored: the restore is scheduled; ran: it has run - until then `pending` holds the remembered cams not on screen yet)
    var info = null, restored = false, ran = false, tiles = [], pending = load(KEY), reported = false;
    var head = el('div', 'cs-head'), title = el('h2', 'cs-title'), count = el('span', 'cs-count'), acts = el('span', 'cs-acts');
    title.appendChild(el('span', null, _t('js.pad.strip.title', '📌 Cam strip'))); title.appendChild(count);
    var hear = el('button', 'cs-btn cs-hear', _t('js.pad.live.audio', '🔊 Hear the room')); hear.type = 'button';
    hear.title = _t('js.pad.live.audio_title', 'A cam has no sound of its own - this plays the room\'s audio');
    var clear = el('button', 'cs-btn cs-clear', _t('js.pad.strip.clear', 'Close all')); clear.type = 'button';
    acts.appendChild(hear); acts.appendChild(clear);
    head.appendChild(title); head.appendChild(acts);
    var row = el('div', 'cs-row'); row.setAttribute('role', 'list');
    var note = el('p', 'cs-note'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
    host.appendChild(head); host.appendChild(row); host.appendChild(note);

    // the room's audio player (room-bridge.js) - opts.audioHost may be a function: it can come later in the page
    function audioBox() { var h = typeof opts.audioHost === 'function' ? opts.audioHost() : opts.audioHost; return h && h.querySelector ? h.querySelector('.rb-audio') : null; }
    function slots() { var s = info && info.slots ? info.slots : null; return s ? Math.max(0, Number(s.max) || 0) : 0; }
    function liveTiles() { return tiles.filter(function (t) { return t.state !== 'ended'; }).length; }
    function paint() {
      host.hidden = !tiles.length;
      count.textContent = info && info.slots ? ' · ' + _t('js.pad.strip.count', '{n} of {max} live', { n: liveTiles(), max: slots() }) : '';
      var ab = audioBox();
      hear.hidden = !ab || ab.classList.contains('hide') || ab.classList.contains('off') || ab.classList.contains('on');
      host.classList.toggle('cs-many', tiles.length > 1);
    }
    // (pubswitch review: until the restore has run, the remembered cams not brought back yet are kept too - a pin made while the page
    // loads never wipes them; one already a tile here, ended or not, is the tile's to keep or forget)
    function remember() {
      var keep = tiles.filter(function (t) { return !t.forget; }).map(function (t) { return { id: t.id, login: t.login, display: t.display }; });
      if (!ran) pending.forEach(function (w) { if (!find(keyOf(w))) keep.push({ id: frogId(w), login: frogId(w) ? null : String(w.login).toLowerCase(), display: w.display }); });
      save(KEY, keep.slice(0, KEEP));
    }
    /** pubswitch review (C2): the one start-up report of a page with remembered cams (numbers only - no login, no cam) */
    function report(didRun, via, n) {
      if (reported || !opts.viewer || !n) return;
      reported = true;
      var nav = navTiming(), ms = function (v) { v = Math.round(Number(v) || 0); return v > 0 ? v : -1; }, at = -1;
      try { at = window.performance && window.performance.now ? Math.round(window.performance.now()) : -1; } catch (e) { at = -1; }
      post(base + '/boot', { ran: didRun ? 1 : 0, via: via, n: n, dcl: ms(nav && nav.domContentLoadedEventStart), load: ms(nav && nav.loadEventStart), at: at }, true)
        .catch(function () { /* only a report */ });
    }
    function find(key) { key = normKey(key); for (var i = 0; i < tiles.length; i++) if (tiles[i].key === key) return tiles[i]; return null; }

    function tile(who) {
      var fid = frogId(who);
      var t = { key: keyOf(who), login: fid ? null : String(who.login).toLowerCase(), id: fid,
                display: fid ? (who.alias || who.display || _t('js.stage.mf.cover_someone', 'someone')) : (who.display || who.login),
                state: 'new', gen: 0, sess: null, beat: null };
      t.ref = fid ? { id: fid } : { login: t.login };          // (1.99aid round 3 - F2: a frog-name cam by its id, never a login)
      var li = el('div', 'cs-tile'); li.setAttribute('role', 'listitem');
      var vw = el('div', 'cs-vid');
      var v = el('video'); v.muted = true; v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
      v.setAttribute('aria-label', _t('js.pad.live.aria', '{name}\'s cam, live', { name: t.display }));
      var badge = el('span', 'cs-badge', _t('js.pad.live.connecting', 'connecting…'));
      var name = el('span', 'cs-name', t.display);
      var big = el('button', 'cs-ic cs-big', '⤢'); big.type = 'button'; big.setAttribute('aria-label', _t('js.pad.strip.bigger', 'Make it bigger')); big.setAttribute('aria-pressed', 'false');
      var x = el('button', 'cs-ic cs-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', _t('js.pad.strip.close', 'Close {name}\'s cam (frees the slot)', { name: t.display }));
      var msg = el('div', 'cs-msg'); var retry = el('button', 'cs-btn cs-retry', _t('js.pad.strip.retry', '↻ Retry')); retry.type = 'button';
      var tap = el('button', 'cs-btn cs-tap', _t('js.pad.strip.tap', '▶ Tap to play')); tap.type = 'button'; tap.hidden = true;
      var over = el('div', 'cs-over'); over.appendChild(msg); over.appendChild(retry); over.appendChild(tap); over.hidden = true;
      vw.appendChild(v); vw.appendChild(badge); vw.appendChild(big); vw.appendChild(x); vw.appendChild(over);
      li.appendChild(vw); li.appendChild(name);
      t.el = li; t.video = v;
      li._who = t.ref;          // 1.99ajf dockclean: the Room Dock's tile ⋯ › 📷 Cam options finds the person by it (a login, or the frog cam's id)
      function say(text, canRetry) { over.hidden = !text && tap.hidden; msg.textContent = text || ''; retry.hidden = !canRetry; }
      t.ended = function (code, m) {
        t.gen++; clearInterval(t.beat); t.beat = null;
        if (t.sess) { try { t.sess.close(); } catch (e) { /* gone */ } t.sess = null; }
        try { v.srcObject = null; } catch (e) { /* gone */ }
        t.state = 'ended'; badge.textContent = _t('js.pad.strip.off', 'off'); badge.classList.remove('on');
        tap.hidden = true; say(why(code, m), true);
        // pubswitch: a cam that ended for a reason about the cam isn't started again by the next page load (↻ Retry here still can)
        if (FORGET_ON[code] && !t.forget) { t.forget = true; remember(); }
        paint();
      };
      t.stop = function (tell, keep) {
        t.gen++; clearInterval(t.beat); t.beat = null;
        if (t.sess) { try { t.sess.close(); } catch (e) { /* gone */ } t.sess = null; }
        try { v.srcObject = null; } catch (e) { /* gone */ }
        if (tell && t.state !== 'ended') post(base + '/stop', t.ref, keep).catch(function () {});
        t.state = 'ended';
      };
      function beats(my) {
        clearInterval(t.beat);
        t.beat = setInterval(function () {
          post(base + '/beat', t.ref).then(function (k) {
            if (my !== t.gen) return;
            if (k && k.ok === false) return t.ended(k.code, k.error);
            if (k && k.state === 'ended') return t.ended(k.why);
            if (k && k.state === 'live' && t.sess) { badge.textContent = _t('js.pad.live.badge', '⚡ LIVE'); badge.classList.add('on'); }
          }).catch(function () { /* a blip: the next beat */ });
        }, BEAT_MS);
      }
      function playing(ss, my) {
        t.sess = ss; t.state = 'live';
        badge.textContent = _t('js.pad.live.badge', '⚡ LIVE'); badge.classList.add('on');
        tap.hidden = !ss.blocked; say('', false); over.hidden = tap.hidden;
        ss.onfail = function () { if (my === t.gen) rewatch(my, ss); };
        paint();
      }
      // mfix review: the connection dropped after it played (Pepe re-opened the relay, its publisher restarted): while the site
      // still says the cam is connecting / live, watch again with a fresh ticket (the same slot) - at most REWATCH_MAX times in
      // REWATCH_WIN_MS, then the tile's "the live cam stopped" with ↻ Retry. camstutter review: a session the server ended after
      // 20 s+ of playing (its relay re-published - fast_end) is a free reconnect (PATVRtc.freeRewatch)
      function rewatch(my, was) {
        var t0 = Date.now();
        t.rew = (t.rew || []).filter(function (x) { return t0 - x < REWATCH_WIN_MS; });
        if (!(was && window.PATVRtc && PATVRtc.freeRewatch && PATVRtc.freeRewatch(was))) {
          if (t.rew.length >= REWATCH_MAX) return t.ended('gone');
          t.rew.push(t0);
        }
        if (t.sess) { try { t.sess.close(); } catch (e) { /* gone */ } t.sess = null; }
        t.state = 'connecting'; badge.textContent = _t('js.pad.live.reconnecting', 'reconnecting…'); badge.classList.remove('on'); paint();
        post(base + '/beat', t.ref).then(function (k) {
          if (my !== t.gen) return null;
          if (!k || k.ok === false) return t.ended(k && k.code, k && k.error);
          if (k.state === 'ended') return t.ended(k.why);
          return post(base, t.ref).then(function (d) {
            if (my !== t.gen) return null;
            if (!d || !d.ok || !d.whep) return t.ended(d && d.code, d && d.error);
            return PATVRtc.watch(d.whep, v, { timeout: 40000, fastEnd: d.fast_end === true, cancelled: function () { return my !== t.gen; } }).then(function (ss) {
              if (my !== t.gen) { ss.close(); return; }
              playing(ss, my);
            }, function (e) { if (my === t.gen && !(e && e.cancelled)) t.ended('gone'); });
          });
        }).catch(function () { if (my === t.gen) t.ended('gone'); });
      }
      t.start = function () {
        var my = ++t.gen;
        t.rew = [];
        if (t.forget) { t.forget = false; remember(); }          // (pubswitch: ↻ Retry - remembered again)
        t.state = 'asking'; badge.textContent = _t('js.pad.live.connecting', 'connecting…'); badge.classList.remove('on'); tap.hidden = true; say('', false);
        if (!window.RTCPeerConnection || !window.PATVRtc || !PATVRtc.watch) return t.ended('browser', _t('js.pad.live.err_browser', 'This browser can\'t play live cams.'));
        post(base, t.ref).then(function (d) {
          if (my !== t.gen) return;
          if (!d || !d.ok) return t.ended(d && d.code, d && d.error);
          if (d.slots && info && info.slots) { info.slots.used = d.slots.used; info.slots.max = d.slots.max; }
          t.state = 'connecting'; paint();
          beats(my);
          // camstutter: fastEnd - the server ending the session (the relay re-published) reconnects at once (webrtc-client.js)
          return PATVRtc.watch(d.whep, v, { timeout: 40000, fastEnd: d.fast_end === true, cancelled: function () { return my !== t.gen; } }).then(function (ss) {
            if (my !== t.gen) { ss.close(); return; }
            playing(ss, my);
          }, function (e) {
            if (my !== t.gen || (e && e.cancelled)) return;
            // (pubswitch review: the site unreachable too = a network blip, not the cam - 'net' keeps it remembered)
            post(base + '/beat', t.ref).then(function (k) { if (my === t.gen) t.ended(k && k.state === 'ended' ? k.why : 'failed'); },
              function () { if (my === t.gen) t.ended('net', _t('js.pad.snap.unreachable', 'Couldn\'t reach the site.')); });
            post(base + '/stop', t.ref).catch(function () {});
          });
        }).catch(function () { if (my === t.gen) t.ended('net', _t('js.pad.snap.unreachable', 'Couldn\'t reach the site.')); });
      };
      // the popover hands over a cam that's already playing: same slot on the server, so nothing is asked again
      t.take = function (h) {
        var my = ++t.gen;
        if (t.forget) { t.forget = false; remember(); }          // (pubswitch review C5: playing again on this tile - remembered again)
        try { v.srcObject = h.stream; var p = v.play(); if (p && p.catch) p.catch(function () { tap.hidden = false; over.hidden = false; }); } catch (e) { /* the next beat says */ }
        beats(my);
        playing(h.sess, my);
        if (h.blocked) { tap.hidden = false; over.hidden = false; }
      };
      retry.addEventListener('click', function () { if (!api.full() || t.state !== 'ended') t.start(); else { say(why('viewer_cap'), true); } });
      tap.addEventListener('click', function () { var p = v.play(); if (p && p.then) p.then(function () { tap.hidden = true; over.hidden = true; }, function () {}); });
      x.addEventListener('click', function () { remove(t, true); });
      big.addEventListener('click', function () {
        var on = !li.classList.contains('big');
        tiles.forEach(function (o) { o.el.classList.remove('big'); var b = o.el.querySelector('.cs-big'); if (b) b.setAttribute('aria-pressed', 'false'); });
        li.classList.toggle('big', on); big.setAttribute('aria-pressed', on ? 'true' : 'false');
        big.setAttribute('aria-label', on ? _t('js.pad.strip.smaller', 'Back to the strip') : _t('js.pad.strip.bigger', 'Make it bigger'));
        if (on && li.scrollIntoView) { try { li.scrollIntoView({ block: 'nearest', inline: 'start', behavior: 'smooth' }); } catch (e) { li.scrollIntoView(); } }
      });
      return t;
    }
    function remove(t, tell) {
      t.stop(tell);
      if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
      tiles = tiles.filter(function (o) { return o !== t; });
      if (tell && info && info.slots && info.slots.used > 0) info.slots.used--;
      note.textContent = tell ? _t('js.pad.live.stopped', 'Stopped - your slot is free again.') : '';
      remember(); paint();
      if (opts.onChange) { try { opts.onChange(); } catch (e) { /* page's own */ } }
    }
    function put(who, restoring) {
      var t = tile(who);
      tiles.push(t); row.appendChild(t.el);
      remember(); paint();
      // (pubswitch: a strip coming back after a reload never scrolls the page - only a pin the viewer just made does)
      if (host.scrollIntoView && !opts.quiet && !restoring) { try { host.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* old engine */ } }
      if (opts.onChange) { try { opts.onChange(); } catch (e) { /* page's own */ } }
      return t;
    }

    api.has = function (key) { return !!find(key); };
    api.count = function () { return tiles.length; };
    api.full = function () { var m = slots(); return !m || liveTiles() >= m; };
    api.focus = function (key) { var t = find(key); if (t && t.el.scrollIntoView) { try { t.el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } catch (e) { t.el.scrollIntoView(); } } };
    api.add = function (who) {
      var k = keyOf(who);
      if (!k) return false;
      var t = find(k);
      if (t) { if (t.state === 'ended') t.start(); api.focus(k); return true; }
      if (!info || info.signin) return false;
      if (api.full()) { note.textContent = why('viewer_cap'); return false; }
      put(who).start();
      return true;
    };
    api.adopt = function (who, h) {
      if (!keyOf(who) || !h || !h.sess) return false;
      var t = find(keyOf(who));
      if (!t) t = put(who);
      t.take(h);
      return true;
    };
    function restore(via) {
      if (!info || info.signin) { restored = false; return; }      // (live cams went off meanwhile: the next live view tries again)
      // (pubswitch review C6: the memory as it is NOW - another tab of this pad and account may have closed or pinned one meanwhile;
      // what this page wrote while loading is in it too)
      var list = load(KEY).filter(function (w) { return !find(keyOf(w)); });
      ran = true; pending = [];
      report(true, via, list.length);
      var room = Math.max(0, slots() - liveTiles());                // (a pin made while the page loaded holds a slot already)
      list.forEach(function (w) {
        var t = put(w, true);
        if (room > 0) { room--; t.start(); } else t.ended('viewer_cap');
      });
      paint();
    }
    api.update = function (inf) {
      info = inf ? { on: !!inf.on, signin: !!inf.signin, slots: inf.slots ? { used: inf.slots.used, max: inf.slots.max } : null, sp_max: inf.sp_max || null } : null;
      if (!info) { tiles.forEach(function (t) { if (t.state !== 'ended') t.ended('off'); }); paint(); return; }
      // restore the remembered strip once, up to the viewer's slots (the rest wait as "off" tiles with ↻ Retry) - pubswitch: once the
      // page has loaded (a cam that can't start must never hold up the page's own start-up)
      if (!restored && !info.signin) { restored = true; settled(restore); }
      var m = slots();
      if (m && info.sp_max && m < info.sp_max && tiles.length && api.full()) note.textContent = _t('js.pad.strip.more', 'A Season Pass lets you watch up to {n} cams at once.', { n: info.sp_max });
      paint();
    };
    hear.addEventListener('click', function () {
      var ab = audioBox(), p = ab ? ab.querySelector('.rb-play') : null;
      if (p) p.click();
      paint();
    });
    clear.addEventListener('click', function () { tiles.slice().forEach(function (t) { remove(t, true); }); note.textContent = ''; });
    // leaving frees the slots at once (keepalive); a page restored from the back-forward cache starts them again
    var wasLive = [];
    window.addEventListener('pagehide', function () {
      // (pubswitch review C2: left with remembered cams the restore never brought back - what prod's stalled loads did: the report)
      if (!ran && pending.length) report(false, restored ? 'hide' : 'noview', pending.length);
      wasLive = tiles.filter(function (t) { return t.state !== 'ended'; });
      tiles.forEach(function (t) { t.stop(true, true); });
    });
    window.addEventListener('pageshow', function (e) { if (e && e.persisted) wasLive.forEach(function (t) { if (tiles.indexOf(t) >= 0) t.start(); }); wasLive = []; });
    paint();
    return api;
  }
  window.PATVCamStrip = { init: init };
})();
