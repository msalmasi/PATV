// hop.js — Hop (1.99eq): the full-screen, vertical media viewer. You hop from post to post - pictures, videos and
// clips one at a time, with the post's title, author, pad, votes and comment count over it and a tap through to the post.
// The name comes from the server (hop.js HOP, via data-hop-name on this script tag).
//
// Opens
//   * over a feed: tapping a picture / video in a feed card ([data-hop] inside .fp) or the sort bar's "▶ Hop" button
//     (a.fs-hop: data-hop-scope / -sort / -t). It starts at that post and goes on through that feed's media posts in
//     its sort (GET /api/hop, cursor paging). The address follows the post in view (replaceState) on a pushed history
//     entry, so Back or ✕ closes it and leaves you where you were on the feed;
//   * as a page (/hop, /p/<pad>/hop, /u/<user>/hop, /feed/following/hop: #hopInit holds the first page) - ✕ goes back
//     (or to that feed);
//   * with a list (window.patvHop.open({items, base, param}) - the Saved page).
// Controls: swipe / scroll (scroll-snap, one post at a time), the mouse wheel (one post per notch), ↑ / ↓ (also
// PageUp / PageDown, j / k), ← / → between the pictures of one post, M or a tap on a video = sound on / off (videos
// autoplay muted), Space = play / pause, Esc = close. The next posts are loaded ahead; far ones are let go.
// NSFW: blurred behind a tap unless the viewer chose "always show" on the feed (localStorage patvFeedNsfw - a
// convenience, the server already leaves NSFW out for signed-out visitors).
(function () {
  'use strict';
  if (window.__patvHop) return;
  window.__patvHop = true;
  var me = document.currentScript;
  var NAME = (me && me.getAttribute('data-hop-name')) || 'Hop';
  var ICON = (me && me.getAttribute('data-hop-icon')) || '🐸';
  var H = null;

  // ── helpers ──
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function nsfwOk() { return lsGet('patvFeedNsfw') === '1'; }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function num(n) {
    var v = Number(n) || 0, a = Math.abs(v);
    if (a < 1000) return String(v);
    if (a < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (a < 1e6) return Math.round(v / 1000) + 'k';
    return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  }
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (d) {
        if (!r.ok || !d.ok) throw Object.assign(new Error(d.error || ('HTTP ' + r.status)), { status: r.status });
        return d;
      });
    });
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false }; }).then(function (d) {
          if (!r.ok || d.ok === false) throw Object.assign(new Error(d.error || ('HTTP ' + r.status)), { status: r.status });
          return d;
        });
      });
  }
  function qs(o) {
    var p = [];
    Object.keys(o).forEach(function (k) { if (o[k] !== null && o[k] !== undefined && o[k] !== '') p.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k])); });
    return p.length ? '?' + p.join('&') : '';
  }
  function hopBase(scope) {
    var s = String(scope || 'all');
    if (s === 'following') return '/feed/following/hop';
    if (/^p\//.test(s)) return '/p/' + encodeURIComponent(s.slice(2).toLowerCase()) + '/hop';
    if (/^u\//.test(s)) return '/u/' + encodeURIComponent(s.slice(2)) + '/hop';
    return '/hop';
  }

  // ── the viewer ──
  function build() {
    var root = el('div', 'hop'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', NAME); root.tabIndex = -1;
    var top = el('div', 'hop-top');
    var x = el('button', 'hop-ico hop-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close ' + NAME);
    var brand = el('span', 'hop-brand'); brand.appendChild(el('span', 'hop-logo', ICON)); brand.appendChild(el('b', null, NAME));
    var scope = el('span', 'hop-scope');
    var mute = el('button', 'hop-ico hop-mute', '🔇'); mute.type = 'button'; mute.setAttribute('aria-label', 'Sound on');
    top.appendChild(x); top.appendChild(brand); top.appendChild(scope); top.appendChild(mute);
    var list = el('div', 'hop-list'); list.setAttribute('aria-label', NAME + ': posts');
    var nav = el('div', 'hop-nav');
    var up = el('button', 'hop-ico hop-prev', '▲'); up.type = 'button'; up.setAttribute('aria-label', 'Previous post');
    var down = el('button', 'hop-ico hop-next', '▼'); down.type = 'button'; down.setAttribute('aria-label', 'Next post');
    nav.appendChild(up); nav.appendChild(down);
    var live = el('div', 'hop-sr'); live.setAttribute('aria-live', 'polite');
    root.appendChild(list); root.appendChild(top); root.appendChild(nav); root.appendChild(live);
    return { root: root, list: list, x: x, scope: scope, mute: mute, up: up, down: down, live: live };
  }

  function mediaEl(m, it, k) {
    var box = el('div', 'hop-m k-' + m.kind);
    if (m.kind === 'image') {
      var img = el('img', 'hop-img'); img.alt = (it.title ? it.title + ': ' : '') + 'picture' + (it.media.length > 1 ? ' ' + (k + 1) + ' of ' + it.media.length : '');
      img.decoding = 'async'; img.setAttribute('data-src', m.src);
      if (m.w && m.h) { img.width = m.w; img.height = m.h; }
      box.appendChild(img);
    } else {
      var v = el('video', 'hop-vid'); v.setAttribute('playsinline', ''); v.playsInline = true; v.loop = true; v.muted = true; v.setAttribute('muted', '');
      v.preload = 'none'; v.setAttribute('data-src', m.src); if (m.poster) v.poster = m.poster;
      v.setAttribute('aria-label', (it.title ? it.title + ': ' : '') + 'video');
      box.appendChild(v);
      var tap = el('span', 'hop-sound', '🔇 Tap for sound'); tap.setAttribute('aria-hidden', 'true'); box.appendChild(tap);
    }
    if (m.ai) box.appendChild(el('span', 'hop-ai', '✨ AI-generated'));
    return box;
  }

  function slide(it, i) {
    var s = el('section', 'hop-it'); s.setAttribute('data-i', i); s.setAttribute('data-id', it.id);
    s.setAttribute('aria-label', (it.title || 'Post') + (it.author ? ' by ' + it.author.display : ''));
    var col = el('div', 'hop-col');
    var media = el('div', 'hop-media' + (it.media.length > 1 ? ' multi' : ''));
    it.media.forEach(function (m, k) { media.appendChild(mediaEl(m, it, k)); });
    col.appendChild(media);
    if (it.media.length > 1) {
      var dots = el('div', 'hop-dots'); dots.setAttribute('aria-hidden', 'true');
      it.media.forEach(function (_, k) { dots.appendChild(el('i', k ? '' : 'on')); });
      col.appendChild(dots);
      media.addEventListener('scroll', function () {
        var k = Math.round(media.scrollLeft / Math.max(1, media.clientWidth));
        Array.prototype.forEach.call(dots.children, function (d, j) { d.className = j === k ? 'on' : ''; });
      }, { passive: true });
    }
    if (it.nsfw && !nsfwOk() && !H.nsfwOk) {
      s.classList.add('is-gated');
      var gate = el('div', 'hop-nsfw');
      gate.appendChild(el('span', null, '🔞 Marked NSFW'));
      var show = el('button', 'hop-btn primary', 'Show it (18+)'); show.type = 'button'; show.setAttribute('data-hop-reveal', '');
      gate.appendChild(show);
      col.appendChild(gate);
    }
    var info = el('div', 'hop-info');
    if (it.pad) { var pad = el('a', 'hop-pad', it.pad.label); pad.href = it.pad.href; info.appendChild(pad); }
    if (it.capture) info.appendChild(el('span', 'hop-capt', '📸 Captured from ' + it.capture.room));
    if (it.url) { var t = el('a', 'hop-title' + (it.titleFallback ? ' fb' : ''), it.title || 'View the post'); t.href = it.url; info.appendChild(t); }
    else if (it.title) info.appendChild(el('span', 'hop-title' + (it.titleFallback ? ' fb' : ''), it.title));
    if (it.author) {
      var by = el('span', 'hop-by'); by.appendChild(document.createTextNode('by '));
      // 1.99ex: the author's photo (over the monogram) and name style, as in the feed
      if (!it.author.bot && it.author.avatar && /^(https:\/\/|\/)/.test(it.author.avatar)) {
        var av = el('span', 'hop-av'); var im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer';
        im.onerror = function () { av.remove(); }; im.src = it.author.avatar; av.appendChild(im); by.appendChild(av);
      }
      var a = el('a', null); a.href = '/u/' + encodeURIComponent(it.author.username);
      var nm = el('span', !it.author.bot && it.author.nameCss ? 'cx-name' : null, it.author.bot ? '🤖 Pepe' : it.author.display);
      if (!it.author.bot && it.author.nameCss) nm.setAttribute('style', it.author.nameCss);
      a.appendChild(nm); by.appendChild(a);
      info.appendChild(by);
    } else if (it.sub) info.appendChild(el('span', 'hop-by', it.sub));
    col.appendChild(info);
    var rail = el('div', 'hop-rail');
    if (it.url) {
      var upv = el('button', 'hop-rb hop-vote'); upv.type = 'button'; upv.setAttribute('data-hop-vote', '');
      upv.setAttribute('aria-pressed', it.myVote === 1 ? 'true' : 'false'); upv.setAttribute('aria-label', 'Upvote');
      upv.appendChild(el('span', 'ic', '▲')); upv.appendChild(el('b', 'n', num(it.score)));
      rail.appendChild(upv);
      var cm = el('a', 'hop-rb'); cm.href = it.url + '#comments'; cm.setAttribute('aria-label', num(it.comments) + ' comments');
      cm.appendChild(el('span', 'ic', '💬')); cm.appendChild(el('b', 'n', num(it.comments)));
      rail.appendChild(cm);
      var op = el('a', 'hop-rb'); op.href = it.url; op.setAttribute('aria-label', 'Open the post');
      op.appendChild(el('span', 'ic', '↗')); op.appendChild(el('b', 'n', 'Post'));
      rail.appendChild(op);
    }
    (it.actions || []).forEach(function (A) {
      var b = el('button', 'hop-rb'); b.type = 'button'; b.setAttribute('data-hop-action', A.id);
      b.appendChild(el('span', 'ic', A.icon)); b.appendChild(el('b', 'n', A.label)); rail.appendChild(b);
    });
    col.appendChild(rail);
    s.appendChild(col);
    return s;
  }

  function render(from) {
    for (var i = from; i < H.items.length; i++) {
      var s = slide(H.items[i], i);
      H.slides.push(s);
      H.list.insertBefore(s, H.tail);
      H.io.observe(s);
    }
    H.tail.textContent = H.next ? 'Loading more…' : (H.items.length ? 'That\'s everything here.' : '');
    H.tail.classList.toggle('end', !H.next);
    if (!H.items.length) { H.empty.hidden = false; H.up.disabled = true; H.down.disabled = true; }
  }
  function add(items) {
    var from = H.items.length;
    (items || []).forEach(function (it) { if (it && it.id && !H.ids[it.id] && it.media && it.media.length) { H.ids[it.id] = 1; H.items.push(it); } });
    render(from);
  }
  function more() {
    if (!H || !H.next || H.loading || !H.scopeKey) return;
    H.loading = true;
    getJson('/api/hop' + qs({ scope: H.scopeKey, sort: H.sort, t: H.t, cursor: H.next })).then(function (d) {
      if (!H) return;
      H.next = d.next || null; H.loading = false; add(d.items);
    }).catch(function () { if (H) { H.loading = false; H.next = null; H.tail.textContent = 'Couldn\'t load more.'; } });
  }

  // load ±2 around the post in view; let far videos go (a phone has only a few decoders)
  function hydrate(c) {
    H.slides.forEach(function (s, i) {
      var near = i >= c - 1 && i <= c + 2;
      Array.prototype.forEach.call(s.querySelectorAll('[data-src]'), function (m) {
        if (near && !m.getAttribute('src')) { m.src = m.getAttribute('data-src'); if (m.tagName === 'VIDEO') m.preload = i === c || i === c + 1 ? 'auto' : 'metadata'; }
        else if (!near && m.tagName === 'VIDEO' && m.getAttribute('src') && Math.abs(i - c) > 4) { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) { /* gone */ } }
      });
    });
  }
  function videosOf(i) { var s = H.slides[i]; return s ? Array.prototype.slice.call(s.querySelectorAll('video')) : []; }
  function playCur() {
    var s = H.slides[H.cur];
    if (!s || s.classList.contains('is-gated') || document.hidden) return;
    videosOf(H.cur).forEach(function (v) {
      v.muted = H.muted;
      var p = v.play(); if (p && p.catch) p.catch(function () { if (!v.muted) { v.muted = true; H.muted = true; paintMute(); v.play().catch(function () {}); } });
    });
  }
  function paintMute() {
    H.mute.textContent = H.muted ? '🔇' : '🔊'; H.mute.setAttribute('aria-label', H.muted ? 'Sound on' : 'Sound off');
    H.root.classList.toggle('is-muted', H.muted);
  }
  function setMuted(m) { H.muted = m; paintMute(); videosOf(H.cur).forEach(function (v) { v.muted = m; if (!m && v.paused) v.play().catch(function () {}); }); }
  function urlFor(it) {
    if (H.mode === 'list') return H.base + qs({ item: it.id });
    return H.base + qs({ post: it.id, sort: H.sort === 'hot' ? '' : H.sort, t: H.t && /^(top|controversial)$/.test(H.sort) ? H.t : '' });
  }
  function setCur(i) {
    if (!H || i === H.cur || !H.items[i]) return;
    var was = H.cur; H.cur = i;
    if (was >= 0) videosOf(was).forEach(function (v) { try { v.pause(); } catch (e) { /* gone */ } });
    hydrate(i);
    playCur();
    var it = H.items[i];
    try { history.replaceState(H.pushed ? { patvHop: 1 } : history.state, '', urlFor(it)); } catch (e) { /* sandboxed */ }
    H.live.textContent = (it.title || 'Post') + (it.author ? ', by ' + it.author.display : '') + ' (' + (i + 1) + (H.next ? '' : ' of ' + H.items.length) + ')';
    H.up.disabled = i === 0; H.down.disabled = i >= H.items.length - 1 && !H.next;
    if (i >= H.items.length - 3) more();
  }
  function go(d) {
    if (!H) return;
    var j = Math.max(0, Math.min(H.slides.length - 1, H.cur + d));
    if (j === H.cur) { if (d > 0) more(); return; }
    H.slides[j].scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  }

  function wire() {
    H.x.addEventListener('click', function () { close(true); });
    H.mute.addEventListener('click', function () { setMuted(!H.muted); });
    H.up.addEventListener('click', function () { go(-1); });
    H.down.addEventListener('click', function () { go(1); });
    // the wheel: one post per notch (a trackpad's long fling doesn't skip ten)
    H.list.addEventListener('wheel', function (e) {
      if (e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      if (H.wheelLock || Math.abs(e.deltaY) < 4) return;
      H.wheelLock = true; setTimeout(function () { if (H) H.wheelLock = false; }, 600);
      go(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    H.list.addEventListener('click', function (e) {
      var rv = e.target.closest('[data-hop-reveal]');
      if (rv) { var s = rv.closest('.hop-it'); s.classList.remove('is-gated'); rv.parentNode.remove(); H.nsfwOk = true; if (Number(s.getAttribute('data-i')) === H.cur) playCur(); return; }
      var vb = e.target.closest('[data-hop-vote]');
      if (vb) return vote(vb);
      var ac = e.target.closest('[data-hop-action]');
      if (ac && H.onAction) { var it = H.items[Number(ac.closest('.hop-it').getAttribute('data-i'))]; return H.onAction(ac.getAttribute('data-hop-action'), it, ac); }
      if (e.target.closest('.hop-m.k-video')) { setMuted(!H.muted); return; }   // tap a video: sound on / off
    });
    H.root.addEventListener('keydown', function (e) {
      if (e.target.closest && e.target.closest('input, textarea, select')) return;
      var k = e.key;
      if (k === 'Escape') { e.preventDefault(); close(true); }
      else if (k === 'ArrowDown' || k === 'PageDown' || k === 'j') { e.preventDefault(); go(1); }
      else if (k === 'ArrowUp' || k === 'PageUp' || k === 'k') { e.preventDefault(); go(-1); }
      else if (k === 'ArrowRight' || k === 'ArrowLeft') {
        var m = H.slides[H.cur] && H.slides[H.cur].querySelector('.hop-media.multi');
        if (m) { e.preventDefault(); m.scrollBy({ left: (k === 'ArrowRight' ? 1 : -1) * m.clientWidth, behavior: reduced() ? 'auto' : 'smooth' }); }
      }
      else if (k === 'm' || k === 'M') { setMuted(!H.muted); }
      else if (k === ' ' && !e.target.closest('a, button')) {
        e.preventDefault();
        videosOf(H.cur).forEach(function (v) { if (v.paused) v.play().catch(function () {}); else v.pause(); });
      }
      else if (k === 'Tab') {
        var f = Array.prototype.slice.call(H.root.querySelectorAll('a[href], button:not([disabled])')).filter(function (x) { return x.offsetParent !== null; });
        if (!f.length) return;
        var i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
    H.onVis = function () { if (!H) return; if (document.hidden) videosOf(H.cur).forEach(function (v) { v.pause(); }); else playCur(); };
    document.addEventListener('visibilitychange', H.onVis);
  }

  function vote(b) {
    var s = b.closest('.hop-it'), it = H.items[Number(s.getAttribute('data-i'))];
    if (!H.signed) { location.href = '/login?next=' + encodeURIComponent(it.url); return; }
    var dir = it.myVote === 1 ? 0 : 1;
    b.disabled = true;
    post('/api/feed/posts/' + encodeURIComponent(it.id) + '/vote', { dir: dir }).then(function (d) {
      it.myVote = d.vote; it.score = d.score;
      b.setAttribute('aria-pressed', d.vote === 1 ? 'true' : 'false'); b.querySelector('.n').textContent = num(d.score);
    }).catch(function (e) { alert(e.message); }).then(function () { b.disabled = false; });
  }

  /**
   * opts: {scope, sort, t, post (start here), items, next (first page given), base, back, mode: 'overlay' | 'page' | 'list',
   *        label, signed, onAction(id, item, button), opener}
   */
  function open(opts) {
    if (H) teardown();
    var V = build();
    H = { root: V.root, list: V.list, x: V.x, mute: V.mute, up: V.up, down: V.down, live: V.live, items: [], slides: [], ids: {}, cur: -1, muted: true,
          mode: opts.mode || 'overlay', scopeKey: opts.scope || null, sort: opts.sort || 'hot', t: opts.t || '', next: null, loading: false,
          base: opts.base || hopBase(opts.scope), back: opts.back || null, signed: opts.signed !== undefined ? !!opts.signed : !!document.querySelector('[data-signed="1"], .fp-vote'),
          onAction: opts.onAction || null, opener: opts.opener || document.activeElement, pushed: false, nsfwOk: false };
    V.scope.textContent = opts.label || '';
    H.tail = el('div', 'hop-tail'); H.list.appendChild(H.tail);
    H.empty = el('div', 'hop-empty'); H.empty.hidden = true;
    H.empty.appendChild(el('div', 'hop-empty-ic', ICON));
    H.empty.appendChild(el('p', null, 'No pictures or videos here yet.'));
    H.list.appendChild(H.empty);
    H.io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting && e.intersectionRatio >= 0.6) setCur(Number(e.target.getAttribute('data-i'))); });
    }, { root: H.list, threshold: [0.6] });
    wire();
    paintMute();
    document.body.appendChild(H.root);
    document.documentElement.classList.add('hop-open');
    H.root.focus();
    if (H.mode === 'overlay') {
      try { history.pushState({ patvHop: 1 }, '', H.base + qs({ post: opts.post || '', sort: H.sort === 'hot' ? '' : H.sort })); H.pushed = true; } catch (e) { H.pushed = false; }
    }
    var start = function (items, next, startId) {
      H.next = next || null;
      add(items);
      var k = startId ? H.items.findIndex(function (x) { return x.id === startId; }) : 0;
      if (k < 0) k = 0;
      if (H.slides[k]) { H.slides[k].scrollIntoView({ block: 'start' }); setCur(k); }
    };
    if (opts.items) return start(opts.items, opts.next, opts.start || null);
    H.tail.textContent = 'Loading…';
    getJson('/api/hop' + qs({ scope: H.scopeKey, sort: H.sort, t: H.t, post: opts.post || '' })).then(function (d) {
      if (!H) return;
      H.base = d.base || H.base;
      start(d.items, d.next, opts.post || null);
    }).catch(function (e) {
      if (!H) return;
      if (e.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
      H.tail.textContent = 'Couldn\'t load ' + NAME + '.';
    });
  }

  function teardown() {
    if (!H) return;
    try { H.io.disconnect(); } catch (e) { /* none */ }
    H.slides.forEach(function (s) { Array.prototype.forEach.call(s.querySelectorAll('video'), function (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* gone */ } }); });
    document.removeEventListener('visibilitychange', H.onVis);
    H.root.remove();
    document.documentElement.classList.remove('hop-open');
    var o = H.opener;
    H = null;
    if (o && o.focus && document.contains(o)) { try { o.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  function close(user) {
    if (!H) return;
    if (H.mode === 'overlay' && H.pushed && user) { history.back(); return; }      // popstate tears it down
    if (H.mode === 'page') {
      var back = H.back || '/feed';
      var same = false;
      try { same = !!document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1; } catch (e) { same = false; }
      teardown();
      if (same) history.back(); else location.href = back;
      return;
    }
    if (H.mode === 'list' && H.listUrl) { try { history.replaceState(history.state, '', H.listUrl); } catch (e) { /* none */ } }
    teardown();
  }
  window.addEventListener('popstate', function (e) {
    if (H && H.mode === 'overlay' && !(e.state && e.state.patvHop)) { H.pushed = false; teardown(); }
  });

  // ── feeds: the sort bar's Hop button, and a tap on a picture / video ──
  function ctxFor(node) {
    var box = node && node.closest('#fdList, .rf, .pf-panel, main, section');
    var b = (box && box.querySelector('a.fs-hop[data-hop-scope]')) || document.querySelector('a.fs-hop[data-hop-scope]');
    return b ? { scope: b.getAttribute('data-hop-scope'), sort: b.getAttribute('data-hop-sort') || 'hot', t: b.getAttribute('data-hop-t') || '' } : null;
  }
  function signedPage() { var f = document.querySelector('script[src*="/public/js/feed.js"]'); return !!(f && f.getAttribute('data-signed')); }
  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var b = ev.target.closest('a.fs-hop[data-hop-scope]');
    if (b) {
      ev.preventDefault();
      return open({ scope: b.getAttribute('data-hop-scope'), sort: b.getAttribute('data-hop-sort') || 'hot', t: b.getAttribute('data-hop-t') || '', signed: signedPage(), opener: b });
    }
    var m = ev.target.closest('[data-hop]');
    if (!m) return;
    var card = m.closest('.fp');
    if (!card || card.classList.contains('is-detail')) return;
    var c = ctxFor(card);
    if (!c) return;                       // no Hop on this page: the link does what it always did
    ev.preventDefault();
    open({ scope: c.scope, sort: c.sort, t: c.t, post: card.getAttribute('data-id'), signed: signedPage(), opener: m });
  });

  // ── the Hop page: open straight away from #hopInit ──
  function boot() {
    var s = document.getElementById('hopInit');
    if (!s) return;
    var d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
    open({ mode: 'page', scope: d.scope, sort: d.sort, t: d.t, items: d.items, next: d.next, start: d.post || null, base: d.base, back: d.back, label: d.label, signed: !!d.signed });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.patvHop = { open: open, close: function () { close(false); }, _state: function () { return H; }, name: NAME };
})();
