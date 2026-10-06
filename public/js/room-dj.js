// The room page's DJ panel (1.99ba): Pepe's now playing / queue / Auto-DJ, and requests to him.
// Data: GET /api/rooms/:slug/dj every few seconds (roomdj.js). Actions: POST /api/rooms/:slug/dj
// {verb, text} -> a website action Pepe runs as you, in this room, through the chat command
// (same PAT price / votes / rules as typing it); GET .../dj/act/:id for his answer.
// Everything from the server is put on the page with textContent.
(function () {
  'use strict';
  var box = document.getElementById('rdj');
  if (!box) return;
  var slug = box.getAttribute('data-slug'), linked = !!box.getAttribute('data-linked');
  var api = '/api/rooms/' + encodeURIComponent(slug) + '/dj';
  var P = null, fetchedAt = 0, timer = null, fails = 0, lastKey = '', busy = false, watchT = null;

  // ── collapsed / open (1.99bx): remembered per browser ──
  var OPEN_KEY = 'patvDjOpen', tog = document.getElementById('rdjTog');
  function isOpen() { return !box.classList.contains('collapsed'); }
  function setOpen(open, save) {
    box.classList.toggle('collapsed', !open);
    if (tog) { tog.setAttribute('aria-expanded', String(open)); tog.textContent = open ? 'Close booth ▴' : 'Open booth ▾'; }
    if (save) { try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) { /* private mode */ } }
  }
  (function () { var v = null; try { v = localStorage.getItem(OPEN_KEY); } catch (e) { v = null; } setOpen(v === '1', false); })();
  if (tog) tog.addEventListener('click', function () { setOpen(!isOpen(), true); });

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function $(id) { return document.getElementById(id); }
  function pat(n) { return Number(n || 0).toLocaleString() + ' PAT'; }
  function mmss(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function art(t, cls) {
    var d = el('div', 'art' + (cls ? ' ' + cls : ''));
    if (t && t.art) {
      var im = el('img'); im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer';
      im.onerror = function () { d.textContent = '🎵'; d.setAttribute('aria-hidden', 'true'); };
      im.src = t.art; d.appendChild(im);
    }
    else { d.textContent = '🎵'; d.setAttribute('aria-hidden', 'true'); }
    return d;
  }
  function tag(t) {
    if (t.removed) return el('span', 'tag gone', 'removed');
    if (t.by === 'user') return el('span', 'tag user', '🙋 ' + (t.who || 'someone'));
    if (t.by === 'dj') return el('span', 'tag dj', '🐸 Pepe\'s pick');
    return el('span', 'tag', 'Spotify');
  }

  // ── rendering ──
  function renderNow() {
    var s = P.state, n = s.now, box2 = $('rdjNow');
    box2.textContent = '';
    if (!s.connected) { box2.appendChild(art(null)); box2.appendChild(el('div', 'a', 'Pepe\'s music is offline right now.')); return; }
    if (!n) { box2.appendChild(art(null)); box2.appendChild(el('div', 'a', 'Nothing playing right now.')); return; }
    box2.appendChild(art(n));
    var meta = el('div');
    meta.appendChild(el('div', 't', n.title));
    meta.appendChild(el('div', 'a', n.artist + (n.album ? ' · ' + n.album : '')));
    var by = el('div', 'by'); by.appendChild(tag(n));
    if (!n.playing) by.appendChild(el('span', 'tag', '⏸ paused'));
    meta.appendChild(by);
    box2.appendChild(meta);
    var bar = el('div', 'bar' + (n.playing ? '' : ' paused'));
    bar.appendChild(el('span', null, '0:00')); bar.firstChild.id = 'rdjPos';
    var tr = el('div', 'track'); tr.setAttribute('role', 'progressbar'); tr.setAttribute('aria-label', 'Song progress');
    tr.setAttribute('aria-valuemin', '0'); tr.setAttribute('aria-valuemax', String(Math.round((n.duration_ms || 0) / 1000)));
    var f = el('div', 'fill'); f.id = 'rdjFill'; tr.appendChild(f); tr.id = 'rdjTrack';
    bar.appendChild(tr);
    bar.appendChild(el('span', null, mmss(n.duration_ms)));
    box2.appendChild(bar);
    tickProgress();
  }
  function tickProgress() {
    if (!P || !P.state || !P.state.now) return;
    var n = P.state.now, f = $('rdjFill'), pos = $('rdjPos'), tr = $('rdjTrack');
    if (!f) return;
    var ms = n.progress_ms + (n.playing ? (P.age || 0) + (Date.now() - fetchedAt) : 0);
    if (n.duration_ms) ms = Math.min(ms, n.duration_ms);
    f.style.width = (n.duration_ms ? (100 * ms / n.duration_ms) : 0).toFixed(2) + '%';
    pos.textContent = mmss(ms);
    tr.setAttribute('aria-valuenow', String(Math.round(ms / 1000)));
    var mf = $('rdjMiniFill');
    if (mf) { mf.style.width = f.style.width; $('rdjMiniTrack').setAttribute('aria-valuenow', String(Math.round(ms / 1000))); }
  }
  // the collapsed bar: cover, title / artist, a thin progress line, the controls this viewer may use
  function renderMini() {
    var s = P.state, r = P.room, me = P.me, n = s.now, d = s.dj || {};
    var a = $('rdjMiniArt'), m = $('rdjMini');
    a.textContent = '';
    if (n && n.art) {
      var im = el('img'); im.alt = ''; im.referrerPolicy = 'no-referrer';
      im.onerror = function () { a.textContent = '🎵'; };
      im.src = n.art; a.appendChild(im);
    } else a.textContent = '🎵';
    $('rdjMiniT').textContent = !s.connected ? 'Pepe\'s music is offline right now.' : n ? n.title : 'Nothing playing right now.';
    $('rdjMiniA').textContent = n && s.connected ? n.artist + (n.playing ? '' : ' · ⏸ paused') : (d.on ? 'Auto-DJ is on' : '');
    m.classList.toggle('paused', !(n && n.playing));
    $('rdjMiniTrack').classList.toggle('hide', !(n && s.connected));
    $('rdjMiniTrack').setAttribute('aria-valuemax', String(Math.round(((n && n.duration_ms) || 0) / 1000)));
    if (!n) $('rdjMiniFill').style.width = '0';
    var c = $('rdjMiniCtrls');
    c.textContent = '';
    if (!s.connected || !linked) return;
    var admin = me.musicAdmin, playing = !!(n && n.playing);
    if (playing && (r.pause || admin)) {
      c.appendChild(btn(admin ? '⏭️ Skip' : '⏭️ Vote skip', null, 'skip', { title: admin ? 'Skip now' : 'Free · ' + s.votes.stop + ' votes skip it' }));
      c.appendChild(btn(admin ? '⏸️ Pause' : '⏸️ Vote pause', null, 'pause', { title: admin ? 'Pause now' : 'Free · ' + s.votes.stop + ' votes pause it' }));
    }
    if (!playing && n) c.appendChild(btn(admin ? '▶️ Resume' : '▶️ Vote resume', null, 'resume', { title: admin ? 'Resume now' : 'Free · ' + s.votes.start + ' votes' }));
    if (!n && (r.play || admin)) c.appendChild(btn(admin ? '▶️ Start' : '▶️ Vote start', null, 'play', { title: admin ? 'Start the music' : 'Free · ' + s.votes.start + ' votes' }));
    if (me.djAdmin && d.on) c.appendChild(btn('🎧 Next', null, 'dj.next', { title: 'Pepe picks the next song' }));
    if (r.queue || admin) {
      var q = el('button', 'b go', '🔎 Request'); q.type = 'button';
      q.title = 'Search for a song to queue';
      q.addEventListener('click', function () {
        setOpen(true, true);
        var f = $('rdjFindQ');
        if (f) { f.focus(); try { f.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* old browser */ } }
      });
      c.appendChild(q);
    }
  }
  function renderBooth() {
    var s = P.state, d = s.dj || {}, b = $('rdjBooth');
    var pill = $('rdjPill');
    pill.textContent = d.on ? 'Auto-DJ on' : 'Auto-DJ off';
    pill.className = 'pill' + (d.on ? '' : ' off');
    b.textContent = '';
    function row(k, v) { var r = el('div'); r.appendChild(el('div', 'k', k)); if (typeof v === 'string') r.appendChild(el('div', 'v', v)); else r.appendChild(v); b.appendChild(r); }
    if (d.on && d.hold) row('Fresh start', 'The DJ session was just reset — Pepe waits for a new vibe before he lines anything up.');
    else if (d.on) row('Pepe\'s on the decks', 'He reads the room and lines up the set — your requests are his cues.');
    else row('Auto-DJ', 'Off — the queue plays what people request.');
    if (d.vibe) {
      var v = el('div', 'v'); v.appendChild(el('q', null, d.vibe.text)); v.appendChild(document.createTextNode(' — asked by ' + d.vibe.by));
      row('The vibe right now', v);
    }
    if (d.vote) {
      var vv = el('div', 'v'); vv.appendChild(el('q', null, d.vote.text));
      vv.appendChild(document.createTextNode(' — ' + d.vote.have + '/' + d.vote.need + ' votes (proposed by ' + d.vote.by + ')'));
      row('Vibe vote open', vv);
    }
    if (d.genre) row('Leaning into', d.genre);
    var pt = P.room && P.room.patter;
    if (d.on && pt && pt.on && P.room.talk) {
      row('🎙️ Patter', (pt.live ? 'Live — ' : '') + 'greetings, chatter' + (pt.starters ? ', new topics' : '') +
        ' and shout-outs go into one short link between songs' + (pt.joins ? '' : ' (joins left out)') +
        ' · up to ' + pt.words + ' words');
    }
    var so = s.shoutouts || [];
    if (so.length) {
      var ul = el('ul', 'sol');
      so.forEach(function (x) {
        var li = el('li');
        li.appendChild(el('b', null, '📣 ' + x.to));
        li.appendChild(document.createTextNode(' from ' + x.by + (x.ded ? ' · dedication' : '')));
        if (x.msg) { li.appendChild(document.createTextNode(' — ')); li.appendChild(el('q', null, x.msg)); }
        ul.appendChild(li);
      });
      row('Shout-outs waiting (' + so.length + ')', ul);
    }
    if (s.drop) { var q = el('div', 'v'); q.appendChild(el('q', null, s.drop.text)); row('🎙️ Pepe just said', q); }
  }
  function renderQueue() {
    var ol = $('rdjQueue'), q = P.state.queue || [];
    ol.textContent = '';
    if (!q.length) { ol.appendChild(el('li', null, 'Nothing queued.')); ol.firstChild.style.display = 'block'; ol.firstChild.style.color = '#888'; return; }
    q.forEach(function (t, i) {
      var li = el('li', t.removed ? 'removed' : null);
      li.appendChild(el('span', 'n', String(i + 1)));
      li.appendChild(art(t));
      var nm = el('div', 'nm'); nm.appendChild(el('b', null, t.title));
      var sub = el('span'); sub.textContent = t.artist + ' · ';
      sub.appendChild(document.createTextNode(t.removed ? 'removed' : t.by === 'user' ? '🙋 ' + (t.who || 'someone') : t.by === 'dj' ? '🐸 Pepe\'s pick' : 'Spotify'));
      nm.appendChild(sub);
      li.appendChild(nm);
      ol.appendChild(li);
    });
  }
  function btn(label, small, verb, opts) {
    var b = el('button', 'b' + (opts && opts.go ? ' go' : ''));
    b.type = 'button'; b.textContent = label;
    if (small) { b.appendChild(document.createTextNode(' ')); b.appendChild(el('small', null, small)); }
    if (opts && opts.title) b.title = opts.title;
    b.disabled = !linked || busy;
    b.addEventListener('click', function () { act(verb, '', label); });
    return b;
  }
  function renderCtrls() {
    var s = P.state, r = P.room, me = P.me, c = $('rdjCtrls'), n = s.now;
    c.textContent = '';
    if (!s.connected || !linked) return;      // read-only viewers just watch
    var stop = s.votes.stop, start = s.votes.start, admin = me.musicAdmin;
    var playing = !!(n && n.playing);
    if (playing && (r.pause || admin)) {
      c.appendChild(btn(admin ? '⏭️ Skip' : '⏭️ Vote skip', admin ? 'instant' : 'free · ' + stop + ' votes', 'skip'));
      c.appendChild(btn(admin ? '⏸️ Pause' : '⏸️ Vote pause', admin ? 'instant' : 'free · ' + stop + ' votes', 'pause'));
    }
    if (!playing && n) c.appendChild(btn(admin ? '▶️ Resume' : '▶️ Vote resume', admin ? 'instant' : 'free · ' + start + ' votes', 'resume'));
    if (!n && (r.play || admin)) c.appendChild(btn(admin ? '▶️ Start the music' : '▶️ Vote to start the music', admin ? 'instant' : 'free · ' + start + ' votes', 'play'));
    if (linked) c.appendChild(btn('🗑️ Remove my last request', 'free', 'remove', { title: 'Like !remove: your last queued song is skipped when it comes up' }));
  }
  function renderTools() {
    if (!linked) return;
    var s = P.state, r = P.room, me = P.me, d = s.dj || {};
    var canQueue = s.connected && (r.queue || me.musicAdmin);
    $('rdjReqBox').classList.toggle('hide', !canQueue);
    $('rdjReqHint').textContent = me.musicAdmin ? 'Admins queue for free.'
      : 'Queuing costs ' + pat(r.price.queue) + ' (like !find + !pick) · up to ' + s.maxPending + ' of your songs waiting at once.';
    $('rdjVibeBox').classList.toggle('hide', !d.on);
    // 1.99bz: listeners vote on the vibe (same rules as the skip/pause votes, counted by Camfrog
    // login together with chat's !dj vibe yes); admins still set it directly.
    var vt = d.vote, vbox = $('rdjVibeVote');
    $('rdjVibeTitle').textContent = me.djAdmin ? 'Set the vibe' : (vt ? 'Vote for this vibe' : 'Propose a vibe');
    vbox.textContent = '';
    vbox.classList.toggle('hide', !vt);
    if (vt) {
      var vl = el('p', 'ro'); vl.appendChild(el('q', null, vt.text));
      vl.appendChild(document.createTextNode(' — proposed by ' + vt.by + ' · ' + vt.have + '/' + vt.need + ' votes'));
      vbox.appendChild(vl);
      if (me.vibeVoted && !me.djAdmin) vbox.appendChild(el('p', 'hint', '✓ You voted — it needs ' + Math.max(0, vt.need - vt.have) + ' more.'));
      else vbox.appendChild(btn(me.djAdmin ? '✅ Pass it now' : '🎧 Vote for this vibe', vt.have + '/' + vt.need, 'vibe.yes', { go: true }));
    }
    $('rdjVibe').classList.toggle('hide', !!vt && !me.djAdmin);   // one open vote at a time
    $('rdjVibeSend').firstChild.nodeValue = me.djAdmin ? '🎧 Set ' : '🎧 Propose ';
    var need = (vt && vt.need) || s.votes.start;
    $('rdjVibeHint').textContent = me.djAdmin ? 'As an admin this sets the DJ\'s genre bias directly (!dj vibe) and cancels an open vote.'
      : vt ? 'Like !dj vibe yes in the room · a vote runs out 90 s after the last vote · a new proposal can start once this one passes or runs out.'
      : 'Free · the room votes on it: ' + need + ' votes (yours counts) like !dj vibe · steers Pepe\'s picks for ~45 minutes if it passes.';
    var pt = r.patter, soOk = s.connected && d.on && r.talk && pt && pt.on;
    $('rdjSoBox').classList.toggle('hide', !soOk);
    $('rdjSoHint').textContent = (me.djAdmin ? 'Admins shout out for free.' : pat(r.price.shoutout) + ' — held when you ask, only taken when Pepe says it (refunded after 30 min if he doesn\'t).') +
      ' One every 15 minutes; no links. Like !dj shoutout.';
    var adm = $('rdjAdmin');
    adm.classList.toggle('hide', !me.djAdmin);
    if (me.djAdmin) {
      var a = $('rdjAdminBtns'); a.textContent = '';
      a.appendChild(d.on ? btn('🎧 Auto-DJ off', null, 'dj.off') : btn('🎧 Auto-DJ on', null, 'dj.on', { go: true }));
      if (d.on) a.appendChild(btn('🎧 Pepe picks next', null, 'dj.next'));
      a.appendChild(r.talk ? btn('🎙️ DJ talk off', 'this room', 'dj.talk.off') : btn('🎙️ DJ talk on', 'this room', 'dj.talk.on'));
      if (pt) {
        a.appendChild(pt.on ? btn('🎙️ Patter off', 'this room', 'dj.patter.off', { title: 'Greeter, chatty and starters use the mic on their own again' })
          : btn('🎙️ Patter on', 'this room', 'dj.patter.on', { title: 'One DJ voice: everything spoken goes into links between songs' }));
        if (pt.on) {
          a.appendChild(pt.joins ? btn('👋 Joins out of patter', null, 'dj.patter.joins.off') : btn('👋 Joins into patter', null, 'dj.patter.joins.on'));
          a.appendChild(pt.starters ? btn('💬 No new topics', null, 'dj.patter.starters.off') : btn('💬 Open new topics', null, 'dj.patter.starters.on'));
        }
      }
      if (d.genre) a.appendChild(btn('🧹 Clear the vibe bias', null, 'dj.vibe.clear'));
      if (d.clear) a.appendChild(btn('🧼 Reset session', 'vibe, cues + queue', 'dj.clear',
        { title: 'Like !dj clear: drops the vibe, the cues and the whole queue (paid requests refunded); the current song plays out' }));
    }
    renderMine();
  }
  function renderMine() {
    var ul = $('rdjMine'); if (!ul) return;
    ul.textContent = '';
    (P.acts || []).forEach(function (a) {
      var li = el('li', a.status);
      li.appendChild(el('span', null, a.status === 'done' ? '✅' : a.status === 'failed' ? '❌' : '⏳'));
      li.appendChild(el('span', null, a.label));
      li.appendChild(el('span', 'm', a.status === 'pending' || a.status === 'claimed' ? 'waiting for Pepe…' : cap(a.message)));
      ul.appendChild(li);
    });
  }
  function render() {
    var show = !!(P && P.active);
    box.classList.toggle('hide', !show);
    if (!show) return;
    var key = JSON.stringify([P.state, P.room, P.me, P.acts, busy]);
    if (key === lastKey) { tickProgress(); return; }
    lastKey = key;
    renderNow(); renderBooth(); renderQueue(); renderCtrls(); renderTools(); renderMini();
  }

  // ── actions ──
  function say(text, cls) { var s = $('rdjSay'); if (!s) return; s.className = 'say' + (cls ? ' ' + cls : ''); s.textContent = text || ''; }
  function setBusy(b) { busy = b; lastKey = ''; render(); }
  function act(verb, text, label) {
    if (!linked || busy) return;
    setBusy(true);
    say('Sending to Pepe…');
    fetch(api, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                 body: JSON.stringify({ verb: verb, text: text || '' }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { setBusy(false); return say(d.error || 'Not right now.', 'bad'); }
        say('Pepe is on it…');
        watch(d.id, verb, 0);
      })
      .catch(function () { setBusy(false); say('Couldn\'t reach the site.', 'bad'); });
  }
  function watch(id, verb, n) {
    clearTimeout(watchT);
    fetch(api + '/act/' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (a) {
        if (a.status === 'done' || a.status === 'failed') {
          setBusy(false);
          say(cap(a.message) || (a.status === 'done' ? 'Done.' : 'Pepe couldn\'t do that.'), a.status === 'done' ? 'ok' : 'bad');
          if (verb === 'find') showResults(a.status === 'done' ? (a.results || []) : []);
          if (verb === 'pick' && a.status === 'done') showResults([]);
          poll(true);
          return;
        }
        if (n > 50) { setBusy(false); return say('Pepe hasn\'t answered yet — check back in a minute.'); }
        watchT = setTimeout(function () { watch(id, verb, n + 1); }, 1500);
      })
      .catch(function () { setBusy(false); say('Couldn\'t reach the site.', 'bad'); });
  }
  function showResults(list) {
    var ul = $('rdjRes'); if (!ul) return;
    ul.textContent = '';
    var price = P && P.me && P.me.musicAdmin ? 'free' : pat(P && P.room ? P.room.price.queue : 0);
    list.forEach(function (t) {
      var li = el('li');
      li.appendChild(art(t));
      var nm = el('div', 'nm'); nm.appendChild(el('b', null, t.title)); nm.appendChild(el('span', null, t.artist + (t.album ? ' · ' + t.album : '')));
      li.appendChild(nm);
      var b = el('button', 'b go', '➕ Queue'); b.type = 'button';
      b.appendChild(document.createTextNode(' ')); b.appendChild(el('small', null, price));
      b.setAttribute('aria-label', 'Queue ' + t.title + ' by ' + t.artist + ' for ' + price);
      b.addEventListener('click', function () { act('pick', String(t.n), 'Queue'); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    if (list.length) ul.appendChild(el('li', null, 'Pick within 2 minutes (like !pick).')).style.cssText = 'display:block;background:none;color:#888;font-size:12px';
  }
  if (linked) {
    $('rdjFind').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = $('rdjFindQ').value.trim();
      if (q) act('find', q, 'Search');
    });
    $('rdjVibe').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = $('rdjVibeQ').value.trim();
      if (q) { act('vibe', q, 'Vibe'); $('rdjVibeQ').value = ''; }
    });
    $('rdjSo').addEventListener('submit', function (e) {
      e.preventDefault();
      var who = $('rdjSoTo').value.trim().replace(/^@/, '').split(/\s+/)[0];
      var msg = $('rdjSoMsg').value.trim();
      if (!who) return say('Type the Camfrog name of who it\'s for.', 'bad');
      act('shoutout', who + (msg ? ' ' + msg : '') + ($('rdjSoDed').checked ? ' -d' : ''), 'Shout-out');
      $('rdjSoMsg').value = '';
    });
  }

  // ── polling ──
  function poll(now) {
    clearTimeout(timer); timer = null;
    if (document.hidden && !now) return;
    fetch(api, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { fails = 0; P = d; fetchedAt = Date.now(); render(); })
      .catch(function () { fails++; })
      .then(function () { schedule(); });
  }
  function schedule() {
    if (!timer && !document.hidden) timer = setTimeout(poll, fails ? Math.min(60000, 5000 * Math.pow(2, fails)) : (P && P.active ? 5000 : 20000));
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(true); });
  setInterval(function () { if (P && P.active && !document.hidden) tickProgress(); }, 1000);
  poll(true);
})();
