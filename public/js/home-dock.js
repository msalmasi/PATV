// home-dock.js - 1.99ajh dockpop (owner P2: "a version of the new room dock for the main page that uses the same principles for preview
// mode"): the homepage's Room Dock (views/home.ejs while homeDock_). ONE stage card - the FRONT pad's stage (Pepe's stream + its slots,
// public/js/stage-room.js) under the pad Dock's auto-hiding overlay - and ONE slim chat card - the panel pad's live chat as the pad Dock
// draws it (public/js/chatlog-core.js lines, the bottom audio bar, a one-row composer for linked viewers), both decorated by
// public/js/pad-dock.js in 'preview' mode. The homepage's rules stay its own: the same /api/rooms/:slug/live long-poll as today's widget
// (no pad=1 - a homepage visitor is never on a pad's people list; no room PM; no Reveal: rv is dropped from every line), no line menus,
// clips or person menus, the newest 120 lines. While the pad's chat is open in its own window (/p/<slug>/chat, same pad and account) this
// card stands down: its poll stops and its audio pauses, and it starts fresh when the window closes. Plain ES5.
(function (W, D) {
  'use strict';
  var _t = typeof W.__t === 'function' ? W.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var initEl = D.getElementById('hmdInit'), root = D.querySelector('main.rm.rm-dock.rmd-home');
  if (!initEl || !root) return;
  var I = {}; try { I = JSON.parse(initEl.textContent) || {}; } catch (e) { I = {}; }
  function $(id) { return D.getElementById(id); }
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var dock = null;

  // ── the stage card: the front pad's stage, as today's homepage plays it (its tabs, Snap / Clip to the front pad's story) ──
  var box = $('rmStage'), frontSlug = I.front ? I.front.slug : '';
  if (W.PATVAvSync) W.PATVAvSync.pad(function () { return frontSlug; });
  var cap = W.PATVStage && W.PATVStage.capture ? W.PATVStage.capture({ host: $('rmCap'), room: function () { return frontSlug; } }) : null;
  if (box && W.PATVStage && W.PATVStage.switcher) {
    var S = I.stage || {};
    W.PATVStage.switcher({
      tabs: $('rmTabs'), wrap: $('rmVideo'), reconnect: $('rmStReconnect'), unmute: $('rmStUnmute'), embedHost: $('rmEmbed'),
      onShow: function (sel) { if (cap) cap.update(frontSlug ? sel : null); try { box.dispatchEvent(new CustomEvent('patv:stagechange', { detail: sel })); } catch (e) { /* old engine */ } },
      // the front pad changed mid-session: capture follows it, the chip becomes a plain link to the new pad (the cosmetics were the old one's)
      onPoll: function (g) {
        if (!g || !g.front || !g.front.slug || g.front.slug === frontSlug) return;
        frontSlug = g.front.slug; if (cap) cap.reload();
        if (dock && dock.retitle) dock.retitle('/p/' + encodeURIComponent(g.front.slug), String(g.front.title || g.front.slug));
        root.classList.remove('pad-acc'); root.removeAttribute('style');
      },
      api: '/api/stage', slots: S.slots || [], pepeOn: !!S.pepeOn, pepeHere: S.pepeHere !== false, pepeWhep: S.pepeWhep || null, pepeSrc: S.pepeSrc || null, manage: !!S.manage,
      onAir: function (on) { box.classList.toggle('is-on', !!on); box.classList.toggle('is-off', !on); }
    });
  }
  function nextUpText() {
    var n = I.nextUp; if (!n || !n.at) return '';
    // (1.99ajh dockpop review: the site's own clock - localtime.js, the viewer's saved zone with its label - as today's off-air slate showed it)
    var time = '';
    try { time = W.PATVTime && W.PATVTime.format ? W.PATVTime.format(n.at, 'time') : new Date(n.at).toLocaleTimeString(D.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' }); } catch (e) { time = ''; }
    return _t('js.home.dock.next_up', 'Next up: {name} · {time}', { name: n.name + (n.title ? ' — ' + n.title : ''), time: time });
  }

  // ── the chat card ──
  var C = I.chat, feed = $('rmFeed'), scroll = $('rmScroll'), jump = $('rmJump');
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
  function person(u) { var n = el('span', 'rmd-person'), who = el('span', 'rmd-person-name'); n.appendChild(avatar(u)); who.appendChild(name(u)); n.appendChild(who); return n; }
  /** a line as the pad Dock draws it - a COPY without rv: the homepage never offers a Reveal */
  function line(it) {
    if (!it) return null;
    var x = {}; for (var k in it) if (Object.prototype.hasOwnProperty.call(it, k) && k !== 'rv') x[k] = it[k];
    if (CLR) return CLR.renderItem(x, rctx, H);
    if (x.removed || (x.k !== 'msg' && x.k !== 'tx') || x.mask) return null;
    return el('div', 'sys', plainName(x.u) + ': ' + String(x.text == null ? '' : x.text));
  }
  if (!C || !feed || !scroll || !W.PATVRoom) { startDock(null, null, null); return; }
  var slug = C.slug;
  var roomAudio = $('rmAudioBox') ? W.PATVRoom.audio($('rmAudioBox'), slug, { showOff: true, idle: _t('js.pad.dock.listen', 'Listen to the room') }) : null;
  if (roomAudio) W.PATVHomeAudio = roomAudio;       // the Top Pads 🎧 buttons play through this player (one room at a time)
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
      out.push({ value: value, name: shown, login: !veil && u.login && String(u.login).toLowerCase() !== String(shown).toLowerCase() ? String(u.login) : '', tag: veil ? _t('js.pad.veil.incognito', 'incognito') : '', u: u, recent: !!rec, cmd: cmd });
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
    people: acPeople, avatar: avatar, placeholder: _t('js.pad.dock.placeholder', 'Message {room}…', { room: C.name }), vt: I.vt || null }) : null;
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
  if (W.ResizeObserver) { var ro = new W.ResizeObserver(function () { if (atEnd && scroll.clientHeight) toBottom(); }); ro.observe(scroll); ro.observe(feed); }

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
  function apply(d, late) {
    if (!d) return;
    latest = d;
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
  }

  // the long-poll (?wait=1, as today's widget; an older site's answer without `lp` is asked again every 3 s). It stands down while the
  // pad's chat is open in its own window (onPopped) and while the tab is hidden.
  var lp = { ok: false, v: null, mv: null }, inflight = false, timer = null, fails = 0, behind = false, suspended = false, ctl = null, again = false;
  function poll() {
    timer = null;
    if (D.hidden || inflight || suspended) return;
    inflight = true;
    var q = '?after=' + cursor + '&wait=1' + (lp.v != null ? '&v=' + lp.v : '') + (lp.mv != null ? '&mv=' + lp.mv : '') +
      (roomRelay && roomRelay.wantsMe && roomRelay.wantsMe() ? '&me=1' : '') + (jcTok ? '&jc=' + encodeURIComponent(jcTok) : '');
    try { ctl = W.AbortController ? new AbortController() : null; } catch (e) { ctl = null; }
    var opts = { credentials: 'same-origin', cache: 'no-store' }; if (ctl) opts.signal = ctl.signal;
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/live' + q, opts)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (suspended) return;
        fails = 0; lp.ok = !!d.lp && !d.gone;
        if (d.reinit) { jcTok = null; started = false; cursor = 0; lp.ok = true; return; }
        if (d.gone) return;
        if (d.ver != null) lp.v = d.ver;
        if (d.mver != null) lp.mv = d.mver;
        var late = behind; behind = !!D.hidden;
        apply(d, late);
        if (late && W.PATVAvSync && W.PATVAvSync.caughtUp) { try { W.PATVAvSync.caughtUp(slug); } catch (e) { /* optional timing */ } }
      })
      .catch(function () { if (suspended || again) return; fails++; behind = true; lp.ok = false; })
      .then(function () {
        inflight = false; ctl = null;
        if (again) { again = false; clearTimeout(timer); timer = null; poll(); return; }
        if (!timer && !D.hidden && !suspended) timer = setTimeout(poll, fails ? Math.min(30000, 3000 * Math.pow(2, fails)) : (lp.ok ? 50 : 3000));
      });
  }
  function now() { if (suspended) return; if (inflight) { again = true; try { if (ctl) ctl.abort(); } catch (e) { /* done */ } return; } clearTimeout(timer); timer = null; poll(); }
  D.addEventListener('visibilitychange', function () { if (D.hidden) behind = true; else if (!timer) poll(); });
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
      var ls = li.querySelector('[data-listen]');
      if (!ls || ls.getAttribute('data-listen') !== slug || li.querySelector('.hmd-here-t')) return;
      li.classList.add('hmd-here'); var a = li.querySelector('a');
      var note = el('span', 'hmd-here-t', _t('js.home.dock.tp_here', '↑ In the chat above')); (a || li).appendChild(note);
    });
  } catch (e) { /* the list is the homepage's own */ }

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
})(window, document);
