// stories.js — the story viewer (1.99bz): Pepe's room captures, IG-style.
//
// Opens from the story strip (views/partials/story-strip.ejs): a room circle starts at that room's
// first unseen capture, a capture thumbnail at that capture. Full screen on phones, a 9:16 frame on
// desktop.
//   tap right / left      next / previous capture (past the ends: the next / previous room)
//   swipe left / right    next / previous room
//   swipe down, Esc, ✕    close
//   press and hold        pause (Space on a keyboard); M mutes clips
//   ← →                   previous / next capture; ↑ ↓ previous / next room
// Photos show for 5 s, clips and audio for their length. Seen state: POST /api/stories/seen (signed in),
// mirrored in localStorage (patvStorySeen: {room: upto}) - wrapped in try/catch, a convenience only.
// Signed-out visitors get a sign-in prompt instead of the viewer.
// 1.99eq: keeping a capture (storykeep.js) - "📌 Post to pad" (a permanent post in its pad, credited to whoever took it;
// optional caption) and "🔖 Save" (the member's private /u/<me>/saved). Shown per item from its `can` / `saved` /
// `posted` flags (forViewer); the server checks everything again (who may post, private subjects, removed / expired).
// 1.99ez: members' own stories (source "user": "<name>'s story", 🗑 Delete for the uploader / the pad's owner / mods /
// staff - can.del) and person stories (a member's uploads + captures of them; each capture says which pad it's from;
// the member themselves gets "🙈 Hide from my story" on captures - it doesn't delete the capture).
// 1.99fn: a pad's capture strip (.ss[data-scope=<pad id>]) opens /api/stories?room=<pad id> - that pad's story alone -
// instead of the site-wide list (which ran on from the pad into other pads and members' profile stories). Members' snap /
// clip stories now show 🔖 Save too (can.save from the server).
// storyreact site (storyreact.js): a reaction row at the bottom of each story, driven only by the item's `react` (none = no
// row, today's layout): "Reply to {name}…" (a sheet: quick emoji + a text box; the reply is a direct message), ▲ score ▼
// (optimistic, settled by the server; your own story can't be ▼'d) and 💸 (the post-tip sheet, opened above the viewer,
// lazy-loaded when the page doesn't have it). Hidden while an NSFW story is still blurred and on a gone one. The story pauses
// while a sheet is open; typing never drives the viewer; drafts live in memory only. data-me = the signed-in username.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function escH(s) { return String(s).replace(/[&<>"]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'; }); }
  var ME = (document.currentScript && document.currentScript.getAttribute('data-me')) || '';
  if (window.__patvStories) return;
  window.__patvStories = true;
  function meName() {
    if (ME) return ME;
    var s = document.querySelector('script[data-me]');
    return s ? s.getAttribute('data-me') || '' : '';
  }
  var QUICK = ['😂', '😮', '😍', '😢', '👏', '🔥', '🎉', '💯'];   // storyreact.QUICK (the server checks)

  var PHOTO_MS = 5000, LS_KEY = 'patvStorySeen';
  var data = null;                            // the list the viewer is on: [{id, title, href, latest, seen, items: [...]}]
  // 1.99fn: lists per SCOPE - '' = the page's inline list / the site-wide /api/stories, '<pad id>' = that one pad's story
  // (/api/stories?room=). A pad's capture strip opens its own scope, so the viewer never runs on into other pads or into
  // members' profile (person) stories.
  var cache = {}, loads = {};
  var V = null;                               // the viewer's DOM + state

  // ── seen state ──
  function lsGet() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function lsSet(room, upto) {
    try {
      var m = lsGet(); if (!(m[room] >= upto)) m[room] = upto;
      var keys = Object.keys(m); if (keys.length > 200) keys.sort(function (a, b) { return m[a] - m[b]; }).slice(0, keys.length - 200).forEach(function (k) { delete m[k]; });
      localStorage.setItem(LS_KEY, JSON.stringify(m));
    } catch (e) { /* private mode */ }
  }
  var pendingSeen = {}, seenTimer = null;
  function flushSeen() {
    clearTimeout(seenTimer); seenTimer = null;
    Object.keys(pendingSeen).forEach(function (room) {
      var upto = pendingSeen[room]; delete pendingSeen[room];
      try {
        fetch('/api/stories/seen', { method: 'POST', credentials: 'same-origin', keepalive: true,
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ room: room, upto: upto }) }).catch(function () {});
      } catch (e) { /* offline */ }
    });
  }
  function markSeen(room, item) {
    if (!(item.created > (room.seen || 0))) return;
    room.seen = item.created;
    lsSet(room.id, item.created);
    pendingSeen[room.id] = item.created;
    if (!seenTimer) seenTimer = setTimeout(flushSeen, 1500);
    paintRings();
  }
  function paintRings() {
    if (!data) return;
    data.forEach(function (r) {
      var done = (r.seen || 0) >= r.latest;
      document.querySelectorAll('.ss-c[data-story-room]').forEach(function (b) {
        if (b.getAttribute('data-story-room') !== r.id) return;
        b.classList.toggle('seen', done); b.classList.toggle('unseen', !done);
      });
    });
  }
  // rings from localStorage too (it covers a seen POST that didn't make it)
  function applyLocal(rooms) {
    var m = lsGet();
    rooms.forEach(function (r) { if (m[r.id] > (r.seen || 0)) r.seen = Math.min(m[r.id], r.latest); });
    return rooms;
  }

  // ── data ──
  function inline() {
    var el = document.querySelector('script.ss-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }
  function load(scope) {
    scope = scope || '';
    if (cache[scope]) return Promise.resolve(cache[scope]);
    if (!scope) {
      var d = inline();
      if (d) { cache[''] = applyLocal(d); return Promise.resolve(cache['']); }
    }
    if (!loads[scope]) loads[scope] = fetch('/api/stories' + (scope ? '?room=' + encodeURIComponent(scope) : ''), { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (r.status === 401) throw Object.assign(new Error('signin'), { signin: true });
      return r.json();
    }).then(function (j) { if (!j.ok) throw new Error(j.error || 'failed'); cache[scope] = applyLocal(j.rooms || []); return cache[scope]; })
      .catch(function (e) { loads[scope] = null; throw e; });
    return loads[scope];
  }

  // ── the sign-in prompt (signed-out visitors) ──
  // onClose (storyreact site): called when "Not now" / Esc / the backdrop closes it (the viewer resumes behind it)
  function signInPrompt(next, onClose) {
    var box = document.createElement('div');
    box.className = 'sv-ask'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', _t('js.feed.sv.ask_aria', 'Sign in to see stories'));
    box.innerHTML = '<div class="sv-ask-card"><div class="sv-ask-ic" aria-hidden="true">📸</div><h2>' + escH(_t('js.feed.sv.ask_h', 'Stories are for PATV members')) + '</h2>' +
      '<p>' + escH(_t('js.feed.sv.ask_p', 'These are snaps and clips from the pads\' chat rooms and stages, so you need to be signed in to watch them.')) + '</p>' +
      '<div class="sv-ask-btns"><a class="sv-btn primary" href="#">' + escH(_t('js.feed.sv.sign_in', 'Sign in')) + '</a><a class="sv-btn" href="/register">' + escH(_t('js.feed.sv.join', 'Join PATV')) + '</a><button type="button" class="sv-btn ghost">' + escH(_t('js.feed.sv.not_now', 'Not now')) + '</button></div></div>';
    box.querySelector('a.primary').setAttribute('href', '/login?next=' + encodeURIComponent(next || (location.pathname + location.search)));
    var close = function () { box.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    box.addEventListener('click', function (e) { if (e.target === box || e.target.closest('button.ghost')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
    box.querySelector('a.primary').focus();
  }

  // ── the viewer ──
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return _t('js.feed.sv.just_now', 'just now'); if (s < 3600) return _t('js.feed.sv.m_ago', '{n}m ago', { n: Math.floor(s / 60) }); return _t('js.feed.sv.h_ago', '{n}h ago', { n: Math.floor(s / 3600) });
  }
  function build() {
    var root = el('div', 'sv'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', _t('js.feed.sv.viewer', 'Story viewer')); root.tabIndex = -1;
    var frame = el('div', 'sv-frame');
    var bars = el('div', 'sv-bars');
    var head = el('div', 'sv-head');
    var room = el('a', 'sv-room');
    var meta = el('div', 'sv-meta');
    var who = el('span', 'sv-who'), when = el('span', 'sv-when');
    meta.appendChild(who); meta.appendChild(when);
    var info = el('div', 'sv-info'); info.appendChild(room); info.appendChild(meta);
    var mute = el('button', 'sv-ico sv-mute'); mute.type = 'button'; mute.setAttribute('aria-label', _t('js.feed.sv.mute', 'Mute')); mute.textContent = '🔊';
    var pause = el('button', 'sv-ico sv-pause'); pause.type = 'button'; pause.setAttribute('aria-label', _t('js.feed.sv.pause', 'Pause')); pause.textContent = '❚❚';
    var x = el('button', 'sv-ico sv-x'); x.type = 'button'; x.setAttribute('aria-label', _t('js.feed.sv.close', 'Close')); x.textContent = '✕';
    head.appendChild(info); head.appendChild(mute); head.appendChild(pause); head.appendChild(x);
    var stage = el('div', 'sv-stage');
    var foot = el('div', 'sv-foot');
    var live = el('div', 'sv-live'); live.setAttribute('aria-live', 'polite'); live.className = 'sv-sr';
    var hint = el('div', 'sv-hint', _t('js.feed.sv.hint', 'Tap → next · tap ← back · hold to pause · swipe ↓ to close'));
    var acts = el('div', 'sv-acts');          // 1.99eq: 📌 Post to pad / 🔖 Save
    // storyreact site: Reply / ▲▼ / 💸 (paintReact)
    var react = el('div', 'sv-react hide'); react.setAttribute('role', 'group'); react.setAttribute('aria-label', _t('js.feed.sv.react_aria', 'React to this story'));
    frame.appendChild(bars); frame.appendChild(head); frame.appendChild(stage); frame.appendChild(foot); frame.appendChild(hint); frame.appendChild(acts); frame.appendChild(react);
    var prevRoom = el('button', 'sv-side sv-prev'); prevRoom.type = 'button'; prevRoom.setAttribute('aria-label', _t('js.feed.sv.prev_pad', 'Previous pad')); prevRoom.textContent = '‹';
    var nextRoom = el('button', 'sv-side sv-next'); nextRoom.type = 'button'; nextRoom.setAttribute('aria-label', _t('js.feed.sv.next_pad', 'Next pad')); nextRoom.textContent = '›';
    root.appendChild(prevRoom); root.appendChild(frame); root.appendChild(nextRoom); root.appendChild(live);
    return { root: root, frame: frame, bars: bars, room: room, who: who, when: when, mute: mute, pause: pause, x: x, stage: stage, foot: foot,
             live: live, hint: hint, prevRoom: prevRoom, nextRoom: nextRoom, acts: acts, react: react, drafts: {} };
  }

  // fresh (storyreact site: a DM's story card): load the scope again rather than use what this page cached earlier, and
  // open THAT story or nothing - never another one of the pad's. -> a promise of true (opened / already open) | false
  function open(roomId, itemId, opener, scope, fresh) {
    if (fresh) { delete cache[scope || '']; loads[scope || ''] = null; }
    return load(scope).then(function (rooms) {
      if (V && V.root.parentNode) return true;     // already open
      data = rooms; paintRings();
      var ri = rooms.findIndex(function (r) { return r.id === roomId; });
      if (ri < 0) { if (opener && opener.href) location.href = opener.href; return false; }
      var R = rooms[ri], ii = 0;
      if (itemId) {
        ii = R.items.findIndex(function (c) { return c.id === itemId; });
        if (ii < 0 && fresh) return false;
        ii = Math.max(0, ii);
      } else { ii = R.items.findIndex(function (c) { return c.created > (R.seen || 0); }); if (ii < 0) ii = 0; }
      start(ri, ii, opener);
      return true;
    }).catch(function (e) {
      if (e && e.signin) { signInPrompt(); return false; }
      if (opener && opener.href) location.href = opener.href;
      return false;
    });
  }

  function start(ri, ii, opener) {
    if (!V) {
      V = build();
      wire();
    }
    V.opener = opener || document.activeElement;
    V.muted = false;
    try { V.muted = localStorage.getItem('patvStoryMuted') === '1'; } catch (e) { V.muted = false; }
    document.body.appendChild(V.root);
    document.documentElement.classList.add('sv-open');
    V.root.focus();
    show(ri, ii);
  }

  function close() {
    if (!V || !V.root.parentNode) return;
    closePanel(true);                         // storyreact site: + the reply sheet's keyboard listener (its draft stays in memory)
    stopMedia();
    cancelAnimationFrame(V.raf);
    V.root.remove();
    document.documentElement.classList.remove('sv-open');
    flushSeen();
    if (V.opener && V.opener.focus) { try { V.opener.focus(); } catch (e) { /* gone */ } }
  }

  function stopMedia() {
    if (V && V.media) { try { V.media.pause(); V.media.removeAttribute('src'); V.media.load(); } catch (e) { /* none */ } }
    if (V) V.media = null;
  }

  function show(ri, ii) {
    var rooms = data;
    if (ri < 0 || ri >= rooms.length) return close();
    var R = rooms[ri];
    if (ii < 0) ii = 0;
    if (ii >= R.items.length) return close();
    stopMedia();
    var fsel = focusSel();                    // storyreact site: the keyboard focus survives the rebuild below (keepFocus)
    V.ri = ri; V.ii = ii; V.paused = false; V.held = false; V.elapsed = 0; V.dur = PHOTO_MS; V.last = performance.now(); V.waiting = true;
    var it = R.items[ii];
    // progress bars
    V.bars.innerHTML = '';
    V.fills = R.items.map(function (_, k) {
      var b = el('div', 'sv-bar'); var f = el('i'); b.appendChild(f); V.bars.appendChild(b);
      f.style.transform = 'scaleX(' + (k < ii ? 1 : 0) + ')';
      return f;
    });
    V.room.textContent = R.title; V.room.href = R.href;
    // 1.99cr: stage captures (a stream on the pad's stage, not a Camfrog cam) say so
    var what = it.source === 'stage' ? (it.kind === 'clip' ? _t('js.feed.sv.k_stage_clip', '📺 Stage clip') : _t('js.feed.sv.k_stage_snap', '📺 Stage snap'))
             : it.source === 'user' ? _t('js.feed.sv.k_story', '✨ Story')
             : it.kind === 'photo' ? _t('js.feed.sv.k_snap', '📸 Snap') : it.kind === 'clip' ? _t('js.feed.sv.k_clip', '📹 Clip') : _t('js.feed.sv.k_audio', '🔊 Audio');
    var whoName = it.subject || _t('js.feed.sv.someone', 'someone');
    var ofWho = _t('js.feed.sv.of', '{what} of {who}', { what: what, who: whoName });
    var storyOf = it.by ? _t('js.feed.sv.users_story', '{name}’s story', { name: it.by }) : _t('js.feed.sv.someones_story', 'someone’s story');
    V.who.textContent = (it.source === 'user' ? '✨ ' + storyOf
      : ofWho + (it.by ? (it.source === 'stage' ? ' ' + _t('js.feed.sv.by', 'by {name}', { name: it.by }) : ' · ' + _t('js.feed.sv.by', 'by {name}', { name: it.by })) : ''))
      + (it.where && it.where.title ? ' · ' + _t('js.feed.sv.in', 'in {pad}', { pad: it.where.title }) : '') + (it.nsfw ? ' · NSFW' : '');
    V.when.textContent = ago(it.created);
    V.when.title = new Date(it.created).toLocaleString();
    V.prevRoom.disabled = ri === 0; V.nextRoom.disabled = ri === rooms.length - 1;
    V.pause.textContent = '❚❚'; V.pause.setAttribute('aria-label', _t('js.feed.sv.pause', 'Pause'));
    V.mute.classList.toggle('hide', it.kind === 'photo');
    V.mute.textContent = V.muted ? '🔇' : '🔊'; V.mute.setAttribute('aria-label', V.muted ? _t('js.feed.sv.unmute', 'Unmute') : _t('js.feed.sv.mute', 'Mute'));
    V.foot.innerHTML = '';
    var openRoom = el('a', 'sv-open-room', _t('js.feed.sv.open_pad', 'Open {pad} ›', { pad: R.title })); openRoom.href = R.href; V.foot.appendChild(openRoom);
    // 1.99ec: says what it opens ("Capture page" confused people)
    var noun = it.source === 'user' ? 'story' : it.kind === 'clip' ? 'clip' : it.kind === 'photo' ? 'snap' : '';
    var page = el('a', 'sv-open-item', noun === 'story' ? _t('js.feed.sv.open_story', 'Open story ›') : noun === 'clip' ? _t('js.feed.sv.open_clip', 'Open clip ›') : noun === 'snap' ? _t('js.feed.sv.open_snap', 'Open snap ›') : _t('js.feed.sv.open', 'Open ›')); page.href = it.page;
    page.setAttribute('aria-label', noun === 'story' ? _t('js.feed.sv.page_story', 'Open this story\'s page to share or download') : noun === 'clip' ? _t('js.feed.sv.page_clip', 'Open this clip\'s page to share or download')
      : noun === 'snap' ? _t('js.feed.sv.page_snap', 'Open this snap\'s page to share or download') : _t('js.feed.sv.page_capture', 'Open this capture\'s page to share or download'));
    V.foot.appendChild(page);
    V.live.textContent = R.title + ': ' + (it.source === 'user' ? storyOf : ofWho) + ', ' + _t('js.feed.sv.n_of', '{i} of {n}', { i: ii + 1, n: R.items.length });
    closePanel(true);
    paintActs(R, it);
    // media
    V.stage.innerHTML = '';
    V.stage.classList.remove('gone');
    // 1.99cr: an NSFW stage capture waits, blurred, until the viewer chooses to see it (once per viewer session)
    V.gated = !!(it.nsfw && !V.nsfwOk);
    V.stage.classList.toggle('nsfw', V.gated);
    paintReact(R, it);                        // storyreact site: hidden while gated (nobody votes on what they haven't chosen to see)
    // storyreact site: a control that had the focus was just rebuilt (the reaction row, the foot, a panel): the same one again,
    // else the viewer - never <body>, where Esc / the arrows / the Tab trap stop working
    keepFocus(fsel);
    var spin = el('div', 'sv-spin'); spin.setAttribute('aria-hidden', 'true'); V.stage.appendChild(spin);
    if (V.gated) {
      var gate = el('div', 'sv-nsfw');
      gate.appendChild(el('span', null, it.source === 'user' ? _t('js.feed.sv.nsfw', '🔞 Marked NSFW') : _t('js.feed.sv.nsfw_streamer', '🔞 Marked NSFW by the streamer')));
      var show18 = el('button', 'sv-btn primary', _t('js.feed.sv.show18', 'Show it (18+)')); show18.type = 'button';
      show18.addEventListener('click', function () {
        var fs = focusSel();
        V.nsfwOk = true; V.gated = false; V.stage.classList.remove('nsfw'); gate.remove();
        if (!V.media) { V.waiting = !!V.stage.querySelector('.sv-spin'); V.last = performance.now(); } else play();
        paintReact(R, it);
        keepFocus(fs);
      });
      gate.appendChild(show18);
      V.stage.appendChild(gate);
    }
    var failed = function () {
      if (V.ri !== ri || V.ii !== ii) return;
      var fs = focusSel();
      V.stage.classList.add('gone');
      V.stage.innerHTML = '';
      V.stage.appendChild(el('div', 'sv-gone', _t('js.feed.sv.gone', 'This capture is gone.')));
      V.waiting = false; V.dur = 1500; V.elapsed = 0;
      paintReact(R, it);                      // storyreact site: no reactions on a gone story
      keepFocus(fs);
    };
    if (it.kind === 'photo') {
      var img = new Image();
      img.alt = it.source === 'user' ? (it.by ? storyOf : _t('js.feed.sv.someones_story_cap', 'Someone’s story')) : _t('js.feed.sv.alt', '{what} of {who} in {pad}', { what: what.replace(/^\S+ /, ''), who: whoName, pad: R.title });
      img.className = 'sv-img'; img.decoding = 'async';
      img.onload = function () { if (V.ri !== ri || V.ii !== ii) return; spin.remove(); V.waiting = !!V.gated; V.last = performance.now(); };
      img.onerror = failed;
      img.src = it.src;
      V.stage.appendChild(img);
    } else {
      var m = document.createElement(it.kind === 'clip' ? 'video' : 'audio');
      m.className = it.kind === 'clip' ? 'sv-vid' : 'sv-aud';
      m.preload = 'auto'; m.setAttribute('playsinline', ''); m.playsInline = true; m.muted = V.muted;
      if (it.kind === 'clip' && it.poster) m.poster = it.poster;   // 1.99dq: the poster frame while the clip loads
      if (it.kind === 'audio') {
        var card = el('div', 'sv-audio-card');
        card.appendChild(el('div', 'sv-audio-ic', '🔊'));
        card.appendChild(el('div', 'sv-audio-t', _t('js.feed.sv.audio_from', 'Chat room audio from {pad}', { pad: R.title })));
        var wave = el('div', 'sv-wave'); for (var w = 0; w < 24; w++) { var s = el('i'); s.style.animationDelay = (w * 53 % 700) + 'ms'; wave.appendChild(s); } card.appendChild(wave);
        V.stage.appendChild(card);
      }
      m.addEventListener('loadedmetadata', function () { if (isFinite(m.duration) && m.duration > 0) V.dur = m.duration * 1000; });
      m.addEventListener('playing', function () { if (V.ri !== ri || V.ii !== ii) return; spin.remove(); V.waiting = false; });
      m.addEventListener('waiting', function () { if (V.media === m) V.waiting = true; });
      m.addEventListener('ended', function () { if (V.media === m) next(); });
      m.addEventListener('error', failed);
      m.src = it.src;
      V.media = m;
      V.stage.appendChild(m);
      if (it.secs > 0) V.dur = it.secs * 1000;
      if (!V.gated) play();
    }
    markSeen(R, it);
    // preload the next photo
    var nx = R.items[ii + 1] || (rooms[ri + 1] && rooms[ri + 1].items[0]);
    if (nx && nx.kind === 'photo') { var pre = new Image(); pre.src = nx.src; }
    cancelAnimationFrame(V.raf);
    V.raf = requestAnimationFrame(tick);
  }

  function play() {
    var m = V.media; if (!m || V.gated) return;
    var p = m.play();
    if (p && p.catch) p.catch(function () {
      // autoplay with sound refused: play muted and say so
      if (!m.muted) { m.muted = true; V.muted = true; V.mute.textContent = '🔇'; V.mute.setAttribute('aria-label', _t('js.feed.sv.unmute', 'Unmute')); m.play().catch(function () {}); }
    });
  }

  function tick(now) {
    if (!V || !V.root.parentNode) return;
    var dt = now - V.last; V.last = now;
    var stopped = V.paused || V.held || document.hidden;
    var f = V.fills[V.ii];
    if (V.media && !V.stage.classList.contains('gone')) {
      var m = V.media;
      var d = isFinite(m.duration) && m.duration > 0 ? m.duration : V.dur / 1000;
      if (f) f.style.transform = 'scaleX(' + Math.min(1, (m.currentTime || 0) / d) + ')';
    } else {
      if (!stopped && !V.waiting) V.elapsed += dt;
      if (f) f.style.transform = 'scaleX(' + Math.min(1, V.elapsed / V.dur) + ')';
      if (V.elapsed >= V.dur) { next(); return; }
    }
    V.raf = requestAnimationFrame(tick);
  }

  // ── 1.99eq: 📌 Post to pad / 🔖 Save ──
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (d) { if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  function paintActs(R, it) {
    V.acts.innerHTML = '';
    var can = it.can || {};
    if (it.posted) {
      var pl = el('a', 'sv-act on', _t('js.feed.sv.posted', '📌 Posted ›')); pl.href = it.posted; pl.setAttribute('aria-label', _t('js.feed.sv.posted_aria', 'Posted to {pad}: open the post', { pad: R.title })); V.acts.appendChild(pl);
    } else if (can.post) {
      var pb = el('button', 'sv-act', _t('js.feed.sv.post_to_pad', '📌 Post to pad')); pb.type = 'button'; pb.setAttribute('aria-label', _t('js.feed.sv.post_to_pad_aria', 'Post this to {pad} for good', { pad: R.title }));
      pb.addEventListener('click', function () { openPanel(R, it); });
      V.acts.appendChild(pb);
    }
    if (can.save || it.saved) {
      var sb = el('button', 'sv-act' + (it.saved ? ' on' : ''), it.saved ? _t('js.feed.sv.saved', '🔖 Saved') : _t('js.feed.sv.save', '🔖 Save')); sb.type = 'button';
      sb.setAttribute('aria-pressed', it.saved ? 'true' : 'false'); sb.setAttribute('aria-label', it.saved ? _t('js.feed.sv.saved_aria', 'Saved - tap to unsave') : _t('js.feed.sv.save_aria', 'Save to your private Saved'));
      sb.addEventListener('click', function () {
        sb.disabled = true;
        var was = !!it.saved;
        api('/api/stories/' + encodeURIComponent(it.id) + (was ? '/unsave' : '/save'), {}).then(function () {
          it.saved = !was;
          if (V && V.ri !== undefined && data[V.ri] && data[V.ri].items[V.ii] === it) paintActs(R, it);
          toast(it.saved ? _t('js.feed.sv.saved_toast', 'Saved — find it on your profile under 🔖 Saved') : _t('js.feed.sv.unsaved_toast', 'Removed from Saved'));
        }).catch(function (e) { sb.disabled = false; toast(e.message); });
      });
      V.acts.appendChild(sb);
    }
    // 1.99ez: 🗑 a member's own story (the uploader, the pad's owner / mods, staff) / 🙈 hide a capture of me from my story
    if (can.del) {
      var db = el('button', 'sv-act', '🗑 ' + (it.mine ? _t('js.feed.sv.delete', 'Delete') : _t('js.feed.sv.remove', 'Remove'))); db.type = 'button';
      db.setAttribute('aria-label', it.mine ? _t('js.feed.sv.delete_aria', 'Delete your story') : _t('js.feed.sv.remove_aria', 'Remove this story from the pad'));
      db.addEventListener('click', function () {
        if (!window.confirm(it.mine ? _t('js.feed.sv.delete_q', 'Delete this story?') : _t('js.feed.sv.remove_q', 'Remove this story?'))) return;
        db.disabled = true;
        api('/api/stories/' + encodeURIComponent(it.id) + '/delete', {}).then(function () { dropItem(R, it, it.mine ? _t('js.feed.sv.deleted', 'Story deleted') : _t('js.feed.sv.removed', 'Story removed')); })
          .catch(function (e) { db.disabled = false; toast(e.message); });
      });
      V.acts.appendChild(db);
    }
    if (it.hideable) {
      var hb = el('button', 'sv-act', _t('js.feed.sv.hide', '🙈 Hide from my story')); hb.type = 'button';
      hb.setAttribute('aria-label', _t('js.feed.sv.hide_aria', 'Hide this capture from your story (it stays in its pad)'));
      hb.addEventListener('click', function () {
        hb.disabled = true;
        api('/api/stories/' + encodeURIComponent(it.id) + '/hide', {}).then(function () { dropItem(R, it, _t('js.feed.sv.hidden', 'Hidden from your story')); })
          .catch(function (e) { hb.disabled = false; toast(e.message); });
      });
      V.acts.appendChild(hb);
    }
    V.acts.classList.toggle('hide', !V.acts.children.length);
  }
  // take an item out of a story (deleted / hidden) and carry on with the next one
  function dropItem(R, it, msg) {
    var k = R.items.indexOf(it);
    if (k < 0) return;
    R.items.splice(k, 1);
    R.count = R.items.length;
    if (!R.items.length) {
      var ri = data.indexOf(R);
      data.splice(ri, 1);
      document.querySelectorAll('.ss-c[data-story-room]').forEach(function (b) { if (b.getAttribute('data-story-room') === R.id) b.remove(); });
      document.querySelectorAll('.ss-t[data-story-item]').forEach(function (b) { if (b.getAttribute('data-story-item') === it.id) b.remove(); });
      if (ri < data.length) show(ri, firstUnseen(data[ri])); else close();
      return;
    }
    document.querySelectorAll('.ss-t[data-story-item]').forEach(function (b) { if (b.getAttribute('data-story-item') === it.id) b.remove(); });
    show(V.ri, Math.min(k, R.items.length - 1));
    toast(msg);
  }
  function toast(msg) {
    var t = el('div', 'sv-toast', msg); t.setAttribute('role', 'status');
    V.frame.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  function closePanel(silent) {
    if (!V || !V.panel) return;
    var wasReply = V.panel.classList.contains('sv-rp');
    V.panel.remove(); V.panel = null;
    kbOff();
    if (!silent && V.panelPaused) setPaused(false);
    V.panelPaused = false;
    // storyreact site: the reply pill gets the focus back (not when show() closed it to move on)
    if (!silent && wasReply) { var pill = V.react.querySelector('.sv-reply'); if (pill) { try { pill.focus(); } catch (e) { /* gone */ } } }
  }
  function openPanel(R, it) {
    closePanel(true);
    V.panelPaused = !V.paused;
    if (!V.paused) setPaused(true);
    var p = el('form', 'sv-panel'); p.setAttribute('aria-label', _t('js.feed.sv.panel_aria', 'Post to {pad}', { pad: R.title }));
    p.appendChild(el('h3', null, _t('js.feed.sv.panel_h', '📌 Post to {pad}', { pad: R.title })));
    p.appendChild(el('p', null, (it.by ? _t('js.feed.sv.permanent_by', 'It becomes a permanent post in this pad, credited to {name}.', { name: it.by }) : _t('js.feed.sv.permanent', 'It becomes a permanent post in this pad.')) + ' ' +
      (it.subject ? _t('js.feed.sv.subject_can', '{name} can remove it from the post any time.', { name: it.subject }) : _t('js.feed.sv.person_can', 'The person in it can remove it any time.'))));
    var cap = el('input', 'sv-cap'); cap.type = 'text'; cap.maxLength = 140; cap.placeholder = _t('js.feed.sv.caption_ph', 'Add a caption (optional)'); cap.setAttribute('aria-label', _t('js.feed.sv.caption_aria', 'Caption (optional)'));
    p.appendChild(cap);
    var err = el('p', 'sv-err'); err.setAttribute('role', 'alert'); p.appendChild(err);
    var row = el('div', 'sv-ask-btns');
    var go = el('button', 'sv-btn primary', _t('js.feed.sv.post', 'Post')); go.type = 'submit';
    var no = el('button', 'sv-btn ghost', _t('js.feed.sv.cancel', 'Cancel')); no.type = 'button';
    no.addEventListener('click', function () { closePanel(false); });
    row.appendChild(go); row.appendChild(no); p.appendChild(row);
    p.addEventListener('submit', function (e) {
      e.preventDefault();
      go.disabled = true; err.textContent = '';
      api('/api/stories/' + encodeURIComponent(it.id) + '/post', { caption: cap.value }).then(function (d) {
        it.posted = d.post.url;
        paintActs(R, it);
        p.innerHTML = '';
        p.appendChild(el('h3', null, d.again ? _t('js.feed.sv.already', '📌 Already posted') : _t('js.feed.sv.posted_to', '📌 Posted to {pad}', { pad: R.title })));
        var a = el('a', 'sv-btn primary', _t('js.feed.sv.view_post', 'View the post ›')); a.href = d.post.url; p.appendChild(a);
        var c2 = el('button', 'sv-btn ghost', _t('js.feed.sv.keep_watching', 'Keep watching')); c2.type = 'button'; c2.addEventListener('click', function () { closePanel(false); }); p.appendChild(c2);
        a.focus();
      }).catch(function (e2) { go.disabled = false; err.textContent = e2.message; });
    });
    V.panel = p;
    V.frame.appendChild(p);
    cap.focus();
  }

  // ── storyreact site: ↩ Reply / ▲▼ / 💸 ──
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function arrow(dir) {             // the feed's vote arrows (feedweb icon 'up' / 'down'), built without innerHTML
    var s = document.createElementNS(SVG_NS, 'svg');
    var a = { viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor',
              'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    Object.keys(a).forEach(function (k) { s.setAttribute(k, a[k]); });
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', dir === 'up' ? 'M12 4 4.5 12.5H9V20h6v-7.5h4.5Z' : 'M12 20 4.5 11.5H9V4h6v7.5h4.5Z');
    s.appendChild(p);
    return s;
  }
  function fmtN(n) { return Number(n || 0).toLocaleString('en-US'); }
  function shortN(n) {
    var v = Number(n) || 0, a = Math.abs(v);
    if (a < 1000) return String(v);
    if (a < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (a < 1e6) return Math.round(v / 1000) + 'k';
    return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  }
  function current(it) { return !!(V && V.root.parentNode && data && data[V.ri] && data[V.ri].items[V.ii] === it); }
  function hasReact(it) {
    var r = it && it.react;
    if (!r) return false;
    var can = r.can || {};
    return !!(r.votes || can.tip || can.reply || (r.tips && r.tips.n));
  }
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (d) { if (!r.ok || d.ok === false) throw Object.assign(new Error(d.error || ('HTTP ' + r.status)), { status: r.status }); return d; }); });
  }
  function nameOf(it) { return (it.react && it.react.to) || _t('js.feed.sv.someone', 'someone'); }
  function paintReact(R, it) {
    var box = V.react;
    box.textContent = '';
    var on = hasReact(it) && !V.gated && !V.stage.classList.contains('gone');
    V.frame.classList.toggle('has-react', on);
    box.classList.toggle('hide', !on);
    if (!on) return;
    var r = it.react, can = r.can || {}, name = nameOf(it);
    if (can.reply) {
      var rp = el('button', 'sv-reply', _t('js.feed.sv.reply_pill', 'Reply to {name}…', { name: name })); rp.type = 'button';
      rp.setAttribute('aria-label', _t('js.feed.sv.reply_aria', 'Reply to {name} in a direct message', { name: name }));
      rp.setAttribute('aria-haspopup', 'dialog');
      rp.addEventListener('click', function () { openReply(R, it, rp); });
      box.appendChild(rp);
    } else box.appendChild(el('span', 'sv-rgap'));
    if (r.votes) {
      var vote = el('div', 'sv-vote');
      var up = el('button', 'sv-up'); up.type = 'button'; up.appendChild(arrow('up'));
      var vs = el('span', 'sv-vs');
      var dn = el('button', 'sv-down'); dn.type = 'button'; dn.appendChild(arrow('down'));
      vote.appendChild(up); vote.appendChild(vs); vote.appendChild(dn);
      box.appendChild(vote);
      paintVote(it, up, vs, dn);
      up.addEventListener('click', function () { doVote(R, it, 1, up); });
      dn.addEventListener('click', function () { doVote(R, it, -1, dn); });
    }
    var tally = r.tips && r.tips.n ? r.tips : null;
    if (can.tip || tally) {
      var tb = el(can.tip ? 'button' : 'span', 'sv-tipb' + (can.tip ? '' : ' ro'));
      if (can.tip) tb.type = 'button';
      tb.appendChild(el('span', 'sv-tipi', '💸')).setAttribute('aria-hidden', 'true');
      var tt = tally ? (tally.n === 1 ? _t('js.feed.sv.tips_one', '1 tip · {total} PAT', { total: fmtN(tally.total) })
                                      : _t('js.feed.sv.tips_n', '{n} tips · {total} PAT', { n: fmtN(tally.n), total: fmtN(tally.total) })) : '';
      if (tally) { var tn = el('span', 'sv-tipn', fmtN(tally.n) + ' · ' + shortN(tally.total)); tn.setAttribute('aria-hidden', 'true'); tb.appendChild(tn); tb.title = tt; }
      if (can.tip) {
        tb.setAttribute('aria-label', _t('js.feed.sv.tip_aria', 'Tip {name}', { name: name }) + (tt ? ' (' + tt + ')' : ''));
        tb.setAttribute('aria-haspopup', 'dialog');
        tb.addEventListener('click', function () { openTip(R, it, tb); });
      } else { tb.setAttribute('role', 'img'); tb.setAttribute('aria-label', tt); }   // read-only: a labelled image, so it's announced
      box.appendChild(tb);
    }
  }
  function paintVote(it, up, vs, dn) {
    var r = it.react, my = r.my || 0;
    var tt = _t('js.feed.sv.score_title', '{up} up · {down} down', { up: fmtN(r.ups), down: fmtN(r.downs) });
    up.classList.toggle('on', my === 1); up.setAttribute('aria-pressed', my === 1 ? 'true' : 'false');
    dn.classList.toggle('on', my === -1); dn.setAttribute('aria-pressed', my === -1 ? 'true' : 'false');
    vs.textContent = fmtN(r.score); vs.title = tt;
    up.setAttribute('aria-label', _t('js.feed.sv.upvote', 'Upvote') + ' (' + tt + ')');
    dn.setAttribute('aria-label', _t('js.feed.sv.downvote', 'Downvote') + ' (' + tt + ')');
    var can = r.can || {};
    if (!r.signin && !can.vote) { up.disabled = true; dn.disabled = true; }
    else if (!r.signin && !can.down) { dn.disabled = true; dn.setAttribute('aria-label', _t('js.feed.sv.no_downvote', "You can't downvote your own story")); dn.title = dn.getAttribute('aria-label'); }
  }
  function doVote(R, it, dir, btn) {
    var r = it.react;
    if (r.signin) {
      // the story waits behind the prompt (it would run on - and close() would pull the focus out of the prompt)
      var held = !V.paused;
      if (held) setPaused(true);
      return signInPrompt(location.pathname + location.search, function () {
        if (!V || !V.root.parentNode) return;
        if (held) setPaused(false);
        keepFocus(selOf(btn));
      });
    }
    var can = r.can || {};
    if (!can.vote || it._voting) return;
    var was = { my: r.my || 0, score: r.score || 0, ups: r.ups || 0, downs: r.downs || 0 };
    var want = was.my === dir ? 0 : dir;
    if (want === -1 && !can.down) return;
    // optimistic: take the old vote out, put the new one in (the server's answer settles it)
    if (was.my === 1) { r.ups--; r.score--; } else if (was.my === -1) { r.downs--; r.score++; }
    if (want === 1) { r.ups++; r.score++; } else if (want === -1) { r.downs++; r.score--; }
    r.my = want;
    it._voting = true;
    if (current(it)) {
      repaint(R, it, btn);
      var nb = V.react.querySelector(dir === 1 ? '.sv-up' : '.sv-down');
      if (nb) nb.classList.add('pop');
    }
    api('/api/stories/' + encodeURIComponent(it.id) + '/vote', { dir: want }).then(function (d) {
      r.my = d.vote || 0; r.score = d.score || 0; r.ups = d.ups || 0; r.downs = d.downs || 0;
      if (current(it)) V.live.textContent = r.my === 1 ? _t('js.feed.sv.voted_up', 'Upvoted · score {n}', { n: fmtN(r.score) })
        : r.my === -1 ? _t('js.feed.sv.voted_down', 'Downvoted · score {n}', { n: fmtN(r.score) }) : _t('js.feed.sv.vote_cleared', 'Vote removed');
    }).catch(function (e) {
      r.my = was.my; r.score = was.score; r.ups = was.ups; r.downs = was.downs;
      if (current(it)) toast(e.message);
    }).then(function () {
      it._voting = false;
      if (current(it)) repaint(R, it);
    });
  }
  // the keyboard focus across a rebuild of the row: selOf = which reaction control an element is; focusSel = where the focus
  // is now (null: not inside the frame - leave it alone; '': in the frame but not on a reaction control); keepFocus = after
  // the rebuild, if the focus fell out of the viewer: the same control again, else the viewer itself (Esc / arrows / Tab work)
  function selOf(a) {
    if (!a || !a.classList) return '';
    return a.classList.contains('sv-up') ? '.sv-up' : a.classList.contains('sv-down') ? '.sv-down' : a.classList.contains('sv-tipb') ? '.sv-tipb'
      : a.classList.contains('sv-reply') ? '.sv-reply' : '';
  }
  function focusSel() {
    var a = document.activeElement;
    if (!V || !a || !V.frame.contains(a)) return null;
    return V.react.contains(a) ? selOf(a) : '';
  }
  function keepFocus(sel) {
    if (sel === null || sel === undefined || !V || !V.root.parentNode) return;
    var a = document.activeElement;
    if (a && a !== document.body && V.root.contains(a)) return;     // still on something that's there
    var f = sel ? V.react.querySelector(sel) : null;
    if (f && !f.disabled && f.focus) { try { f.focus(); return; } catch (e) { /* the viewer, then */ } }
    try { V.root.focus(); } catch (e) { /* gone */ }
  }
  // repaint the row, keeping the keyboard focus on the same control (the row is rebuilt)
  function repaint(R, it, was) {
    var sel = was && V.react.contains(was) ? selOf(was) : focusSel();
    paintReact(R, it);
    keepFocus(sel);
  }

  // 💸: the post-tip sheet (post-tip.js), above the viewer; loaded once when this page doesn't have it
  var tipP = null;
  function addScript(src) {
    return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.async = false; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  }
  function addCss(href) {
    var base = href.split('?')[0];
    var have = Array.prototype.some.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) { return (l.getAttribute('href') || '').split('?')[0] === base; });
    if (have) return Promise.resolve();
    return new Promise(function (ok) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = ok; l.onerror = ok; document.head.appendChild(l); });
  }
  function loadTip() {
    if (window.PATVPostTip) return Promise.resolve();
    if (!tipP) {
      tipP = Promise.all([addCss('/public/css/posttips.css?v=3'), window.PATVAmount ? null : addScript('/public/js/patamount.js?v=1'), addScript('/public/js/post-tip.js?v=3')])
        .catch(function (e) { tipP = null; throw e; });
    }
    return tipP;
  }
  function openTip(R, it, btn) {
    var r = it.react, name = nameOf(it);
    V.tipPaused = !V.paused;
    if (!V.paused) setPaused(true);
    var resume = function () {
      if (!V) return;
      if (V.tipPaused) setPaused(false);
      V.tipPaused = false;
      var b = V.react.querySelector('.sv-tipb');
      if (b && b.focus) { try { b.focus(); } catch (e) { /* gone */ } }
    };
    loadTip().then(function () {
      if (!window.PATVPostTip) throw new Error('no tip sheet');
      window.PATVPostTip.open({
        url: '/api/stories/' + encodeURIComponent(it.id) + '/tip', name: name, me: meName(), layer: 'top', from: btn,
        lead: function (who) { return _t('js.feed.tip.lead_story', 'For this story. {name} gets the full amount.', { name: who }); },
        sum: function (n, who) { return _t('js.feed.tip.sum_story', 'Send {n} PAT to {name} for this story?', { n: n, name: who }); },
        onDone: function (d) { if (d && d.tips) { r.tips = d.tips; if (current(it)) repaint(R, it); } },
        onClose: resume,
      });
    }).catch(function () { resume(); toast(_t('js.feed.sv.tip_unavailable', 'Tipping isn\'t available right now - try again.')); });
  }

  // ↩ the reply sheet (a .sv-panel, so typing in it never drives the viewer)
  function kbOn() {
    var vv = window.visualViewport;
    if (!vv || V.kb) return;
    var f = function () { if (!V) return; V.root.style.setProperty('--sv-kb', Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) + 'px'); };
    vv.addEventListener('resize', f); vv.addEventListener('scroll', f);
    V.kb = f; f();
  }
  function kbOff() {
    if (!V || !V.kb) return;
    var vv = window.visualViewport;
    if (vv) { vv.removeEventListener('resize', V.kb); vv.removeEventListener('scroll', V.kb); }
    V.kb = null;
    V.root.style.removeProperty('--sv-kb');
  }
  function openReply(R, it, pill) {
    closePanel(true);
    V.panelPaused = !V.paused;
    if (!V.paused) setPaused(true);
    var name = nameOf(it), can = (it.react && it.react.can) || {};
    var p = el('form', 'sv-panel sv-rp'); p.noValidate = true;
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-modal', 'true'); p.setAttribute('aria-labelledby', 'svRpH');
    var h = el('h3', null, _t('js.feed.sv.reply_h', 'Reply to {name}', { name: name })); h.id = 'svRpH';
    var note = el('p', 'sv-rp-note', _t('js.feed.sv.reply_note', 'Your reply goes to {name} as a direct message.', { name: name })); note.id = 'svRpNote';
    p.appendChild(h); p.appendChild(note);
    var quick = null;
    if (can.quick) {
      quick = el('div', 'sv-rq'); quick.setAttribute('role', 'group'); quick.setAttribute('aria-label', _t('js.feed.sv.react_aria', 'React to this story'));
      QUICK.forEach(function (e) {
        var b = el('button', 'sv-rqb', e); b.type = 'button'; b.setAttribute('aria-label', _t('js.feed.sv.react_send', 'Send {emoji}', { emoji: e }));
        b.addEventListener('click', function () { send(e, true, b); });
        quick.appendChild(b);
      });
      p.appendChild(quick);
    }
    var ta = el('textarea', 'sv-rt'); ta.rows = 1; ta.maxLength = 2000; ta.autocomplete = 'off'; ta.setAttribute('enterkeyhint', 'send');
    ta.setAttribute('aria-label', _t('js.feed.sv.reply_label', 'Your reply')); ta.setAttribute('aria-describedby', 'svRpNote svRpErr');
    ta.value = V.drafts[it.id] || '';
    p.appendChild(ta);
    var cnt = el('p', 'sv-rp-cnt'); cnt.setAttribute('aria-live', 'polite'); p.appendChild(cnt);
    var err = el('p', 'sv-err'); err.id = 'svRpErr'; err.setAttribute('role', 'alert'); p.appendChild(err);
    var row = el('div', 'sv-ask-btns');
    var go = el('button', 'sv-btn primary', _t('js.feed.sv.reply_send', 'Send')); go.type = 'submit';
    var no = el('button', 'sv-btn ghost', _t('js.feed.sv.cancel', 'Cancel')); no.type = 'button';
    no.addEventListener('click', function () { closePanel(false); });
    row.appendChild(go); row.appendChild(no); p.appendChild(row);
    var busy = false, refused = false;
    function sync() {
      var n = ta.value.length;
      cnt.textContent = n >= 1800 ? _t('js.feed.sv.chars_left', '{n} characters left', { n: fmtN(2000 - n) }) : '';
      go.disabled = busy || refused || !ta.value.trim();
    }
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(96, ta.scrollHeight) + 'px'; }
    function lock(on) {
      // a control about to be disabled drops the focus to <body> (outside the viewer: Esc and the Tab trap stop working) -
      // Cancel takes it first
      var a = document.activeElement;
      if (on && a && (a === ta || a === go || (quick && quick.contains(a)))) { try { no.focus(); } catch (e) { /* gone */ } }
      ta.disabled = on;
      if (quick) Array.prototype.forEach.call(quick.children, function (b) { b.disabled = on; });
      sync();
    }
    function send(text, isQuick, qb) {
      if (busy || refused) return;
      var body = isQuick ? text : ta.value;
      if (!String(body).trim()) return;
      busy = true; err.textContent = ''; lock(true);
      if (!isQuick) go.textContent = _t('js.feed.sv.reply_sending', 'Sending…');
      api('/api/stories/' + encodeURIComponent(it.id) + '/reply', { body: body, quick: !!isQuick }).then(function (d) {
        busy = false;
        if (V.panel !== p) return;
        if (isQuick) {
          V.quickAt = Date.now();               // the quick row stays off for a second after a send (reopening included)
          toast(_t('js.feed.sv.react_sent', 'Sent {emoji}', { emoji: text }));
          closePanel(false);
          return;
        }
        delete V.drafts[it.id];
        p.textContent = '';
        var dh = el('h3', null, _t('js.feed.sv.reply_sent', 'Sent to {name}', { name: name })); dh.id = 'svRpH'; p.appendChild(dh);
        var row2 = el('div', 'sv-ask-btns');
        var a = el('a', 'sv-btn primary', _t('js.feed.sv.reply_open', 'View in Messages ›')); a.href = '/messages/c/' + encodeURIComponent(String(d.conversation || ''));
        var k = el('button', 'sv-btn ghost', _t('js.feed.sv.keep_watching', 'Keep watching')); k.type = 'button';
        k.addEventListener('click', function () { closePanel(false); });
        row2.appendChild(a); row2.appendChild(k); p.appendChild(row2);
        kbOff();
        a.focus();
      }).catch(function (e) {
        busy = false;
        if (V.panel !== p) return;
        go.textContent = _t('js.feed.sv.reply_send', 'Send');
        err.textContent = (e && e.message && e.message.length < 300) ? e.message : _t('js.feed.sv.reply_failed', 'Your reply didn\'t send - try again.');
        lock(false);
        if (!isQuick) ta.focus();
        else if (qb && !qb.disabled) qb.focus();   // back on the emoji that failed
      });
    }
    ta.addEventListener('input', function () { V.drafts[it.id] = ta.value; grow(); sync(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;   // Shift+Enter = a new line; never mid-IME
      e.preventDefault();
      send(null, false);
    });
    p.addEventListener('submit', function (e) { e.preventDefault(); send(null, false); });
    V.panel = p;
    V.frame.appendChild(p);
    kbOn();
    grow(); sync();
    ta.focus();                                // inside the tap, so phones open the keyboard
    var wait = 1000 - (Date.now() - (V.quickAt || 0));
    if (quick && wait > 0) {
      Array.prototype.forEach.call(quick.children, function (b) { b.disabled = true; });
      setTimeout(function () { if (V && V.panel === p && !busy && !refused) Array.prototype.forEach.call(quick.children, function (b) { b.disabled = false; }); }, wait);
    }
    getJson('/api/stories/' + encodeURIComponent(it.id) + '/reply').then(function (d) {
      if (V.panel !== p || d.canSend) return;
      refused = true; err.textContent = d.refusal || _t('js.feed.sv.reply_failed', 'Your reply didn\'t send - try again.');
      lock(true);
    }).catch(function (e) {
      if (V.panel !== p) return;
      refused = true; err.textContent = (e && e.message) || _t('js.feed.sv.reply_failed', 'Your reply didn\'t send - try again.');
      lock(true);
    });
  }

  function setPaused(p) {
    V.paused = p;
    V.pause.textContent = p ? '▶' : '❚❚'; V.pause.setAttribute('aria-label', p ? _t('js.feed.sv.play', 'Play') : _t('js.feed.sv.pause', 'Pause'));
    V.root.classList.toggle('is-paused', p);
    if (V.media) { if (p) V.media.pause(); else play(); }
  }
  function hold(on) {
    V.held = on;
    V.root.classList.toggle('is-held', on);
    if (V.media && !V.paused) { if (on) V.media.pause(); else play(); }
  }
  function next() {
    var R = data[V.ri];
    if (V.ii + 1 < R.items.length) return show(V.ri, V.ii + 1);
    nextRoomStart();
  }
  function prev() {
    if (V.ii > 0) return show(V.ri, V.ii - 1);
    if (V.ri > 0) return show(V.ri - 1, data[V.ri - 1].items.length - 1);
    show(V.ri, 0);
  }
  function firstUnseen(R) { var k = R.items.findIndex(function (c) { return c.created > (R.seen || 0); }); return k < 0 ? 0 : k; }
  function nextRoomStart() { if (V.ri + 1 < data.length) show(V.ri + 1, firstUnseen(data[V.ri + 1])); else close(); }
  function prevRoomStart() { if (V.ri > 0) show(V.ri - 1, firstUnseen(data[V.ri - 1])); else show(V.ri, 0); }

  function wire() {
    V.x.addEventListener('click', close);
    V.pause.addEventListener('click', function () { setPaused(!V.paused); });
    V.mute.addEventListener('click', function () {
      V.muted = !V.muted;
      try { localStorage.setItem('patvStoryMuted', V.muted ? '1' : '0'); } catch (e) { /* none */ }
      if (V.media) V.media.muted = V.muted;
      V.mute.textContent = V.muted ? '🔇' : '🔊'; V.mute.setAttribute('aria-label', V.muted ? _t('js.feed.sv.unmute', 'Unmute') : _t('js.feed.sv.mute', 'Mute'));
    });
    V.prevRoom.addEventListener('click', prevRoomStart);
    V.nextRoom.addEventListener('click', nextRoomStart);
    V.root.addEventListener('click', function (e) { if (e.target === V.root) close(); });
    // pointer: tap / hold / swipe on the frame (not on its links and buttons)
    var P = null, holdT = null;
    V.frame.addEventListener('pointerdown', function (e) {
      // storyreact site: + the reaction row (its score isn't a button) and any text box
      if (e.button !== 0 || e.target.closest('a, button, input, textarea, .sv-panel, .sv-react')) return;
      P = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, held: false };
      clearTimeout(holdT);
      holdT = setTimeout(function () { if (P) { P.held = true; hold(true); } }, 200);
    });
    var end = function (e, cancel) {
      if (!P || e.pointerId !== P.id) return;
      clearTimeout(holdT);
      var dx = e.clientX - P.x, dy = e.clientY - P.y, was = P.held;
      P = null;
      if (was) hold(false);
      if (cancel) return;
      if (dy > 80 && Math.abs(dy) > Math.abs(dx)) return close();
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? nextRoomStart() : prevRoomStart();
      if (was || Math.abs(dx) > 12 || Math.abs(dy) > 12) return;
      var r = V.frame.getBoundingClientRect();
      if (e.clientX - r.left < r.width / 3) prev(); else next();
    };
    V.frame.addEventListener('pointerup', function (e) { end(e, false); });
    V.frame.addEventListener('pointercancel', function (e) { end(e, true); });
    V.frame.addEventListener('contextmenu', function (e) { if (!e.target.closest('a')) e.preventDefault(); });   // long-press menu on phones
    V.root.addEventListener('keydown', function (e) {
      // 1.99eq: typing a caption - Esc closes the panel, every other key is the input's
      // storyreact site: + Tab stays inside the panel (it's a dialog: the reply sheet, the 📌 panel)
      var pnl = e.target.closest && e.target.closest('.sv-panel');
      if (pnl) {
        if (e.key === 'Escape') { e.preventDefault(); closePanel(false); }
        else if (e.key === 'Tab') {
          var pf = Array.prototype.slice.call(pnl.querySelectorAll('textarea:not([disabled]), input:not([disabled]), button:not([disabled]), a[href]')).filter(function (x) { return x.offsetParent !== null; });
          if (pf.length) {
            var pi = pf.indexOf(document.activeElement);
            if (e.shiftKey && pi <= 0) { e.preventDefault(); pf[pf.length - 1].focus(); }
            else if (!e.shiftKey && pi === pf.length - 1) { e.preventDefault(); pf[0].focus(); }
          }
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); nextRoomStart(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); prevRoomStart(); }
      else if (e.key === ' ' && !e.target.closest('a, button')) { e.preventDefault(); setPaused(!V.paused); }
      else if (e.key === 'm' || e.key === 'M') { V.mute.click(); }
      else if (e.key === 'Tab') {                          // keep focus inside the dialog
        var f = Array.prototype.slice.call(V.root.querySelectorAll('a[href], button:not([disabled])')).filter(function (x) { return x.offsetParent !== null; });
        if (!f.length) return;
        var i = f.indexOf(document.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
    document.addEventListener('visibilitychange', function () { if (V.media && document.hidden) V.media.pause(); else if (V.media && !V.paused && !V.held && V.root.parentNode) play(); });
    window.addEventListener('pagehide', flushSeen);
  }

  // ── strip clicks ──
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-story-room]');
    if (!t || !t.closest('.ss') || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    var strip = t.closest('.ss');
    // 1.99fu: signed out, only a Public pad's circle (data-story-open, its story inlined) opens; the rest ask to sign in
    if (strip.getAttribute('data-signed') !== '1' && !t.hasAttribute('data-story-open')) return signInPrompt(strip.getAttribute('data-next'));
    // 1.99fn: a pad's capture strip (data-scope = its pad id) opens that pad's story only
    open(t.getAttribute('data-story-room'), t.getAttribute('data-story-item'), t, strip.getAttribute('data-scope') || '');
  });
  // rings: apply the local seen map to server-rendered circles (and again after /feed swaps the list)
  function initRings() {
    var d = inline();
    if (d) { data = cache[''] = applyLocal(d); paintRings(); }
  }
  // 1.99es: the strip's scroller - no native scrollbar (stories.css), so: which edges have more (the fade), and
  // ‹ › buttons (hover-capable pointers only, CSS) that page by about one viewport. Touch / trackpad / shift + wheel /
  // keyboard focus scroll natively; the vertical wheel is never taken over.
  function initStrips() {
    document.querySelectorAll('.ss-scroll').forEach(function (box) {
      if (box.__ssInit) return;
      box.__ssInit = true;
      var row = box.querySelector('.ss-row');
      if (!row) return;
      if (row.querySelector('.ss-t')) box.classList.add('thumbs');
      var raf = 0;
      function update() {
        raf = 0;
        var max = row.scrollWidth - row.clientWidth;
        box.classList.toggle('ovf', max > 1);
        box.classList.toggle('at-start', row.scrollLeft <= 1);
        box.classList.toggle('at-end', row.scrollLeft >= max - 1);
      }
      function soon() { if (!raf) raf = requestAnimationFrame(update); }
      var smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      box.querySelectorAll('.ss-arr').forEach(function (b) {
        b.hidden = false;
        b.addEventListener('click', function () {
          var dir = b.classList.contains('prev') ? -1 : 1;
          row.scrollBy({ left: dir * Math.max(120, row.clientWidth * 0.85), behavior: smooth ? 'smooth' : 'auto' });
        });
      });
      row.addEventListener('scroll', soon, { passive: true });
      if (window.ResizeObserver) new ResizeObserver(soon).observe(row); else window.addEventListener('resize', soon);
      row.querySelectorAll('img').forEach(function (im) { if (!im.complete) im.addEventListener('load', soon, { once: true }); });
      update();
    });
  }
  function initAll() { initRings(); initStrips(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll); else initAll();
  document.addEventListener('patv:feed-swapped', function () { data = null; cache = {}; loads = {}; initRings(); initStrips(); });
  window.patvStories = { open: open, _state: function () { return V; } };
})();
