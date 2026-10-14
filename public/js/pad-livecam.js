// pad-livecam.js — 📡 "▶ Live" on the pad's cam popover (1.99yh; livecam.js on the server, camfrog-bot pepe_livecam.py).
// The still preview stays as it is; this adds a button that asks for the cam LIVE (WebRTC, about a second behind) and
// plays it in the popover with a ⚡ LIVE badge, "connecting…", the reason when it can't, and ✕ to stop (which frees
// the viewer's live-cam slot at once). A cam has no sound of its own: the room's audio player is offered next to it.
//
//   PATVLiveCam.row(box, slug, who, info, {audioHost, onStart}) -> {stop()}   info = the live view's room.livecams
// The page beats every 15 s while watching (the server drops a slot without beats after 45 s). All text via textContent.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var BEAT_MS = 15000;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function why(code, fallback) {
    switch (code) {
      case 'signin': return _t('js.pad.live.err_signin', 'Sign in to watch cams live.');
      case 'pad_access': return _t('js.pad.live.err_pad', 'This pad\'s live room is for its approved members.');
      case 'opted_out': return _t('js.pad.live.err_optout', 'They\'ve switched off live video of their cam.');
      case 'not_on_cam': return _t('js.pad.live.err_offcam', 'They aren\'t on cam.');
      case 'viewer_cap': return _t('js.pad.live.err_cap', 'You\'re already watching as many live cams as you can - stop one first.');
      case 'slots_busy': return _t('js.pad.live.err_busy', 'All live cam slots are busy - try again in a bit.');
      case 'budget': return _t('js.pad.live.err_budget', 'Live cams are full right now - try again in a bit.');
      case 'nopepe': return _t('js.pad.live.err_pepe', 'Pepe can\'t do live cams right now.');
      case 'room_off': case 'off': return _t('js.pad.live.err_off', 'Live cams aren\'t on in this room.');
      case 'ended_by': case 'ended_by_admin': return _t('js.pad.live.err_ended', 'Their live cam was ended.');
      case 'cam_closed': return _t('js.pad.live.err_closed', 'Their cam closed.');
      case 'unwatched': case 'gone': return _t('js.pad.live.err_gone', 'The live cam stopped.');
      case 'switched_off': return _t('js.pad.live.err_off', 'Live cams aren\'t on in this room.');
      default: return fallback || _t('js.pad.live.err_failed', 'Pepe couldn\'t open their cam live - try again in a bit.');
    }
  }
  function row(box, slug, who, info, opts) {
    opts = opts || {};
    var ctl = { stop: function () {} };
    if (!info || !who || !who.login) return ctl;
    var acts = el('div', 'acts livecam'), res = el('div', 'res'), stage = el('div', 'lc-stage');
    res.setAttribute('role', 'status'); res.setAttribute('aria-live', 'polite');
    var b = el('button', 'live', _t('js.pad.live.btn', '▶ Live')); b.type = 'button';
    var base = '/api/rooms/' + encodeURIComponent(slug) + '/livecam';
    if (info.signin) {
      b.disabled = true; b.title = _t('js.pad.live.err_signin', 'Sign in to watch cams live.');
      acts.appendChild(b); box.appendChild(acts); return ctl;
    }
    var s = info.slots || { used: 0, max: 1 };
    var watchingThis = (info.watching || []).indexOf(String(who.login).toLowerCase()) >= 0;
    var left = Math.max(0, (s.max || 0) - (s.used || 0));
    var hint = el('span', 'lc-slots', _t('js.pad.live.slots', '{n} of {max} live slots free', { n: left, max: s.max || 0 }));
    b.title = _t('js.pad.live.title', 'Watch {name}\'s cam live (about a second behind the room)', { name: who.display || who.login });
    if (!left && !watchingThis) { b.disabled = true; res.textContent = why('viewer_cap'); }
    acts.appendChild(b); acts.appendChild(hint);
    box.appendChild(acts); box.appendChild(stage); box.appendChild(res);
    var sess = null, beatT = null, gen = 0, video = null;
    function say(text, cls) { res.className = 'res' + (cls ? ' ' + cls : ''); res.textContent = text || ''; }
    function teardown(tell) {
      gen++;
      clearInterval(beatT); beatT = null;
      if (sess) { try { sess.close(); } catch (e) { /* gone */ } sess = null; }
      if (video) { try { video.srcObject = null; } catch (e) { /* gone */ } }
      stage.textContent = ''; video = null;
      box.classList.remove('lc-on');
      if (tell) post(base + '/stop', { login: who.login }).catch(function () {});
    }
    function ended(code, msg) {
      teardown(false);
      b.disabled = false; b.textContent = _t('js.pad.live.btn', '▶ Live');
      say(why(code, msg), 'bad');
    }
    function audioOffer() {
      var host = opts.audioHost, ab = host ? host.querySelector('.rb-audio') : null;
      if (!ab || ab.classList.contains('hide') || ab.classList.contains('off') || ab.classList.contains('on')) return null;
      var a = el('button', 'lc-audio', _t('js.pad.live.audio', '🔊 Hear the room')); a.type = 'button';
      a.title = _t('js.pad.live.audio_title', 'A cam has no sound of its own - this plays the room\'s audio');
      a.addEventListener('click', function () { var p = ab.querySelector('.rb-play'); if (p) p.click(); a.remove(); });
      return a;
    }
    function start() {
      var my = ++gen;
      b.disabled = true; say(_t('js.pad.live.asking', 'Asking Pepe to go live…'));
      post(base, { login: who.login }).then(function (d) {
        if (my !== gen) return;
        if (!d || !d.ok) { b.disabled = false; return say(why(d && d.code, d && d.error), 'bad'); }
        if (!window.PATVRtc || !PATVRtc.watch) { b.disabled = false; post(base + '/stop', { login: who.login }); return say(_t('js.pad.live.err_browser', 'This browser can\'t play live cams.'), 'bad'); }
        if (d.slots) hint.textContent = _t('js.pad.live.slots', '{n} of {max} live slots free', { n: Math.max(0, d.slots.max - d.slots.used), max: d.slots.max });
        box.classList.add('lc-on');
        if (opts.onStart) { try { opts.onStart(); } catch (e) { /* page's own */ } }
        var wrap = el('div', 'lc-wrap');
        video = el('video'); video.autoplay = true; video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
        video.setAttribute('aria-label', _t('js.pad.live.aria', '{name}\'s cam, live', { name: who.display || who.login }));
        var badge = el('span', 'lc-badge', _t('js.pad.live.connecting', 'connecting…'));
        var x = el('button', 'lc-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', _t('js.pad.live.stop', 'Stop the live cam'));
        x.addEventListener('click', function () { teardown(true); b.disabled = false; b.textContent = _t('js.pad.live.btn', '▶ Live'); say(_t('js.pad.live.stopped', 'Stopped - your slot is free again.')); });
        wrap.appendChild(video); wrap.appendChild(badge); wrap.appendChild(x);
        stage.appendChild(wrap);
        var offer = audioOffer();
        if (offer) stage.appendChild(offer);
        b.textContent = _t('js.pad.live.btn_on', '⚡ Live'); say('');
        beatT = setInterval(function () {
          post(base + '/beat', { login: who.login }).then(function (k) {
            if (my !== gen) return;
            if (k && k.ok === false) return ended(k.code, k.error);
            if (k && k.state === 'ended') return ended(k.why);
          }).catch(function () { /* a blip: the next beat */ });
        }, BEAT_MS);
        PATVRtc.watch(d.whep, video, { timeout: 40000, cancelled: function () { return my !== gen; } }).then(function (ss) {
          if (my !== gen) { ss.close(); return; }
          sess = ss;
          badge.textContent = _t('js.pad.live.badge', '⚡ LIVE'); badge.classList.add('on');
          ss.onfail = function () { if (my === gen) ended('gone'); };
        }, function (e) {
          if (my !== gen || (e && e.cancelled)) return;
          post(base + '/beat', { login: who.login }).then(function (k) { if (my === gen) ended(k && k.state === 'ended' ? k.why : 'failed'); },
            function () { if (my === gen) ended('failed'); });
          post(base + '/stop', { login: who.login }).catch(function () {});
        });
      }).catch(function () { if (my === gen) { b.disabled = false; say(_t('js.pad.snap.unreachable', 'Couldn\'t reach the site.'), 'bad'); } });
    }
    b.addEventListener('click', function () { if (!sess && !beatT) start(); });
    ctl.stop = function () { if (sess || beatT) teardown(true); };
    window.addEventListener('pagehide', ctl.stop);
    return ctl;
  }
  window.PATVLiveCam = { row: row };
})();
