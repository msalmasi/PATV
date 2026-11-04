// The bridged pad's Dock moves existing widgets; it never requests or resolves room data.
(function (W, D) {
  'use strict';
  var tr = typeof W.__t === 'function' ? W.__t : function (k, d, v) {
    return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function t(k, fallback, v) { return tr('js.pad.dock.' + k, fallback, v); }
  function el(tag, cls, text, doc) { var n = (doc || D).createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function each(nodes, fn) { Array.prototype.forEach.call(nodes || [], fn); }
  // 1.99?? dockfu (owner decision 6, the lead's design call d): the view controls are EMOJI icons (the design system's rule), not
  // text symbols (▁ ⌄ ⛶ ↗ 🗗 ↩): 🔽 hide the stage / open the phone drawer (🔼 folds it back), 🖥️ fullscreen, 🪟 pop out or float,
  // ↩️ bring it back. Each button keeps its words as its accessible name and tooltip (button() below).
  var IC = { hide: '🔽', fold: '🔼', full: '🖥️', pop: '🪟', back: '↩️' };
  function init(o) {
    o = o || {};
    var root = o.root || D.querySelector('main.rm.rm-dock');
    if (!root) return null;
    var nodes = o.nodes || {}, dead = false, ready = false, data = null, holders = [], listeners = [];
    var stage, chat, strip, compose, side, panel, template, bar, drawer, holderBox, duck, tools, extras;
    var current = null, layer = null, pip = null, pipPending = false, popGeneration = 0, localCam = null, stageHidden = false;
    var autoTimer = null, toastTimer = null, observer = null, lastTouch = null, selected = null, stageRevision = 0, videoPipSource = null;
    function node(id) { return nodes[id] || (nodes[id] = D.getElementById(id)); }
    function on(n, type, fn, capture) { if (!n) return; n.addEventListener(type, fn, !!capture); if (n === W || n.nodeType === 9) listeners.push([n, type, fn, !!capture]); }
    function button(icon, key, fallback, fn, cls, doc) {
      var b = el('button', cls || 'ds-btn quiet sm', null, doc); b.type = 'button';
      if (icon) { var i = el('span', 'ds-ic', icon, doc); i.setAttribute('aria-hidden', 'true'); b.appendChild(i); }
      b.appendChild(el('span', 'rmd-label', t(key, fallback), doc));
      b.title = t(key, fallback); b.setAttribute('aria-label', t(key, fallback));
      if (fn) on(b, 'click', function (e) { fn(b, e); }); return b;
    }
    function activeRoot() { return pip && !pip.closed ? pip.document.querySelector('main') : current && current.kind === 'full' ? current.host : root; }
    function docOf() { return chat && chat.ownerDocument || D; }
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
      if (focus !== false && old.opener && old.opener.isConnected) old.opener.focus();
    }
    function sheet(title, opener, menu) {
      closeLayer(false);
      var place = activeRoot(), doc = place.ownerDocument;
      var host = el('div', 'rmd-layer ds-scrim sheet', null, doc);
      var box = el('section', menu ? 'ds-modal rmd-menu' : 'ds-modal', null, doc);
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
      var head = el('div', 'ds-modal-h', null, doc); head.appendChild(el('h2', null, title, doc));
      head.appendChild(button('✕', 'close', 'Close', function () { closeLayer(); }, 'ds-btn ghost sm', doc));
      box.appendChild(head); host.appendChild(box); place.appendChild(host);
      layer = { host: host, box: box, opener: opener || doc.activeElement };
      on(host, 'click', function (e) { if (e.target === host && !foreignModal(doc)) closeLayer(); });
      setTimeout(function () { if (layer && layer.host === host) { var a = focusable(box); if (a[0]) a[0].focus(); } }, 0);
      return box;
    }
    function menu(opener) {
      closeLayer(false);
      var place = activeRoot(), doc = place.ownerDocument, box = el('div', 'rmd-menu ds-pop', null, doc);
      box.setAttribute('role', 'menu'); box.setAttribute('aria-label', t('extras', 'Add to the chat'));
      place.appendChild(box); layer = { host: box, box: box, opener: opener };
      return box;
    }
    function menuItem(box, icon, key, label, fn) {
      var opener = layer && layer.opener;
      var b = button(icon, key, label, function () { closeLayer(false); fn(opener || b); }, 'ds-menu-item', box.ownerDocument);
      b.setAttribute('role', 'menuitem'); box.appendChild(b); return b;
    }
    function external(fn) {
      if (pip && !pip.closed) { W.focus(); toast(t('in_pad', 'Use this control in the pad tab.')); return; }
      closeLayer(false);
      if (D.fullscreenElement && D.exitFullscreen) {
        Promise.resolve(D.exitFullscreen()).then(function () { redock(); fn(); }).catch(function () { toast(t('exit_first', 'Leave fullscreen to use this control.')); });
      } else fn();
    }
    // Existing menus/prompts belong to the opener. Route the original gesture there before they open.
    var externalSelector = '.la-btn,.pm-mg,.pm-btn,.ic button.cam,.mc-btn,.cc-btn,.pc-btn,.sc-btn,.stx,.mf-rv,.mf-off,[data-rv],[data-rvm],.rv,.rvm,[data-reveal],.veil-reveal,.reveal-btn,#rmMoreBtn,#rmSearchBtn,#rmHistJump,#rmCap button,#rmClip button,.sbd-rep,[data-pad-gift],[data-share-path]';
    function routeExternal(e) {
      var b = e.target.closest && e.target.closest(externalSelector); if (!b || b.__rmdReplay) return;
      // Roster popovers belong to the pad body. Restore their anchors before the
      // original click opens one, so the Participants scrim cannot cover it or steal focus.
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
      var a = focusable(layer.box); if (a[0]) a[0].focus();
    }
    function attachDoc(doc) {
      on(doc, 'keydown', keydown); on(doc, 'focusin', trap); on(doc, 'click', routeExternal, true);
      on(doc, 'click', function (e) { if (layer && layer.host.classList.contains('ds-pop') && !layer.host.contains(e.target) && e.target !== layer.opener && !layer.opener.contains(e.target)) closeLayer(false); });
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
    function watchCam(tile) {
      redock(); returnCam(); hideStage(false);
      var host = el('section', 'rmd-local-player cam-strip'); stage.parentNode.insertBefore(host, stage);
      var head = viewbar(host, returnCam);
      head.appendChild(button(IC.full, 'fullscreen', 'Fullscreen', function () { full(host); }));
      head.appendChild(button(IC.hide, 'hide_stage', 'Hide stage', function () { hideStage(true); }, 'ds-btn quiet sm rmd-icon'));
      head.appendChild(button(IC.pop, 'pop_stage', 'Pop out player', function () { pop(host, false); }, 'ds-btn quiet sm rmd-icon'));
      localCam = { host: host, move: movable(tile, host, t('cam_stage', 'This cam is on your stage.')) };
      // This placeholder returns the local swap rather than redocking an unrelated surface.
      var rb = localCam.move.mark.querySelector('button'); rb.replaceWith(button(IC.back, 'return_cam', 'Return cam to strip', returnCam));
      var close = tile.querySelector('.cs-x'); if (close) on(close, 'click', function () { setTimeout(function () { if (localCam && localCam.move.node === tile && !tile.parentNode) returnCam(); }, 0); });
      root.classList.add('rmd-local-cam'); changed();
    }
    function decorateCams() {
      if (!strip) return;
      each(strip.querySelectorAll('.cs-tile'), function (tile) {
        if (tile.querySelector('.rmd-cam-tools')) return;
        var bar = el('div', 'rmd-cam-tools');
        bar.appendChild(button('📺', 'watch_cam', 'Watch on my stage', function () { watchCam(tile); }));
        bar.appendChild(button(IC.full, 'fullscreen', 'Fullscreen', function () { full(tile); })); tile.appendChild(bar);
      });
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
    function mic(list) {
      holders = Array.isArray(list) ? list : []; if (!holderBox || !o.person) return;
      var max = W.matchMedia && W.matchMedia('(max-width: 760px)').matches ? 1 : 2;
      // 1.99aiw review: drawMic calls this on every /live answer (and on lip-sync redraws); like the On the mic card, redraw only
      // when the holders change - a rebuild restarted animated name styles and dropped keyboard focus on a chip
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
        var more = button('', 'more_holders', 'More people on the mic', participants, 'ds-btn quiet sm');
        more.querySelector('.rmd-label').textContent = '+' + (holders.length - max); holderBox.appendChild(more);
      }
      holderBox.hidden = !holders.length;
    }
    function cmds() { return data && data.room && data.room.cmds || {}; }
    function hasCmd(k) { return !!o.linked && Object.prototype.hasOwnProperty.call(cmds(), k); }
    function tts(opener) {
      if (!hasCmd('!say') || !o.relay || !o.relay.sendCmd) return;
      var box = sheet(t('tts', 'Pepe says it'), opener), doc = box.ownerDocument;
      layer.kind = 'tts'; layer.price = cmds()['!say'];
      var form = el('form', 'rmd-tts', null, doc), lab = el('label', 'ds-label', t('tts_words', 'What should Pepe say?'), doc);
      var inp = el('input', 'ds-in', null, doc); inp.type = 'text'; inp.maxLength = 295; inp.required = true;
      lab.appendChild(inp); form.appendChild(lab);
      var price = cmds()['!say'];
      var priceText = price === 0 ? t('free', 'free') : typeof price === 'number' ? t('price', '{n} PAT', { n: price.toLocaleString() }) : String(price || '');
      form.appendChild(el('p', 'rmd-price', priceText + (price > 0 ? ' · ' + t('admins_free', 'admins free') : ''), doc));
      var actions = el('div', 'ds-modal-f', null, doc);
      actions.appendChild(button('', 'cancel', 'Cancel', function () { closeLayer(); }, 'ds-btn quiet', doc));
      var send = button('📣', 'send_tts', 'Send to Pepe', null, 'ds-btn gold', doc); send.type = 'submit'; actions.appendChild(send); form.appendChild(actions); box.appendChild(form);
      on(form, 'submit', function (e) {
        e.preventDefault(); var text = inp.value.trim(); if (!text || !hasCmd('!say')) return;
        o.relay.sendCmd('!say ' + text.slice(0, 295)); closeLayer();
      }); inp.focus();
    }
    function apps(opener) {
      var box = sheet(t('apps', 'Chat apps'), opener), doc = box.ownerDocument;
      [['!duel', '⚔️'], ['!brawl', '🥊'], ['!bj', '🃏'], ['!holdem', '♠️']].forEach(function (c) {
        if (!hasCmd(c[0]) || !o.relay) return;
        var b = el('button', 'ds-btn quiet', null, doc); b.type = 'button';
        var ic = el('span', 'ds-ic', c[1], doc); ic.setAttribute('aria-hidden', 'true'); b.appendChild(ic); b.appendChild(doc.createTextNode(c[0]));
        on(b, 'click', function () { o.relay.insert(c[0] + ' ', { replace: true }); closeLayer(); o.relay.getInput().focus(); }); box.appendChild(b);
      });
      var wheel = el('a', 'ds-btn quiet', t('wheel', '🎡 Wheel'), doc); wheel.href = o.user ? '/u/' + encodeURIComponent(o.user) + '/wheel' : '/login';
      if (pip && !pip.closed) on(wheel, 'click', function (e) { e.preventDefault(); W.focus(); toast(t('in_pad', 'Use this control in the pad tab.')); });
      box.appendChild(wheel);
    }
    function soundboard(opener) {
      var sb = node('rmSb'); if (!sb) return;
      var box = sheet(t('soundboard', 'Soundboard'), opener), mark = D.createComment('soundboard dock'); sb.parentNode.insertBefore(mark, sb); box.appendChild(sb);
      layer.restore = function () { if (mark.parentNode) { mark.parentNode.insertBefore(sb, mark); mark.remove(); } };
      var toggle = sb.querySelector('.sbd-toggle'); if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    }
    function tip(opener) {
      if (!o.signed || !W.PATVRoom || !W.PATVRoom.tipModal) return;
      var box = sheet(t('tip_who', 'Who would you like to tip?'), opener), people = data && data.members || [];
      layer.kind = 'tip';
      var count = 0;
      people.forEach(function (u) {
        if (!u || u.veil || u.anon || u.bot || u.self || !u.tip || !u.tip.to || !u.tip.href || u.tip.to === o.user) return;
        var b = el('button', 'ds-btn quiet', null, box.ownerDocument), content = o.person && o.person(u); b.type = 'button'; if (content) b.appendChild(content);
        on(b, 'click', function () {
          var now = (data && data.members || []).filter(function (p) { return p && !p.veil && !p.anon && !p.bot && !p.self && p.tip && p.tip.to === u.tip.to && p.tip.href; })[0];
          if (!now) { closeLayer(); return; }
          external(function () { W.PATVRoom.tipModal({ to: now.tip.to, display: now.display, slug: o.slug, me: o.user }); });
        }); box.appendChild(b); count++;
      });
      if (!count) box.appendChild(el('p', null, t('tip_none', 'No eligible recipients are in the room.')));
    }
    function openExtras(opener) {
      var box = menu(opener);
      if (o.signed && !(pip && !pip.closed)) menuItem(box, '💸', 'tip', 'Tip', tip);
      var clip = node('rmClip'), cb = clip && clip.querySelector('button');
      if (cb && !cb.hidden && !cb.disabled) menuItem(box, '✂️', 'clip', 'Clip chat', function () { external(function () { cb.click(); }); });
      if (node('rmSb')) menuItem(box, '🔊', 'soundboard', 'Soundboard', soundboard);
      if (hasCmd('!say')) menuItem(box, '🗣️', 'tts', 'Pepe says it', tts);
      menuItem(box, '⚡', 'apps', 'Chat apps', apps);
      var story = root.querySelector('.rm-story button.ss-add[data-pad]');
      if (story && !(pip && !pip.closed)) menuItem(box, '📸', 'story', 'Add to your story', function () { external(function () { story.click(); }); });
      // Phase 2 can register the picker without changing the one relay or the Dock's layer policy.
      if (W.PATVPadPicker && W.PATVPadPicker.available && W.PATVPadPicker.available(data, o)) {
        menuItem(box, '🎞️', 'media', 'Stickers, GIFs and emoji', function (b) {
          W.PATVPadPicker.open({ data: data, slug: o.slug, relay: o.relay, signed: o.signed, linked: o.linked, root: activeRoot(), opener: b, closeLayer: closeLayer, sheet: sheet });
        });
      }
      var first = box.querySelector('button'); if (first) first.focus();
    }
    function participants(opener, after) {
      if (pip && !pip.closed) { W.focus(); toast(t('in_pad', 'Use this control in the pad tab.')); return; }
      external(function () {
        var box = sheet(t('participants', 'Participants'), opener), mark = D.createComment('side dock');
        layer.kind = 'participants';
        side.parentNode.insertBefore(mark, side); box.appendChild(side); side.classList.add('rmd-side-open');
        layer.restore = function () { side.classList.remove('rmd-side-open'); if (mark.parentNode) { mark.parentNode.insertBefore(side, mark); mark.remove(); } };
        if (typeof after === 'function') after();
      });
    }
    function decorateComposer() {
      if (!compose || !chat) return;
      compose.classList.add('rmd-composer');
      // Room audio remains usable even in the composer's signed-out / link-required states.
      var audioHost = node('rmAudioBox'); if (audioHost) chat.insertBefore(audioHost, compose);
      var audioRow = audioHost && audioHost.querySelector('.rb-audio');
      if (audioRow) {
        holderBox = el('div', 'rmd-holders'); audioRow.insertBefore(holderBox, audioRow.querySelector('.rb-mute')); mic(holders);
        each(audioRow.querySelectorAll('button'), function (b) { b.classList.add('ds-btn', 'quiet', 'sm'); });
        if (o.audio && o.audio.duck && o.ptt) {
          duck = button('🎙️', 'duck', 'Duck while recording', function () { duck.setAttribute('aria-pressed', String(o.audio.duck(!o.audio.duck()))); }, 'ds-btn quiet sm rmd-icon');
          duck.setAttribute('aria-pressed', 'false'); audioRow.appendChild(duck);
          if (/iP(hone|ad|od)/.test(W.navigator.userAgent || '') || W.navigator.platform === 'MacIntel' && W.navigator.maxTouchPoints > 1) {
            duck.disabled = true; duck.title = t('duck_ios', 'This device controls room volume with its hardware buttons.');
          }
          if (o.ptt.onRecording) o.ptt.onRecording(function (yes) { o.audio.setRecording(yes); });
        }
      }
      var input = o.relay && o.relay.getInput && o.relay.getInput();
      if (input) {
        input.classList.add('ds-in'); var form = input.closest('form'), wrap = input.closest('.rb-say-in');
        var row = el('div', 'rmd-input-row'), relayHost = node('rmRelay'); relayHost.parentNode.insertBefore(row, relayHost); row.appendChild(relayHost);
        extras = button('＋', 'extras', 'Add to the chat', function () { openExtras(extras); }, 'ds-btn ghost rmd-extras rmd-icon');
        extras.setAttribute('aria-haspopup', 'menu'); form.insertBefore(extras, wrap);
        var send = form.querySelector('.rb-send'); if (send) send.classList.add('ds-btn', 'primary');
        var ptt = node('rmPtt'); if (ptt) { row.appendChild(ptt); var talk = ptt.querySelector('.rb-talk'); if (talk) talk.classList.add('ds-btn', 'quiet'); }
        var secondary = el('div', 'rmd-composer-tools');
        if (node('rmSb')) secondary.appendChild(button('🔊', 'soundboard', 'Soundboard', soundboard));
        var say = button('🗣️', 'tts', 'Pepe says it', tts); say.setAttribute('data-rmd-tts', ''); secondary.appendChild(say);
        secondary.appendChild(button('⚡', 'apps', 'Chat apps', apps)); each(secondary.children, function (b) { b.classList.add('rmd-icon'); }); compose.appendChild(secondary);
      }
    }
    function update(d) {
      var previous = data; data = d || {}; if (!ready) return;
      if (o.mod && o.mod.closeMenu) {
        var personMenu = D.querySelector('.pm-pop'), login = personMenu && String(personMenu._login || '').toLowerCase();
        function namedMember(value) { return !!(login && value && Array.isArray(value.members) && value.members.some(function (u) { return u && !u.veil && !u.anon && String(u.login || '').toLowerCase() === login; })); }
        if ((data.removed && data.removed.length) || (data.redo && data.redo.length) || (namedMember(previous) && !namedMember(data))) o.mod.closeMenu(false);
      }
      if (layer && (layer.kind === 'tip' || layer.kind === 'tts' && (!hasCmd('!say') || layer.price !== cmds()['!say']))) closeLayer();
      each(root.querySelectorAll('[data-rmd-tts]'), function (b) { b.hidden = !hasCmd('!say'); });
      var topicEdit = chat && chat.querySelector('[data-rmd-topic]');
      if (topicEdit) {
        topicEdit.hidden = !o.canTopic || !o.canTopic();
        var topic = node('rmTopic'); if (topicEdit.hidden) { topic.removeAttribute('role'); topic.removeAttribute('tabindex'); }
        else { topic.setAttribute('role', 'button'); topic.tabIndex = 0; }
      }
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
    function start() {
      if (ready || dead) return;
      ready = true; stage = node('rmStage'); chat = node('rmChat'); strip = node('rmStrip'); compose = node('rmCompose');
      panel = node('padPanel-live'); template = node('rmdId'); bar = node('rmdBar'); drawer = node('rmdDrawer');
      side = root.querySelector('.rm-live > .side'); if (side) side.classList.add('rmd-side');
      if (side) { var story = root.querySelector('.rm-story'), peopleCard = node('rmPplCard'); if (story && peopleCard) peopleCard.insertAdjacentElement('afterend', story); }
      if (side && node('rmGoLive')) {
        var micCard = node('rmMicCard'); if (micCard) micCard.insertAdjacentElement('afterend', node('rmGoLive')); else side.insertBefore(node('rmGoLive'), side.firstChild);
        var slots = node('rmGoLive').querySelector('.slots'), schedule = node('rmSched');
        if (stage && (slots || schedule)) {
          var status = el('div', 'rmd-stage-status'); stage.parentNode.insertBefore(status, stage);
          if (slots) status.appendChild(slots);
          if (schedule) {
            status.appendChild(schedule);
            var scheduleButton = button('📅', 'schedule', 'Stage schedule', function (b) {
              external(function () {
                var box = sheet(t('schedule', 'Stage schedule'), b), mark = D.createComment('schedule dock');
                schedule.parentNode.insertBefore(mark, schedule); box.appendChild(schedule);
                layer.restore = function () { if (mark.parentNode) { mark.parentNode.insertBefore(schedule, mark); mark.remove(); } };
              });
            }, 'ds-btn quiet sm rmd-icon');
          }
        }
      }
      if (bar && drawer) {
        identity(bar);
        var handle = button(IC.hide, 'drawer', 'Pad header and tabs', function () { fold(!root.classList.contains('rmd-drawer-open')); }, 'ds-btn quiet rmd-drawer-toggle rmd-icon');
        handle.setAttribute('aria-controls', 'rmdDrawer'); handle.setAttribute('aria-expanded', 'false'); bar.appendChild(handle);
        function fold(open) {
          root.classList.toggle('rmd-drawer-open', open); handle.setAttribute('aria-expanded', String(open));
          var ic = handle.querySelector('.ds-ic'); if (ic) ic.textContent = open ? IC.fold : IC.hide;   // 1.99?? dockfu: 🔽 opens, 🔼 folds
        }
        on(bar, 'touchstart', function (e) { lastTouch = e.touches[0].clientY; }, false);
        on(bar, 'touchend', function (e) { if (lastTouch != null && e.changedTouches[0].clientY - lastTouch > 30) fold(true); lastTouch = null; });
        on(bar, 'wheel', function (e) { if (e.deltaY < -10) fold(true); });
      }
      if (stage) {
        var overlay = el('div', 'rmd-stage-overlay'); identity(overlay);
        tools = el('div', 'rmd-stage-tools');
        tools.appendChild(button(IC.hide, 'hide_stage', 'Hide stage', function () { hideStage(true); }));
        tools.appendChild(button(IC.full, 'fullscreen', 'Fullscreen', function () { full(stageMedia()); }));
        tools.appendChild(button(IC.pop, 'pop_stage', 'Pop out player', function () { pop(stageMedia(), false); }));
        if (scheduleButton) tools.appendChild(scheduleButton);
        if (node('rmGoLive') && side) tools.appendChild(button('🎬', 'stage_actions', 'Stage options', function (b) {
          participants(b, function () { var go = node('rmGoLive'); if (go.scrollIntoView) go.scrollIntoView({ block: 'nearest' }); var action = go.querySelector('button,a'); if (action) action.focus(); });
        }));
        each(tools.children, function (b) { b.classList.add('rmd-icon'); });
        overlay.appendChild(tools); stage.insertBefore(overlay, stage.firstChild);
        var oldHead = node('rmStageH'); if (oldHead) overlay.appendChild(oldHead);
        var tabs = node('rmTabs'); if (tabs) overlay.appendChild(tabs);
        var mini = el('div', 'rmd-mini'); mini.id = 'rmdMini'; mini.hidden = true; identity(mini);
        mini.appendChild(button('📺', 'restore_stage', 'Show stage', function () { hideStage(false); })); stage.parentNode.insertBefore(mini, stage);
        function showTools() { stage.classList.add('rmd-controls-on'); clearTimeout(autoTimer); autoTimer = setTimeout(function () { if (!stage.contains(stage.ownerDocument.activeElement)) stage.classList.remove('rmd-controls-on'); }, 2400); }
        on(stage, 'pointermove', showTools); on(stage, 'pointerdown', showTools); on(stage, 'focusin', showTools); showTools();
        on(stage, 'patv:stagechange', function (e) { stageChanged(e.detail); });
      }
      if (chat) {
        var head = el('div', 'rmd-chat-tools');
        if (side) head.appendChild(button('👥', 'participants', 'Participants', participants));
        head.appendChild(button(IC.pop, 'float_chat', 'Float chat', floatChat));
        head.appendChild(button(IC.pop, 'pop_chat', 'Pop out chat', function () { pop(chat, true); }));
        each(head.children, function (b) { b.classList.add('rmd-icon'); });
        var chatHeading = node('chatH'); if (chatHeading) chatHeading.appendChild(head); else chat.insertBefore(head, chat.firstChild);
        var topic = node('rmTopic'); if (topic && o.openTopic) {
          var topicRow = el('span', 'rmd-topic-line'); topic.parentNode.insertBefore(topicRow, topic); topicRow.appendChild(topic);
          if (chatHeading) chatHeading.appendChild(topicRow);
          var edit = button('✏️', 'topic', 'Edit topic', function (b) { if (!o.canTopic || !o.canTopic()) return; participants(b, o.openTopic); }, 'ds-btn quiet sm rmd-icon'); edit.setAttribute('data-rmd-topic', ''); topicRow.appendChild(edit);
          on(topic, 'click', function () { if (o.canTopic && o.canTopic()) participants(edit, o.openTopic); });
          on(topic, 'keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && o.canTopic && o.canTopic()) { e.preventDefault(); participants(edit, o.openTopic); } });
        }
      }
      if (strip) {
        var seg = el('div', 'ds-seg rmd-strip-layout'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('cam_layout', 'Cam layout'));
        var compactLayout = el('select', 'ds-select rmd-strip-select'); compactLayout.setAttribute('aria-label', t('cam_layout', 'Cam layout'));
        [['small', 'Small'], ['large', 'Large'], ['grid', 'Grid']].forEach(function (pair) {
          var b = button('', 'layout_' + pair[0], pair[1], function () {
            strip.setAttribute('data-rmd-layout', pair[0]); compactLayout.value = pair[0]; each(seg.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          }, 'ds-tab'); b.setAttribute('aria-pressed', String(pair[0] === 'small')); seg.appendChild(b);
          var option = el('option', null, t('layout_' + pair[0], pair[1])); option.value = pair[0]; compactLayout.appendChild(option);
        });
        on(compactLayout, 'change', function () { each(seg.children, function (b, i) { if (compactLayout.options[i].value === compactLayout.value) b.click(); }); });
        var stripHead = strip.querySelector('.cs-head');
        if (stripHead) { stripHead.insertBefore(seg, stripHead.firstChild); stripHead.insertBefore(compactLayout, seg); }
        else { strip.insertBefore(seg, strip.firstChild); strip.insertBefore(compactLayout, seg); }
        each(strip.querySelectorAll('.cs-hear,.cs-clear'), function (b) {
          var label = b.textContent; b.setAttribute('aria-label', label); b.title = label; b.classList.add('ds-btn', 'quiet', 'sm', 'rmd-icon'); b.textContent = '';
          var icon = el('span', 'ds-ic', b.classList.contains('cs-clear') ? '✕' : '🔊'); icon.setAttribute('aria-hidden', 'true'); b.appendChild(icon); b.appendChild(el('span', 'rmd-label', label));
        });
        strip.setAttribute('data-rmd-layout', 'small');
        if (W.MutationObserver) { observer = new W.MutationObserver(decorateCams); observer.observe(strip, { childList: true, subtree: true }); } decorateCams();
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
      destroy: function () { dead = true; redock(); returnCam(); closeLayer(false); if (observer) observer.disconnect(); clearTimeout(autoTimer); clearTimeout(toastTimer); listeners.forEach(function (x) { x[0].removeEventListener(x[1], x[2], x[3]); }); D.body.classList.remove('pad-dock-live'); }
    };
  }
  W.PATVPadDock = { init: init };
})(window, document);
