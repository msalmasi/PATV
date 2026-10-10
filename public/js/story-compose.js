// story-compose.js — "＋ Your story" (1.99ez): post a picture or a short video (<= 30 s) as a 24-hour story, to a
// pad you can post in or to your profile. Opened by any [data-story-compose] element (the story strips on the homepage,
// /feed, pad pages and profiles; data-pad preselects a pad id, "user:<id>" / "profile" = your profile).
// The file goes through the feed's upload pipeline (chunked; purpose "story": re-encoded, metadata stripped, size and
// length caps) and then POST /api/stories/mine {attachment, pad, nsfw}; the server checks the pad's posting rules,
// bans and the safety check again. The page reloads to show the new story.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  if (window.__patvStoryCompose) return;
  window.__patvStoryCompose = true;

  var MAX_SECS = 30, CHUNK = 512 * 1024;
  var dlg = null, busy = false, cancelled = false;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (d) { if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }

  function close() {
    if (busy && !window.confirm(_t('js.feed.sc.stop', 'Stop posting your story?'))) return;
    cancelled = true;
    if (dlg) dlg.remove();
    dlg = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function open(pad) {
    if (dlg) return;
    cancelled = false; busy = false;
    dlg = el('div', 'sc-dlg'); dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-label', _t('js.feed.sc.title', 'Add your story'));
    var card = el('div', 'sc-card');
    card.appendChild(el('h2', null, '＋ Your story'));
    var msg = el('p', 'sc-msg', _t('js.feed.sc.loading', 'Loading…')); msg.setAttribute('role', 'status');
    card.appendChild(msg);
    dlg.appendChild(card);
    dlg.addEventListener('click', function (e) { if (e.target === dlg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(dlg);
    fetch('/api/stories/targets', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!dlg) return;
      if (!d.ok) { msg.className = 'sc-msg bad'; msg.textContent = d.error || _t('js.feed.sc.not_now', 'Not right now.'); return; }
      if (d.refusal || !d.pads || !d.pads.length) { msg.className = 'sc-msg bad'; msg.textContent = d.refusal || _t('js.feed.sc.nowhere', 'There\'s nowhere you can post a story right now.'); addClose(card); return; }
      if (d.caps && d.caps.secs) MAX_SECS = d.caps.secs;
      form(card, msg, d, pad);
    }).catch(function () { if (msg) { msg.className = 'sc-msg bad'; msg.textContent = _t('js.feed.sc.unreachable', 'Couldn\'t reach the site.'); } });
  }
  function addClose(card) {
    var x = el('button', 'sv-btn ghost', _t('js.feed.sc.close', 'Close')); x.type = 'button'; x.addEventListener('click', close); card.appendChild(x);
  }

  function form(card, msg, d, pad) {
    msg.textContent = ''; msg.className = 'sc-msg';
    var lab = el('label', null, _t('js.feed.sc.post_to', 'Post to'));
    var sel = el('select'); sel.setAttribute('aria-label', _t('js.feed.sc.where', 'Where to post your story'));
    d.pads.forEach(function (p) {
      var o = el('option', null, p.profile ? _t('js.feed.sc.your_profile', 'Your profile ({label})', { label: p.label }) : p.title + ' (' + p.label + ')'); o.value = p.id; sel.appendChild(o);
    });
    var want = String(pad || '');
    if (/^user:|^profile$/i.test(want)) sel.value = d.pads[0].id;
    else if (want && d.pads.some(function (p) { return p.id === want; })) sel.value = want;
    lab.appendChild(sel); card.insertBefore(lab, msg);
    var fl = el('label', null, _t('js.feed.sc.file', 'A picture, or a video up to {n} s', { n: MAX_SECS }));
    var inp = el('input'); inp.type = 'file'; inp.accept = 'image/*,video/*';
    fl.appendChild(inp); card.insertBefore(fl, msg);
    var prev = el('div', 'sc-prev'); prev.hidden = true; card.insertBefore(prev, msg);
    var nl = el('label', 'sc-chk'); var nsfw = el('input'); nsfw.type = 'checkbox'; nl.appendChild(nsfw); nl.appendChild(document.createTextNode(_t('js.feed.sc.nsfw', 'NSFW (blurred until someone taps it)')));
    card.insertBefore(nl, msg);
    var bar = el('div', 'sc-bar'); var bi = el('i'); bar.appendChild(bi); bar.hidden = true; card.insertBefore(bar, msg);
    card.insertBefore(el('p', 'sc-note', _t('js.feed.sc.note', 'Stories disappear after 24 hours. Pictures and videos are re-encoded and their metadata (location, camera) is removed. Follow the pad\'s rules and the Terms.')), msg);
    var row = el('div', 'sc-row');
    var go = el('button', 'sv-btn primary', _t('js.feed.sc.post', 'Post story')); go.type = 'button'; go.disabled = true;
    var no = el('button', 'sv-btn ghost', _t('js.feed.sc.cancel', 'Cancel')); no.type = 'button'; no.addEventListener('click', close);
    row.appendChild(go); row.appendChild(no); card.appendChild(row);
    var file = null, kind = null, url = null;
    function say(t, cls) { msg.className = 'sc-msg' + (cls ? ' ' + cls : ''); msg.textContent = t || ''; }
    inp.addEventListener('change', function () {
      say(''); go.disabled = true; file = null;
      if (url) { URL.revokeObjectURL(url); url = null; }
      prev.innerHTML = ''; prev.hidden = true;
      var f = inp.files && inp.files[0];
      if (!f) return;
      kind = /^video\//.test(f.type) ? 'video' : /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name) ? 'image' : null;
      if (!kind) return say(_t('js.feed.sc.pick', 'Pick a picture or a video.'), 'bad');
      var capMb = kind === 'video' ? (d.caps && d.caps.videoMb) || 60 : (d.caps && d.caps.imageMb) || 10;
      if (f.size > capMb * 1024 * 1024) return say(kind === 'video' ? _t('js.feed.sc.video_cap', 'Videos can be up to {n} MB.', { n: capMb }) : _t('js.feed.sc.picture_cap', 'Pictures can be up to {n} MB.', { n: capMb }), 'bad');
      url = URL.createObjectURL(f);
      if (kind === 'video') {
        var v = el('video'); v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.controls = true; v.preload = 'metadata';
        v.addEventListener('loadedmetadata', function () {
          if (isFinite(v.duration) && v.duration > MAX_SECS + 0.5) { say(_t('js.feed.sc.too_long_video', 'That video is {s} s - stories can be up to {n} s.', { s: Math.round(v.duration), n: MAX_SECS }), 'bad'); go.disabled = true; file = null; }
        });
        v.src = url; prev.appendChild(v);
      } else {
        var im = el('img'); im.alt = _t('js.feed.sc.pic_alt', 'Your story picture'); im.src = url; im.onerror = function () { im.remove(); prev.appendChild(el('p', 'sc-note', _t('js.feed.sc.no_preview', '(no preview for this format - it will be converted)'))); };
        prev.appendChild(im);
      }
      prev.hidden = false; file = f; go.disabled = false;
    });
    go.addEventListener('click', function () {
      if (!file || busy) return;
      busy = true; go.disabled = true; inp.disabled = true; sel.disabled = true; bar.hidden = false;
      say(_t('js.feed.sc.uploading', 'Uploading…'));
      upload(file, kind, function (p) { bi.style.width = Math.round(p * 100) + '%'; say(_t('js.feed.sc.uploading_pct', 'Uploading {n}%', { n: Math.round(p * 100) })); })
        .then(function (att) {
          say(kind === 'video' ? _t('js.feed.sc.converting', 'Converting your video (this can take a minute)…') : _t('js.feed.sc.processing', 'Processing…'));
          return waitReady(att);
        })
        .then(function (aid) { say(_t('js.feed.sc.posting', 'Posting…')); return api('/api/stories/mine', { attachment: aid, pad: sel.value, nsfw: nsfw.checked }); })
        .then(function (r) {
          busy = false; say(_t('js.feed.sc.posted', 'Posted! It\'s up for 24 hours.'), 'ok');
          void r;
          setTimeout(function () { location.reload(); }, 700);
        })
        .catch(function (e) {
          busy = false;
          if (cancelled) return;
          say(e.message || _t('js.feed.sc.failed', 'That didn\'t work.'), 'bad'); go.disabled = !file; inp.disabled = false; sel.disabled = false; bar.hidden = true;
        });
    });
  }

  function upload(file, kind, progress) {
    return api('/api/feed/uploads', { kind: kind, size: file.size, name: String(file.name || '').slice(0, 100), purpose: 'story' }).then(function (d) {
      var id = d.id, chunk = d.chunk || CHUNK, off = 0;
      function next() {
        if (cancelled) { api('/api/feed/uploads/' + id + '/discard', {}).catch(function () {}); throw new Error('cancelled'); }
        if (off >= file.size) return api('/api/feed/uploads/' + id + '/finish', {}).then(function () { return id; });
        var part = file.slice(off, Math.min(file.size, off + chunk));
        return fetch('/api/feed/uploads/' + id + '?offset=' + off, {
          method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: part
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
          .then(function (j) { off = j.received; progress(off / file.size); return next(); });
      }
      return next();
    });
  }
  function waitReady(id) {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function poll() {
        if (cancelled) return reject(new Error('cancelled'));
        fetch('/api/feed/uploads/' + id, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.state === 'ready') return resolve(id);
          if (j.state === 'failed' || j.state === 'deleted' || !j.ok) return reject(new Error(j.error || _t('js.feed.fc.not_processed', 'That file couldn\'t be processed.')));
          if (++tries > 300) return reject(new Error(_t('js.feed.fc.too_long', 'Processing took too long.')));
          setTimeout(poll, tries < 10 ? 800 : 2000);
        }).catch(function () { setTimeout(poll, 3000); });
      })();
    });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-story-compose]');
    if (!t || ev.button !== 0) return;
    ev.preventDefault();
    open(t.getAttribute('data-pad') || '');
  });
  window.patvStoryCompose = { open: open };
})();
