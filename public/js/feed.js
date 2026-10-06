// feed.js — the feed's browser side (1.99bv): votes, the composer (chunked uploads, link preview),
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

  // ── the composer ──
  var form = document.getElementById('fcForm');
  if (!form) return;
  var CHUNK = parseInt(form.getAttribute('data-chunk'), 10) || 524288;
  var caps = {}, prices = {};
  try { caps = JSON.parse(form.getAttribute('data-caps')); prices = JSON.parse(form.getAttribute('data-prices')); } catch (e) { /* defaults */ }
  var maxImages = parseInt(form.getAttribute('data-max-images'), 10) || 4;
  var maxRooms = parseInt(form.getAttribute('data-max-rooms'), 10) || 5;
  var list = document.getElementById('fcFiles');
  var errEl = document.getElementById('fcErr');
  var go = document.getElementById('fcGo');
  var files = [];        // {kind, name, id, state, el}
  var linkRow = document.getElementById('fcLinkRow');
  var pv = document.getElementById('fcPv');

  function setErr(t) { errEl.textContent = t || ''; errEl.classList.remove('ok'); }
  function cost() {
    var el = document.getElementById('fcCost');
    var paid = Object.keys(prices).some(function (k) { return prices[k] > 0; });
    if (!paid || !el) return;
    var n = { image: 0, audio: 0, video: 0 };
    files.forEach(function (f) { if (f.state !== 'failed') n[f.kind]++; });
    var c = (prices.post || 0) + (form.elements.link.value.trim() ? prices.link || 0 : 0) + n.image * (prices.image || 0) + n.audio * (prices.audio || 0) + n.video * (prices.video || 0);
    el.textContent = c ? 'This post costs ' + c.toLocaleString('en-US') + ' PAT.' : 'This post is free.';
  }
  function busy() { return files.some(function (f) { return f.state === 'uploading' || f.state === 'processing'; }); }
  function refreshGo() { go.disabled = busy(); go.textContent = busy() ? 'Uploading…' : 'Post'; cost(); }

  form.querySelector('[data-tool=link]').addEventListener('click', function () {
    linkRow.classList.toggle('hide');
    if (!linkRow.classList.contains('hide')) form.elements.link.focus();
  });
  var pvTimer = null, pvFor = '';
  function preview() {
    var u = form.elements.link.value.trim();
    cost();
    if (!u || u === pvFor) return;
    pvFor = u;
    pv.textContent = 'Checking the link…';
    api('/api/feed/preview', { url: u }).then(function (d) {
      if (form.elements.link.value.trim() !== u) return;
      var p = d.preview;
      pv.innerHTML = '';
      var a = document.createElement('div'); a.className = 'fp-link' + (p.image ? ' has-img' : '');
      if (p.image) { var im = document.createElement('img'); im.src = p.image; im.alt = ''; a.appendChild(im); }
      var t = document.createElement('span'); t.className = 't';
      var bb = document.createElement('b'); bb.textContent = p.title || p.domain; t.appendChild(bb);
      if (p.description) { var dd = document.createElement('span'); dd.className = 'd'; dd.textContent = p.description; t.appendChild(dd); }
      var dm = document.createElement('span'); dm.className = 'dom'; dm.textContent = '🔗 ' + p.domain + (p.embed ? ' · ' + p.embed + ' (plays in the post)' : ''); t.appendChild(dm);
      a.appendChild(t); pv.appendChild(a);
    }).catch(function (e) { if (form.elements.link.value.trim() === u) pv.textContent = '⚠️ ' + e.message; });
  }
  form.elements.link.addEventListener('input', function () { clearTimeout(pvTimer); pvTimer = setTimeout(preview, 700); });
  form.elements.link.addEventListener('blur', preview);

  function row(f) {
    var li = document.createElement('li');
    var th = document.createElement('span'); th.className = 'th'; th.textContent = f.kind === 'image' ? '🖼' : f.kind === 'audio' ? '🔊' : '🎬';
    var mid = document.createElement('div');
    var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = f.name;
    var st = document.createElement('div'); st.className = 'st'; st.textContent = 'Starting…';
    var bar = document.createElement('div'); bar.className = 'bar'; var bi = document.createElement('i'); bar.appendChild(bi);
    mid.appendChild(nm); mid.appendChild(st); mid.appendChild(bar);
    var x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', 'Remove ' + f.name);
    x.addEventListener('click', function () {
      f.cancel = true;
      if (f.id) api('/api/feed/uploads/' + f.id + '/discard', {}).catch(function () {});
      files = files.filter(function (y) { return y !== f; }); li.remove(); refreshGo();
    });
    li.appendChild(th); li.appendChild(mid); li.appendChild(x);
    f.el = { li: li, th: th, st: st, bar: bar, bi: bi };
    list.appendChild(li);
  }
  function say(f, t, bad) { f.el.st.textContent = t; f.el.st.classList.toggle('bad', !!bad); }

  function upload(f, file) {
    f.state = 'uploading'; refreshGo();
    return api('/api/feed/uploads', { kind: f.kind, size: file.size, name: file.name.slice(0, 100) }).then(function (d) {
      f.id = d.id;
      var chunk = d.chunk || CHUNK, off = 0;
      function next() {
        if (f.cancel) throw new Error('cancelled');
        if (off >= file.size) return api('/api/feed/uploads/' + f.id + '/finish', {});
        var part = file.slice(off, Math.min(file.size, off + chunk));
        return fetch('/api/feed/uploads/' + f.id + '?offset=' + off, {
          method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: part
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
          .then(function (j) {
            off = j.received;
            f.el.bi.style.width = Math.round(off / file.size * 100) + '%';
            say(f, 'Uploading ' + Math.round(off / file.size * 100) + '%');
            return next();
          });
      }
      return next();
    }).then(function () {
      f.state = 'processing'; say(f, f.kind === 'image' ? 'Processing…' : 'Converting (this can take a minute)…'); refreshGo();
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          if (f.cancel) return reject(new Error('cancelled'));
          fetch('/api/feed/uploads/' + f.id, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
            if (j.state === 'ready') return resolve(j.attachment);
            if (j.state === 'failed' || j.state === 'deleted' || !j.ok) return reject(new Error(j.error || 'That file couldn\'t be processed.'));
            if (++tries > 400) return reject(new Error('Processing took too long.'));
            setTimeout(poll, tries < 10 ? 800 : 2000);
          }).catch(function () { setTimeout(poll, 3000); });
        })();
      });
    }).then(function (att) {
      f.state = 'ready';
      say(f, (f.kind === 'image' ? 'Ready' : 'Ready · ' + (att.secs ? Math.round(att.secs) + 's' : '')) + ' ✔');
      if (att.url && (f.kind === 'image' || f.kind === 'video')) f.el.th.style.backgroundImage = 'url("' + att.url.replace(/["\\]/g, '') + '")', f.el.th.textContent = '';
      refreshGo();
    }).catch(function (e) {
      if (f.cancel) return;
      f.state = 'failed'; say(f, '⚠️ ' + e.message, true); refreshGo();
    });
  }

  form.querySelectorAll('input[type=file]').forEach(function (inp) {
    inp.addEventListener('change', function () {
      setErr('');
      var kind = inp.getAttribute('data-kind');
      Array.prototype.slice.call(inp.files || []).forEach(function (file) {
        var have = files.filter(function (x) { return x.kind === kind && x.state !== 'failed'; }).length;
        if (kind === 'image' && have >= maxImages) return setErr('At most ' + maxImages + ' pictures per post.');
        if (kind !== 'image' && have >= 1) return setErr('One ' + kind + ' file per post.');
        var capMb = caps[kind] || 10;
        if (file.size > capMb * 1024 * 1024) return setErr(file.name + ' is over ' + capMb + ' MB.');
        var f = { kind: kind, name: file.name, state: 'new' };
        files.push(f); row(f); upload(f, file);
      });
      inp.value = '';
    });
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    setErr('');
    if (busy()) return setErr('Wait for the uploads to finish.');
    var roomsSel = Array.prototype.slice.call(form.querySelectorAll('input[name=room]:checked')).map(function (x) { return x.value; });
    if (roomsSel.length > maxRooms) return setErr('Post to at most ' + maxRooms + ' rooms at once.');
    var body = {
      title: form.elements.title.value, body: form.elements.body.value, link: form.elements.link.value.trim(), nsfw: form.elements.nsfw.checked,
      global: form.elements.global.checked, rooms: roomsSel,
      attachments: files.filter(function (f) { return f.state === 'ready'; }).map(function (f) { return f.id; })
    };
    go.disabled = true; go.textContent = 'Posting…';
    api('/api/feed/posts', body).then(function (d) {
      errEl.textContent = 'Posted ✔'; errEl.classList.add('ok');
      // stay on a room page / the feed (the new post shows on top of New); elsewhere open the post
      var u = new URL(location.href);
      if (/^\/rooms\//.test(u.pathname)) { u.searchParams.delete('fsort'); u.searchParams.delete('fp'); u.hash = 'feed';
        var target = u.toString();
        if (target.split('#')[0] === location.href.split('#')[0]) { location.hash = 'feed'; location.reload(); } else location.href = target; }
      else location.href = d.url;
    }).catch(function (e) { setErr(e.message); go.disabled = false; go.textContent = 'Post'; });
  });
  refreshGo();
})();
