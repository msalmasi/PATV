// stage-mic.js — 🎙 "On the mic": the pad stage's mic-follows view (micfollow.js on the server). Whoever holds the pad's
// Camfrog mic is on it; several people at once are shown together. The layout is drawn HERE from one WebRTC (WHEP)
// stream per cam - nothing is mixed or re-encoded on a server:
//   single  one tile                       split  two side by side
//   grid4   2 x 2                          grid9  3 x 3 (empty cells stay black - the "Brady Bunch" look)
//   pip     the newest speaker fills the stage, the one before in a corner inset
// The newest speaker is highlighted (a green ring + "newest speaker" for screen readers). A tile without live video is a
// still (a snapshot every few seconds, "📷 still") or a name card with the reason (cam off, starting, live cams full,
// members only, not available). Each live tile asks POST /api/rooms/<slug>/micfollow/watch for a ticket of its own, plays
// it with PATVRtc.watch (muted: the room's sound is the 🔊 room audio) and beats every 15 s; a tile that leaves closes its
// session. After 30 s in a hidden tab every session closes and stills stop polling; they come back when the tab does. The player box keeps its
// 16:9 size whatever the layout, so the page never moves. Owners / staff (program.manage) get a bar ABOVE the tiles (it
// never covers one): ⋯ Manage (❄ freeze, the layout for this session, ✕ to keep someone off the mic stage 1 h / 24 h /
// always) and 🧹 Clear the stage (everyone off now, frozen). Signed-in viewers get ⚑ on each tile (on narrow grids, in a
// bar above them): a reason, and the tile hides for them at once (program.report). While the mic is held only by people
// nobody can show - or Pepe alone - the stage shows a neutral card (program.speaking: "Someone is speaking" / Pepe's card),
// never the last speaker's face. All text via textContent.
// mfix (owner 2026-10-25): a speaker who let go of the mic stays up a while (a recent tile - no ring); 📌 pinned cams take the
// first places (owners / staff pin them from ⋯ Manage → 📌 Pin a cam, unpin with 📌✕ on the tile); while someone nobody can show
// - or Pepe - talks with tiles still up, the tiles dim and a strip says so (program.speaking with src); a tile showing the
// viewer's OWN cam has 🙈 Take me off (POST /api/stage/leave); an empty program (the page keeps the view a moment) says nobody
// is on the mic; every card says why there's no picture (cold opens off, the rate limit, Pepe's cams busy, ...).
//
//   var ctl = PATVStageMic.render(host, program, {slug, onChange})    host = the stage's player box (#rmVideo)
//   ctl.update(program) · ctl.stop() · ctl.selection()
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var BEAT_MS = 15000, HIDDEN_MS = 30000, SAY_GAP = 5000, RETRY_MS = 10000;
  var REWATCH_MAX = 4, REWATCH_WIN_MS = 3 * 60 * 1000;   // mfix review: a live tile's re-watches after a dropped connection
  var LAYOUTS = ['single', 'split', 'grid4', 'grid9', 'pip'];
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, label) { var b = el('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; }
  function post(url, body, keep) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: !!keep,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function initials(n) {
    var p = String(n || '?').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '?').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }
  function short(n) { n = String(n || ''); return n.length > 10 ? n.slice(0, 10) + '…' : n; }
  function cleanProgram(p) {
    if (!p || typeof p !== 'object') return null;
    var src = Array.isArray(p.src) ? p.src.filter(function (s) { return s && typeof s.id === 'string' && /^[\w.\-]{1,40}$/.test(s.id); }).slice(0, 9) : [];
    return { v: p.v, layout: LAYOUTS.indexOf(p.layout) >= 0 ? p.layout : 'single', count: Math.max(0, Number(p.count) || 0), pins_n: Math.max(0, Number(p.pins_n) || 0), signin: p.signin === true, idle: p.idle === true,
             blocked: p.blocked === true, src: src, manage: p.manage && typeof p.manage === 'object' ? p.manage : null, frozen_until: Number(p.frozen_until) || 0,
             still_s: Math.max(10, Math.min(120, Number(p.still_s) || 20)), fixed: p.fixed === true, report: p.report === true,
             speaking: p.speaking === 'someone' || p.speaking === 'pepe' ? p.speaking : null };
  }
  var REASONS = ['impersonation', 'sexual', 'abuse', 'minor', 'other'];
  function reasonText(r) {
    return r === 'impersonation' ? _t('js.stage.mf.r_impersonation', 'Not who they say they are') : r === 'sexual' ? _t('js.stage.mf.r_sexual', 'Nudity or sexual')
      : r === 'abuse' ? _t('js.stage.mf.r_abuse', 'Harassment or hate') : r === 'minor' ? _t('js.stage.mf.r_minor', 'May be under 18') : _t('js.stage.mf.r_other', 'Something else');
  }
  /** The reason a tile shows a card, as words. */
  function cardText(s) {
    if (s.watch === 'hidden') return _t('js.stage.mf.hidden', 'hidden for you (you reported it)');
    if (s.watch === 'members_only') return _t('js.stage.mf.members_only', 'only for members');
    if (s.watch === 'unavailable') return _t('js.stage.mf.unavailable', 'isn\'t available');
    if (s.watch === 'blocked') return _t('js.stage.mf.blocked_tile', 'blocked for you here');
    if (s.video === 'starting') return _t('js.stage.mf.starting', 'cam starting…');
    if (s.why === 'off_cam') return _t('js.stage.mf.cam_off', 'cam off');
    if (s.why === 'failed' || s.why === 'pepe') return _t('js.stage.mf.failed', 'Pepe couldn\'t open their cam');
    // mfix: why there's no picture - not always "full"
    if (s.why === 'retry') return _t('js.stage.mf.retry', 'trying their cam again in a moment…');
    if (s.why === 'cold_off') return _t('js.stage.mf.cold_off', 'only cams already live show here right now');
    if (s.why === 'rate') return _t('js.stage.mf.rate', 'a lot of cams opened just now - this one is next');
    if (s.why === 'pool') return _t('js.stage.mf.pool', 'Pepe\'s cams are all busy right now');
    if (s.why === 'pad_cap') return _t('js.stage.mf.pad_cap', 'this stage\'s live cams are all in use');
    return _t('js.stage.mf.full', 'live cams are full right now');
  }

  function render(host, program, ctx) {
    ctx = ctx || {};
    var slug = String(ctx.slug || '');
    var base = '/api/rooms/' + encodeURIComponent(slug) + '/micfollow';
    var P = cleanProgram(program) || { src: [], count: 0, layout: 'single' };
    var stopped = false, dark = false, hideTimer = null;
    var box = el('div', 'mf-stage'); box.setAttribute('role', 'group');
    var grid = el('div', 'mf-grid');
    var note = el('div', 'mf-note');
    var tapAll = btn('mf-tapall', _t('js.pad.strip.tap', '▶ Tap to play')); tapAll.hidden = true;
    var say = el('div', 'mf-sr-only'); say.setAttribute('aria-live', 'polite'); say.setAttribute('role', 'status');
    // the neutral card (DF-30 / DF-12): no name, no avatar - nobody is singled out while someone nobody can show speaks
    var neutral = el('div', 'mf-neutral'); neutral.hidden = true; neutral.setAttribute('role', 'status');
    var nIcon = el('span', 'mf-av', '🎙'), nText = el('span', 'mf-why');
    nIcon.setAttribute('aria-hidden', 'true'); neutral.appendChild(nIcon); neutral.appendChild(nText);
    // mfix: tiles kept up while someone nobody can show (or Pepe) talks - dimmed, and this strip says who speaks
    var strip = el('div', 'mf-strip'); strip.hidden = true; strip.setAttribute('role', 'status');
    box.appendChild(grid); box.appendChild(strip); box.appendChild(neutral); box.appendChild(note); box.appendChild(tapAll); box.appendChild(say);
    // the bar ABOVE the tiles: ⋯ Manage + 🧹 Clear the stage (owners / staff); ⚑ Report (viewers, on narrow grids)
    var bar = el('div', 'mf-bar');
    var mBtn = btn('mf-mbtn', '⋯', _t('js.stage.mf.manage', 'Manage the mic stage'));
    mBtn.setAttribute('aria-expanded', 'false'); mBtn.hidden = true;
    var clearBtn = btn('mf-bbtn mf-clear', _t('js.stage.mf.clear', '🧹 Clear the stage'), _t('js.stage.mf.clear_aria', 'Clear the mic stage now (and freeze it)'));
    clearBtn.hidden = true;
    var rBtn = btn('mf-bbtn mf-rbtn', _t('js.stage.mf.report_list', '⚑ Report'), _t('js.stage.mf.report_list_aria', 'Report someone on the mic stage'));
    rBtn.hidden = true; rBtn.setAttribute('aria-expanded', 'false');
    var bmsg = el('span', 'mf-bmsg'); bmsg.setAttribute('role', 'status');
    bar.appendChild(mBtn); bar.appendChild(clearBtn); bar.appendChild(rBtn); bar.appendChild(bmsg);
    // ⚑ the report panel (viewers): who, then why
    var rpanel = el('div', 'mf-panel mf-rpanel'); rpanel.hidden = true; rpanel.setAttribute('role', 'dialog');
    rpanel.setAttribute('aria-label', _t('js.stage.mf.report_list_aria', 'Report someone on the mic stage'));
    var panel = el('div', 'mf-panel'); panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', _t('js.stage.mf.manage', 'Manage the mic stage'));
    var freeze = btn('mf-pbtn', ''), layoutSel = el('select', 'mf-layout'), people = el('ul', 'mf-people'), ask = el('div', 'mf-ask'), pmsg = el('p', 'mf-pmsg');
    layoutSel.setAttribute('aria-label', _t('js.stage.mf.layout', 'Layout'));
    [['', _t('js.stage.mf.layout_pad', 'The pad\'s setting')], ['auto', _t('js.stage.mf.layout_auto', 'Auto (by how many are on the mic)')],
     ['single', _t('js.stage.mf.layout_single', 'Newest speaker only')], ['split', _t('js.stage.mf.layout_split', 'Side by side')],
     ['grid', _t('js.stage.mf.layout_grid', 'Grid')], ['pip', _t('js.stage.mf.layout_pip', 'Picture in picture')]].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; layoutSel.appendChild(op);
    });
    ask.hidden = true; pmsg.setAttribute('role', 'status');
    // mfix: 📌 Pin a cam - who's on cam in the room, and a Pin / Unpin for each (the server says who can't be pinned, never why)
    var pinBtn = btn('mf-pbtn', _t('js.stage.mf.pin_open', '📌 Pin a cam…')); pinBtn.setAttribute('aria-expanded', 'false');
    var pinPanel = el('div', 'mf-pins'); pinPanel.hidden = true;
    var pinList = el('ul', 'mf-people'); pinPanel.appendChild(pinList);
    pinBtn.addEventListener('click', function () {
      pinPanel.hidden = !pinPanel.hidden;
      pinBtn.setAttribute('aria-expanded', pinPanel.hidden ? 'false' : 'true');
      if (!pinPanel.hidden) loadPins();
    });
    panel.appendChild(freeze); panel.appendChild(layoutSel); panel.appendChild(pinBtn); panel.appendChild(pinPanel); panel.appendChild(people); panel.appendChild(ask); panel.appendChild(pmsg);
    box.appendChild(bar); box.appendChild(panel); box.appendChild(rpanel);
    host.appendChild(box);

    var tiles = Object.create(null);    // id -> tile (no prototype: an id is a login)
    // ── screen readers: who came on / left, at most one line every 5 s ──
    var pending = [], sayAt = 0, sayTimer = null;
    function announce(line) {
      pending.push(line);
      if (sayTimer) return;
      var wait = Math.max(0, sayAt + SAY_GAP - Date.now());
      sayTimer = setTimeout(function () {
        sayTimer = null; sayAt = Date.now();
        say.textContent = pending.length > 1 ? _t('js.stage.mf.changed_n', '{n} people changed on the mic stage', { n: pending.length }) : pending[0];
        pending = [];
      }, wait);
    }

    function tile(s) {
      var t = { id: s.id, s: s, mode: null, gen: 0, sess: null, beat: null, still: null, failedAt: 0, failText: '', retry: null };
      var e = el('div', 'mf-tile'); e.setAttribute('data-id', s.id); e.setAttribute('role', 'group');   // (a role, so its aria-label is read)
      var v = el('video', 'rtc-video'); v.muted = true; v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
      var img = el('img', 'mf-still'); img.alt = ''; img.hidden = true;
      var card = el('div', 'mf-card'), av = el('span', 'mf-av'), avImg = el('img'), avTxt = el('span', 'mf-avt'), reason = el('span', 'mf-why');
      avImg.alt = ''; avImg.hidden = true; av.appendChild(avImg); av.appendChild(avTxt); card.appendChild(av); card.appendChild(reason);
      var label = el('div', 'mf-label'), name = el('span', 'mf-name'), mic = el('span', 'mf-mic', '🎙'), tag = el('span', 'mf-tag'), sr = el('span', 'mf-sr-only');
      mic.setAttribute('aria-hidden', 'true');
      // mfix: 📌 on a pinned cam's label (its place is fixed: hand-overs and new speakers never move it)
      var pinTag = el('span', 'mf-pin', '📌'); pinTag.hidden = true; pinTag.setAttribute('title', _t('js.stage.mf.pinned_tag', 'pinned'));
      var pinSr = el('span', 'mf-sr-only');
      label.appendChild(mic); label.appendChild(pinTag); label.appendChild(name); label.appendChild(tag); label.appendChild(pinSr); label.appendChild(sr);
      var x = btn('mf-x', '✕');
      var rp = btn('mf-x mf-rp', _t('js.stage.mf.report', '⚑'));            // ⚑ viewers (owners have ✕)
      var pn = btn('mf-x mf-pn', '📌'); pn.hidden = true;                      // mfix: owners - pin this person here
      var off = btn('mf-off', _t('js.stage.mf.take_off', '🙈 Take me off')); off.hidden = true;   // mfix: the viewer's OWN cam
      e.appendChild(v); e.appendChild(img); e.appendChild(card); e.appendChild(label); e.appendChild(x); e.appendChild(rp); e.appendChild(pn); e.appendChild(off);
      t.el = e; t.video = v;
      x.addEventListener('click', function () { if (t.s && t.s.pin) pinPost(t.s.id, true); else askExclude(t.s); });
      rp.addEventListener('click', function () { askReport(t.s, rp); });
      pn.addEventListener('click', function () { pn.disabled = true; pinPost(t.s.id, false).then(function () { pn.disabled = false; }); });
      off.addEventListener('click', function () { takeOff(off); });
      /** the watch route's body: a pinned cam's ticket comes through its pin */
      function wb(extra) { var b = { login: t.id }; if (t.s && t.s.pin) b.pin = true; for (var k in extra) b[k] = extra[k]; return b; }
      function stopLive(tell) {
        t.gen++; clearInterval(t.beat); t.beat = null;
        if (t.sess) { try { t.sess.close(); } catch (er) { /* gone */ } t.sess = null; }
        try { v.srcObject = null; } catch (er) { /* gone */ }
        if (tell) post(base + '/watch', wb({ stop: true }), true).catch(function () {});
      }
      function stopStill() { clearInterval(t.still); t.still = null; img.hidden = true; img.removeAttribute('src'); }
      function showCard(text) {
        card.hidden = false; v.hidden = true; img.hidden = true;
        reason.textContent = text || '';
        tag.textContent = '';
      }
      /** A live picture didn't work out: a card with the reason, and one more try after RETRY_MS (unless it's for good). */
      function failed(text, forGood) {
        t.failedAt = Date.now(); t.failText = text || ''; t.mode = 'card';
        showCard(t.failText);
        clearTimeout(t.retry); t.retry = null;
        if (!forGood) t.retry = setTimeout(function () { t.retry = null; if (!stopped && tiles[t.id] === t) apply(t.s); }, RETRY_MS + 50);
      }
      function startLive() {
        var my = ++t.gen;
        showCard(_t('js.stage.mf.starting', 'cam starting…'));
        if (!window.RTCPeerConnection || !window.PATVRtc || !PATVRtc.watch) { failed(_t('js.pad.live.err_browser', 'This browser can\'t play live cams.'), true); return; }
        post(base + '/watch', wb({})).then(function (d) {
          if (my !== t.gen) return;
          if (!d || !d.ok || !d.whep) {
            failed(d && d.code === 'budget' ? _t('js.stage.mf.full', 'live cams are full right now') : d && d.code === 'members_only' ? _t('js.stage.mf.members_only', 'only for members')
              : d && d.code === 'unavailable' ? _t('js.stage.mf.unavailable', 'isn\'t available') : d && d.state === 'ended' ? _t('js.stage.mf.starting', 'cam starting…')
              : window.PATVLiveCam && PATVLiveCam.why ? PATVLiveCam.why(d && d.code, d && d.error) : _t('js.stage.mf.failed', 'Pepe couldn\'t open their cam'),
              !!(d && (d.code === 'members_only' || d.code === 'unavailable' || d.code === 'blocked' || d.code === 'pad_access' || d.code === 'prime')));
            return;
          }
          t.beat = setInterval(function () {
            post(base + '/watch', wb({ beat: true })).then(function (k) {
              if (my !== t.gen) return;
              if (k && (k.ok === false || k.state === 'ended')) { stopLive(false); failed(cardText(t.s)); }
            }).catch(function () { /* a blip: the next beat */ });
          }, BEAT_MS);
          return PATVRtc.watch(d.whep, v, { timeout: 40000, cancelled: function () { return my !== t.gen; } }).then(function (ss) { playing(ss, my); });
        }).catch(function (er) { if (my === t.gen && !(er && er.cancelled)) { stopLive(true); failed(_t('js.stage.mf.failed', 'Pepe couldn\'t open their cam')); } });
      }
      function playing(ss, my) {
        if (my !== t.gen) { ss.close(); return; }
        t.sess = ss; t.failedAt = 0;
        card.hidden = true; v.hidden = false;
        v.setAttribute('aria-label', _t('js.pad.live.aria', '{name}\'s cam, live', { name: t.s.name }));
        if (ss.blocked) tapAll.hidden = false;
        ss.onfail = function () { if (my === t.gen) rewatch(my); };
      }
      // mfix review: the connection dropped after it played (Pepe re-opened the relay, its publisher restarted): watch again at once
      // with a fresh ticket while the tile is still live (the route says no otherwise) - no "couldn't open" card for a short
      // reconnect; at most REWATCH_MAX times in REWATCH_WIN_MS, then the card and the usual retry
      function rewatch(my) {
        var t0 = Date.now();
        t.rew = (t.rew || []).filter(function (x) { return t0 - x < REWATCH_WIN_MS; });
        var give = function () { if (my === t.gen) { stopLive(true); failed(_t('js.stage.mf.failed', 'Pepe couldn\'t open their cam')); } };
        if (t.rew.length >= REWATCH_MAX) return give();
        t.rew.push(t0);
        if (t.sess) { try { t.sess.close(); } catch (er) { /* gone */ } t.sess = null; }
        showCard(_t('js.stage.mf.reconnecting', 'reconnecting…'));
        post(base + '/watch', wb({})).then(function (d) {
          if (my !== t.gen) return null;
          if (!d || !d.ok || !d.whep) { stopLive(true); failed(cardText(t.s)); return null; }
          return PATVRtc.watch(d.whep, v, { timeout: 40000, cancelled: function () { return my !== t.gen; } }).then(function (ss) { playing(ss, my); },
            function (er) { if (!(er && er.cancelled)) give(); });
        }).catch(give);
      }
      function startStill() {
        stopStill();
        showCard(_t('js.stage.mf.starting', 'cam starting…'));
        var waits = 0, gen = t.gen;
        var load = function () {
          getJson(base + '/still/' + encodeURIComponent(t.id)).then(function (d) {
            if (t.mode !== 'still' || gen !== t.gen) return;
            if (d && d.state === 'ok' && typeof d.img === 'string' && d.img.indexOf('data:image/jpeg;base64,') === 0) {
              waits = 0;
              img.src = d.img; img.hidden = false; card.hidden = true; v.hidden = true;
              img.alt = _t('js.stage.mf.still_alt', '{name}\'s cam, a still', { name: t.s.name });
              tag.textContent = _t('js.stage.mf.still', '📷 still');
              return;
            }
            // no picture: say why on the card instead of "starting" for ever
            if (d && d.ok === false) {
              var forGood = d.code === 'members_only' || d.code === 'unavailable' || d.code === 'blocked' || d.code === 'pad_access' || d.code === 'prime' || d.code === 'signin';
              showCard(d.code === 'members_only' ? _t('js.stage.mf.members_only', 'only for members') : d.code === 'blocked' ? _t('js.stage.mf.blocked_tile', 'blocked for you here')
                : d.code === 'rate' ? _t('js.stage.mf.starting', 'cam starting…') : _t('js.stage.mf.unavailable', 'isn\'t available'));
              if (forGood) { clearInterval(t.still); t.still = null; }
              return;
            }
            if (d && d.state === 'pending' && ++waits < 2) return;          // Pepe is on it (one more round)
            if (d && (d.state === 'pending' || d.state === 'refused' || d.state === 'none') && img.hidden) showCard(_t('js.stage.mf.unavailable', 'isn\'t available'));
          }).catch(function () { /* the next round */ });
        };
        load();
        t.still = setInterval(load, (P.still_s || 20) * 1000);
      }
      function apply(s) {
        t.s = s;
        name.textContent = P.layout === 'grid9' && box.classList.contains('narrow') ? short(s.name) : s.name;
        name.className = 'mf-name' + (s.nameCss ? ' cx-name' : '');
        name.style.cssText = s.nameCss || '';
        e.setAttribute('aria-label', s.name);
        e.classList.toggle('newest', !!s.newest);
        // mfix: pinned / recent (let go of the mic a moment ago - no ring) / the viewer's own cam
        e.classList.toggle('pinned', !!s.pin);
        e.classList.toggle('recent', !!s.recent);
        pinTag.hidden = !s.pin;
        pinSr.textContent = s.pin ? ', ' + _t('js.stage.mf.pinned_tag', 'pinned') : '';
        pn.hidden = !P.manage || !!s.pin || !pinsFree();
        pn.setAttribute('aria-label', _t('js.stage.mf.pin_q', 'Pin {name} on the mic stage', { name: s.name }));
        off.hidden = s.mine !== true;
        off.setAttribute('aria-label', _t('js.stage.mf.take_off_aria', 'Take my cam off this pad\'s stage'));
        if (s.newest) { e.setAttribute('aria-current', 'true'); sr.textContent = ', ' + _t('js.stage.mf.newest', 'newest speaker'); }
        else { e.removeAttribute('aria-current'); sr.textContent = ''; }
        avTxt.textContent = initials(s.name);
        if (s.avatar && /^(https:\/\/|\/)[^\s"'<>]+$/.test(s.avatar)) { avImg.src = s.avatar; avImg.hidden = false; avTxt.hidden = true; } else { avImg.hidden = true; avTxt.hidden = false; }
        x.textContent = s.pin ? '📌✕' : '✕';
        x.setAttribute('aria-label', s.pin ? _t('js.stage.mf.unpin_q', 'Unpin {name}', { name: s.name }) : _t('js.stage.mf.exclude_q', 'Keep {name} off the mic stage', { name: s.name }));
        x.hidden = !P.manage;
        rp.setAttribute('aria-label', _t('js.stage.mf.report_aria', 'Report {name}', { name: s.name }));
        rp.hidden = !P.report || !!P.manage || s.watch === 'hidden';
        var want = s.watch !== 'ok' ? 'card' : s.video === 'live' ? 'live' : s.video === 'still' ? 'still' : 'card';
        if ((want === 'live' || want === 'still') && dark) want = 'paused';           // a hidden tab: no video, no still polling
        var held = want === 'live' && t.mode !== 'live' && t.failedAt && Date.now() - t.failedAt < RETRY_MS;   // a failed one waits a moment
        if (held) want = 'card';
        else if (want !== 'live') t.failedAt = 0;
        var text = held ? t.failText : cardText(s);
        if (want !== t.mode) {
          if (t.mode === 'live') stopLive(true);
          if (t.mode === 'still') stopStill();
          t.mode = want;
          if (want === 'live') startLive();
          else if (want === 'still') startStill();
          else showCard(want === 'paused' ? '' : text);
        } else if (want === 'card') showCard(text);
      }
      t.apply = apply;
      t.stop = function (tell) { clearTimeout(t.retry); t.retry = null; if (t.mode === 'live') stopLive(tell); stopStill(); t.mode = null; };
      t.pause = function () {
        if (t.mode === 'live') { stopLive(true); t.mode = 'paused'; }
        else if (t.mode === 'still') { stopStill(); t.mode = 'paused'; }
      };
      t.resume = function () { if (t.mode === 'paused') { t.mode = null; apply(t.s); } };
      apply(s);
      return t;
    }

    // ── mfix: 📌 pins (owners / staff) and 🙈 Take me off (the person shown) ──
    function pinCount() { var n = 0; P.src.forEach(function (s) { if (s && s.pin) n++; }); return n; }
    function pinsFree() { return !!(P.manage && Number(P.manage.pins_room) > pinCount()); }
    function pinPost(login, remove) {
      return post(base + '/pin', remove ? { login: login, remove: true } : { login: login }).then(function (d) {
        var m = d && d.ok ? (d.asked ? _t('js.stage.mf.pin_asked', 'Asked them - it goes up once they say OK.') : remove ? _t('js.stage.mf.unpinned', 'Unpinned.') : _t('js.stage.mf.pinned', 'Pinned.'))
          : (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
        bmsg.textContent = m; pmsg.textContent = m;
        if (!pinPanel.hidden) loadPins();
        if (ctx.onChange) { try { ctx.onChange(); } catch (er) { /* page's own */ } }
        return d;
      }).catch(function () { bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); return null; });
    }
    function takeOff(b) {
      var ok = typeof window.confirm === 'function' ? window.confirm(_t('js.stage.room.q_leave', 'Take your cam off this pad\'s Stage? This pad can\'t put it back for an hour.')) : true;
      if (!ok) return;
      b.disabled = true;
      fetch('/api/stage/leave', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ room: slug }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (j) {
          b.disabled = false;
          bmsg.textContent = j && j.ok ? _t('js.stage.mf.took_off', 'You\'re off this pad\'s stage for now.') : (j && j.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
          if (ctx.onChange) { try { ctx.onChange(); } catch (er) { /* page's own */ } }
        })
        .catch(function () { b.disabled = false; bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    }
    function pinState(c) {
      if (c.pinned) return _t('js.stage.mf.pin_s_pinned', 'pinned');
      if (c.blocked === 'opted_out') return _t('js.stage.mf.pin_s_opted_out', 'live video off');
      if (c.blocked === 'limited') return _t('js.stage.mf.pin_s_limited', 'cam only for some viewers');
      if (c.blocked) return _t('js.stage.mf.unavailable', 'isn\'t available');
      if (c.waiting) return _t('js.stage.mf.pin_s_waiting', 'waiting for their OK');
      if (c.ask) return _t('js.stage.mf.pin_s_ask', 'asks them first');
      return '';
    }
    function loadPins() {
      pinList.textContent = '';
      pinList.appendChild(el('li', 'mf-pmsg', '…'));
      getJson(base + '/pins').then(function (d) {
        pinList.textContent = '';
        if (!d || !d.ok) { pinList.appendChild(el('li', 'mf-pmsg', (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.'))); return; }
        var cams = Array.isArray(d.cams) ? d.cams : [];
        if (!cams.length) { pinList.appendChild(el('li', 'mf-pmsg', _t('js.stage.mf.pin_none', 'Nobody is on cam in the room right now.'))); return; }
        var full = (Array.isArray(d.pins) ? d.pins.length : 0) >= (Number(d.room) || 0);
        cams.forEach(function (c) {
          if (!c || typeof c.login !== 'string') return;
          var li = el('li', null), nm = el('span', 'mf-pn-name', String(c.display || c.login)), st = el('span', 'mf-pn-state', pinState(c));
          li.appendChild(nm); li.appendChild(st);
          if (c.pinned) {
            var u = btn('mf-pbtn', _t('js.stage.mf.unpin', 'Unpin'), _t('js.stage.mf.unpin_q', 'Unpin {name}', { name: String(c.display || c.login) }));
            u.addEventListener('click', function () { u.disabled = true; pinPost(c.login, true); });
            li.appendChild(u);
          } else if (!c.blocked && !c.waiting && !full) {
            var b = btn('mf-pbtn', c.ask ? _t('js.stage.mf.pin_ask', 'Ask to pin') : _t('js.stage.mf.pin', '📌 Pin'), _t('js.stage.mf.pin_q', 'Pin {name} on the mic stage', { name: String(c.display || c.login) }));
            b.addEventListener('click', function () { b.disabled = true; pinPost(c.login, false); });
            li.appendChild(b);
          }
          pinList.appendChild(li);
        });
        if (full) pinList.appendChild(el('li', 'mf-pmsg', _t('js.stage.mf.pin_full', 'No room for another pin - unpin one first.')));
      }).catch(function () { pinList.textContent = ''; pinList.appendChild(el('li', 'mf-pmsg', _t('js.stage.mf.e_do', 'Couldn\'t do that.'))); });
    }
    function askExclude(s) {
      if (!P.manage || !s) return;
      openPanel(true);
      ask.textContent = '';
      ask.hidden = false;
      ask.appendChild(el('p', null, _t('js.stage.mf.exclude_q', 'Keep {name} off the mic stage', { name: s.name })));
      [[1, _t('js.stage.mf.exclude_1h', 'for 1 hour')], [24, _t('js.stage.mf.exclude_24h', 'for 24 hours')], [0, _t('js.stage.mf.exclude_always', 'always')]].forEach(function (o) {
        var b = btn('mf-pbtn danger', o[1]);
        b.addEventListener('click', function () {
          b.disabled = true;
          post(base + '/exclude', { login: s.id, hours: o[0] }).then(function (d) {
            pmsg.textContent = d && d.ok ? _t('js.stage.mf.excluded', 'Off the mic stage.') : (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
            ask.hidden = true; ask.textContent = '';
            if (ctx.onChange) { try { ctx.onChange(); } catch (er) { /* page's own */ } }
          }).catch(function () { pmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); b.disabled = false; });
        });
        ask.appendChild(b);
      });
      var no = btn('mf-pbtn', _t('js.stage.mf.cancel', 'Cancel'));
      no.addEventListener('click', function () { ask.hidden = true; ask.textContent = ''; });
      ask.appendChild(no);
      var first = ask.querySelector('button');
      if (first && first.focus) first.focus();
    }
    // ── ⚑ reports (viewers): the tile hides for this viewer at once; two qualified reporters take it off for everyone ──
    var rFocusBack = null;
    function closeReport() {
      if (rpanel.hidden) return;
      rpanel.hidden = true; rpanel.textContent = ''; rBtn.setAttribute('aria-expanded', 'false');
      if (rFocusBack && rFocusBack.focus) { try { rFocusBack.focus(); } catch (er) { /* gone */ } }
      rFocusBack = null;
    }
    function askReport(s, from) {
      if (!P.report || !s) return;
      openPanel(false);
      rFocusBack = from || null;
      rpanel.textContent = ''; rpanel.hidden = false; rBtn.setAttribute('aria-expanded', 'true');
      rpanel.appendChild(el('p', null, _t('js.stage.mf.report_q', 'Report {name}? Why:', { name: s.name })));
      REASONS.forEach(function (r) {
        var b = btn('mf-pbtn', reasonText(r));
        b.addEventListener('click', function () {
          b.disabled = true;
          post(base + '/report', { login: s.id, reason: r }).then(function (d) {
            closeReport();
            bmsg.textContent = d && d.ok ? _t('js.stage.mf.reported', 'Reported - it\'s hidden for you.') : (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
            var t = tiles[s.id];
            if (d && d.ok && t) { t.s.watch = 'hidden'; t.apply(t.s); }          // hidden at once (the next program says so too)
          }).catch(function () { b.disabled = false; bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
        });
        rpanel.appendChild(b);
      });
      var no = btn('mf-pbtn', _t('js.stage.mf.cancel', 'Cancel'));
      no.addEventListener('click', closeReport);
      rpanel.appendChild(no);
      var first = rpanel.querySelector('button');
      if (first && first.focus) { try { first.focus(); } catch (er) { /* none */ } }
    }
    /** ⚑ in the bar (narrow grids): pick who first. */
    function reportList() {
      openPanel(false);
      rFocusBack = rBtn;
      rpanel.textContent = ''; rpanel.hidden = false; rBtn.setAttribute('aria-expanded', 'true');
      P.src.forEach(function (s) {
        if (s.watch === 'hidden') return;
        var b = btn('mf-pbtn', '⚑ ' + s.name, _t('js.stage.mf.report_aria', 'Report {name}', { name: s.name }));
        b.addEventListener('click', function () { askReport(s, rBtn); });
        rpanel.appendChild(b);
      });
      var no = btn('mf-pbtn', _t('js.stage.mf.cancel', 'Cancel'));
      no.addEventListener('click', closeReport);
      rpanel.appendChild(no);
      var first = rpanel.querySelector('button');
      if (first && first.focus) { try { first.focus(); } catch (er) { /* none */ } }
    }
    rBtn.addEventListener('click', function () { if (rpanel.hidden) reportList(); else closeReport(); });
    rpanel.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); closeReport(); } });
    // 🧹 Clear the stage (owners / staff): everyone off now, frozen
    clearBtn.addEventListener('click', function () {
      clearBtn.disabled = true;
      post(base + '/clear', {}).then(function (d) {
        clearBtn.disabled = false;
        if (d && d.ok) { P.frozen_until = Number(d.frozen_until) || 0; bmsg.textContent = _t('js.stage.mf.cleared', 'Cleared - nobody new for {n} min.', { n: freezeMin() }); if (!panel.hidden) paintPanel(); }
        else bmsg.textContent = (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
        if (ctx.onChange) { try { ctx.onChange(); } catch (er) { /* page's own */ } }
      }).catch(function () { clearBtn.disabled = false; bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    });
    function openPanel(on, focusBack) {
      if (on) closeReport();
      var was = !panel.hidden;
      panel.hidden = !on; mBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        paintPanel();
        if (!was && freeze.focus) { try { freeze.focus(); } catch (er) { /* none */ } }   // keyboard users land inside it
      } else if (was && focusBack && !mBtn.hidden && mBtn.focus) { try { mBtn.focus(); } catch (er) { /* none */ } }
    }
    // Escape closes ⋯ Manage (or its ✕ question first) and puts the focus back on ⋯
    panel.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' && ev.key !== 'Esc') return;
      ev.preventDefault();
      if (!ask.hidden) { ask.hidden = true; ask.textContent = ''; try { freeze.focus(); } catch (er) { /* none */ } return; }
      openPanel(false, true);
    });
    /** How long ❄ freezes: the server says (the site's freeze_max_min caps it), else 30 min. */
    function freezeMin() { var n = P.manage && Number(P.manage.freeze_min); return n > 0 ? Math.round(n) : 30; }
    function paintPanel() {
      var m = P.manage;
      if (!m) return;
      var frozen = P.frozen_until > Date.now();
      freeze.textContent = frozen ? _t('js.stage.mf.unfreeze', '▶ Unfreeze') : _t('js.stage.mf.freeze', '❄ Freeze (nobody new for {n} min)', { n: freezeMin() });
      freeze.setAttribute('aria-pressed', frozen ? 'true' : 'false');
      layoutSel.value = m.layout_override || '';
      pinBtn.hidden = !(Number(m.pins_room) > 0);
      if (pinBtn.hidden) pinPanel.hidden = true;
      people.textContent = '';
      P.src.forEach(function (s) {
        if (s.pin) return;                                        // (a pin's own 📌✕ unpins it)
        var li = el('li', null), b = btn('mf-pbtn', '✕ ' + s.name, _t('js.stage.mf.exclude_q', 'Keep {name} off the mic stage', { name: s.name }));
        b.addEventListener('click', function () { askExclude(s); });
        li.appendChild(b); people.appendChild(li);
      });
    }
    mBtn.addEventListener('click', function () { openPanel(panel.hidden, true); });
    freeze.addEventListener('click', function () {
      var frozen = P.frozen_until > Date.now();
      freeze.disabled = true;
      post(base + '/freeze', { minutes: frozen ? 0 : freezeMin() }).then(function (d) {
        freeze.disabled = false;
        if (d && d.ok) { P.frozen_until = Number(d.frozen_until) || 0; paintPanel(); pmsg.textContent = ''; } else pmsg.textContent = (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
      }).catch(function () { freeze.disabled = false; pmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    });
    layoutSel.addEventListener('change', function () {
      post(base + '/layout', { layout: layoutSel.value || null }).then(function (d) {
        pmsg.textContent = d && d.ok ? '' : (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
      }).catch(function () { pmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    });
    tapAll.addEventListener('click', function () {
      // one gesture plays every tile (iOS refuses autoplay until the page is touched)
      var ok = true;
      for (var id in tiles) {
        var vv = tiles[id].video;
        if (vv && vv.srcObject) { try { var p = vv.play(); if (p && p.catch) p.catch(function () { ok = false; }); } catch (er) { ok = false; } }
      }
      setTimeout(function () { if (ok) tapAll.hidden = true; }, 50);
    });

    /** The bar above the tiles: always for owners / staff (⋯ + 🧹); for viewers only where the tiles are too small for their
     *  own ⚑ (narrow grid4 / grid9). `.barred` moves the tiles below it - it never covers one. */
    function barState() {
      var tight = box.classList.contains('narrow') && (P.layout === 'grid4' || P.layout === 'grid9');
      rBtn.hidden = !!P.manage || !P.report || !tight || !P.src.length;
      box.classList.toggle('managed', !!P.manage);
      box.classList.toggle('barred', !!P.manage || !rBtn.hidden);
    }
    function narrow() {
      var w = host.clientWidth || (host.getBoundingClientRect ? host.getBoundingClientRect().width : 0) || 0;
      var was = box.classList.contains('narrow');
      box.classList.toggle('narrow', w > 0 && w < 480);
      if (was !== box.classList.contains('narrow') && P) barState();
    }
    var ro = null;
    if (window.ResizeObserver) { try { ro = new ResizeObserver(function () { narrow(); }); ro.observe(host); } catch (er) { ro = null; } }
    if (!ro) window.addEventListener('resize', narrow);

    function update(p) {
      if (stopped) return;
      var n = cleanProgram(p);
      if (!n) return;
      P = n;
      narrow();
      box.setAttribute('data-layout', P.layout);
      var neutralText = P.speaking === 'pepe' ? _t('js.stage.mf.pepe', 'Pepe is on the mic') : P.speaking ? _t('js.stage.mf.someone', 'Someone is speaking') : '';
      // mfix: the page keeps this view a moment after the stage empties (stage-room.js): nobody is on the mic right now
      var idleText = !P.src.length && !neutralText && P.idle ? _t('js.stage.mf.idle', 'Nobody is on the mic right now') : '';
      box.setAttribute('aria-label', !P.count && (neutralText || idleText) ? neutralText || idleText
        : !P.count && P.pins_n ? _t('js.stage.mf.group_aria_pins', 'Pinned on the stage: {n}', { n: P.pins_n })      // mfix review: pins aren't "on the mic"
        : P.count === 1 ? _t('js.stage.mf.group_aria_one', 'On the mic: 1 person', { n: 1 })
        : _t('js.stage.mf.group_aria', 'On the mic: {n} people', { n: P.count }));
      // the neutral card: only while nobody is on the stage (the tiles gave way to it)
      neutral.hidden = !((neutralText || idleText) && !P.src.length && !P.signin && !P.blocked);
      nText.textContent = neutralText || idleText;
      nIcon.textContent = P.speaking === 'pepe' ? '🐸' : '🎙';
      // mfix: tiles kept up while someone nobody can show - or Pepe - talks: dimmed, nobody ringed, a strip says who speaks
      var dim = !!P.speaking && P.src.length > 0 && !P.signin && !P.blocked;
      box.classList.toggle('mf-dim', dim);
      strip.hidden = !dim;
      strip.textContent = dim ? (P.speaking === 'pepe' ? _t('js.stage.mf.pepe_strip', '🐸 Pepe is on the mic') : _t('js.stage.mf.someone_strip', 'Someone else is speaking')) : '';
      mBtn.hidden = !P.manage;
      clearBtn.hidden = !P.manage;
      barState();
      if (!P.report || P.manage || !P.src.length) closeReport();
      if (!P.manage) openPanel(false); else if (!panel.hidden) paintPanel();
      // signed out / blocked: a note, no tiles
      var msg = P.signin ? _t('js.stage.mf.tab_signin', '🎙 On the mic: sign in to watch') : P.blocked ? _t('js.stage.mf.blocked', 'Live cams from this room are blocked for you.') : '';
      note.textContent = msg; note.hidden = !msg;
      var seen = {};
      P.src.slice().sort(function (a, b) { return (a.pos || 0) - (b.pos || 0); }).forEach(function (s) {
        seen[s.id] = true;
        var t = tiles[s.id];
        if (!t) {
          t = tiles[s.id] = tile(s);
          announce(_t('js.stage.mf.joined', '{name} is on the stage', { name: s.name }));
        } else t.apply(s);
        grid.appendChild(t.el);                         // keeps reading order = positions
      });
      Object.keys(tiles).forEach(function (id) {
        if (seen[id]) return;
        var t = tiles[id];
        announce(_t('js.stage.mf.left', '{name} left the stage', { name: t.s.name }));
        t.stop(true);
        if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
        delete tiles[id];
      });
      // mfix: the tile that fills the stage in picture in picture (the others are the corner inset): the newest speaker, else
      // the latest mic tile (a pin sits in the corner while someone else is up), else the first
      var order = P.src.slice().sort(function (a, b) { return (a.pos || 0) - (b.pos || 0); }), main = null;
      for (var j = 0; j < order.length; j++) if (order[j].newest) main = order[j];
      if (!main) for (var q = order.length - 1; q >= 0 && !main; q--) if (!order[q].pin) main = order[q];
      if (!main) main = order[0] || null;
      Object.keys(tiles).forEach(function (id) { tiles[id].el.classList.toggle('main', !!main && main.id === id); });
      // grid9 keeps its 3 x 3 cells (empty ones stay black)
      var cells = P.layout === 'grid9' ? 9 : P.layout === 'grid4' ? 4 : 0, have = grid.querySelectorAll('.mf-tile').length;
      var fillers = grid.querySelectorAll('.mf-empty');
      for (var i = 0; i < fillers.length; i++) fillers[i].parentNode.removeChild(fillers[i]);
      for (var k = have; k < cells; k++) { var f = el('div', 'mf-empty'); f.setAttribute('aria-hidden', 'true'); grid.appendChild(f); }
    }
    function onVis() {
      if (document.hidden) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { dark = true; for (var id in tiles) tiles[id].pause(); }, HIDDEN_MS);
      } else {
        clearTimeout(hideTimer); hideTimer = null;
        if (dark) { dark = false; for (var id2 in tiles) tiles[id2].resume(); }
      }
    }
    document.addEventListener('visibilitychange', onVis);
    function onHide() { for (var id in tiles) tiles[id].stop(true); }
    window.addEventListener('pagehide', onHide);
    update(program);
    return {
      update: update,
      stop: function () {
        stopped = true;
        clearTimeout(hideTimer); clearTimeout(sayTimer);
        for (var id in tiles) tiles[id].stop(true);
        tiles = Object.create(null);
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('pagehide', onHide);
        if (ro) { try { ro.disconnect(); } catch (er) { /* gone */ } } else window.removeEventListener('resize', narrow);
        if (box.parentNode) box.parentNode.removeChild(box);
      },
      selection: function () {
        return { stream: 'mic', label: P.count ? _t('js.stage.mf.tab', '🎙 On the mic ({n})', { n: P.count }) : _t('js.stage.mf.tab_speaking', '🎙 On the mic'),
                 embed: true, capture: false, nsfw: false };
      },
    };
  }
  window.PATVStageMic = { render: render };
})();
