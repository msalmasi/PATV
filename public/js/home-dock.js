// home-dock.js - 1.99ajh dockpop (owner P2: "a version of the new room dock for the main page that uses the same principles for preview
// mode"): the homepage's Room Dock (views/home.ejs while homeDock_). ONE stage card - the FRONT pad's stage (Pepe's stream + its slots,
// public/js/stage-room.js) under the pad Dock's auto-hiding overlay - and ONE slim chat card - the panel pad's live chat as the pad Dock
// draws it (public/js/chatlog-core.js lines, the bottom audio bar, a one-row composer for linked viewers), both decorated by
// public/js/pad-dock.js in 'preview' mode. The homepage's rules stay its own: the same /api/rooms/:slug/live long-poll as today's widget
// (no pad=1 - a homepage visitor is never on a pad's people list; no room PM; no Reveal: rv is dropped from every line), no line menus,
// clips or person menus, the newest 120 lines. While the pad's chat is open in its own window (/p/<slug>/chat, same pad and account) this
// card stands down: its poll stops and its audio pauses, and it starts fresh when the window closes. Plain ES5.
// 1.99ajq dockpol (the owner's 2026-11-04 tweaks):
//   H5  the front pad's 🎙 mic-follows stage - ONLY for a signed-in viewer who may see that pad (home.js homeMic -> I.micStage): each /live
//       answer's stage_program (asked with &home=1: no cover's Reveal / ✕ / View cam) goes through PATVAvSync.gateProgram into the stage's
//       setMic, as on the pad page; the switcher's own precedence keeps a featured slot / Pepe's featured stream ahead of it
//   H6  the front pad changes mid-session: the block is fetched again (GET /?dock=1, the same gates) and swapped in once the viewer is idle
//       (empty draft, no open sheet / menu, not holding to talk, not typing) - else "📡 Now on the front page: {pad} · Switch"
//   the Top Pads 🎧 buttons talk to a stable window.PATVHomeAudio that follows whichever block is booted
(function (W, D) {
  'use strict';
  var _t = typeof W.__t === 'function' ? W.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var root = D.querySelector('main.rm.rm-dock.rmd-home');
  if (!D.getElementById('hmdInit') || !root) return;
  function $(id) { return D.getElementById(id); }
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function parse(n) { try { return JSON.parse(n.textContent) || {}; } catch (e) { return {}; } }
  var frontSlug = '';
  if (W.PATVAvSync) W.PATVAvSync.pad(function () { return frontSlug; });
  // (one capture row for the page: it follows the front pad - its host node moves into a swapped-in block)
  var cap = null;
  // the room audio the Top Pads 🎧 buttons play through: ONE object that speaks to the booted block's player (a swap brings a new one)
  var audioNow = null, audioHear = [];
  var homeAudio = {
    listen: function (s, name) { return audioNow ? audioNow.listen(s, name) : false; },
    onChange: function (f) { audioHear.push(f); if (audioNow) audioNow.onChange(f); },
    pause: function () { return audioNow ? audioNow.pause() : false; },
    resume: function () { return audioNow ? audioNow.resume() : false; },
    isPlaying: function () { return !!(audioNow && audioNow.isPlaying()); },
    playingSlug: function () { return audioNow && audioNow.playingSlug ? audioNow.playingSlug() : null; }
  };

  function boot(I) {
    var dock = null, dead = false, sw = null;
    frontSlug = I.front ? I.front.slug : '';
    var C = I.chat, slug = C ? C.slug : '';
    // ── the stage card: the front pad's stage, as today's homepage plays it (its tabs, Snap / Clip to the front pad's story) ──
    var box = $('rmStage');
    if (!cap && W.PATVStage && W.PATVStage.capture) cap = W.PATVStage.capture({ host: $('rmCap'), room: function () { return frontSlug; } });
    if (box && W.PATVStage && W.PATVStage.switcher) {
      var S = I.stage || {};
      sw = W.PATVStage.switcher({
        tabs: $('rmTabs'), wrap: $('rmVideo'), reconnect: $('rmStReconnect'), unmute: $('rmStUnmute'), embedHost: $('rmEmbed'), slug: frontSlug,
        onShow: function (sel) { if (dead) return; if (cap) cap.update(frontSlug ? sel : null); try { box.dispatchEvent(new CustomEvent('patv:stagechange', { detail: sel })); } catch (e) { /* old engine */ } },
        // the front pad changed mid-session: the block follows it (frontChanged below)
        onPoll: function (g) {
          if (dead || !g) return;
          if (g.front && g.front.slug && g.front.slug !== frontSlug) { frontChanged(g.front); return; }
          if (Object.prototype.hasOwnProperty.call(g, 'next')) nextChanged(g.next);   // newstream 1.99ala: the off-air bar's "Next up"
        },
        // (dock3 review 1.99akf MF2: THIS block's pad by the homepage's rules - home=1 - and `front` = what the front page shows now; polling
        // with no pad applied a new front pad's stage to this block until the swap - its 🎙 mic stage over the featured stream)
        api: frontSlug ? '/api/stage?room=' + encodeURIComponent(frontSlug) + '&home=1' : '/api/stage',
        slots: S.slots || [], pepeOn: !!S.pepeOn, pepeHere: S.pepeHere !== false, pepeWhep: S.pepeWhep || null, pepeSrc: S.pepeSrc || null, manage: !!S.manage, featured: S.featured || null,   // (dock3 1.99akf: the front pad's featured slot)
        posters: !!I.signed,                                // (upnext: the "Coming up next" card's poster - the site's proxy is for signed-in viewers)
        // (upnext2 review F5 / safety F10, 1.99alc: the off-air slate naming a booked 📼 start - {slate} - is OFF AIR here: the Dock's own off-air
        // bar says "Next up" - it was "on", and that bar went)
        onAir: function (on, sub, x) { var air = !!on && !(x && x.slate); box.classList.toggle('is-on', air); box.classList.toggle('is-off', !air); }
      });
    }
    function nextUpText() {
      var n = I.nextUp; if (!n || !n.at) return '';
      // (1.99ajh dockpop review: the site's own clock - localtime.js, the viewer's saved zone with its label - as today's off-air slate showed it)
      var time = '';
      try { time = W.PATVTime && W.PATVTime.format ? W.PATVTime.format(n.at, 'time') : new Date(n.at).toLocaleTimeString(D.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' }); } catch (e) { time = ''; }
      return _t('js.home.dock.next_up', 'Next up: {name} · {time}', { name: n.name + (n.title ? ' — ' + n.title : ''), time: time });
    }
    // newstream 1.99ala: the off-air bar's "Next up" was built once (pad-dock.js preview.nextUp) - a booking made since never showed, one that
    // started and ended stayed. The stage's own 10 s poll carries the pad's next booking (/api/stage ...&home=1 `next`); the bar's second
    // piece (.rmd-slim-b, after its " · ") follows it - added, rewritten or taken away. Text only.
    function nextChanged(n) {
      var nn = n && typeof n === 'object' && Number(n.start_at) > 0 && n.display ? { name: String(n.display).slice(0, 80), title: n.title ? String(n.title).slice(0, 120) : null, at: Number(n.start_at) } : null;
      var was = I.nextUp || null;
      if (was === nn || (was && nn && was.name === nn.name && was.title === nn.title && Number(was.at) === nn.at)) return;
      I.nextUp = nn;
      var slim = box ? box.querySelector('.rmd-slim-t') : null; if (!slim) return;
      var b = slim.querySelector('.rmd-slim-b'), sep = slim.querySelector('.rmd-slim-sep'), txt = nextUpText();
      if (!txt) { if (b) b.parentNode.removeChild(b); if (sep) sep.parentNode.removeChild(sep); return; }
      if (!b) { sep = el('span', 'rmd-slim-sep', ' · '); sep.setAttribute('aria-hidden', 'true'); slim.appendChild(sep); b = el('span', 'rmd-slim-b'); slim.appendChild(b); }
      b.textContent = txt;
    }

    // ── the chat card ──
    var feed = $('rmFeed'), scroll = $('rmScroll'), jump = $('rmJump');
    var CLR = W.PATVChatlog && typeof W.PATVChatlog.renderItem === 'function' ? W.PATVChatlog : null, H = CLR ? CLR.domH(D) : null;
    var rctx = { t: _t, lang: D.documentElement.lang || undefined, cfsticker: function (set, id) { return '/media/cfsticker/' + id + '.webp'; } };
    function plainName(u) { return !u || u.anon ? _t('js.home.room.someone', 'someone') : String(u.display || u.login || ''); }
    function avatar(u) { if (CLR) return CLR.avatarNode(u, rctx, H); var a = el('span', 'av anon', '?'); a.setAttribute('aria-hidden', 'true'); return a; }
    function name(u) {
      var n = CLR ? CLR.nameNode(u, rctx, H) : el('span', 'who', plainName(u));
      var tag = n.querySelector && n.querySelector('.veil-tag'); if (tag && !tag.title) tag.title = String(tag.textContent || '');   // (its full word when it shortens)
      return n;
    }
    function label(u) { return CLR ? CLR.label(u, rctx) : plainName(u); }
    // (1.99ajq dockpol (owner item 21): opts.flair - the bottom bar's holder chips show the speaker's flair; never for a veiled person)
    function person(u, opts) {
      var n = el('span', 'rmd-person'), who = el('span', 'rmd-person-name'); n.appendChild(avatar(u)); who.appendChild(name(u));
      if (opts && opts.flair && CLR && u && !u.veil && !u.anon) { var fl = CLR.flairNode(u, rctx, H); if (fl) who.appendChild(fl); }
      n.appendChild(who); return n;
    }
    /** a line as the pad Dock draws it - a COPY without rv: the homepage never offers a Reveal */
    function line(it) {
      if (!it) return null;
      var x = {}; for (var k in it) if (Object.prototype.hasOwnProperty.call(it, k) && k !== 'rv') x[k] = it[k];
      if (CLR) return CLR.renderItem(x, rctx, H);
      if (x.removed || (x.k !== 'msg' && x.k !== 'tx') || x.mask) return null;
      return el('div', 'sys', plainName(x.u) + ': ' + String(x.text == null ? '' : x.text));
    }
    if (!C || !feed || !scroll || !W.PATVRoom) { startDock(null, null, null); return handle(null, null, null, null); }
    var roomAudio = $('rmAudioBox') ? W.PATVRoom.audio($('rmAudioBox'), slug, { showOff: true, idle: _t('js.pad.dock.listen', 'Listen to the room') }) : null;
    if (roomAudio) { audioNow = roomAudio; audioHear.forEach(function (f) { roomAudio.onChange(f); }); W.PATVHomeAudio = homeAudio; }   // the Top Pads 🎧 buttons play through this player (one room at a time)
    var latest = I.initial || null, recent = [];
    /** the composer's name autocomplete - this page's own roster (mic + members; no 🌐 list here), recent speakers last */
    function acPeople() {
      var out = [], seen = {};
      function add(u, rec) {
        if (!u || u.self || u.bot || u.me) return;
        var veil = u.veil === 'incognito' && u.anon && u.alias ? 'incognito' : null;
        if (u.anon && !veil) return;
        var value = veil ? String(u.alias) : String(u.login || '');
        if (!value || /^u:/i.test(value)) return;
        var k = value.toLowerCase(); if (seen[k]) return; seen[k] = 1;
        var shown = label(u), cmd = !veil && !u.web && !u.acct && !!u.login && !/^u:/i.test(String(u.login));
        // 1.99ajn padppl review fix (owner point 24, here too): after "@" the name the person SHOWS as on PATV (a frog name stays a frog name),
        // never their Camfrog login (that's for commands: `value`), with `ref` = exactly who it is - the same as the pad page (room.ejs acPeople)
        var lg = String(u.login || ''), un = !veil && u.patv && u.patv.username ? String(u.patv.username) : '';
        var ref = veil ? (u.id ? { k: 'veil', id: String(u.id) } : null) : lg && !u.acct ? { k: 'login', v: lg } : un ? { k: 'user', v: un } : null;
        var sub = un && un.toLowerCase() !== String(shown).toLowerCase() ? '@' + un : (!veil && lg && lg.toLowerCase() !== String(shown).toLowerCase() ? lg : '');
        out.push({ value: value, atValue: veil ? String(u.alias) : String(shown || value), ref: ref, name: shown, login: sub, tag: veil ? _t('js.pad.veil.incognito', 'incognito') : '',
                   u: u, recent: !!rec, cmd: cmd });
      }
      (latest && latest.mic || []).forEach(function (u) { add(u); });
      (latest && latest.members || []).forEach(function (u) { add(u); });
      recent.slice().reverse().forEach(function (u) { add(u, true); });
      return out;
    }
    function nearBottom() { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80; }
    function toBottom() { scroll.style.scrollBehavior = 'auto'; scroll.scrollTop = scroll.scrollHeight; scroll.style.scrollBehavior = ''; if (jump) jump.style.display = 'none'; }
    // (1.99ajh dockpop review: the viewer tag rides every line - the site refuses one from a page made for another account)
    var relayHost = $('rmRelay'), roomRelay = relayHost ? W.PATVRoom.relay(relayHost, slug, { feed: feed, line: line, scroller: scroll, onBottom: function () { if (jump) jump.style.display = 'none'; },
      people: acPeople, avatar: avatar, placeholder: _t('js.pad.dock.placeholder', 'Message {room}…', { room: C.name }), vt: I.vt || null,
      onCmd: function (row) { if (dock && dock.cmd) dock.cmd(row); } }) : null;   // 1.99ajq dockpol (owner item 22): command toasts
    var pttHost = $('rmPtt'), roomPtt = pttHost ? W.PATVRoom.ptt(pttHost, slug) : null, compose = $('rmCompose');
    if (jump) jump.addEventListener('click', function () { toBottom(); });
    // (a reader who scrolled up stays where they are; the box changing size while the page settles is never that - only a scroll at the
    // same box height counts)
    var atEnd = true, lastCh = -1;
    scroll.addEventListener('scroll', function () {
      var ch = scroll.clientHeight;
      if (ch === lastCh) atEnd = nearBottom();
      lastCh = ch;
      if (atEnd && jump) jump.style.display = 'none';
    });
    // (the cards settle after the first lines are drawn - the stage's size, a font, the off-air bar: a log at its newest line stays there)
    // (and when the lines themselves grow - a web font, an avatar or a sticker arriving after the first draw)
    var ro = null;
    if (W.ResizeObserver) { ro = new W.ResizeObserver(function () { if (atEnd && scroll.clientHeight) toBottom(); }); ro.observe(scroll); ro.observe(feed); }

    // the lines: the feed cursors already shown (a late line goes in its place), A/V sync holds a live grab / drop line, the newest 120
    var cursor = 0, started = false, haveC = {}, haveList = [], maxC = 0, jcTok = null, jcAt = 0, histV = null, lastP = '';
    function revealHeld(n, show) { var near = nearBottom(); show(); if (near) toBottom(); }
    function refilter(h) {
      var f = h && h.floor; if (!f) return;
      Array.prototype.slice.call(feed.childNodes).forEach(function (n) {
        if (!n._c || !n._ts || n._c > jcAt) return;
        var floor = n._k === 'tx' ? f.tx : (n._k === 'join' || n._k === 'leave' || n._k === 'mic' || n._k === 'unmic') ? f.presence : f.chat;
        if (n._ts < floor) feed.removeChild(n);
      });
    }
    function drawPeople(members) {
      var ul = $('rmPeople'); if (!ul) return;
      var pk = JSON.stringify(members || []); if (pk === lastP) { if (dock) dock.peopleDrawn(); return; }
      lastP = pk; ul.textContent = '';
      var ms = (members || []).filter(function (u) { return u && !u.self; }).sort(function (a, b) {
        return (b.on_mic ? 1 : 0) - (a.on_mic ? 1 : 0) || (a.anon ? 1 : 0) - (b.anon ? 1 : 0) || label(a).localeCompare(label(b));
      });
      ms.forEach(function (u) {
        var li = el('li'); li.appendChild(avatar(u));
        var n = el('span', 'nm'); n.appendChild(name(u));
        if (CLR && !u.veil) { var fl = CLR.flairNode(u, rctx, H); if (fl) n.appendChild(fl); }
        li.appendChild(n);
        var ic = el('span', 'ic');
        if (u.on_mic) { li.classList.add('rmd-on-mic'); var m = el('span', 'rmd-mic', '🎙️'); m.title = _t('js.pad.people.on_mic', 'On the mic'); ic.appendChild(m); }
        li.appendChild(ic); ul.appendChild(li);
      });
      var pn = $('rmPplN'); if (pn) pn.textContent = ms.length ? String(ms.length) : '';
      if (dock) dock.peopleDrawn();
    }
    function drawMic(list) { if (dock) dock.mic(Array.isArray(list) ? list : []); }
    function drawHeard(v) {
      try { drawMic(v && Array.isArray(v.mic) ? v.mic : []); } catch (e) { /* the next answer draws it */ }
      try { if (v && Array.isArray(v.members)) drawPeople(v.members); } catch (e) { /* the next answer draws it */ }
    }
    // (owner H5) the front pad's mic stage, only for the viewer the page says it is for; cover controls never reach the homepage
    function micProgram(p) {
      if (!p || typeof p !== 'object') return p || null;
      var q = {}; for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k) && k !== 'manage' && k !== 'report') q[k] = p[k];
      q.src = (Array.isArray(p.src) ? p.src : []).map(function (s) { var x = {}; for (var j in s) if (Object.prototype.hasOwnProperty.call(s, j) && j !== 'rv' && j !== 'ex' && j !== 'cv' && j !== 'self') x[j] = s[j]; return x; });
      return q;
    }
    function stageMic(d) {
      if (!I.micStage || !sw || !sw.setMic || !C || !C.onStage) return;
      // (1.99ajq dockpol fix (review): after a swap to a front pad whose mic stage this viewer may see, the page may not have its script yet -
      // it is loaded once, and the latest answer drawn when it arrives)
      if (!W.PATVStageMic) { if (I.micJs && !micScript) { micScript = D.createElement('script'); micScript.src = I.micJs; micScript.async = true; micScript.onload = function () { try { if (cur && cur.redrawMic) cur.redrawMic(); } catch (e) { /* the next answer draws it */ } }; D.head.appendChild(micScript); } return; }
      var show = function (p) { if (dead) return; sw.setMic(p); if (dock && dock.talking) dock.talking(p); };
      var prog = micProgram(d && d.stage_program || null);
      if (W.PATVAvSync && W.PATVAvSync.gateProgram) W.PATVAvSync.gateProgram(slug, prog, show); else show(prog);
    }
    // upnext2: the pad's stage version the last answer carried (mainstage.stageBump) - a move = the stage card asks /api/stage now
    var stvSeen = null;
    function apply(d, late) {
      if (!d || dead) return;
      latest = d;
      // upnext2: a 📼 "Coming up next" was set / its stream came up on the pad whose chat this is - when it's also the stage's pad, the stage
      // asks now (the card within a round trip, not at its next 10 s poll); the first answer only notes where it is (review fixes 1.99alc: the
      // switcher keeps it - sw.stv - and knows the long-poll wakes it: no faster poll while a 📼 title is on)
      if (d.stv != null) {
        stvSeen = d.stv;
        if (sw && typeof sw.stv === 'function' && slug && slug === frontSlug) { try { sw.stv(d.stv); } catch (e) { /* the 10 s poll */ } }
      }
      // 1.99ajn padppl review fix: the viewer's own blocks (their named lines fold) and who they are (lines that @mention them are marked) -
      // as on the pad page (chatlog-core.js ctx.blk / ctx.me)
      rctx.blk = d.blk || null;
      if (d.me && d.me.patv) rctx.me = { username: d.me.patv.username, login: /^u:/i.test(String(d.me.login || '')) ? null : d.me.login, display: d.me.display };
      var near = !started || nearBottom();
      if (started && d.cursor < cursor) { started = false; cursor = 0; }
      if (d.jc) { jcTok = d.jc; jcAt = Number(String(d.jc).split('.')[1]) || jcAt; }
      if (d.history) { if (histV != null && d.history.v !== histV) refilter(d.history); histV = d.history.v; }
      if (d.removed && d.removed.length) {
        var gone = {}; d.removed.forEach(function (c) { gone[c] = 1; });
        Array.prototype.slice.call(feed.childNodes).forEach(function (x) { if (x._c && gone[x._c]) feed.removeChild(x); });
      }
      if (!started) { feed.textContent = ''; haveC = {}; haveList = []; maxC = 0; if (roomRelay && roomRelay.reset) roomRelay.reset(); }
      var anchor = roomRelay && roomRelay.anchor ? roomRelay.anchor() : null;
      // (the newest 120, plus an older one that names YOUR say job: the relay outbox swaps your pending line only for a line it really shows)
      var all = d.feed || [];
      var shown = all.length > 120 ? all.filter(function (it, i) { return i >= all.length - 120 || it.job || it.cid; }) : all;
      var held = [], added = 0;
      shown.forEach(function (it) {
        if (it.c && haveC[it.c]) return;
        if (it.c) { haveC[it.c] = 1; haveList.push(it.c); }
        var n = line(it); if (!n) return;
        added++;
        n._c = it.c || 0; n._ts = Number(it.ts) || 0; n._k = it.k;
        if ((it.k === 'msg' || it.k === 'tx') && it.u && !it.u.self && !it.mask) { recent.push(it.u); if (recent.length > 30) recent.shift(); }
        if (started && !late && (it.k === 'mic' || it.k === 'unmic')) held.push(n);
        if (it.c && it.c < maxC) {
          for (var k = 0; k < feed.childNodes.length; k++) { var x = feed.childNodes[k]; if (x._c && x._c > it.c) { feed.insertBefore(n, x); return; } }
        }
        if (anchor && anchor.parentNode === feed) feed.insertBefore(n, anchor); else feed.appendChild(n);
      });
      if (held.length && W.PATVAvSync && W.PATVAvSync.holdLine) held.forEach(function (n) { try { W.PATVAvSync.holdLine(slug, n, revealHeld); } catch (e) { n.style.display = ''; } });
      (d.feed || []).forEach(function (it) { if (it.c > maxC) maxC = it.c; });
      while (haveList.length > 1000) delete haveC[haveList.shift()];
      if (!started && !feed.childNodes.length) feed.appendChild(el('p', 'muted', _t('js.home.room.quiet', 'Quiet right now — lines show up here the moment someone talks.')));
      if (started && added && feed.firstChild && feed.firstChild.tagName === 'P') feed.removeChild(feed.firstChild);
      while (feed.childNodes.length > 120) feed.removeChild(feed.firstChild);
      if (near) toBottom(); else if (added && jump) jump.style.display = 'block';
      started = true;
      cursor = Math.max(cursor, d.cursor || 0);
      var r = d.room || {};
      var tp = $('rmTopic'); if (tp) tp.textContent = String(r.topic || '').trim();
      if (compose) compose.classList.toggle('hide', !(r.relay || r.micRelay));
      if (roomAudio) roomAudio.update(d);
      if (roomRelay) roomRelay.update(shown === all ? d : Object.assign({}, d, { feed: shown }));
      if (roomPtt) roomPtt.update(d);
      var miss = roomRelay && roomRelay.refetch ? roomRelay.refetch() : 0;
      if (miss && miss <= cursor) cursor = miss - 1;
      var micNow = d.mic || [], peopleNow = d.members || [];
      if (W.PATVAvSync && W.PATVAvSync.micView) {
        try {
          var heard = W.PATVAvSync.micView(slug, { members: d.members, mic: d.mic }, drawHeard);
          if (heard && Array.isArray(heard.mic)) micNow = heard.mic;
          if (heard && Array.isArray(heard.members)) peopleNow = heard.members;
        } catch (e) { micNow = d.mic || []; peopleNow = d.members || []; }
      }
      if (dock) dock.update(d);
      drawMic(micNow); drawPeople(peopleNow);
      try { stageMic(d); } catch (e) { /* the next answer draws it */ }
    }

    // the long-poll (?wait=1, as today's widget; an older site's answer without `lp` is asked again every 3 s). It stands down while the
    // pad's chat is open in its own window (onPopped) and while the tab is hidden.
    var lp = { ok: false, v: null, mv: null }, inflight = false, timer = null, fails = 0, behind = false, suspended = false, ctl = null, again = false;
    function poll() {
      timer = null;
      if (dead || D.hidden || inflight || suspended) return;
      inflight = true;
      var q = '?after=' + cursor + '&wait=1' + (lp.v != null ? '&v=' + lp.v : '') + (lp.mv != null ? '&mv=' + lp.mv : '') +
        (roomRelay && roomRelay.wantsMe && roomRelay.wantsMe() ? '&me=1' : '') + (jcTok ? '&jc=' + encodeURIComponent(jcTok) : '') +
        (I.micStage ? '&home=1' : '');                 // (owner H5: the mic stage without any cover's Reveal / ✕ / View cam)
      try { ctl = W.AbortController ? new AbortController() : null; } catch (e) { ctl = null; }
      var opts = { credentials: 'same-origin', cache: 'no-store' }; if (ctl) opts.signal = ctl.signal;
      fetch('/api/rooms/' + encodeURIComponent(slug) + '/live' + q, opts)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          if (suspended || dead) return;
          fails = 0; lp.ok = !!d.lp && !d.gone;
          if (d.reinit) { jcTok = null; started = false; cursor = 0; lp.ok = true; return; }
          if (d.gone) return;
          if (d.ver != null) lp.v = d.ver;
          if (d.mver != null) lp.mv = d.mver;
          var late = behind; behind = !!D.hidden;
          apply(d, late);
          if (late && W.PATVAvSync && W.PATVAvSync.caughtUp) { try { W.PATVAvSync.caughtUp(slug); } catch (e) { /* optional timing */ } }
        })
        .catch(function () { if (suspended || again || dead) return; fails++; behind = true; lp.ok = false; })
        .then(function () {
          inflight = false; ctl = null;
          if (dead) return;
          if (again) { again = false; clearTimeout(timer); timer = null; poll(); return; }
          if (!timer && !D.hidden && !suspended) timer = setTimeout(poll, fails ? Math.min(30000, 3000 * Math.pow(2, fails)) : (lp.ok ? 50 : 3000));
        });
    }
    function now() { if (suspended || dead) return; if (inflight) { again = true; try { if (ctl) ctl.abort(); } catch (e) { /* done */ } return; } clearTimeout(timer); timer = null; poll(); }
    function onVis() { if (dead) return; if (D.hidden) behind = true; else if (!timer) poll(); }
    D.addEventListener('visibilitychange', onVis);
    /** the pad's chat is in its own window: no poll (its AbortController stops the one in flight), the audio paused (pad-dock.js) */
    function onPopped(yes) {
      if (yes) { suspended = true; clearTimeout(timer); timer = null; try { if (ctl) ctl.abort(); } catch (e) { /* done */ } return; }
      // the window closed: a fresh view (cursor 0), polled at once
      suspended = false; started = false; cursor = 0; jcTok = null; lp = { ok: false, v: null, mv: null }; behind = true;
      clearTimeout(timer); timer = null; if (!inflight) poll(); else again = true;
    }
    startDock(roomRelay, roomAudio, roomPtt);
    if (I.initial) apply(I.initial);
    timer = setTimeout(poll, 300);
    // 1.99ajh dockpop review (owner: nothing shown twice): the chat's own pad in Top Pads keeps its rank and link, but not the count, the mic
    // line or 🎧 - the chat card above has them (its 👥, its audio bar and holders)
    try {
      Array.prototype.forEach.call(D.querySelectorAll('#stageSide .tp li'), function (li) {
        var was = li.querySelector('.hmd-here-t'); if (was) was.remove(); li.classList.remove('hmd-here');
        var ls = li.querySelector('[data-listen]');
        if (!ls || ls.getAttribute('data-listen') !== slug) return;
        li.classList.add('hmd-here'); var a = li.querySelector('a');
        var note = el('span', 'hmd-here-t', _t('js.home.dock.tp_here', '↑ In the chat above')); (a || li).appendChild(note);
      });
    } catch (e) { /* the list is the homepage's own */ }
    return handle(roomAudio, roomRelay, roomPtt, function () {
      clearTimeout(timer); timer = null; try { if (ctl) ctl.abort(); } catch (e) { /* done */ }
      D.removeEventListener('visibilitychange', onVis); if (ro) ro.disconnect();
    });

    function startDock(relay, audio, ptt) {
      if (!W.PATVPadDock) return;
      var staff = I.staff || null, about = $('hmdAbout');
      dock = W.PATVPadDock.init({
        mode: 'preview', root: root, slug: C ? C.slug : frontSlug, room: C ? C.id : null, vt: I.vt || null,
        signed: !!I.signed, linked: !!I.linked, user: I.user || null, relay: relay, audio: audio, ptt: ptt, person: person,
        padHref: frontSlug ? '/p/' + encodeURIComponent(frontSlug) : '/p', padName: I.front ? I.front.title : '',
        // (1.99ajh dockpop review: no ↗️ for the sign-in tease - the route would only send the pop-up to the pad's gate page)
        chatUrl: C && I.initial ? '/p/' + encodeURIComponent(C.slug) + '/chat' : null,
        preview: { goLive: I.goLive || null, staff: staff, nextUp: nextUpText(), about: about || null,
                   roomLink: C && !C.onStage ? { href: '/p/' + encodeURIComponent(C.slug), name: C.name } : null },
        toBottom: C ? toBottom : null, recheck: function () { if (C) now(); }, onPopped: C ? onPopped : null
      });
    }
    /** this block's lifetime: busy() = the viewer is in the middle of something here; teardown() stops all of it for a swap */
    function handle(audio, relay, ptt, stop) {
      return {
        front: I.front ? I.front.slug : '', slug: slug, dock: function () { return dock; },
        redrawMic: function () { if (!dead && latest) stageMic(latest); },
        // (1.99ajq dockpol fix (review): focus alone isn't "busy" - the log a viewer clicked, a button, or the composer just after a send (empty
        // and not typed in for 15 s) let the swap happen; a draft, a field being typed in, an open sheet / menu or holding to talk don't)
        busy: function () {
          var input = relay && relay.getInput ? relay.getInput() : null, hmd = $('hmDock'), a = D.activeElement;
          if (input && String(input.value || '').trim()) return true;
          if (hmd && a && a !== D.body && hmd.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && Date.now() - typedAt < 15000) return true;
          if (D.querySelector('.rmd-menu, .rmd-layer, .pm-pop')) return true;
          // (relaymic review F1 1.99anh: and the release tail - .rb-sending, "Sending…" until the clip's upload has started: a swap then tore
          // down - ptt.destroy() - a clip the viewer had already let go of, without a word)
          var talk = $('rmPtt') && $('rmPtt').querySelector('.rb-talk[aria-pressed="true"], .rb-talk.rb-sending'); if (talk) return true;
          return !!(dock && dock.popped && dock.popped());
        },
        playing: function () { return !!(audio && audio.isPlaying && audio.isPlaying()); },
        teardown: function () {
          dead = true;
          if (stop) stop();
          try { if (audio && audio.pause) audio.pause(); } catch (e) { /* stopped */ }
          try { if (audio && audio.destroy) audio.destroy(); } catch (e) { /* gone */ }   // (1.99ajq dockpol fix: its timer and its place in the page's player list go too)
          try { if (relay && relay.destroy) relay.destroy(); } catch (e) { /* gone */ }
          try { if (ptt && ptt.destroy) ptt.destroy(); } catch (e) { /* gone */ }
          try { if (sw && sw.destroy) sw.destroy(); } catch (e) { /* gone */ }
          try { if (dock && dock.destroy) dock.destroy(); } catch (e) { /* gone */ }
          dock = null;
        }
      };
    }
  }

  // ── 1.99ajq dockpol (owner H6): the front pad changed - fetch its block (GET /?dock=1: the same gates as the page; a viewer who may not see the
  // new front gets whatever the server renders for them) and swap it in while the viewer is idle; busy, a chip on the stage's top bar offers it ──
  var typedAt = 0, micScript = null;
  D.addEventListener('keydown', function (e) { var a = e.target; if (a && a.closest && a.closest('#hmDock')) typedAt = Date.now(); }, true);
  D.addEventListener('input', function (e) { var a = e.target; if (a && a.closest && a.closest('#hmDock')) typedAt = Date.now(); }, true);
  var cur = boot(parse($('hmdInit'))), pendingFront = null, swapping = false, chip = null, skipSlug = null;
  function frontChanged(f) {
    if (f.slug === skipSlug) return;                  // (the server rendered another block for this viewer last time: not again and again)
    pendingFront = f;
    if (cur && cur.busy()) { offerSwitch(f); return; }
    swap();
  }
  function offerSwitch(f) {
    var top = D.querySelector('#rmStage .rmd-ov-top'); if (!top) return;
    if (!chip || !chip.isConnected) {
      chip = el('button', 'ds-btn sm rmd-front-chip'); chip.type = 'button';
      chip.addEventListener('click', function () { swap(); });
      top.appendChild(chip);
    }
    var words = _t('js.home.dock.front_changed', '📡 Now on the front page: {pad}', { pad: String(f.title || f.slug) }) + ' · ' + _t('js.home.dock.switch', 'Switch');
    chip.textContent = words; chip.setAttribute('aria-label', words); chip.title = words;
    // (once the viewer is done - their draft sent, the sheet closed - it switches by itself)
    clearTimeout(offerSwitch.t);
    offerSwitch.t = setTimeout(function idle() { if (!pendingFront) return; if (cur && cur.busy()) { offerSwitch.t = setTimeout(idle, 4000); return; } swap(); }, 4000);
  }
  function swap() {
    if (swapping || !pendingFront) return;
    swapping = true;
    var resumeAudio = !!(cur && cur.playing());
    fetch('/?dock=1', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (html) {
        var tpl = D.createElement('template'); tpl.innerHTML = html;
        var next = tpl.content.querySelector('#hmDock'), init = tpl.content.querySelector('#hmdInit'), old = $('hmDock');
        if (!next || !init || !old) throw new Error('no block');
        var I = parse(init), want = pendingFront.slug;
        if (!I.front || I.front.slug !== want) skipSlug = want;
        if (cur) cur.teardown();
        // (the one capture row keeps its node; the rest is the new pad's)
        var oldCap = $('rmCap'), newCap = next.querySelector('#rmCap');
        if (oldCap && newCap) newCap.replaceWith(oldCap);
        old.replaceWith(next);
        var oldInit = $('hmdInit'); if (oldInit) oldInit.replaceWith(init); else root.appendChild(init);
        // the front pad's accent (its look) - or none
        root.classList.toggle('pad-acc', next.getAttribute('data-rmd-acc') === '1');
        var vars = next.getAttribute('data-rmd-vars') || ''; if (vars) root.setAttribute('style', vars); else root.removeAttribute('style');
        if (chip && chip.isConnected) chip.remove(); chip = null; pendingFront = null;
        cur = boot(I);
        if (cap) cap.reload();
        if (W.PATVChipFit && W.PATVChipFit.run) W.PATVChipFit.run();
        // the room audio: on again here when it was playing and the new pad's room may be heard (a blocked autoplay says "tap ▶")
        if (resumeAudio && I.initial && audioNow && audioNow.resume) { try { audioNow.resume(); } catch (e) { /* blocked */ } }
      })
      .catch(function () { /* the next stage poll asks again */ })
      .then(function () { swapping = false; });
  }
})(window, document);
