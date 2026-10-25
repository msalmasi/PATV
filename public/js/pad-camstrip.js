// pad-camstrip.js — 📌 the cam strip on a pad's live room (1.99zc; livecam.js on the server, pad-livecam.js = the popover).
// The cam popover shows ONE cam at a time; "📌 Pin to strip" there moves a cam here, where a viewer keeps up to their live-cam
// slots (1, or 4 with a Season Pass - the same slots the popover uses; the server counts them) side by side. Each tile: the
// cam live over WebRTC (muted - a cam has no sound; the room's audio is the 🔊 button), its name, ⚡ LIVE, ⤢ bigger, ✕ (frees
// the slot at once). Stills / previews never count. A cam that ends says why and offers ↻ Retry.
// The strip is remembered per pad in this browser (localStorage, wrapped: blocked storage = not remembered) and comes back
// after a reload: fresh tickets are asked for each remembered cam, up to the viewer's slots.
//
//   var strip = PATVCamStrip.init(host, slug, {audioHost})     host = views/partials/cam-strip.ejs's #rmStrip
//   strip.update(info)         the live view's room.livecams (null = live cams off here) - every poll
//   strip.add(who) / strip.adopt(who, {sess, stream})    pin a cam (adopt = the popover hands over a cam already playing)
//   strip.has(login) / strip.full() / strip.focus(login)
// The page beats every 15 s per tile (the server drops a slot without beats after 45 s). All text via textContent.
// mfix review: a tile whose connection drops after it played is watched again while the site still says the cam is connecting /
// live ("reconnecting…") - a few times, then "the live cam stopped" with ↻ Retry.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var BEAT_MS = 15000, KEEP = 8;
  var REWATCH_MAX = 4, REWATCH_WIN_MS = 3 * 60 * 1000;   // mfix review: re-watches after a dropped connection (rewatch)
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function post(url, body, keep) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', keepalive: !!keep, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function why(code, msg) {
    return window.PATVLiveCam && PATVLiveCam.why ? PATVLiveCam.why(code, msg) : (msg || _t('js.pad.live.err_failed', 'Pepe couldn\'t open their cam live - try again in a bit.'));
  }
  function load(key) {
    try { var a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a.filter(function (x) { return x && typeof x.login === 'string' && /^[\w.\-$]{1,40}$/.test(x.login); }).slice(0, KEEP) : []; }
    catch (e) { return []; }
  }
  function save(key, tiles) {
    try { localStorage.setItem(key, JSON.stringify(tiles.map(function (t) { return { login: t.login, display: String(t.display || t.login).slice(0, 60) }; }))); } catch (e) { /* not remembered */ }
  }

  function init(host, slug, opts) {
    opts = opts || {};
    var api = { update: function () {}, add: function () { return false; }, adopt: function () { return false; }, has: function () { return false; },
                full: function () { return true; }, focus: function () {}, count: function () { return 0; } };
    if (!host) return api;
    var KEY = 'patv.camstrip.' + slug;
    var base = '/api/rooms/' + encodeURIComponent(slug) + '/livecam';
    var info = null, restored = false, tiles = [], saved = load(KEY);
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
    function remember() { save(KEY, tiles); }
    function find(login) { login = String(login || '').toLowerCase(); for (var i = 0; i < tiles.length; i++) if (tiles[i].login === login) return tiles[i]; return null; }

    function tile(who) {
      var t = { login: String(who.login).toLowerCase(), display: who.display || who.login, state: 'new', gen: 0, sess: null, beat: null };
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
      function say(text, canRetry) { over.hidden = !text && tap.hidden; msg.textContent = text || ''; retry.hidden = !canRetry; }
      t.ended = function (code, m) {
        t.gen++; clearInterval(t.beat); t.beat = null;
        if (t.sess) { try { t.sess.close(); } catch (e) { /* gone */ } t.sess = null; }
        try { v.srcObject = null; } catch (e) { /* gone */ }
        t.state = 'ended'; badge.textContent = _t('js.pad.strip.off', 'off'); badge.classList.remove('on');
        tap.hidden = true; say(why(code, m), true); paint();
      };
      t.stop = function (tell, keep) {
        t.gen++; clearInterval(t.beat); t.beat = null;
        if (t.sess) { try { t.sess.close(); } catch (e) { /* gone */ } t.sess = null; }
        try { v.srcObject = null; } catch (e) { /* gone */ }
        if (tell && t.state !== 'ended') post(base + '/stop', { login: t.login }, keep).catch(function () {});
        t.state = 'ended';
      };
      function beats(my) {
        clearInterval(t.beat);
        t.beat = setInterval(function () {
          post(base + '/beat', { login: t.login }).then(function (k) {
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
        ss.onfail = function () { if (my === t.gen) rewatch(my); };
        paint();
      }
      // mfix review: the connection dropped after it played (Pepe re-opened the relay, its publisher restarted): while the site
      // still says the cam is connecting / live, watch again with a fresh ticket (the same slot) - at most REWATCH_MAX times in
      // REWATCH_WIN_MS, then the tile's "the live cam stopped" with ↻ Retry
      function rewatch(my) {
        var t0 = Date.now();
        t.rew = (t.rew || []).filter(function (x) { return t0 - x < REWATCH_WIN_MS; });
        if (t.rew.length >= REWATCH_MAX) return t.ended('gone');
        t.rew.push(t0);
        if (t.sess) { try { t.sess.close(); } catch (e) { /* gone */ } t.sess = null; }
        t.state = 'connecting'; badge.textContent = _t('js.pad.live.reconnecting', 'reconnecting…'); badge.classList.remove('on'); paint();
        post(base + '/beat', { login: t.login }).then(function (k) {
          if (my !== t.gen) return null;
          if (!k || k.ok === false) return t.ended(k && k.code, k && k.error);
          if (k.state === 'ended') return t.ended(k.why);
          return post(base, { login: t.login }).then(function (d) {
            if (my !== t.gen) return null;
            if (!d || !d.ok || !d.whep) return t.ended(d && d.code, d && d.error);
            return PATVRtc.watch(d.whep, v, { timeout: 40000, cancelled: function () { return my !== t.gen; } }).then(function (ss) {
              if (my !== t.gen) { ss.close(); return; }
              playing(ss, my);
            }, function (e) { if (my === t.gen && !(e && e.cancelled)) t.ended('gone'); });
          });
        }).catch(function () { if (my === t.gen) t.ended('gone'); });
      }
      t.start = function () {
        var my = ++t.gen;
        t.rew = [];
        t.state = 'asking'; badge.textContent = _t('js.pad.live.connecting', 'connecting…'); badge.classList.remove('on'); tap.hidden = true; say('', false);
        if (!window.RTCPeerConnection || !window.PATVRtc || !PATVRtc.watch) return t.ended('browser', _t('js.pad.live.err_browser', 'This browser can\'t play live cams.'));
        post(base, { login: t.login }).then(function (d) {
          if (my !== t.gen) return;
          if (!d || !d.ok) return t.ended(d && d.code, d && d.error);
          if (d.slots && info && info.slots) { info.slots.used = d.slots.used; info.slots.max = d.slots.max; }
          t.state = 'connecting'; paint();
          beats(my);
          return PATVRtc.watch(d.whep, v, { timeout: 40000, cancelled: function () { return my !== t.gen; } }).then(function (ss) {
            if (my !== t.gen) { ss.close(); return; }
            playing(ss, my);
          }, function (e) {
            if (my !== t.gen || (e && e.cancelled)) return;
            post(base + '/beat', { login: t.login }).then(function (k) { if (my === t.gen) t.ended(k && k.state === 'ended' ? k.why : 'failed'); },
              function () { if (my === t.gen) t.ended('failed'); });
            post(base + '/stop', { login: t.login }).catch(function () {});
          });
        }).catch(function () { if (my === t.gen) t.ended('net', _t('js.pad.snap.unreachable', 'Couldn\'t reach the site.')); });
      };
      // the popover hands over a cam that's already playing: same slot on the server, so nothing is asked again
      t.take = function (h) {
        var my = ++t.gen;
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
    function put(who) {
      var t = tile(who);
      tiles.push(t); row.appendChild(t.el);
      remember(); paint();
      if (host.scrollIntoView && !opts.quiet) { try { host.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* old engine */ } }
      if (opts.onChange) { try { opts.onChange(); } catch (e) { /* page's own */ } }
      return t;
    }

    api.has = function (login) { return !!find(login); };
    api.count = function () { return tiles.length; };
    api.full = function () { var m = slots(); return !m || liveTiles() >= m; };
    api.focus = function (login) { var t = find(login); if (t && t.el.scrollIntoView) { try { t.el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } catch (e) { t.el.scrollIntoView(); } } };
    api.add = function (who) {
      if (!who || !who.login) return false;
      var t = find(who.login);
      if (t) { if (t.state === 'ended') t.start(); api.focus(who.login); return true; }
      if (!info || info.signin) return false;
      if (api.full()) { note.textContent = why('viewer_cap'); return false; }
      put(who).start();
      return true;
    };
    api.adopt = function (who, h) {
      if (!who || !who.login || !h || !h.sess) return false;
      var t = find(who.login);
      if (!t) t = put(who);
      t.take(h);
      return true;
    };
    api.update = function (inf) {
      info = inf ? { on: !!inf.on, signin: !!inf.signin, slots: inf.slots ? { used: inf.slots.used, max: inf.slots.max } : null, sp_max: inf.sp_max || null } : null;
      if (!info) { tiles.forEach(function (t) { if (t.state !== 'ended') t.ended('off'); }); paint(); return; }
      // restore the remembered strip once, up to the viewer's slots (the rest wait as "off" tiles with ↻ Retry)
      if (!restored && !info.signin) {
        restored = true;
        var room = slots();
        saved.forEach(function (w) {
          if (find(w.login)) return;
          var t = put(w);
          if (room > 0) { room--; t.start(); } else t.ended('viewer_cap');
        });
        saved = [];
      }
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
      wasLive = tiles.filter(function (t) { return t.state !== 'ended'; });
      tiles.forEach(function (t) { t.stop(true, true); });
    });
    window.addEventListener('pageshow', function (e) { if (e && e.persisted) wasLive.forEach(function (t) { if (tiles.indexOf(t) >= 0) t.start(); }); wasLive = []; });
    paint();
    return api;
  }
  window.PATVCamStrip = { init: init };
})();
