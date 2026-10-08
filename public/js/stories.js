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
(function () {
  'use strict';
  if (window.__patvStories) return;
  window.__patvStories = true;

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
  function signInPrompt(next) {
    var box = document.createElement('div');
    box.className = 'sv-ask'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Sign in to see stories');
    box.innerHTML = '<div class="sv-ask-card"><div class="sv-ask-ic" aria-hidden="true">📸</div><h2>Stories are for PATV members</h2>' +
      '<p>These are snaps and clips from the pads\' Camfrog rooms and stages, so you need to be signed in to watch them.</p>' +
      '<div class="sv-ask-btns"><a class="sv-btn primary" href="#">Sign in</a><a class="sv-btn" href="/register">Join PATV</a><button type="button" class="sv-btn ghost">Not now</button></div></div>';
    box.querySelector('a.primary').setAttribute('href', '/login?next=' + encodeURIComponent(next || (location.pathname + location.search)));
    var close = function () { box.remove(); document.removeEventListener('keydown', onKey); };
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
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; return Math.floor(s / 3600) + 'h ago';
  }
  function build() {
    var root = el('div', 'sv'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Story viewer'); root.tabIndex = -1;
    var frame = el('div', 'sv-frame');
    var bars = el('div', 'sv-bars');
    var head = el('div', 'sv-head');
    var room = el('a', 'sv-room');
    var meta = el('div', 'sv-meta');
    var who = el('span', 'sv-who'), when = el('span', 'sv-when');
    meta.appendChild(who); meta.appendChild(when);
    var info = el('div', 'sv-info'); info.appendChild(room); info.appendChild(meta);
    var mute = el('button', 'sv-ico sv-mute'); mute.type = 'button'; mute.setAttribute('aria-label', 'Mute'); mute.textContent = '🔊';
    var pause = el('button', 'sv-ico sv-pause'); pause.type = 'button'; pause.setAttribute('aria-label', 'Pause'); pause.textContent = '❚❚';
    var x = el('button', 'sv-ico sv-x'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.textContent = '✕';
    head.appendChild(info); head.appendChild(mute); head.appendChild(pause); head.appendChild(x);
    var stage = el('div', 'sv-stage');
    var foot = el('div', 'sv-foot');
    var live = el('div', 'sv-live'); live.setAttribute('aria-live', 'polite'); live.className = 'sv-sr';
    var hint = el('div', 'sv-hint', 'Tap → next · tap ← back · hold to pause · swipe ↓ to close');
    var acts = el('div', 'sv-acts');          // 1.99eq: 📌 Post to pad / 🔖 Save
    frame.appendChild(bars); frame.appendChild(head); frame.appendChild(stage); frame.appendChild(foot); frame.appendChild(hint); frame.appendChild(acts);
    var prevRoom = el('button', 'sv-side sv-prev'); prevRoom.type = 'button'; prevRoom.setAttribute('aria-label', 'Previous pad'); prevRoom.textContent = '‹';
    var nextRoom = el('button', 'sv-side sv-next'); nextRoom.type = 'button'; nextRoom.setAttribute('aria-label', 'Next pad'); nextRoom.textContent = '›';
    root.appendChild(prevRoom); root.appendChild(frame); root.appendChild(nextRoom); root.appendChild(live);
    return { root: root, frame: frame, bars: bars, room: room, who: who, when: when, mute: mute, pause: pause, x: x, stage: stage, foot: foot,
             live: live, hint: hint, prevRoom: prevRoom, nextRoom: nextRoom, acts: acts };
  }

  function open(roomId, itemId, opener, scope) {
    load(scope).then(function (rooms) {
      if (V && V.root.parentNode) return;     // already open
      data = rooms; paintRings();
      var ri = rooms.findIndex(function (r) { return r.id === roomId; });
      if (ri < 0) { if (opener && opener.href) location.href = opener.href; return; }
      var R = rooms[ri], ii = 0;
      if (itemId) ii = Math.max(0, R.items.findIndex(function (c) { return c.id === itemId; }));
      else { ii = R.items.findIndex(function (c) { return c.created > (R.seen || 0); }); if (ii < 0) ii = 0; }
      start(ri, ii, opener);
    }).catch(function (e) {
      if (e && e.signin) return signInPrompt();
      if (opener && opener.href) location.href = opener.href;
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
    var what = it.source === 'stage' ? (it.kind === 'clip' ? '📺 Stage clip' : '📺 Stage snap')
             : it.source === 'user' ? '✨ Story'
             : it.kind === 'photo' ? '📸 Snap' : it.kind === 'clip' ? '📹 Clip' : '🔊 Audio';
    V.who.textContent = (it.source === 'user' ? '✨ ' + (it.by || 'someone') + '’s story'
      : what + ' of ' + (it.subject || 'someone') + (it.by ? (it.source === 'stage' ? ' by ' : ' · by ') + it.by : ''))
      + (it.where && it.where.title ? ' · in ' + it.where.title : '') + (it.nsfw ? ' · NSFW' : '');
    V.when.textContent = ago(it.created);
    V.when.title = new Date(it.created).toLocaleString();
    V.prevRoom.disabled = ri === 0; V.nextRoom.disabled = ri === rooms.length - 1;
    V.pause.textContent = '❚❚'; V.pause.setAttribute('aria-label', 'Pause');
    V.mute.classList.toggle('hide', it.kind === 'photo');
    V.mute.textContent = V.muted ? '🔇' : '🔊'; V.mute.setAttribute('aria-label', V.muted ? 'Unmute' : 'Mute');
    V.foot.innerHTML = '';
    var openRoom = el('a', 'sv-open-room', 'Open ' + R.title + ' ›'); openRoom.href = R.href; V.foot.appendChild(openRoom);
    // 1.99ec: says what it opens ("Capture page" confused people)
    var noun = it.source === 'user' ? 'story' : it.kind === 'clip' ? 'clip' : it.kind === 'photo' ? 'snap' : '';
    var page = el('a', 'sv-open-item', noun ? 'Open ' + noun + ' ›' : 'Open ›'); page.href = it.page;
    page.setAttribute('aria-label', 'Open this ' + (noun || 'capture') + '\'s page to share or download');
    V.foot.appendChild(page);
    V.live.textContent = R.title + ': ' + (it.source === 'user' ? (it.by || 'someone') + '’s story' : what + ' of ' + (it.subject || 'someone')) + ', ' + (ii + 1) + ' of ' + R.items.length;
    closePanel(true);
    paintActs(R, it);
    // media
    V.stage.innerHTML = '';
    V.stage.classList.remove('gone');
    // 1.99cr: an NSFW stage capture waits, blurred, until the viewer chooses to see it (once per viewer session)
    V.gated = !!(it.nsfw && !V.nsfwOk);
    V.stage.classList.toggle('nsfw', V.gated);
    var spin = el('div', 'sv-spin'); spin.setAttribute('aria-hidden', 'true'); V.stage.appendChild(spin);
    if (V.gated) {
      var gate = el('div', 'sv-nsfw');
      gate.appendChild(el('span', null, it.source === 'user' ? '🔞 Marked NSFW' : '🔞 Marked NSFW by the streamer'));
      var show18 = el('button', 'sv-btn primary', 'Show it (18+)'); show18.type = 'button';
      show18.addEventListener('click', function () {
        V.nsfwOk = true; V.gated = false; V.stage.classList.remove('nsfw'); gate.remove();
        if (!V.media) { V.waiting = !!V.stage.querySelector('.sv-spin'); V.last = performance.now(); } else play();
      });
      gate.appendChild(show18);
      V.stage.appendChild(gate);
    }
    var failed = function () {
      if (V.ri !== ri || V.ii !== ii) return;
      V.stage.classList.add('gone');
      V.stage.innerHTML = '';
      V.stage.appendChild(el('div', 'sv-gone', 'This capture is gone.'));
      V.waiting = false; V.dur = 1500; V.elapsed = 0;
    };
    if (it.kind === 'photo') {
      var img = new Image();
      img.alt = it.source === 'user' ? (it.by || 'Someone') + '’s story' : what.replace(/^\S+ /, '') + ' of ' + (it.subject || 'someone') + ' in ' + R.title;
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
        card.appendChild(el('div', 'sv-audio-t', 'Camfrog room audio from ' + R.title));
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
      if (!m.muted) { m.muted = true; V.muted = true; V.mute.textContent = '🔇'; V.mute.setAttribute('aria-label', 'Unmute'); m.play().catch(function () {}); }
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
      var pl = el('a', 'sv-act on', '📌 Posted ›'); pl.href = it.posted; pl.setAttribute('aria-label', 'Posted to ' + R.title + ': open the post'); V.acts.appendChild(pl);
    } else if (can.post) {
      var pb = el('button', 'sv-act', '📌 Post to pad'); pb.type = 'button'; pb.setAttribute('aria-label', 'Post this to ' + R.title + ' for good');
      pb.addEventListener('click', function () { openPanel(R, it); });
      V.acts.appendChild(pb);
    }
    if (can.save || it.saved) {
      var sb = el('button', 'sv-act' + (it.saved ? ' on' : ''), it.saved ? '🔖 Saved' : '🔖 Save'); sb.type = 'button';
      sb.setAttribute('aria-pressed', it.saved ? 'true' : 'false'); sb.setAttribute('aria-label', it.saved ? 'Saved - tap to unsave' : 'Save to your private Saved');
      sb.addEventListener('click', function () {
        sb.disabled = true;
        var was = !!it.saved;
        api('/api/stories/' + encodeURIComponent(it.id) + (was ? '/unsave' : '/save'), {}).then(function () {
          it.saved = !was;
          if (V && V.ri !== undefined && data[V.ri] && data[V.ri].items[V.ii] === it) paintActs(R, it);
          toast(it.saved ? 'Saved — find it on your profile under 🔖 Saved' : 'Removed from Saved');
        }).catch(function (e) { sb.disabled = false; toast(e.message); });
      });
      V.acts.appendChild(sb);
    }
    // 1.99ez: 🗑 a member's own story (the uploader, the pad's owner / mods, staff) / 🙈 hide a capture of me from my story
    if (can.del) {
      var db = el('button', 'sv-act', '🗑 ' + (it.mine ? 'Delete' : 'Remove')); db.type = 'button';
      db.setAttribute('aria-label', it.mine ? 'Delete your story' : 'Remove this story from the pad');
      db.addEventListener('click', function () {
        if (!window.confirm(it.mine ? 'Delete this story?' : 'Remove this story?')) return;
        db.disabled = true;
        api('/api/stories/' + encodeURIComponent(it.id) + '/delete', {}).then(function () { dropItem(R, it, it.mine ? 'Story deleted' : 'Story removed'); })
          .catch(function (e) { db.disabled = false; toast(e.message); });
      });
      V.acts.appendChild(db);
    }
    if (it.hideable) {
      var hb = el('button', 'sv-act', '🙈 Hide from my story'); hb.type = 'button';
      hb.setAttribute('aria-label', 'Hide this capture from your story (it stays in its pad)');
      hb.addEventListener('click', function () {
        hb.disabled = true;
        api('/api/stories/' + encodeURIComponent(it.id) + '/hide', {}).then(function () { dropItem(R, it, 'Hidden from your story'); })
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
    V.panel.remove(); V.panel = null;
    if (!silent && V.panelPaused) setPaused(false);
    V.panelPaused = false;
  }
  function openPanel(R, it) {
    closePanel(true);
    V.panelPaused = !V.paused;
    if (!V.paused) setPaused(true);
    var p = el('form', 'sv-panel'); p.setAttribute('aria-label', 'Post to ' + R.title);
    p.appendChild(el('h3', null, '📌 Post to ' + R.title));
    p.appendChild(el('p', null, 'It becomes a permanent post in this pad' + (it.by ? ', credited to ' + it.by : '') + '. ' +
      (it.subject ? it.subject + ' can remove it from the post any time.' : 'The person in it can remove it any time.')));
    var cap = el('input', 'sv-cap'); cap.type = 'text'; cap.maxLength = 140; cap.placeholder = 'Add a caption (optional)'; cap.setAttribute('aria-label', 'Caption (optional)');
    p.appendChild(cap);
    var err = el('p', 'sv-err'); err.setAttribute('role', 'alert'); p.appendChild(err);
    var row = el('div', 'sv-ask-btns');
    var go = el('button', 'sv-btn primary', 'Post'); go.type = 'submit';
    var no = el('button', 'sv-btn ghost', 'Cancel'); no.type = 'button';
    no.addEventListener('click', function () { closePanel(false); });
    row.appendChild(go); row.appendChild(no); p.appendChild(row);
    p.addEventListener('submit', function (e) {
      e.preventDefault();
      go.disabled = true; err.textContent = '';
      api('/api/stories/' + encodeURIComponent(it.id) + '/post', { caption: cap.value }).then(function (d) {
        it.posted = d.post.url;
        paintActs(R, it);
        p.innerHTML = '';
        p.appendChild(el('h3', null, d.again ? '📌 Already posted' : '📌 Posted to ' + R.title));
        var a = el('a', 'sv-btn primary', 'View the post ›'); a.href = d.post.url; p.appendChild(a);
        var c2 = el('button', 'sv-btn ghost', 'Keep watching'); c2.type = 'button'; c2.addEventListener('click', function () { closePanel(false); }); p.appendChild(c2);
        a.focus();
      }).catch(function (e2) { go.disabled = false; err.textContent = e2.message; });
    });
    V.panel = p;
    V.frame.appendChild(p);
    cap.focus();
  }

  function setPaused(p) {
    V.paused = p;
    V.pause.textContent = p ? '▶' : '❚❚'; V.pause.setAttribute('aria-label', p ? 'Play' : 'Pause');
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
      V.mute.textContent = V.muted ? '🔇' : '🔊'; V.mute.setAttribute('aria-label', V.muted ? 'Unmute' : 'Mute');
    });
    V.prevRoom.addEventListener('click', prevRoomStart);
    V.nextRoom.addEventListener('click', nextRoomStart);
    V.root.addEventListener('click', function (e) { if (e.target === V.root) close(); });
    // pointer: tap / hold / swipe on the frame (not on its links and buttons)
    var P = null, holdT = null;
    V.frame.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('a, button, input, .sv-panel')) return;
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
      if (e.target.closest && e.target.closest('.sv-panel')) { if (e.key === 'Escape') { e.preventDefault(); closePanel(false); } return; }
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
    if (strip.getAttribute('data-signed') !== '1') return signInPrompt(strip.getAttribute('data-next'));
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
