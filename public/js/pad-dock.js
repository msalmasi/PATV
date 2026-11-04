// The bridged pad's Dock moves existing widgets; it never requests or resolves room data.
// 1.99?? dockclean: the owner's stripped-down Live view (hand-off 18 clean-up) - ONE stage card (the video + the pinned cams, an
// auto-hiding overlay: the pad chip at the top, source / Snap / Clip / fullscreen / ⋯ at the bottom), the chat card (one slim
// header row, the log, the bottom audio bar, the composer box with its tool row) and, 1024px and wider, the people column. Every
// other control lives in exactly one menu (the pad menu, the stage ⋯, the chat ⋯, audio settings, ＋, the tool row, the person
// menu, a pinned cam's ⋯). Nothing new is fetched here: each menu item proxies the original control (its handlers, prices,
// confirms and server checks stay theirs).
(function (W, D) {
  'use strict';
  var tr = typeof W.__t === 'function' ? W.__t : function (k, d, v) {
    return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function t(k, fallback, v) { return tr('js.pad.dock.' + k, fallback, v); }
  function el(tag, cls, text, doc) { var n = (doc || D).createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function each(nodes, fn) { Array.prototype.forEach.call(nodes || [], fn); }
  function txt(n) { return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function shown(n) { return !!(n && n.isConnected && !n.hidden && !(n.classList && n.classList.contains('hide')) && !(n.closest && n.closest('[hidden]'))); }
  function fmtN(n) { return Number(n).toLocaleString('en-US'); }
  // 1.99ajc dockfu (owner decision 6): the controls are EMOJI icons; each button keeps its words as its accessible name and tooltip.
  var IC = { hide: '🔽', full: '🖥️', pop: '🪟', back: '↩️', more: '⋯', down: '▾' };
  // 1.99?? dockclean (owner point 17): the Apps sheet - the room's games and tools, each only when Pepe offers it here (d.room.cmds).
  // A tile puts the command into the composer (a trailing space where it takes a name / amount: the name autocomplete opens) and
  // never sends by itself.
  var APPS = [['!spin', '🎡', 'spin', 'Spin', 0], ['!heist', '💰', 'heist', 'Heist', 1], ['!duel', '⚔️', 'duel', 'Duel', 1], ['!brawl', '🥊', 'brawl', 'Brawl', 1],
    ['!arena', '🏟️', 'arena', 'Arena', 1], ['!bj', '🃏', 'bj', 'Blackjack', 1], ['!holdem', '♠️', 'holdem', 'Hold’em', 1], ['!pictionary', '🎨', 'pictionary', 'Pictionary', 0],
    ['!trivia', '❓', 'trivia', 'Trivia', 0], ['!guess', '🔢', 'guess', 'Guess', 1], ['!bingo', '🎱', 'bingo', 'Bingo', 0], ['!lotto', '🎟️', 'lotto', 'Lotto', 1]];
  var HIDE_MS = 2500, VOICE_KEY = 'patv.dock.voice';
  function store(k, v) { try { if (v === undefined) return W.localStorage.getItem(k); W.localStorage.setItem(k, String(v)); } catch (e) { return null; } return null; }
  function priceText(p) { return p === 0 ? t('free', 'free') : typeof p === 'number' && p > 0 ? t('price', '{n} PAT', { n: fmtN(p) }) : ''; }
  function parseAmount(v) {
    if (W.PATVAmount && W.PATVAmount.parse) { var x = W.PATVAmount.parse(v); return x && x > 0 ? Math.floor(x) : null; }
    var m = /^\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*([kKmMbB]?)\s*$/.exec(String(v || ''));
    if (!m) return null;
    var n = Number(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[3].toLowerCase()] || 1);
    return n >= 1 && isFinite(n) ? Math.floor(n) : null;
  }
  function init(o) {
    o = o || {};
    var root = o.root || D.querySelector('main.rm.rm-dock');
    if (!root) return null;
    var nodes = o.nodes || {}, dead = false, ready = false, data = null, holders = [], listeners = [];
    var stage, chat, strip, compose, side, panel, template, holderBox, extras, toolRow, ovTop, ovBot, srcHost, srcBox, snapBtn, clipBtn, playBtn, nowBox;
    var current = null, layer = null, pip = null, pipPending = false, popGeneration = 0, localCam = null, stageHidden = false;
    var autoTimer = null, toastTimer = null, observers = [], selected = null, stageRevision = 0, videoPipSource = null, overBar = false;
    var toolBtns = {}, peopleInput = null, infoMark = null, pplBtn = null, chatMore = null, topicRow = null, slimText = null;
    function node(id) { return nodes[id] || (nodes[id] = D.getElementById(id)); }
    function on(n, type, fn, capture) { if (!n) return; n.addEventListener(type, fn, !!capture); if (n === W || n.nodeType === 9) listeners.push([n, type, fn, !!capture]); }
    function observe(n, fn, opts) { if (!n || !W.MutationObserver) return; var m = new W.MutationObserver(fn); m.observe(n, opts || { childList: true, subtree: true }); observers.push(m); }
    function button(icon, key, fallback, fn, cls, doc, vars) {
      var b = el('button', cls || 'ds-btn quiet sm', null, doc); b.type = 'button';
      if (icon) { var i = el('span', 'ds-ic', icon, doc); i.setAttribute('aria-hidden', 'true'); b.appendChild(i); }
      var label = t(key, fallback, vars);
      b.appendChild(el('span', 'rmd-label', label, doc));
      b.title = label; b.setAttribute('aria-label', label);
      if (fn) on(b, 'click', function (e) { fn(b, e); }); return b;
    }
    function iconBtn(icon, key, fallback, fn, cls, doc) { var b = button(icon, key, fallback, fn, (cls || 'ds-btn quiet sm') + ' rmd-icon', doc); return b; }
    function inPip() { return !!(pip && !pip.closed); }
    function activeRoot() { return inPip() ? pip.document.querySelector('main') : current && current.kind === 'full' ? current.host : root; }
    function identity(into) {
      if (!template || !template.content) return;
      into.appendChild(template.content.cloneNode(true));
      if (W.PATVChipFit && W.PATVChipFit.run) W.PATVChipFit.run();
    }
    function foreignModal(doc) {
      var found = false;
      each(doc.querySelectorAll('dialog[open], [aria-modal="true"]'), function (n) {
        if (!(layer && layer.host.contains(n)) && !n.hidden && (!n.closest || !n.closest('[hidden]'))) found = true;
      });
      return found;
    }
    function focusable(host) {
      return Array.prototype.filter.call(host.querySelectorAll('a[href],button,input,select,textarea,[tabindex="0"]'), function (n) {
        return !n.disabled && !n.hidden && (!n.closest || !n.closest('[hidden],.hide')) && n.getClientRects().length;
      });
    }
    function toast(message) {
      var host = activeRoot(); if (!host) return;
      var parent = host === root ? D.body : host;
      var stack = null; each(parent.children, function (n) { if (n.classList.contains('ds-toasts')) stack = n; });
      if (!stack) { stack = el('div', 'ds-toasts', null, parent.ownerDocument); stack.setAttribute('aria-live', 'polite'); parent.appendChild(stack); }
      var old = stack.querySelector('.rmd-toast'); if (old) old.remove();
      var n = el('div', 'ds-toast rmd-toast', message, parent.ownerDocument); stack.appendChild(n);
      clearTimeout(toastTimer); toastTimer = setTimeout(function () { n.remove(); }, 4200);
    }
    function changed() {
      ['rmVideo', 'rmPtt', 'rmFeed'].forEach(function (id) {
        var n = node(id); if (!n) return;
        n.dispatchEvent(new W.CustomEvent('patv:surfacechange', { bubbles: true }));
      });
      if (o.ptt && o.ptt.adopt && node('rmPtt')) o.ptt.adopt(node('rmPtt').ownerDocument);
      if (W.PATVAvSync && W.PATVAvSync.surfaceChanged) W.PATVAvSync.surfaceChanged(node('rmFeed'));
      if (o.wake) o.wake();
      if (W.PATVChipFit && W.PATVChipFit.run) W.PATVChipFit.run();
    }
    function closeLayer(focus) {
      if (!layer) return;
      var old = layer; layer = null;
      if (old.restore) old.restore();
      old.host.remove();
      if (old.opener && old.opener.getAttribute && old.opener.getAttribute('aria-haspopup')) old.opener.setAttribute('aria-expanded', 'false');
      if (focus !== false && old.opener && old.opener.isConnected) old.opener.focus();
      if (old.overlay) showTools();
    }
    function sheet(title, opener, menuLike) {
      closeLayer(false);
      var place = activeRoot(), doc = place.ownerDocument;
      var host = el('div', 'rmd-layer ds-scrim sheet', null, doc);
      var box = el('section', menuLike ? 'ds-modal rmd-menu' : 'ds-modal', null, doc);
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
      var head = el('div', 'ds-modal-h', null, doc); head.appendChild(el('h2', null, title, doc));
      head.appendChild(button('✕', 'close', 'Close', function () { closeLayer(); }, 'ds-btn ghost sm', doc));
      box.appendChild(head); host.appendChild(box); place.appendChild(host);
      layer = { host: host, box: box, head: head, opener: opener || doc.activeElement };
      on(host, 'click', function (e) { if (e.target === host && !foreignModal(doc)) closeLayer(); });
      setTimeout(function () { if (layer && layer.host === host) { var a = focusable(box); if (a[0]) a[0].focus(); } }, 0);
      return box;
    }
    /** a Dock sheet holding an existing node (moved in, put back where it was on close) */
    function nodeSheet(title, n, opener, kind, after) {
      if (!n || !n.parentNode) return null;
      var box = sheet(title, opener), mark = n.ownerDocument.createComment('dock ' + (kind || 'sheet'));
      layer.kind = kind || 'node';
      n.parentNode.insertBefore(mark, n); box.appendChild(n); n.classList.add('rmd-in-sheet');
      var old = layer.restore;
      layer.restore = function () { if (old) old(); if (typeof after === 'function') after(); n.classList.remove('rmd-in-sheet'); if (mark.parentNode) { mark.parentNode.insertBefore(n, mark); mark.remove(); } };
      return box;
    }
    // ── menus: one .ds-pop at a time (a bottom sheet on phones, pad-dock.css); arrows / Home / End / Escape (keydown below) ──
    function menu(opener, label) {
      closeLayer(false);
      var place = activeRoot(), doc = place.ownerDocument, box = el('div', 'rmd-menu ds-pop', null, doc);
      box.setAttribute('role', 'menu'); box.setAttribute('aria-label', label || t('extras', 'Add to the chat'));
      place.appendChild(box); layer = { host: box, box: box, opener: opener, kind: 'menu' };
      if (opener && opener.closest && opener.closest('.rmd-ov')) layer.overlay = true;
      return box;
    }
    function placeMenu(box, opener) {
      var win = box.ownerDocument.defaultView || W, vw = win.innerWidth || 1024, vh = win.innerHeight || 768;
      if (vw <= 760 || !opener || !opener.getBoundingClientRect) { box.classList.add('rmd-pop-sheet'); return; }
      var r = opener.getBoundingClientRect(), w = box.offsetWidth || 260, h = box.offsetHeight || 240;
      var x = Math.max(8, Math.min(r.right - w, vw - w - 8)), y = r.bottom + 6;
      if (y + h > vh - 8) y = r.top - h - 6 > 8 ? r.top - h - 6 : Math.max(8, vh - h - 8);
      box.style.position = 'fixed'; box.style.left = x + 'px'; box.style.top = y + 'px';
    }
    function finishMenu(box, opener) {
      placeMenu(box, opener);
      if (opener && opener.setAttribute && opener.getAttribute('aria-haspopup')) opener.setAttribute('aria-expanded', 'true');
      var first = focusable(box)[0]; if (first) first.focus();
    }
    function menuItem(box, icon, key, label, fn, opts) {
      opts = opts || {};
      var opener = layer && layer.opener, doc = box.ownerDocument, b;
      if (opts.href) {
        b = el('a', 'ds-menu-item', null, doc); b.setAttribute('href', opts.href);
        var ic0 = el('span', 'ds-ic', icon, doc); ic0.setAttribute('aria-hidden', 'true'); b.appendChild(ic0); b.appendChild(el('span', 'rmd-label', t(key, label, opts.vars), doc));
        if (fn) on(b, 'click', function (e) { fn(opener || b, e); });
      } else {
        b = button(icon, key, label, function (bb, e) { if (!opts.keep) closeLayer(false); if (fn) fn(opener || b, e); }, 'ds-menu-item', doc, opts.vars);
      }
      b.setAttribute('role', opts.role || 'menuitem');
      if (opts.role === 'menuitemcheckbox' || opts.role === 'menuitemradio') b.setAttribute('aria-checked', String(!!opts.checked));
      if (opts.sub) b.appendChild(el('small', 'rmd-sub', opts.sub, doc));
      if (opts.tip) b.title = opts.tip;
      if (opts.disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); }
      box.appendChild(b); return b;
    }
    function menuGroup(box, key, label) { var g = el('div', 'rmd-menu-g ds-eyebrow', t(key, label), box.ownerDocument); g.setAttribute('role', 'presentation'); box.appendChild(g); return g; }
    function clickOf(n) { return function () { if (n && n.isConnected) external(function () { n.click(); }); }; }
    function external(fn) {
      if (inPip()) { W.focus(); toast(t('in_pad', 'Use this control in the pad tab.')); return; }
      closeLayer(false);
      if (D.fullscreenElement && D.exitFullscreen) {
        Promise.resolve(D.exitFullscreen()).then(function () { redock(); fn(); }).catch(function () { toast(t('exit_first', 'Leave fullscreen to use this control.')); });
      } else fn();
    }
    // Existing menus/prompts belong to the opener. Route the original gesture there before they open.
    var externalSelector = '.la-btn,.pm-mg,.pm-btn,.ic button.cam,.mc-btn,.cc-btn,.pc-btn,.sc-btn,.stx,.mf-rv,.mf-off,[data-rv],[data-rvm],.rv,.rvm,[data-reveal],.veil-reveal,.reveal-btn,#rmMoreBtn,#rmSearchBtn,#rmHistJump,#rmCap button,#rmClip button,.sbd-rep,[data-pad-gift],[data-share-path]';
    function routeExternal(e) {
      var b = e.target.closest && e.target.closest(externalSelector); if (!b || b.__rmdReplay) return;
      // Roster popovers belong to the pad body. Restore their anchors before the original click opens one.
      if (layer && layer.kind === 'participants' && layer.host.contains(b) && b.matches('.pm-mg,.ic button.cam')) closeLayer(false);
      if (pip && e.currentTarget === pip.document) {
        e.preventDefault(); e.stopImmediatePropagation(); W.focus(); toast(t('in_pad', 'Use this control in the pad tab.')); return;
      }
      if (!D.fullscreenElement) return;
      e.preventDefault(); e.stopImmediatePropagation();
      external(function () { b.__rmdReplay = true; b.click(); b.__rmdReplay = false; });
    }
    function keydown(e) {
      var doc = e.currentTarget;
      if (foreignModal(doc)) return;
      if (layer && layer.host.ownerDocument === doc) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLayer(); return; }
        if (e.key === 'Tab') {
          var a = focusable(layer.box); if (!a.length) { e.preventDefault(); return; }
          var idx = a.indexOf(doc.activeElement);
          if (e.shiftKey && idx <= 0) { e.preventDefault(); a[a.length - 1].focus(); }
          else if (!e.shiftKey && (idx === a.length - 1 || idx < 0)) { e.preventDefault(); a[0].focus(); }
        }
        if (layer.host.classList.contains('ds-pop') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(e.key) >= 0) {
          var items = focusable(layer.box), at = items.indexOf(doc.activeElement); e.preventDefault();
          if (items.length) items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length].focus();
        }
      } else if (e.key === 'Escape' && current && current.kind === 'float') { e.preventDefault(); redock(); }
    }
    function trap(e) {
      if (!layer || layer.host.ownerDocument !== e.currentTarget || foreignModal(e.currentTarget) || layer.host.contains(e.target)) return;
      if (layer.host.classList.contains('ds-pop')) return;            // a menu loses focus quietly (the outside click closes it)
      var a = focusable(layer.box); if (a[0]) a[0].focus();
    }
    function attachDoc(doc) {
      on(doc, 'keydown', keydown); on(doc, 'focusin', trap); on(doc, 'click', routeExternal, true);
      on(doc, 'click', function (e) { if (layer && layer.host.classList.contains('ds-pop') && e.target.isConnected !== false && !layer.host.contains(e.target) && e.target !== layer.opener && !(layer.opener && layer.opener.contains(e.target))) closeLayer(false); });
    }
    function movable(n, destination, label) {
      var mark = el('div', 'rmd-placeholder', null, n.ownerDocument);
      mark.appendChild(el('span', null, label));
      mark.appendChild(button(IC.back, 'redock', 'Bring it back', redock));
      n.parentNode.insertBefore(mark, n); destination.appendChild(n);
      return { node: n, mark: mark };
    }
    function restore(record) { if (record && record.mark.parentNode) { if (record.node.parentNode) record.mark.parentNode.insertBefore(record.node, record.mark); record.mark.remove(); } }
    function redock() {
      popGeneration++;
      if (videoPipSource) {
        videoPipSource = null;
        if (D.pictureInPictureElement && D.exitPictureInPicture) Promise.resolve(D.exitPictureInPicture()).catch(function () {});
      }
      closeLayer(false);
      if (!current) return;
      var old = current; current = null;
      if (old.cleanup) old.cleanup();
      if (old.kind === 'full' && D.fullscreenElement && D.exitFullscreen) { try { Promise.resolve(D.exitFullscreen()).catch(function () {}); } catch (e) {} }
      (old.moves || []).slice().reverse().forEach(restore);
      if (old.host) old.host.remove();
      if (pip) {
        var win = pip; pip = null;
        listeners = listeners.filter(function (x) { if (x[0] !== win.document) return true; x[0].removeEventListener(x[1], x[2], x[3]); return false; });
        if (!win.closed) win.close();
      }
      changed();
      if (old.focus && old.focus.isConnected) old.focus.focus();
    }
    function viewbar(host, close) {
      var v = el('div', 'rmd-viewbar', null, host.ownerDocument); identity(v);
      v.appendChild(button(IC.back, 'redock', 'Bring it back', close || redock, 'ds-btn quiet sm', host.ownerDocument)); host.appendChild(v); return v;
    }
    function drag(host, handle) {
      var start = null;
      function clamp() {
        var r = host.getBoundingClientRect(), maxX = Math.max(0, W.innerWidth - r.width), maxY = Math.max(58, W.innerHeight - r.height);
        var x = Math.max(0, Math.min(maxX, r.left)), y = Math.max(58, Math.min(maxY, r.top));
        host.style.insetInlineStart = (D.documentElement.dir === 'rtl' ? W.innerWidth - x - r.width : x) + 'px';
        host.style.insetBlockStart = y + 'px'; host.style.insetInlineEnd = 'auto'; host.style.insetBlockEnd = 'auto';
      }
      on(handle, 'pointerdown', function (e) {
        if (e.button !== 0 || e.target.closest('button,a,input')) return;
        var r = host.getBoundingClientRect(); start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width };
        if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId); e.preventDefault();
      });
      on(handle, 'pointermove', function (e) {
        if (!start) return;
        var x = Math.max(0, Math.min(W.innerWidth - start.width, start.left + e.clientX - start.x));
        host.style.insetInlineStart = (D.documentElement.dir === 'rtl' ? W.innerWidth - x - start.width : x) + 'px';
        host.style.insetBlockStart = Math.max(58, Math.min(W.innerHeight - host.offsetHeight, start.top + e.clientY - start.y)) + 'px';
        host.style.insetInlineEnd = 'auto'; host.style.insetBlockEnd = 'auto';
      });
      on(handle, 'pointerup', function () { start = null; clamp(); }); on(W, 'resize', clamp);
      // 1.99aiw review: the panel's window listener goes with the panel (redock), not one more per float
      return function () { W.removeEventListener('resize', clamp, false); listeners = listeners.filter(function (x) { return x[2] !== clamp; }); };
    }
    function floatChat() {
      if (!chat) return; redock();
      var host = el('section', 'rmd-float'); root.appendChild(host);
      var head = viewbar(host); current = { kind: 'float', host: host, moves: [], focus: D.activeElement };
      current.moves.push(movable(chat, host, t('chat_away', 'Chat is in a floating window.'))); current.cleanup = drag(host, head); changed();
    }
    function full(n) {
      redock(); if (!n) return;
      var host = el('section', 'rmd-fullscreen'); root.appendChild(host);
      var head = viewbar(host), media = el('div', 'rmd-full-media' + (n.classList.contains('cs-tile') ? ' cam-strip' : ''));
      var overlay = el('div', 'rmd-overlay'); overlay.hidden = true;
      host.appendChild(media); host.appendChild(overlay);
      current = { kind: 'full', host: host, moves: [], focus: D.activeElement };
      current.moves.push(movable(n, media, t('media_away', 'The player is in another view.')));
      var toggle = button('💬', 'show_chat', 'Show chat', function () {
        if (overlay.hidden) {
          overlay.hidden = false;
          current.chatMove = movable(chat, overlay, t('chat_overlay', 'Chat is over the player.'));
          current.moves.push(current.chatMove); toggle.setAttribute('aria-pressed', 'true');
        } else {
          restore(current.chatMove); current.moves.splice(current.moves.indexOf(current.chatMove), 1); current.chatMove = null;
          overlay.hidden = true; toggle.setAttribute('aria-pressed', 'false');
        }
        toggle.querySelector('.rmd-label').textContent = overlay.hidden ? t('show_chat', 'Show chat') : t('hide_chat', 'Hide chat'); changed();
      });
      toggle.setAttribute('aria-pressed', 'false'); head.appendChild(toggle); changed();
      if (!host.requestFullscreen) { redock(); toast(t('fullscreen_unavailable', 'Fullscreen is unavailable in this browser.')); return; }
      try { Promise.resolve(host.requestFullscreen()).catch(function () { redock(); toast(t('fullscreen_unavailable', 'Fullscreen is unavailable in this browser.')); }); }
      catch (e) { redock(); toast(t('fullscreen_unavailable', 'Fullscreen is unavailable in this browser.')); }
    }
    function stageMedia() { return localCam ? localCam.host : stage; }
    function pop(n, isChat) {
      if (!n || pipPending) return;
      redock();
      if (!W.documentPictureInPicture || !W.documentPictureInPicture.requestWindow) {
        if (isChat) { floatChat(); return; }
        var sel = o.stage && o.stage.selection ? o.stage.selection() : null;
        var video = stage && stage.querySelector('video');
        if (!localCam && sel && !sel.embed && sel.stream !== 'mic' && !(o.stage && o.stage.view && o.stage.view() === 'mic') && video && video.requestPictureInPicture) {
          var nativeGeneration = ++popGeneration, nativeRevision = stageRevision, nativeSource = JSON.stringify(sel);
          pipPending = true;
          try { Promise.resolve(video.requestPictureInPicture()).then(function () {
            pipPending = false;
            var now = o.stage && o.stage.selection ? o.stage.selection() : selected;
            if (dead || nativeGeneration !== popGeneration || nativeRevision !== stageRevision || nativeSource !== JSON.stringify(now) || localCam || panel && panel.hidden) {
              if (D.pictureInPictureElement === video && D.exitPictureInPicture) Promise.resolve(D.exitPictureInPicture()).catch(function () {});
              return;
            }
            videoPipSource = nativeSource;
          }).catch(function () { pipPending = false; if (nativeGeneration === popGeneration) toast(t('pop_unavailable', 'Pop-out is unavailable for this player.')); }); }
          catch (e) { pipPending = false; toast(t('pop_unavailable', 'Pop-out is unavailable for this player.')); }
        } else toast(t('pop_unavailable', 'Pop-out is unavailable for this player.'));
        return;
      }
      pipPending = true;
      var requestGeneration = ++popGeneration;
      W.documentPictureInPicture.requestWindow({ width: isChat ? 520 : 760, height: isChat ? 680 : 520 }).then(function (win) {
        pipPending = false;
        if (dead || requestGeneration !== popGeneration || panel && panel.hidden) { win.close(); return; }
        redock(); pip = win;
        var doc = win.document; doc.title = D.title; doc.documentElement.lang = D.documentElement.lang; doc.documentElement.dir = D.documentElement.dir;
        each(D.querySelectorAll('link[rel="stylesheet"],style'), function (s) {
          var clone = s.cloneNode(true); if (s.tagName === 'LINK') clone.href = s.href; doc.head.appendChild(clone);
        });
        doc.body.className = D.body.className; doc.body.classList.add('pad-dock-live');
        var main = el('main', root.className, null, doc); main.setAttribute('style', root.getAttribute('style') || ''); main.setAttribute('data-rmd-pip', '');
        doc.body.appendChild(main); viewbar(main); attachDoc(doc);
        main.appendChild(el('p', 'rmd-surface-hint', t('pip_hint', 'More actions are available in the pad tab.'), doc));
        current = { kind: 'pip', host: main, moves: [], focus: D.activeElement };
        current.moves.push(movable(n, main, isChat ? t('chat_pop', 'Chat is in a popped-out window.') : t('stage_pop', 'The player is in a popped-out window.')));
        on(win, 'pagehide', redock); on(doc, 'visibilitychange', changed); changed();
      }).catch(function () { pipPending = false; toast(t('pop_unavailable', 'Pop-out is unavailable for this player.')); });
    }
    function hideStage(onOff) {
      if (!stage) return; if (current) redock();
      stageHidden = !!onOff;
      root.classList.toggle('rmd-stage-hidden', stageHidden);
      var mini = node('rmdMini'); if (mini) mini.hidden = !stageHidden;
      changed();
    }
    function returnCam() {
      if (!localCam) return; if (current) redock();
      var old = localCam; localCam = null; restore(old.move); old.host.remove(); root.classList.remove('rmd-local-cam'); changed();
    }
    // A pinned cam on the viewer's own stage: inside the stage card, in the main area (the other pins stay in the strip).
    function watchCam(tile) {
      redock(); returnCam(); hideStage(false);
      var host = el('section', 'rmd-local-player cam-strip'), player = stage.querySelector('.player');
      stage.insertBefore(host, player || null);
      var head = viewbar(host, returnCam);
      head.appendChild(iconBtn(IC.full, 'fullscreen', 'Fullscreen', function () { full(host); }));
      head.appendChild(iconBtn(IC.hide, 'hide_stage', 'Hide stage', function () { hideStage(true); }));
      head.appendChild(iconBtn(IC.pop, 'pop_stage', 'Pop out player', function () { pop(host, false); }));
      localCam = { host: host, move: movable(tile, host, t('cam_stage', 'This cam is on your stage.')) };
      // This placeholder returns the local swap rather than redocking an unrelated surface.
      var rb = localCam.move.mark.querySelector('button'); rb.replaceWith(button(IC.back, 'return_cam', 'Return cam to strip', returnCam));
      var close = tile.querySelector('.cs-x'); if (close) on(close, 'click', function () { setTimeout(function () { if (localCam && localCam.move.node === tile && !tile.parentNode) returnCam(); }, 0); });
      root.classList.add('rmd-local-cam'); changed();
    }
    // 1.99?? dockclean (owner point 28): a pinned cam is the clean video + its name; ONE ⋯ per tile (Watch on my stage, Fullscreen,
    // Cam options, Close). A click on the video watches it on the viewer's own stage. The tile's own ⤢ / ✕ and ⚡ LIVE badge are hidden
    // (pad-dock.css); ✕ Close and the failure overlay's ↻ Retry / ▶ Tap to play are the strip's own buttons.
    function tileMenu(tile, opener) {
      var box = menu(opener, t('cam_menu', 'Cam options'));
      menuItem(box, '📺', 'watch_cam', 'Watch on my stage', function () { watchCam(tile); });
      menuItem(box, IC.full, 'fullscreen', 'Fullscreen', function () { full(tile); });
      var who = tile._who;
      if (who && o.openCam) menuItem(box, '📷', 'cam_options', 'Cam options…', function () { external(function () { o.openCam(who); }); });
      var x = tile.querySelector('.cs-x');
      if (x) menuItem(box, '✕', 'close_cam', 'Close (frees the slot)', function () { external(function () { x.click(); }); });
      finishMenu(box, opener);
    }
    function decorateCams() {
      if (!strip) return;
      each(strip.querySelectorAll('.cs-tile'), function (tile) {
        if (tile.querySelector('.rmd-tile-more')) return;
        var more = iconBtn(IC.more, 'cam_menu', 'Cam options', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } tileMenu(tile, b); }, 'ds-btn quiet sm rmd-tile-more');
        more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
        var vid = tile.querySelector('.cs-vid') || tile; vid.appendChild(more);
        var v = tile.querySelector('video');
        if (v) on(v, 'click', function () { if (!localCam || localCam.move.node !== tile) watchCam(tile); });
      });
      root.classList.toggle('rmd-has-pins', !!strip.querySelector('.cs-tile'));
    }
    function visible() { return !D.hidden || !!(pip && !pip.closed && !pip.document.hidden); }
    function personLine(n, u) {
      if (!n || !u || u.veil || u.anon || u.self || !u.login || !o.openPerson || !n.querySelector || !(o.signed || o.mod && o.mod.active && o.mod.active())) return;
      var who = n.querySelector('.who'); if (!who || who.__rmdPerson) return;
      who.__rmdPerson = true;
      function open(e) {
        if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button > 0)) return;
        if (e) e.preventDefault(); external(function () { o.openPerson(u, who, false); });
      }
      if (who.tagName !== 'A') { who.tabIndex = 0; who.setAttribute('role', 'button'); }
      on(who, 'click', open); on(who, 'keydown', function (e) { if (e.key === 'Enter' || (e.key === ' ' && who.tagName !== 'A')) open(e); });
    }
    var holderKey = null;
    function narrow() { return !!(W.matchMedia && W.matchMedia('(max-width: 1023px)').matches); }
    function mic(list) {
      holders = Array.isArray(list) ? list : []; if (!holderBox || !o.person) return;
      var max = narrow() ? 1 : 2;
      // 1.99aiw review: redraw only when the holders change - a rebuild restarted animated name styles and dropped keyboard focus
      var key = null;
      try { key = JSON.stringify(holders) + '|' + max + '|' + (o.signed ? 1 : 0) + (o.mod && o.mod.active && o.mod.active() ? 1 : 0); } catch (e) { key = null; }
      if (key !== null && key === holderKey) return;
      holderKey = key;
      holderBox.textContent = '';
      holders.slice(0, max).forEach(function (u) {
        var chip = el('span', 'rmd-holder'); var content = o.person(u); if (content) chip.appendChild(content);
        holderBox.appendChild(chip); personLine(chip, u);
      });
      if (holders.length > max) {
        var more = button('', 'more_holders', 'More people on the mic', participants, 'ds-btn quiet sm rmd-holder-more');
        more.querySelector('.rmd-label').textContent = '+' + (holders.length - max); more.title = t('plus_on_mic', '+{n} on mic', { n: holders.length - max }); holderBox.appendChild(more);
      }
      holderBox.hidden = !holders.length;
      if (nowBox) nowBox.classList.toggle('rmd-has-holders', !!holders.length);
      paintNow();
    }
    function cmds() { return data && data.room && data.room.cmds || {}; }
    function hasCmd(k) { return !!o.linked && Object.prototype.hasOwnProperty.call(cmds(), k); }

    // ── 🗣️ Say it (owner point 13: a voice selector; the voices are the site's own GET /api/voices, loaded by pad-picker.js) ──
    function tts(opener) {
      if (!hasCmd('!say') || !o.relay || !o.relay.sendCmd) return;
      var box = sheet(t('tts', 'Pepe says it'), opener), doc = box.ownerDocument;
      layer.kind = 'tts'; layer.price = cmds()['!say'];
      var form = el('form', 'rmd-tts', null, doc), lab = el('label', 'ds-label', t('tts_words', 'What should Pepe say?'), doc);
      var inp = el('input', 'ds-in', null, doc); inp.type = 'text'; inp.maxLength = 295; inp.required = true;
      lab.appendChild(inp); form.appendChild(lab);
      var vLab = el('label', 'ds-label rmd-voice', t('voice', 'Voice'), doc), vRow = el('span', 'rmd-voice-row', null, doc);
      var sel = el('select', 'ds-select', null, doc); sel.setAttribute('aria-label', t('voice', 'Voice'));
      var def = el('option', null, t('voice_default', '🐸 Pepe (default)'), doc); def.value = ''; sel.appendChild(def);
      var sample = el('audio', null, null, doc); sample.preload = 'none';
      var play = iconBtn('▶', 'voice_sample', 'Play a sample', function () {
        var v = voices[sel.value]; if (!v || !v.sample) return;
        try { sample.src = v.sample; var p = sample.play(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* no audio */ }
      }, 'ds-btn quiet sm', doc);
      play.hidden = true;
      vRow.appendChild(sel); vRow.appendChild(play); vLab.appendChild(vRow); form.appendChild(vLab); form.appendChild(sample);
      var priceLine = el('p', 'rmd-price', null, doc); form.appendChild(priceLine);
      var voices = {};
      function paintPrice() {
        var p = cmds()['!say'], v = voices[sel.value], base = priceText(p);
        var line = t('say_price', '!say {price}', { price: base || '' });
        if (v && v.price_use > 0 && !v.owned && !v.free) line += ' + ' + t('voice_price', 'voice {n} PAT', { n: fmtN(v.price_use) });
        if (p > 0 || (v && v.price_use > 0)) line += ' · ' + t('admins_free', 'admins free');
        priceLine.textContent = line;
        var hasSample = !!(v && v.sample); play.hidden = !hasSample;
      }
      on(sel, 'change', function () { store(VOICE_KEY, sel.value); paintPrice(); });
      paintPrice();
      if (W.PATVPadPicker && W.PATVPadPicker.voices) {
        W.PATVPadPicker.voices().then(function (list) {
          if (!box.isConnected) return;
          (list || []).forEach(function (v) {
            if (!v || !v.id || v.status !== 'active' || v.listed === false || v.in_voicebox === false || (v.kind === 'clone' && v.allow_free_text === false)) return;
            var op = el('option', null, String(v.display || v.id) + ' · ' + (v.free || !(v.price_use > 0) ? t('voice_free', 'free') : v.owned ? t('voice_owned', 'owned') : t('voice_per_use', '+{n} PAT per use', { n: fmtN(v.price_use) })), doc);
            op.value = String(v.id); sel.appendChild(op); voices[op.value] = v;
          });
          var last = store(VOICE_KEY); if (last && voices[last]) sel.value = last;
          paintPrice();
        }, function () { /* the default voice only */ });
      }
      var actions = el('div', 'ds-modal-f', null, doc);
      actions.appendChild(button('', 'cancel', 'Cancel', function () { closeLayer(); }, 'ds-btn quiet', doc));
      var send = button('📣', 'send_tts', 'Send to Pepe', null, 'ds-btn gold', doc); send.type = 'submit'; actions.appendChild(send); form.appendChild(actions); box.appendChild(form);
      on(form, 'submit', function (e) {
        e.preventDefault(); var text = inp.value.trim(); if (!text || !hasCmd('!say')) return;
        var id = sel.value, flag = id ? ' -v ' + (/\s/.test(id) ? '"' + id.replace(/"/g, '') + '"' : id) : '';
        o.relay.sendCmd('!say ' + text.slice(0, 295) + flag); closeLayer();
      }); inp.focus();
    }
    // ── ⚡ Apps (owner points 12, 17): games and room tools as tiles; a tile fills the composer, never sends ──
    function insertCmd(c, space) {
      if (!o.relay) return;
      o.relay.insert(c + (space ? ' ' : ''), { replace: true }); var input = o.relay.getInput(); if (input) { input.focus(); input.dispatchEvent(new W.CustomEvent('input', { bubbles: true })); }
    }
    function dj() { var n = node('rdj'); return n && !n.classList.contains('hide') ? n : null; }
    function appList() { return APPS.filter(function (a) { return hasCmd(a[0]); }); }
    function apps(opener) {
      var box = sheet(t('apps', 'Chat apps'), opener), doc = box.ownerDocument;
      layer.kind = 'apps';
      var list = appList();
      if (list.length) {
        box.appendChild(el('p', 'ds-eyebrow rmd-apps-h', t('apps_games', 'Games'), doc));
        var grid = el('div', 'rmd-apps', null, doc);
        list.forEach(function (a) {
          var b = el('button', 'ds-btn quiet rmd-app', null, doc); b.type = 'button';
          var ic = el('span', 'ds-ic', a[1], doc); ic.setAttribute('aria-hidden', 'true'); b.appendChild(ic);
          b.appendChild(el('span', 'rmd-app-n', t('app_' + a[2], a[3]), doc));
          var p = priceText(cmds()[a[0]]); b.appendChild(el('small', 'rmd-app-p', a[0] + (p ? ' · ' + p : ''), doc));
          b.setAttribute('aria-label', t('app_' + a[2], a[3]) + ' (' + a[0] + ')' + (p ? ', ' + p : ''));
          on(b, 'click', function () { closeLayer(false); insertCmd(a[0], !!a[4]); }); grid.appendChild(b);
        });
        box.appendChild(grid);
      }
      var booth = dj();
      if (booth && !inPip()) {
        box.appendChild(el('p', 'ds-eyebrow rmd-apps-h', t('apps_room', 'Room'), doc));
        var g2 = el('div', 'rmd-apps', null, doc), b2 = el('button', 'ds-btn quiet rmd-app', null, doc); b2.type = 'button';
        var ic2 = el('span', 'ds-ic', '🎧', doc); ic2.setAttribute('aria-hidden', 'true'); b2.appendChild(ic2); b2.appendChild(el('span', 'rmd-app-n', t('app_dj', 'DJ booth'), doc));
        on(b2, 'click', function () { nodeSheet(t('app_dj', 'DJ booth'), booth, opener, 'dj'); }); g2.appendChild(b2); box.appendChild(g2);
      }
      box.appendChild(el('p', 'ds-fine rmd-apps-f', t('apps_more', 'Type ! in the chat for every command'), doc));
    }
    function soundboard(opener) {
      var sb = node('rmSb'); if (!sb) return;
      var box = sheet(t('soundboard', 'Soundboard'), opener), mark = D.createComment('soundboard dock'); sb.parentNode.insertBefore(mark, sb); box.appendChild(sb);
      layer.restore = function () { if (mark.parentNode) { mark.parentNode.insertBefore(sb, mark); mark.remove(); } };
      var toggle = sb.querySelector('.sbd-toggle'); if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    }
    // ── 💸 Tip (owner point 16): mic holders first, then the room, then web users - the eligible ones the server marked (u.tip) ──
    function tipPeople() {
      var seen = {}, out = [];
      [data && data.mic, data && data.members, data && data.web].forEach(function (list) {
        (list || []).forEach(function (u) {
          if (!u || u.veil || u.anon || u.bot || u.self || u.me || !u.tip || !u.tip.to || !u.tip.href || u.tip.to === o.user) return;
          var k = String(u.tip.to).toLowerCase(); if (seen[k]) return; seen[k] = 1; out.push(u);
        });
      });
      return out;
    }
    function tip(opener) {
      if (!o.signed || !W.PATVRoom || !W.PATVRoom.tipModal) return;
      var box = sheet(t('tip_who', 'Who would you like to tip?'), opener), doc = box.ownerDocument;
      layer.kind = 'tip';
      var people = tipPeople(), list = el('div', 'rmd-tip-list', null, doc);
      if (people.length > 4) {
        var find = el('input', 'ds-in rmd-find', null, doc); find.type = 'search'; find.placeholder = t('find', '🔍 Find someone…'); find.setAttribute('aria-label', t('find_aria', 'Find someone'));
        on(find, 'input', function () { var q = find.value.trim().toLowerCase(); each(list.children, function (b) { b.hidden = !!q && String(b._name || '').toLowerCase().indexOf(q) < 0; }); });
        box.appendChild(find);
      }
      people.forEach(function (u) {
        var b = el('button', 'ds-btn quiet', null, doc), content = o.person && o.person(u); b.type = 'button'; if (content) b.appendChild(content);
        b._name = txt(content) || u.display || u.tip.to;
        on(b, 'click', function () {
          var now = tipPeople().filter(function (p) { return p.tip.to === u.tip.to; })[0];
          if (!now) { closeLayer(); return; }
          external(function () { W.PATVRoom.tipModal({ to: now.tip.to, display: now.display, slug: o.slug, me: o.user }); });
        }); list.appendChild(b);
      });
      box.appendChild(list);
      if (!people.length) box.appendChild(el('p', null, t('tip_none', 'No eligible recipients are in the room.'), doc));
    }
    // ── 🧸 / 😀 / 🎞️: the picker sheet (pad-picker.js) on its tab ──
    function picker(tab, opener) {
      if (!W.PATVPadPicker || !W.PATVPadPicker.open) return;
      var input = o.relay && o.relay.getInput && o.relay.getInput();
      W.PATVPadPicker.open({ data: data, slug: o.slug, relay: o.relay, signed: o.signed, linked: o.linked, root: activeRoot(), opener: input && input.isConnected ? input : opener, closeLayer: closeLayer, sheet: sheet, tab: tab });
    }
    // ── ⚔️ Duel / 🥊 Brawl from the person menu (owner point 15): a stake, then '!duel <login> <amount>' through the relay ──
    function pvp(u, kind, opener) {
      if (!u || !u.login || u.veil || u.anon || u.self || u.bot || !o.relay || !o.relay.sendCmd || !hasCmd('!' + kind)) return;
      var name = u.display || u.login;
      var box = sheet(kind === 'brawl' ? t('brawl_who', 'Brawl {name}', { name: name }) : t('duel_who', 'Duel {name}', { name: name }), opener), doc = box.ownerDocument;
      layer.kind = 'pvp';
      var form = el('form', 'rmd-pvp', null, doc), presets = el('div', 'rmd-presets', null, doc), amt = el('input', 'ds-in', null, doc);
      presets.setAttribute('role', 'group'); presets.setAttribute('aria-label', t('stake', 'Stake'));
      amt.type = 'text'; amt.inputMode = 'numeric'; amt.value = '5,000'; amt.setAttribute('aria-label', t('stake_custom', 'Stake in PAT'));
      [1000, 5000, 25000].forEach(function (n) {
        var b = el('button', 'ds-btn quiet sm', fmtN(n), doc); b.type = 'button'; on(b, 'click', function () { amt.value = fmtN(n); amt.focus(); }); presets.appendChild(b);
      });
      var lab = el('label', 'ds-label', t('stake_custom', 'Stake in PAT'), doc); lab.appendChild(amt);
      var note = el('p', 'ds-fine', t('stake_note', 'Your stake is held until they accept; refunded if they decline or it expires.'), doc);
      var err = el('p', 'rmd-err', null, doc); err.setAttribute('role', 'status');
      form.appendChild(presets); form.appendChild(lab); form.appendChild(note); form.appendChild(err);
      var actions = el('div', 'ds-modal-f', null, doc);
      actions.appendChild(button('', 'cancel', 'Cancel', function () { closeLayer(); }, 'ds-btn quiet', doc));
      var send = button(kind === 'brawl' ? '🥊' : '⚔️', 'send_challenge', 'Send challenge', null, 'ds-btn primary', doc); send.type = 'submit'; actions.appendChild(send);
      form.appendChild(actions); box.appendChild(form);
      on(form, 'submit', function (e) {
        e.preventDefault(); var n = parseAmount(amt.value);
        if (!n) { err.textContent = t('stake_bad', 'Type an amount of PAT, like 5,000 or 5k.'); return; }
        if (!hasCmd('!' + kind)) { closeLayer(); return; }
        o.relay.sendCmd('!' + kind + ' ' + u.login + ' ' + n); closeLayer();
      });
    }
    function pvpFor(u) {
      if (!o.signed || !o.linked || !u || !u.login || u.veil || u.anon || u.self || u.bot || u.web || u.acct || /^u:/i.test(u.login)) return null;
      var low = String(u.login).toLowerCase(), member = (data && data.members || []).some(function (m) { return m && !m.veil && !m.anon && String(m.login || '').toLowerCase() === low; });
      if (!member) return null;
      var me = data && data.me && data.me.login ? String(data.me.login).toLowerCase() : null;
      if (me && me === low) return null;
      if (o.user && u.patv && u.patv.username && String(u.patv.username).toLowerCase() === String(o.user).toLowerCase()) return null;
      var duel = hasCmd('!duel'), brawl = hasCmd('!brawl');
      return duel || brawl ? { duel: duel, brawl: brawl } : null;
    }
    // ── ＋ (owner point 16: Tip, Soundboard, Say it, Apps and the pickers moved to the tool row - no duplicates) ──
    function openExtras(opener) {
      var box = menu(opener);
      var clip = node('rmClip'), cb = clip && clip.querySelector('button');
      if (cb && !cb.hidden && !cb.disabled) menuItem(box, '✂️', 'clip', 'Clip this chat', function () { external(function () { cb.click(); }); });
      var story = root.querySelector('.rm-story button.ss-add[data-pad]');
      if (story && !inPip()) menuItem(box, '📸', 'story', 'Add to your story', function () { external(function () { story.click(); }); });
      if (o.relay && o.relay.getInput && data && data.room && data.room.cmds) menuItem(box, '❔', 'commands', 'Commands', function () { insertCmd('!', false); });
      finishMenu(box, opener);
    }
    // ── 👥 Participants (owner point 29): ONLY the people card ──
    function participants(opener, after) {
      if (inPip()) { W.focus(); toast(t('in_pad', 'Use this control in the pad tab.')); return; }
      var card = node('rmPplCard'); if (!card) return;
      external(function () {
        var box = sheet(t('participants_n', 'In the room · {n}', { n: peopleCount() }), opener);
        layer.kind = 'participants';
        var mark = D.createComment('people dock'); card.parentNode.insertBefore(mark, card); box.appendChild(card); card.classList.add('rmd-side-open');
        if (infoMark && !infoMark.hidden && layer.head) { var i2 = infoMark.cloneNode(true); i2.classList.add('rmd-info-h'); layer.head.querySelector('h2').appendChild(i2); }
        layer.restore = function () { card.classList.remove('rmd-side-open'); if (mark.parentNode) { mark.parentNode.insertBefore(card, mark); mark.remove(); } };
        if (typeof after === 'function') after();
      });
    }
    function peopleCount() {
      var r = data && data.room || {}, m = (data && data.members || []).length, w = (data && data.web || []).length;
      return (Math.max(Number(r.count) || 0, m)) + w;
    }
    function filterPeople() {
      var ul = node('rmPeople'); if (!ul || !peopleInput) return;
      var q = peopleInput.value.trim().toLowerCase();
      each(ul.children, function (li) { var nm = li.querySelector('.nm'); li.hidden = !!q && txt(nm).toLowerCase().indexOf(q) < 0; });
    }
    function decoratePeople() {
      var card = node('rmPplCard'); if (!card || card.__rmd) return;
      card.__rmd = true; card.classList.add('rmd-people');
      var h = node('pplH'), note = node('rmListNote');
      infoMark = el('span', 'rmd-info', 'ℹ️'); infoMark.tabIndex = 0; infoMark.setAttribute('role', 'note');
      if (h) h.appendChild(infoMark);
      peopleInput = el('input', 'ds-in rmd-find'); peopleInput.type = 'search'; peopleInput.placeholder = t('find', '🔍 Find someone…'); peopleInput.setAttribute('aria-label', t('find_aria', 'Find someone'));
      peopleInput.setAttribute('aria-controls', 'rmPeople');
      on(peopleInput, 'input', filterPeople);
      var list = node('rmPeople'); if (list) card.insertBefore(peopleInput, list); else card.appendChild(peopleInput);
      if (note) note.classList.add('ds-sr-only');
      paintInfo();
    }
    function paintInfo() {
      var note = node('rmListNote'), s = txt(note);
      if (!infoMark) return;
      infoMark.hidden = !s; infoMark.title = s; infoMark.setAttribute('aria-label', s || t('list_note', 'About this list'));
      try { infoMark.setAttribute('aria-description', s); } catch (e) { /* older engines */ }
      var n = node('rmPplN'); if (n) n.textContent = String(peopleCount());
      if (pplBtn) { var c = pplBtn.querySelector('.rmd-count'); if (c) c.textContent = String(peopleCount()); pplBtn.setAttribute('aria-label', t('participants_n', 'In the room · {n}', { n: peopleCount() })); }
    }

    // ── the bottom audio bar (owner points 19, 24): [▶ / ❚❚] [the now zone] [🔊 · volume · 🎚️] ──
    function paintNow() {
      var audioRow = node('rmAudioBox') && node('rmAudioBox').querySelector('.rb-audio'); if (!audioRow || !playBtn) return;
      var state = audioRow.querySelector('.rb-state'), s = txt(state), live = state && state.classList.contains('live');
      playBtn.classList.toggle('rmd-note', !!(s && !live && holders.length && state && state.classList.contains('wait')));
      if (holders.length && s && !live) playBtn.title = s; else playBtn.removeAttribute('title');
    }
    function audioStatus() {
      var row = node('rmAudioBox') && node('rmAudioBox').querySelector('.rb-audio'); if (!row) return '';
      if (!row.classList.contains('on')) return t('audio_idle', 'Not playing');
      var mode = row.querySelector('.rb-mode'), title = mode && mode.title || '';
      var m = /([\d.]+)\s*s\b/.exec(title);
      var rtc = mode && mode.classList.contains('rtc');
      if (rtc) return m ? t('audio_rtc_s', '⚡ Low latency · about {s} s behind', { s: m[1] }) : t('audio_rtc', '⚡ Low latency · about half a second behind');
      if (mode && !mode.classList.contains('hide')) return m ? t('audio_mp3_s', 'Standard relay · about {s} s behind', { s: m[1] }) : t('audio_mp3', 'Standard relay · about 1.5 s behind');
      return txt(row.querySelector('.rb-state')) || t('audio_connecting', 'Connecting…');
    }
    function switchRow(box, icon, key, label, checked, fn, opts) {
      opts = opts || {};
      var doc = box.ownerDocument, row = el('label', 'rmd-switch-row', null, doc);
      var ic = el('span', 'ds-ic', icon, doc); ic.setAttribute('aria-hidden', 'true'); row.appendChild(ic);
      var words = el('span', 'rmd-switch-l', t(key, label), doc); row.appendChild(words);
      var sw = el('span', 'ds-switch', null, doc), input = el('input', null, null, doc); input.type = 'checkbox'; input.setAttribute('role', 'switch');
      input.checked = !!checked; input.setAttribute('aria-checked', String(!!checked)); if (opts.disabled) { input.disabled = true; row.classList.add('off'); }
      sw.appendChild(input); sw.appendChild(el('span', null, null, doc)); row.appendChild(sw);
      if (opts.note) { row.title = opts.note; row.appendChild(el('small', 'rmd-sub', opts.note, doc)); }
      on(input, 'change', function () { var v = fn(input.checked); if (typeof v === 'boolean') input.checked = v; input.setAttribute('aria-checked', String(input.checked)); });
      box.appendChild(row); return input;
    }
    function ios() { return /iP(hone|ad|od)/.test(W.navigator.userAgent || '') || W.navigator.platform === 'MacIntel' && W.navigator.maxTouchPoints > 1; }
    function audioSettings(opener) {
      var box = menu(opener, t('audio_settings', 'Audio settings')), doc = box.ownerDocument;
      box.classList.add('rmd-audio-pop'); box.setAttribute('role', 'dialog');
      var head = el('p', 'rmd-audio-st', audioStatus(), doc); head.setAttribute('role', 'status'); box.appendChild(head);
      var row = node('rmAudioBox') && node('rmAudioBox').querySelector('.rb-audio'), jump = row && row.querySelector('.rb-jump');
      if (jump && !jump.classList.contains('hide')) box.appendChild(button('⏩', 'jump_live', 'Jump to live', function () { jump.click(); closeLayer(); }, 'ds-btn quiet sm', doc));
      var ptt = node('rmPtt'), micSel = ptt && ptt.querySelector('.rb-micsel'), restoreSel = null;
      if (micSel && !inPip()) {
        var lab = el('label', 'rmd-mic', null, doc), ic = el('span', 'ds-ic', '🎙️', doc); ic.setAttribute('aria-hidden', 'true');
        var lt = el('span', 'rmd-mic-l', null, doc); lt.appendChild(ic); lt.appendChild(doc.createTextNode(' ' + t('microphone', 'Microphone'))); lab.appendChild(lt);
        if (micSel.options.length) {
          var mark = micSel.ownerDocument.createComment('mic select'); micSel.parentNode.insertBefore(mark, micSel); lab.appendChild(micSel); micSel.classList.add('ds-select');
          restoreSel = function () { micSel.classList.remove('ds-select'); if (mark.parentNode) { mark.parentNode.insertBefore(micSel, mark); mark.remove(); } };
          box.appendChild(lab);
        } else if (W.navigator.mediaDevices && W.navigator.mediaDevices.getUserMedia) {
          box.appendChild(lab);
          box.appendChild(button('', 'mic_names', 'Allow the microphone to see device names', function (b) {
            b.disabled = true;
            W.navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
              s.getTracks().forEach(function (x) { try { x.stop(); } catch (e) { /* ended */ } });
              if (o.ptt && o.ptt.listMics) o.ptt.listMics();
              setTimeout(function () { if (layer && layer.box === box) audioSettings(opener); }, 300);
            }).catch(function () { b.disabled = false; b.querySelector('.rmd-label').textContent = t('mic_denied', 'The browser didn’t allow the microphone'); });
          }, 'ds-btn quiet sm', doc));
        }
      }
      if (o.audio && o.audio.duck && o.ptt) {
        var iosNote = ios() ? t('duck_ios', 'This device controls room volume with its hardware buttons.') : null;
        switchRow(box, '🦆', 'duck_room', 'Duck the room while I record', o.audio.duck(), function (v) { return o.audio.duck(v); }, { disabled: !!iosNote, note: iosNote });
      }
      var av = row && row.querySelector('.rb-avsync');
      if (av) switchRow(box, '⏱️', 'avsync', 'Sync cams to the audio', av.getAttribute('aria-pressed') === 'true', function () { av.click(); return av.getAttribute('aria-pressed') === 'true'; });
      layer.restore = restoreSel;
      finishMenu(box, opener);
    }
    function decorateAudio() {
      var audioHost = node('rmAudioBox'); if (!audioHost || !chat) return;
      if (compose && compose.parentNode === chat) chat.insertBefore(audioHost, compose);   // room audio stays usable in the composer's signed-out / link-first states
      var row = audioHost.querySelector('.rb-audio'); if (!row || row.__rmd) return;
      row.__rmd = true; row.classList.add('rmd-bar');
      playBtn = row.querySelector('.rb-play');
      nowBox = el('div', 'rmd-now'); var right = el('div', 'rmd-right');
      holderBox = el('div', 'rmd-holders');
      [row.querySelector('.rb-meter'), holderBox, row.querySelector('.rb-state')].forEach(function (n) { if (n) nowBox.appendChild(n); });
      [row.querySelector('.rb-mute'), row.querySelector('.rb-vol')].forEach(function (n) { if (n) right.appendChild(n); });
      var settings = iconBtn('🎚️', 'audio_settings', 'Audio settings', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } audioSettings(b); }, 'ds-btn quiet sm rmd-audio-btn');
      settings.setAttribute('aria-haspopup', 'dialog'); settings.setAttribute('aria-expanded', 'false'); right.appendChild(settings);
      row.insertBefore(nowBox, playBtn ? playBtn.nextSibling : row.firstChild); row.insertBefore(right, nowBox.nextSibling);
      each(row.querySelectorAll('button'), function (b) { b.classList.add('ds-btn', 'quiet', 'sm'); });
      mic(holders);
      if (o.ptt && o.ptt.onRecording && o.audio && o.audio.setRecording) o.ptt.onRecording(function (yes) { o.audio.setRecording(yes); });
      observe(row, function () { paintNow(); if (layer && layer.box && layer.box.classList.contains('rmd-audio-pop')) { var st = layer.box.querySelector('.rmd-audio-st'); if (st) st.textContent = audioStatus(); } }, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    }
    // ── the composer box (owner point 10): row 1 [＋][input][🎙️][Send], row 2 the tool row; the status line under the box ──
    function decorateComposer() {
      if (!compose || !chat) return;
      compose.classList.add('rmd-composer');
      decorateAudio();
      var input = o.relay && o.relay.getInput && o.relay.getInput();
      var row = el('div', 'rmd-input-row');
      if (input) {
        input.classList.add('ds-in'); var form = input.closest('form'), wrap = input.closest('.rb-say-in');
        var relayHost = node('rmRelay'); relayHost.parentNode.insertBefore(row, relayHost); row.appendChild(relayHost);
        extras = iconBtn('＋', 'extras', 'Add to the chat', function () { if (layer && layer.opener === extras) { closeLayer(); return; } openExtras(extras); }, 'ds-btn ghost rmd-extras');
        extras.setAttribute('aria-haspopup', 'menu'); extras.setAttribute('aria-expanded', 'false'); form.insertBefore(extras, wrap);
        var send = form.querySelector('.rb-send'); if (send) send.classList.add('ds-btn', 'primary');
        var hint = el('span', 'ds-sr-only', t('input_hint', 'Type ! for commands; Pepe relays your words into the room as you (web).')); hint.id = 'rmdInputHint'; row.appendChild(hint);
        input.setAttribute('aria-describedby', 'rmdInputHint');
      } else if (node('rmPtt')) compose.insertBefore(row, node('rmPtt'));
      var ptt = node('rmPtt'); if (ptt) { row.appendChild(ptt); var talk = ptt.querySelector('.rb-talk'); if (talk) talk.classList.add('ds-btn', 'quiet'); }
      if (!input && !ptt) return;
      toolRow = el('div', 'rmd-tools'); toolRow.setAttribute('role', 'toolbar'); toolRow.setAttribute('aria-label', t('tools', 'Chat tools'));
      function tool(id, icon, key, label, fn) { var b = iconBtn(icon, key, label, function (x) { fn(x); }, 'ds-btn ghost rmd-tool'); b.setAttribute('data-rmd-tool', id); toolRow.appendChild(b); toolBtns[id] = b; return b; }
      tool('tip', '💸', 'tip', 'Tip', tip);
      tool('gif', '🎞️', 'gifs', 'GIFs', function (b) { picker('gifs', b); });
      tool('stickers', '🧸', 'stickers', 'Stickers', function (b) { picker('patv', b); });
      tool('emoji', '😀', 'emoji', 'Emoji', function (b) { picker('emoji', b); });
      tool('apps', '⚡', 'apps', 'Chat apps', apps);
      tool('sb', '🔊', 'soundboard', 'Soundboard', soundboard);
      var say = tool('tts', '🗣️', 'tts', 'Pepe says it', tts); say.setAttribute('data-rmd-tts', '');
      row.appendChild(toolRow);
      paintTools();
    }
    function paintTools() {
      if (!toolRow) return;
      var room = data && data.room || {}, relayOn = !!(o.relay && room.relay), pick = !!(W.PATVPadPicker && W.PATVPadPicker.available && W.PATVPadPicker.available(data, o));
      var show = { tip: !!o.signed && !inPip(), gif: pick && room.gifPicker === true, stickers: pick && relayOn, emoji: pick && relayOn,
        apps: !!(appList().length || dj()), sb: !!(o.linked && node('rmSb')), tts: hasCmd('!say') };
      Object.keys(toolBtns).forEach(function (k) { toolBtns[k].hidden = !show[k]; });
      toolRow.hidden = !Object.keys(show).some(function (k) { return show[k]; });
    }

    // ── the pad chip + the pad menu (owner points 1, 2, 4, 25) ──
    function heroPiece(sel) { var h = node('rmHero'); return h ? h.querySelector(sel) : null; }
    function padChip(cls, bare) {
      var b = el('button', 'rmd-chip' + (cls ? ' ' + cls : '')); b.type = 'button';
      if (!bare) identity(b);
      var dn = el('span', 'rmd-chip-v', IC.down); dn.setAttribute('aria-hidden', 'true'); b.appendChild(dn);
      var nm = b.querySelector('.rm-nm') || (node('rmTitle') && node('rmTitle').querySelector('.rm-nm')), name = txt(nm);
      b.setAttribute('aria-label', t('pad_menu', 'Pad menu: {name}', { name: name || D.title }));
      b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
      on(b, 'click', function () { if (layer && layer.opener === b) { closeLayer(); return; } padMenu(b); });
      return b;
    }
    function tabButton(id) { var b = D.getElementById('padTab-' + id); return b && b.isConnected ? b : null; }
    function padMenu(opener) {
      var box = menu(opener, t('pad_menu_label', 'Pad menu')), doc = box.ownerDocument;
      box.classList.add('rmd-padmenu');
      var head = el('div', 'rmd-padmenu-h', null, doc); identity(head); box.appendChild(head);
      var follow = heroPiece('.hd-follow'), restoreFollow = null, onLive = !panel || !panel.hidden;
      if (follow && onLive && !inPip() && !follow.closest('.rmd-padmenu')) {
        var fm = follow.ownerDocument.createComment('follow'); follow.parentNode.insertBefore(fm, follow); head.appendChild(follow);
        restoreFollow = function () { if (fm.parentNode) { fm.parentNode.insertBefore(follow, fm); fm.remove(); } };
      }
      layer.restore = restoreFollow;
      var feed = tabButton('feed'), about = tabButton('about'), fresh = node('padFeedNew');
      if (feed && (onLive || feed.getAttribute('aria-selected') !== 'true')) menuItem(box, '📰', 'feed', 'Feed', function () { feed.click(); }, { sub: shown(fresh) ? txt(fresh) : '' });
      if (about && about.getAttribute('aria-selected') !== 'true') menuItem(box, 'ℹ️', 'about', 'About', function () { about.click(); });
      var live = tabButton('live');
      if (live && !onLive) menuItem(box, '🔴', 'live', 'Live', function () { live.click(); });
      var share = node('rmStageH') && node('rmStageH').querySelector('[data-share-path]');
      if (share) menuItem(box, '🔗', 'share', 'Share pad', clickOf(share));
      var go = node('rmGoLive');
      if (go) {
        var here = go.querySelector('.stage-acts a.sact.primary'), book = go.querySelector('.stage-acts a.sact[href*="whenSet"]');
        var boost = node('rmBoostBtn'), boostLink = go.querySelector('.stage-acts a.sact.boost'), slots = node('rmSlotsTxt');
        if (here || book || boost || boostLink) menuGroup(box, 'g_stage', 'Stage');
        if (here) menuItem(box, '🎥', 'golive', 'Go live here', null, { href: here.getAttribute('href'), sub: txt(slots) });
        if (book) menuItem(box, '📅', 'book', 'Book a slot', null, { href: book.getAttribute('href') });
        if (boost && !inPip()) menuItem(box, '🚀', 'boost', 'Boost this pad…', function () { boostSheet(opener); }, { sub: shown(node('rmBoostTxt')) ? txt(node('rmBoostTxt')).replace(/^·\s*/, '') : '' });
        else if (boostLink) menuItem(box, '🚀', 'boost', 'Boost this pad…', null, { href: boostLink.getAttribute('href') });
      }
      var more = node('rmMore'), items = more ? more.querySelectorAll('.hd-menu [role="menuitem"]') : [];
      var extra = Array.prototype.filter.call(items, function (it) { return !it.hasAttribute('data-copy-link'); });
      if (extra.length) {
        menuGroup(box, 'g_more', 'More');
        extra.forEach(function (it) {
          var label = txt(it), ic = '•', m = /^(\p{Extended_Pictographic}\uFE0F?)\s*/u.exec(label);
          if (m) { ic = m[1]; label = label.slice(m[0].length); }
          var b = menuItem(box, ic, 'raw', label, function () { if (it.tagName === 'A' && !it.hasAttribute('data-pad-tab')) return; clickOf(it)(); }, it.tagName === 'A' && !it.hasAttribute('data-pad-tab') ? { href: it.getAttribute('href') } : null);
          b.querySelector('.rmd-label').textContent = label; b.title = label; b.setAttribute('aria-label', label);
        });
      }
      var owner = heroPiece('a.po-link'), settings = heroPiece('a.ps-link');
      if (owner || settings) menuGroup(box, 'g_owner', 'Owner');
      if (owner) { var ob = menuItem(box, '👑', 'owner', 'Owner panel', null, { href: owner.getAttribute('href') }); ob.querySelector('.rmd-label').textContent = owner.getAttribute('aria-label') || txt(owner); }
      if (settings) {
        var q = settings.querySelector('.ps-q');
        menuItem(box, '⚙️', 'settings', 'Settings', null, { href: settings.getAttribute('href'), sub: q && txt(q) !== '0' ? t('n_waiting', '{n} waiting', { n: txt(q) }) : '' });
      }
      var mod = node('rmMod'), cv = root.querySelector('.rm-cvlogin');
      var modOn = mod && !mod.hidden && mod.children.length, cvOn = cv && !cv.hidden && cv.querySelector('button');
      if (modOn || cvOn) menuGroup(box, 'g_mod', 'Moderation');
      if (modOn && !inPip()) menuItem(box, '🛡️', 'manage_room', 'Manage room…', function () { manageRoom(opener); });
      if (cvOn) menuItem(box, '👁', 'cv_login', 'View a cam by Camfrog login (logged)…', clickOf(cv.querySelector('button')));
      finishMenu(box, opener);
    }
    function boostSheet(opener) {
      var form = node('rmBoostBox'), btn = node('rmBoostBtn'); if (!form || !btn) return;
      nodeSheet(t('boost', 'Boost this pad…').replace(/…$/, ''), form, opener, 'boost', function () { if (!form.hidden) btn.click(); });
      if (form.hidden) btn.click();
      var line = node('rmBoostTxt'); if (line && shown(line)) layer.box.appendChild(el('p', 'ds-fine', txt(line).replace(/^·\s*/, '')));
    }
    function manageRoom(opener, then) {
      var mod = node('rmMod'); if (!mod) return;
      external(function () {
        nodeSheet(t('manage_room', 'Manage room…').replace(/…$/, ''), mod, opener, 'mod');
        var tog = mod.querySelector('.pm-tog'); if (tog && tog.getAttribute('aria-expanded') !== 'true') tog.click();
        if (typeof then === 'function') then();
      });
    }

    // ── the stage overlay (owner points 5, 6, 7, 25, 28) ──
    function capButton(k) { var cap = node('rmCap'); return cap && !cap.classList.contains('hide') ? cap.querySelector('.stcap-btn[data-k="' + k + '"]') : null; }
    function capPrices() {
      var p = node('rmCap') && node('rmCap').querySelector('.stcap-price'), s = txt(p);
      var snap = /snap\s+([\d,]+)/i.exec(s), clip = /clip\s+([\d,]+)/i.exec(s);
      return { text: s, snap: snap ? snap[1] : null, clip: clip ? clip[1] : null, off: /^🚫/.test(s) ? s.replace(/^🚫\s*/, '') : null };
    }
    function paintCapture() {
      if (!snapBtn) return;
      var pr = capPrices();
      [['snap', snapBtn], ['clip', clipBtn]].forEach(function (x) {
        var orig = capButton(x[0]), b = x[1];
        b.hidden = !orig;
        if (!orig) return;
        b.disabled = !!orig.disabled; if (orig.disabled) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
        var label = x[0] === 'snap' ? t('snap', 'Snap') : t('clip_stage', 'Clip');
        var price = x[0] === 'snap' ? pr.snap : pr.clip;
        var tip = orig.disabled ? label + ' · ' + (orig.title || pr.off || t('unavailable', 'not available right now'))
          : label + (price ? ' · ' + t('cap_price', '{n} PAT · preview first, pay only if you save', { n: price }) : '');
        b.title = tip; b.setAttribute('aria-label', tip);
      });
    }
    function clipMenu(opener) {
      var cap = node('rmCap'), secs = cap && cap.querySelector('.stcap-secs');
      if (!secs) { var orig = capButton('clip'); if (orig) external(function () { orig.click(); }); return; }
      var box = menu(opener, t('clip_len', 'Clip length')), pr = capPrices();
      Array.prototype.forEach.call(secs.options, function (op) {
        var n = op.value;
        menuItem(box, '🎬', 'clip_secs', '{n} s', function () {
          var s = node('rmCap') && node('rmCap').querySelector('.stcap-secs'); if (!s) return;
          s.value = n; s.dispatchEvent(new W.CustomEvent('change', { bubbles: true }));
          var b = capButton('clip'); if (b && !b.disabled) external(function () { b.click(); });
        }, { role: 'menuitemradio', checked: op.selected || secs.value === n, vars: { n: n } });
      });
      if (pr.clip) box.appendChild(el('p', 'ds-fine rmd-menu-note', t('clip_note', 'Preview first; {n} PAT only if you save', { n: pr.clip }), box.ownerDocument));
      finishMenu(box, opener);
    }
    function tabs() { var n = node('rmTabs'); return n ? Array.prototype.slice.call(n.querySelectorAll('.stab')) : []; }
    // the tab row's own extras (Pepe's own stream / back to the embed, 🟣 Watch on Twitch, 🙈 Take me off this Stage, a manager's ☆ / ✕)
    function tabExtras() {
      var n = node('rmTabs'), out = []; if (!n) return out;
      each(n.querySelectorAll('.stx'), function (b) { out.push(b); });
      each(n.querySelectorAll('.adm button'), function (b) { out.push(b); });
      return out;
    }
    function paintSource() {
      if (!srcHost) return;
      var list = tabs(), sel = list.filter(function (b) { return b.getAttribute('aria-selected') === 'true'; })[0] || list[0];
      srcHost.textContent = '';
      if (!list.length) { srcHost.hidden = true; return; }
      srcHost.hidden = false;
      var label = txt(sel).replace(/^★\s*/, '');
      if (list.length < 2 && !tabExtras().length) { srcHost.appendChild(el('span', 'rmd-src rmd-src-one', label)); return; }
      var b = el('button', 'rmd-src ds-btn quiet sm'); b.type = 'button';
      var dot = el('span', 'rmd-dot' + (sel && !sel.classList.contains('off') ? ' rmd-on' : '')); dot.setAttribute('aria-hidden', 'true'); b.appendChild(dot);
      b.appendChild(el('span', 'rmd-label', label)); var dn = el('span', 'rmd-chip-v', IC.down); dn.setAttribute('aria-hidden', 'true'); b.appendChild(dn);
      b.setAttribute('aria-label', t('source', 'Stage source: {name}', { name: label })); b.title = b.getAttribute('aria-label');
      b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
      on(b, 'click', function () { if (layer && layer.opener === b) { closeLayer(); return; } sourceMenu(b); });
      srcHost.appendChild(b);
    }
    function sourceMenu(opener) {
      var box = menu(opener, t('sources', 'Stage sources'));
      tabs().forEach(function (tb) {
        var label = txt(tb).replace(/^★\s*/, '');
        var it = menuItem(box, tb.classList.contains('off') ? '⚪' : '🔴', 'raw', label, function () { tb.click(); paintSource(); }, { role: 'menuitemradio', checked: tb.getAttribute('aria-selected') === 'true' });
        it.querySelector('.rmd-label').textContent = label; it.title = label; it.setAttribute('aria-label', label);
      });
      var extras = tabExtras();
      if (extras.length) {
        box.appendChild(el('div', 'rmd-menu-g', null, box.ownerDocument)).setAttribute('role', 'separator');
        extras.forEach(function (x) {
          var lb = txt(x), href = x.tagName === 'A' ? x.getAttribute('href') : null;
          var it = menuItem(box, '•', 'raw', lb, href ? null : function () { external(function () { x.click(); }); }, href ? { href: href } : { disabled: x.disabled, tip: x.title });
          if (href) { it.target = '_blank'; it.rel = 'noopener noreferrer'; }
          it.querySelector('.rmd-label').textContent = lb; it.setAttribute('aria-label', lb);
        });
      }
      finishMenu(box, opener);
    }
    function lowlat() { var b = stage && stage.querySelector('.lowlat'); return b && !b.classList.contains('hide') ? b : null; }
    function stageMenu(opener) {
      var box = menu(opener, t('stage_menu', 'Stage options'));
      var ll = lowlat();
      if (ll) menuItem(box, '⚡', 'lowlat', 'Low latency', function () { ll.click(); }, { role: 'menuitemcheckbox', checked: ll.getAttribute('aria-pressed') === 'true', tip: ll.title });
      menuItem(box, IC.pop, 'pop_stage', 'Pop out player', function () { pop(stageMedia(), false); });
      menuItem(box, IC.hide, 'hide_stage', 'Hide stage', function () { hideStage(true); });
      if (strip && strip.querySelector('.cs-tile')) menuItem(box, '📌', 'pins', 'Pinned cams', function () { pinsMenu(box, opener); }, { keep: true, sub: '▸' });
      var sched = node('rmSched'), upnext = node('rmGoLive') && node('rmGoLive').querySelector('.upnext');
      if (sched || upnext) menuItem(box, '📅', 'schedule', 'Stage schedule…', function () { scheduleSheet(opener); });
      var plex = node('rmPlexQ'); if (plex && !plex.hidden) menuItem(box, '📼', 'plex', 'Plex queue & controls…', function () { external(function () { nodeSheet(t('plex', 'Plex queue & controls…').replace(/…$/, ''), plex, opener, 'plex'); }); });
      var mbtn = stage && stage.querySelector('.mf-mbtn'), clear = stage && stage.querySelector('.mf-clear'), rep = stage && stage.querySelector('.mf-rbtn');
      if (rep && !rep.hidden) menuItem(box, '⚑', 'mf_report', 'Report someone on the mic stage…', function () { external(function () { rep.click(); }); });
      if ((mbtn && !mbtn.hidden) || (clear && !clear.hidden)) menuGroup(box, 'g_managers', 'Managers');
      if (mbtn && !mbtn.hidden) menuItem(box, '🎚️', 'mf_manage', 'Manage the mic stage…', function () { micPanel(opener, mbtn); });
      if (clear && !clear.hidden) menuItem(box, '🧹', 'mf_clear', 'Clear the stage', function () { external(function () { clear.click(); }); }, { disabled: clear.disabled });
      var oab = root.querySelectorAll('.oab button[data-oab]');
      if (oab.length) {
        menuGroup(box, 'g_staff', 'Staff');
        each(oab, function (b) {
          var label = b.getAttribute('aria-label') || txt(b), what = b.getAttribute('data-oab');
          var it = menuItem(box, what === 'play' ? '📺' : what === 'cut' ? '✂️' : '•', 'raw', label, function () { external(function () { b.click(); }); }, { disabled: b.disabled, tip: b.title });
          it.querySelector('.rmd-label').textContent = label.replace(/^📺\s*|^✂\s*/, ''); it.setAttribute('aria-label', label);
        });
      }
      finishMenu(box, opener);
    }
    function pinsMenu(box, opener) {
      box.textContent = '';
      menuItem(box, '←', 'back', 'Back', function () { closeLayer(false); stageMenu(opener); });
      var now = strip.getAttribute('data-rmd-layout') || 'small';
      [['small', 'Small'], ['large', 'Large'], ['grid', 'Grid']].forEach(function (p) {
        menuItem(box, p[0] === 'grid' ? '▦' : p[0] === 'large' ? '⬛' : '▪️', 'layout_' + p[0], p[1], function () { strip.setAttribute('data-rmd-layout', p[0]); root.setAttribute('data-rmd-pins', p[0]); }, { role: 'menuitemradio', checked: now === p[0] });
      });
      var clear = strip.querySelector('.cs-clear');
      if (clear) menuItem(box, '✕', 'close_all', 'Close all', function () { external(function () { clear.click(); }); });
      var first = focusable(box)[0]; if (first) first.focus();
    }
    function scheduleSheet(opener) {
      var sched = node('rmSched'), upnext = node('rmGoLive') && node('rmGoLive').querySelector('.upnext');
      external(function () {
        var n = sched || upnext; nodeSheet(t('schedule', 'Stage schedule…').replace(/…$/, ''), n, opener, 'schedule');
        if (sched && upnext) { var m2 = D.createComment('upnext'); upnext.parentNode.insertBefore(m2, upnext); layer.box.appendChild(upnext); var r0 = layer.restore; layer.restore = function () { if (m2.parentNode) { m2.parentNode.insertBefore(upnext, m2); m2.remove(); } r0(); }; }
      });
    }
    function micPanel(opener, mbtn) {
      var pnl = null;
      each(stage ? stage.querySelectorAll('.mf-panel') : [], function (x) { if (!pnl && !x.classList.contains('mf-rpanel')) pnl = x; });
      if (!pnl) return;
      external(function () {
        nodeSheet(t('mf_manage', 'Manage the mic stage…').replace(/…$/, ''), pnl, opener, 'micstage', function () { if (!pnl.hidden) mbtn.click(); });
        if (pnl.hidden) mbtn.click();
      });
    }
    function overlayHot() {
      var doc = stage.ownerDocument;
      // (keyboard focus keeps it up; a mouse click that left focus on a button doesn't pin it)
      var a = doc.activeElement, kb = false;
      try { kb = !!(a && a.matches && a.matches(':focus-visible')); } catch (e) { kb = true; }
      return overBar || (kb && ovTop && (ovTop.contains(a) || ovBot.contains(a))) || !!(layer && layer.overlay);
    }
    function showTools() {
      if (!stage) return;
      stage.classList.add('rmd-controls-on'); clearTimeout(autoTimer);
      paintCapture(); paintSource();
      autoTimer = setTimeout(function hide() { if (overlayHot()) { autoTimer = setTimeout(hide, HIDE_MS); return; } stage.classList.remove('rmd-controls-on'); }, HIDE_MS);
    }
    function hideTools() { clearTimeout(autoTimer); if (!overlayHot()) stage.classList.remove('rmd-controls-on'); }
    function buildStage() {
      var ov = el('div', 'rmd-ov');
      ovTop = el('div', 'rmd-ov-top'); ovBot = el('div', 'rmd-ov-bot');
      ovTop.appendChild(padChip());
      slimText = el('span', 'rmd-slim-t', t('nothing_on', 'Nothing on stage right now')); ovTop.appendChild(slimText);
      srcHost = el('span', 'rmd-src-host'); ovBot.appendChild(srcHost);
      ovBot.appendChild(el('span', 'rmd-ov-gap'));
      snapBtn = iconBtn('📸', 'snap', 'Snap', function () { var b = capButton('snap'); if (b && !b.disabled) external(function () { b.click(); }); });
      clipBtn = iconBtn('🎬', 'clip_stage', 'Clip', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } clipMenu(b); });
      clipBtn.setAttribute('aria-haspopup', 'menu'); clipBtn.setAttribute('aria-expanded', 'false');
      var fullBtn = iconBtn(IC.full, 'fullscreen', 'Fullscreen', function () { full(stageMedia()); });
      var more = iconBtn(IC.more, 'stage_menu', 'Stage options', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } stageMenu(b); });
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); more.classList.add('rmd-stage-more');
      [snapBtn, clipBtn, fullBtn, more].forEach(function (b) { ovBot.appendChild(b); });
      ov.appendChild(ovTop); ov.appendChild(ovBot);
      srcBox = node('rmTabs'); if (srcBox) { srcBox.classList.add('rmd-tabs-src'); ov.appendChild(srcBox); }
      stage.insertBefore(ov, stage.firstChild);
      [ovTop, ovBot].forEach(function (bar) { on(bar, 'pointerenter', function () { overBar = true; }); on(bar, 'pointerleave', function () { overBar = false; showTools(); }); });
      // the stage hidden: a slim bar [pad chip ▾] Stage hidden … [📺 Show stage]
      var mini = el('div', 'rmd-mini'); mini.id = 'rmdMini'; mini.hidden = true; mini.appendChild(padChip('rmd-chip-mini'));
      mini.appendChild(el('span', 'rmd-slim-t', t('stage_hidden', 'Stage hidden')));
      mini.appendChild(button('📺', 'restore_stage', 'Show stage', function () { hideStage(false); }));
      stage.parentNode.insertBefore(mini, stage);
      on(stage, 'pointermove', function (e) { if (e.pointerType !== 'touch') showTools(); });
      on(stage, 'pointerdown', function (e) {
        if (e.pointerType === 'touch' && !(e.target.closest && e.target.closest('.rmd-ov-top,.rmd-ov-bot,.rmd-strip,button,a,input,select'))) {
          if (stage.classList.contains('rmd-controls-on')) hideTools(); else showTools();
          return;
        }
        showTools();
      });
      on(stage, 'pointerleave', function () { clearTimeout(autoTimer); autoTimer = setTimeout(function () { if (!overlayHot()) stage.classList.remove('rmd-controls-on'); }, HIDE_MS); });
      on(stage, 'focusin', showTools);
      on(stage, 'patv:stagechange', function (e) { stageChanged(e.detail); paintSource(); paintCapture(); });
      // the pinned cams live inside the stage card (owner point 28 / targets 172-173): a column at the inline end, a row on phones
      if (strip) { stage.appendChild(strip); strip.classList.add('rmd-strip'); }
      observe(node('rmCap'), paintCapture, { childList: true, subtree: true, attributes: true });
      observe(srcBox, paintSource, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'class'] });
      showTools();
    }

    // ── the chat card's one header row (owner points 8, 18) ──
    function chatMenu(opener) {
      var box = menu(opener, t('chat_menu', 'Chat options'));
      var jump = node('rmHistJump'); if (jump && !jump.hidden) menuItem(box, '📅', 'jump_date', 'Jump to a date', function () { external(function () { jump.click(); }); });
      var dl = o.download;
      if (dl && dl.items) dl.items().forEach(function (it) {
        var mi = menuItem(box, '⬇', 'raw', it.label.replace(/^⬇\s*/, ''), function () { dl.run(it.id); });
        mi.querySelector('.rmd-label').textContent = it.label.replace(/^⬇\s*/, '');
      });
      menuItem(box, IC.pop, 'float_chat', 'Float chat', floatChat);
      if (W.documentPictureInPicture && W.documentPictureInPicture.requestWindow) menuItem(box, '🗗', 'pop_chat', 'Pop out chat', function () { pop(chat, true); });
      var hist = node('rmHist');
      if (hist && !hist.hidden && hist.getAttribute('href')) {
        var hi = menuItem(box, '📜', 'raw', '', null, { href: hist.getAttribute('href') });
        hi.querySelector('.rmd-label').textContent = t('hist_info', 'Visitors read: {span} · how it works', { span: txt(hist).replace(/^📜\s*/, '') });
        hi.title = hist.title || ''; hi.setAttribute('aria-label', hi.querySelector('.rmd-label').textContent);
      }
      finishMenu(box, opener);
    }
    function topicPop(opener, text) {
      var box = menu(opener, t('topic_full', 'Topic')); box.setAttribute('role', 'dialog');
      box.appendChild(el('p', 'rmd-topic-full', text, box.ownerDocument)); finishMenu(box, opener);
    }
    function paintTopic() {
      var topic = node('rmTopic'); if (!topic || !topicRow) return;
      var s = txt(topic), can = !!(o.canTopic && o.canTopic());
      topicRow.hidden = !s && !can;
      topic.title = s;
      if (can) { topic.setAttribute('role', 'button'); topic.tabIndex = 0; topic.setAttribute('aria-label', t('topic_edit', 'Edit topic: {topic}', { topic: s || '—' })); }
      else if (s) { topic.setAttribute('role', 'button'); topic.tabIndex = 0; topic.setAttribute('aria-label', t('topic_read', 'Topic: {topic}', { topic: s })); }
      else { topic.removeAttribute('role'); topic.removeAttribute('tabindex'); topic.removeAttribute('aria-label'); }
    }
    function topicClick(e) {
      var topic = node('rmTopic'), s = txt(topic);
      if (e && e.type === 'keydown') { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); }
      if (o.canTopic && o.canTopic()) { manageRoom(topic, o.openTopic); return; }
      if (s && (topic.scrollWidth > topic.clientWidth + 1 || (e && e.type === 'keydown'))) topicPop(topic, s);
    }
    function buildChatHead() {
      var h = node('chatH'); if (!h) return;
      h.classList.add('rmd-chat-h');
      var topic = node('rmTopic');
      if (topic) {
        topicRow = el('span', 'rmd-topic-line'); topicRow.appendChild(topic);
        var status = node('rmStatus'); h.insertBefore(topicRow, status || null);
        on(topic, 'click', topicClick); on(topic, 'keydown', topicClick);
      }
      if (node('rmPplCard')) {
        pplBtn = button('👥', 'participants', 'Participants', participants, 'ds-btn quiet sm rmd-ppl-btn');
        pplBtn.appendChild(el('span', 'rmd-count', String(peopleCount()))); h.appendChild(pplBtn);
      }
      var search = node('rmSearchBtn'); if (search) h.appendChild(search);
      chatMore = iconBtn(IC.more, 'chat_menu', 'Chat options', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } chatMenu(b); }, 'ds-btn ghost sm rmd-chat-more');
      chatMore.setAttribute('aria-haspopup', 'menu'); chatMore.setAttribute('aria-expanded', 'false'); h.appendChild(chatMore);
      paintTopic();
      // the log and its "New messages ↓" pill (owner point 31): bottom-centre of the log, never over the audio bar or the composer
      var scroll = node('rmScroll'), jump = node('rmJump');
      if (scroll && jump && !scroll.parentNode.classList.contains('rmd-log')) {
        var log = el('div', 'rmd-log'); scroll.parentNode.insertBefore(log, scroll); log.appendChild(scroll); log.appendChild(jump);
      }
    }

    function update(d) {
      var previous = data; data = d || {}; if (!ready) return;
      if (o.mod && o.mod.closeMenu) {
        var personMenu = D.querySelector('.pm-pop'), login = personMenu && String(personMenu._login || '').toLowerCase();
        function namedMember(value) { return !!(login && value && Array.isArray(value.members) && value.members.some(function (u) { return u && !u.veil && !u.anon && String(u.login || '').toLowerCase() === login; })); }
        if ((data.removed && data.removed.length) || (data.redo && data.redo.length) || (namedMember(previous) && !namedMember(data))) o.mod.closeMenu(false);
      }
      if (layer && (layer.kind === 'tip' || layer.kind === 'tts' && (!hasCmd('!say') || layer.price !== cmds()['!say']) || layer.kind === 'pvp' && previous && JSON.stringify(previous.members) !== JSON.stringify(data.members))) closeLayer();
      each(root.querySelectorAll('[data-rmd-tts]'), function (b) { b.hidden = !hasCmd('!say'); });
      paintTools(); paintTopic(); paintInfo(); filterPeople(); paintCapture(); paintSource(); paintNow();
      if (pip) each(pip.document.querySelectorAll('[data-rmd-tts]'), function (b) { b.hidden = !hasCmd('!say'); });
      decorateCams();
    }
    function stageChanged(sel) {
      if (JSON.stringify(selected) !== JSON.stringify(sel)) stageRevision++;
      selected = sel;
      if (videoPipSource && videoPipSource !== JSON.stringify(sel)) {
        videoPipSource = null; if (D.pictureInPictureElement && D.exitPictureInPicture) Promise.resolve(D.exitPictureInPicture()).catch(function () {});
      }
    }
    function tabChanged(tab) {
      var live = tab === 'live'; D.body.classList.toggle('pad-dock-live', live);
      if (!live) { redock(); closeLayer(false); }
    }
    // Feed / About: one slim header row - [pad identity] [● Live · Feed · About] [Follow] [▾ pad menu] (owner point 4)
    function buildHeader() {
      var hero = node('rmHero'), tabsNav = node('padTabs'), hd = hero && hero.querySelector('.hd');
      if (!hd || !tabsNav) return;
      tabsNav.classList.add('ds-seg', 'rmd-seg');
      var acts = hd.querySelector('.hd-acts'); hd.insertBefore(tabsNav, acts || null);
      if (acts) acts.appendChild(padChip('rmd-chip-head', true));
    }
    function start() {
      if (ready || dead) return;
      ready = true; stage = node('rmStage'); chat = node('rmChat'); strip = node('rmStrip'); compose = node('rmCompose');
      panel = node('padPanel-live'); template = node('rmdId');
      side = root.querySelector('.rm-live > .side'); if (side) side.classList.add('rmd-side');
      buildHeader();
      if (stage) buildStage();
      if (chat) buildChatHead();
      decoratePeople();
      if (strip) {
        strip.setAttribute('data-rmd-layout', 'small');
        observe(strip, decorateCams); decorateCams();
      }
      decorateComposer(); attachDoc(D);
      on(D, 'fullscreenchange', function () { if (current && current.kind === 'full' && !D.fullscreenElement) redock(); });
      on(D, 'patv:padtab', function (e) { tabChanged(e.detail && e.detail.tab); });
      on(W, 'pagehide', function () { redock(); if (pip) pip.close(); });
      tabChanged(panel && !panel.hidden ? 'live' : 'feed'); update(data);
    }
    if (D.readyState === 'loading') on(D, 'DOMContentLoaded', start); else start();
    return {
      update: update, mic: mic, personLine: personLine, visible: visible, redock: redock, stageChanged: stageChanged,
      pvp: pvp, pvpFor: pvpFor, peopleDrawn: function () { filterPeople(); paintInfo(); }, participants: participants,
      destroy: function () { dead = true; redock(); returnCam(); closeLayer(false); observers.forEach(function (m) { m.disconnect(); }); clearTimeout(autoTimer); clearTimeout(toastTimer); listeners.forEach(function (x) { x[0].removeEventListener(x[1], x[2], x[3]); }); D.body.classList.remove('pad-dock-live'); }
    };
  }
  W.PATVPadDock = { init: init };
})(window, document);
