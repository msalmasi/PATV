// feed.js — the feed's browser side (1.99bv): votes,
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
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
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
      if (navigator.share) { navigator.share({ url: url }).catch(function () {}); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { b.textContent = '✔ Link copied'; }, function () { window.prompt('Copy the link:', url); });
      else window.prompt('Copy the link:', url);
      return;
    }
    if (act === 'vote') {
      if (!signed) return login();
      b.disabled = true;
      api('/api/feed/posts/' + id + '/vote', {}).then(function (d) {
        b.classList.toggle('on', d.voted); b.setAttribute('aria-pressed', d.voted ? 'true' : 'false');
        b.parentNode.querySelector('.fp-score').textContent = d.score;
      }).catch(function (e) { alert(e.message); }).then(function () { b.disabled = false; });
      return;
    }
    if (act === 'report' || act === 'creport') {
      var r = askReason(); if (!r) return;
      if (act === 'creport') { r.comment = b.closest('.cm').getAttribute('data-id'); id = document.querySelector('.fp').getAttribute('data-id'); }
      api('/api/feed/posts/' + id + '/report', r).then(function (d) { alert(d.already ? 'You already reported this.' : 'Thanks - an admin will take a look.'); }).catch(function (e) { alert(e.message); });
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
    if (act === 'remove-room' || act === 'restore-room') {
      if (act === 'remove-room' && !window.confirm('Take this post out of your room\'s feed? (It stays anywhere else it was posted.)')) return;
      api('/api/feed/posts/' + id + '/' + act, { room: b.getAttribute('data-room') }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    if (act === 'admin-nsfw' || act === 'admin-hide') {
      var on = b.getAttribute('data-on') === '1';
      api('/api/feed/posts/' + id + '/admin', act === 'admin-nsfw' ? { nsfw: on } : { hidden: on }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
    if (act === 'reply') { var li = b.closest('.cm'); var f2 = li.querySelector(':scope > .cm-replyf'); if (f2) { f2.classList.toggle('hide'); f2.querySelector('textarea').focus(); } return; }
    if (act === 'cedit') { var li2 = b.closest('.cm'); var f3 = li2.querySelector(':scope > .cm-editf'); if (f3) f3.classList.toggle('hide'); return; }
    if (act === 'cdelete') {
      if (!window.confirm('Delete this comment?')) return;
      api('/api/feed/comments/' + b.closest('.cm').getAttribute('data-id') + '/delete', {}).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
      return;
    }
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
      api('/api/feed/posts/' + f.getAttribute('data-post') + '/comments', body).then(function (d) {
        location.hash = 'c-' + d.id; location.reload();
      }).catch(fail);
    } else if (act === 'cedit-save') {
      api('/api/feed/comments/' + f.closest('.cm').getAttribute('data-id') + '/edit', { body: f.elements.body.value }).then(function () { location.reload(); }).catch(fail);
    } else if (act === 'edit-save') {
      api('/api/feed/posts/' + postOf(f) + '/edit', { title: f.elements.title.value, body: f.elements.body.value, nsfw: f.elements.nsfw.checked }).then(function () { location.reload(); }).catch(fail);
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
