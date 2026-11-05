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
    function send(token) {
      if (!box.isConnected) return;
      if (o.relay._send(token)) closeToInput();
      else note(t('queue', 'Your messages are still on their way. Try again in a moment.'));
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
    function picture(parent, src, label) {
      var image = el('img'); image.src = src; image.alt = label; image.loading = 'lazy'; image.decoding = 'async';
      image.style.inlineSize = '100%'; image.style.blockSize = '88px'; image.style.objectFit = 'contain'; image.style.borderRadius = 'var(--ds-r-sm)';
      image.addEventListener('error', function () { image.hidden = true; }); parent.appendChild(image);
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
          var desc = String(r.desc || t('sticker', 'Sticker')).slice(0, 240);
          var b = mediaButton(desc, function () { send('[cfsticker:' + r.set + '/' + r.id + ']'); });
          b.setAttribute('aria-label', t('send_sticker', 'Send sticker: {name}', { name: desc })); b.title = desc;
          picture(b, r.src, desc); caption(b, desc); items.appendChild(b);
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
            var b = mediaButton(title, function () { send('[gif:' + r.id + ']'); });
            b.title = title; b.setAttribute('aria-label', t('send_gif', 'Send GIF: {name}', { name: title })); picture(b, r.preview.src, title);
            caption(b, title); items.appendChild(b);
          });
          results.appendChild(el('p', 'ds-fine', t('credit', 'via KLIPY')));
          if (!items.children.length) note(t('empty', 'Nothing here yet.'));
        }, { q: query, pad: o.slug });
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
      if (tab.id === 'patv') patv(generation); else if (tab.id === 'stickers') stickers(generation); else if (tab.id === 'gifs') gifs(); else emoji();
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
  W.PATVPadPicker = { available: available, open: open, voices: voices };
})(window);
