// Dock-only composer extras. The existing relay owns sends, client ids and retries.
// 1.99ajf dockclean: the tool row opens this sheet on a tab (o.tab: 'patv' | 'stickers' | 'gifs' | 'emoji'). 🧸 PATV = the site's own
// sticker packs (GET /api/stickers: the packs this account owns or has as a perk, in the viewer's language); a pick sends exactly
// '[sticker:<pack>/<id>]' through the relay (the server checks the pack and relays '[sticker: Name]' into Camfrog). Emoji insert
// at the caret and the sheet stays open. voices() = the site's voice catalogue (GET /api/voices) for the Dock's 🗣️ Say it sheet.
(function (W) {
  'use strict';
  var tr = typeof W.__t === 'function' ? W.__t : function (k, d, v) {
    return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function t(k, d, v) { return tr('js.pad.picker.' + k, d, v); }
  var EMOJI = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '🙂', '🙃', '😉', '😍', '🥰', '😘', '😎', '🤔', '🤨', '😐', '🙄', '😏', '😴', '😢', '😭', '😤', '😡', '🤯', '😱', '🥳', '🤗', '🫡', '🤫', '🤭', '🫠', '🥹', '💀', '👻', '👀', '💚', '❤️', '💜', '💙', '💛', '💔', '✨', '⭐', '🔥', '💯', '🎉', '🎊', '👏', '🙌', '👍', '👎', '🤝', '🙏', '💪', '👋', '✌️', '🤘', '🫶', '🤷', '🤦', '🐸', '🐈', '🐕', '🦊', '🐼', '🦋', '🌻', '🌈', '🌙', '☀️', '🍿', '🍕', '☕', '🎵', '🎶', '🎤', '🎬', '🎮', '🎲', '🎁', '🏆'];
  function available(data, o) { return !!(o && o.signed && o.relay && data && data.room && data.room.relay); }
  // 1.99aot gifs: free mode - KLIPY's own API from this browser (docs.klipy.com/gifs-api: api/v1/{app_key}/gifs/search | trending |
  // share/{slug}); gifs.js KLIPY_BROWSER_API is the same base. The page link Pepe posts in Camfrog: FREE_PAGE + slug.
  var FREE_API = 'https://api.klipy.com/api/v1', FREE_PAGE = 'https://klipy.com/gifs/', FREE_PRIVACY = 'https://klipy.com/support/privacy-policy';
  var RATINGS = ['high', 'medium', 'low', 'off'];
  // review: the one-time notice accepted on this page - kept here, not on the data object the sheet opened with (a live update replaces
  // that object, and the next sheet would ask again)
  var noticeOk = false;
  // owner 2026-11-19 (KLIPY's rules: Search and Trending as KLIPY gives them - "lets stick to their rules"): a GIF moderators removed
  // everywhere stays in its place among KLIPY's results, in both modes; the site refuses to send it (gif_removed) and the sender's line
  // says so. removedHere = the GIFs the site refused that way on this page: picking one again says so here, with no second send.
  var removedHere = [];
  /** room.gifFree -> {k, r, n} | null (no valid browser key: no free picker). An unknown rating is the strictest. */
  function freeOf(x) {
    if (!x || typeof x !== 'object' || !/^[A-Za-z0-9_-]{8,128}$/.test(String(x.k))) return null;
    return { k: String(x.k), r: RATINGS.indexOf(x.r) >= 0 ? x.r : 'high', n: x.n === true || noticeOk };
  }
  // the same checks the server makes on a send (gifs.js cdnSrc): exact KLIPY CDN hosts, https, no userinfo / port / fragment / encoded
  // characters, KLIPY's own path /ii/<32 hex>/<2 hex>/<2 hex>/<name>.gif|webp, a plain query, at most 512 characters, exactly as given
  var CDN_PATH = /^\/ii\/([0-9a-fA-F]{32})\/([0-9a-fA-F]{2})\/([0-9a-fA-F]{2})\/[A-Za-z0-9_-]{1,64}\.(?:gif|webp)$/;
  function cdnOk(src) {
    if (typeof src !== 'string' || !src || src.length > 512 || /[\u0000-\u0020\u007f\\%#"'<>]/.test(src) || !/^https:\/\//.test(src)) return false;
    try {
      var u = new W.URL(src);
      return u.href === src && u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash &&
        /^(static|static1|static2)\.klipy\.com$/.test(u.hostname) &&
        CDN_PATH.test(u.pathname) && /^[A-Za-z0-9._~=&-]{0,256}$/.test(u.search.replace(/^\?/, ''));
    } catch (e) { return false; }
  }
  function cleanTitle(v) {
    return String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 80);
  }
  function dimOk(n) { return typeof n === 'number' && Math.floor(n) === n && n >= 1 && n <= 4096; }
  /** One size tier of a KLIPY item (file.xs / sm / md) -> {src, w, h} of its webp (smaller), else its gif; null when neither checks. */
  function tierOf(file, tier) {
    var x = file && typeof file === 'object' ? file[tier] : null;
    if (!x || typeof x !== 'object') return null;
    var list = [x.webp, x.gif];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (f && cdnOk(f.url) && dimOk(f.width) && dimOk(f.height)) return { src: f.url, w: f.width, h: f.height };
    }
    return null;
  }
  /** KLIPY's search / trending answer ({result, data: {data: [...]}}) -> [{id: slug, title, preview, media}], in KLIPY's order, all of
   *  it. Only an item this page can't draw safely is skipped (not a GIF item, no usable slug, no picture that passes cdnOk) - never one
   *  for what it shows: no content filter, never re-ranked (owner 2026-11-19: KLIPY's rules). */
  function freeRows(body) {
    var list = body && body.data && Array.isArray(body.data.data) ? body.data.data : [], out = [];
    for (var i = 0; i < list.length && i < 50; i++) {
      var r = list[i];
      if (!r || typeof r !== 'object' || (r.type != null && r.type !== 'gif') || typeof r.slug !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.slug)) continue;
      var media = tierOf(r.file, 'sm') || tierOf(r.file, 'md'), preview = tierOf(r.file, 'xs') || media;
      if (!media) continue;
      out.push({ id: r.slug, title: cleanTitle(r.title), preview: preview, media: media });
    }
    return out;
  }
  // stkimg 1.99akg: a Camfrog tile's picture URL -> the fresh one its next showing asks for, once it failed (this page, every sheet)
  var HAS = Object.prototype.hasOwnProperty, retryTile = {};
  var voiceList = null;
  function voices() {
    if (voiceList) return voiceList;
    voiceList = W.fetch('/api/voices', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { if (!r.ok) throw new Error('unavailable'); return r.json(); })
      .then(function (d) { return d && Array.isArray(d.voices) ? d.voices : []; })
      .catch(function (e) { voiceList = null; throw e; });
    return voiceList;
  }
  function open(o) {
    if (!o || !available(o.data, o) || !o.sheet || !o.relay.getInput || !o.relay._send) return null;
    // (1.99ajq dockpol (owner item 27): a title that says what the sheet is - 🎞️ GIFs from the GIF tool, 🧸 Stickers & emoji otherwise)
    var box = o.sheet(o.tab === 'gifs' ? t('title_gifs', '🎞️ GIFs') : t('title_media', '🧸 Stickers & emoji'), o.opener), doc = box.ownerDocument;
    var room = o.data.room, generation = 0, active = null, search = null;
    var tabs = [], tabBar = el('div', 'ds-seg'), body = el('div', 'rmp-body');
    var status = el('p', 'ds-note'); status.hidden = true; status.style.display = 'none'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    tabBar.setAttribute('role', 'tablist'); tabBar.setAttribute('aria-label', t('tabs', 'Chat media'));
    tabBar.style.marginBlock = 'var(--ds-sp-2)';
    body.style.maxBlockSize = 'min(50dvh, 420px)'; body.style.overflow = 'auto';
    body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-label', t('title', 'Add to the chat'));
    box.appendChild(tabBar); box.appendChild(status); box.appendChild(body);
    function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function button(text, fn, cls) { var b = el('button', cls || 'ds-btn quiet', text); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
    function connected(g) { return box.isConnected && generation === g; }
    function note(text) { status.textContent = text || ''; status.hidden = !text; status.style.display = text ? '' : 'none'; }
    function grid() {
      var n = el('div', 'rmp-grid'); n.style.display = 'grid'; n.style.gridTemplateColumns = 'repeat(auto-fill, minmax(88px, 1fr))'; n.style.gap = 'var(--ds-sp-2)'; body.appendChild(n); return n;
    }
    function closeToInput() { o.closeLayer(false); var input = o.relay.getInput(); if (input && input.isConnected) input.focus(); }
    function send(token, extra) {
      if (!box.isConnected) return;
      if (extra ? o.relay._send(token, extra) : o.relay._send(token)) closeToInput();
      else note(t('queue', 'Your messages are still on their way. Try again in a moment.'));
    }
    // 1.99aot gifs: a GIF pick, either mode. The site's refusal as removed everywhere (gif_removed) is remembered on this page (the
    // sender's line says so at once - room-bridge.js): the GIF stays in its place among KLIPY's results, and picking it again says so
    // plainly here instead of sending it once more
    function pickGif(id, token, extra) {
      if (!box.isConnected) return;
      if (removedHere.indexOf(id) >= 0) { note(t('gif_removed', 'This GIF was removed on PATV.')); return; }
      var x = extra || {};
      x.onRefused = function (code) { if (code === 'gif_removed' && removedHere.indexOf(id) < 0) removedHere.push(id); };
      send(token, x);
    }
    // 1.99aiw dock: review - `post` = a JSON body (the GIF search: its words never ride in a URL, which request logs keep)
    function request(url, g, show, post) {
      note(t('loading', 'Loading…'));
      var init = { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } };
      if (post) { init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(post); }
      W.fetch(url, init)
        .then(function (r) { if (!r.ok) throw new Error('unavailable'); return r.json(); })
        .then(function (rows) {
          if (!connected(g)) return;
          if (!Array.isArray(rows)) throw new Error('unavailable');
          note(rows.length ? '' : t('empty', 'Nothing here yet.'));
          show(rows);
        }).catch(function () { if (connected(g)) note(t('unavailable', 'Could not load this right now. Try again.')); });
    }
    // (stkimg 1.99akg: again = a Camfrog tile - one that failed is asked for once more, under a fresh ?r=, the next time the sheet shows it)
    function picture(parent, src, label, again) {
      var image = el('img'); image.src = again && HAS.call(retryTile, src) ? retryTile[src] : src; image.alt = label; image.loading = 'lazy'; image.decoding = 'async';
      image.style.inlineSize = '100%'; image.style.blockSize = '88px'; image.style.objectFit = 'contain'; image.style.borderRadius = 'var(--ds-r-sm)';
      image.addEventListener('error', function () {
        image.hidden = true;
        if (again && !HAS.call(retryTile, src)) retryTile[src] = src + (src.indexOf('?') < 0 ? '?' : '&') + 'r=' + new Date().getTime().toString(36);
      }); parent.appendChild(image);
    }
    function mediaButton(label, action) {
      var b = button('', action); b.style.display = 'flex'; b.style.flexDirection = 'column'; b.style.minInlineSize = '0';
      b.style.minBlockSize = '132px'; b.style.borderRadius = 'var(--ds-r-md)'; b.style.padding = 'var(--ds-sp-2)';
      b.title = label; return b;
    }
    function caption(parent, label) {
      var n = el('span', null, label); n.style.whiteSpace = 'normal'; n.style.overflowWrap = 'anywhere'; n.style.inlineSize = '100%';
      n.style.fontSize = 'var(--ds-fs-xs)'; n.style.display = '-webkit-box'; n.style.webkitBoxOrient = 'vertical'; n.style.webkitLineClamp = '2'; n.style.overflow = 'hidden'; parent.appendChild(n);
    }
    // 🧸 the site's sticker packs: the ones this account owns or may use right now (perk packs in season)
    function patv(g) {
      note(t('loading', 'Loading…'));
      W.fetch('/api/stickers', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } })
        .then(function (r) { if (!r.ok) throw new Error('unavailable'); return r.json(); })
        .then(function (d) {
          if (!connected(g)) return;
          var packs = d && Array.isArray(d.packs) ? d.packs.filter(function (p) { return p && p.owned && /^[a-z0-9]{1,32}$/.test(String(p.id)) && Array.isArray(p.stickers); }) : [];
          note('');
          if (!packs.length) {
            var empty = el('p', 'ds-note', t('patv_none', 'No sticker packs yet · ')); var a = el('a', null, t('patv_get', 'Get packs ›')); a.href = '/cosmetics?tab=stickers';
            empty.appendChild(a); body.appendChild(empty); return;
          }
          packs.forEach(function (p) {
            var h = el('p', 'ds-eyebrow', (p.emoji ? p.emoji + ' ' : '') + String(p.name || p.id)); h.style.margin = 'var(--ds-sp-2) 0 var(--ds-sp-1)'; body.appendChild(h);
            var items = grid(); items.style.gridTemplateColumns = 'repeat(auto-fill, minmax(72px, 1fr))';
            p.stickers.forEach(function (st) {
              if (!st || !/^[a-z0-9]{1,32}$/.test(String(st.id)) || st.url !== '/public/stickers/' + p.id + '/' + st.id + '.svg') return;
              var name = String(st.name || t('sticker', 'Sticker')).slice(0, 80);
              var b = button('', function () { send('[sticker:' + p.id + '/' + st.id + ']'); }); b.title = name; b.setAttribute('aria-label', t('send_sticker', 'Send sticker: {name}', { name: name }));
              b.style.minBlockSize = '72px'; b.style.padding = 'var(--ds-sp-1)';
              var img = el('img'); img.src = st.url; img.alt = name; img.loading = 'lazy'; img.decoding = 'async'; img.width = 64; img.height = 64; img.style.imageRendering = 'pixelated';
              b.appendChild(img); items.appendChild(b);
            });
          });
        }).catch(function () { if (connected(g)) note(t('unavailable', 'Could not load this right now. Try again.')); });
    }
    function stickers(g) {
      request('/api/rooms/' + encodeURIComponent(o.slug) + '/cfstickers', g, function (rows) {
        var items = grid();
        rows.forEach(function (r) {
          if (!r || !/^\d{1,10}$/.test(String(r.id)) || !/^\d{1,10}$/.test(String(r.set)) || r.src !== '/media/cfsticker/' + r.id + '.webp') return;
          // (stkimg 1.99akg: asked for under ?v= the picture's version - 8 lower-case hex, cfstickers.js - so a new picture is a new URL; a
          // row without one (a server from before this release) is the plain URL, as before)
          var src = typeof r.v === 'string' && /^[a-f0-9]{8}$/.test(r.v) ? r.src + '?v=' + r.v : r.src;
          var desc = String(r.desc || t('sticker', 'Sticker')).slice(0, 240);
          var b = mediaButton(desc, function () { send('[cfsticker:' + r.set + '/' + r.id + ']'); });
          b.setAttribute('aria-label', t('send_sticker', 'Send sticker: {name}', { name: desc })); b.title = desc;
          picture(b, src, desc, true); caption(b, desc); items.appendChild(b);
        });
        if (!items.children.length) note(t('empty', 'Nothing here yet.'));
      });
    }
    function safeGif(src) {
      try { var u = new W.URL(src); return u.protocol === 'https:' && !u.username && !u.password && !u.port && /^(static|static1|static2)\.klipy\.com$/.test(u.hostname); } catch (e) { return false; }
    }
    function gifs() {
      var form = el('form'), label = el('label', 'ds-label', t('search_label', 'Find a GIF'));
      search = el('input', 'ds-in'); search.type = 'search'; search.maxLength = 50; search.placeholder = t('search_placeholder', 'Search KLIPY'); search.setAttribute('aria-label', t('search_label', 'Find a GIF')); search.style.fontSize = '16px';
      label.appendChild(search); form.appendChild(label);
      var submit = button(t('search', 'Search')); submit.type = 'submit'; submit.style.marginBlock = 'var(--ds-sp-2)'; form.appendChild(submit); body.appendChild(form);
      var results = el('div'); body.appendChild(results);
      function load() {
        var g = ++generation, query = search.value.slice(0, 50); results.textContent = '';
        request('/api/gifs/search', g, function (rows) {
          var items = el('div', 'rmp-grid'); items.style.display = 'grid'; items.style.gridTemplateColumns = 'repeat(auto-fill, minmax(100px, 1fr))'; items.style.gap = 'var(--ds-sp-2)'; results.appendChild(items);
          rows.forEach(function (r) {
            if (!r || !/^[A-Za-z0-9_-]{1,64}$/.test(String(r.id)) || !r.preview || !safeGif(r.preview.src)) return;
            var title = String(r.title || t('gif', 'GIF')).slice(0, 80);
            var b = mediaButton(title, function () { pickGif(String(r.id), '[gif:' + r.id + ']'); });
            b.title = title; b.setAttribute('aria-label', t('send_gif', 'Send GIF: {name}', { name: title })); picture(b, r.preview.src, title);
            caption(b, title); items.appendChild(b);
          });
          results.appendChild(el('p', 'ds-fine', t('credit', 'via KLIPY')));
          if (!items.children.length) note(t('empty', 'Nothing here yet.'));
        }, { q: query, pad: o.slug });
      }
      form.addEventListener('submit', function (e) { e.preventDefault(); load(); }); load();
    }
    // 1.99aot gifs: FREE mode (KLIPY's free plan) - this browser asks KLIPY itself and PATV's server never does. room.gifFree is the
    // server's, for this viewer on this pad: k = the browser key, r = this pad's rating (content_filter: high on general pads, low on
    // 18+ pads), n = this member has seen the one-time notice. No customer id, no locale or device data, no cookies go to KLIPY.
    // Results are shown in KLIPY's order (a malformed item is skipped, never re-ranked). A pick posts '[gif:<slug>]' with the GIF's
    // details through the relay (the server checks them); once the site took it, KLIPY's share trigger: q = the search words, '' for
    // trending. Before the first search (trending too - it reaches KLIPY as well) the notice, recorded per account on the server.
    var free = freeOf(room.gifFree);
    function freeUrl(q) {
      return FREE_API + '/' + encodeURIComponent(free.k) + '/gifs/' + (q ? 'search?q=' + encodeURIComponent(q) + '&' : 'trending?') +
        'per_page=24&content_filter=' + encodeURIComponent(free.r) + '&format_filter=gif,webp';
    }
    function share(slug, q) {
      try {
        W.fetch(FREE_API + '/' + encodeURIComponent(free.k) + '/gifs/share/' + encodeURIComponent(slug), { method: 'POST', credentials: 'omit', cache: 'no-store',
          mode: 'cors', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q || '' }) })
          .then(null, function () { /* KLIPY's measurement only - the line is already sent */ });
      } catch (e) { /* no fetch: nothing to measure */ }
    }
    function freeNotice(g) {
      var wrap = el('div', 'rmp-notice'); wrap.setAttribute('role', 'note');
      wrap.style.display = 'grid'; wrap.style.gap = 'var(--ds-sp-2)'; wrap.style.justifyItems = 'start'; wrap.style.paddingBlock = 'var(--ds-sp-2)';
      wrap.appendChild(el('p', null, t('free_notice', 'GIF search is provided by KLIPY. When you search or browse GIFs, what you type and your IP address go to KLIPY, and the GIFs load from KLIPY.')));
      var more = el('p', 'ds-fine'), a = el('a', null, t('free_notice_link', 'KLIPY’s privacy policy'));
      a.href = FREE_PRIVACY; a.target = '_blank'; a.rel = 'noopener noreferrer'; more.appendChild(a); wrap.appendChild(more);
      var ok = button(t('free_notice_ok', 'OK, show GIFs'), function () {
        if (!connected(g)) return;
        // (this page: once - review: noticeOk, whatever data object a later sheet opens with)
        noticeOk = true; free.n = true; if (room.gifFree && typeof room.gifFree === 'object') room.gifFree.n = true;
        W.fetch('/api/gifs/notice', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: '{}' })
          .then(null, function () { /* shown again on another device until it's recorded - never a KLIPY request before it's accepted */ });
        body.textContent = ''; gifsFree();
        // review: focus follows - the OK button is gone. The search box with a fine pointer; else the panel (no uninvited iPhone keyboard)
        var fine = false;
        try { fine = !!(W.matchMedia && W.matchMedia('(pointer: fine)').matches); } catch (e) { fine = false; }
        if (fine && search && search.isConnected) search.focus();
        else { body.tabIndex = -1; body.focus(); }
      }, 'ds-btn');
      wrap.appendChild(ok); body.appendChild(wrap);
      Array.prototype.forEach.call(wrap.querySelectorAll('p'), function (p) { p.style.margin = '0'; });
    }
    function gifsFree() {
      if (!free.n) { freeNotice(generation); return; }
      var form = el('form'), label = el('label', 'ds-label', t('search_label', 'Find a GIF'));
      search = el('input', 'ds-in'); search.type = 'search'; search.maxLength = 50; search.placeholder = t('search_placeholder', 'Search KLIPY'); search.setAttribute('aria-label', t('search_label', 'Find a GIF')); search.style.fontSize = '16px';
      label.appendChild(search); form.appendChild(label);
      var submit = button(t('search', 'Search')); submit.type = 'submit'; submit.style.marginBlock = 'var(--ds-sp-2)'; form.appendChild(submit); body.appendChild(form);
      var results = el('div'); body.appendChild(results);
      function load() {
        var g = ++generation, query = search.value.slice(0, 50).replace(/^\s+|\s+$/g, ''); results.textContent = '';
        note(t('loading', 'Loading…'));
        W.fetch(freeUrl(query), { method: 'GET', credentials: 'omit', cache: 'no-store', mode: 'cors', headers: { Accept: 'application/json' } })
          .then(function (r) { if (!r.ok) throw new Error('unavailable'); return r.json(); })
          .then(function (data) {
            if (!connected(g)) return;
            var rows = freeRows(data);
            note(rows.length ? '' : t('empty', 'Nothing here yet.'));
            var items = el('div', 'rmp-grid'); items.style.display = 'grid'; items.style.gridTemplateColumns = 'repeat(auto-fill, minmax(100px, 1fr))'; items.style.gap = 'var(--ds-sp-2)'; results.appendChild(items);
            rows.forEach(function (r) {
              var title = r.title || t('gif', 'GIF');
              var b = mediaButton(title, function () {
                pickGif(r.id, '[gif:' + r.id + ']', { gif: { src: r.media.src, w: r.media.w, h: r.media.h, title: r.title, page: FREE_PAGE + r.id },
                                                      onPosted: function () { share(r.id, query); } });
              });
              b.title = title; b.setAttribute('aria-label', t('send_gif', 'Send GIF: {name}', { name: title })); picture(b, r.preview.src, title);
              caption(b, title); items.appendChild(b);
            });
            results.appendChild(el('p', 'ds-fine', t('credit', 'via KLIPY')));
          }).then(null, function () { if (connected(g)) note(t('unavailable', 'Could not load this right now. Try again.')); });
      }
      form.addEventListener('submit', function (e) { e.preventDefault(); load(); }); load();
    }
    function emoji() {
      var items = grid(); items.style.gridTemplateColumns = 'repeat(auto-fill, minmax(44px, 1fr))';
      EMOJI.forEach(function (value) {
        var b = button(value, function () {
          if (!box.isConnected || !o.relay.insert) return;
          if (!o.relay.insert(value)) note(t('full', 'The message is full. Remove some text to add an emoji.'));
          else { var input = o.relay.getInput(); if (input && W.matchMedia && W.matchMedia('(pointer: fine)').matches) b.focus(); }   // (the sheet stays open for more)
        }); b.style.fontSize = '24px'; b.style.minBlockSize = '44px'; b.style.padding = 'var(--ds-sp-1)';
        b.setAttribute('aria-label', t('insert', 'Insert {emoji}', { emoji: value })); items.appendChild(b);
      });
    }
    function select(tab, focus) {
      active = tab; generation++; body.textContent = ''; note('');
      tabs.forEach(function (x) { x.button.setAttribute('aria-selected', String(x === tab)); x.button.setAttribute('aria-pressed', String(x === tab)); x.button.tabIndex = x === tab ? 0 : -1; });
      body.setAttribute('aria-label', tab.label);
      if (tab.id === 'patv') patv(generation); else if (tab.id === 'stickers') stickers(generation); else if (tab.id === 'gifs') { if (free) gifsFree(); else gifs(); } else emoji();
      if (focus) tab.button.focus();
    }
    function add(id, icon, label) {
      var tab = { id: id, label: label }, b = button('', function () { select(tab, true); }, 'ds-tab');
      var ic = el('span', 'ds-ic', icon); ic.setAttribute('aria-hidden', 'true'); b.appendChild(ic); b.appendChild(doc.createTextNode(label));
      b.setAttribute('role', 'tab'); b.addEventListener('keydown', function (e) {
        var i = tabs.indexOf(tab), rtl = doc.documentElement.dir === 'rtl';
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) < 0) return;
        e.preventDefault();
        var next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + ((e.key === 'ArrowRight') !== rtl ? 1 : -1) + tabs.length) % tabs.length;
        select(tabs[next], true);
      }); tab.button = b; tabs.push(tab); tabBar.appendChild(b);
    }
    add('patv', '🧸', t('patv', 'PATV'));
    if (room.cfstickerPicker === true) add('stickers', '🏷️', t('camfrog', 'Camfrog'));
    if (room.gifPicker === true) add('gifs', '🎞️', t('gifs', 'GIFs'));
    add('emoji', '😀', t('emoji', 'Emoji'));
    // (no tab asked for: the first one that loads nothing on its own - the 🧸 PATV catalogue loads only when asked for)
    var want = tabs.filter(function (x) { return x.id === o.tab; })[0] || tabs.filter(function (x) { return x.id !== 'patv'; })[0];
    select(want || tabs[0], false);
    // focus goes back to the composer when the sheet closes (the Dock's layer returns it to the opener otherwise)
    return { box: box, tabs: tabs, current: function () { return active.id; } };
  }
  W.PATVPadPicker = { available: available, open: open, voices: voices, _freeRows: freeRows, _cdnOk: cdnOk };
})(window);
