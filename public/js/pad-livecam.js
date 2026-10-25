// pad-livecam.js — 📡 "▶ Live" on the pad's cam popover (1.99yh; livecam.js on the server, camfrog-bot pepe_livecam.py).
// The still preview stays as it is; this adds a button that asks for the cam LIVE (WebRTC, about a second behind) and
// plays it in the popover with a ⚡ LIVE badge, "connecting…", the reason when it can't, and ✕ to stop (which frees
// the viewer's live-cam slot at once). A cam has no sound of its own: the room's audio player is offered next to it.
//
//   PATVLiveCam.row(box, slug, who, info, {audioHost, onStart, strip, onPin, stage}) -> {stop()}   info = the live view's room.livecams
// 1.99zc: strip = the page's cam strip (pad-camstrip.js): "📌 Pin to strip" moves the cam there - a cam already playing is
//   HANDED OVER (same slot, same connection, nothing asked again); one that isn't starts in the strip. A cam that's in the
//   strip shows "📌 In the strip" here instead of a second player. onPin() = the page closes the popover.
//   stage = {slug} for the pad's owner / staff: "🎬 Put on stage" makes the cam a stage slot (mainstage camOpen).
// PATVLiveCam.why(code, fallback) = the reason text (the strip and the stage use it too).
// The page beats every 15 s while watching (the server drops a slot without beats after 45 s). All text via textContent.
// mfix review: a connection that drops after it played (Pepe re-opened the relay, its publisher restarted) is watched again
// while the site still says the cam is connecting / live ("reconnecting…") - a few times, then "the live cam stopped".
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var BEAT_MS = 15000;
  var REWATCH_MAX = 4, REWATCH_WIN_MS = 3 * 60 * 1000;   // mfix review: re-watches after a dropped connection (see rewatch)
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
      case 'unavailable': return _t('js.pad.live.err_unavailable', 'That cam isn\'t available right now.');
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
    // 1.99aaf: 👻 staff in ghost mode see it on every cam popover (snapshots / clips / live tell the owner nothing - audited)
    if (info.ghost) box.appendChild(el('div', 'lc-ghost', _t('js.pad.live.ghost', '👻 ghost - the owner isn\'t told (logged for admins)')));
    var s = info.slots || { used: 0, max: 1 };
    var strip = opts.strip || null;
    if (strip && strip.has(who.login)) {                    // 1.99zc: it's playing in the strip already - one player per cam
      var inS = el('button', 'live', _t('js.pad.strip.in', '📌 In the strip')); inS.type = 'button';
      inS.addEventListener('click', function () { strip.focus(who.login); if (opts.onPin) opts.onPin(); });
      acts.appendChild(inS); stageBtn(acts); box.appendChild(acts); box.appendChild(res); return ctl;
    }
    var watchingThis = (info.watching || []).indexOf(String(who.login).toLowerCase()) >= 0;
    var left = Math.max(0, (s.max || 0) - (s.used || 0));
    var hint = el('span', 'lc-slots', _t('js.pad.live.slots', '{n} of {max} live slots free', { n: left, max: s.max || 0 }));
    b.title = _t('js.pad.live.title', 'Watch {name}\'s cam live (about a second behind the room)', { name: who.display || who.login });
    if (!left && !watchingThis) { b.disabled = true; res.textContent = why('viewer_cap'); }
    acts.appendChild(b);
    var pin = null;
    if (strip) {                                             // 1.99zc: 📌 Pin to strip
      pin = el('button', 'live pin', _t('js.pad.strip.pin', '📌 Pin to strip')); pin.type = 'button';
      pin.title = _t('js.pad.strip.pin_title', 'Keep {name}\'s cam playing in the strip under the stage - watch several cams at once', { name: who.display || who.login });
      if (!left && !watchingThis) pin.disabled = true;
      acts.appendChild(pin);
    }
    acts.appendChild(hint);
    stageBtn(acts);
    box.appendChild(acts); box.appendChild(stage); box.appendChild(res);
    var sess = null, beatT = null, gen = 0, video = null, rew = [];
    function say(text, cls) { res.className = 'res' + (cls ? ' ' + cls : ''); res.textContent = text || ''; }
    // 1.99zc: 🎬 the pad's owner / staff put this cam on the pad's stage (a cam slot - same consent rules as ▶ Live)
    function stageBtn(into) {
      if (!opts.stage || !opts.stage.slug) return;
      var sb = el('button', 'live onstage', _t('js.pad.strip.stage', '🎬 Put on stage')); sb.type = 'button';
      sb.title = _t('js.pad.strip.stage_title', 'Show {name}\'s live cam on this pad\'s stage (they are told; it ends when they leave cam or switch live video off)', { name: who.display || who.login });
      sb.addEventListener('click', function () {
        if (!confirm(_t('js.pad.strip.stage_q', 'Put {name}\'s cam on the stage? It takes one of the pad\'s stage slots.', { name: who.display || who.login }))) return;
        sb.disabled = true;
        post('/api/rooms/' + encodeURIComponent(opts.stage.slug) + '/stage/cam', { login: who.login }).then(function (d) {
          sb.disabled = false;
          // stagefix final round (stagepin.js): their level may turn the pin into an ask - it goes up once they say yes
          say(d && d.ok ? (d.asked ? _t('js.pad.strip.stage_asked', 'Asked them - it goes on the stage once they say yes (they have 10 minutes).')
                                   : _t('js.pad.strip.staged', 'On the stage now - it shows in the stage\'s tabs.')) : why(d && d.code, d && d.error), d && d.ok ? 'ok' : 'bad');
        }).catch(function () { sb.disabled = false; say(_t('js.pad.snap.unreachable', 'Couldn\'t reach the site.'), 'bad'); });
      });
      into.appendChild(sb);
    }
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
      // 1.99zc: no WebRTC here (iOS Lockdown Mode, an old / embedded browser) - say so before taking a slot
      if (!window.RTCPeerConnection) return say(_t('js.pad.live.err_browser', 'This browser can\'t play live cams.'), 'bad');
      var my = ++gen;
      rew = [];
      b.disabled = true; say(_t('js.pad.live.asking', 'Asking Pepe to go live…'));
      post(base, { login: who.login }).then(function (d) {
        if (my !== gen) return;
        if (!d || !d.ok) {
          b.disabled = false;
          say(why(d && d.code, d && d.error), 'bad');
          if (d && (d.can_ask || d.pending)) askUi(!!d.pending);            // 1.99aar: members / followers / on request - ask the owner
          return;
        }
        if (!window.RTCPeerConnection || !window.PATVRtc || !PATVRtc.watch) { b.disabled = false; post(base + '/stop', { login: who.login }); return say(_t('js.pad.live.err_browser', 'This browser can\'t play live cams.'), 'bad'); }
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
        function playing(ss) {
          sess = ss;
          badge.textContent = _t('js.pad.live.badge', '⚡ LIVE'); badge.classList.add('on');
          ss.onfail = function () { if (my === gen) rewatch(); };
        }
        // mfix review: the connection dropped after it played (Pepe re-opened the relay - e.g. by the exact name for a pad's mic
        // stage - or its publisher restarted): while the site still says the cam is connecting / live, watch again with a fresh
        // ticket (the same slot) - at most REWATCH_MAX times in REWATCH_WIN_MS, then "the live cam stopped"
        function rewatch() {
          var t0 = Date.now();
          rew = rew.filter(function (x) { return t0 - x < REWATCH_WIN_MS; });
          if (rew.length >= REWATCH_MAX) return ended('gone');
          rew.push(t0);
          if (sess) { try { sess.close(); } catch (e) { /* gone */ } sess = null; }
          badge.textContent = _t('js.pad.live.reconnecting', 'reconnecting…'); badge.classList.remove('on');
          post(base + '/beat', { login: who.login }).then(function (k) {
            if (my !== gen) return null;
            if (!k || k.ok === false) return ended(k && k.code, k && k.error);
            if (k.state === 'ended') return ended(k.why);
            return post(base, { login: who.login }).then(function (d2) {
              if (my !== gen) return null;
              if (!d2 || !d2.ok || !d2.whep) return ended(d2 && d2.code, d2 && d2.error);
              return PATVRtc.watch(d2.whep, video, { timeout: 40000, cancelled: function () { return my !== gen; } }).then(function (ss) {
                if (my !== gen) { ss.close(); return; }
                playing(ss);
              }, function (e) { if (my === gen && !(e && e.cancelled)) ended('gone'); });
            });
          }).catch(function () { if (my === gen) ended('gone'); });
        }
        PATVRtc.watch(d.whep, video, { timeout: 40000, cancelled: function () { return my !== gen; } }).then(function (ss) {
          if (my !== gen) { ss.close(); return; }
          playing(ss);
        }, function (e) {
          if (my !== gen || (e && e.cancelled)) return;
          post(base + '/beat', { login: who.login }).then(function (k) { if (my === gen) ended(k && k.state === 'ended' ? k.why : 'failed'); },
            function () { if (my === gen) ended('failed'); });
          post(base + '/stop', { login: who.login }).catch(function () {});
        });
      }).catch(function () { if (my === gen) { b.disabled = false; say(_t('js.pad.snap.unreachable', 'Couldn\'t reach the site.'), 'bad'); } });
    }
    // 1.99aar: 🙋 Ask to watch (camaccess.js): the owner is PM'd in Camfrog + told in their inbox; this waits for the answer
    // (up to 10 minutes) and starts the cam by itself on a yes.
    var askB = null, askT = null;
    function askStop() { clearInterval(askT); askT = null; }
    function askWait() {
      askStop();
      var until = Date.now() + 10 * 60 * 1000;
      askT = setInterval(function () {
        if (Date.now() > until) { askStop(); if (askB) { askB.disabled = false; askB.textContent = _t('js.pad.live.ask', '🙋 Ask to watch'); } return say(_t('js.pad.live.ask_none', 'No answer yet - you can ask again.')); }
        fetch(base + '/ask?login=' + encodeURIComponent(who.login), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (k) {
            if (!k || !k.ok) return;
            if (k.state === 'allowed') { askStop(); if (askB) { askB.remove(); askB = null; } say(_t('js.pad.live.ask_yes', 'They said yes!'), 'ok'); start(); }
            else if (k.state === 'no') { askStop(); if (askB) askB.remove(); askB = null; say(_t('js.pad.live.ask_no', 'They said no.'), 'bad'); }
          }).catch(function () { /* the next poll */ });
      }, 5000);
    }
    function askUi(pending) {
      if (!askB) {
        askB = el('button', 'live ask', ''); askB.type = 'button';
        askB.addEventListener('click', function () {
          askB.disabled = true;
          post(base + '/ask', { login: who.login }).then(function (k) {
            if (k && k.ok && k.allowed) { askB.remove(); askB = null; return start(); }
            if (!k || !k.ok) { askB.disabled = false; return say((k && k.error) || _t('js.pad.live.ask_fail', 'Couldn’t ask - try again in a bit.'), 'bad'); }
            askB.textContent = _t('js.pad.live.asked', '⏳ Asked - waiting');
            say(_t('js.pad.live.ask_sent', 'Asked - they’re told in Camfrog. This starts by itself if they say yes.'));
            askWait();
          }).catch(function () { askB.disabled = false; say(_t('js.pad.snap.unreachable', 'Couldn\'t reach the site.'), 'bad'); });
        });
        acts.insertBefore(askB, b.nextSibling);
      }
      if (pending) { askB.disabled = true; askB.textContent = _t('js.pad.live.asked', '⏳ Asked - waiting'); askWait(); }
      else { askB.disabled = false; askB.textContent = _t('js.pad.live.ask', '🙋 Ask to watch'); }
    }
    b.addEventListener('click', function () { if (!sess && !beatT) start(); });
    if (pin) {
      pin.addEventListener('click', function () {
        var ok;
        if (sess && video && video.srcObject) {               // playing: hand the connection + the slot over as they are
          var h = { sess: sess, stream: video.srcObject, blocked: !!sess.blocked };
          gen++; clearInterval(beatT); beatT = null; sess = null;
          try { video.srcObject = null; } catch (e) { /* gone */ }
          stage.textContent = ''; video = null; box.classList.remove('lc-on');
          ok = strip.adopt(who, h);
        } else {
          if (beatT) teardown(false);                         // still connecting: the strip asks again (same slot - no /stop)
          ok = strip.add(who);
        }
        if (ok) { if (opts.onPin) opts.onPin(); }
        else say(why('viewer_cap'), 'bad');
      });
    }
    ctl.stop = function () { askStop(); if (sess || beatT) teardown(true); };
    window.addEventListener('pagehide', ctl.stop);
    return ctl;
  }
  window.PATVLiveCam = { row: row, why: why };
})();
