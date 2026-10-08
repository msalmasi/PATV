// feed-gallery.js — 1.99fn: the feeds' ☰ List / ▦ Gallery toggle and the gallery grid (feedgallery.js on the server,
// views/partials/feed-sort.ejs + feed-gallery.ejs, public/css/feed-gallery.css).
//
//   * The sort bar (nav.fs) carries data-view="list|gallery"; CSS shows the post list or the grid from it.
//   * Which view on load: ?view= (a deep link) or the member's saved choice (the server decided: data-fv-src "query" /
//     "account"), else this browser's choice for the scope (localStorage patvFeedView: {scope: view}), else List.
//   * Switching: the bar's data-view, the address (?view=gallery / no view for List, replaceState), localStorage, and -
//     signed in - the account (POST /api/feed/view), so the next device opens the same way.
//   * The grid: GET /api/feed/gallery?scope=&sort=&t=&cursor= (Hop's media-only list and cursor), more tiles as the end
//     comes into view (IntersectionObserver; a "Load more" button without it). A tap opens Hop at that post
//     (window.patvHop, else the tile's link to Hop's page). NSFW tiles stay blurred unless the member chose "always show"
//     (localStorage patvFeedNsfw - the feed's own setting).
// Every localStorage access is wrapped: it's a convenience only.
(function () {
  'use strict';
  if (window.__patvGallery) return;
  window.__patvGallery = true;

  var LS = 'patvFeedView';
  function lsMap() { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } }
  function lsSet(scope, v) {
    try {
      var m = lsMap(); m[scope] = v;
      var k = Object.keys(m); if (k.length > 100) k.slice(0, k.length - 100).forEach(function (x) { delete m[x]; });
      localStorage.setItem(LS, JSON.stringify(m));
    } catch (e) { /* private mode */ }
  }
  function nsfwOk() { try { return localStorage.getItem('patvFeedNsfw') === '1'; } catch (e) { return false; } }
  function signed() { var f = document.querySelector('script[src*="/public/js/feed.js"]'); return !!(f && f.getAttribute('data-signed')); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function num(n) {
    var v = Number(n) || 0, a = Math.abs(v);
    if (a < 1000) return String(v);
    if (a < 1e6) return (v / 1000).toFixed(a < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
    return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  }
  function qs(o) {
    var p = [];
    Object.keys(o).forEach(function (k) { if (o[k] !== null && o[k] !== undefined && o[k] !== '') p.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k])); });
    return p.length ? '?' + p.join('&') : '';
  }

  // the bar <-> its grid (siblings; a <link> may sit between them)
  function gridOf(nav) { for (var n = nav.nextElementSibling; n; n = n.nextElementSibling) if (n.classList && n.classList.contains('fg')) return n; return null; }
  function barOf(fg) { for (var n = fg.previousElementSibling; n; n = n.previousElementSibling) if (n.classList && n.classList.contains('fs')) return n; return null; }

  // ── tiles ──
  function tile(x) {
    var li = el('li', 'fg-t' + (x.nsfw ? ' nsfw' : '')); li.setAttribute('data-id', x.id);
    var a = el('a', 'fg-a'); a.href = x.hop; a.setAttribute('data-fg-post', x.id);
    var ic = x.clip ? ['📹', 'captured clip'] : x.video ? ['▶', 'video'] : x.multi ? ['❐', x.multi + ' pictures'] : null;
    a.setAttribute('aria-label', (x.title || 'Post') + (ic ? ' (' + ic[1] + ')' : '') + (x.ai ? ' (AI-generated)' : '') + (x.nsfw ? ' (NSFW)' : '') +
      ' - ' + (Number(x.score) || 0) + ' votes, ' + (Number(x.comments) || 0) + ' comments');
    if (x.thumb) {
      var img = el('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = x.thumb;
      img.addEventListener('error', function () { img.remove(); });
      a.appendChild(img);
    } else { var ph = el('span', 'fg-ph', '▶'); ph.setAttribute('aria-hidden', 'true'); a.appendChild(ph); }
    if (ic) { var i = el('span', 'fg-ic', ic[0]); i.setAttribute('aria-hidden', 'true'); a.appendChild(i); }
    if (x.nsfw) { var n = el('span', 'fg-18', '18+'); n.setAttribute('aria-hidden', 'true'); a.appendChild(n); }
    var ov = el('span', 'fg-ov'); ov.setAttribute('aria-hidden', 'true');
    ov.appendChild(el('span', null, '▲ ' + num(x.score))); ov.appendChild(el('span', null, '💬 ' + num(x.comments)));
    a.appendChild(ov);
    li.appendChild(a);
    return li;
  }
  function textLine(fg, t) {
    var p = fg.querySelector('.fg-text'), s = fg.querySelector('[data-fg-textn]');
    if (!p || !s) return;
    if (!t || !t.n) { p.hidden = true; return; }
    s.textContent = t.n + (t.more ? '+' : '') + ' text post' + (t.n === 1 && !t.more ? '' : 's');
    p.hidden = false;
  }

  // ── paging ──
  function load(fg, first) {
    if (fg._busy) return;
    var cur = first ? '' : fg.getAttribute('data-fg-next');
    if (!first && !cur) return;
    fg._busy = true;
    var st = fg.querySelector('.fg-status');
    if (st) st.textContent = 'Loading…';
    var url = '/api/feed/gallery' + qs({ scope: fg.getAttribute('data-fg-scope'), sort: fg.getAttribute('data-fg-sort'), t: fg.getAttribute('data-fg-t'), cursor: cur });
    fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; });
    }).then(function (d) {
      var grid = fg.querySelector('.fg-grid');
      if (first) { grid.innerHTML = ''; textLine(fg, d.text); }
      var have = {};
      grid.querySelectorAll('.fg-t[data-id]').forEach(function (li) { have[li.getAttribute('data-id')] = 1; });
      (d.tiles || []).forEach(function (x) { if (!have[x.id]) { grid.appendChild(tile(x)); have[x.id] = 1; } });
      fg.setAttribute('data-fg-next', d.next || '');
      fg.setAttribute('data-fg-loaded', '1');
      var empty = fg.querySelector('.fg-empty'); if (empty) empty.hidden = grid.children.length > 0;
      if (st) st.textContent = '';
      fg._busy = false;
      watch(fg);
    }).catch(function (e) {
      fg._busy = false;
      if (!st) return;
      st.textContent = '';
      var b = el('button', null, 'Couldn\'t load (' + (e.message || 'error') + ') - try again'); b.type = 'button';
      b.addEventListener('click', function () { load(fg, !fg.getAttribute('data-fg-loaded')); });
      st.appendChild(b);
    });
  }
  function watch(fg) {
    var s = fg.querySelector('.fg-sentinel'), st = fg.querySelector('.fg-status');
    if (!s) return;
    if (fg._io) { fg._io.disconnect(); fg._io = null; }
    if (!fg.getAttribute('data-fg-next')) return;
    if ('IntersectionObserver' in window) {
      fg._io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting && isGallery(fg)) load(fg, false); });
      }, { rootMargin: '600px 0px' });
      fg._io.observe(s);
    } else if (st && !st.querySelector('button')) {
      var b = el('button', null, 'Load more'); b.type = 'button';
      b.addEventListener('click', function () { b.remove(); load(fg, false); });
      st.appendChild(b);
    }
  }
  function isGallery(fg) { var nav = barOf(fg); return !!nav && nav.getAttribute('data-view') === 'gallery'; }

  // ── switching ──
  function paintToggle(nav, v) {
    nav.querySelectorAll('.fv [data-fv]').forEach(function (b) {
      var on = b.getAttribute('data-fv') === v;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function setUrl(v) {
    try {
      var u = new URL(location.href);
      if (v === 'gallery') u.searchParams.set('view', 'gallery'); else u.searchParams.delete('view');
      if (u.toString() !== location.href) history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) { /* old browser */ }
  }
  function apply(nav, v, opts) {
    opts = opts || {};
    nav.setAttribute('data-view', v);
    paintToggle(nav, v);
    var fg = gridOf(nav);
    if (fg && v === 'gallery') {
      if (nsfwOk()) fg.classList.add('fg-nsfw-ok');
      if (!fg.getAttribute('data-fg-loaded')) load(fg, true); else watch(fg);
    }
    if (opts.url) setUrl(v);
    var fv = nav.querySelector('.fv'), scope = fv && fv.getAttribute('data-fv-scope');
    if (opts.save && scope) {
      lsSet(scope, v);
      if (signed()) {
        fetch('/api/feed/view', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
          body: JSON.stringify({ scope: scope, view: v }) }).catch(function () {});
      }
    }
  }
  function init() {
    document.querySelectorAll('nav.fs[data-view]').forEach(function (nav) {
      if (nav._fv) return;
      nav._fv = true;
      var fv = nav.querySelector('.fv');
      if (!fv) return;
      var scope = fv.getAttribute('data-fv-scope'), src = fv.getAttribute('data-fv-src');
      var v = nav.getAttribute('data-view') === 'gallery' ? 'gallery' : 'list';
      if (!src) {
        // the server didn't decide: this browser's choice for this feed (and, signed in, it becomes the account's)
        var mine = lsMap()[scope];
        if (mine === 'gallery' || mine === 'list') { v = mine; apply(nav, v, { save: mine === 'gallery' && signed(), url: v === 'gallery' }); return; }
      } else if (src === 'query') lsSet(scope, v);
      apply(nav, v, {});
    });
  }

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var b = ev.target.closest('[data-fv]');
    if (b) {
      var nav = b.closest('nav.fs') || (b.closest('.fg') && barOf(b.closest('.fg')));
      if (!nav) return;
      ev.preventDefault();
      var v = b.getAttribute('data-fv') === 'gallery' ? 'gallery' : 'list';
      apply(nav, v, { save: true, url: true });
      if (v === 'list' && b.closest('.fg')) { try { nav.scrollIntoView({ block: 'nearest' }); } catch (e) { /* none */ } }
      return;
    }
    var t = ev.target.closest('a[data-fg-post]');
    if (!t || !window.patvHop) return;
    var fg = t.closest('.fg');
    if (!fg) return;
    ev.preventDefault();
    window.patvHop.open({ scope: fg.getAttribute('data-fg-hop'), sort: fg.getAttribute('data-fg-sort') || 'hot', t: fg.getAttribute('data-fg-t') || '',
                          post: t.getAttribute('data-fg-post'), signed: signed(), opener: t });
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  document.addEventListener('patv:feed-swapped', init);
  window.patvGallery = { init: init };
})();
