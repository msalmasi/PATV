// feed.js — the feed's browser side (1.99bv; up/down votes, the "more" menus and room-owner tools 1.99ca): votes,
// comments and replies, edit / delete / report, room-owner and admin buttons, NSFW reveal and
// click-to-play embeds. Every write is a same-site JSON fetch with X-Requested-With: fetch.
(function () {
  'use strict';
  if (window.__patvFeed) return;          // the room page and /feed may include this twice
  window.__patvFeed = true;
  var me = document.currentScript;
  var signed = !!(me && me.getAttribute('data-signed'));

  function api(url, body, method) {
    return fetch(url, {
      method: method || 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) { var e = new Error(d.error || ('HTTP ' + r.status)); e.code = d.code; throw e; }
        return d;
      });
    });
  }
  function fmtNum(n) {
    var v = Number(n) || 0, a = Math.abs(v);
    if (a < 1000) return String(v);
    if (a < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (a < 1e6) return Math.round(v / 1000) + 'k';
    return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  }
  function login() { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); }
  function postOf(el) { var a = el.closest('.fp'); return a ? a.getAttribute('data-id') : null; }
  function reasons() {
    var el = document.getElementById('fdReasons');
    try { return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; }
  }
  function askReason() {
    var R = reasons() || { spam: 'Spam', abuse: 'Harassment or hate', nsfw: 'Unmarked NSFW', illegal: 'Illegal content', personal: 'Personal info / doxxing', other: 'Something else' };
    var keys = Object.keys(R);
    var txt = 'Why are you reporting this?\n' + keys.map(function (k, i) { return (i + 1) + '. ' + R[k]; }).join('\n') + '\n\nType a number:';
    var n = window.prompt(txt, '1');
    if (n === null) return null;
    var k = keys[(parseInt(n, 10) || 0) - 1];
    if (!k) { alert('Pick one of the numbers.'); return null; }
    var note = window.prompt('Anything to add? (optional)', '') || '';
    return { reason: k, note: note.slice(0, 300) };
  }

  // NSFW: per-viewer "always show" lives in localStorage (a convenience, never security)
  var showNsfw = false;
  try { showNsfw = localStorage.getItem('patvFeedNsfw') === '1'; } catch (e) { showNsfw = false; }
  if (showNsfw) document.querySelectorAll('.fp-content.blur').forEach(function (c) { if (!c.querySelector('.fp-nsfw-gate')) c.classList.remove('blur'); });

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act]');
    if (!b || b.tagName === 'FORM') return;
    var act = b.getAttribute('data-act');
    var id = postOf(b);
    if (act === 'reveal') {
      var c = b.closest('.fp-content'); c.classList.remove('blur');
      if (!showNsfw && window.confirm('Show NSFW posts without the blur from now on (on this device)?')) { try { localStorage.setItem('patvFeedNsfw', '1'); } catch (e) { /* private mode */ } }
      return;
    }
    if (act === 'embed') {
      var box = b.closest('.fp-embed'); var src = box.getAttribute('data-src');
      if (!/^https:\/\/(www\.youtube-nocookie\.com|player\.twitch\.tv)\//.test(src)) return;
      var f = document.createElement('iframe');
      f.src = src; f.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media'; f.allowFullscreen = true;
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
      f.title = 'Video player';
      box.innerHTML = ''; box.appendChild(f);
      return;
    }
    if (act === 'share') {
      var url = location.origin + b.getAttribute('data-url');
      var lbl = b.querySelector('.lbl') || b;
      if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) { navigator.share({ url: url }).catch(function () {}); return; }
      var done = function () { lbl.textContent = 'Link copied'; b.classList.add('done'); setTimeout(function () { lbl.textContent = 'Share'; b.classList.remove('done'); }, 2000); };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy the link:', url); });
      else window.prompt('Copy the link:', url);
      return;
    }
    if (act === 'vote') {
      if (!signed) return login();
      var box = b.closest('.vote');
      if (!box || box.classList.contains('busy') || b.disabled) return;
      var cur = parseInt(box.getAttribute('data-v'), 10) || 0;
      var want = parseInt(b.getAttribute('data-dir'), 10) || 0;
      var dir = cur === want ? 0 : want;               // up -> up = none; up -> down = down
      var kind = box.getAttribute('data-kind');
      var vurl = kind === 'comment' ? '/api/feed/comments/' + b.closest('.cm').getAttribute('data-id') + '/vote' : '/api/feed/posts/' + id + '/vote';
      var vs = box.querySelector('.vs');
      var setState = function (v) {
        box.setAttribute('data-v', String(v));
        box.querySelector('.vb-up').setAttribute('aria-pressed', v === 1 ? 'true' : 'false');
        box.querySelector('.vb-down').setAttribute('aria-pressed', v === -1 ? 'true' : 'false');
      };
      setState(dir);
      box.classList.add('busy');
      api(vurl, { dir: dir }).then(function (d) {
        setState(d.vote);
        vs.textContent = fmtNum(d.score);
        vs.title = d.ups + ' up · ' + d.downs + ' down' + (d.counted === false ? ' · your downvote counts once your account is level 2 or has a linked Camfrog name' : '');
      }).catch(function (e) { setState(cur); alert(e.message); }).then(function () { box.classList.remove('busy'); });
      return;
    }
    if (act === 'report' || act === 'creport') {
      // 1.99cc: the report modal (feed-safety.js); the old prompt() flow only if that script didn't load
      var tgt = { post: id };
      if (act === 'creport') { tgt.comment = b.closest('.cm').getAttribute('data-id'); tgt.post = document.querySelector('.fp').getAttribute('data-id'); }
      if (window.patvSafety) { window.patvSafety.report(tgt); return; }
      var r = askReason(); if (!r) return;
      if (tgt.comment) r.comment = tgt.comment;
      api('/api/feed/posts/' + tgt.post + '/report', r).then(function (d) { alert(d.already ? 'You already reported this.' : 'Thanks - an admin will take a look.'); }).catch(function (e) { alert(e.message); });
      return;
    }
    if (act === 'details' || act === 'cdetails') {
      if (!window.patvSafety) return;
      if (act === 'cdetails') window.patvSafety.details({ comment: b.closest('.cm').getAttribute('data-id') });
      else window.patvSafety.details({ post: id });
      return;
    }
    if (act === 'crosspost') {
      // 1.99ci: the crosspost dialog (feed-crosspost.js)
      if (!signed) return login();
      if (window.patvCrosspost) window.patvCrosspost.open(id, b.getAttribute('data-title') || '');
      return;
    }
    if (act === 'edit') { var art = b.closest('.fp'); art.querySelector('.fp-editf').classList.remove('hide'); return; }
    if (act === 'edit-cancel') { b.closest('.fp-editf').classList.add('hide'); return; }
    if (act === 'delete' || act === 'admin-delete') {
      var why = '';
      if (act === 'admin-delete') { why = window.prompt('Delete this post for everyone. Reason (the author is told):', ''); if (why === null) return; }
      else if (!window.confirm('Delete your post? This can\'t be undone.')) return;
      api('/api/feed/posts/' + id + '/delete', { reason: why }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    // 1.99eq: the person in a story capture takes its post down (storykeep.js; the poster is told)
    if (act === 'remove-me') {
      if (!window.confirm('Remove this post of you? It comes down for everyone and the person who posted it is told.')) return;
      b.disabled = true;
      api('/api/stories/posts/' + id + '/remove-me', {}).then(function () { location.reload(); }).catch(function (e) { b.disabled = false; alert(e.message); });
      return;
    }
    // 1.99fp: someone quoted anonymises themselves in a quote (quotes.js); someone heard takes a mic clip down (micclip.js)
    if (act === 'quote-rm' || act === 'voice-rm') {
      if (!window.confirm(act === 'quote-rm' ? 'Show your lines in this quote as “someone”? Your name comes off it for good.' : 'Take this clip of you down? It comes down for everyone and the person who posted it is told.')) return;
      b.disabled = true;
      api('/api/feed/posts/' + id + '/' + (act === 'quote-rm' ? 'quote-remove-me' : 'voice-remove-me'), {}).then(function () { location.reload(); }).catch(function (e) { b.disabled = false; alert(e.message); });
      return;
    }
    if (act === 'remove-room' || act === 'restore-room') {
      if (act === 'remove-room' && !window.confirm('Take this post out of your pad? (It stays anywhere else it was posted.)')) return;
      api('/api/feed/posts/' + id + '/' + act, { room: b.getAttribute('data-room') }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    if (act === 'admin-nsfw' || act === 'admin-hide' || act === 'admin-lock') {
      var on = b.getAttribute('data-on') === '1';
      var patch = act === 'admin-nsfw' ? { nsfw: on } : act === 'admin-hide' ? { hidden: on } : { locked: on };
      api('/api/feed/posts/' + id + '/admin', patch).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    // 1.99cg: "Mute Pepe in this thread" (the post's author, its rooms' owners, staff - checked on the server)
    if (act === 'pepe-mute') {
      api('/api/feed/posts/' + id + '/pepe-mute', { on: b.getAttribute('data-on') === '1' }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    // room owners: their room only (the server checks the owner per room)
    if (act === 'rmod') {
      var op = b.getAttribute('data-op'), body = { op: op, post: id };
      if (op === 'reject') { var rs = window.prompt('Reject this post for your pad? Reason (optional, the author is told):', ''); if (rs === null) return; body.reason = rs; }
      api('/api/rooms/' + encodeURIComponent(b.getAttribute('data-slug')) + '/feed/mod', body).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    if (act === 'room-ban') {
      // 1.99df: data-what = "commenting on your profile" (a profile owner's block)
      var what = b.getAttribute('data-what') || 'posting and commenting in this pad';
      var d = window.prompt('Ban ' + b.getAttribute('data-user') + ' from ' + what + '.\nHow long? 1 = a day, 7 = a week, 0 = permanently', '1');
      if (d === null) return;
      var days = parseInt(d, 10); if (!(days >= 0)) { alert('Type a number of days (0 = permanently).'); return; }
      var reason = window.prompt('Reason (optional):', '') || '';
      api('/api/feed/ban', { user: b.getAttribute('data-user'), room: b.getAttribute('data-slug'), days: days, reason: reason })
        .then(function () { alert((b.getAttribute('data-what') ? 'Blocked from ' + what : 'Banned from this pad') + (days ? ' for ' + days + ' day' + (days === 1 ? '' : 's') : ' permanently') + '.'); }).catch(function (e) { alert(e.message); });
      return;
    }
    // 1.99di: the author shows / hides the prompt of an AI-generated file (aigen.js checks it's theirs)
    if (act === 'ai-prompt') {
      api('/api/feed/attachments/' + b.getAttribute('data-att') + '/ai-prompt', { show: b.getAttribute('data-show') === '1' })
        .then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    // 1.99df: a profile post's "Also show in All" (its author only - checked on the server)
    if (act === 'in-all') {
      api('/api/feed/posts/' + id + '/edit', { inAll: b.getAttribute('data-on') === '1' }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    if (act === 'reply') {
      var li = b.closest('.cm'); var f2 = li.querySelector(':scope > .cm-replyf');
      if (f2) { f2.classList.toggle('hide'); if (!f2.classList.contains('hide')) f2.querySelector('textarea').focus(); }
      return;
    }
    if (act === 'cedit') { var li2 = b.closest('.cm'); var f3 = li2.querySelector(':scope > .cm-editf'); if (f3) f3.classList.toggle('hide'); return; }
    if (act === 'cdelete') {
      var cm = b.closest('.cm');
      var own = !!cm.querySelector(':scope > .cm-editf');
      var cwhy = '';
      if (own) { if (!window.confirm('Delete your comment?')) return; }
      else { cwhy = window.prompt('Remove this comment. Reason (optional, the author is told):', ''); if (cwhy === null) return; }
      api('/api/feed/comments/' + cm.getAttribute('data-id') + '/delete', { reason: cwhy }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
  });

  // the "more" menus and the time filter: one open at a time; close on an item, outside click or Escape
  function closeMenus(except) {
    document.querySelectorAll('details.more[open], details.fs-time[open]').forEach(function (d) { if (d !== except) d.removeAttribute('open'); });
  }
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d.matches || !d.matches('details.more, details.fs-time') || !d.open) return;
    closeMenus(d);
    var m = d.querySelector('.menu, .fs-menu');
    if (m) {
      // open upwards near the bottom of the screen; slide left / right to stay on screen
      d.classList.remove('up');
      m.style.left = '';
      var r = m.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      if (r.bottom > window.innerHeight - 8 && r.height < d.getBoundingClientRect().top) d.classList.add('up');
      var shift = 0;
      if (r.right > vw - 8) shift = r.right - (vw - 8);
      if (r.left - shift < 8) shift = r.left - 8;
      if (shift) m.style.left = (parseFloat(getComputedStyle(m).left) - shift) + 'px';
    }
  }, true);
  document.addEventListener('click', function (ev) {
    var inMenu = ev.target.closest('details.more, details.fs-time');
    if (!inMenu) return closeMenus(null);
    if (ev.target.closest('.menu [data-act], .menu a')) inMenu.removeAttribute('open');
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeMenus(null); });

  // comment boxes grow with their text
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.tagName !== 'TEXTAREA' || !t.closest('.composer')) return;
    t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 420) + 'px';
  });

  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    var act = f.getAttribute('data-act');
    if (!act) return;
    ev.preventDefault();
    var err = f.querySelector('.fc-err');
    var btn = f.querySelector('button[type=submit]');
    var fail = function (e) { if (err) err.textContent = e.message; else alert(e.message); if (btn) btn.disabled = false; };
    if (btn) btn.disabled = true;
    if (act === 'comment') {
      var body = { body: f.elements.body.value, parent: f.getAttribute('data-parent') || null };
      var curl = '/api/feed/posts/' + f.getAttribute('data-post') + '/comments';
      // 1.99cc: not accepted the current Terms yet -> ask once, then send again with acceptTerms
      api(curl, body).catch(function (e) {
        if (e.code !== 'terms' || !window.patvSafety) throw e;
        return window.patvSafety.termsAsk().then(function (yes) {
          if (!yes) throw new Error('You need to accept the Terms of Service to comment.');
          body.acceptTerms = true;
          return api(curl, body);
        });
      }).then(function (d) {
        location.hash = 'c-' + d.id; location.reload();
      }).catch(fail);
    } else if (act === 'cedit-save') {
      api('/api/feed/comments/' + f.closest('.cm').getAttribute('data-id') + '/edit', { body: f.elements.body.value }).then(function () { location.reload(); }).catch(fail);
    } else if (act === 'edit-save') {
      api('/api/feed/posts/' + postOf(f) + '/edit', { title: f.elements.title.value, body: f.elements.body.value, nsfw: f.elements.nsfw.checked,
        inAll: f.elements.inAll ? f.elements.inAll.checked : undefined,
        tags: f.elements.tags ? f.elements.tags.value : undefined }).then(function () { location.reload(); }).catch(fail);      // 1.99iq: tags
    }
  });

  // the room owner's "Pepe announces new posts" switch
  var mention = document.getElementById('rfMention');
  if (mention) mention.addEventListener('change', function () {
    api('/api/rooms/' + encodeURIComponent(mention.getAttribute('data-slug')) + '/feed/mention', { on: mention.checked })
      .catch(function (e) { alert(e.message); mention.checked = !mention.checked; });
  });

  // the composer lives in feed-composer.js (1.99bz: drafts, destination switching)
})();
