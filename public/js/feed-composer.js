// feed-composer.js — the post composer (moved out of feed.js in 1.99bz) and the /feed page's
// in-place list switching.
//
// Composer: chunked uploads, link preview, price, plus (1.99bz)
//   * the draft (title, text, link, NSFW, destinations, finished uploads) is autosaved per user in
//     localStorage and restored on the next visit; it's cleared once the post is made
//   * (1.99ci) exactly ONE community per post, picked from a searchable list (no main feed, no
//     multi-select - Crosspost shares a post into other communities); a room page / community view
//     preselects its own
//   * "Pepe announces it in <room>" for the picked community, only when its owner switched announcements on
//     (1.99cu: always shown for the picked pad; default ON for Camfrog pads; greyed out with the reason - announcements
//     off, no Camfrog room, Pepe not in the room - when he can't; disabled boxes are never sent nor kept in the draft)
// Page: the pad bar, sort and pager links on /feed and /feed/following (data-swap)
// swap #fdTop / #fdList in place (fetch + DOMParser) with history entries, so nothing typed in the
// composer is ever lost.
(function () {
  'use strict';
  if (window.__patvComposer) return;
  window.__patvComposer = true;

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

  // ── /feed: swap the list in place ──
  var SWAP_IDS = ['fdTop', 'fdList'];
  var swapping = null;
  // the feed's own addresses: /feed (All), /feed/following (1.99ck: one pad's feed is its pad page /p/<slug>)
  function feedPath(p) { return p === '/feed' || p === '/feed/following'; }
  function canSwap() { return !!document.getElementById('fdList') && feedPath(location.pathname); }
  function swap(url, push) {
    if (!canSwap()) { location.href = url; return Promise.resolve(); }
    var u = new URL(url, location.href);
    if (u.origin !== location.origin || !feedPath(u.pathname)) { location.href = url; return Promise.resolve(); }
    var list = document.getElementById('fdList');
    list.setAttribute('aria-busy', 'true'); list.classList.add('fd-loading');
    var mine = swapping = fetch(u.toString(), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch-page' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (html) {
        if (mine !== swapping) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        SWAP_IDS.forEach(function (id) {
          var a = document.getElementById(id), b = doc.getElementById(id);
          if (a && b) a.innerHTML = b.innerHTML;
        });
        if (doc.title) document.title = doc.title;
        if (push) history.pushState({ patvSwap: 1 }, '', u.pathname + u.search);
        document.dispatchEvent(new CustomEvent('patv:feed-swapped'));
      })
      .catch(function () { location.href = u.toString(); })
      .then(function () { var l = document.getElementById('fdList'); if (l) { l.removeAttribute('aria-busy'); l.classList.remove('fd-loading'); } });
    return mine;
  }
  window.patvFeedSwap = swap;
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest('a[data-swap]');
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if (!canSwap()) return;
    ev.preventDefault();
    swap(a.getAttribute('href'), true);
  });
  window.addEventListener('popstate', function () { if (canSwap()) swap(location.href, false); });
  // 1.99ci: the community bar's search box (the bar is swapped in place, so delegated)
  document.addEventListener('input', function (ev) {
    var inp = ev.target;
    if (!inp.hasAttribute || !inp.hasAttribute('data-cb-search')) return;
    var menu = inp.closest('.cb-menu'), n = inp.value.trim().toLowerCase(), any = false;
    menu.querySelectorAll('.cb-it[data-name]').forEach(function (a) { var hit = !n || a.getAttribute('data-name').indexOf(n) >= 0; a.classList.toggle('hide', !hit); any = any || hit; });
    var none = menu.querySelector('[data-cb-none]'); if (none) none.classList.toggle('hide', any || !n);
  });
  document.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (!d.matches || !d.matches('details.cb-pick') || !d.open) return;
    var s = d.querySelector('[data-cb-search]');
    if (s && window.matchMedia('(pointer: fine)').matches) setTimeout(function () { s.focus(); }, 0);
  }, true);
  document.addEventListener('click', function (ev) {
    // close the community menu on an outside click / after picking
    document.querySelectorAll('details.cb-pick[open]').forEach(function (d) { if (!d.contains(ev.target) || ev.target.closest('.cb-it')) d.removeAttribute('open'); });
  });

  // ── the composer ──
  var form = document.getElementById('fcForm');
  if (!form) return;
  var CHUNK = parseInt(form.getAttribute('data-chunk'), 10) || 524288;
  var caps = {}, prices = {};
  try { caps = JSON.parse(form.getAttribute('data-caps')); prices = JSON.parse(form.getAttribute('data-prices')); } catch (e) { /* defaults */ }
  var maxImages = parseInt(form.getAttribute('data-max-images'), 10) || 4;
  var list = document.getElementById('fcFiles');
  var errEl = document.getElementById('fcErr');
  var go = document.getElementById('fcGo');
  var files = [];        // {kind, name, id, state, el, url}
  var linkRow = document.getElementById('fcLinkRow');
  var pv = document.getElementById('fcPv');
  var DRAFT_KEY = 'patvFeedDraft:' + (form.getAttribute('data-user') || '_');
  var DRAFT_TTL = 5 * 3600 * 1000;       // the server drops never-posted uploads after 6 h

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
  function refreshGo() { go.disabled = busy(); go.textContent = busy() ? 'Uploading…' : 'Post'; cost(); saveSoon(); }

  // ── draft (localStorage, a convenience: any failure just means no draft) ──
  function picked() { var x = form.querySelector('input[name=community]:checked'); return x ? x.value : ''; }
  function roomsChecked() { var c = picked(); return c ? [c] : []; }
  function announceOff() { return Array.prototype.slice.call(form.querySelectorAll('input[name=announce]:not(:disabled)')).filter(function (x) { return !x.checked; }).map(function (x) { return x.value; }); }
  function draft() {
    return {
      v: 1, at: Date.now(), path: location.pathname,
      title: form.elements.title.value, body: form.elements.body.value, link: form.elements.link.value, nsfw: form.elements.nsfw.checked,
      community: picked(), announceOff: announceOff(),
      files: files.filter(function (f) { return (f.state === 'ready' || f.restoring) && f.id; }).map(function (f) { return { id: f.id, kind: f.kind, name: f.name, url: f.url || null }; })
    };
  }
  function empty(d) { return !d.title.trim() && !d.body.trim() && !d.link.trim() && !d.files.length; }
  var saveTimer = null, restoring = false;
  function saveNow() {
    if (restoring) return;
    try {
      var d = draft();
      if (empty(d)) localStorage.removeItem(DRAFT_KEY); else localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch (e) { /* private mode / storage full */ }
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* none */ } }
  form.addEventListener('input', saveSoon);
  window.addEventListener('pagehide', saveNow);

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
  function ready(f, att) {
    f.state = 'ready'; f.restoring = false;
    f.el.bi.style.width = '100%';
    say(f, (f.kind === 'image' ? 'Ready' : 'Ready · ' + (att.secs ? Math.round(att.secs) + 's' : '')) + ' ✔');
    if (att.url && (f.kind === 'image' || f.kind === 'video')) {
      f.url = att.url;
      f.el.th.style.backgroundImage = 'url("' + att.url.replace(/["\\]/g, '') + '")'; f.el.th.textContent = '';
    }
    refreshGo();
  }

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
    }).then(function (att) { ready(f, att); }).catch(function (e) {
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

  // ── the community picker (1.99ci): one community, searchable; the announce checkbox follows it ──
  var comm = form.querySelector('.fc-comm');
  function syncAnnounce() {
    var on = roomsChecked();
    form.querySelectorAll('[data-ann-for]').forEach(function (l) { l.classList.toggle('hide', on.indexOf(l.getAttribute('data-ann-for')) < 0); });
  }
  function showPicked() {
    if (!comm) return;
    var x = form.querySelector('input[name=community]:checked');
    var cur = comm.querySelector('[data-comm-cur]');
    cur.textContent = '';
    var b = document.createElement('span'); b.className = 'cbadge sm' + (x ? '' : ' all'); b.setAttribute('aria-hidden', 'true');
    var t = document.createElement('b');
    if (x) {
      b.textContent = x.getAttribute('data-badge') || '';
      b.style.setProperty('--h', x.getAttribute('data-hue') || '0');
      t.textContent = x.getAttribute('data-title') || x.value;
      var sm = document.createElement('small'); sm.textContent = 'p/' + (x.getAttribute('data-slug') || '');
      cur.appendChild(b); cur.appendChild(t); cur.appendChild(sm);
      comm.removeAttribute('data-empty');
    } else {
      b.textContent = '?'; t.textContent = 'Choose a pad';
      cur.appendChild(b); cur.appendChild(t);
      comm.setAttribute('data-empty', '');
    }
  }
  var cs = comm ? comm.querySelector('[data-comm-search]') : null;
  if (cs) {
    cs.addEventListener('input', function () {
      var n = cs.value.trim().toLowerCase(), any = false;
      comm.querySelectorAll('.fc-comm-it').forEach(function (l) { var hit = !n || (l.getAttribute('data-name') || '').indexOf(n) >= 0; l.classList.toggle('hide', !hit); any = any || hit; });
      var none = comm.querySelector('[data-comm-none]'); if (none) none.classList.toggle('hide', any);
    });
    comm.addEventListener('toggle', function () { if (comm.open && window.matchMedia('(pointer: fine)').matches) setTimeout(function () { cs.focus(); }, 0); });
    document.addEventListener('click', function (ev) { if (comm.open && !comm.contains(ev.target)) comm.open = false; });
    // Enter in the search box picks the first match instead of submitting the post
    cs.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var first = Array.prototype.slice.call(comm.querySelectorAll('.fc-comm-it')).filter(function (l) { return !l.classList.contains('hide'); })[0];
      if (first) { var r = first.querySelector('input'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }
  form.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.name === 'community') { syncAnnounce(); showPicked(); if (comm) comm.open = false; setErr(''); }
    saveSoon();
  });

  // ── restore a saved draft ──
  (function restore() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || d.v !== 1 || !(Date.now() - d.at < DRAFT_TTL)) { if (d) clearDraft(); return; }
    restoring = true;
    if (d.title) form.elements.title.value = String(d.title).slice(0, 140);
    if (d.body) form.elements.body.value = String(d.body).slice(0, 5000);
    if (d.link) { form.elements.link.value = String(d.link).slice(0, 2000); linkRow.classList.remove('hide'); }
    form.elements.nsfw.checked = !!d.nsfw;
    // the community: kept unless this page has its own (a room page / community view preselects it)
    if (d.community && !form.getAttribute('data-home')) {
      form.querySelectorAll('input[name=community]').forEach(function (x) { x.checked = x.value === d.community; });
    }
    showPicked();
    if (Array.isArray(d.announceOff)) form.querySelectorAll('input[name=announce]:not(:disabled)').forEach(function (x) { x.checked = d.announceOff.indexOf(x.value) < 0; });
    syncAnnounce();
    var pending = (Array.isArray(d.files) ? d.files : []).slice(0, 6).filter(function (x) { return x && /^[a-f0-9]{24}$/.test(String(x.id)); });
    pending.forEach(function (x) {
      var f = { kind: x.kind === 'audio' || x.kind === 'video' ? x.kind : 'image', name: String(x.name || 'file').slice(0, 100), id: x.id, state: 'processing', restoring: true, url: x.url || null };
      files.push(f); row(f); say(f, 'Checking…');
      fetch('/api/feed/uploads/' + f.id, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.ok && j.state === 'ready' && j.attachment) ready(f, j.attachment);
        else { files = files.filter(function (y) { return y !== f; }); f.el.li.remove(); refreshGo(); }
      }).catch(function () { files = files.filter(function (y) { return y !== f; }); f.el.li.remove(); refreshGo(); });
    });
    restoring = false;
    if (d.link) preview();
    errEl.textContent = 'Draft restored'; errEl.classList.add('ok');
    var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'fc-clear'; clr.textContent = 'Discard draft';
    clr.addEventListener('click', function () {
      files.forEach(function (f) { f.cancel = true; if (f.id) api('/api/feed/uploads/' + f.id + '/discard', {}).catch(function () {}); if (f.el) f.el.li.remove(); });
      files = [];
      form.elements.title.value = ''; form.elements.body.value = ''; form.elements.link.value = ''; form.elements.nsfw.checked = false; pv.textContent = '';
      clearDraft(); setErr(''); clr.remove(); refreshGo();
    });
    errEl.parentNode.insertBefore(clr, errEl.nextSibling);
  })();

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    setErr('');
    if (busy()) return setErr('Wait for the uploads to finish.');
    var roomsSel = roomsChecked();
    if (!roomsSel.length) { setErr('Choose a pad to post in.'); if (comm) comm.open = true; return; }
    var announce = Array.prototype.slice.call(form.querySelectorAll('input[name=announce]:checked:not(:disabled)'))
      .map(function (x) { return x.value; }).filter(function (v) { return roomsSel.indexOf(v) >= 0; });
    var body = {
      title: form.elements.title.value, body: form.elements.body.value, link: form.elements.link.value.trim(), nsfw: form.elements.nsfw.checked,
      community: roomsSel[0], announce: announce,
      attachments: files.filter(function (f) { return f.state === 'ready'; }).map(function (f) { return f.id; })
    };
    // 1.99cc: the Terms tick box (shown until this account accepted the current version)
    var tk = form.elements.acceptTerms;
    if (tk && !tk.checked) { setErr('Tick the box to accept the Terms of Service first.'); tk.focus(); return; }
    if (tk && tk.checked) body.acceptTerms = true;
    go.disabled = true; go.textContent = 'Posting…';
    api('/api/feed/posts', body).catch(function (e) {
      // not accepted yet (a page from before the change): ask once, then post again
      if (e.code !== 'terms' || !window.patvSafety) throw e;
      return window.patvSafety.termsAsk().then(function (yes) {
        if (!yes) throw new Error('You need to accept the Terms of Service to post.');
        body.acceptTerms = true;
        return api('/api/feed/posts', body);
      });
    }).then(function (d) {
      clearTimeout(saveTimer); clearDraft(); restoring = true;     // posted: the draft is done
      errEl.textContent = 'Posted ✔'; errEl.classList.add('ok');
      // stay on a pad page (the new post shows on top of New); elsewhere open the post
      var u = new URL(location.href);
      if (/^\/p\/[^/]+\/?$/.test(u.pathname)) { ['fsort', 'fp', 'sort', 'p', 't', 'ft'].forEach(function (k) { u.searchParams.delete(k); }); u.hash = 'feed';
        var target = u.toString();
        if (target.split('#')[0] === location.href.split('#')[0]) { location.hash = 'feed'; location.reload(); } else location.href = target; }
      else location.href = d.url;
    }).catch(function (e) { setErr(e.message); go.disabled = false; go.textContent = 'Post'; });
  });
  refreshGo();
})();
