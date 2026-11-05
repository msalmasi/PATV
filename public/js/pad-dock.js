// The bridged pad's Dock moves existing widgets; it never requests or resolves room data.
// 1.99ajf dockclean: the owner's stripped-down Live view (hand-off 18 clean-up) - ONE stage card (the video + the pinned cams, an
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
  // 1.99ajh dockpop (owner: no icon with two meanings): 🪟 floats the chat in the page, ↗️ opens it in its own window, 🖼️ is the stage's
  // picture-in-picture, 🔽 / 🔼 hide / show the stage, 🖥️ is fullscreen (one toggle), › opens a page (the homepage's pad chip)
  // (1.99ajh dockpop review: 📽️ Watch on my stage - 📺 is the pad's Prime Time item in the pad menu)
  var IC = { hide: '🔽', show: '🔼', full: '🖥️', float: '🪟', win: '↗️', pip: '🖼️', back: '↩️', more: '⋯', down: '▾', open: '›', min: '➖', max: '➕', watch: '📽️' };
  var POP_GEO = 'patv.dock.popwin', ALIVE_MS = 5000, DEAD_MS = 15000, SLOW_DEAD_MS = 90000, PENDING_MS = 6000, HANDOFF_MS = 3000;
  // (1.99ajh dockpop review: a pad tab answers every heartbeat - "Back in the pad tab" only while one did within 12 s; LISTEN = the window
  // was playing the room when it reloaded: it picks it up again)
  var TAB_FRESH_MS = 12000, LISTEN_KEY = 'patv.dock.listen.', FOCUS_GAP_MS = 15000;
  // the icons the Dock's own controls use (a proxied menu item that brings one of them shows • instead: one meaning per icon)
  var DOCK_ICONS = Object.keys(IC).map(function (k) { return IC[k].replace(/\uFE0F/g, ''); }).concat(['📸', '🎬', '✂', '▶', '🎦', '⬇', '📅', '📜', '🔍', '👥', '🎚', '💬', '📌', '🎥', '🗓', '🎫', '🚀']);
  /** a proxied label's leading emoji (the Dock draws its own icon): "🎬 1/2 slots in use" -> "1/2 slots in use" */
  function noIcon(s) { try { return String(s || '').replace(/^(?:\p{Extended_Pictographic}\uFE0F?\s*)+/u, ''); } catch (e) { return String(s || ''); } }
  // 1.99ajf dockclean (owner point 17): the Apps sheet - the room's games and tools, each only when Pepe offers it here (d.room.cmds).
  // A tile puts the command into the composer (a trailing space where it takes a name / amount: the name autocomplete opens) and
  // never sends by itself.
  // (1.99ajq dockpol (owner item 26): 💲 Showdown STARTS the price game - !guess only joins a running one. The tile inserts '!showdown' where
  // Pepe's web relay offers it, else '!pricegame', the relay's allowed name for the same handler - and shows the one it inserts (appList);
  // !guess stays typeable)
  var APPS = [['!spin', '🎡', 'spin', 'Spin', 0], ['!heist', '💰', 'heist', 'Heist', 1], ['!duel', '⚔️', 'duel', 'Duel', 1], ['!brawl', '🥊', 'brawl', 'Brawl', 1],
    ['!arena', '🏟️', 'arena', 'Arena', 1], ['!bj', '🃏', 'bj', 'Blackjack', 1], ['!holdem', '♠️', 'holdem', 'Hold’em', 1], ['!pictionary', '🎨', 'pictionary', 'Pictionary', 0],
    ['!trivia', '❓', 'trivia', 'Trivia', 0], ['!pricegame', '💲', 'showdown', 'Showdown', 0], ['!bingo', '🎱', 'bingo', 'Bingo', 0], ['!lotto', '🎟️', 'lotto', 'Lotto', 1]];
  // 1.99ajq dockpol (owner item 29): 🎧 DJ - Pepe's music commands as tiles (each only when Pepe offers it here); a tile INSERTS, never sends.
  // [command, icon, key, words, trailing space]; STAFF ones only for Pepe's admins / owners of this room (data.mod - Pepe refuses others anyway)
  var DJ_APPS = [['!find', '🔎', 'dj_find', 'Find a song', 1], ['!play', '➕', 'dj_play', 'Request a song', 1], ['!np', '🎵', 'dj_np', 'Now playing', 0],
    ['!upnext', '📜', 'dj_upnext', 'Up next', 0], ['!skip', '⏭️', 'dj_skip', 'Vote skip', 0], ['!pause', '⏸️', 'dj_pause', 'Vote pause', 0],
    ['!resume', '▶️', 'dj_resume', 'Resume', 0], ['!remove', '↩️', 'dj_remove', 'Remove my last', 0]];
  var DJ_STAFF = [['!dj', '🤖', 'dj_on', 'Auto-DJ on', 0, '!dj on'], ['!dj', '🛑', 'dj_off', 'Auto-DJ off', 0, '!dj off'], ['!shuffle', '🔀', 'dj_shuffle', 'Shuffle', 0],
    ['!repeat', '🔁', 'dj_repeat', 'Repeat', 0], ['!vol', '🔊', 'dj_vol', 'Volume', 1]];
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
    // 1.99ajh dockpop: 'pad' (the pad page), 'popout' (the pad's chat in its own window, /p/<slug>/chat) or 'preview' (the homepage)
    var mode = o.mode === 'popout' || o.mode === 'preview' ? o.mode : 'pad';
    var nodes = o.nodes || {}, dead = false, ready = false, data = null, holders = [], listeners = [];
    var stage, chat, strip, compose, side, panel, template, holderBox, extras, toolRow, ovTop, ovBot, srcHost, srcBox, snapBtn, clipBtn, playBtn, nowBox;
    var current = null, layer = null, pip = null, pipPending = false, popGeneration = 0, localCam = null, stageHidden = false;
    // 1.99ajh dockpop: the chat in its own window - popped (this page's chat card is hidden in place while a window for this pad and account
    // is open), the window we opened (only while we hold it), the dock-link channel and its timers
    var popped = false, popPending = false, popWin = null, link = null, lastAlive = 0, lastAudio = 0, tabSeen = 0, popBar = null;
    var pendTimer = null, aliveTimer = null, handTimer = null, bringing = false, resumedInClick = false, gone_ = false, lastSlow = false;
    var autoTimer = null, toastTimer = null, observers = [], selected = null, stageRevision = 0, videoPipSource = null, overBar = false;
    var toolBtns = {}, peopleInput = null, pplBtn = null, chatMore = null, topicRow = null, slimText = null, setTopicBtn = null;
    var fullBtn = null, stageMoreBtn = null, showStageBtn = null, sizeSeg = null, sizeBtn = null, toastHost = null, talkLogins = {};
    // 1.99ajq dockpol (owner item 13): how the last layer was opened - a pointer (mouse / touch) or the keyboard
    var ptrAt = 0, keyAt = 0;
    function byPointer() { return ptrAt > keyAt && Date.now() - ptrAt < 2000; }
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
    // 1.99ajq dockpol (owner item 22): the CHAT card's notices - a small stack at the bottom of the log (above the audio bar, under the menus,
    // never over the composer; at most 2; role=status, polite). A command's state updates its own toast in place (waiting -> done after
    // 3 s, a refusal with its reason after 8 s); a sticky one stays until ✕. Hover or focus holds the timer. Memory only: nothing beyond
    // what the command list under the composer showed. The reveal notice (item 2) and Copied (item 6) use it too.
    var toasts = [], toastSr = null, srTimer = null;
    // (the log's "New messages ↓" pill steps up over the stack - never under a notice)
    // (1.99ajq dockpol fix (review): and the log makes room for the stack - its end padding grows by the stack's height, so a log at its
    // newest line still shows that line above a notice (room.ejs's pin re-pins when the box changes); a reader who scrolled up isn't moved)
    function paintToastH() {
      var j = node('rmJump'), sc = node('rmScroll'); if (!toastHost) return;
      var hgt = toasts.length ? toastHost.offsetHeight || 0 : 0;
      if (j) j.style.marginBlockEnd = hgt ? hgt + 4 + 'px' : '';
      if (sc && sc.closest && sc.closest('.rmd-log') === toastHost.parentNode) sc.style.paddingBlockEnd = hgt ? hgt + 12 + 'px' : '';
    }
    // (1.99ajq dockpol fix (review): the stack is in the chat card from the start, and what a screen reader hears is a separate polite live
    // region that only ever holds the notice's words - a region inserted with its first notice often isn't announced, and the ✕'s "Dismiss"
    // was read with every one)
    function toastBox() {
      var log = chat && chat.querySelector('.rmd-log'); if (!log) return null;
      if (!toastHost || toastHost.parentNode !== log) {
        toastHost = el('div', 'rmd-toasts', null, log.ownerDocument);
        log.appendChild(toastHost);
        toastSr = el('div', 'ds-sr-only rmd-toasts-sr', null, log.ownerDocument); toastSr.setAttribute('role', 'status'); toastSr.setAttribute('aria-live', 'polite');
        log.appendChild(toastSr);
      }
      return toastHost;
    }
    function announce(text) {
      if (!toastSr) return;
      clearTimeout(srTimer); toastSr.textContent = '';
      srTimer = setTimeout(function () { if (toastSr) toastSr.textContent = String(text || ''); }, 60);   // (cleared first: the same words twice are read twice)
    }
    function dropToast(rec) {
      clearTimeout(rec.timer); rec.timer = null;
      var i = toasts.indexOf(rec); if (i >= 0) toasts.splice(i, 1);
      var had = rec.node.contains(rec.node.ownerDocument.activeElement);
      if (rec.node.parentNode) rec.node.remove();
      if (had && o.relay && o.relay.getInput) { var inp = o.relay.getInput(); if (inp && inp.isConnected) { try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } } }
      paintToastH();
    }
    function armToast(rec) {
      clearTimeout(rec.timer); rec.timer = null;
      if (rec.sticky || rec.held || !(rec.ms > 0)) return;
      rec.timer = setTimeout(function () { dropToast(rec); }, rec.ms);
    }
    function chatToast(text, opts) {
      opts = opts || {};
      var host = toastBox(); if (!host) { toast(text); return null; }
      var doc = host.ownerDocument, rec = opts.id ? toasts.filter(function (x) { return x.id === opts.id; })[0] : null;
      if (!rec) {
        rec = { id: opts.id || null, timer: null, held: false, node: el('div', 'rmd-ct', null, doc) };
        rec.words = el('span', 'rmd-ct-t', null, doc); rec.node.appendChild(rec.words);
        rec.node.appendChild(iconBtn('✕', 'dismiss', 'Dismiss', function () { dropToast(rec); }, 'ds-btn ghost sm rmd-ct-x', doc));
        var hold = function (yes) { return function () { rec.held = yes; if (yes) { clearTimeout(rec.timer); rec.timer = null; } else armToast(rec); }; };
        on(rec.node, 'pointerenter', hold(true)); on(rec.node, 'pointerleave', hold(false)); on(rec.node, 'focusin', hold(true)); on(rec.node, 'focusout', hold(false));
        host.appendChild(rec.node); toasts.push(rec);
      }
      var was = rec.words.textContent;
      rec.words.textContent = String(text || '');
      rec.sticky = !!opts.sticky; rec.ms = opts.ms || 4000;
      rec.node.classList.toggle('rmd-ct-bad', !!opts.bad); rec.node.classList.toggle('rmd-ct-sticky', rec.sticky);
      // (1.99ajq dockpol fix (review): at most two passing notices; a STICKY one - Pepe's private answer while room PM is off - is never pushed
      // out by newer ones (it is content: it goes only with its ✕); the stack scrolls when they pile up, pad-dock.css)
      var passing = toasts.filter(function (x) { return !x.sticky && x !== rec; });
      while (passing.length > (rec.sticky ? 2 : 1)) dropToast(passing.shift());
      armToast(rec); paintToastH();
      if (was !== rec.words.textContent) announce(rec.words.textContent);
      return rec;
    }
    // a command from this composer (room-bridge.js opts.onCmd: {id, text, st, ok, replies}) - Pepe's private answers are content: with the
    // site's room PM on (main.rpm-on) they are lines in the log already (no toast repeats them); with it off each one is a sticky toast
    function cmdToast(row) {
      if (!row || !row.text) return;
      var rpmOn = root.classList.contains('rpm-on'), replies = Array.isArray(row.replies) ? row.replies.filter(Boolean) : [];
      var pending = row.ok == null && /…$/.test(String(row.st || ''));
      var st = row.st || (replies.length ? (rpmOn ? t('cmd_private', 'answered privately in the chat') : '') : t('cmd_done', 'done'));
      chatToast('› ' + row.text + (st ? ' · ' + st : ''), { id: 'cmd:' + row.id, ms: row.ok === false ? 8000 : pending ? 30000 : 3000, bad: row.ok === false });
      if (!rpmOn) replies.forEach(function (r, i) { chatToast('🔒 ' + r, { id: 'cmd:' + row.id + ':r' + i, sticky: true }); });
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
      paintFull();
      // (1.99ajh dockpop: the stage takes the freed height while the chat floats or is in its own window; body.rmd-afloat keeps a person
      // menu opened from the floating chat in its Dock look on Feed / About)
      var afloat = !!(current && current.kind === 'float');
      if (root) root.classList.toggle('rmd-chat-out', afloat || popped);
      D.body.classList.toggle('rmd-afloat', afloat);
    }
    function stageFull() { return !!(current && current.kind === 'full' && stage && current.host.contains(stage)); }
    function paintFull() {
      if (!fullBtn) return;
      var label = stageFull() ? t('exit_fullscreen', 'Exit fullscreen') : t('fullscreen', 'Fullscreen');
      fullBtn.querySelector('.rmd-label').textContent = label; fullBtn.title = label; fullBtn.setAttribute('aria-label', label);
    }
    function closeLayer(focus) {
      if (!layer) return;
      var old = layer; layer = null;
      if (old.restore) old.restore();
      old.host.remove();
      if (old.opener && old.opener.getAttribute && old.opener.getAttribute('aria-haspopup')) old.opener.setAttribute('aria-expanded', 'false');
      if (focus !== false && old.opener && old.opener.isConnected) quietFocus(old.opener, old.byPointer);
      if (old.overlay) showTools();
    }
    // 1.99ajq dockpol (owner item 13): a layer a pointer opened gives focus back to its opener WITHOUT the focus ring (data-rmd-quiet: the
    // ring would sit around a tapped tool after its sheet closed - outside the button, over the row's rule); the next key or a blur takes
    // the mark off, so a keyboard user's ring comes back at once. A keyboard-opened layer returns focus with the ring, as before.
    function quietFocus(n, quiet) {
      if (quiet && n.setAttribute) {
        n.setAttribute('data-rmd-quiet', '');
        var off = function () { n.removeAttribute('data-rmd-quiet'); n.removeEventListener('keydown', off); n.removeEventListener('blur', off); };
        n.addEventListener('keydown', off); n.addEventListener('blur', off);
      }
      try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); }
    }
    function sheet(title, opener, menuLike) {
      closeLayer(false);
      var place = activeRoot(), doc = place.ownerDocument, ptr = byPointer();
      var host = el('div', 'rmd-layer ds-scrim sheet', null, doc);
      var box = el('section', menuLike ? 'ds-modal rmd-menu' : 'ds-modal', null, doc);
      // (1.99ajq dockpol (owner item 27): one sheet header everywhere - the title on one line, ✕ an icon-only 36px button, both centred; a
      // title's leading emoji is its icon - aria-hidden, the words are the dialog's name)
      var words = noIcon(title), lead = String(title || '').slice(0, String(title || '').length - words.length).trim();
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', words || title); box.tabIndex = -1;
      var head = el('div', 'ds-modal-h rmd-sheet-h', null, doc), h2 = el('h2', null, null, doc);
      // (1.99ajq dockpol fix (review): the words are their own box - centred with the icon and the ✕ by their ink, not the pixel font's line box)
      if (lead) { var hi = el('span', 'ds-ic', lead, doc); hi.setAttribute('aria-hidden', 'true'); h2.appendChild(hi); h2.appendChild(doc.createTextNode(' ')); }
      h2.appendChild(el('span', 'rmd-sheet-t', words || title, doc)); head.appendChild(h2);
      head.appendChild(iconBtn('✕', 'close', 'Close', function () { closeLayer(); }, 'ds-btn ghost sm rmd-sheet-x', doc));
      box.appendChild(head); host.appendChild(box); place.appendChild(host);
      layer = { host: host, box: box, head: head, opener: opener || doc.activeElement, byPointer: ptr };
      on(host, 'click', function (e) { if (e.target === host && !foreignModal(doc)) closeLayer(); });
      // (a pointer-opened sheet starts on its box - or its main field - never on ✕ with a ring; Tab still goes to the first control)
      setTimeout(function () {
        if (!layer || layer.host !== host) return;
        var a = focusable(box), field = box.querySelector('input[type="search"], input[type="text"], textarea');
        if (ptr) { if (field && !field.hidden && field.getClientRects().length && box.contains(doc.activeElement) === false) field.focus(); else if (!box.contains(doc.activeElement)) { try { box.focus({ preventScroll: true }); } catch (e) { box.focus(); } } }
        else if (a[0] && !box.contains(doc.activeElement)) a[0].focus();
      }, 0);
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
      place.appendChild(box); layer = { host: box, box: box, opener: opener, kind: 'menu', byPointer: byPointer() };
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
        // (1.99ajq dockpol fix (review): an item that acts in place - Show real names, a cam size, Copy - gives focus back to the menu's opener
        // instead of dropping it on <body>; one that opens a sheet, a dialog or a page keeps whatever it focused)
        b = button(icon, key, label, function (bb, e) {
          var ptr = !!(e && e.detail > 0);
          if (!opts.keep) closeLayer(false); if (fn) fn(opener || b, e);
          var back = function () { var a = doc.activeElement; if (!opts.keep && !layer && opener && opener.isConnected && (!a || a === doc.body || !a.isConnected)) quietFocus(opener, ptr); };
          back(); setTimeout(back, 0);
        }, 'ds-menu-item', doc, opts.vars);
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
      // 1.99ajf dockclean review: a person menu / camera popup opened from the Participants sheet opens OVER it, next to its row (the
      // sheet stays: putting the card back first left the menu's anchor without a box below 1024px - the menu jumped to the corner)
      if (pip && e.currentTarget === pip.document) {
        e.preventDefault(); e.stopImmediatePropagation(); W.focus(); toast(t('in_pad', 'Use this control in the pad tab.')); return;
      }
      if (!D.fullscreenElement) return;
      e.preventDefault(); e.stopImmediatePropagation();
      external(function () { b.__rmdReplay = true; b.click(); b.__rmdReplay = false; });
    }
    // 1.99ajf dockclean review: a person menu (room-mod's .pm-pop, on <body>) or the camera popup opened from inside a Dock sheet (the
    // Participants list) sits over that sheet - it owns the keys and focus while it is open; the sheet stays where it was underneath
    function overSheet(doc, n) {
      var a = n || doc.activeElement;
      return !!(a && a.closest && a.closest('.pm-pop, .snap'));
    }
    function keydown(e) {
      var doc = e.currentTarget;
      if (foreignModal(doc) || overSheet(doc)) return;
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
      } else if (e.key === 'Escape' && current && current.kind === 'float' && current.host.contains(doc.activeElement)) {
        // (1.99ajh dockpop: only from inside the float - an Escape anywhere else on Feed / About never pulls the chat back)
        e.preventDefault(); floatBack();
      }
    }
    function trap(e) {
      if (!layer || layer.host.ownerDocument !== e.currentTarget || foreignModal(e.currentTarget) || layer.host.contains(e.target) || overSheet(e.currentTarget, e.target)) return;
      if (layer.host.classList.contains('ds-pop')) return;            // a menu loses focus quietly (the outside click closes it)
      var a = focusable(layer.box); if (a[0]) a[0].focus();
    }
    function attachDoc(doc) {
      on(doc, 'pointerdown', function () { ptrAt = Date.now(); }, true); on(doc, 'keydown', function () { keyAt = Date.now(); }, true);
      on(doc, 'keydown', keydown); on(doc, 'focusin', trap); on(doc, 'click', routeExternal, true);
      on(doc, 'click', function (e) { if (!proxying && layer && layer.host.classList.contains('ds-pop') && e.target.isConnected !== false && !layer.host.contains(e.target) && e.target !== layer.opener && !(layer.opener && layer.opener.contains(e.target))) closeLayer(false); });
    }
    // 1.99ajf dockclean review: a control clicked FOR a menu (Audio settings' ⏱️ switch clicks av-sync's own button) is not a click outside it
    var proxying = false;
    function proxyClick(n) { proxying = true; try { n.click(); } finally { proxying = false; } }
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
    // (bare: the floating chat's bar - a drag grip and ↩, no second pad identity: 1.99ajf dockclean review)
    function viewbar(host, close, bare) {
      var v = el('div', 'rmd-viewbar', null, host.ownerDocument);
      if (bare) { var g = el('span', 'rmd-grip', '⠿', host.ownerDocument); g.setAttribute('aria-hidden', 'true'); v.appendChild(g); v.appendChild(el('span', 'rmd-ov-gap', null, host.ownerDocument)); }
      else identity(v);
      var b = button(IC.back, 'redock', 'Bring it back', close || redock, 'ds-btn quiet sm', host.ownerDocument); b.setAttribute('data-rmd-back', '');
      v.appendChild(b); host.appendChild(v); return v;
    }
    function drag(host, handle, skip) {
      var start = null;
      function clamp() {
        if (skip && skip()) return;
        if (!host.style.insetInlineStart && !host.style.insetBlockStart) return;   // (never dragged: the stylesheet keeps it in view)
        var r = host.getBoundingClientRect(), maxX = Math.max(0, W.innerWidth - r.width), maxY = Math.max(58, W.innerHeight - r.height);
        var x = Math.max(0, Math.min(maxX, r.left)), y = Math.max(58, Math.min(maxY, r.top));
        host.style.insetInlineStart = (D.documentElement.dir === 'rtl' ? W.innerWidth - x - r.width : x) + 'px';
        host.style.insetBlockStart = y + 'px'; host.style.insetInlineEnd = 'auto'; host.style.insetBlockEnd = 'auto';
      }
      on(handle, 'pointerdown', function (e) {
        if (e.button !== 0 || e.target.closest('button,a,input') || (skip && skip())) return;
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
      // (1.99ajh dockpop review: only a drag that started pins the panel - a tap on ➖ / ↩️ in the bar used to clamp it to inline insets,
      // and on a phone the float lost its 8px gutter after Minimize / Expand)
      on(handle, 'pointerup', function () { if (!start) return; start = null; clamp(); }); on(W, 'resize', clamp);
      // 1.99aiw review: the panel's window listener goes with the panel (redock), not one more per float
      return function () { W.removeEventListener('resize', clamp, false); listeners = listeners.filter(function (x) { return x[2] !== clamp; }); };
    }
    // 1.99ajh dockpop (owner P1): the floating chat stays over Feed and About (tabChanged no longer redocks it). Its bar:
    // [⠿][💬 Chat + a new-lines dot, while minimized][…][➖ Minimize | ➕ Expand][↩️ Bring it back] - ↩️ on Feed / About also shows Live,
    // the chat's docked place (it would vanish into the hidden panel with the audio still playing). Minimized it is the 44px bar alone:
    // #rmChat stays in it (display: none), so the audio keeps playing and the lines keep coming, with no remount.
    var floatMin = false;
    function floatBack() {
      var onLive = !panel || !panel.hidden; redock();
      if (!onLive) { var lt = tabButton('live'); if (lt) lt.click(); }
      // (1.99ajh dockpop review: focus lands on the chat's ⋯ - the menu item that floated it is gone, and Escape left it on <body>)
      if (chatMore && chatMore.isConnected) chatMore.focus();
    }
    function floatChat() {
      if (!chat || popped) return; redock();
      var host = el('section', 'rmd-float'); root.appendChild(host);
      var head = el('div', 'rmd-viewbar'), g = el('span', 'rmd-grip', '⠿'); g.setAttribute('aria-hidden', 'true'); head.appendChild(g);
      var title = el('span', 'rmd-float-t'), ti = el('span', 'ds-ic', '💬'); ti.setAttribute('aria-hidden', 'true'); title.appendChild(ti);
      title.appendChild(el('span', 'rmd-float-tl', t('float_bar', 'Chat')));
      var dot = el('span', 'rmd-float-dot'); dot.hidden = true; dot.setAttribute('aria-label', t('float_new', 'New lines')); dot.setAttribute('role', 'img'); title.appendChild(dot);
      head.appendChild(title); head.appendChild(el('span', 'rmd-ov-gap'));
      var minBtn = iconBtn(IC.min, 'float_min', 'Minimize', function () { setMin(!host.classList.contains('rmd-min')); }, 'ds-btn quiet sm rmd-float-min');
      head.appendChild(minBtn);
      var back = button(IC.back, 'redock', 'Bring it back', floatBack, 'ds-btn quiet sm'); back.setAttribute('data-rmd-back', ''); head.appendChild(back);
      host.appendChild(head);
      current = { kind: 'float', host: host, moves: [], focus: D.activeElement };
      var away = movable(chat, host, t('chat_floating', 'Chat is floating over the page.')); away.mark.classList.add('rmd-ph-float');
      var awayBtn = away.mark.querySelector('button'); if (awayBtn) awayBtn.hidden = true;     // (the floating window's own ↩ is the one way back)
      current.moves.push(away);
      var undrag = drag(host, head, function () { return host.classList.contains('rmd-min'); }), feedObs = null, wasEnd = true, saved = null;
      var feedN = node('rmFeed'), scrollN = node('rmScroll');
      if (feedN && W.MutationObserver) { feedObs = new W.MutationObserver(function () { if (host.classList.contains('rmd-min')) dot.hidden = false; }); feedObs.observe(feedN, { childList: true }); }
      function setMin(on) {
        on = !!on; floatMin = on;
        if (on && scrollN) wasEnd = scrollN.scrollHeight - scrollN.scrollTop - scrollN.clientHeight < 80;
        if (on) { saved = host.getAttribute('style'); host.removeAttribute('style'); }      // (minimized: the bar's own corner, pad-dock.css)
        else if (saved != null) { host.setAttribute('style', saved); saved = null; }
        host.classList.toggle('rmd-min', on);
        var label = on ? t('float_max', 'Expand') : t('float_min', 'Minimize');
        minBtn.querySelector('.ds-ic').textContent = on ? IC.max : IC.min; minBtn.querySelector('.rmd-label').textContent = label;
        minBtn.title = label; minBtn.setAttribute('aria-label', label); minBtn.setAttribute('aria-expanded', String(!on));
        if (!on) { dot.hidden = true; if (wasEnd && typeof o.toBottom === 'function') o.toBottom(); }
        changed();
      }
      minBtn.setAttribute('aria-expanded', 'true');
      current.cleanup = function () { undrag(); if (feedObs) feedObs.disconnect(); };
      current.setMin = setMin;
      if (floatMin) setMin(true); else changed();
    }
    function full(n) {
      redock(); if (!n) return;
      var host = el('section', 'rmd-fullscreen'); root.appendChild(host);
      var head = viewbar(host), media = el('div', 'rmd-full-media' + (n.classList.contains('cs-tile') ? ' cam-strip' : ''));
      if (n === stage) { var bk = head.querySelector('[data-rmd-back]'); if (bk) bk.hidden = true; }    // (the overlay's 🖥️ Exit fullscreen is the way out)
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
      toggle.setAttribute('aria-pressed', 'false'); toggle.setAttribute('data-rmd-showchat', '');
      if (popped || !chat) toggle.hidden = true;     // (1.99ajh dockpop: the chat is in its own window - nothing to show here)
      head.appendChild(toggle); changed();
      if (!host.requestFullscreen) { redock(); toast(t('fullscreen_unavailable', 'Fullscreen is unavailable in this browser.')); return; }
      try { Promise.resolve(host.requestFullscreen()).catch(function () { redock(); toast(t('fullscreen_unavailable', 'Fullscreen is unavailable in this browser.')); }); }
      catch (e) { redock(); toast(t('fullscreen_unavailable', 'Fullscreen is unavailable in this browser.')); }
    }
    function stageMedia() { return localCam ? localCam.host : stage; }
    // 1.99ajh dockpop: 🖼️ Picture-in-picture is the STAGE's only (Document PiP where the browser has it, else the video's own PiP for the
    // pad's stream or Pepe's - never the 🎙 mic stage). The chat's Document PiP is gone: it closed with its opener, so it couldn't follow
    // the viewer around the site - ↗️ Chat in its own window does (popWindow). A PiP survives Live / Feed / About; it closes on pagehide.
    // 1.99ajq dockpol (owner item 17): a pinned cam pops out too (its tile ⋯) - with Document PiP the SAME tile node (its video, its WHEP
    // session, its frog-name label) moves to the window, no new ticket or slot; without it, that tile's own <video> goes picture-in-picture
    // and the tile stays in the strip. One at a time (a new pop replaces the old); the cam ending or ✕ closes it.
    function camPipApi(tile) {
      var v = tile && tile.querySelector && tile.querySelector('video');
      return !!((W.documentPictureInPicture && W.documentPictureInPicture.requestWindow) || (v && (v.requestPictureInPicture || v.webkitSetPresentationMode)));
    }
    function popVideo(v) {
      if (!v) { toast(t('pip_unavailable', 'Picture-in-picture isn’t available for this player.')); return; }
      try {
        if (v.requestPictureInPicture) Promise.resolve(v.requestPictureInPicture()).catch(function () { toast(t('pip_unavailable', 'Picture-in-picture isn’t available for this player.')); });
        else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode('picture-in-picture');
        else toast(t('pip_unavailable', 'Picture-in-picture isn’t available for this player.'));
      } catch (e) { toast(t('pip_unavailable', 'Picture-in-picture isn’t available for this player.')); }
    }
    function pop(n) {
      if (!n || pipPending) return;
      redock();
      var camTile = !!(n.classList && n.classList.contains('cs-tile'));
      if (camTile && (!W.documentPictureInPicture || !W.documentPictureInPicture.requestWindow)) { popVideo(n.querySelector('video')); return; }
      if (!W.documentPictureInPicture || !W.documentPictureInPicture.requestWindow) {
        var sel = o.stage && o.stage.selection ? o.stage.selection() : null;
        var video = stage && stage.querySelector('video');
        if (!localCam && sel && !sel.embed && sel.stream !== 'mic' && !(o.stage && o.stage.view && o.stage.view() === 'mic') && video && video.requestPictureInPicture) {
          var nativeGeneration = ++popGeneration, nativeRevision = stageRevision, nativeSource = JSON.stringify(sel);
          pipPending = true;
          try { Promise.resolve(video.requestPictureInPicture()).then(function () {
            pipPending = false;
            var now = o.stage && o.stage.selection ? o.stage.selection() : selected;
            if (dead || nativeGeneration !== popGeneration || nativeRevision !== stageRevision || nativeSource !== JSON.stringify(now) || localCam) {
              if (D.pictureInPictureElement === video && D.exitPictureInPicture) Promise.resolve(D.exitPictureInPicture()).catch(function () {});
              return;
            }
            videoPipSource = nativeSource;
          }).catch(function () { pipPending = false; if (nativeGeneration === popGeneration) toast(t('pip_unavailable', 'Picture-in-picture isn’t available for this player.')); }); }
          catch (e) { pipPending = false; toast(t('pip_unavailable', 'Picture-in-picture isn’t available for this player.')); }
        } else toast(t('pip_unavailable', 'Picture-in-picture isn’t available for this player.'));
        return;
      }
      pipPending = true;
      var requestGeneration = ++popGeneration;
      W.documentPictureInPicture.requestWindow({ width: 760, height: 520 }).then(function (win) {
        pipPending = false;
        if (dead || requestGeneration !== popGeneration) { win.close(); return; }
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
        current.moves.push(movable(n, main, camTile ? t('cam_pip', 'This cam is in picture-in-picture.') : t('stage_pip', 'The player is in picture-in-picture.')));
        on(win, 'pagehide', redock); on(doc, 'visibilitychange', changed); changed();
        // (a popped cam that ends - closed, or the strip let it go - takes its window with it)
        // (1.99ajq dockpol fix (review): ...and so does one whose session ENDED in place - the strip keeps that tile, "off" with ↻ Retry, which
        // is the strip's to offer: the window closes and the tile goes back to it)
        if (camTile && W.MutationObserver) {
          var ended = function () { var ov = n.querySelector('.cs-over'), rt = ov && ov.querySelector('button'); return !n.querySelector('.cs-badge.on') && !!ov && !ov.hidden && !!rt && !rt.hidden; };
          try { var gone = new W.MutationObserver(function () { if (pip === win && (!main.contains(n) || ended())) { gone.disconnect(); redock(); } }); gone.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] }); observers.push(gone); } catch (e) { /* no observer across windows */ }
        }
      }).catch(function () { pipPending = false; toast(t('pip_unavailable', 'Picture-in-picture isn’t available for this player.')); });
    }
    function hideStage(onOff, focus) {
      if (!stage) return; if (current) redock();
      stageHidden = !!onOff;
      root.classList.toggle('rmd-stage-hidden', stageHidden);
      var mini = node('rmdMini'); if (mini) mini.hidden = !stageHidden;
      changed();
      // (1.99ajf dockclean review: focus follows - onto 📺 Show stage, or back to the stage's ⋯)
      if (focus) { var f = stageHidden ? showStageBtn : stageMoreBtn; if (f && f.isConnected) f.focus(); }
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
      head.appendChild(iconBtn(IC.hide, 'hide_stage', 'Hide stage', function () { hideStage(true, true); }));
      head.appendChild(iconBtn(IC.pip, 'pip_stage', 'Picture-in-picture', function () { pop(host); }));
      localCam = { host: host, move: movable(tile, host, t('cam_stage', 'This cam is on your stage.')) };
      // This placeholder returns the local swap rather than redocking an unrelated surface.
      var rb = localCam.move.mark.querySelector('button'); rb.replaceWith(button(IC.back, 'return_cam', 'Return cam to strip', returnCam));
      var close = tile.querySelector('.cs-x'); if (close) on(close, 'click', function () { setTimeout(function () { if (localCam && localCam.move.node === tile && !tile.parentNode) returnCam(); }, 0); });
      root.classList.add('rmd-local-cam'); changed();
    }
    // 1.99ajf dockclean (owner point 28): a pinned cam is the clean video + its name; ONE ⋯ per tile (Watch on my stage, Fullscreen,
    // Cam options, Close). A click on the video watches it on the viewer's own stage. The tile's own ⤢ / ✕ and ⚡ LIVE badge are hidden
    // (pad-dock.css); ✕ Close and the failure overlay's ↻ Retry / ▶ Tap to play are the strip's own buttons.
    function tileMenu(tile, opener) {
      var box = menu(opener, t('cam_menu', 'Cam options'));
      menuItem(box, IC.watch, 'watch_cam', 'Watch on my stage', function () { watchCam(tile); });
      menuItem(box, IC.full, 'fullscreen', 'Fullscreen', function () { full(tile); });
      if (camPipApi(tile)) menuItem(box, IC.pip, 'pop_cam', 'Pop out (picture-in-picture)', function () { pop(tile); });
      var who = tileWho(tile);
      if (who && o.openCam) menuItem(box, '📷', 'cam_options', 'Cam options…', function () { external(function () { if (opener && opener.isConnected) opener.focus(); o.openCam(who); }); });
      var x = tile.querySelector('.cs-x');
      if (x) menuItem(box, '✕', 'close_cam', 'Close (frees the slot)', function () { external(function () { x.click(); }); });
      finishMenu(box, opener);
    }
    // 1.99ajf dockclean review: the person behind a pinned cam - the strip's own reference (pad-camstrip.js: a login, or a frog-name
    // cam's opaque id; never more) matched against the room as it is NOW, so the camera popup opens for someone who is still here
    // and as the roster shows them (a frog name stays a frog name)
    function tileWho(tile) {
      var ref = tile && tile._who; if (!ref) return null;
      var low = ref.login ? String(ref.login).toLowerCase() : null, hit = null;
      [data && data.mic, data && data.members].forEach(function (list) {
        (list || []).forEach(function (m) {
          if (hit || !m) return;
          if (low && !m.anon && !m.veil && String(m.login || '').toLowerCase() === low) hit = m;
          else if (!low && ref.id && m.id === ref.id && m.veil === 'incognito') hit = m;
        });
      });
      return hit;
    }
    // 1.99ajq dockpol (owner item 15): the cam strip's size is a visible control again - [S][M][L][▦] at the end of the cam row, while cams
    // are pinned - and the choice is remembered for this viewer (localStorage; default Small). Stage ⋯ › Pinned cams mirrors it.
    var PIN_SIZES = [['small', 'S', 'Small'], ['medium', 'M', 'Medium'], ['large', 'L', 'Large'], ['grid', '▦', 'Grid']], PIN_KEY = 'patv.dock.pins';
    function pinSize(v) {
      if (v === undefined) { var s = strip && strip.getAttribute('data-rmd-layout'); return s || 'small'; }
      if (!PIN_SIZES.some(function (p) { return p[0] === v; })) v = 'small';
      if (strip) strip.setAttribute('data-rmd-layout', v);
      root.setAttribute('data-rmd-pins', v);
      store(PIN_KEY, v);
      paintPinSize();
      return v;
    }
    function paintPinSize() {
      if (!sizeSeg) return; var now = pinSize();
      each(sizeSeg.querySelectorAll('button'), function (b) { var on = b.getAttribute('data-size') === now; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      if (sizeBtn) {
        var p = PIN_SIZES.filter(function (x) { return x[0] === now; })[0] || PIN_SIZES[0], label = t('cam_size_now', 'Cam size: {size}', { size: t('layout_' + p[0], p[2]) });
        sizeBtn.querySelector('.rmd-label').textContent = p[1]; sizeBtn.title = label; sizeBtn.setAttribute('aria-label', label);
      }
    }
    function buildSizeSeg() {
      if (!strip || sizeSeg) return;
      sizeSeg = el('div', 'ds-seg rmd-pin-size'); sizeSeg.setAttribute('role', 'radiogroup'); sizeSeg.setAttribute('aria-label', t('cam_size', 'Cam size'));
      PIN_SIZES.forEach(function (p, i) {
        var b = el('button', 'ds-tab rmd-pin-sz', p[1]); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('data-size', p[0]);
        var label = t('layout_' + p[0], p[2]); b.setAttribute('aria-label', label); b.title = label;
        on(b, 'click', function () { pinSize(p[0]); });
        on(b, 'keydown', function (e) {
          var k = e.key, d = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0; if (!d) return;
          if (D.documentElement.dir === 'rtl' && (k === 'ArrowRight' || k === 'ArrowLeft')) d = -d;
          e.preventDefault(); var n = PIN_SIZES[(i + d + PIN_SIZES.length) % PIN_SIZES.length][0]; pinSize(n);
          var nb = sizeSeg.querySelector('[data-size="' + n + '"]'); if (nb) nb.focus();
        });
        sizeSeg.appendChild(b);
      });
      strip.appendChild(sizeSeg);
      // (1.99ajq dockpol fix (review): a phone's cam row is 64px - four 44px radios don't fit beside it, so there it is ONE button showing
      // the size, opening the same four as a menu; pad-dock.css shows one or the other)
      sizeBtn = button('', 'cam_size', 'Cam size', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } sizeMenu(b); }, 'ds-btn quiet sm rmd-pin-menu');
      sizeBtn.setAttribute('aria-haspopup', 'menu'); sizeBtn.setAttribute('aria-expanded', 'false');
      strip.appendChild(sizeBtn);
      pinSize(store(PIN_KEY) || 'small');
    }
    function sizeMenu(opener) {
      var box = menu(opener, t('cam_size', 'Cam size')), now = pinSize();
      PIN_SIZES.forEach(function (p) { menuItem(box, p[1], 'layout_' + p[0], p[2], function () { pinSize(p[0]); }, { role: 'menuitemradio', checked: now === p[0] }); });
      finishMenu(box, opener);
    }
    function decorateCams() {
      if (!strip) return;
      buildSizeSeg();
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
    function personLine(n, u, it) {
      // 1.99ajn padppl: a veiled chat line (a frog name, not the viewer's own) opens the person menu too - by its row c (🚫 Block, bans)
      var vc = u && u.anon && (u.veil === 'incognito' || u.veil === 'hidden') && it && it.c && it.self !== 1 && !it.mask && o.signed ? Number(it.c) : 0;
      if (!vc && (!n || !u || u.veil || u.anon || u.self || !u.login)) return;
      if (!n || !o.openPerson || !n.querySelector || !(o.signed || o.mod && o.mod.active && o.mod.active())) return;
      var who = n.querySelector('.who'); if (!who || who.__rmdPerson) return;
      who.__rmdPerson = true;
      function open(e) {
        if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button > 0)) return;
        if (e) e.preventDefault(); external(function () { o.openPerson(u, who, false, undefined, vc || (it && it.c) || null); });
      }
      if (who.tagName !== 'A') { who.tabIndex = 0; who.setAttribute('role', 'button'); }
      on(who, 'click', open); on(who, 'keydown', function (e) { if (e.key === 'Enter' || (e.key === ' ' && who.tagName !== 'A')) open(e); });
    }
    var holderKey = null;
    function narrow() { return !!(W.matchMedia && W.matchMedia('(max-width: 1023px)').matches); }
    function mic(list) {
      holders = Array.isArray(list) ? list : []; if (!holderBox || !o.person) return;
      var max = narrow() || mode !== 'pad' ? 1 : 2;      // (1.99ajh dockpop: the homepage's and the window's chat cards are narrow)
      // 1.99aiw review: redraw only when the holders change - a rebuild restarted animated name styles and dropped keyboard focus
      var key = null;
      try { key = JSON.stringify(holders) + '|' + max + '|' + (o.signed ? 1 : 0) + (o.mod && o.mod.active && o.mod.active() ? 1 : 0); } catch (e) { key = null; }
      if (key !== null && key === holderKey) return;
      holderKey = key;
      holderBox.textContent = '';
      // 1.99ajq dockpol (owner items 5, 21): a holder chip is [🎙][avatar][name + flair] at every width (the 🎙 is the "on the mic" sign phones
      // lost with the On the mic card; the bar's eq meter is off on iOS and while paused); the flair shows whole when there is room, and
      // talking() rings the avatar of the one the mic stage says is talking now. Veiled holders: a static 🎙, no flair, never a ring.
      holders.slice(0, max).forEach(function (u) {
        var chip = el('span', 'rmd-holder'), b = el('span', 'rmd-mic-b', '🎙'); b.setAttribute('aria-hidden', 'true'); chip.appendChild(b);
        var content = o.person(u, { flair: !(u && (u.veil || u.anon)) }); if (content) chip.appendChild(content);
        chip.appendChild(el('span', 'ds-sr-only', ' ' + t('on_mic_aria', 'on the mic')));
        chip._login = u && !u.veil && !u.anon && u.login ? String(u.login).toLowerCase() : null;
        holderBox.appendChild(chip); personLine(chip, u);
      });
      paintTalking(); fitSoon(holderBox);
      if (holders.length > max) {
        var more = button('', 'more_holders', 'More people on the mic', participants, 'ds-btn quiet sm rmd-holder-more');
        more.querySelector('.rmd-label').textContent = '+' + (holders.length - max); more.title = t('plus_on_mic', '+{n} on mic', { n: holders.length - max }); holderBox.appendChild(more);
      }
      holderBox.hidden = !holders.length;
      if (nowBox) nowBox.classList.toggle('rmd-has-holders', !!holders.length);
      paintNow();
    }
    // 1.99ajq dockpol fix (review, items 20 / 21): a flair shows its words WHOLE where they fit - or, where they would be cut to a letter or two
    // ("💚 S", "📼 P" - Plex or Plus?), its emoji alone in a 22px disc (the name in its title and for screen readers). People rows, the
    // holder chips and the line heads; again when their box changes width (one pass per frame, measured before anything is changed).
    var FLAIR_SEL = '#rmPeople .nm > .ufl, .rmd-holders .rmd-person-name > .ufl, .rmd-log .line-head > .ufl', fitQ = null, fitW = [];
    function fitSoon(n) {
      var first = !fitQ; fitQ = fitQ || [];
      if (fitQ.indexOf(n || D) < 0) fitQ.push(n || D);
      if (first) (W.requestAnimationFrame || setTimeout)(function () { var q = fitQ; fitQ = null; if (!dead) fitFlairs(q.indexOf(D) >= 0 ? [D] : q); });
    }
    function fitFlairs(scopes) {
      var list = [];
      scopes.forEach(function (s) {
        if (!s || !s.querySelectorAll) return;
        if (s.matches && s.matches(FLAIR_SEL)) list.push(s);
        each(s.querySelectorAll(FLAIR_SEL), function (f) { list.push(f); });
      });
      var words = list.map(function (f) { f.classList.remove('rmd-ufl-e', 'rmd-ufl-off'); var n = null; each(f.children, function (c) { if (c.classList.contains('ufl-n')) n = c; }); return n; });
      var cut = words.map(function (n) {
        if (!n || !n.getClientRects().length) return false;              // (no words, or a narrow line's rule already hides them)
        var cw = n.clientWidth, sw = n.scrollWidth;
        return sw > cw + 1 && (sw < 72 || cw < 48);                     // (a short word - Plus, Plex, Supporter - whole or not at all)
      });
      list.forEach(function (f, i) { if (cut[i]) f.classList.add('rmd-ufl-e'); });
      // (a holder chip in the bottom bar: the SPEAKER's name first - where even the emoji would cut it ("Aster …"), the flair steps out)
      var hold = list.filter(function (f) { return f.parentNode && f.parentNode.closest && f.parentNode.closest('.rmd-holders'); });
      var off = hold.map(function (f) { var w = f.parentNode.querySelector('.who'); return !!(w && w.getClientRects().length && w.scrollWidth > w.clientWidth + 1); });
      hold.forEach(function (f, i) { if (off[i]) f.classList.add('rmd-ufl-off'); });
    }
    function fitOnResize(n) {
      if (!n || !W.ResizeObserver) return;
      var ro = new W.ResizeObserver(function () { var w = n.clientWidth, i = fitW.indexOf(n); if (i >= 0 && fitW[i + 1] === w) return; if (i >= 0) fitW[i + 1] = w; else fitW.push(n, w); fitSoon(n); });
      ro.observe(n); observers.push(ro);
    }
    /** the mic stage's program as the viewer gets it (A/V-gated, the same one the stage draws): who is talking NOW (src[].ring) */
    function talking(p) {
      var now = {};
      (p && Array.isArray(p.src) ? p.src : []).forEach(function (s) { if (s && s.ring && s.login && s.kind !== 'cover' && !s.veil) now[String(s.login).toLowerCase()] = 1; });
      talkLogins = now; paintTalking();
    }
    function paintTalking() {
      if (!holderBox) return;
      each(holderBox.children, function (c) { if (c.classList && c.classList.contains('rmd-holder')) c.classList.toggle('rmd-talking', !!(c._login && talkLogins[c._login])); });
    }
    function cmds() { return data && data.room && data.room.cmds || {}; }
    function hasCmd(k) { return !!o.linked && Object.prototype.hasOwnProperty.call(cmds(), k); }

    // ── 🗣️ Say it (owner point 13: a voice selector; the voices are the site's own GET /api/voices, loaded by pad-picker.js) ──
    function tts(opener) {
      if (!hasCmd('!say') || !o.relay || !o.relay.sendCmd) return;
      var box = sheet(t('tts_title', '🗣️ Pepe says it'), opener), doc = box.ownerDocument;
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
    // (1.99ajq dockpol fix (review, item 26): the 💲 Showdown tile shows the command it puts in the composer - '!showdown' once Pepe's web relay
    // offers that name (it lists exactly what it lets through), until then '!pricegame', the same game's allowed alias)
    function appList() {
      return APPS.map(function (a) {
        if (a[2] !== 'showdown') return hasCmd(a[0]) ? a : null;
        var c = hasCmd('!showdown') ? '!showdown' : hasCmd('!pricegame') ? '!pricegame' : null;
        return c ? [c, a[1], a[2], a[3], a[4]] : null;
      }).filter(Boolean);
    }
    function musicOn() { return ['!find', '!play', '!np', '!skip'].some(hasCmd); }
    // Pepe's admins / owners of this room (his roles for this viewer's login, data.mod) - Pepe still refuses anyone else
    function djStaff() { var m = data && data.mod; return !!(m && (m.admin === true || (Array.isArray(m.roles) && m.roles.some(function (r) { return r === 'admin' || r === 'owner'; })))); }
    /** an app tile: icon, name, the command (+ price) - a tap puts the command in the composer and never sends */
    function appTile(grid, a, doc, after) {
      var b = el('button', 'ds-btn quiet rmd-app', null, doc); b.type = 'button';
      var ic = el('span', 'ds-ic', a[1], doc); ic.setAttribute('aria-hidden', 'true'); b.appendChild(ic);
      var name = t(a[2].indexOf('dj_') === 0 ? a[2] : 'app_' + a[2], a[3]), shownCmd = a[5] || a[0];
      b.appendChild(el('span', 'rmd-app-n', name, doc));
      var p = priceText(cmds()[a[0]]); b.appendChild(el('small', 'rmd-app-p', shownCmd + (p ? ' · ' + p : ''), doc));
      b.setAttribute('aria-label', name + ' (' + shownCmd + ')' + (p ? ', ' + p : ''));
      on(b, 'click', function () { closeLayer(false); insertCmd(a[2].indexOf('dj_') === 0 && a[5] ? a[5] : a[0], !!a[4]); if (after) after(); });
      grid.appendChild(b); return b;
    }
    function apps(opener) {
      var box = sheet(t('apps_title', '⚡ Chat apps'), opener), doc = box.ownerDocument;
      layer.kind = 'apps';
      var list = appList();
      if (list.length) {
        box.appendChild(el('p', 'ds-eyebrow rmd-apps-h', t('apps_games', 'Games'), doc));
        var grid = el('div', 'rmd-apps', null, doc);
        list.forEach(function (a) { appTile(grid, a, doc); });
        box.appendChild(grid);
      }
      // (1.99ajq dockpol (owner item 29): ONE 🎧 DJ tile - the booth and Pepe's music commands live in its sheet; one icon, one meaning)
      if ((musicOn() || dj()) && !inPip()) {
        box.appendChild(el('p', 'ds-eyebrow rmd-apps-h', t('apps_music', 'Music'), doc));
        var g2 = el('div', 'rmd-apps', null, doc), b2 = el('button', 'ds-btn quiet rmd-app', null, doc); b2.type = 'button';
        var ic2 = el('span', 'ds-ic', '🎧', doc); ic2.setAttribute('aria-hidden', 'true'); b2.appendChild(ic2); b2.appendChild(el('span', 'rmd-app-n', t('app_dj_tile', 'DJ'), doc));
        b2.appendChild(el('small', 'rmd-app-p', t('app_dj_sub', 'songs, queue, skip'), doc));
        b2.setAttribute('aria-label', t('app_dj_tile', 'DJ'));
        on(b2, 'click', function () { djSheet(opener); }); g2.appendChild(b2); box.appendChild(g2);
      }
      box.appendChild(el('p', 'ds-fine rmd-apps-f', t('apps_more', 'Type ! in the chat for every command'), doc));
    }
    function djSheet(opener) {
      var box = sheet(t('dj_title', '🎧 DJ'), opener), doc = box.ownerDocument, booth = dj();
      layer.kind = 'dj';
      var back = button('‹', 'dj_back', 'Back to chat apps', function () { apps(opener); }, 'ds-btn quiet sm rmd-sheet-back', doc);
      back.querySelector('.rmd-label').textContent = t('dj_back_short', 'Chat apps');
      box.insertBefore(back, layer.head.nextSibling);
      if (booth) {
        var mark = booth.ownerDocument.createComment('dock dj'); booth.parentNode.insertBefore(mark, booth); box.appendChild(booth); booth.classList.add('rmd-in-sheet');
        layer.restore = function () { booth.classList.remove('rmd-in-sheet'); if (mark.parentNode) { mark.parentNode.insertBefore(booth, mark); mark.remove(); } };
      } else box.appendChild(el('p', 'ds-fine rmd-dj-idle', t('dj_idle', 'No music in this room right now'), doc));
      var list = DJ_APPS.filter(function (a) { return hasCmd(a[0]); });
      if (list.length) { var grid = el('div', 'rmd-apps', null, doc); list.forEach(function (a) { appTile(grid, a, doc); }); box.appendChild(grid); }
      var staffList = djStaff() ? DJ_STAFF.filter(function (a) { return hasCmd(a[0]); }) : [];
      if (staffList.length) {
        box.appendChild(el('p', 'ds-eyebrow rmd-apps-h', t('g_staff', 'Staff'), doc));
        var g3 = el('div', 'rmd-apps', null, doc); staffList.forEach(function (a) { appTile(g3, a, doc); }); box.appendChild(g3);
      }
    }
    // ── 🎡 Spin (owner item 27): the tool row's own spin - one explicit press, through the relay's command path and Pepe's rules ──
    function spinPop(opener) {
      if (!hasCmd('!spin') || !o.relay || !o.relay.sendCmd) return;
      var box = menu(opener, t('spin_title', 'Spin the wheel')), doc = box.ownerDocument;
      box.classList.add('rmd-confirm'); box.setAttribute('role', 'dialog'); layer.kind = 'spin';
      var p = priceText(cmds()['!spin']);
      box.appendChild(el('p', 'rmd-confirm-t', t('spin_confirm', 'Spin the wheel') + (p ? ' · ' + p : ''), doc));
      var row = el('div', 'rmd-confirm-acts', null, doc);
      row.appendChild(button('', 'cancel', 'Cancel', function () { closeLayer(); }, 'ds-btn quiet sm', doc));
      row.appendChild(button('🎡', 'spin_go', 'Spin', function () { if (!hasCmd('!spin')) { closeLayer(); return; } o.relay.sendCmd('!spin'); closeLayer(); }, 'ds-btn primary sm', doc));
      box.appendChild(row);
      finishMenu(box, opener);
    }
    function soundboard(opener) {
      var sb = node('rmSb'); if (!sb) return;
      // (1.99ajq dockpol fix: titled as the rest - its icon, then its words)
      var box = sheet(t('soundboard_title', '🔊 Soundboard'), opener), mark = D.createComment('soundboard dock'); sb.parentNode.insertBefore(mark, sb); box.appendChild(sb);
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
      var box = sheet(t('tip_title', '💸 Tip someone'), opener), doc = box.ownerDocument;
      layer.kind = 'tip';
      var list = el('div', 'rmd-tip-list', null, doc), none = el('p', null, t('tip_none', 'No eligible recipients are in the room.'), doc), drawn = null;
      var find = el('input', 'ds-in rmd-find', null, doc); find.type = 'search'; find.placeholder = t('find', '🔍 Find someone…'); find.setAttribute('aria-label', t('find_aria', 'Find someone'));
      function filter() { var q = find.value.trim().toLowerCase(); each(list.children, function (b) { b.hidden = !!q && String(b._name || '').toLowerCase().indexOf(q) < 0; }); }
      on(find, 'input', filter);
      box.appendChild(find); box.appendChild(list); box.appendChild(none);
      // 1.99ajf dockclean review: the list is redrawn IN PLACE when the room changes (a poll no longer closes the sheet under someone
      // typing in its search); a person who left or became veiled leaves the list at once, and a button drawn for them before does nothing
      function draw() {
        var people = tipPeople(), key = JSON.stringify(people);
        if (key === drawn) return; drawn = key;
        var a = doc.activeElement, had = a && a.parentNode === list ? a._tipTo : null, back = null;
        list.textContent = '';
        people.forEach(function (u) {
          var b = el('button', 'ds-btn quiet', null, doc), content = o.person && o.person(u); b.type = 'button'; if (content) b.appendChild(content);
          b._name = txt(content) || u.display || u.tip.to; b._tipTo = u.tip.to;
          on(b, 'click', function () {
            var now = tipPeople().filter(function (p) { return p.tip.to === u.tip.to; })[0];
            if (!now) { closeLayer(); return; }
            // (1.99ajf dockclean review: the 💸 tool has focus when the tip dialog opens - the dialog gives it back there when it closes)
          external(function () { if (opener && opener.isConnected && opener.focus) opener.focus(); W.PATVRoom.tipModal({ to: now.tip.to, display: now.display, slug: o.slug, me: o.user }); });
          }); list.appendChild(b);
          if (had && had === u.tip.to) back = b;
        });
        find.hidden = people.length <= 4 && !find.value;
        none.hidden = !!people.length;
        filter();
        if (had) { var f = back || (!find.hidden ? find : focusable(box)[0]); if (f) f.focus(); }
      }
      layer.redraw = draw; draw();
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
      layer.kind = 'pvp'; layer.who = u;
      var form = el('form', 'rmd-pvp', null, doc), presets = el('div', 'rmd-presets', null, doc), amt = el('input', 'ds-in', null, doc);
      presets.setAttribute('role', 'group'); presets.setAttribute('aria-label', t('stake', 'Stake'));
      amt.type = 'text'; amt.inputMode = 'numeric'; amt.value = '5,000'; amt.setAttribute('aria-label', t('stake_custom', 'Stake in PAT'));
      [1000, 5000, 25000].forEach(function (n) {
        var b = el('button', 'ds-btn quiet sm', fmtN(n), doc); b.type = 'button'; on(b, 'click', function () { amt.value = fmtN(n); paintStake(); amt.focus(); }); presets.appendChild(b);
      });
      var lab = el('label', 'ds-label', t('stake_custom', 'Stake in PAT'), doc); lab.appendChild(amt);
      var note = el('p', 'ds-fine', t('stake_note', 'Your stake is held until they accept; refunded if they decline or it expires.'), doc);
      var err = el('p', 'rmd-err', null, doc); err.setAttribute('role', 'status');
      form.appendChild(presets); form.appendChild(lab); form.appendChild(note); form.appendChild(err);
      var actions = el('div', 'ds-modal-f', null, doc);
      actions.appendChild(button('', 'cancel', 'Cancel', function () { closeLayer(); }, 'ds-btn quiet', doc));
      var send = button(kind === 'brawl' ? '🥊' : '⚔️', 'send_challenge', 'Send challenge', null, 'ds-btn primary', doc); send.type = 'submit'; actions.appendChild(send);
      form.appendChild(actions); box.appendChild(form);
      // 1.99ajf dockclean review: the button says the stake it will send ("5m" is 5,000,000), and a big one (a million or more) asks once more
      var sure = null;
      function paintStake() {
        var n = parseAmount(amt.value), l = send.querySelector('.rmd-label'); sure = sure === n ? sure : null;
        l.textContent = n ? (sure ? t('stake_sure', 'Yes, stake {n} PAT', { n: fmtN(n) }) : t('send_challenge_n', 'Send challenge · {n} PAT', { n: fmtN(n) })) : t('send_challenge', 'Send challenge');
        send.setAttribute('aria-label', l.textContent); send.title = l.textContent;
      }
      on(amt, 'input', function () { sure = null; err.textContent = ''; paintStake(); });
      paintStake();
      on(form, 'submit', function (e) {
        e.preventDefault(); var n = parseAmount(amt.value);
        if (!n) { err.textContent = t('stake_bad', 'Type an amount of PAT, like 5,000 or 5k.'); return; }
        if (!hasCmd('!' + kind) || !pvpFor(u)) { closeLayer(); return; }
        if (n >= 1e6 && sure !== n) { sure = n; paintStake(); err.textContent = t('stake_big', 'That is {n} PAT - press again to send it.', { n: fmtN(n) }); return; }
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
      if (cb && !cb.hidden && !cb.disabled) menuItem(box, '🎬', 'clip', 'Clip this chat', function () { external(function () { cb.click(); }); });
      var story = root.querySelector('.rm-story button.ss-add[data-pad]');
      if (story && !inPip()) menuItem(box, '📲', 'story', 'Add to your story', function () { external(function () { story.click(); }); });
      if (o.relay && o.relay.getInput && data && data.room && data.room.cmds) menuItem(box, '❔', 'commands', 'Commands', function () { insertCmd('!', false); });
      // 1.99ajq dockpol (owner item 30): CREATE - each only where Pepe offers its command here (hasCmd: linked viewers). Poll / Wager / Bounty
      // are small forms that send the chat command through the relay after an explicit press (exactly as typing it: Pepe's escrow, fees,
      // minimums and refusals apply); a market opens the site's own create form (its close-time bounds and judge rules live there)
      var canSend = !!(o.relay && o.relay.sendCmd) && !inPip();
      var create = [canSend && hasCmd('!poll'), canSend && hasCmd('!wager') && wagerPeople().length > 0, canSend && hasCmd('!bounty'), hasCmd('!market') && !!o.slug];
      if (create.some(Boolean)) menuGroup(box, 'g_create', 'Create');
      if (create[0]) menuItem(box, '📊', 'create_poll', 'Poll…', function () { pollSheet(opener); });
      if (create[1]) menuItem(box, '🤝', 'create_wager', 'Wager…', function () { wagerSheet(opener); });
      if (create[2]) menuItem(box, '🎯', 'create_bounty', 'Bounty…', function () { bountySheet(opener); });
      if (create[3]) {
        var mk = menuItem(box, '📈', 'create_market', 'Market ↗', null, { href: '/markets?pad=' + encodeURIComponent(o.slug) });
        mk.target = '_blank'; mk.rel = 'noopener'; on(mk, 'click', function () { closeLayer(false); });
      }
      finishMenu(box, opener);
    }
    // ── the Create forms (owner item 30): they build the same line a person would type; the relay sends it, Pepe does the rest ──
    var CMD_MAX = 300;
    function formRow(doc, label, field) { var l = el('label', 'ds-label rmd-form-l', label, doc); l.appendChild(field); return l; }
    function textField(doc, max, ph) { var i = el('input', 'ds-in', null, doc); i.type = 'text'; i.maxLength = max; if (ph) i.placeholder = ph; i.autocomplete = 'off'; return i; }
    function formFoot(form, doc, icon, key, label) {
      var err = el('p', 'rmd-err', null, doc); err.setAttribute('role', 'status'); form.appendChild(err);
      var actions = el('div', 'ds-modal-f', null, doc);
      actions.appendChild(button('', 'cancel', 'Cancel', function () { closeLayer(); }, 'ds-btn quiet', doc));
      var go = button(icon, key, label, null, 'ds-btn primary', doc); go.type = 'submit'; actions.appendChild(go); form.appendChild(actions);
      return { err: err, go: go };
    }
    function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
    function pollSheet(opener) {
      if (!hasCmd('!poll')) return;
      var box = sheet(t('poll_title', '📊 Start a poll'), opener), doc = box.ownerDocument; layer.kind = 'create';
      var form = el('form', 'rmd-form', null, doc), q = textField(doc, 200, t('poll_q_ph', 'What should the room decide?'));
      form.appendChild(formRow(doc, t('poll_q', 'Question'), q));
      var opts = el('div', 'rmd-form-opts', null, doc); form.appendChild(opts);
      function addOpt() {
        if (opts.children.length >= 8) return null;
        var i = textField(doc, 100, t('poll_opt_n', 'Option {n}', { n: opts.children.length + 1 })); i.setAttribute('aria-label', t('poll_opt_n', 'Option {n}', { n: opts.children.length + 1 }));
        opts.appendChild(i); more.hidden = opts.children.length >= 8; return i;
      }
      var more = button('', 'poll_add', '+ Add option', function () { var i = addOpt(); if (i) i.focus(); }, 'ds-btn quiet sm rmd-form-add', doc);
      addOpt(); addOpt(); form.appendChild(more);
      var f = formFoot(form, doc, '📊', 'poll_go', 'Start poll'); box.appendChild(form);
      on(form, 'submit', function (e) {
        e.preventDefault();
        // (1.99ajq dockpol fix (review): Pepe reads the question up to its FIRST "?" and splits the options at commas - so a "?" inside the
        // question or a comma inside an option is said, not silently changed)
        var question = oneLine(q.value).replace(/\?+$/, ''), list = [], comma = null;
        each(opts.children, function (i) { var v = oneLine(i.value); if (v.indexOf(',') >= 0 && !comma) comma = i; if (v) list.push(v); });
        if (!question) { f.err.textContent = t('poll_need_q', 'Write the question.'); q.focus(); return; }
        if (question.indexOf('?') >= 0) { f.err.textContent = t('poll_one_q', 'Use one question mark, at the end of the question.'); q.focus(); return; }
        if (comma) { f.err.textContent = t('poll_no_comma', 'An option can’t have a comma in it - Pepe splits the options at commas.'); comma.focus(); return; }
        if (list.length < 2) { f.err.textContent = t('poll_need_opts', 'Give it at least two options.'); return; }
        var line = '!poll ' + question + '? ' + list.join(', ');
        if (line.length > CMD_MAX) { f.err.textContent = t('form_long', 'That is too long for one chat line - shorten it a little.'); return; }
        if (!hasCmd('!poll')) { closeLayer(); return; }
        o.relay.sendCmd(line); closeLayer();
      });
      setTimeout(function () { if (q.isConnected) q.focus(); }, 0);
    }
    /** named Camfrog members a wager can name (never a frog name, a web user, Pepe or the viewer) */
    function wagerPeople() {
      var me = data && data.me && data.me.login ? String(data.me.login).toLowerCase() : null, seen = {}, out = [];
      (data && data.members || []).forEach(function (u) {
        if (!u || u.veil || u.anon || u.self || u.bot || u.me || u.web || u.acct || !u.login || /^u:/i.test(String(u.login))) return;
        var k = String(u.login).toLowerCase(); if (k === me || seen[k]) return; seen[k] = 1; out.push(u);
      });
      return out;
    }
    function personSelect(doc, list, none) {
      var s = el('select', 'ds-select', null, doc), z = el('option', null, none, doc); z.value = ''; s.appendChild(z);
      list.forEach(function (u) { var op = el('option', null, String(u.display || u.login) + (u.display && String(u.display).toLowerCase() !== String(u.login).toLowerCase() ? ' (' + u.login + ')' : ''), doc); op.value = String(u.login); s.appendChild(op); });
      return s;
    }
    /** an amount field + presets; the primary button says the amount, and a million or more asks once more (as the duel sheet) */
    function stakeField(doc, form, go, verbKey, verb, presets, start) {
      var row = el('div', 'rmd-presets', null, doc), amt = el('input', 'ds-in', null, doc), sure = null;
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', t('stake', 'Stake'));
      amt.type = 'text'; amt.inputMode = 'numeric'; amt.value = fmtN(start); amt.setAttribute('aria-label', t('stake_custom', 'Stake in PAT'));
      function paint() {
        var n = parseAmount(amt.value), l = go.querySelector('.rmd-label'); sure = sure === n ? sure : null;
        l.textContent = n ? (sure ? t('stake_sure', 'Yes, stake {n} PAT', { n: fmtN(n) }) : t(verbKey + '_n', verb + ' · {n} PAT', { n: fmtN(n) })) : t(verbKey, verb);
        go.setAttribute('aria-label', l.textContent); go.title = l.textContent;
      }
      presets.forEach(function (n) { var b = el('button', 'ds-btn quiet sm', fmtN(n), doc); b.type = 'button'; on(b, 'click', function () { amt.value = fmtN(n); sure = null; paint(); amt.focus(); }); row.appendChild(b); });
      on(amt, 'input', function () { sure = null; paint(); });
      // (1.99ajq dockpol fix (review): the presets under their own field - above it they read as the previous field's)
      form.appendChild(formRow(doc, t('stake_custom', 'Stake in PAT'), amt)); form.appendChild(row); paint();
      /** -> the amount once it may go (null: not yet - the field says why) */
      return function check(err) {
        var n = parseAmount(amt.value);
        if (!n) { err.textContent = t('stake_bad', 'Type an amount of PAT, like 5,000 or 5k.'); amt.focus(); return null; }
        if (n >= 1e6 && sure !== n) { sure = n; paint(); err.textContent = t('stake_big', 'That is {n} PAT - press again to send it.', { n: fmtN(n) }); return null; }
        return n;
      };
    }
    function wagerSheet(opener) {
      var people = wagerPeople(); if (!hasCmd('!wager') || !people.length) return;
      var box = sheet(t('wager_title', '🤝 Offer a wager'), opener), doc = box.ownerDocument; layer.kind = 'create';
      var form = el('form', 'rmd-form', null, doc), who = personSelect(doc, people, t('wager_pick', 'Pick someone in the room'));
      form.appendChild(formRow(doc, t('wager_who', 'Against'), who));
      var terms = textField(doc, 160, t('wager_terms_ph', 'e.g. the Bills win tonight'));
      var f = { err: null, go: null }, foot = null;
      // (1.99ajq dockpol fix (review): every wager needs a judge - Pepe refuses one without (pepe_wager.py) - so the judge is required and
      // Pepe himself, his AI judge, is the first choice; or someone in the room other than the two of you)
      var judge = personSelect(doc, people, t('wager_pick_judge', 'Pick a judge'));
      var pj = el('option', null, t('wager_judge_pepe', '🐸 Pepe (AI judge)'), doc); pj.value = 'pepe';
      judge.insertBefore(pj, judge.children[1] || null); judge.value = 'pepe';
      var holder = el('div', null, null, doc); form.appendChild(holder);
      form.appendChild(formRow(doc, t('wager_terms', 'What you’re betting on'), terms));
      form.appendChild(formRow(doc, t('wager_judge', 'Judge'), judge));
      form.appendChild(el('p', 'ds-fine', t('wager_note', 'Your stake is held until they accept; refunded if they decline or it expires. Minimum 1,000 PAT.'), doc));
      foot = formFoot(form, doc, '🤝', 'wager_go', 'Offer wager'); f = foot;
      var tmp = el('div', null, null, doc), check = stakeField(doc, tmp, f.go, 'wager_go', 'Offer wager', [1000, 10000, 50000], 10000);
      while (tmp.firstChild) holder.appendChild(tmp.firstChild);
      box.appendChild(form);
      setTimeout(function () { if (who.isConnected) who.focus(); }, 0);      // (who first - the sheet's own first focus would take the stake)
      on(form, 'submit', function (e) {
        e.preventDefault(); f.err.textContent = '';
        var w = who.value, what = oneLine(terms.value), j = judge.value;
        if (!w) { f.err.textContent = t('wager_need_who', 'Pick who the wager is with.'); who.focus(); return; }
        if (!what) { f.err.textContent = t('wager_need_terms', 'Say what you’re betting on.'); terms.focus(); return; }
        if (!j) { f.err.textContent = t('wager_need_judge', 'Pick a judge - Pepe, or someone other than the two of you.'); judge.focus(); return; }
        if (j.toLowerCase() === w.toLowerCase()) { f.err.textContent = t('wager_judge_self', 'The judge can’t be the person you bet against.'); return; }
        var n = check(f.err); if (!n) return;
        if (n < 1000) { f.err.textContent = t('wager_min', 'The smallest wager is 1,000 PAT.'); return; }
        var line = '!wager @' + w + ' ' + n + ' ' + what + ' judge @' + j;
        if (line.length > CMD_MAX) { f.err.textContent = t('form_long', 'That is too long for one chat line - shorten it a little.'); return; }
        if (!hasCmd('!wager')) { closeLayer(); return; }
        o.relay.sendCmd(line); closeLayer();
      });
    }
    function bountySheet(opener) {
      if (!hasCmd('!bounty')) return;
      var box = sheet(t('bounty_title', '🎯 Post a bounty'), opener), doc = box.ownerDocument; layer.kind = 'create';
      var form = el('form', 'rmd-form', null, doc), what = textField(doc, 160, t('bounty_what_ph', 'e.g. someone sings the whole song on the mic'));
      form.appendChild(formRow(doc, t('bounty_what', 'What has to happen'), what));
      var holder = el('div', null, null, doc); form.appendChild(holder);
      var by = el('select', 'ds-select', null, doc);
      [['', t('bounty_by_none', 'No deadline')], ['1d', t('bounty_by_1d', 'Within a day')], ['2d', t('bounty_by_2d', 'Within 2 days')], ['7d', t('bounty_by_7d', 'Within a week')]].forEach(function (x) { var op = el('option', null, x[1], doc); op.value = x[0]; by.appendChild(op); });
      form.appendChild(formRow(doc, t('bounty_by', 'Deadline'), by));
      form.appendChild(el('p', 'ds-fine', t('bounty_note', 'The reward is held until someone claims it; Pepe’s bounty rules apply.'), doc));
      var f = formFoot(form, doc, '🎯', 'bounty_go', 'Post bounty');
      var tmp = el('div', null, null, doc), check = stakeField(doc, tmp, f.go, 'bounty_go', 'Post bounty', [1000, 5000, 25000], 5000);
      while (tmp.firstChild) holder.appendChild(tmp.firstChild);
      box.appendChild(form);
      on(form, 'submit', function (e) {
        e.preventDefault(); f.err.textContent = '';
        var w = oneLine(what.value); if (!w) { f.err.textContent = t('bounty_need', 'Say what has to happen.'); what.focus(); return; }
        var n = check(f.err); if (!n) return;
        var line = '!bounty ' + w + ' ' + n + (by.value ? ' by ' + by.value : '');
        if (line.length > CMD_MAX) { f.err.textContent = t('form_long', 'That is too long for one chat line - shorten it a little.'); return; }
        if (!hasCmd('!bounty')) { closeLayer(); return; }
        o.relay.sendCmd(line); closeLayer();
      });
      setTimeout(function () { if (what.isConnected) what.focus(); }, 0);
    }
    // ── 👥 Participants (owner point 29): ONLY the people card ──
    function participants(opener, after) {
      if (inPip()) { W.focus(); toast(t('in_pad', 'Use this control in the pad tab.')); return; }
      var card = node('rmPplCard'); if (!card) return;
      external(function () {
        var box = sheet(t('participants_n', 'In the room · {n}', { n: peopleCount() }), opener);
        layer.kind = 'participants';
        var mark = D.createComment('people dock'); card.parentNode.insertBefore(mark, card); box.appendChild(card); card.classList.add('rmd-side-open');
        // (1.99ajq dockpol (owner item 19): the freshness note is the title's tooltip and description - no ℹ️ to wrap or tap)
        var note = txt(node('rmListNote')), h2 = layer.head && layer.head.querySelector('h2');
        if (h2 && note) { h2.title = note; try { h2.setAttribute('aria-description', note); } catch (e) { /* older engines */ } }
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
      var note = node('rmListNote'), n0 = node('rmPplN');
      // (1.99ajq dockpol (owner item 19): one line - IN THE CHAT ROOM [n]; the count is a badge, the freshness note the heading's tooltip)
      if (n0) n0.classList.add('rmd-count');
      // (1.99ajq dockpol fix (review, item 19): a column too narrow for IN THE CHAT ROOM says IN THE ROOM - never "IN THE CHAT RO…"; pad-dock.css
      // picks one by the card's width, the long words stay the heading's name)
      var ht = node('pplH') && node('pplH').querySelector('.ht');
      if (ht && !(ht.nextElementSibling && ht.nextElementSibling.classList.contains('rmd-ht-s'))) { var hs = el('span', 'ht rmd-ht-s', t('people_short', 'In the room')); hs.setAttribute('aria-hidden', 'true'); ht.parentNode.insertBefore(hs, ht.nextSibling); ht.classList.add('rmd-ht-l'); }
      peopleInput = el('input', 'ds-in rmd-find'); peopleInput.type = 'search'; peopleInput.placeholder = t('find', '🔍 Find someone…'); peopleInput.setAttribute('aria-label', t('find_aria', 'Find someone'));
      peopleInput.setAttribute('aria-controls', 'rmPeople');
      on(peopleInput, 'input', filterPeople);
      var list = node('rmPeople'); if (list) card.insertBefore(peopleInput, list); else card.appendChild(peopleInput);
      if (note) note.classList.add('ds-sr-only');
      paintInfo();
    }
    function paintInfo() {
      var note = node('rmListNote'), s = txt(note), h = node('pplH');
      if (!peopleInput) return;
      var n = node('rmPplN'); if (n) { n.textContent = String(peopleCount()); n.title = s; }
      if (h) { if (s) h.title = s; else h.removeAttribute('title'); try { if (s) h.setAttribute('aria-description', s); else h.removeAttribute('aria-description'); } catch (e) { /* older engines */ } }
      if (pplBtn) {
        var c = pplBtn.querySelector('.rmd-count'); if (c) c.textContent = String(peopleCount()); pplBtn.setAttribute('aria-label', t('participants_n', 'In the room · {n}', { n: peopleCount() }));
        pplBtn.title = s ? t('participants_n', 'In the room · {n}', { n: peopleCount() }) + ' - ' + s : t('participants_n', 'In the room · {n}', { n: peopleCount() });
        // (1.99ajh dockpop: the homepage's sign-in tease has no people to show)
        if (mode === 'preview') pplBtn.hidden = !(data && Array.isArray(data.members) && data.members.length);
      }
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
      if (av) switchRow(box, '⏱️', 'avsync', 'Sync cams to the audio', av.getAttribute('aria-pressed') === 'true', function () { proxyClick(av); return av.getAttribute('aria-pressed') === 'true'; });
      layer.restore = restoreSel;
      finishMenu(box, opener);
    }
    function decorateAudio() {
      var audioHost = node('rmAudioBox'); if (!audioHost || !chat) return;
      if (compose && compose.parentNode === chat) chat.insertBefore(audioHost, compose);   // room audio stays usable in the composer's signed-out / link-first states
      else if (audioHost.parentNode === chat) chat.appendChild(audioHost);   // (1.99ajh dockpop review: no composer - read-only on the homepage - it is still the BOTTOM bar)
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
      if (!chat) return;
      decorateAudio();
      if (!compose) return;
      compose.classList.add('rmd-composer');
      var input = o.relay && o.relay.getInput && o.relay.getInput();
      var row = el('div', 'rmd-input-row' + (mode === 'preview' ? ' rmd-input-slim' : ''));
      if (input) {
        input.classList.add('ds-in'); var form = input.closest('form'), wrap = input.closest('.rb-say-in');
        var relayHost = node('rmRelay'); relayHost.parentNode.insertBefore(row, relayHost); row.appendChild(relayHost);
        // (1.99ajh dockpop P2: the homepage's composer is one row - [Message …][🎙️ Hold to talk][Send], no ＋ and no tool row)
        if (mode !== 'preview') {
          extras = iconBtn('＋', 'extras', 'Add to the chat', function () { if (layer && layer.opener === extras) { closeLayer(); return; } openExtras(extras); }, 'ds-btn ghost rmd-extras');
          extras.setAttribute('aria-haspopup', 'menu'); extras.setAttribute('aria-expanded', 'false'); form.insertBefore(extras, wrap);
        }
        var send = form.querySelector('.rb-send'); if (send) send.classList.add('ds-btn', 'primary');
        var hint = el('span', 'ds-sr-only', t('input_hint', 'Type ! for commands; Pepe relays your words into the room as you (web).')); hint.id = 'rmdInputHint'; row.appendChild(hint);
        input.setAttribute('aria-describedby', 'rmdInputHint');
      } else if (node('rmPtt')) compose.insertBefore(row, node('rmPtt'));
      var ptt = node('rmPtt'); if (ptt) { row.appendChild(ptt); var talk = ptt.querySelector('.rb-talk'); if (talk) talk.classList.add('ds-btn', 'quiet'); }
      // (1.99ajf dockclean review: Tab goes as the row reads - ＋, the input, 🎙 Hold to talk, Send: Send sits after the push-to-talk
      // box and still submits its form through the form attribute; Enter in the input submits as before)
      var sendBtn = input && input.closest('form') && input.closest('form').querySelector('.rb-send');
      if (sendBtn && ptt) { var sf = input.closest('form'); if (!sf.id) sf.id = 'rmdSayForm'; sendBtn.setAttribute('form', sf.id); row.insertBefore(sendBtn, ptt.nextSibling); }
      if ((!input && !ptt) || mode === 'preview') return;
      toolRow = el('div', 'rmd-tools'); toolRow.setAttribute('role', 'toolbar'); toolRow.setAttribute('aria-label', t('tools', 'Chat tools'));
      function tool(id, icon, key, label, fn) { var b = iconBtn(icon, key, label, function (x) { fn(x); }, 'ds-btn ghost rmd-tool'); b.setAttribute('data-rmd-tool', id); toolRow.appendChild(b); toolBtns[id] = b; return b; }
      tool('tip', '💸', 'tip', 'Tip', tip);
      tool('gif', '🎞️', 'gifs', 'GIFs', function (b) { picker('gifs', b); });
      tool('stickers', '🧸', 'stickers', 'Stickers', function (b) { picker('patv', b); });
      // (1.99ajq dockpol (owner item 27): no 😀 - 🧸's sheet has the Emoji tab; a 🎡 Spin with a confirm in its place)
      var spinB = tool('spin', '🎡', 'spin_tool', 'Spin the wheel', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } spinPop(b); });
      spinB.setAttribute('aria-haspopup', 'dialog'); spinB.setAttribute('aria-expanded', 'false');
      tool('apps', '⚡', 'apps', 'Chat apps', apps);
      tool('sb', '🔊', 'soundboard', 'Soundboard', soundboard);
      var say = tool('tts', '🗣️', 'tts', 'Pepe says it', tts); say.setAttribute('data-rmd-tts', '');
      row.appendChild(toolRow);
      paintTools();
    }
    function paintTools() {
      if (!toolRow) return;
      var room = data && data.room || {}, relayOn = !!(o.relay && room.relay), pick = !!(W.PATVPadPicker && W.PATVPadPicker.available && W.PATVPadPicker.available(data, o));
      var show = { tip: !!o.signed && !inPip(), gif: pick && room.gifPicker === true, stickers: pick && relayOn, spin: hasCmd('!spin') && !!(o.relay && o.relay.sendCmd),
        apps: !!(appList().length || dj() || musicOn()), sb: !!(o.linked && node('rmSb')), tts: hasCmd('!say') };
      Object.keys(toolBtns).forEach(function (k) { toolBtns[k].hidden = !show[k]; });
      toolRow.hidden = !Object.keys(show).some(function (k) { return show[k]; });
    }

    // ── the pad chip + the pad menu (owner points 1, 2, 4, 25) ──
    function heroPiece(sel) { var h = node('rmHero'); return h ? h.querySelector(sel) : null; }
    function padChip(cls, bare) {
      var b = el('button', 'rmd-chip' + (cls ? ' ' + cls : '')); b.type = 'button';
      if (!bare) identity(b);
      // (1.99ajf dockclean review: ▾ inside the identity's own plate - one pill, not a pill inside a pill)
      var dn = el('span', 'rmd-chip-v', IC.down); dn.setAttribute('aria-hidden', 'true'); (b.querySelector('.rmd-id-content') || b).appendChild(dn);
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
      // (1.99ajq dockpol (owner item 9): while the navbar has stepped aside on a phone, the way back to it is the first item here)
      if (navOff && navHeader) menuItem(box, '☰', 'site_menu', 'Site menu', function () {
        setNav(false);
        var f = navHeader.querySelector('a[href], button'); if (f) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
      });
      // (1.99ajf dockclean review: the chip that opened this menu already shows the pad's banner, look and badges - the header is the
      // name as words and Follow, not a second identity plate)
      var head = el('div', 'rmd-padmenu-h', null, doc), hn = node('rmTitle') && node('rmTitle').querySelector('.rm-nm');
      head.appendChild(el('b', 'rmd-padmenu-n', txt(hn) || D.title, doc)); box.appendChild(head);
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
      if (share) menuItem(box, '🔗', 'share', 'Share pad', function (op) { sharePad(share, op); });
      var go = node('rmGoLive');
      if (go) {
        var here = go.querySelector('.stage-acts a.sact.primary'), book = go.querySelector('.stage-acts a.sact[href*="whenSet"]');
        var boost = node('rmBoostBtn'), boostLink = go.querySelector('.stage-acts a.sact.boost'), slots = node('rmSlotsTxt');
        if (here || book || boost || boostLink) menuGroup(box, 'g_stage', 'Stage');
        // (1.99ajh dockpop review: a sub line's own emoji goes - "🎬 1/2 slots in use" said 🎬, which is Clip in the Dock)
        if (here) menuItem(box, '🎥', 'golive', 'Go live here', null, { href: here.getAttribute('href'), sub: noIcon(txt(slots)) });
        if (book) menuItem(box, '🎫', 'book', 'Book a slot', null, { href: book.getAttribute('href') });
        if (boost && !inPip()) menuItem(box, '🚀', 'boost', 'Boost this pad…', function () { boostSheet(opener); }, { sub: shown(node('rmBoostTxt')) ? noIcon(txt(node('rmBoostTxt')).replace(/^·\s*/, '')) : '' });
        else if (boostLink) menuItem(box, '🚀', 'boost', 'Boost this pad…', null, { href: boostLink.getAttribute('href') });
      }
      var more = node('rmMore'), items = more ? more.querySelectorAll('.hd-menu [role="menuitem"]') : [];
      var extra = Array.prototype.filter.call(items, function (it) { return !it.hasAttribute('data-copy-link'); });
      if (extra.length) {
        menuGroup(box, 'g_more', 'More');
        extra.forEach(function (it) {
          var label = txt(it), ic = '•', m = /^(\p{Extended_Pictographic}\uFE0F?)\s*/u.exec(label);
          if (m) { ic = m[1]; label = label.slice(m[0].length); }
          if (DOCK_ICONS.indexOf(ic.replace(/\uFE0F/g, '')) >= 0) ic = '•';     // (1.99ajh dockpop review: never a Dock control's icon for another thing)
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
    // 🔗 Share pad (1.99ajf dockclean review): share-link.js's own link (its share base) - the phone's share sheet, else copied, with a
    // Dock notice either way (the hidden stage-heading button the old proxy clicked had the only "Link copied"); focus back on the chip
    function sharePad(btn, opener) {
      var S = W.PATVShare, path = btn.getAttribute('data-share-path');
      function back() { if (opener && opener.isConnected && opener.focus) opener.focus(); }
      if (!S || !S.url) { clickOf(btn)(); back(); return; }
      var link = S.url(path), nav = W.navigator || {};
      if (nav.share && /Mobi|Android/i.test(nav.userAgent || '')) { S.share(btn, link); back(); return; }
      function ask() { try { W.prompt(t('copy_link', 'Copy the link:'), link); } catch (e) { /* no prompt */ } back(); }
      if (nav.clipboard && nav.clipboard.writeText) {
        Promise.resolve(nav.clipboard.writeText(link)).then(function () { toast(t('link_copied', 'Link copied')); back(); }, ask);
      } else ask();
      back();
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
        if (typeof then === 'function') setTimeout(then, 0);     // (1.99ajf dockclean review: after the sheet's own first focus - the topic editor wins)
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
      // 1.99ajf dockclean review: a disabled one says WHY - the capture row's own reason (its price line holds it: "🚫 …" or the
      // viewer's why), and a stream that can't be captured at all (the row's note only) shows a greyed 📸 with that note
      var cap = node('rmCap'), capNote = cap && !cap.classList.contains('hide') ? txt(cap.querySelector('.stcap-note')) : '';
      var why = pr.off || (pr.text && !/preview first/i.test(pr.text) ? pr.text : '');
      [['snap', snapBtn], ['clip', clipBtn]].forEach(function (x) {
        var orig = capButton(x[0]), b = x[1];
        var label = x[0] === 'snap' ? t('snap', 'Snap') : t('clip_stage', 'Clip');
        if (!orig && x[0] === 'snap' && capNote && !capButton('clip')) {
          b.hidden = false; b.disabled = true; b.setAttribute('aria-disabled', 'true');
          b.title = label + ' · ' + capNote; b.setAttribute('aria-label', b.title); return;
        }
        b.hidden = !orig;
        if (!orig) return;
        b.disabled = !!orig.disabled; if (orig.disabled) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
        var price = x[0] === 'snap' ? pr.snap : pr.clip;
        var tip = orig.disabled ? label + ' · ' + (why || orig.title || t('unavailable', 'not available right now'))
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
          // (1.99ajf dockclean review: focus back on 🎬 unless the capture's own preview took it)
          if (clipBtn && clipBtn.isConnected && !clipBtn.hidden && !(D.activeElement && D.activeElement !== D.body && D.activeElement.isConnected)) clipBtn.focus();
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
    // 1.99ajf dockclean review: ONE source chip, built once and painted in place (it was rebuilt on every pointer move and poll - a click
    // landed on a node that was gone, Tab fell to <body>, an open menu lost its opener). Only its words, dot and labels change.
    var srcBtn = null, srcOne = null, srcKey = null;
    function paintSource() {
      if (!srcHost) return;
      var list = tabs(), sel = list.filter(function (b) { return b.getAttribute('aria-selected') === 'true'; })[0] || list[0];
      var label = sel ? txt(sel).replace(/^★\s*/, '') : '', many = list.length >= 2 || tabExtras().length > 0, live = !!(sel && !sel.classList.contains('off'));
      var key = list.length + '|' + label + '|' + (many ? 1 : 0) + (live ? 1 : 0);
      if (key === srcKey) return; srcKey = key;
      if (!srcBtn) {
        srcOne = el('span', 'rmd-src rmd-src-one');
        srcBtn = el('button', 'rmd-src ds-btn quiet sm'); srcBtn.type = 'button';
        var dot = el('span', 'rmd-dot'); dot.setAttribute('aria-hidden', 'true'); srcBtn.appendChild(dot);
        srcBtn.appendChild(el('span', 'rmd-label')); var dn = el('span', 'rmd-chip-v', IC.down); dn.setAttribute('aria-hidden', 'true'); srcBtn.appendChild(dn);
        srcBtn.setAttribute('aria-haspopup', 'menu'); srcBtn.setAttribute('aria-expanded', 'false');
        on(srcBtn, 'click', function () { if (layer && layer.opener === srcBtn) { closeLayer(); return; } sourceMenu(srcBtn); });
        srcHost.appendChild(srcOne); srcHost.appendChild(srcBtn);
      }
      srcHost.hidden = !list.length;
      srcOne.hidden = many; srcOne.textContent = label;
      srcBtn.hidden = !many;
      srcBtn.querySelector('.rmd-dot').classList.toggle('rmd-on', live);
      srcBtn.querySelector('.rmd-label').textContent = label;
      srcBtn.setAttribute('aria-label', t('source', 'Stage source: {name}', { name: label })); srcBtn.title = srcBtn.getAttribute('aria-label');
      if (!many && layer && layer.opener === srcBtn) closeLayer(false);
    }
    function sourceMenu(opener) {
      var box = menu(opener, t('sources', 'Stage sources'));
      tabs().forEach(function (tb) {
        var label = txt(tb).replace(/^★\s*/, '');
        var it = menuItem(box, tb.classList.contains('off') ? '⚪' : '🔴', 'raw', label, function () { tb.click(); paintSource(); if (srcBtn && !srcBtn.hidden) srcBtn.focus(); }, { role: 'menuitemradio', checked: tb.getAttribute('aria-selected') === 'true' });
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
      menuItem(box, IC.pip, 'pip_stage', 'Picture-in-picture', function () { pop(stageMedia()); });
      if (mode === 'preview') { previewItems(box); finishMenu(box, opener); return; }
      menuItem(box, IC.hide, 'hide_stage', 'Hide stage', function () { hideStage(true, true); });
      if (strip && strip.querySelector('.cs-tile')) menuItem(box, '📌', 'pins', 'Pinned cams', function () { pinsMenu(box, opener); }, { keep: true, sub: '▸' });
      var sched = node('rmSched'), upnext = node('rmGoLive') && node('rmGoLive').querySelector('.upnext');
      if (sched || upnext) menuItem(box, '🗓️', 'schedule', 'Stage schedule…', function () { scheduleSheet(opener); });
      var plex = node('rmPlexQ'); if (plex && !plex.hidden) menuItem(box, '📼', 'plex', 'Plex queue & controls…', function () { external(function () { nodeSheet(t('plex', 'Plex queue & controls…').replace(/…$/, ''), plex, opener, 'plex'); }); });
      var mbtn = stage && stage.querySelector('.mf-mbtn'), clear = stage && stage.querySelector('.mf-clear'), rep = stage && stage.querySelector('.mf-rbtn');
      if (rep && !rep.hidden) menuItem(box, '⚑', 'mf_report', 'Report someone on the mic stage…', function () { external(function () { rep.click(); }); });
      if ((mbtn && !mbtn.hidden) || (clear && !clear.hidden)) menuGroup(box, 'g_managers', 'Managers');
      if (mbtn && !mbtn.hidden) menuItem(box, '🎛️', 'mf_manage', 'Manage the mic stage…', function () { micPanel(opener, mbtn); });
      if (clear && !clear.hidden) menuItem(box, '🧹', 'mf_clear', 'Clear the stage', function () { external(function () { clear.click(); }); }, { disabled: clear.disabled });
      staffItems(box);
      finishMenu(box, opener);
    }
    // the staff's on-air bar (onair-bar.js: ▶️ Play content here, ✂️ Cut), proxied - its own buttons, checks and confirms
    function staffItems(box) {
      var oab = root.querySelectorAll('.oab button[data-oab]');
      if (!oab.length) return 0;
      menuGroup(box, 'g_staff', 'Staff');
      each(oab, function (b) {
        var label = b.getAttribute('aria-label') || txt(b), what = b.getAttribute('data-oab');
        var it = menuItem(box, what === 'play' ? '▶️' : what === 'cut' ? '✂️' : '•', 'raw', label, function () { external(function () { b.click(); }); }, { disabled: b.disabled, tip: b.title });
        it.querySelector('.rmd-label').textContent = label.replace(/^📺\s*|^✂\s*/, ''); it.setAttribute('aria-label', label.replace(/^📺\s*|^✂\s*/, ''));
      });
      return oab.length;
    }
    // 1.99ajh dockpop (P2): the homepage stage's ⋯ - 🎥 Go live here, and for staff the on-air bar, ⚙️ Front page settings and 🐸 Pepe's panel
    function previewItems(box) {
      var pv = o.preview || {};
      if (pv.goLive) menuItem(box, '🎥', 'golive', 'Go live here', null, { href: pv.goLive });
      var n = staffItems(box);
      if (pv.staff && (pv.staff.front || pv.staff.pepe)) {
        if (!n) menuGroup(box, 'g_staff', 'Staff');
        if (pv.staff.front) menuItem(box, '⚙️', 'front_settings', 'Front page settings', null, { href: pv.staff.front });
        if (pv.staff.pepe) menuItem(box, '🐸', 'pepe_panel', 'Pepe control panel', null, { href: pv.staff.pepe });
      }
    }
    function pinsMenu(box, opener) {
      box.textContent = '';
      menuItem(box, '←', 'back', 'Back', function () { closeLayer(false); stageMenu(opener); });
      var now = pinSize();
      [['small', 'Small', '▪️'], ['medium', 'Medium', '◾'], ['large', 'Large', '⬛'], ['grid', 'Grid', '▦']].forEach(function (p) {
        menuItem(box, p[2], 'layout_' + p[0], p[1], function () { pinSize(p[0]); }, { role: 'menuitemradio', checked: now === p[0] });
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
    // The overlay shows (rmd-controls-on: opacity) and takes taps (rmd-ov-armed: only its own buttons, never the whole bar - the mic
    // stage's tile controls under the bars stay usable). 1.99ajf dockclean review: a touch that wakes a hidden overlay arms it a moment
    // LATER, so the tap that revealed the pad chip / ⋯ / 🖥️ under the finger doesn't also press it.
    var armTimer = null;
    function offTools() { clearTimeout(armTimer); stage.classList.remove('rmd-controls-on', 'rmd-ov-armed'); }
    function showTools(armLater) {
      if (!stage) return;
      var was = stage.classList.contains('rmd-controls-on');
      stage.classList.add('rmd-controls-on'); clearTimeout(autoTimer);
      if (armLater === true && !was) { clearTimeout(armTimer); armTimer = setTimeout(function () { if (stage.classList.contains('rmd-controls-on')) stage.classList.add('rmd-ov-armed'); }, 450); }
      else if (armLater !== true) { clearTimeout(armTimer); stage.classList.add('rmd-ov-armed'); }
      paintCapture();
      autoTimer = setTimeout(function hide() { if (overlayHot()) { autoTimer = setTimeout(hide, HIDE_MS); return; } offTools(); }, HIDE_MS);
    }
    function hideTools() { clearTimeout(autoTimer); if (!overlayHot()) offTools(); }
    function buildStage() {
      var ov = el('div', 'rmd-ov');
      ovTop = el('div', 'rmd-ov-top'); ovBot = el('div', 'rmd-ov-bot');
      var pv = o.preview || {};
      // (1.99ajq dockpol fix (review, item 9): while a phone's navbar has stepped aside, ☰ before the pad chip is the visible way back -
      // pad-dock.css shows it only then; its words stay its name)
      if (mode === 'pad') ovTop.appendChild(iconBtn('☰', 'site_menu', 'Site menu', function () { setNav(false); var f = navHeader && navHeader.querySelector('a[href], button'); if (f) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } } }, 'ds-btn quiet sm rmd-nav-back'));
      // (1.99ajh dockpop P2: on the homepage the pad chip is a LINK to the pad - its menu is the pad page's)
      ovTop.appendChild(mode === 'preview' ? padLink() : padChip());
      // (1.99ajh dockpop review: the homepage's "Next up" is its own piece - a second line on a phone, never squeezing the pad chip)
      slimText = el('span', 'rmd-slim-t'); slimText.appendChild(el('span', 'rmd-slim-a', t('nothing_on', 'Nothing on stage right now')));
      if (mode === 'preview' && pv.nextUp) { var sep = el('span', 'rmd-slim-sep', ' · '); sep.setAttribute('aria-hidden', 'true'); slimText.appendChild(sep); slimText.appendChild(el('span', 'rmd-slim-b', pv.nextUp)); }
      ovTop.appendChild(slimText);
      srcHost = el('span', 'rmd-src-host'); ovBot.appendChild(srcHost);
      ovBot.appendChild(el('span', 'rmd-ov-gap'));
      snapBtn = iconBtn('📸', 'snap', 'Snap', function () { var b = capButton('snap'); if (b && !b.disabled) external(function () { b.click(); }); });
      clipBtn = iconBtn('🎬', 'clip_stage', 'Clip', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } clipMenu(b); });
      clipBtn.setAttribute('aria-haspopup', 'menu'); clipBtn.setAttribute('aria-expanded', 'false');
      // (1.99ajf dockclean review: 🖥️ is a toggle - inside fullscreen it is "Exit fullscreen", the one way out; the viewbar's ↩ is hidden there)
      fullBtn = iconBtn(IC.full, 'fullscreen', 'Fullscreen', function () { if (stageFull()) redock(); else full(stageMedia()); });
      var more = iconBtn(IC.more, 'stage_menu', 'Stage options', function (b) { if (layer && layer.opener === b) { closeLayer(); return; } stageMenu(b); });
      more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false'); more.classList.add('rmd-stage-more'); stageMoreBtn = more;
      [snapBtn, clipBtn, fullBtn, more].forEach(function (b) { ovBot.appendChild(b); });
      // the homepage's slim off-air bar: [pad chip ›] Nothing on stage right now · Next up … (+ ⋯ for staff). (1.99ajh dockpop review: no
      // 🎥 Go live of its own - the Your show card and the navbar already have the same link; on air it is the stage ⋯'s Go live here)
      if (mode === 'preview' && pv.staff) root.classList.add('rmd-staff');
      ov.appendChild(ovTop); ov.appendChild(ovBot);
      srcBox = node('rmTabs'); if (srcBox) { srcBox.classList.add('rmd-tabs-src'); ov.appendChild(srcBox); }
      stage.insertBefore(ov, stage.firstChild);
      [ovTop, ovBot].forEach(function (bar) { on(bar, 'pointerenter', function () { overBar = true; }); on(bar, 'pointerleave', function () { overBar = false; showTools(); }); });
      // the stage hidden: a slim bar [pad chip ▾] Stage hidden … [🔼 Show stage]
      // (1.99ajf dockclean review: no "Stage hidden" words beside 📺 Show stage - they said the same thing and squeezed the pad's name)
      // (the homepage has no Hide stage, so no slim bar for it either)
      if (mode !== 'preview') {
        var mini = el('div', 'rmd-mini'); mini.id = 'rmdMini'; mini.hidden = true; mini.appendChild(padChip('rmd-chip-mini'));
        mini.appendChild(el('span', 'rmd-ov-gap'));
        showStageBtn = button(IC.show, 'restore_stage', 'Show stage', function () { hideStage(false, true); });
        mini.appendChild(showStageBtn);
        stage.parentNode.insertBefore(mini, stage);
      }
      on(stage, 'pointermove', function (e) { if (e.pointerType !== 'touch') showTools(); });
      on(stage, 'pointerdown', function (e) {
        if (e.pointerType === 'touch') {
          var ctl = e.target.closest && e.target.closest('.rmd-ov-top,.rmd-ov-bot,.rmd-strip,button,a,input,select');
          if (!ctl && stage.classList.contains('rmd-controls-on')) { hideTools(); return; }
          showTools(!stage.classList.contains('rmd-ov-armed'));
          return;
        }
        showTools();
      });
      on(stage, 'pointerleave', function () { clearTimeout(autoTimer); autoTimer = setTimeout(function () { if (!overlayHot()) offTools(); }, HIDE_MS); });
      on(stage, 'focusin', function () { showTools(); });
      on(stage, 'patv:stagechange', function (e) { stageChanged(e.detail); paintSource(); paintCapture(); });
      // the pinned cams live inside the stage card (owner point 28 / targets 172-173): a column at the inline end, a row on phones
      if (strip) { stage.appendChild(strip); strip.classList.add('rmd-strip'); }
      observe(node('rmCap'), paintCapture, { childList: true, subtree: true, attributes: true });
      observe(srcBox, paintSource, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'class'] });
      showTools();
    }

    // ── the chat card's one header row (owner points 8, 18) ──
    // the chat ⋯ - pad: 📅 · ⬇ · 🪟 Float chat · ↗️ Chat in its own window · 📜; the window: 📅 · ⬇ · 📜 · ↩️ Back in the pad tab;
    // the homepage: ↗️ · ℹ️ About this chat (it never had history or search)
    function chatMenu(opener) {
      var box = menu(opener, t('chat_menu', 'Chat options'));
      if (mode === 'preview') {
        if (canWindow()) menuItem(box, IC.win, 'chat_window', 'Chat in its own window', function () { popWindow(); }, { tip: t('chat_window_tip', 'Opens the chat in its own window, which stays open while you browse the site') });
        if (o.preview && o.preview.about) menuItem(box, 'ℹ️', 'chat_about', 'About this chat', aboutChat, { keep: true });
        finishMenu(box, opener); return;
      }
      var jump = node('rmHistJump'); if (jump && !jump.hidden) menuItem(box, '📅', 'jump_date', 'Jump to a date', function () { external(function () { jump.click(); }); });
      // 1.99ajq dockpol (owner item 2): the pad's ONE "Show real names" switch (room.ejs roomReveal - the same POST /api/chatlog/seethrough,
      // the same audit rows and reason prompt), offered exactly when the old banner was; a notice says it once when it changes
      var rv = o.reveal;
      if (rv && rv.offered && rv.offered()) {
        menuItem(box, '🪪', 'show_real_names', 'Show real names', function () { rv.flip(); }, { role: 'menuitemcheckbox', checked: rv.state() === true, sub: t('real_names_sub', 'every reveal is logged'), disabled: !!(rv.busy && rv.busy()) });
      }
      var dl = o.download;
      if (dl && dl.items) dl.items().forEach(function (it) {
        var mi = menuItem(box, '⬇', 'raw', it.label.replace(/^⬇\s*/, ''), function () { dl.run(it.id, chatMore); });
        mi.querySelector('.rmd-label').textContent = it.label.replace(/^⬇\s*/, '');
      });
      if (mode === 'pad') {
        menuItem(box, IC.float, 'float_chat', 'Float chat', floatChat);
        if (canWindow()) menuItem(box, IC.win, 'chat_window', 'Chat in its own window', function () { popWindow(); }, { tip: t('chat_window_tip', 'Opens the chat in its own window, which stays open while you browse the site') });
      }
      var hist = node('rmHist');
      if (hist && !hist.hidden && hist.getAttribute('href')) {
        var hi = menuItem(box, '📜', 'raw', '', null, { href: hist.getAttribute('href') });
        hi.querySelector('.rmd-label').textContent = t('hist_info', 'Visitors read: {span} · how it works', { span: txt(hist).replace(/^📜\s*/, '') });
        hi.title = hist.title || ''; hi.setAttribute('aria-label', hi.querySelector('.rmd-label').textContent);
      }
      // 1.99ajn padppl: 🔔 the page's mention items (room.ejs mentionItems: "Sound when I'm mentioned", "Mute mentions from this pad") - a hook
      // only; each item is {icon, label, run, checked?}
      if (o.mentionItems) {
        var mis = []; try { mis = o.mentionItems() || []; } catch (e) { mis = []; }
        mis.forEach(function (x) {
          var mi = menuItem(box, x.icon, 'raw', '', x.run, typeof x.checked === 'boolean' ? { role: 'menuitemcheckbox', checked: x.checked } : null);
          var lb = mi.querySelector('.rmd-label'); if (lb) lb.textContent = x.label;
        });
      }
      // (the window: only while a pad tab of this pad and account has announced itself - it closes the window, that tab restores.
      // 1.99ajh dockpop review: a popped tab answers every heartbeat, and says tab-gone when it leaves - so a tab that went to Hold'em
      // is no "pad tab" here a moment later)
      if (mode === 'popout' && link && tabFresh()) menuItem(box, IC.back, 'pop_back', 'Back in the pad tab', backToTab);
      finishMenu(box, opener);
    }
    // ℹ️ About this chat (the homepage): today's read-only note - a string, or a <template> the page rendered it into (its <code> tags)
    function aboutChat() {
      var a = o.preview && o.preview.about; if (!a) return;
      var p = menu(chatMore, t('chat_about', 'About this chat')); p.setAttribute('role', 'dialog'); p.classList.add('rmd-about');
      // (1.99ajh dockpop review: a title and ✕ - on a phone it is a bottom sheet, far from the ⋯ that opened it)
      var head = el('div', 'rmd-about-h', null, p.ownerDocument); head.appendChild(el('b', null, t('chat_about', 'About this chat'), p.ownerDocument));
      head.appendChild(iconBtn('✕', 'close', 'Close', function () { closeLayer(); }, 'ds-btn ghost sm', p.ownerDocument)); p.appendChild(head);
      var body = el('p', 'rmd-topic-full', null, p.ownerDocument);
      if (typeof a === 'string') body.textContent = a; else if (a.content) body.appendChild(a.content.cloneNode(true)); else body.textContent = txt(a);
      p.appendChild(body); finishMenu(p, chatMore);
    }
    function topicPop(opener, text) {
      var box = menu(opener, t('topic_full', 'Topic')); box.setAttribute('role', 'dialog');
      box.appendChild(el('p', 'rmd-topic-full', text, box.ownerDocument)); finishMenu(box, opener);
    }
    function paintTopic() {
      var topic = node('rmTopic'); if (!topic || !topicRow) return;
      var s = txt(topic), can = !!(o.canTopic && o.canTopic());
      // (1.99ajq dockpol (owner item 14): no topic - an editor sees a muted ✏️ Set a topic that opens the same editor; everyone else nothing)
      topicRow.hidden = false;          // (an empty row is the spacer that keeps the buttons at the end)
      topic.hidden = !s;
      if (setTopicBtn) setTopicBtn.hidden = !!s || !can;
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
      // (1.99ajf dockclean review: the heading's words in their own box that never shrinks - a bare text node broke "CHAT" letter by letter)
      // (1.99ajq dockpol (owner item 14): no visible "CHAT" - the row is the topic and its buttons; the word stays the section's name, sr-only)
      Array.prototype.slice.call(h.childNodes).forEach(function (n) {
        if (n.nodeType === 3 && String(n.textContent).trim()) { h.insertBefore(el('span', 'rmd-chat-t ds-sr-only', String(n.textContent).trim()), n); n.remove(); }
      });
      // 1.99ajh dockpop: in its own window the chat's heading is the pad chip (a link to the pad, in a new tab); on the homepage a 📡 link to
      // the chat's pad follows CHAT when that pad isn't the stage's
      var word = h.querySelector('.rmd-chat-t');
      if (mode === 'popout' && word) word.replaceWith(padLink('rmd-chip-chat'));
      if (mode === 'preview' && o.preview && o.preview.roomLink && word) {
        var rl = el('a', 'rmd-room-link', '📡 ' + o.preview.roomLink.name); rl.setAttribute('href', o.preview.roomLink.href);
        rl.title = o.preview.roomLink.name; word.parentNode.insertBefore(rl, word.nextSibling);
      }
      var topic = node('rmTopic');
      if (topic) {
        topicRow = el('span', 'rmd-topic-line'); topicRow.appendChild(topic);
        if (mode !== 'preview') {
          setTopicBtn = button('✏️', 'set_topic', 'Set a topic', function () { if (o.canTopic && o.canTopic()) manageRoom(setTopicBtn, o.openTopic); }, 'ds-btn quiet sm rmd-set-topic');
          setTopicBtn.hidden = true; topicRow.appendChild(setTopicBtn);
        }
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

    // ══ 1.99ajh dockpop (owner P1): the chat in its OWN window - /p/<slug>/chat, opened from the chat ⋯ (desktop: a second window can sit
    // beside the page; phones get the float), kept running while this tab goes anywhere (Hold'em, other pads, the feed) ══
    function roomKey() { return W.PATVDockLink ? W.PATVDockLink.roomKey(o.room) : String(o.room == null ? '' : o.room).replace(/[^A-Za-z0-9_-]/g, '_'); }
    function chatUrl() { return o.chatUrl !== undefined ? o.chatUrl || null : o.slug ? '/p/' + encodeURIComponent(o.slug) + '/chat' : null; }
    function tabFresh() { return !!(tabSeen && Date.now() - tabSeen < TAB_FRESH_MS); }
    function canWindow() {
      // (1.99ajh dockpop review: the homepage passes no chatUrl when its card is the sign-in tease - the route would only send a pop-up to
      // the pad's gate page)
      if (mode === 'popout' || !chatUrl() || typeof W.open !== 'function') return false;
      var fine = false; try { fine = !!(W.matchMedia && W.matchMedia('(hover: hover) and (pointer: fine)').matches); } catch (e) { fine = false; }
      return fine && (W.innerWidth || 0) > 760;
    }
    function playingHere() { return !!(o.audio && o.audio.isPlaying && o.audio.isPlaying() && (!o.audio.playingSlug || o.audio.playingSlug() === o.slug)); }
    function inputNode() { var i = o.relay && o.relay.getInput && o.relay.getInput(); return i && i.isConnected ? i : null; }
    function setDraft(i, text) { i.value = text; try { i.dispatchEvent(new W.CustomEvent('input', { bubbles: true })); } catch (e) { /* no listeners */ } }
    function num(v, d) { v = Number(v); return isFinite(v) && v !== 0 ? v : d; }
    /** where the window opens: where it was last (patv.dock.popwin), else 420 wide at this window's inline-end edge */
    function geometry() {
      var g = null; try { g = JSON.parse(store(POP_GEO) || 'null'); } catch (e) { g = null; }
      if (!g || typeof g !== 'object') g = {};
      var sc = W.screen || {}, aw = num(sc.availWidth, 1280), ah = num(sc.availHeight, 800), al = Number(sc.availLeft) || 0, at = Number(sc.availTop) || 0;
      var w = Math.max(360, Math.min(640, Math.round(num(g.w, 420)))), h = Math.max(320, Math.min(ah, Math.round(num(g.h, Math.min(760, ah - 80)))));
      var x = typeof g.x === 'number' && isFinite(g.x) ? g.x : (Number(W.screenX) || 0) + num(W.outerWidth, aw) - w - 24;
      var y = typeof g.y === 'number' && isFinite(g.y) ? g.y : (Number(W.screenY) || 0) + 80;
      x = Math.max(al, Math.min(al + aw - w, Math.round(x))); y = Math.max(at, Math.min(at + ah - h, Math.round(y)));
      return { w: w, h: h, x: x, y: y };
    }
    function saveGeometry() {
      if (mode !== 'popout') return;
      try { store(POP_GEO, JSON.stringify({ w: W.innerWidth, h: W.innerHeight, x: W.screenX, y: W.screenY })); } catch (e) { /* private window */ }
    }
    /** ↗️ Chat in its own window - in the click (a pop-up needs the gesture); a blocked one floats the chat here instead */
    function popWindow() {
      if (popWin && !popWin.closed) { try { popWin.focus(); } catch (e) { /* gone */ } return; }
      var url = chatUrl(); if (!url) return;
      redock();
      var g = geometry(), w = null;
      try { w = W.open(url + (playingHere() ? '#listen' : ''), 'patv-chat-' + roomKey(), 'popup,width=' + g.w + ',height=' + g.h + ',left=' + g.x + ',top=' + g.y); } catch (e) { w = null; }
      if (!w || w.closed) {
        if (mode === 'pad') { floatChat(); toast(t('pop_blocked', 'Pop-ups are blocked for this site, so the chat floats here instead. Allow pop-ups for publicaccess.tv to keep it in its own window.')); }
        else toast(t('pop_blocked_home', 'Pop-ups are blocked for this site. Allow pop-ups for publicaccess.tv to open the chat in its own window.'));
        return;
      }
      popWin = w;
      enterPopped(true);
      // (1.99ajh dockpop review: this tab's focus goes to the bar's ↩️ - the menu item that opened the window is gone; focus() in a
      // background window never raises it over the new one)
      var back = popBar && popBar.querySelector('.rmd-popbar-back'); if (back && back.isConnected) { try { back.focus(); } catch (e) { /* gone */ } }
      clearTimeout(pendTimer);
      pendTimer = setTimeout(function () { if (popped && popPending) { leavePopped(null); toast(t('pop_failed', 'The chat window didn’t open.')); } }, PENDING_MS);
    }
    function buildPopBar() {
      var bar = el('div', 'rmd-popbar'); bar.setAttribute('role', 'status');
      var ic = el('span', 'ds-ic', IC.win); ic.setAttribute('aria-hidden', 'true'); bar.appendChild(ic);
      bar.appendChild(el('span', 'rmd-popbar-t', t('popped', 'Chat is open in its own window')));
      bar.appendChild(el('span', 'rmd-ov-gap'));
      var show = button('', 'popped_show', 'Show it', function () { if (popWin && !popWin.closed) { try { popWin.focus(); } catch (e) { /* gone */ } } }, 'ds-btn quiet sm rmd-popbar-show');
      bar.appendChild(show);
      bar.appendChild(button(IC.back, 'redock', 'Bring it back', bringBack, 'ds-btn sm rmd-popbar-back'));
      return bar;
    }
    function paintPopBar() {
      if (popWin && popWin.closed) popWin = null;
      var s = popBar && popBar.querySelector('.rmd-popbar-show'); if (s) s.hidden = !popWin;
    }
    /** POPPED: a window for this pad and account is open - this chat card is hidden IN PLACE (still fed by this page's own poll, so Bring it
     *  back is instant), a 44px bar takes its spot, the stage takes the freed height, and this page's room audio pauses (never heard twice) */
    function enterPopped(pending) {
      if (gone_ || mode === 'popout' || !chat) return;
      popPending = !!pending && !popped;
      if (!popped) {
        var showing = root.querySelector('[data-rmd-showchat][aria-pressed="true"]'); if (showing) showing.click();
        if (current && current.kind !== 'full') redock();
        closeLayer(false);
        popped = true;
        root.classList.add('rmd-popped');
        if (!popBar) popBar = buildPopBar();
        if (chat.parentNode) chat.parentNode.insertBefore(popBar, chat);
        each(root.querySelectorAll('[data-rmd-showchat]'), function (b) { b.hidden = true; });
        if (playingHere()) o.audio.pause();
        if (o.onPopped) { try { o.onPopped(true); } catch (e) { /* the page's own */ } }
        changed();
      }
      paintPopBar(); watchAlive();
    }
    function leavePopped(m) {
      clearTimeout(pendTimer); clearTimeout(handTimer); clearTimeout(aliveTimer); aliveTimer = null;
      if (!popped) return;
      var wasBringing = bringing, resumed = resumedInClick, opener = !!popWin;
      popped = false; popPending = false; bringing = false; resumedInClick = false;
      root.classList.remove('rmd-popped'); if (popBar && popBar.parentNode) popBar.remove();
      each(root.querySelectorAll('[data-rmd-showchat]'), function (b) { b.hidden = false; });
      // (1.99ajh dockpop review: the window we hold stays ours while it is open - a reloading window comes straight back, and Show it with it)
      if (popWin && popWin.closed) popWin = null;
      // the window's draft and room audio come back to ONE place: the tab the hand-over names (the one whose Bring it back asked), or for a
      // window closed by its own ✕ the tab that opened it, else a visible tab - two pad tabs of this pad never both get the draft (1.99ajh
      // dockpop review: the same words could be sent twice)
      var mine = !!m && (m.to ? m.to === (link && link.id) || (m.to === '*' && opener) : m.t === 'pop-closed' && (opener || !D.hidden));
      var input = inputNode();
      // (a tab that kept words of its own - it wasn't the one that handed its draft over - keeps them, the window's follow: nothing typed is lost)
      if (m && m.draft && mine && input) {
        var have = String(input.value || '');
        if (!have.trim()) setDraft(input, m.draft);
        else if (have.indexOf(m.draft) < 0) setDraft(input, (have.replace(/\s+$/, '') + ' ' + m.draft).slice(0, Number(input.maxLength) > 0 ? Number(input.maxLength) : 300));
      }
      if (o.onPopped) { try { o.onPopped(false); } catch (e) { /* the page's own */ } }
      changed();
      // the room audio comes back here when the window was playing it: in the Bring it back click itself (resumedInClick), else for
      // that one tab (a blocked autoplay shows "tap ▶ to resume")
      if (m && m.audio && !resumed && mine && o.audio && o.audio.resume) { try { o.audio.resume(); } catch (e) { /* blocked */ } }
      if (wasBringing && input) input.focus();
    }
    function watchAlive() {
      clearTimeout(aliveTimer);
      aliveTimer = setTimeout(function tick() {
        aliveTimer = null; if (!popped) return;
        paintPopBar();
        // a crashed / killed window: no heartbeat for 15 s (a window still being opened has its own 6 s wait)
        // (a minimized / hidden window beats at the browser's pace - up to once a minute: it said so, and gets 90 s)
        if (!popPending && Date.now() - lastAlive > (lastSlow ? SLOW_DEAD_MS : DEAD_MS)) { leavePopped(null); return; }
        aliveTimer = setTimeout(tick, ALIVE_MS);
      }, ALIVE_MS);
    }
    /** ↩️ Bring it back: the window hands over its draft and closes; its audio resumes HERE, inside this click (the gesture plays it) */
    function bringBack() {
      if (!popped) return;
      bringing = true; resumedInClick = false;
      if (lastAudio && o.audio && o.audio.resume) { try { resumedInClick = !!o.audio.resume(); } catch (e) { resumedInClick = false; } }
      if (!link || !link.ok || popPending) { if (popWin && !popWin.closed) { try { popWin.close(); } catch (e) { /* not ours */ } } leavePopped(null); return; }
      link.send('pop-close-req');
      clearTimeout(handTimer); handTimer = setTimeout(function () { leavePopped(null); }, HANDOFF_MS);
    }
    /** the pad tab / homepage side of the channel */
    function tabMsg(m) {
      if (m.t === 'pop-open' || m.t === 'pop-alive') {
        // (1.99ajh dockpop review: the viewer played this room HERE while its window was open - this page stopped being popped for that
        // window, so its heartbeats no longer pop it again; a new window - another id - does)
        if (m.t === 'pop-open') detached = null;
        if (detached && m.id === detached) return;
        winId = m.id; lastAlive = Date.now(); lastAudio = m.audio ? 1 : 0; lastSlow = !!m.slow;
        if (popped && popPending) { popPending = false; clearTimeout(pendTimer); }
        if (!popped) enterPopped(false);
        if (mode === 'pad') link.send('tab-here');
        if (m.t === 'pop-open' && popWin) {
          // the opener's unsent words go to the new window (it puts them in its empty input); this tab's copy is cleared (1.99ajh dockpop
          // review: only the tab that opened it - a second pad tab of this pad keeps its own words, hidden with its chat card)
          var input = inputNode();
          if (input && input.value.trim()) { link.send('draft', { draft: input.value }); setDraft(input, ''); }
        }
        paintPopBar();
      } else if (m.t === 'pop-closed' || m.t === 'handoff') leavePopped(m);
      else if (m.t === 'audio-on') { if (playingHere()) o.audio.pause(); }
    }
    /** this page's room audio started for the popped room (the homepage's Top Pads 🎧): its own chat card comes back, with its audio bar -
     *  the window keeps running (it paused on audio-on) */
    var detached = null, winId = null;
    function detach() { if (!popped || bringing || popPending) return; detached = winId; leavePopped(null); }
    /** the window's side of the channel */
    var handed = false, beatTimer = null, leaving = false;
    function popMsg(m) {
      if (m.t === 'who') link.send('pop-alive', { audio: playingHere(), slow: D.hidden });
      else if (m.t === 'tab-here') tabSeen = Date.now();
      else if (m.t === 'tab-gone') tabSeen = 0;           // (1.99ajh dockpop review: the pad tab went elsewhere - Hold'em, another pad)
      else if (m.t === 'pop-close-req') handOff(m.id);
      else if (m.t === 'draft') { var input = inputNode(); if (input && !input.value && m.draft) setDraft(input, m.draft); }
      else if (m.t === 'pop-open') {
        // a newer window for this pad and account: the newest wins (two windows would poll twice and play the room twice)
        if (playingHere()) o.audio.pause();
        retire('pop_moved', 'This chat is open in a newer window.');
      } else if (m.t === 'audio-on') { if (playingHere()) o.audio.pause(); }
    }
    function handOff(to) {
      if (handed || gone_) return; handed = true;
      var input = inputNode(), draft = input ? input.value : '', audio = playingHere();
      if (audio) o.audio.pause();
      if (link) link.send('handoff', { draft: draft, audio: audio, to: to || '*' });
      saveGeometry();
      try { W.close(); } catch (e) { /* not a window this site opened */ }
      setTimeout(function () { if (!W.closed) retire('pop_back_done', 'The chat is back in the pad tab.'); }, 400);
    }
    function backToTab() {
      try { if (W.opener && !W.opener.closed && W.opener.focus) W.opener.focus(); } catch (e) { /* another origin / gone */ }
      handOff(null);
    }
    function beat() {
      clearTimeout(beatTimer);
      beatTimer = setTimeout(function () { beatTimer = null; if (gone_ || !link || leaving) return; link.send('pop-alive', { audio: playingHere(), slow: D.hidden }); beat(); }, ALIVE_MS);
    }
    function recheck() { if (o.recheck) { try { o.recheck(); } catch (e) { /* the page's own */ } } }
    /** another viewer tag on the channel. 1.99ajh dockpop review (load): only the WINDOW re-checks (it must never show another account's
     *  chat; it compares vt on every answer). A pad tab or the homepage compares nothing, so a stale one heard every window heartbeat as
     *  "foreign" and re-polled every 5 s - they re-check on 'session' only. A tab still waiting for the window it just opened, when that
     *  window announces itself under another account (this tab was made for an older sign-in), stops waiting and says so. */
    function tabForeign(m) {
      if (popPending && m.t === 'pop-open' && m.room === roomKey()) { leavePopped(null); toast(t('pop_stale', 'The chat window opened for the account you’re signed in with now. Reload this page to match it.')); }
    }
    function openLink() {
      if (!W.PATVDockLink || o.room == null || o.room === '') return;
      link = W.PATVDockLink.open({ room: roomKey(), tag: o.vt || '', role: mode === 'popout' ? 'pop' : mode === 'preview' ? 'home' : 'tab',
        onMsg: mode === 'popout' ? popMsg : tabMsg, onForeign: mode === 'popout' ? recheck : tabForeign, onSession: recheck });
      // one room is never heard twice: whoever starts it tells the others
      if (o.audio && o.audio.onChange) o.audio.onChange(function (now) {
        if (!now || now !== o.slug || !link || gone_) return;
        link.send('audio-on');
        if (mode !== 'popout' && popped) detach();
      });
      if (mode === 'popout') { link.send('pop-open', { audio: playingHere() }); beat(); }
      else { if (mode === 'pad') link.send('tab-here'); link.send('who'); }
    }
    function stopLink() { clearTimeout(beatTimer); clearTimeout(aliveTimer); clearTimeout(pendTimer); clearTimeout(handTimer); if (link) { link.close(); link = null; } }
    /** the window is done (signed out / another account / a newer window): every Dock layer closes and one card says why */
    function retire(key, fallback) {
      if (gone_) return;
      // (the page stops its poll and audio and wipes what it shows, then asks for the card - roomDock.gone)
      if (o.onRetire) { try { o.onRetire(key, fallback); } catch (e) { /* the page's own */ } }
      if (!gone_) goneCard(key, fallback);
    }
    function goneCard(key, fallback) {
      // (the pad tab this window popped comes back at once - no draft, no audio: this window shows nothing any more; not when a newer
      // window took over - the tab stays popped for that one)
      if (mode === 'popout' && link && !handed && !gone_ && key !== 'pop_moved') link.send('pop-closed', { audio: false });
      gone_ = true;
      closeLayer(false); redock(); stopLink();
      if (o.mod && o.mod.closeMenu) { try { o.mod.closeMenu(false); } catch (e) { /* none open */ } }
      var old = root.querySelector('.rmd-gone'); if (old) old.remove();
      var card = el('section', 'card rmd-gone'); card.setAttribute('role', 'alert');
      card.appendChild(el('p', null, t(key, fallback)));
      // (1.99ajh dockpop review: signed IN in another tab - the window can show the chat as that account, but only when the viewer asks)
      var row = el('div', 'rmd-gone-acts'); card.appendChild(row);
      row.appendChild(button('✕', 'pop_close', 'Close this window', function () { try { W.close(); } catch (e) { /* not ours */ } }, 'ds-btn primary'));
      if (key === 'pop_signed_in') row.appendChild(button('🔄', 'pop_reload', 'Reload', function () { try { W.location.reload(); } catch (e) { /* gone */ } }, 'ds-btn'));
      if (chat && chat.parentNode) { chat.parentNode.insertBefore(card, chat); chat.hidden = true; } else root.appendChild(card);
      var b = card.querySelector('button'); if (b) b.focus();
    }
    /** 1.99ajh dockpop review: in the chat's own window a link never takes the window away from the chat (a profile, /privacy, the packs,
     *  a web user's page - and the chat ended, its tab restored): it opens in a new tab (noopener; noreferrer when it leaves the site).
     *  Sign in stays HERE and comes back to this window (?next= the window), and so do this window's own links. A modified click is the
     *  browser's own; a click a page script already handled (defaultPrevented) is left alone. */
    function popLink(e) {
      if (!e || e.defaultPrevented || e.button > 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || a.hasAttribute('download')) return;
      var href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || /^(?:javascript|mailto|tel|sms):/i.test(href)) return;
      var here = W.location || {}, u = null;
      try { u = new W.URL(href, here.href); } catch (x) { return; }
      var same = u.origin === here.origin;
      if (same && u.pathname === '/login') { a.setAttribute('href', '/login?next=' + encodeURIComponent(here.pathname)); a.removeAttribute('target'); return; }
      if (same && u.pathname === here.pathname) return;
      var rel = String(a.getAttribute('rel') || '');
      if (a.getAttribute('target') && a.getAttribute('target') !== '_self') { if (!/\bnoopener\b/.test(rel)) a.setAttribute('rel', (rel + ' noopener').trim()); return; }
      a.setAttribute('target', '_blank'); a.setAttribute('rel', same ? 'noopener' : 'noopener noreferrer');
    }
    // ── the pad chip as a LINK (the window's chat header, the homepage's stage card): the pad's identity + › ──
    function padLink(cls) {
      var a = el('a', 'rmd-chip rmd-chip-link' + (cls ? ' ' + cls : '')); a.setAttribute('href', o.padHref || '/p/' + encodeURIComponent(o.slug || ''));
      if (template) identity(a); else a.appendChild(el('span', 'rmd-chip-plain', '📡 ' + (o.padName || o.slug || '')));
      var arrow = el('span', 'rmd-chip-v', IC.open); arrow.setAttribute('aria-hidden', 'true'); (a.querySelector('.rmd-id-content') || a).appendChild(arrow);
      var nm = a.querySelector('.rm-nm'), name = txt(nm) || o.padName || D.title;
      a.setAttribute('aria-label', t('open_pad', 'Open the pad: {name}', { name: name })); a.title = a.getAttribute('aria-label');
      if (mode === 'popout') { a.target = '_blank'; a.rel = 'noopener'; }
      return a;
    }
    /** the homepage: the front pad changed mid-session - the chip becomes a plain '📡 {title} ›' link (the cosmetics were the old pad's) */
    function retitle(href, title) {
      each(root.querySelectorAll('.rmd-chip-link'), function (a) {
        a.textContent = ''; a.setAttribute('href', href);
        a.appendChild(el('span', 'rmd-chip-plain', '📡 ' + title));
        var arrow = el('span', 'rmd-chip-v', IC.open); arrow.setAttribute('aria-hidden', 'true'); a.appendChild(arrow);
        a.setAttribute('aria-label', t('open_pad', 'Open the pad: {name}', { name: title })); a.title = a.getAttribute('aria-label');
      });
    }

    function update(d) {
      var previous = data; data = d || {}; if (!ready) return;
      if (o.mod && o.mod.closeMenu) {
        var personMenu = D.querySelector('.pm-pop'), login = personMenu && String(personMenu._login || '').toLowerCase();
        function namedMember(value) { return !!(login && value && Array.isArray(value.members) && value.members.some(function (u) { return u && !u.veil && !u.anon && String(u.login || '').toLowerCase() === login; })); }
        if ((data.removed && data.removed.length) || (data.redo && data.redo.length) || (namedMember(previous) && !namedMember(data))) o.mod.closeMenu(false);
      }
      // (1.99ajf dockclean review: the 💸 Tip list redraws in place; a ⚔️ / 🥊 stake sheet closes only when its person is no longer a
      // named member here - not on every cam / mic flip)
      if (layer && (layer.kind === 'tts' && (!hasCmd('!say') || layer.price !== cmds()['!say']) || layer.kind === 'pvp' && !pvpFor(layer.who))) closeLayer();
      if (layer && layer.kind === 'tip' && layer.redraw) layer.redraw();
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
    // 1.99ajh dockpop (owner P1): Live / Feed / About - the 100dvh frame follows the tab; a floating chat and a stage in picture-in-picture
    // stay exactly as they are (the same nodes, position, scroll, draft, outbox, poll and room audio - the float is a child of <main>,
    // outside the hidden Live panel); only a fullscreen view goes back
    function tabChanged(tab) {
      var fa = D.activeElement, heroFocus = !!(fa && fa.closest && fa.closest('#rmHero, #padTabs'));
      var live = tab === 'live'; D.body.classList.toggle('pad-dock-live', live);
      // (1.99ajq dockpol (owner item 11): Feed / About in the same frame as Live - no footer, the same width; body.rmd-dock-pad marks it)
      D.body.classList.add('rmd-dock-pad');
      if (!live) { closeLayer(false); if (current && current.kind === 'full') redock(); }
      // (1.99ajq dockpol fix (review): Home / ← to Live on the tab bar - that bar isn't on Live, so focus goes to the stage's pad chip, whose
      // menu has Feed and About, instead of falling to <body>)
      else if (heroFocus) setTimeout(function () {
        var a = D.activeElement; if (a && a !== D.body && a.isConnected && a.getClientRects().length) return;
        var c = stage && stage.querySelector('.rmd-ov-top .rmd-chip'); if (c) { try { c.focus({ preventScroll: true }); } catch (e) { c.focus(); } }
      }, 0);
    }
    // Feed / About: one slim header row - [pad identity] [● Live · Feed · About] [Follow] [▾ pad menu] (owner point 4)
    // 1.99ajq dockpol (owner item 11): ONE slim 44px card - [the pad chip ▾ (the same component and menu as on Live)] … [Live · Feed · About]
    // [Follow]; the header's own identity row is the page's h1 for screen readers only. A tab switch starts at the page's top, inside a
    // short cross-fade where the browser has view transitions (none under reduced motion) - pad-tabs.js asks W.PATVPadSwitch.
    function buildHeader() {
      var hero = node('rmHero'), tabsNav = node('padTabs'), hd = hero && hero.querySelector('.hd');
      if (!hd || !tabsNav) return;
      hero.classList.add('rmd-slimhead');
      tabsNav.classList.add('ds-seg', 'rmd-seg');
      each(tabsNav.querySelectorAll('.ptab'), function (b) { var w = txt(b); if (w && !b.getAttribute('aria-label')) b.setAttribute('aria-label', w); });
      var acts = hd.querySelector('.hd-acts'); hd.insertBefore(tabsNav, acts || null);
      hd.insertBefore(padChip('rmd-chip-head'), hd.firstChild);
      W.PATVPadSwitch = function (fn) {
        try { W.scrollTo(0, 0); } catch (e) { /* old engine */ }
        var reduce = false; try { reduce = !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduce = false; }
        if (!reduce && D.startViewTransition) { try { D.startViewTransition(fn); return; } catch (e) { /* run it plain */ } }
        fn();
      };
    }
    // ── 1.99ajq dockpol (owner item 9): the navbar steps aside on a phone's Live view - the reader scrolling the chat toward newer lines
    // (24px of their own scrolling) or typing hides it; scrolling back 48px, a swipe down on the stage, a tap on the stage with its overlay
    // up, or focus in the navbar brings it back. Never while one of its menus is open, never in fullscreen / picture-in-picture / the
    // floating chat. It stays in the DOM and the tab order (no hidden / inert): always reachable; the pad menu says ☰ Site menu meanwhile. ──
    var navHeader = null, navOff = false;
    function navOk() {
      var mq = false; try { mq = !!(W.matchMedia && W.matchMedia('(max-width: 760px)').matches); } catch (e) { mq = false; }
      return mq && D.body.classList.contains('pad-dock-live') && !(current && (current.kind === 'full' || current.kind === 'float')) && !inPip();
    }
    function navBusy() { return !!(navHeader && navHeader.querySelector('[aria-expanded="true"], details[open], .open, .show')); }
    function setNav(off) {
      off = !!off && navOk() && !navBusy();
      if (off === navOff) return;
      navOff = off;
      if (navHeader) navHeader.style.marginBlockStart = off ? -(navHeader.offsetHeight || 58) + 'px' : '';   // (its own height: the Dock takes it)
      D.body.classList.toggle('rmd-nav-off', off);
    }
    function navSync() { var okNow = navOk(); D.body.classList.toggle('rmd-nav-auto', okNow); if (!okNow) setNav(false); }
    // (1.99ajq dockpol fix (review): only the READER's scrolling counts - never the log's own jump to its newest line (room.ejs toBottom
    // marks it: scroll.__rmdProg) or a scroll the box's height change caused (the navbar's own 180 ms step, a toast, a sheet), which had the
    // two fighting: the navbar flickered and the log snapped back. And the common case: a reader AT the newest line can't scroll toward newer,
    // so a swipe up there (the finger moving up 32px) hides it too. While it is off, ☰ on the stage's top bar brings it back.)
    function navAuto() {
      each(D.body.children, function (n) { if (!navHeader && n.tagName === 'HEADER') navHeader = n; });
      var scroll = node('rmScroll'); if (!navHeader || !scroll) return;
      var userAt = 0, lastTop = null, lastCh = -1, acc = 0, swipe = null, drag = null;
      ['wheel', 'touchstart', 'touchmove', 'keydown'].forEach(function (k) { scroll.addEventListener(k, function () { userAt = Date.now(); }, { passive: true }); });
      on(scroll, 'scroll', function () {
        var top = scroll.scrollTop, ch = scroll.clientHeight, d = lastTop == null ? 0 : top - lastTop; lastTop = top;
        if (scroll.__rmdProg != null && Math.abs(top - scroll.__rmdProg) < 1) { acc = 0; lastCh = ch; return; }   // (the log's own jump to its end)
        if (ch !== lastCh) { lastCh = ch; acc = 0; return; }                                               // (the box changed height)
        if (!navOk() || Date.now() - userAt > 1500 || !d) return;
        if ((d > 0) !== (acc > 0)) acc = 0;
        acc += d;
        if (acc >= 24) { acc = 0; setNav(true); } else if (acc <= -48) { acc = 0; setNav(false); }
      });
      // (the finger moving up on a log that is at its newest line: nothing to scroll, the same wish - more room for the chat)
      scroll.addEventListener('touchstart', function (e) { var p = e.touches && e.touches.length === 1 ? e.touches[0] : null; drag = p ? { y: p.clientY } : null; }, { passive: true });
      scroll.addEventListener('touchmove', function (e) {
        var p = e.touches && e.touches[0]; if (!drag || !p || !navOk() || navOff) return;
        if (drag.y - p.clientY >= 32 && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2) { drag = null; setNav(true); }
      }, { passive: true });
      scroll.addEventListener('touchend', function () { drag = null; }, { passive: true });
      var input = o.relay && o.relay.getInput && o.relay.getInput();
      if (input) on(input, 'focus', function () { setNav(true); });
      on(navHeader, 'focusin', function () { setNav(false); });
      if (stage) {
        on(stage, 'pointerdown', function (e) {
          if (stage.classList.contains('rmd-controls-on') && !(e.target.closest && e.target.closest('button,a,input,select'))) setNav(false);
        }, true);
        // (touch events, not pointer ones: a vertical swipe makes the browser cancel the pointer stream)
        stage.addEventListener('touchstart', function (e) { var p = e.touches && e.touches[0]; swipe = p ? { y: p.clientY, at: Date.now() } : null; }, { passive: true });
        stage.addEventListener('touchend', function (e) { var p = e.changedTouches && e.changedTouches[0]; if (swipe && p && p.clientY - swipe.y >= 32 && Date.now() - swipe.at < 1200) setNav(false); swipe = null; }, { passive: true });
      }
      on(W, 'resize', navSync); on(D, 'patv:padtab', navSync); navSync();
    }
    function start() {
      if (ready || dead) return;
      ready = true; stage = node('rmStage'); chat = node('rmChat'); strip = node('rmStrip'); compose = node('rmCompose');
      panel = node('padPanel-live'); template = node('rmdId');
      side = root.querySelector('.rm-live > .side'); if (side) side.classList.add('rmd-side');
      // 1.99ajh dockpop: the window is the chat card alone (no stage, header, strip or tabs); the homepage has no pad header, strip or tabs
      if (mode === 'pad') buildHeader();
      if (stage && mode !== 'popout') buildStage();
      if (chat) { buildChatHead(); toastBox(); }
      decoratePeople();
      if (strip && mode === 'pad') { observe(strip, decorateCams); decorateCams(); }
      decorateComposer(); attachDoc(D);
      // (1.99ajq dockpol fix: the flairs' fit - when the people list, the audio bar or the log change width, and for each new line)
      fitOnResize(node('rmPeople')); fitOnResize(node('rmAudioBox')); fitOnResize(node('rmScroll'));
      [node('rmFeed'), node('rmOlder')].forEach(function (box) { observe(box, function (ms) { ms.forEach(function (m) { each(m.addedNodes, function (x) { if (x.nodeType === 1) fitSoon(x); }); }); }, { childList: true }); });
      on(D, 'fullscreenchange', function () { if (current && current.kind === 'full' && !D.fullscreenElement) redock(); });
      if (mode === 'pad') on(D, 'patv:padtab', function (e) { tabChanged(e.detail && e.detail.tab); });
      on(W, 'pagehide', function () {
        leaving = true;
        if (mode === 'popout' && link && !handed && !gone_) {
          var input = inputNode(), audio = playingHere();
          link.send('pop-closed', { audio: audio, draft: input ? input.value : '' });
          // (1.99ajh dockpop review: a window that RELOADS was playing the room - it picks it up again, room.ejs reads this; the tab it
          // restored for a moment pauses again on the new pop-open. The window's own sessionStorage: it dies with the window)
          try { if (audio) W.sessionStorage.setItem(LISTEN_KEY + o.slug, '1'); else W.sessionStorage.removeItem(LISTEN_KEY + o.slug); } catch (e) { /* private mode */ }
        }
        // (1.99ajh dockpop review: a pad tab that leaves - for Hold'em, another pad - is no "pad tab" for the window's ↩️ any more)
        if (mode === 'pad' && link) link.send('tab-gone');
        saveGeometry();
        redock(); if (pip) pip.close();
      });
      if (mode === 'popout') {
        on(D, 'click', popLink, true);
        var geoTimer = null;
        on(W, 'resize', function () { clearTimeout(geoTimer); geoTimer = setTimeout(saveGeometry, 400); });
        // (going hidden - minimized, another window over it: one beat now that says the next ones may be slow)
        // (never after pagehide: a closing window's last word is pop-closed)
        on(D, 'visibilitychange', function () { if (link && !gone_ && !handed && !leaving) link.send('pop-alive', { audio: playingHere(), slow: D.hidden }); });
      }
      openLink();
      if (mode === 'pad') tabChanged(panel && !panel.hidden ? 'live' : 'feed');
      if (o.reveal && o.reveal.onChange) o.reveal.onChange(revealNote);
      if (mode === 'pad') navAuto();
      update(data);
    }
    // the reveal switch's one notice (owner item 2): on - the audited words for 5 s; off - 3 s; on after a reload - once; a failure - 8 s
    function revealNote(ev) {
      if (!ev) return;
      if (ev.type === 'on') chatToast(tr('js.pad.veil.toast_on', 'Showing who’s behind frog names on this pad - every reveal is logged.'), { id: 'veil', ms: 5000 });
      else if (ev.type === 'off') chatToast(tr('js.pad.veil.toast_off', 'Frog names are hidden again.'), { id: 'veil', ms: 3000 });
      else if (ev.type === 'error') chatToast(ev.text || tr('js.pad.veil.toast_err', 'Couldn’t change it - try again.'), { id: 'veil', ms: 8000, bad: true });
    }
    if (D.readyState === 'loading') on(D, 'DOMContentLoaded', start); else start();
    return {
      update: update, mic: mic, personLine: personLine, visible: visible, redock: redock, stageChanged: stageChanged,
      pvp: pvp, pvpFor: pvpFor, peopleDrawn: function () { filterPeople(); paintInfo(); fitSoon(node('rmPeople')); }, participants: participants,
      // 1.99ajh dockpop
      floating: function () { return !!(current && current.kind === 'float'); },
      popped: function () { return popped; }, popWindow: popWindow, canWindow: canWindow, bringBack: bringBack,
      gone: function (key, fallback) { goneCard(key || 'pop_gone', fallback || 'You signed out or switched accounts in another tab, so this chat window is closed.'); },
      retitle: retitle,
      // 1.99ajq dockpol: the chat card's notices, a composer command's state (room-bridge.js onCmd), who the mic stage says is talking
      toast: function (text, opts) { return chatToast(text, opts); }, cmd: cmdToast, talking: talking,
      destroy: function () { dead = true; stopLink(); redock(); returnCam(); closeLayer(false); observers.forEach(function (m) { m.disconnect(); }); clearTimeout(autoTimer); clearTimeout(toastTimer); listeners.forEach(function (x) { x[0].removeEventListener(x[1], x[2], x[3]); }); D.body.classList.remove('pad-dock-live', 'rmd-afloat', 'rmd-dock-pad', 'rmd-nav-auto', 'rmd-nav-off'); if (W.PATVPadSwitch && mode === 'pad') W.PATVPadSwitch = null; }
    };
  }
  W.PATVPadDock = { init: init };
})(window, document);
