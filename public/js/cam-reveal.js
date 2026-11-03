// cam-reveal.js — 1.99aid (privacy controls S4): "👁 View cam (logged)" - a moderator views a cam someone has hidden from the website
// (camreveal.js on the server; livecam.js reveal sessions). Loaded on demand (PATVCamRevealLoad in pad-livecam.js) the first time a
// page shows a control for it - a page with cam reveals off never loads it.
//
//   PATVCamReveal.open({slug, tile | member | login, name, admin?: true})    {slug, ask: true} (1.99aid round 3 - F4): by a typed login
//     1. asks why (at least 3 characters - logged with the view) and says the person is told unless the viewer is in 👻 ghost mode;
//     2. POST /api/rooms/<slug>/livecam/reveal (admin: /api/admin/pepe/livecams/reveal {room, login}) -> a WebRTC ticket;
//     3. plays it in a dialog: BLURRED until the viewer clicks it (a shared screen shows nothing by accident), the watermark "Only you
//        can see this · logged", the time left of the 3 minutes, "Extend (logged)" (a new reason, a new row) and Close - no controls,
//        no picture-in-picture, no download, no right-click menu; admins and the pad's owner get "Save still / clip (evidence)";
//     4. beats every 15 s (the server re-checks the right, the pad and that the cam is still hidden) and stops on the answer's why.
// All text via textContent.
(function () {
  'use strict';
  if (window.PATVCamReveal) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var BEAT_MS = 15000;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text) { var b = el('button', cls, text); b.type = 'button'; return b; }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  var styled = false;
  function style() {
    if (styled) return;
    styled = true;
    var s = document.createElement('style');
    s.textContent = '.cr-ov{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.cr-box{background:var(--card,#141a22);color:var(--text,#e8edf3);border-radius:12px;max-width:560px;width:100%;padding:14px 16px;box-shadow:0 10px 40px rgba(0,0,0,.5)}' +
      '.cr-box h3{margin:0 0 6px;font-size:1.05rem}.cr-box p{margin:6px 0;font-size:.9rem;opacity:.9}.cr-box input{width:100%;box-sizing:border-box;padding:6px 8px;margin:6px 0}' +
      '.cr-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.cr-wrap{position:relative;background:#000;border-radius:8px;overflow:hidden;aspect-ratio:4/3}' +
      '.cr-wrap video{width:100%;height:100%;object-fit:contain;filter:blur(28px)}.cr-wrap.shown video{filter:none}' +
      '.cr-blur{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);color:#fff;border:0;font-size:.95rem;cursor:pointer}' +
      '.cr-wrap.shown .cr-blur{display:none}.cr-mark{position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.6);color:#fff;font-size:.75rem;padding:2px 6px;border-radius:4px;pointer-events:none}' +
      '.cr-left{position:absolute;right:8px;top:8px;background:rgba(0,0,0,.6);color:#fff;font-size:.75rem;padding:2px 6px;border-radius:4px;pointer-events:none}' +
      '.cr-res{min-height:1.2em;font-size:.85rem;margin-top:6px}.cr-res.bad{color:#ff9b9b}.cr-res.ok{color:#9be3a7}';
    document.head.appendChild(s);
  }
  function why(code, fallback) {
    switch (code) {
      case 'time_up': return _t('js.camrv.e_time', 'Your 3 minutes are up - open it again if you still need to (it\'s logged again).');
      case 'visible': return _t('js.camrv.e_visible', 'Their cam isn\'t hidden from you - use ▶ Live.');
      case 'lost_right': case 'forbidden': return _t('js.camrv.e_right', 'You can\'t view hidden cams here.');
      case 'left_out': case 'gone': return _t('js.camrv.e_gone', 'They aren\'t here any more.');
      case 'not_on_cam': return _t('js.camrv.e_offcam', 'They aren\'t on cam.');
      case 'no_video': case 'start_timeout': case 'open_failed': case 'relay_lost': return _t('js.camrv.e_video', 'Pepe couldn\'t show their cam - try again in a bit.');
      case 'room_off': case 'switched_off': case 'off': return _t('js.camrv.e_off', 'Viewing hidden cams isn\'t on here right now.');
      case 'pad_access': return _t('js.pad.live.err_pad', 'This pad\'s live room is for its approved members.');
      case 'nopepe': return _t('js.pad.live.err_pepe', 'Pepe can\'t do live cams right now.');
      case 'stopped': return _t('js.camrv.closed', 'Closed.');
      default: return fallback || _t('js.camrv.e_failed', 'Couldn\'t open it - try again in a bit.');
    }
  }
  var cur = null;
  function close() { if (cur) { var c = cur; cur = null; c.close(); } }
  function overlay(title) {
    style();
    close();
    var ov = el('div', 'cr-ov'), box = el('div', 'cr-box');
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', title);
    box.appendChild(el('h3', null, title));
    ov.appendChild(box);
    document.body.appendChild(ov);
    return { ov: ov, box: box };
  }
  /** Step 1: why (logged), then the ticket. 1.99aid (privacy controls, round 3 - F4): {slug, ask: true} = "View a cam by Camfrog login" on
   *  the pad page - the moderator types the login too (the by-login entry: someone the people list doesn't show, e.g. left out). */
  function open(o) {
    if (!o || !o.slug && !o.admin) return;
    var name = o.name || _t('js.stage.mf.cover_someone', 'someone');
    var d = overlay(o.ask ? _t('js.camrv.login_title', '👁 View a cam by Camfrog login (logged)') : _t('js.camrv.title', '👁 {name} - moderation view', { name: name }));
    var who = null;
    if (o.ask) {
      d.box.appendChild(el('p', null, _t('js.camrv.login_intro', 'For a report that names a login - someone in this room the people list doesn\'t show you. It shows nothing you didn\'t type: no frog name, no profile. Only you see it, for 3 minutes, and it\'s logged with your reason.')));
      var wl = el('label', null, _t('js.camrv.login', 'Camfrog login'));
      who = el('input'); who.type = 'text'; who.maxLength = 40; who.autocomplete = 'off'; who.spellcheck = false;
      wl.appendChild(who); d.box.appendChild(wl);
    } else d.box.appendChild(el('p', null, _t('js.camrv.intro', 'Their cam is hidden from the website. You can view it for moderation: only you see it, for 3 minutes, and it\'s logged with your reason.')));
    d.box.appendChild(el('p', null, _t('js.camrv.told', 'They\'re told that someone moderating this pad viewed their cam (never who) - unless you\'re in 👻 ghost mode.')));
    var lab = el('label', null, _t('js.camrv.reason', 'Why? (logged)'));
    var inp = el('input'); inp.type = 'text'; inp.maxLength = 200; inp.autocomplete = 'off';
    lab.appendChild(inp); d.box.appendChild(lab);
    var acts = el('div', 'cr-acts'), go = btn('live', _t('js.camrv.view', '👁 View cam (logged)')), no = btn(null, _t('js.camrv.cancel', 'Cancel'));
    acts.appendChild(go); acts.appendChild(no); d.box.appendChild(acts);
    var res = el('div', 'cr-res'); res.setAttribute('role', 'status'); d.box.appendChild(res);
    var gone = false;
    cur = { close: function () { if (gone) return; gone = true; d.ov.remove(); } };
    no.addEventListener('click', close);
    go.addEventListener('click', function () {
      var reason = String(inp.value || '').trim();
      var typed = who ? String(who.value || '').trim().replace(/^@/, '') : '';
      if (who && !/^[\w.\-]{1,40}$/.test(typed)) { res.className = 'cr-res bad'; res.textContent = _t('js.camrv.need_login', 'Type their Camfrog login.'); return; }
      if (reason.length < 3) { res.className = 'cr-res bad'; res.textContent = _t('js.camrv.need_reason', 'Say why (at least 3 characters) - it\'s logged.'); return; }
      go.disabled = true; res.className = 'cr-res'; res.textContent = _t('js.camrv.asking', 'Asking Pepe to open it…');
      var body = { reason: reason }, url;
      if (o.admin) { url = '/api/admin/pepe/livecams/reveal'; body.room = o.room; body.login = o.login; }
      else if (who) { url = '/api/rooms/' + encodeURIComponent(o.slug) + '/livecam/reveal'; body.login = typed; body.bylogin = true; name = typed; }
      else {
        url = '/api/rooms/' + encodeURIComponent(o.slug) + '/livecam/reveal';
        if (o.tile) body.tile = o.tile; else if (o.member) body.member = o.member; else body.login = o.login;
      }
      post(url, body).then(function (a) {
        if (!a || !a.ok) { go.disabled = false; res.className = 'cr-res bad'; res.textContent = why(a && a.code, a && a.error); return; }
        play(o.admin ? a.slug : o.slug, a, name, reason);
      }).catch(function () { go.disabled = false; res.className = 'cr-res bad'; res.textContent = _t('js.pad.snap.unreachable', 'Couldn\'t reach the site.'); });
    });
    setTimeout(function () { try { (who || inp).focus(); } catch (e) { /* none */ } }, 0);
  }
  function mmss(ms) { var s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  /** Step 2: the player. */
  function play(slug, a, name0, reason) {
    var name = a.name || name0;
    var d = overlay(_t('js.camrv.title', '👁 {name} - moderation view', { name: name }));
    var base = '/api/rooms/' + encodeURIComponent(slug) + '/livecam/reveal';
    var wrap = el('div', 'cr-wrap'), v = el('video');
    v.autoplay = true; v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.controls = false;
    v.disablePictureInPicture = true; v.setAttribute('disablepictureinpicture', ''); v.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback');
    v.setAttribute('aria-label', _t('js.camrv.aria', '{name}\'s cam, a moderation view', { name: name }));
    v.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    var blur = btn('cr-blur', _t('js.camrv.unblur', 'Blurred - click to show (only on your screen)'));
    blur.addEventListener('click', function () { wrap.classList.add('shown'); });
    var mark = el('span', 'cr-mark', _t('js.camrv.mark', 'Only you can see this · logged'));
    var left = el('span', 'cr-left', '');
    wrap.appendChild(v); wrap.appendChild(blur); wrap.appendChild(mark); wrap.appendChild(left);
    d.box.appendChild(wrap);
    if (a.ghost) d.box.appendChild(el('p', null, _t('js.camrv.ghost', '👻 ghost mode - they aren\'t told (it\'s still logged).')));
    var res = el('div', 'cr-res', _t('js.pad.live.connecting', 'connecting…')); res.setAttribute('role', 'status'); res.setAttribute('aria-live', 'polite');
    var acts = el('div', 'cr-acts'), ext = btn(null, _t('js.camrv.extend', 'Extend (logged)')), x = btn(null, _t('js.camrv.close', 'Close'));
    acts.appendChild(ext);
    var evs = [];
    if (a.can_save) {
      evs.push(btn(null, _t('js.camrv.ev_still', '📷 Save still (evidence)')), btn(null, _t('js.camrv.ev_clip', '🎬 Save 15 s clip (evidence)')));
      evs.forEach(function (b) { acts.appendChild(b); });
    }
    acts.appendChild(x);
    d.box.appendChild(acts); d.box.appendChild(res);
    var until = Number(a.until) || Date.now() + 180000, sess = null, beatT = null, tickT = null, done = false;
    function say(text, cls) { res.className = 'cr-res' + (cls ? ' ' + cls : ''); res.textContent = text || ''; }
    function end(code, msg, tell) {
      if (done) return;
      done = true;
      clearInterval(beatT); clearInterval(tickT);
      if (sess) { try { sess.close(); } catch (e) { /* gone */ } sess = null; }
      try { v.srcObject = null; } catch (e) { /* gone */ }
      wrap.classList.remove('shown');
      ext.disabled = true; evs.forEach(function (b) { b.disabled = true; });
      if (tell) post(base + '/stop', { rv: a.rv }).catch(function () {});
      say(why(code, msg), code === 'stopped' ? '' : 'bad');
    }
    cur = { close: function () { end('stopped', null, true); d.ov.remove(); } };
    x.addEventListener('click', close);
    tickT = setInterval(function () { left.textContent = _t('js.camrv.left', '{t} left', { t: mmss(until - Date.now()) }); }, 1000);
    beatT = setInterval(function () {
      post(base + '/beat', { rv: a.rv }).then(function (k) {
        if (done) return;
        if (!k || k.ok === false) return end(k && k.code, k && k.error, false);
        if (k.state === 'ended') return end(k.why, null, false);
        if (k.until) until = Number(k.until);
        if (k.state === 'live') say('');
      }).catch(function () { /* a blip: the next beat */ });
    }, BEAT_MS);
    ext.addEventListener('click', function () {
      var r = window.prompt(_t('js.camrv.extend_q', 'Another 3 minutes - why? (logged)'), reason || '');
      if (r == null) return;
      ext.disabled = true;
      post(base + '/extend', { rv: a.rv, reason: r }).then(function (k) {
        ext.disabled = false;
        if (k && k.ok) { until = Number(k.until) || until; reason = r; say(_t('js.camrv.extended', 'Extended - logged.'), 'ok'); }
        else say(why(k && k.code, k && k.error), 'bad');
      }).catch(function () { ext.disabled = false; say(_t('js.pad.snap.unreachable', 'Couldn\'t reach the site.'), 'bad'); });
    });
    evs.forEach(function (b, i) {
      b.addEventListener('click', function () {
        var r = window.prompt(_t('js.camrv.ev_q', 'Saved as moderation evidence for 30 days (never posted; logged). Why?'), reason || '');
        if (r == null) return;
        evs.forEach(function (z) { z.disabled = true; });
        say(i ? _t('js.camrv.ev_recording', 'Recording 15 s…') : _t('js.camrv.ev_taking', 'Taking a still…'));
        post(base + '/evidence', { rv: a.rv, kind: i ? 'clip' : 'still', secs: 15, reason: r }).then(function (k) {
          evs.forEach(function (z) { z.disabled = done; });
          say(k && k.ok ? _t('js.camrv.ev_saved', 'Saved as evidence (kept 30 days).') : why(k && k.code, k && k.error), k && k.ok ? 'ok' : 'bad');
        }).catch(function () { evs.forEach(function (z) { z.disabled = done; }); say(_t('js.pad.snap.unreachable', 'Couldn\'t reach the site.'), 'bad'); });
      });
    });
    if (!window.RTCPeerConnection || !window.PATVRtc || !PATVRtc.watch) return end('failed', _t('js.pad.live.err_browser', 'This browser can\'t play live cams.'), true);
    PATVRtc.watch(a.whep, v, { timeout: 40000, cancelled: function () { return done; } }).then(function (ss) {
      if (done) { try { ss.close(); } catch (e) { /* gone */ } return; }
      sess = ss; say('');
    }, function (e) { if (!done && !(e && e.cancelled)) end('no_video', null, true); });
  }
  window.PATVCamReveal = { open: open, play: play, why: why };
})();
