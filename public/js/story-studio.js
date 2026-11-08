// Story Studio (1.99alq): local drafts, one shared overlay renderer, and a versioned server edit.
// No media leaves the device before Post. Mentions remain removable data, never overlay pixels.
// storyux (1.99??): direct manipulation, no sliders (the owner, iPhone, 2026-11-08). On the picture (the stage):
//   a layer (text / sticker / mention)   tap = select it (an outline, a delete handle and - on a pointer - a turn/size corner);
//                                        one finger drags it; two fingers pinch it and twist it at once; a double tap on a
//                                        text edits its words. It stays in the frame (its turned box) and snaps to the centre
//                                        lines (a guide shows) and to square turns.
//   nothing selected                    the picture itself: one finger pans, two zoom about the fingers; a double tap puts
//                                        it back. Fill never shows empty space; Fit may (black), within its limits.
//   desktop                              drag; the wheel (or ctrl+wheel - a trackpad pinch) sizes the selected layer or zooms
//                                        the picture, Shift+wheel turns; the corner handle turns and sizes
//   keyboard                             a focused layer: arrows move, + − size, [ ] turn, Delete removes, Enter edits words;
//                                        the focused picture: arrows pan, + − zoom, 0 resets
// Gestures are pointer events on the stage (touch-action: none) batched per animation frame; WebKit's own gesture events
// stand in when a second finger never reaches the pointer stream. After a pick or a capture only an X stays (back to the
// camera, or the picker; a quiet question first when there are edits), and every icon button is a round icon whose words
// are its aria-label and tooltip. The posted story matches the preview: the overlay is the same canvas, and the picture's
// window goes as Fill's crop or Fit's frame (storycompose.js renders both from the same window).
(function () {
  'use strict';
  if (window.patvStoryStudio) return;
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var W = 1080, H = 1920, CHUNK = 512 * 1024, current = null, serial = 0;
  // ssfix (1.99alt): a phone hands the page over to its camera or photo picker, and iOS may reclaim the hidden tab meanwhile and
  // bring it back RELOADED - the picture then reaches nobody and the studio is simply gone. While a picker is open, a small note in
  // this tab's session (which picker, the destination, the NSFW choice - never media) remembers it; a page that comes back
  // reloaded with an unanswered note reopens the studio there and says what happened. An answer, a cancel or a close drops it.
  // ssfix2 (1.99alt): the note lives until the picture has OPENED (phase 'arrived' after the change event: decoding a 12 MP photo
  // right after the camera is the memory peak), and any kind of page load counts - WebKit brings a killed page back through
  // WebPageProxy::launchProcessForReload, a FrameLoadType::IndexedBackForward load, so an iPhone sees navigation type 'back_forward'
  // there (a page restored from the back/forward cache never re-runs this script). A picker that comes back with neither a change
  // nor a cancel is said out loud after BACK_MS, and leaving the page after coming back drops the note (engines with no 'cancel').
  var NOTE = 'patv.storyStudio.picking', NOTE_MS = 10 * 60 * 1000, BACK_MS = 3000;
  function session() { try { return window.sessionStorage || null; } catch (e) { return null; } }
  function page() { return String(location.pathname || '') + String(location.search || ''); }
  function notePicking(s) {
    var st = session(), p = s.pending; if (!st || !p) return;
    try { st.setItem(NOTE, JSON.stringify({ v: 1, picker: p.picker, phase: p.phase, pad: s.target ? s.target.id : s.pad, nsfw: !!s.d.nsfw, at: Date.now(), page: page() })); } catch (e) { /* blocked storage: the studio works without it */ }
  }
  function dropNote() { var st = session(); if (st) try { st.removeItem(NOTE); } catch (e) { /* blocked */ } }
  function takeNote() {
    var st = session(), raw = null, note = null; if (!st) return null;
    try { raw = st.getItem(NOTE); if (raw != null) st.removeItem(NOTE); } catch (e) { return null; }
    try { note = raw == null ? null : JSON.parse(raw); } catch (e) { return null; }
    if (!note || note.v !== 1 || (note.picker !== 'camera' && note.picker !== 'gallery') || typeof note.pad !== 'string' || note.page !== page()) return null;
    if (note.phase != null && note.phase !== 'open' && note.phase !== 'arrived') return null;
    var age = Date.now() - Number(note.at); if (!(age >= 0 && age <= NOTE_MS)) return null;
    return note;
  }
  function hiddenNow() { return document.visibilityState ? document.visibilityState === 'hidden' : !!document.hidden; }
  // The pick is answered or given up: forget it (here and in the tab session).
  function settle(s) { var p = s.pending; if (p) clearTimeout(p.timer); s.pending = null; dropNote(); }
  // The picture of pick n has opened, or was refused: only then is the note done with.
  function pickDone(s, n) { if (n && s.pending && s.pending.n === n) settle(s); }
  // The page is back from the picker (or the user is touching it, so no picker is open): if no answer comes within BACK_MS, say so.
  function back(s) {
    var p = s.pending; if (!live(s) || !p || p.phase !== 'open' || !p.away || hiddenNow()) return;
    p.back = true; clearTimeout(p.timer);
    p.timer = setTimeout(function () {
      if (!live(s) || s.pending !== p || p.phase !== 'open') return;
      settle(s); tell(s, p.picker === 'camera' ? _t('js.feed.ss.no_camera_file', 'No picture arrived from the camera. Try again, or choose it from Gallery.') : _t('js.feed.ss.no_file', 'No file arrived. Try again.'));
    }, BACK_MS);
  }
  // What a picked file is: the browser's type, else its first bytes - an iOS camera or file-provider hand-off can come without a
  // usable type. The signatures are the server's (feedmedia.sniff), which checks the assembled upload again anyway.
  function sniff(file) {
    try {
      var head = file.slice(0, 64);
      var read = head.arrayBuffer ? head.arrayBuffer() : new Promise(function (resolve, reject) { var r = new FileReader(); r.onload = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); }; r.readAsArrayBuffer(head); });
      return read.then(function (buffer) {
        var b = new Uint8Array(buffer), at = function (o, n) { return String.fromCharCode.apply(null, Array.prototype.slice.call(b, o, o + n)); };
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image' };
        if (b[0] === 0x89 && at(1, 3) === 'PNG') return { kind: 'image' };
        if (at(0, 6) === 'GIF87a' || at(0, 6) === 'GIF89a') return { kind: 'image', gif: true };
        if (at(0, 4) === 'RIFF' && at(8, 4) === 'WEBP') return { kind: 'image' };
        if (at(0, 4) === 'RIFF' && at(8, 4) === 'AVI ') return { kind: 'video' };
        if (at(4, 4) === 'ftyp') { var brand = at(8, 4).toLowerCase(); return /^(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(brand) ? { kind: 'image' } : /^m4[abp] $/.test(brand) ? null : { kind: 'video' }; }
        if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: 'video' };
        return null;
      });
    } catch (e) { return Promise.reject(e); }
  }
  // The picture's ink palette, kept equal to padlook.PALETTE by the client test.
  var COLORS = ['#ffffff', '#000000', '#66bb6a', '#c6e94f', '#26c6da', '#4fc3f7', '#64b5f6', '#9fa8da', '#ba68c8', '#f06292', '#ef5350', '#ff8a50', '#ffca28', '#b0bec5'];
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function add(p, e) { p.appendChild(e); return e; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function chars(s) { return Array.from(String(s)); }
  function button(label, fn, cls) { var b = el('button', 'ds-btn ' + (cls || 'quiet sm'), label); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
  // storyux: a round icon with no visible words - the label's first character is the icon, the rest its name (aria-label + tooltip)
  function iconButton(label, fn, cls) {
    var b = button(null, fn, (cls || 'icon sm quiet') + ' sst-round'), ic = add(b, el('span', 'ds-ic')); ic.setAttribute('aria-hidden', 'true');
    relabel(b, label); return b;
  }
  function relabel(b, label) {
    var bits = chars(label), first = bits.shift() || ''; if (bits[0] === '\ufe0f') first += bits.shift();
    var words = bits.join('').trim() || String(label); b.setAttribute('aria-label', words); b.title = words; b.querySelector('.ds-ic').textContent = first;
  }
  function field(label, input) { var l = el('label', 'sst-field'); add(l, el('span', 'ds-label', label)); add(l, input); return l; }
  function input(type, value) { var i = el('input', 'ds-in'); i.type = type; if (value != null) i.value = value; return i; }
  function live(s) { return current === s && !s.closed; }
  // ── storyux: the geometry - pure, shared by the gestures, the keyboard and the tests (patvStoryStudio.geometry) ──
  // Frame fractions: 0..1 of the 9:16 story frame (x of its width, y of its height); canvas px: the 1080 × 1920 overlay.
  // The picture's WINDOW (d.crop) is what the frame shows of it, in picture fractions and always the 9:16 shape; its RECT is
  // the inverse - where the picture sits in the frame (the preview's CSS; storycompose.js renders from the same window).
  // Fill: the window stays inside the picture (no empty space). Fit: it may run past the picture (black there), with the
  // picture's centre kept in the frame, down to half the whole picture. Both zoom in to 8x the frame-filling size, never to a
  // window under 5% of the picture (the server checks the same).
  var G = (function () {
    var RATIO = W / H, MIN = .05, DEEP = 8, SMALL = .5, SNAP = .02, SQUARE = 4 * Math.PI / 180, TEXT = [24, 288], STICKER = [48, 960];
    function cover(own) { var w = own > RATIO ? RATIO / own : 1, h = own > RATIO ? 1 : own / RATIO; return { x: (1 - w) / 2, y: (1 - h) / 2, w: w, h: h }; }
    function contain(own) { var w = own > RATIO ? 1 : RATIO / own, h = own > RATIO ? own / RATIO : 1; return { x: (1 - w) / 2, y: (1 - h) / 2, w: w, h: h }; }
    function rect(win) { return { x: -win.x / win.w, y: -win.y / win.h, w: 1 / win.w, h: 1 / win.h }; }
    // the window widths a layout allows: [the deepest zoom, the widest]
    function widths(own, fit) { var c = cover(own), k = contain(own), min = Math.max(c.w / DEEP, MIN, MIN * c.w / c.h); return [min, Math.max(min, fit === 'fill' ? c.w : k.w / SMALL)]; }
    function canFill(own) { var c = cover(own); return Math.min(c.w, c.h) >= MIN; }
    function place(win, own, fit) {
      var x = fit === 'fill' ? clamp(win.x, 0, Math.max(0, 1 - win.w)) : clamp(win.x, .5 - win.w, .5);
      var y = fit === 'fill' ? clamp(win.y, 0, Math.max(0, 1 - win.h)) : clamp(win.y, .5 - win.h, .5);
      return { x: x, y: y, w: win.w, h: win.h };
    }
    // a pinch: k times the size, the picture point under f0 (frame fractions, the fingers at the start) brought under f1
    function zoom(win, own, fit, k, f0, f1) {
      var lim = widths(own, fit), w = clamp(win.w / (k > 0 ? k : 1), lim[0], lim[1]), h = win.h * w / win.w;
      var u = win.x + f0.x * win.w, v = win.y + f0.y * win.h;
      return place({ x: u - f1.x * w, y: v - f1.y * h, w: w, h: h }, own, fit);
    }
    // a drag: the picture moved by dx, dy of the frame
    function pan(win, own, fit, dx, dy) { return place({ x: win.x - dx * win.w, y: win.y - dy * win.h, w: win.w, h: win.h }, own, fit); }
    // the window a layout starts with: the whole picture (fit), or filling the frame around the same centre (fill)
    function layout(win, own, fit) {
      if (fit !== 'fill') return contain(own);
      var c = cover(own), cx = win ? win.x + win.w / 2 : .5, cy = win ? win.y + win.h / 2 : .5;
      return place({ x: cx - c.w / 2, y: cy - c.h / 2, w: c.w, h: c.h }, own, 'fill');
    }
    function same(a, b) { return !!a && !!b && ['x', 'y', 'w', 'h'].every(function (k) { return Math.abs(a[k] - b[k]) < 1e-6; }); }
    // layers: centre (x, y) in frame fractions, size in canvas px (a text's font size; a sticker's side), rot in radians
    function stickerPx(size) { return clamp(Math.round(size / 24) * 24, STICKER[0], STICKER[1]); }
    function box(t) {
      if (t.type === 'sticker') { var p = stickerPx(t.size); return { w: p, h: p }; }
      var b = t.bounds, k = b && b.size ? t.size / b.size : 1; return b ? { w: b.w * k, h: b.h * k } : { w: t.size, h: t.size };
    }
    function spread(b, rot) { var c = Math.abs(Math.cos(rot || 0)), s = Math.abs(Math.sin(rot || 0)); return { w: b.w * c + b.h * s, h: b.w * s + b.h * c }; }
    // in the frame: the turned box inside it where it fits, else centred; a mention chip 5% in from the edges
    function keepIn(t) {
      if (t.type === 'mention') { t.x = clamp(t.x, .05, .95); t.y = clamp(t.y, .05, .95); return t; }
      var a = spread(box(t), t.rot);
      t.x = clamp(t.x, Math.min(.5, a.w / W / 2), Math.max(.5, 1 - a.w / W / 2)); t.y = clamp(t.y, Math.min(.5, a.h / H / 2), Math.max(.5, 1 - a.h / H / 2));
      return t;
    }
    function turnOf(r) { r %= 2 * Math.PI; if (r > Math.PI) r -= 2 * Math.PI; if (r <= -Math.PI) r += 2 * Math.PI; return r; }
    function angle(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }
    // two fingers from (a0, b0) to (a1, b1), client px: how much bigger, how far turned, how far the midpoint moved
    function twoFinger(a0, b0, a1, b1) {
      var d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y), d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
      return { scale: d0 > 0 ? d1 / d0 : 1, turn: turnOf(angle(a1, b1) - angle(a0, b0)), dx: (a1.x + b1.x - a0.x - b0.x) / 2, dy: (a1.y + b1.y - a0.y - b0.y) / 2 };
    }
    // a layer moved from its gesture-start state: m.dx / m.dy (client px over a frame of frame.width × frame.height) move it,
    // m.scale sizes it, m.turn turns it - each only when given (a drag never sizes; a WebKit gesture event never moves). With
    // o.snap: the centre lines and square turns pull it in. -> the guides to show { v, h, turn }
    function moveItem(t, start, m, frame, o) {
      var g = { v: false, h: false, turn: false }, snap = !!(o && o.snap), moved = m.dx != null || m.dy != null;
      if (moved) { t.x = start.x + (m.dx || 0) / frame.width; t.y = start.y + (m.dy || 0) / frame.height; }
      if (t.type !== 'mention') {
        var lim = t.type === 'text' ? TEXT : STICKER;
        if (m.scale != null) t.size = clamp(start.size * m.scale, lim[0], lim[1]);
        if (m.turn != null) {
          t.rot = turnOf((start.rot || 0) + m.turn);
          var q = Math.round(t.rot / (Math.PI / 2)) * (Math.PI / 2); if (snap && Math.abs(t.rot - q) < SQUARE) { t.rot = turnOf(q); g.turn = true; }
        }
      }
      if (snap && moved) { if (Math.abs(t.x - .5) < SNAP) { t.x = .5; g.v = true; } if (Math.abs(t.y - .5) < SNAP * W / H) { t.y = .5; g.h = true; } }
      keepIn(t); return g;
    }
    return { RATIO: RATIO, LIMITS: { text: TEXT, sticker: STICKER, deep: DEEP, small: SMALL, min: MIN, snap: SNAP },
      cover: cover, contain: contain, rect: rect, widths: widths, canFill: canFill, place: place, zoom: zoom, pan: pan, layout: layout, same: same,
      stickerPx: stickerPx, box: box, spread: spread, keepIn: keepIn, turnOf: turnOf, angle: angle, twoFinger: twoFinger, moveItem: moveItem };
  })();
  function req(url, body, method) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } };
    if (body != null) { o.method = method || 'POST'; o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok || d.ok === false) { var e = new Error(d.error || _t('js.feed.sc.failed', 'That didn\'t work.')); e.status = r.status; throw e; } return d;
    }); });
  }
  function say(s, text, error) { s.status.textContent = text || ''; s.status.setAttribute('role', error ? 'alert' : 'status'); s.status.classList.toggle('sst-error', !!error); }
  function revoke(s) { s.urls.forEach(function (u) { URL.revokeObjectURL(u); }); s.urls = []; }
  function objectURL(s, blob) { var u = URL.createObjectURL(blob); s.urls.push(u); return u; }
  function discard(ids) { return Promise.all(ids.map(function (id) { return req('/api/feed/uploads/' + encodeURIComponent(id) + '/discard', {}).catch(function () {}); })); }
  function cancel(s) {
    if (s.attempt && s.attempt.stage === 'mine') return;
    var ids = s.attempt ? s.attempt.ids.slice() : [];
    if (s.ready && ids.indexOf(s.ready.id) < 0) ids.push(s.ready.id);
    if (s.attempt) s.attempt.cancelled = true;
    discard(ids);
    s.attempt = null; s.ready = null; s.busy = false;
    if (live(s)) { s.progress.hidden = true; paintControls(s); say(s, _t('js.feed.ss.cancelled', 'Posting cancelled. Your draft is still here.')); }
  }
  function close(s, done) {
    if (!live(s)) return;
    if (!done && s.attempt && s.attempt.stage === 'mine') return;
    if (!done && (s.d.file || s.busy) && !window.confirm(_t('js.feed.ss.discard', 'Discard this story?'))) return;
    if (!done) cancel(s);
    if (s.cam) { var cam = s.cam; s.cam = null; cam.close(); }
    s.closed = true; settle(s); clearTimeout(s.suggestTimer); clearTimeout(s.wheelTimer); revoke(s); s.gesture = null; if (s.raf && window.cancelAnimationFrame) window.cancelAnimationFrame(s.raf); s.raf = 0;
    if (s.media && s.media.pause) s.media.pause();
    document.removeEventListener('keydown', s.key, true); document.removeEventListener('focusin', s.focus);
    document.removeEventListener('visibilitychange', s.vis); document.removeEventListener('pointerdown', s.touch, true);
    window.removeEventListener('blur', s.away); window.removeEventListener('focus', s.back); window.removeEventListener('pageshow', s.back); window.removeEventListener('pagehide', s.leave);
    if (s.resize) window.removeEventListener('resize', s.resize);
    if (s.viewport) window.visualViewport.removeEventListener('resize', s.viewport);
    s.root.remove(); document.body.style.overflow = s.oldOverflow; current = null;
    if (s.opener && s.opener.isConnected) s.opener.focus();
  }
  function focusables(root) { return Array.prototype.filter.call(root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'), function (n) { return !n.disabled && n.tabIndex !== -1 && !n.hidden && n.offsetParent !== null && getComputedStyle(n).visibility !== 'hidden'; }); }
  function key(s, e) {
    if (!live(s)) return;
    s.touch();
    // storyux: the quiet question first (Escape = keep editing), and a selected layer is let go before the editor closes
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (s.cam) s.cam.cancel(); else if (s.ask) unask(s, true); else if (s.suggestions && !s.suggestions.hidden) { s.suggestions.hidden = true; if (s.mentionInput) s.mentionInput.setAttribute('aria-expanded', 'false'); } else if (s.sheet) closeSheet(s); else if (picked(s)) select(s, null); else close(s); return; }
    if (e.key === 'Tab') {
      var list = focusables(s.sheet || s.root), i = list.indexOf(document.activeElement);
      if (!list.length) { e.preventDefault(); s.root.focus(); }
      else if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && (i < 0 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
    }
  }
  function open(pad, opener, resumed) {
    if (current) return;
    var s = { id: ++serial, opener: opener || document.activeElement, pad: String(pad || ''), urls: [], d: { file: null, texts: [], stickers: [], mentions: [], fit: 'fit', crop: null, nsfw: false }, caps: {}, targets: [], busy: false, closed: false, selected: null, drawId: 0, pickId: 0 };
    current = s; s.root = el('div', 'sst ds-scrim sheet'); s.root.setAttribute('role', 'dialog'); s.root.setAttribute('aria-modal', 'true'); s.root.tabIndex = -1; s.root.setAttribute('aria-label', _t('js.feed.sc.title', 'Add your story'));
    s.root.addEventListener('click', function (e) { if (e.target === s.root) close(s); });
    // storyux: iOS - a pinch anywhere in the editor never zooms the page (Safari ignores user-scalable=no; its own gesture events can be stopped)
    s.root.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
    s.oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; add(document.body, s.root);
    s.card = add(s.root, el('section', 'ds-modal sst-card'));
    var head = add(s.card, el('header', 'sst-head'));
    // storyux: one X at the top left - with no picture it closes the editor; with one it goes back to the camera (or the picker)
    s.closeButton = add(head, iconButton(_t('js.feed.ss.close_x', '✕ Close story editor'), function () { close(s); }, 'icon sm quiet sst-icon-only sst-close'));
    s.backButton = add(head, iconButton(_t('js.feed.ss.back_camera', '✕ Back to the camera'), function () { goBack(s); }, 'icon sm quiet sst-icon-only sst-back')); s.backButton.hidden = true;
    add(head, el('h2', 'ds-pixel-h', _t('js.feed.ss.title', 'Your story')));
    add(head, el('span', 'sst-lifetime', _t('js.feed.ss.hours_short', '24 h')));
    s.more = add(head, iconButton(_t('js.feed.ss.options', '⚙️ Story options'), function () { optionsSheet(s); }, 'icon sm quiet sst-icon-only'));
    s.body = add(s.card, el('div', 'sst-body')); var work = add(s.body, el('div', 'sst-work'));
    s.previewWrap = add(work, el('div', 'sst-preview-wrap')); s.preview = add(s.previewWrap, el('div', 'sst-preview')); s.preview.tabIndex = 0;
    s.preview.setAttribute('aria-label', _t('js.feed.ss.preview', 'Story preview. Use the editing tools to make it yours.'));
    s.help = add(s.preview, el('span', 'ds-sr-only', _t('js.feed.ss.gesture_help', 'Drag to move. Pinch to resize, twist to turn. Keyboard: arrows move, + and − resize, [ and ] turn, Delete removes.')));
    s.help.id = 'sst-help-' + s.id; s.preview.setAttribute('aria-describedby', s.help.id);
    s.empty = add(s.preview, el('div', 'sst-empty')); var emptyIcon = add(s.empty, el('span', 'ds-ic', _t('js.feed.ss.camera_icon', '📷'))); emptyIcon.setAttribute('aria-hidden', 'true'); add(s.empty, el('p', null, _t('js.feed.ss.choose', 'Choose a picture or video')));
    s.canvas = add(s.preview, el('canvas', 'sst-overlay')); s.canvas.width = W; s.canvas.height = H; s.canvas.setAttribute('aria-hidden', 'true');
    // storyux: the centre guides a layer snaps to, the layers' hit areas, and the selection (outline, delete, turn/size corner)
    s.guides = {}; ['v', 'h'].forEach(function (k) { var g = s.guides[k] = add(s.preview, el('span', 'sst-guide')); g.setAttribute('data-guide', k); g.setAttribute('aria-hidden', 'true'); g.hidden = true; });
    s.handles = add(s.preview, el('div', 'sst-handles')); s.layers = {};
    s.sel = add(s.handles, el('div', 'sst-select')); s.sel.hidden = true;
    s.selDel = add(s.sel, iconButton(_t('js.feed.ss.delete_x', '✕ Delete layer'), function (e) { if (e) e.stopPropagation(); if (picked(s) && !s.busy) removeLayer(s, s.selected); }, 'icon sm sst-sel-del'));
    s.selTurn = add(s.sel, el('span', 'sst-sel-turn')); s.selTurn.setAttribute('aria-hidden', 'true');
    s.picks = add(work, el('div', 'sst-picks'));
    [['camera', _t('js.feed.ss.camera', '📷 Camera')], ['gallery', _t('js.feed.ss.gallery', '🖼️ Gallery')]].forEach(function (pair) {
      var f = add(s.picks, input('file')); f.accept = 'image/*,video/*'; f.hidden = true; f.setAttribute('data-pick', pair[0]); if (pair[0] === 'camera') f.setAttribute('capture', 'environment');
      // ssfix: a hand-off with no file says so (it was a silent no-op). ssfix2: a file keeps the note ('arrived') until it has opened
      f.addEventListener('change', function () {
        var file = f.files && f.files[0], p = s.pending, n = 0;
        if (!file) { settle(s); tell(s, pair[0] === 'camera' ? _t('js.feed.ss.no_camera_file', 'No picture arrived from the camera. Try again, or choose it from Gallery.') : _t('js.feed.ss.no_file', 'No file arrived. Try again.')); }
        else { if (p) { clearTimeout(p.timer); p.phase = 'arrived'; n = p.n; notePicking(s); } pick(s, file, n); }
        f.value = '';
      });
      f.addEventListener('cancel', function () { settle(s); });
      // story camera: 📷 Camera opens the live camera when it can; otherwise the capture input (with its pick note, as ever)
      var pickButton = add(s.picks, iconButton(pair[1], function () { if (pair[0] !== 'camera' || !camera(s)) choose(s, pair[0]); })); pickButton.setAttribute('data-picker', pair[0]);
    });
    // storyux: no Retake - once there is a picture the pickers go, and the X (backButton) is the one way back
    s.filename = add(work, el('span', 'sst-filename'));
    s.summary = add(s.body, el('aside', 'sst-summary')); add(s.summary, el('h3', 'ds-eyebrow', _t('js.feed.ss.summary', 'Story details')));
    add(s.summary, el('p', null, _t('js.feed.ss.canvas', 'Canvas 9:16'))); add(s.summary, el('p', null, _t('js.feed.ss.lifetime', 'Appears for 24 hours')));
    s.summaryPad = add(s.summary, el('p')); s.summaryAs = add(s.summary, el('p'));
    s.tools = add(s.card, el('div', 'sst-tools')); s.toolButtons = {};
    // storyux: 📐 is the layout toggle (pressed = Fill) - the picture itself is placed and sized by touch, not in a sheet
    [['layout', _t('js.feed.ss.layout', '📐 Fill the screen')], ['text', _t('js.feed.ss.text', '🔤 Text')], ['sticker', _t('js.feed.ss.sticker', '🧸 Sticker')], ['mention', _t('js.feed.ss.mention', '👤 Mention')], ['trim', _t('js.feed.ss.trim', '✂️ Trim')]].forEach(function (p) {
      s.toolButtons[p[0]] = add(s.tools, iconButton(p[1], function () { tool(s, p[0]); })); s.toolButtons[p[0]].setAttribute('data-tool', p[0]);
    });
    s.sheetSlot = add(s.card, el('div', 'sst-sheet-slot')); s.status = add(s.card, el('div', 'sst-status')); s.status.setAttribute('aria-live', 'polite'); s.status.setAttribute('role', 'status');
    s.recovery = add(s.card, el('div', 'sst-recovery')); s.recovery.hidden = true;
    s.progress = add(s.card, el('div', 'sst-progress')); s.progress.hidden = true;
    s.meter = add(s.progress, el('progress')); s.meter.max = 100; s.meter.value = 0; s.meter.setAttribute('aria-label', _t('js.feed.ss.progress', 'Posting progress'));
    s.cancelButton = add(s.progress, button(_t('js.feed.sc.cancel', 'Cancel'), function () { cancel(s); }));
    var foot = add(s.card, el('footer', 'sst-foot')); var row = add(foot, el('div', 'sst-decision'));
    s.destination = add(row, button(null, function () { destinationSheet(s); }, 'quiet sst-destination')); s.destination.setAttribute('aria-label', _t('js.feed.sc.where', 'Where to post your story'));
    s.post = add(row, button(_t('js.feed.sc.post', 'Post story'), function () { post(s); }, 'sst-post'));
    s.rules = add(foot, el('p', 'sst-rules'));
    s.identity = add(foot, el('p', 'sst-identity'));
    s.key = function (e) { key(s, e); }; document.addEventListener('keydown', s.key, true);
    s.focus = function (e) { if (live(s) && !s.root.contains(e.target)) { var fs = focusables(s.root); (fs[0] || s.root).focus(); } }; document.addEventListener('focusin', s.focus);
    s.resize = function () { layoutHandles(s); }; window.addEventListener('resize', s.resize);
    // ssfix2: where the page is while a picker is out - away (hidden, blurred) and back (visible, focused, restored, touched)
    s.away = function () { if (s.pending && s.pending.phase === 'open') s.pending.away = true; };
    s.back = function () { back(s); };
    s.touch = function () { if (s.pending && s.pending.phase === 'open') { s.pending.away = true; back(s); } };   // a picker is modal: a touch means it's gone
    s.vis = function () { if (hiddenNow()) s.away(); else back(s); };
    s.leave = function () { var p = s.pending; if (p && p.phase === 'open' && (p.back || !p.away)) settle(s); };   // left after coming back; not while the camera is in front
    document.addEventListener('visibilitychange', s.vis); document.addEventListener('pointerdown', s.touch, true);
    window.addEventListener('blur', s.away); window.addEventListener('focus', s.back); window.addEventListener('pageshow', s.back); window.addEventListener('pagehide', s.leave);
    if (window.visualViewport) { s.viewport = function () { s.root.style.setProperty('--sst-vh', Math.floor(window.visualViewport.height) + 'px'); layoutHandles(s); }; window.visualViewport.addEventListener('resize', s.viewport); s.viewport(); }
    stage(s); paintControls(s); say(s, _t('js.feed.sc.loading', 'Loading…')); s.root.focus();
    // story camera: a new studio opens on the live camera; one reopened after a reload (ssfix) shows its picker and says what happened
    if (!resumed) camera(s);
    var include = pad && !/^(?:user:|u\/|profile$)/i.test(String(pad)) ? '?pad=' + encodeURIComponent(pad) : '';
    req('/api/stories/targets' + include).then(function (data) {
      if (!live(s)) return;
      if (data.refusal || !data.pads || !data.pads.length) throw new Error(data.refusal || _t('js.feed.sc.nowhere', 'There\'s nowhere you can post a story right now.'));
      s.targets = data.pads; s.caps = data.caps || {}; s.as = data.as || ''; s.target = data.pads.filter(function (p) { return p.id === pad; })[0] || data.pads[0];
      s.canPost = true; if (s.cam) s.cam.go();
      paintTarget(s); paintControls(s); say(s, s.camWhy || '');
      if (resumed) { s.d.nsfw = !!resumed.nsfw; say(s, resumed.phase === 'arrived' ? _t('js.feed.ss.reloaded_loading', 'The page reloaded while your file was opening, so it isn\'t here. Try again, or choose it from Gallery.') : resumed.picker === 'camera' ? _t('js.feed.ss.reloaded_camera', 'The page reloaded while the camera was open, so the picture didn\'t arrive. Try again - or take it with your camera app and choose it from Gallery.') : _t('js.feed.ss.reloaded_gallery', 'The page reloaded while you were choosing a file, so nothing arrived. Try again.'), true); }
    }).catch(function (e) { s.noPost = true; if (s.cam) { s.cam.close(); s.cam = null; } if (live(s)) say(s, e.message || _t('js.feed.sc.unreachable', 'Couldn\'t reach the site.'), true); });
  }
  // Story camera (1.99alu, story-camera.js): the studio opens on the live camera when this browser can show one. A capture
  // comes back through pick() exactly like a chosen file; without a camera the picker stays, with the reason. The camera
  // and mic are asked for only once the targets say this person can post (go()); after a refusal there, or once the live
  // camera failed in this studio, 📷 Camera and Retake open the phone's own capture input instead.
  // (with ssfix: the live camera never leaves the page, so a capture has no pick note - and ends any pick still open; its 🖼️
  // and the capture-input fallback are the studio's own pickers, note and all)
  function camera(s) {
    var C = window.patvStoryCamera; if (!C || !live(s) || s.busy || s.camFailed || s.noPost) return false;
    if (s.cam) s.cam.close(); closeSheet(s); if (s.media && s.media.pause) s.media.pause(); s.camWhy = '';
    s.cam = C.open(s.root, { wait: !s.canPost, draft: !!s.d.file, secs: function () { return s.caps.secs || 30; }, file: function (f, info) { s.cam = null; settle(s); pick(s, f, 0, info); },
      gallery: function () { choose(s, 'gallery'); },
      close: function () { s.cam = null; if (!s.d.file) close(s); else s.backButton.focus(); },
      unavailable: function (why) { s.cam = null; s.camWhy = why; s.camFailed = true; if (live(s)) { say(s, why); paintControls(s); } } });
    return !!s.cam;
  }
  function paintTarget(s) {
    var p = s.target; if (!p) return;
    s.root.classList.remove('pad-acc'); s.root.style.removeProperty('--pad-accent'); s.root.style.removeProperty('--pad-accent-ink');
    if (!p.profile && p.look && /^#[0-9a-f]{6}$/.test(p.look.accent || '') && /^#[0-9a-f]{6}$/.test(p.look.ink || '')) {
      s.root.style.setProperty('--pad-accent', p.look.accent); s.root.style.setProperty('--pad-accent-ink', p.look.ink); s.root.classList.add('pad-acc');
    }
    s.destination.textContent = ''; var av = el(p.look && p.look.avatar ? 'img' : 'span', 'ds-av sm sst-avatar' + (p.profile ? ' sst-person' : ''));
    if (p.look && p.look.avatar) { av.src = p.look.avatar; av.alt = ''; } else av.textContent = chars(p.profile ? s.as : p.title)[0] || '+';
    add(s.destination, av); var words = add(s.destination, el('span')); add(words, el('small', null, _t('js.feed.sc.post_to', 'Post to'))); add(words, el('strong', null, p.profile ? _t('js.feed.ss.profile', 'Your profile') : p.title));
    s.rules.textContent = _t('js.feed.ss.visible', 'Visible for 24 hours');
    if (!p.profile && p.href) { add(s.rules, document.createTextNode(' · ')); var a = add(s.rules, el('a', null, _t('js.feed.ss.rules', 'Pad rules'))); a.href = p.href + '#rules'; a.target = '_blank'; a.rel = 'noopener'; }
    s.summaryPad.textContent = _t('js.feed.ss.posting_to', 'Posting to {name}', { name: p.profile ? _t('js.feed.ss.profile', 'Your profile') : p.title });
    s.summaryAs.textContent = _t('js.feed.ss.posted_as', 'Posted as {name}', { name: s.as });
    s.identity.textContent = s.summaryAs.textContent;
  }
  function paintControls(s) {
    var d = s.d; s.post.disabled = s.busy || !!s.pendingStickers || !s.target || !d.file || !d.valid || (!d.decoded && !d.legacy);
    s.root.classList.toggle('sst-has-media', !!d.file); s.root.classList.toggle('sst-video', d.kind === 'video'); s.root.classList.toggle('sst-busy', !!s.busy);
    s.closeButton.disabled = !!(s.attempt && s.attempt.stage === 'mine'); s.cancelButton.disabled = s.closeButton.disabled;
    // storyux: with a picture, no Gallery / Camera - one X back (to the live camera when there is one, else the picker)
    s.picks.hidden = !!d.file; s.closeButton.hidden = !!d.file; s.backButton.hidden = !d.file; s.backButton.disabled = s.busy;
    relabel(s.backButton, cameraOK(s) ? _t('js.feed.ss.back_camera', '✕ Back to the camera') : _t('js.feed.ss.back_pick', '✕ Choose another picture or video'));
    s.destination.disabled = s.busy || !s.targets.length; s.more.disabled = s.busy;
    Array.prototype.forEach.call(s.picks.querySelectorAll('button'), function (b) { b.disabled = s.busy; });
    // storyfix2: a video under a second has no 1 s window to trim; storyux: Fill only where the picture can fill the frame
    Object.keys(s.toolButtons).forEach(function (k) {
      var b = s.toolButtons[k]; b.disabled = s.busy || !d.file || !d.valid || (k !== 'mention' && (!d.decoded || d.legacy || d.gif)) || (k === 'trim' && (d.kind !== 'video' || !(d.duration >= 1))) || (k === 'layout' && !(d.w && G.canFill(d.w / d.h)));
      b.setAttribute('aria-pressed', String(k === 'layout' ? d.fit === 'fill' : s.sheetName === k));
    });
    s.post.textContent = s.failed ? _t('js.feed.ss.retry', 'Retry') : _t('js.feed.sc.post', 'Post story');
  }
  function changed(s, pixels) { s.failed = false; if (pixels && s.ready) { discard([s.ready.id]); s.ready = null; } render(s); paintControls(s); }
  function closeSheet(s) { if (!s.sheet) return; var opener = s.sheetOpener; s.sheetSlot.textContent = ''; s.sheet = null; s.sheetName = null; s.sheetLayer = null; s.suggestions = null; s.mentionInput = null; clearTimeout(s.suggestTimer); s.root.classList.remove('sst-has-sheet'); s.root.removeAttribute('data-sheet'); paintControls(s); if (opener && opener.isConnected) opener.focus(); }
  function sheet(s, name, title) {
    var opener = document.activeElement; closeSheet(s); s.sheetOpener = opener; s.sheetName = name; s.root.classList.add('sst-has-sheet'); s.root.setAttribute('data-sheet', name);
    s.sheet = add(s.sheetSlot, el('section', 'sst-sheet')); s.sheet.setAttribute('aria-label', title);
    var h = add(s.sheet, el('div', 'sst-sheet-head')); add(h, el('h3', 'ds-eyebrow', title)); var done = add(h, button(_t('js.feed.ss.done', 'Done'), function () { closeSheet(s); })); done.focus();
    var body = add(s.sheet, el('div', 'sst-sheet-body')); paintControls(s); return body;
  }
  function destinationSheet(s) {
    var box = sheet(s, 'destination', _t('js.feed.sc.post_to', 'Post to'));
    s.targets.forEach(function (p) { var b = add(box, button(p.profile ? _t('js.feed.ss.profile', 'Your profile') : p.title, function () { s.target = p; paintTarget(s); closeSheet(s); }, 'quiet sst-target')); b.setAttribute('aria-pressed', String(p === s.target)); });
    var first = box.querySelector('button'); if (first) first.focus();
  }
  function optionsSheet(s) {
    var box = sheet(s, 'options', _t('js.feed.ss.options', '⚙️ Story options')); var check = input('checkbox'); check.checked = s.d.nsfw; check.addEventListener('change', function () { s.d.nsfw = check.checked; }); add(box, field(_t('js.feed.sc.nsfw', 'NSFW (blurred until someone taps it)'), check)).classList.add('ds-check');
    add(box, el('p', 'sst-help', _t('js.feed.ss.visible', 'Visible for 24 hours')));
    if (s.target && !s.target.profile && s.target.href) { var rules = add(box, el('a', 'ds-btn quiet sm', _t('js.feed.ss.rules', 'Pad rules'))); rules.href = s.target.href + '#rules'; rules.target = '_blank'; rules.rel = 'noopener'; }
    check.focus();
  }
  // storyux: d.crop is the picture's window in either layout (G above); a picture near 9:16 starts filling the frame, any
  // other starts whole. d.start remembers that, so the X knows whether the draft has edits.
  function resetFrame(d, fit) {
    var own = d.w / d.h; d.fit = fit || (Math.abs(own / (W / H) - 1) <= .2 && G.canFill(own) ? 'fill' : 'fit');
    d.crop = G.layout(null, own, d.fit); if (!fit) d.start = { fit: d.fit, crop: Object.assign({}, d.crop) };
  }
  function choose(s, which) {
    if (s.pending) clearTimeout(s.pending.timer);
    s.pending = { n: ++serial, picker: which, phase: 'open', away: false, back: false, timer: null };
    notePicking(s); s.picks.querySelector('[data-pick="' + which + '"]').click();
  }
  // A pick's trouble, said in the studio - and over the camera while it is up (a file chosen with its 🖼️): it stays, and says why there.
  function tell(s, why) { say(s, why, true); if (s.cam) s.cam.say(why); }
  function refuse(s, why, n) { tell(s, why); pickDone(s, n); }
  // ssfix: every way a pick can fail is said out loud, in words that aren't the empty screen's own prompt.
  // ssfix2: n is the pick's note (0: none); a refusal is the end of it, an accepted file keeps it until it has opened.
  // story camera: info = the camera's capture details ({ camera, secs, ... }; none for a chosen file). The checks run before
  // the camera closes, so a refused file keeps it.
  function pick(s, file, n, info) {
    if (s.busy) { refuse(s, _t('js.feed.ss.busy_pick', 'Wait until this story is posted, then choose another.'), n); return; }
    if (!file.size) { refuse(s, _t('js.feed.ss.empty_file', 'That file is empty. Try again, or choose another one.'), n); return; }
    var type = String(file.type || '').toLowerCase();
    if (/^video\//.test(type)) return use(s, file, 'video', false, n, info);
    if (/^image\//.test(type)) return use(s, file, 'image', type === 'image/gif', n, info);
    var id = s.sniffId = (s.sniffId || 0) + 1; say(s, _t('js.feed.sc.loading', 'Loading…'));
    sniff(file).then(function (found) {
      if (!live(s) || id !== s.sniffId) return;
      if (!found) refuse(s, _t('js.feed.ss.file_type', 'That file isn\'t a picture or a video. Choose another one.'), n);
      else if (s.busy) refuse(s, _t('js.feed.ss.busy_pick', 'Wait until this story is posted, then choose another.'), n);
      else use(s, file, found.kind, !!found.gif, n, info);
    }, function () { if (live(s) && id === s.sniffId) refuse(s, _t('js.feed.ss.unreadable', 'That file couldn\'t be read. Try again, or choose another one.'), n); });
  }
  // storyprev (1.99??): the owner's iPhone (iOS 26) said "This browser cannot preview that file" for clips just taken with the
  // story camera (they posted fine). The editor now waits WAIT_MS for a <video> with no size yet, tries a refused media
  // fragment once without it, and shows a camera clip's poster (story-camera.js: the live preview's frame as it started)
  // whenever the video can't show a frame - see use(). LOAD_MS: a file that says nothing at all.
  var WAIT_MS = 4000, LOAD_MS = 10000;
  function coarse() { try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } }
  // a camera clip's poster as the preview's still: the <video>'s poster until it has a frame of its own, and an <img> over it
  // (framed like the video by render()) that stays wherever this browser can't show the recording at all
  function stillOf(s, m, poster) {
    var st = s.still = el('img', 'sst-source sst-still'); st.alt = ''; st.setAttribute('aria-hidden', 'true'); st.setAttribute('draggable', 'false'); st.style.objectFit = 'contain';
    // storyprev verify: it takes no touch - a press goes through to the <video> and the preview (crop pan, pinch), never to
    // iOS's long-press menu for an image (Save / Copy / Share, which cancels the gesture) or a text selection on it
    st.style.pointerEvents = 'none'; st.style.setProperty('-webkit-touch-callout', 'none'); st.style.setProperty('-webkit-user-select', 'none'); st.style.setProperty('user-select', 'none');
    st.addEventListener('error', function () { st.bad = true; st.hidden = true; m.removeAttribute('poster'); });
    st.src = objectURL(s, poster); m.setAttribute('poster', st.src); s.preview.insertBefore(st, s.canvas); return st;
  }
  // ?storydebug=1 on the page (or patv.storydebug = 1 in local storage): a small read-out over the preview of what this browser made
  // of the picked file - type and size, the element's readyState / networkState / error, its size and length, which events
  // fired and when, whether the poster stood in - for a screenshot. Off by default; it only reads the page (no network).
  var MEDIA_EVENTS = ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'resize', 'play', 'playing', 'pause', 'seeked', 'waiting', 'stalled', 'suspend', 'abort', 'emptied', 'error', 'ended', 'load'];
  var MEDIA_ERRORS = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
  function debugOn() {
    try { if (/(?:^|&)storydebug=1(?:&|$)/.test(String(location.search || '').replace(/^\?/, ''))) return true; } catch (e) { /* no location */ }
    try { return !!window.localStorage && window.localStorage.getItem('patv.storydebug') === '1'; } catch (e) { return false; }
  }
  function bytes(n) { n = Number(n) || 0; return n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 10240 ? Math.round(n / 1024) + ' KB' : n + ' bytes'; }
  function debugFor(s, file, m, info, st) {
    if (s.debug) { s.debug.remove(); s.debug = null; }
    if (!debugOn()) return null;
    var box = s.debug = el('pre', 'sst-debug'), t0 = Date.now(), log = [], counts = {}, last = null, view = 'loading', camera = !!(info && info.camera);
    var look = { position: 'absolute', insetBlockStart: '0', insetInlineStart: '0', insetInlineEnd: '0', maxBlockSize: '80%', overflow: 'hidden', margin: '0', padding: '4px 6px', zIndex: '5',
      font: '10px/1.35 ui-monospace, Menlo, Consolas, monospace', color: '#e6ffe6', background: 'rgba(0, 0, 0, .74)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'start', pointerEvents: 'none' };
    Object.keys(look).forEach(function (k) { box.style[k] = look[k]; }); add(s.preview, box);
    function px(w, h) { return (w || 0) + '×' + (h || 0); }
    function num(x) { return typeof x === 'number' && isFinite(x) ? x.toFixed(3) : String(x); }
    function paint() {
      var video = m.localName === 'video', e = m.error && m.error.code ? { code: m.error.code, message: m.error.message || '' } : null, src = String(m.getAttribute('src') || ''), hash = src.indexOf('#'), nav = window.navigator || {};
      var lines = ['story debug', 'file ' + (file.type || '(no type)') + ' · ' + bytes(file.size) + ' · ' + (file.name || '(no name)') + ' · ' + (camera ? 'camera' : 'gallery')];
      if (camera) lines.push('camera ' + px(info.width, info.height) + ' · ' + num(info.secs) + ' s' + (info.mime ? ' · ' + info.mime : '') + (info.facing ? ' · ' + info.facing : '') + (info.sound === false && info.kind === 'video' ? ' · silent' : ''));
      lines.push('poster ' + (st ? px(info.width, info.height) + ' · ' + bytes(info.poster.size) + (st.naturalWidth ? ' · decoded ' + px(st.naturalWidth, st.naturalHeight) : '') + (st.bad ? ' · failed' : st.hidden ? ' · hidden' : ' · shown') : camera && info.kind === 'video' ? 'none came' : 'none'));
      lines.push('src ' + (!src ? '-' : hash >= 0 ? 'blob ' + src.slice(hash) : 'blob (no fragment)'));
      lines.push(video ? 'element readyState ' + m.readyState + ' · networkState ' + m.networkState + ' · ' + px(m.videoWidth, m.videoHeight) + ' · duration ' + num(m.duration) + ' · ' + (m.paused === false ? 'playing' : 'paused') + ' at ' + num(m.currentTime)
        : 'element ' + px(m.naturalWidth, m.naturalHeight));
      if (e) last = e;
      lines.push('error ' + (last ? last.code + ' ' + (MEDIA_ERRORS[last.code] || '?') + (last.message ? ' · ' + last.message : '') + (e ? '' : ' (earlier)') : 'none'));
      lines.push('preview ' + view, 'events ' + (log.join(', ') || '-'));
      if (nav.userAgent) lines.push('ua ' + nav.userAgent);
      box.textContent = lines.join('\n');
    }
    function note(what) { log.push(what + ' +' + (Date.now() - t0) + ' ms'); if (log.length > 40) log.splice(0, log.length - 40); paint(); }
    // a chatty event is listed three times; an error is read at once (a second try clears the element's own)
    MEDIA_EVENTS.forEach(function (type) { m.addEventListener(type, function () { counts[type] = (counts[type] || 0) + 1; if (type === 'error') paint(); if (counts[type] <= 3) note(type); else paint(); }); });
    m.addEventListener('timeupdate', function once() { m.removeEventListener('timeupdate', once); note('timeupdate ' + num(m.currentTime)); });
    if (st) { st.addEventListener('load', function () { note('poster loaded'); }); st.addEventListener('error', function () { note('poster failed'); }); }
    paint();
    return { note: note, view: function (what) { view = what; note('preview: ' + what); } };
  }
  function use(s, file, kind, gif, n, info) {
    s.sniffId = (s.sniffId || 0) + 1;     // a typed pick after an untyped one wins
    var limit = kind === 'video' ? s.caps.srcVideoMb || s.caps.videoMb || 60 : s.caps.imageMb || 10;
    if (file.size > limit * 1024 * 1024) { refuse(s, _t('js.feed.ss.too_big', 'That file is too big. Choose one up to {n} MB.', { n: limit }), n); return; }
    if (s.cam) { s.cam.close(); s.cam = null; }
    var captured = !!(info && info.camera); s.camWhy = ''; unask(s);
    if (s.ready) discard([s.ready.id]); s.ready = null; closeSheet(s); revoke(s); if (s.media) { if (s.media.pause) s.media.pause(); s.media.remove(); }
    if (s.still) { s.still.remove(); s.still = null; }
    var id = ++s.pickId, d = s.d = { file: file, kind: kind, gif: !!gif || /\.gif$/i.test(file.name || ''), decoded: false, valid: true, texts: [], stickers: [], mentions: [], fit: 'fit', crop: null, nsfw: s.d.nsfw, camera: captured && kind === 'video' };
    s.selected = null; s.gesture = null; s.failed = false; s.recovery.hidden = true; s.recovery.textContent = ''; s.filename.textContent = file.name || ''; s.empty.hidden = true;
    var m = s.media = el(kind === 'video' ? 'video' : 'img', 'sst-source'); s.preview.insertBefore(m, s.canvas);
    m.setAttribute('aria-label', _t('js.feed.ss.source', 'Selected story media')); if (kind === 'image') m.alt = _t('js.feed.sc.pic_alt', 'Your story picture');
    m.setAttribute('draggable', 'false');     // storyux: a desktop drag pans the picture, never drags the image out
    // storyfix2: muted + inline (attributes too, as iOS reads them) and preload auto, for the first frame below
    if (kind === 'video') { m.muted = true; m.defaultMuted = true; m.playsInline = true; ['playsinline', 'webkit-playsinline', 'muted'].forEach(function (a) { m.setAttribute(a, ''); }); m.preload = 'auto'; m.addEventListener('timeupdate', function () { if (d.trim && m.currentTime >= d.trim.end) { m.currentTime = d.trim.start; } }); m.addEventListener('ended', function () { if (d.trim && live(s)) { m.currentTime = d.trim.start; m.play().catch(function () {}); } }); }
    // storyprev: a camera clip's poster stands by (its size came with it); the read-out is there only with ?storydebug=1
    var st = kind === 'video' && captured && info.poster && info.poster.size && info.width > 0 && info.height > 0 ? stillOf(s, m, info.poster) : null;
    var dbg = debugFor(s, file, m, info, st), url = objectURL(s, file), frag = kind === 'video', phase = 'loading', waiting = false, late = false, timer = 0, early = false;
    // storyprev: a <video> counts as open once it has a size. WebKit can have none yet at 'loadedmetadata' (a MediaRecorder MP4
    // is fragmented, its moov empty) and bring it with 'resize' once a frame decodes - so a missing size is waited for (WAIT_MS),
    // never refused at once, and a file that says nothing at all is given LOAD_MS (a camera clip with its poster: WAIT_MS)
    function sized() { return kind === 'video' ? !!(m.videoWidth && m.videoHeight) : !!(m.naturalWidth && m.naturalHeight); }
    function arm(ms) { clearTimeout(timer); timer = setTimeout(function () { failed(waiting ? 'no size' : 'no metadata'); }, ms); }
    function meta() {
      if (!live(s) || id !== s.pickId) return;
      // the poster stood in, and the video has a size after all: it takes over once it paints (playback in the editor).
      // storyprev verify: a play already running is the user's (Trim's - WebKit may size a video only once it plays): it goes on,
      // and the poster goes with it; a paused video gets the muted first-frame play
      if (phase === 'still' && !late && sized()) { late = true; if (!m.paused && !m.priming) m.primed = true; cover(); if (m.paused) firstFrame(s, m, id); return; }
      // storyprev verify: a gallery video (or a camera clip with no poster) whose metadata comes after the give-up opens after all,
      // unless it was already chosen to go as it is
      if (phase === 'failed' && sized() && !d.legacy && !s.busy) { phase = 'loading'; s.recovery.hidden = true; s.recovery.textContent = ''; say(s, ''); if (dbg) dbg.note('a size after all'); loaded(); return; }
      if (phase !== 'loading') return;
      // storyprev verify: WebKit loads only metadata until a video plays, so the size it is waited for may come only from a
      // decoded frame: the muted first-frame play asks for one now (paused as soon as it starts, as below)
      if (sized()) loaded(); else if (!waiting) { waiting = true; arm(WAIT_MS); early = true; firstFrame(s, m, id); }
    }
    function loaded() {
      if (!live(s) || id !== s.pickId || phase !== 'loading') return;
      d.w = kind === 'video' ? m.videoWidth : m.naturalWidth; d.h = kind === 'video' ? m.videoHeight : m.naturalHeight;
      if (!d.w || !d.h) return failed('no size');
      phase = 'ready'; clearTimeout(timer);
      d.decoded = true; d.legacy = d.gif; resetFrame(d);
      if (kind === 'video') {
        // a fresh recording can report no length (Infinity, NaN, 0): the camera's measured hold stands in
        length(isFinite(m.duration) && m.duration > 0 ? m.duration : info && info.secs);
        if (st) cover();      // before the first-frame play: that play is not the video showing itself
        if (!early) firstFrame(s, m, id);      // storyprev verify: the wait's own muted play put it up already
      }
      if (dbg) dbg.view(st ? 'video, under its poster until it paints a frame' : 'video');
      opened();
    }
    function length(secs) {
      d.duration = secs;
      // storyfix2: no 1 s minimum here - a video kept whole goes with no trim (editFor) and posts whatever the file holds (an
      // iPhone recording can hold less than the hold; a quick clip from the phone's capture input is short too); only a trim
      // needs a second (the Trim tool is off under one)
      if (!isFinite(d.duration) || !(d.duration > 0) || d.duration > (s.caps.srcSecs || 180)) { d.valid = false; say(s, _t('js.feed.ss.source_long', 'Choose a video between 1 and {n} seconds.', { n: s.caps.srcSecs || 180 }), true); }
      else { d.trim = { start: 0, end: Math.min(d.duration, s.caps.secs || 30) }; d.trim0 = { start: d.trim.start, end: d.trim.end }; if (d.duration > (s.caps.secs || 30)) { say(s, _t('js.feed.ss.trim_needed', 'Choose up to {n} seconds to keep.', { n: s.caps.secs || 30 })); tool(s, 'trim'); } }
    }
    function opened() {
      render(s); paintControls(s);
      // ssfix2: the note goes once the picture has been painted (two frames on), not at 'load': the paint decode is the peak
      var frame = window.requestAnimationFrame ? function (f) { window.requestAnimationFrame(f); } : function (f) { setTimeout(f, 16); };
      frame(function () { frame(function () { pickDone(s, n); }); });
    }
    // storyprev: an error while loading gets one more try without the media fragment (WebKit may refuse one on a blob: URL;
    // the muted play still puts the first frame up)
    function broke() {
      if (!live(s) || id !== s.pickId) return;
      if (phase === 'loading' && frag) { frag = false; waiting = false; early = false; arm(st ? WAIT_MS : LOAD_MS); if (dbg) dbg.note('retry without the fragment #t=0.001'); m.src = url; return; }
      failed('error');
    }
    // storyprev: when this browser can't show the video (an error, no size, nothing at all), a camera clip's poster is the preview
    // - its size frames it, so crop, text and stickers work and the clip posts with its edits; a gallery video (no poster)
    // keeps the old recovery, in kinder words. A video that had opened and fails later keeps its edits under its poster.
    function failed(why) {
      if (!live(s) || id !== s.pickId || phase === 'failed') return;
      // storyprev verify: the video took over from the poster (late) and fails after all - the poster comes back over it
      if (phase === 'still') { if (late && st && !st.bad && st.hidden) { st.hidden = false; if (dbg) dbg.view('poster (a late ' + why + ')'); } return; }
      clearTimeout(timer); if (dbg) dbg.note('no preview from the element: ' + why);
      if (st && !st.bad && phase === 'ready') { st.hidden = false; if (dbg) dbg.view('poster (a late ' + why + ')'); return; }
      if (st && !st.bad) {
        // d.poster (storyprev verify): framed on the poster's size - post() offers "Post it as it is" if the server refuses the edit
        phase = 'still'; d.w = info.width; d.h = info.height; d.decoded = true; d.legacy = false; d.poster = true; resetFrame(d);
        length(isFinite(m.duration) && m.duration > 0 ? m.duration : info.secs);
        if (dbg) dbg.view('poster (' + why + ')');
        return opened();
      }
      phase = 'failed'; d.decoded = false; d.legacy = false; pickDone(s, n);
      say(s, kind !== 'video' ? _t('js.feed.ss.decode', 'This browser cannot preview that file. You can post it without edits; videos must be up to 30 seconds.')
        : coarse() ? _t('js.feed.ss.no_preview_phone', 'Your phone can\'t preview this video here, but it will still post. Post it as it is (up to {n} seconds), or pick another.', { n: s.caps.secs || 30 })
        : _t('js.feed.ss.no_preview', 'This browser can\'t preview this video here, but it will still post. Post it as it is (up to {n} seconds), or pick another.', { n: s.caps.secs || 30 }), true);
      if (dbg) dbg.view('none: "Post it as it is"');
      s.recovery.textContent = ''; s.recovery.hidden = false;
      add(s.recovery, button(_t('js.feed.ss.as_is', 'Post it as it is'), function () { asIs(s); }));
      add(s.recovery, button(_t('js.feed.ss.pick_another', 'Pick another'), function () { choose(s, 'gallery'); })); paintControls(s);
    }
    // storyprev: the poster stays over the <video> until the video has painted a frame of its own (requestVideoFrameCallback) or,
    // in an engine without that, until it plays after its first-frame pause (Trim's play): over a blank or broken video it stays
    function cover() {
      function off(why) { if (live(s) && id === s.pickId && (phase === 'ready' || phase === 'still') && !st.hidden) { st.hidden = true; if (dbg) dbg.view('video (' + why + ')'); } }
      if (typeof m.requestVideoFrameCallback === 'function') { try { m.requestVideoFrameCallback(function () { off('a frame painted'); }); return; } catch (e) { /* the event below */ } }
      if (m.primed && !m.paused) return off('playing');      // storyprev verify: the user's play is running already (a late size)
      m.addEventListener('playing', function () { if (m.primed) off('playing'); });
    }
    if (st) st.addEventListener('error', function () { if (live(s) && id === s.pickId && phase === 'still') { phase = 'loading'; failed('poster'); } });
    if (kind === 'video') { ['loadedmetadata', 'resize', 'loadeddata', 'canplay'].forEach(function (t) { m.addEventListener(t, meta); }); arm(st ? WAIT_MS : LOAD_MS); }
    else m.addEventListener('load', loaded);
    // storyfix2: a video starts at 0.001 s (a media fragment): iOS then puts its first frame up without playing it
    m.addEventListener('error', broke); m.src = url + (frag ? '#t=0.001' : '');
    say(s, ''); render(s); paintControls(s);
  }
  // storyfix2 (1.99aly): the preview's first frame. WebKit (every iPhone browser) paints nothing for a <video> that has never
  // played - preload is only ever 'metadata' there - so a clip just taken (or chosen) stayed blank; a seek this early leaves it
  // black (WebKit bug 225963), so there is none. The media fragment (#t=0.001 on the src) is one way up; a muted inline play,
  // paused as soon as it starts, is the other. Where even that is refused (Low Power Mode), the fragment alone shows it.
  // (storyprev: m.primed once that play is over - a later play is the user's; m.priming while it runs)
  function firstFrame(s, m, id) {
    m.primed = false; m.priming = true;
    function over() { m.priming = false; m.primed = true; }
    var played; try { played = m.play(); } catch (e) { played = null; }
    if (played && typeof played.then === 'function') played.then(function () { if (live(s) && id === s.pickId) m.pause(); over(); }, function () { over(); /* refused: the media fragment shows the frame */ });
    else m.addEventListener('playing', function once() { m.removeEventListener('playing', once); if (live(s) && id === s.pickId) m.pause(); over(); });
  }
  function asIs(s) {
    var d = s.d;
    if (d.kind === 'video' && d.file.size > (s.caps.videoMb || 60) * 1024 * 1024) { say(s, _t('js.feed.ss.too_big', 'That file is too big. Choose one up to {n} MB.', { n: s.caps.videoMb || 60 }), true); return; }
    d.legacy = true; d.fit = 'fit'; d.texts = []; d.stickers = []; s.selected = null; s.failed = false; s.recovery.hidden = true;
    if (!d.decoded) d.mentions.forEach(function (m) { m.x = .5; m.y = .5; });
    say(s, _t('js.feed.ss.legacy', 'Ready to post without edits.')); render(s); paintControls(s);
  }
  function render(s) {
    if (!live(s)) return; var d = s.d; placeMedia(s);
    var n = ++s.drawId;
    fonts(d).then(function () { if (!live(s) || n !== s.drawId) return; draw(s.canvas, d); layoutHandles(s); }).catch(function () { if (live(s)) say(s, _t('js.feed.ss.font_failed', 'The text font could not load. Try again before posting.'), true); });
  }
  // storyux: the picture where its window puts it - in Fit too (it may be smaller than the frame, or zoomed past it)
  // (storyprev: a camera clip's poster - s.still - is framed exactly like its video, whichever of the two shows)
  function placeMedia(s) {
    var d = s.d, m = s.media; if (!m || !d.decoded) return;
    m.style.transform = ''; m.style.inlineSize = '100%'; m.style.blockSize = '100%'; m.style.insetInlineStart = '0'; m.style.insetBlockStart = '0';
    if (d.legacy || !d.crop) { m.style.objectFit = 'contain'; return frameStill(s); }
    var r = G.rect(d.crop); m.style.objectFit = 'fill';
    m.style.inlineSize = r.w * 100 + '%'; m.style.blockSize = r.h * 100 + '%'; m.style.insetInlineStart = r.x * 100 + '%'; m.style.insetBlockStart = r.y * 100 + '%';
    frameStill(s);
  }
  function frameStill(s) { var m = s.media, st = s.still; if (m && st) ['objectFit', 'inlineSize', 'blockSize', 'insetInlineStart', 'insetBlockStart', 'transform'].forEach(function (k) { st.style[k] = m.style[k]; }); }
  function fonts(d) { if (!document.fonts || !document.fonts.load) return Promise.resolve(); return Promise.all(d.texts.map(function (t) { return document.fonts.load(font(t), t.text); })); }
  function font(t) { return '700 ' + t.size + 'px ' + (t.style === 'pixel' ? '"Press Start 2P", monospace' : 'Ubuntu, system-ui, sans-serif'); }
  // storyux: a text scales as a whole - its lines break where they did at 72 px (the wrap width grows with it) until it would
  // be wider than the frame; its box's padding grows with it too
  function wrapWidth(t) { return Math.min(W * .86 * t.size / 72, W * .92); }
  function textLines(ctx, text, max) {
    // Word wrapping, then grapheme wrapping for a single unbroken word. Emoji clusters stay together where supported.
    var out = [], segments = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    String(text).split('\n').forEach(function (paragraph) {
      var line = '';
      paragraph.split(/(\s+)/).forEach(function (word) {
        if (ctx.measureText(line + word).width <= max) { line += word; return; }
        if (line.trim()) { out.push(line.trim()); line = ''; }
        if (ctx.measureText(word).width <= max) { line = word.trimStart(); return; }
        var units = segments ? Array.from(segments.segment(word)).map(function (x) { return x.segment; }) : chars(word);
        units.forEach(function (c) { if (line && ctx.measureText(line + c).width > max) { out.push(line); line = ''; } line += c; });
      }); out.push(line.trim());
    }); return out;
  }
  // storyux: every layer is drawn about its centre, turned by its rot - the handle on the preview sits on the same box
  function draw(canvas, d) {
    var ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, W, H);
    d.texts.forEach(function (t) {
      ctx.save(); ctx.font = font(t); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = /[\u0590-\u08ff]/.test(t.text) ? 'rtl' : 'ltr';
      var lines = textLines(ctx, t.text, wrapWidth(t)), lh = t.size * 1.3, height = lines.length * lh, width = Math.max.apply(Math, lines.map(function (x) { return ctx.measureText(x).width; }).concat([t.size]));
      var px = t.size * 16 / 72, py = t.size * 10 / 72;
      t.bounds = { w: width + 2 * px, h: height + 2 * py, size: t.size }; G.keepIn(t);
      ctx.translate(t.x * W, t.y * H); if (t.rot) ctx.rotate(t.rot);
      if (t.style === 'box') { ctx.fillStyle = t.color === '#000000' ? '#ffffff' : '#000000'; ctx.fillRect(-width / 2 - px, -height / 2 - py, width + 2 * px, height + 2 * py); }
      if (t.style === 'plain') { ctx.shadowColor = '#000000'; ctx.shadowBlur = 7 * t.size / 72; ctx.shadowOffsetY = 3 * t.size / 72; }
      ctx.fillStyle = t.color; ctx.strokeStyle = t.color === '#000000' ? '#ffffff' : '#000000'; ctx.lineWidth = Math.max(4, t.size / 9); ctx.lineJoin = 'round';
      lines.forEach(function (line, i) { var ly = (i - (lines.length - 1) / 2) * lh; if (t.style === 'outline') ctx.strokeText(line, 0, ly); ctx.fillText(line, 0, ly); }); ctx.restore();
    });
    // a sticker's side is a multiple of 24 (whole pixels of its 24 px art) and its centre a whole pixel: crisp when upright
    d.stickers.forEach(function (t) {
      if (!t.img) return; var p = G.stickerPx(t.size); G.keepIn(t);
      ctx.save(); ctx.imageSmoothingEnabled = false; ctx.translate(Math.round(t.x * W), Math.round(t.y * H)); if (t.rot) ctx.rotate(t.rot);
      ctx.drawImage(t.img, -p / 2, -p / 2, p, p); ctx.restore();
    });
  }
  function layerName(t) { return t.type === 'text' ? t.text : t.type === 'mention' ? '@' + t.username : t.name; }
  function layersOf(d) { return d.texts.concat(d.stickers, d.mentions); }
  // the selected layer, while it is one of the draft's (a text being typed for the first time isn't, until it has words)
  function picked(s) { var t = s.selected; return t && layersOf(s.d).indexOf(t) >= 0 ? t : null; }
  // storyux: the layers' hit areas are kept (one per layer, by id) and only moved - a gesture never loses its element
  function layoutHandles(s) {
    if (!live(s)) return; var d = s.d, keep = {};
    // Unedited media keeps its original aspect ratio. Its mention fractions refer to the
    // contained picture, matching the viewer; edited media always fills the 9:16 output.
    var mw = W, mh = H;
    if (d.legacy && d.decoded) { var scale = Math.min(W / d.w, H / d.h); mw = d.w * scale; mh = d.h * scale; }
    s.handles.style.insetInlineStart = (W - mw) / W * 50 + '%'; s.handles.style.insetBlockStart = (H - mh) / H * 50 + '%';
    s.handles.style.inlineSize = mw / W * 100 + '%'; s.handles.style.blockSize = mh / H * 100 + '%'; s.handles.hidden = !d.decoded;
    layersOf(d).forEach(function (t) {
      var b = s.layers[t.id] || (s.layers[t.id] = makeLayer(s, t)); keep[t.id] = true;
      if (b.parentNode !== s.handles) s.handles.insertBefore(b, s.sel);
      placeLayer(s, b, t);
    });
    Object.keys(s.layers).forEach(function (id) { if (!keep[id]) { s.layers[id].remove(); delete s.layers[id]; } });
    placeSelect(s);
  }
  function makeLayer(s, t) {
    var b = button(t.type === 'mention' ? '@' + t.username : '', null, 'sst-layer' + (t.type === 'mention' ? ' sst-mention' : ''));
    b.setAttribute('data-layer', t.id); b.setAttribute('aria-label', _t('js.feed.ss.layer', 'Edit {name}', { name: layerName(t) }));
    // a pointer's tap is the stage's (detail > 0); Enter / Space / assistive tech select it - and open a text's words
    b.addEventListener('click', function (e) { if ((e.detail || 0) > 0 || s.busy) return; e.preventDefault(); select(s, t); if (t.type === 'text') textSheet(s, t); });
    b.addEventListener('keydown', function (e) { layerKey(s, t, e); });
    return b;
  }
  function placeLayer(s, b, t) {
    b.style.insetInlineStart = t.x * 100 + '%'; b.style.insetBlockStart = t.y * 100 + '%';
    if (t.type !== 'mention') { var bx = G.box(t); b.style.inlineSize = bx.w / W * 100 + '%'; b.style.blockSize = bx.h / H * 100 + '%'; b.style.transform = 'translate(-50%, -50%) rotate(' + (t.rot || 0) + 'rad)'; }
    b.classList.toggle('selected', s.selected === t);
    if (t.type === 'text' || t.type === 'sticker') b.setAttribute('aria-label', _t('js.feed.ss.layer', 'Edit {name}', { name: layerName(t) }));
  }
  // the outline, its delete handle and (text / sticker) its turn-and-size corner, on the selected layer's box
  function placeSelect(s) {
    var t = picked(s), x = s.sel; if (s.handles.lastChild !== x) s.handles.appendChild(x);
    x.hidden = !t || !s.d.decoded; if (x.hidden) return;
    var b = s.layers[t.id];
    x.style.insetInlineStart = b.style.insetInlineStart; x.style.insetBlockStart = b.style.insetBlockStart;
    x.style.inlineSize = t.type === 'mention' ? 'auto' : b.style.inlineSize; x.style.blockSize = t.type === 'mention' ? 'auto' : b.style.blockSize;
    x.style.transform = t.type === 'mention' ? 'translate(-50%, -50%)' : b.style.transform;
    x.classList.toggle('sst-select-chip', t.type === 'mention'); s.selTurn.hidden = t.type === 'mention';
    x.style.setProperty('--sst-rot', (t.type === 'mention' ? 0 : t.rot || 0) + 'rad');      // the handles stay upright on a turned layer
  }
  function select(s, t) {
    if (s.selected === t) { layoutHandles(s); return; }
    s.selected = t; layoutHandles(s);
  }
  function removeLayer(s, t) {
    var list = t.type === 'text' ? s.d.texts : t.type === 'sticker' ? s.d.stickers : s.d.mentions, index = list.indexOf(t);
    if (index >= 0) list.splice(index, 1);
    if (s.selected === t) s.selected = null;
    if (s.sheet && s.sheetLayer === t) closeSheet(s);
    s.preview.focus(); changed(s, t.type !== 'mention');
  }
  // the keyboard on a focused layer: arrows move (Shift: 10%), + − size, [ ] turn (Shift: 15°), Delete / Backspace remove
  function layerKey(s, t, e) {
    if (s.busy) return; var k = e.key, step = e.shiftKey ? .1 : .01, turn = (e.shiftKey ? 15 : 5) * Math.PI / 180, art = t.type !== 'mention', used = true;
    var lim = t.type === 'text' ? G.LIMITS.text : G.LIMITS.sticker;
    if (k === 'ArrowLeft') t.x -= step; else if (k === 'ArrowRight') t.x += step; else if (k === 'ArrowUp') t.y -= step; else if (k === 'ArrowDown') t.y += step;
    else if (art && (k === '+' || k === '=')) t.size = clamp(t.size * 1.1, lim[0], lim[1]);
    else if (art && (k === '-' || k === '_' || k === '−')) t.size = clamp(t.size / 1.1, lim[0], lim[1]);
    else if (art && (k === ']' || k === '[')) t.rot = G.turnOf((t.rot || 0) + (k === ']' ? turn : -turn));
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removeLayer(s, t); return; }
    else used = false;
    if (!used) return;
    e.preventDefault(); if (s.selected !== t) s.selected = t;
    G.keepIn(t); placeLayer(s, s.layers[t.id], t); placeSelect(s); changed(s, art);
  }

  // ── storyux: the stage - pointers (touch, pen, mouse) on the preview, batched per animation frame ──
  // A gesture's target is the layer the first finger lands on (selected at once), or the picture when nothing is selected.
  // A first finger off the selected layer waits: a second finger then pinches that layer (a small one is easier pinched
  // around), the first one moving alone lets it go and pans the picture, and lifted it is a tap (deselects).
  // Each phase (the fingers down) starts from a snapshot, so nothing drifts; a third finger is ignored.
  var SLOP = 6, TAP_MS = 400;
  function frameNow() { return window.requestAnimationFrame ? function (f) { return window.requestAnimationFrame(f); } : function (f) { return setTimeout(f, 16); }; }
  function snapshot(t) { return { x: t.x, y: t.y, size: t.size, rot: t.rot || 0 }; }
  function canPan(s) { var d = s.d; return !!(d.decoded && !d.legacy && !d.gif && d.crop); }
  function stage(s) {
    var P = s.preview, raf = frameNow();
    function own() { return s.d.w / s.d.h; }
    function layerAt(target) { var b = target && target.closest ? target.closest('.sst-layer') : null, id = b && b.getAttribute('data-layer'); return id ? layersOf(s.d).filter(function (t) { return t.id === id; })[0] || null : null; }
    function ids(g) { return Object.keys(g.pts).slice(0, 2); }
    function rebase(g) {
      g.start = ids(g).map(function (id) { return { x: g.pts[id].x, y: g.pts[id].y }; }); g.acc = 0; g.prev = g.start.length === 2 ? G.angle(g.start[0], g.start[1]) : 0;
      g.rect = (g.target === 'base' ? P : s.handles).getBoundingClientRect();
      if (g.target && g.target !== 'base' && g.target !== 'wait') { g.s0 = snapshot(g.target); if (g.turn) { var c = centre(g); g.v0 = { x: g.start[0].x - c.x, y: g.start[0].y - c.y }; } }
      if (g.target === 'base') g.w0 = Object.assign({}, s.d.crop);
    }
    function centre(g) { return { x: g.rect.left + g.target.x * g.rect.width, y: g.rect.top + g.target.y * g.rect.height }; }
    function down(e) {
      if (!live(s) || s.busy || !s.d.decoded || (e.button != null && e.button > 0)) return;
      if (e.target && e.target.closest && e.target.closest('.sst-sel-del')) return;          // its own click
      unask(s);
      var g = s.gesture, turnCorner = !!(e.target && e.target.closest && e.target.closest('.sst-sel-turn'));
      if (!g) {
        var hit = turnCorner ? picked(s) : layerAt(e.target);
        if (!hit && !picked(s) && !canPan(s)) return;
        g = s.gesture = { pts: {}, n: 0, moved: false, two: false, turn: turnCorner && !!hit, hit: hit, target: hit || (picked(s) ? 'wait' : 'base') };
        if (hit && hit !== s.selected) select(s, hit);
      } else if (g.n >= 2 || g.turn) return;
      g.pts[e.pointerId] = { x: e.clientX, y: e.clientY }; g.n++;
      if (g.n === 2) { g.two = true; if (g.target === 'wait') g.target = picked(s); if (g.target && g.target !== 'base' && g.target.type === 'mention') g.target = null; }
      try { if (P.setPointerCapture) P.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      if (e.pointerType === 'mouse' && e.preventDefault) e.preventDefault();       // no text selection or image drag
      rebase(g);
    }
    function move(e) {
      var g = s.gesture, p = g && g.pts[e.pointerId]; if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (!g.moved) { var i = ids(g).indexOf(String(e.pointerId)), q = g.start[i]; if (q && Math.hypot(p.x - q.x, p.y - q.y) > SLOP) g.moved = true; }
      if (!s.raf) s.raf = raf(function () { s.raf = 0; apply(); });
    }
    function apply() {
      var g = s.gesture; if (!g || !live(s)) return;
      if (s.busy) { end(); return; }                                   // Post froze it
      if (g.target === 'wait') { if (!g.moved) return; select(s, null); g.target = canPan(s) ? 'base' : null; rebase(g); return; }
      if (!g.target) return;
      var now = ids(g).map(function (id) { return g.pts[id]; }), m;
      if (g.turn) { var c = centre(g), v = { x: now[0].x - c.x, y: now[0].y - c.y }, l0 = Math.hypot(g.v0.x, g.v0.y);
        m = { scale: l0 > 0 ? Math.hypot(v.x, v.y) / l0 : 1, turn: G.turnOf(Math.atan2(v.y, v.x) - Math.atan2(g.v0.y, g.v0.x)) }; }
      else if (now.length === 2) {
        var a = G.angle(now[0], now[1]); g.acc += G.turnOf(a - g.prev); g.prev = a;           // more than half a turn adds up
        m = G.twoFinger(g.start[0], g.start[1], now[0], now[1]); m.turn = g.acc;
      } else m = { dx: now[0].x - g.start[0].x, dy: now[0].y - g.start[0].y };
      if (g.target === 'base') {
        var r = g.rect, f = function (pt) { return { x: (pt.x - r.left) / r.width, y: (pt.y - r.top) / r.height }; };
        if (now.length === 2) { var m0 = { x: (g.start[0].x + g.start[1].x) / 2, y: (g.start[0].y + g.start[1].y) / 2 }, m1 = { x: (now[0].x + now[1].x) / 2, y: (now[0].y + now[1].y) / 2 };
          s.d.crop = G.zoom(g.w0, own(), s.d.fit, m.scale, f(m0), f(m1)); }
        else s.d.crop = G.pan(g.w0, own(), s.d.fit, m.dx / r.width, m.dy / r.height);
        placeMedia(s); dirty(s, true); return;
      }
      guides(s, G.moveItem(g.target, g.s0, m, g.rect, { snap: true })); paintLayer(s, g.target);
    }
    function up(e) {
      var g = s.gesture; if (!g || !g.pts[e.pointerId]) return;
      if (s.raf) { if (window.cancelAnimationFrame) window.cancelAnimationFrame(s.raf); s.raf = 0; apply(); }   // its last move still counts
      if (s.gesture !== g) return;
      delete g.pts[e.pointerId]; g.n--;
      if (g.n > 0) { rebase(g); return; }                             // the other finger carries on, from here
      var tap = !g.moved && !g.two && !g.wk && e.type === 'pointerup' && !s.busy; end();
      if (tap) tapped(s, g.hit, g.target);
    }
    function end() {
      var g = s.gesture; s.gesture = null; guides(s, null); if (!g || !live(s)) return;
      if (s.busy) { layoutHandles(s); return; }                      // posting: the draft is frozen as it was sent
      if (g.moved || g.two || g.wk) { var t = g.target; changed(s, !t || t === 'base' || t.type !== 'mention'); }
    }
    P.addEventListener('pointerdown', down);
    P.addEventListener('pointermove', move);
    P.addEventListener('pointerup', up);
    P.addEventListener('pointercancel', up);
    // the page never scrolls, zooms, selects or calls out under the stage (touch-action: none in the CSS does most of it)
    P.addEventListener('touchmove', function (e) { if (live(s) && s.d.file) e.preventDefault(); }, { passive: false });
    ['contextmenu', 'dragstart', 'selectstart'].forEach(function (type) { P.addEventListener(type, function (e) { e.preventDefault(); }); });
    // WebKit's own pinch events: always kept from zooming the page; they move a layer (or the picture) only when the pointer
    // stream has lost the second finger (scale and rotation from gesturestart, in degrees)
    P.addEventListener('gesturestart', function (e) {
      e.preventDefault(); var g = s.gesture; if (!live(s) || s.busy || !g || g.n >= 2) { s.wk = null; return; }
      var t = g.target === 'wait' ? picked(s) : g.target; if (!t || (t !== 'base' && t.type === 'mention')) { s.wk = null; return; }
      s.wk = { target: t, s0: t === 'base' ? null : snapshot(t), w0: t === 'base' ? Object.assign({}, s.d.crop) : null };
    }, { passive: false });
    P.addEventListener('gesturechange', function (e) {
      e.preventDefault(); var g = s.gesture, w = s.wk; if (!w || !live(s) || s.busy || (g && g.n >= 2)) return;
      var k = Number(e.scale) > 0 ? Number(e.scale) : 1, turn = (Number(e.rotation) || 0) * Math.PI / 180;
      if (g) { g.wk = true; if (g.target === 'wait') g.target = w.target; }
      if (w.target === 'base') { s.d.crop = G.zoom(w.w0, own(), s.d.fit, k, { x: .5, y: .5 }, { x: .5, y: .5 }); placeMedia(s); dirty(s, true); return; }
      guides(s, G.moveItem(w.target, w.s0, { scale: k, turn: turn }, s.handles.getBoundingClientRect(), { snap: true })); paintLayer(s, w.target);
      if (!g) changed(s, true);
    }, { passive: false });
    P.addEventListener('gestureend', function (e) { e.preventDefault(); s.wk = null; }, { passive: false });
    // a desktop: the wheel sizes the selected layer (ctrl+wheel = a trackpad pinch), Shift+wheel turns it; with nothing
    // selected it zooms the picture about the pointer
    P.addEventListener('wheel', function (e) {
      if (!live(s) || s.busy || s.gesture || !s.d.decoded) return;
      var t = picked(s); if (t && t.type === 'mention') t = null; if (!t && !canPan(s)) return;
      e.preventDefault(); var dv = Number(e.deltaY) || Number(e.deltaX) || 0; if (e.deltaMode === 1) dv *= 16; else if (e.deltaMode === 2) dv *= 400;
      var k = Math.exp(-dv * (e.ctrlKey ? .01 : .0015));
      if (t) { G.moveItem(t, snapshot(t), e.shiftKey ? { turn: dv * .0025 } : { scale: k }, s.handles.getBoundingClientRect()); paintLayer(s, t); dirty(s, true); wheelDone(s); return; }
      var r = P.getBoundingClientRect(), f = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      if (!(f.x >= 0 && f.x <= 1)) f.x = .5; if (!(f.y >= 0 && f.y <= 1)) f.y = .5;
      s.d.crop = G.zoom(s.d.crop, own(), s.d.fit, k, f, f); placeMedia(s); dirty(s, true); wheelDone(s);
    }, { passive: false });
    // the focused picture: arrows pan (Shift: 10%), + − zoom, 0 puts it back
    P.addEventListener('keydown', function (e) {
      if (e.target !== P || s.busy || !canPan(s)) return; var q = e.shiftKey ? .1 : .01, used = true, d = s.d;
      if (e.key === 'ArrowLeft') d.crop = G.pan(d.crop, own(), d.fit, -q, 0); else if (e.key === 'ArrowRight') d.crop = G.pan(d.crop, own(), d.fit, q, 0);
      else if (e.key === 'ArrowUp') d.crop = G.pan(d.crop, own(), d.fit, 0, -q); else if (e.key === 'ArrowDown') d.crop = G.pan(d.crop, own(), d.fit, 0, q);
      else if (e.key === '+' || e.key === '=') d.crop = G.zoom(d.crop, own(), d.fit, 1.1, { x: .5, y: .5 }, { x: .5, y: .5 });
      else if (e.key === '-' || e.key === '_' || e.key === '−') d.crop = G.zoom(d.crop, own(), d.fit, 1 / 1.1, { x: .5, y: .5 }, { x: .5, y: .5 });
      else if (e.key === '0') resetFrame(d, d.fit);
      else used = false;
      if (used) { e.preventDefault(); changed(s, true); }
    });
  }
  // a wheel turn ends a moment later: then the full render and the controls
  function wheelDone(s) { clearTimeout(s.wheelTimer); s.wheelTimer = setTimeout(function () { if (live(s) && !s.gesture) changed(s, true); }, 120); }
  // pixels changed under a gesture: a finished upload no longer matches (discarded once, at once)
  function dirty(s, pixels) { s.failed = false; if (pixels && s.ready) { discard([s.ready.id]); s.ready = null; } }
  // one layer moved: redraw the overlay and move its handle and the outline - nothing else is laid out
  function paintLayer(s, t) { if (t.type !== 'mention') { dirty(s, true); draw(s.canvas, s.d); } var b = s.layers[t.id]; if (b) placeLayer(s, b, t); placeSelect(s); }
  function guides(s, g) { s.guides.v.hidden = !(g && g.v); s.guides.h.hidden = !(g && g.h); }
  // a tap: on a layer, select it (a second tap on a text within TAP_MS opens its words); elsewhere, let the selection go - and a
  // double tap on the picture puts it back the way its layout starts
  function tapped(s, hit, target) {
    var now = Date.now(), last = s.lastTap; s.lastTap = { on: hit || 'base', at: now };
    if (hit) {
      select(s, hit); var b = s.layers[hit.id]; if (b && b.focus) b.focus();
      if (hit.type === 'text' && last && last.on === hit && now - last.at < TAP_MS) { s.lastTap = null; textSheet(s, hit); }
      return;
    }
    if (target === 'wait' || picked(s)) { select(s, null); return; }
    if (last && last.on === 'base' && now - last.at < TAP_MS && canPan(s)) { s.lastTap = null; resetFrame(s.d, s.d.fit); changed(s, true); }
  }
  function tool(s, name) { if (s.busy || !s.d.file || !s.d.valid) return; if (name === 'layout') toggleLayout(s); else if (name === 'text') textSheet(s); else if (name === 'sticker') stickerSheet(s); else if (name === 'mention') mentionSheet(s); else if (name === 'trim') trimSheet(s); }
  // 📐: Fill (the picture covers the frame, around the same centre) or Fit (the whole picture)
  function toggleLayout(s) {
    var d = s.d; if (!d.decoded || d.legacy || !G.canFill(d.w / d.h)) return;
    d.fit = d.fit === 'fill' ? 'fit' : 'fill'; d.crop = G.layout(d.crop, d.w / d.h, d.fit); changed(s, true);
  }
  function textSheet(s, t) {
    if (!s.d.decoded || s.d.legacy) return; var box = sheet(s, 'text', _t('js.feed.ss.text', '🔤 Text'));
    if (!t) {
      s.d.texts.forEach(function (layer) { add(box, button(layer.text || _t('js.feed.ss.empty_text', 'Empty text'), function () { select(s, layer); textSheet(s, layer); })); });
      if (s.d.texts.length >= (s.caps.textsMax || 3)) { add(box, el('p', null, _t('js.feed.ss.text_limit', 'You can add up to {n} text layers.', { n: s.caps.textsMax || 3 }))); return; }
      t = { id: 'text-' + (++serial), type: 'text', text: '', size: 72, rot: 0, x: .5, y: .3, color: COLORS[0], style: 'plain' };
    }
    s.selected = t; s.sheetLayer = t; var ta = add(box, el('textarea', 'ds-in sst-text-input')); ta.rows = 2; ta.value = t.text; ta.setAttribute('aria-label', _t('js.feed.ss.words', 'Story text')); var count = add(box, el('span', 'sst-help'));
    function update() { ta.value = chars(ta.value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')).slice(0, s.caps.textLen || 120).join(''); t.text = ta.value; count.textContent = _t('js.feed.ss.characters', '{used}/{max} characters', { used: chars(t.text).length, max: s.caps.textLen || 120 }); if (t.text.trim() && s.d.texts.indexOf(t) < 0) s.d.texts.push(t); if (!t.text.trim() && s.d.texts.indexOf(t) >= 0) s.d.texts.splice(s.d.texts.indexOf(t), 1); changed(s, true); }
    ta.addEventListener('input', update); count.textContent = _t('js.feed.ss.characters', '{used}/{max} characters', { used: chars(t.text).length, max: s.caps.textLen || 120 });
    var styles = add(box, el('div', 'ds-seg'));
    [['plain', _t('js.feed.ss.plain', 'Plain')], ['box', _t('js.feed.ss.box', 'Box')], ['pixel', _t('js.feed.ss.pixel', 'Pixel')], ['outline', _t('js.feed.ss.outline', 'Outline')]].forEach(function (p) { var b = add(styles, button(p[1], function () { t.style = p[0]; Array.prototype.forEach.call(styles.children, function (n) { n.setAttribute('aria-pressed', String(n === b)); }); changed(s, true); })); b.setAttribute('aria-pressed', String(t.style === p[0])); });
    var palette = add(box, el('div', 'sst-colors')); COLORS.forEach(function (c, index) { var b = add(palette, button(null, function () { t.color = c; changed(s, true); })); b.style.setProperty('--sst-ink', c); b.setAttribute('aria-label', _t('js.feed.ss.color', 'Text colour {n}', { n: index + 1 })); });
    // storyux: no size or position sliders - the text is placed, sized and turned on the picture
    add(box, el('p', 'sst-help', _t('js.feed.ss.place_help', 'Drag it on the picture to move it; pinch to resize and twist to turn.')));
    if (s.d.texts.indexOf(t) >= 0) add(box, button(_t('js.feed.ss.delete_layer', 'Delete layer'), function () { removeLayer(s, t); }, 'quiet sm sst-delete'));
    ta.focus(); render(s);
  }
  function stickerImage(s, st) {
    if (!/^\/public\/stickers\/[a-z0-9]+\/[a-z0-9]+\.svg$/.test(st.url)) return Promise.reject(new Error(_t('js.feed.ss.sticker_failed', 'That sticker could not load.')));
    return fetch(st.url, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(_t('js.feed.ss.sticker_failed', 'That sticker could not load.')); return r.text(); }).then(function (text) {
      var xml = new DOMParser().parseFromString(text, 'image/svg+xml'), root = xml.documentElement;
      if (root.nodeName.toLowerCase() !== 'svg' || xml.querySelector('parsererror')) throw new Error(_t('js.feed.ss.sticker_failed', 'That sticker could not load.'));
      root.setAttribute('width', '240'); root.setAttribute('height', '240');
      var blob = new Blob([new XMLSerializer().serializeToString(xml)], { type: 'image/svg+xml' });
      if (!live(s)) throw new Error('closed'); var url = objectURL(s, blob);
      return new Promise(function (resolve, reject) { var image = new Image(); image.onload = function () { resolve(image); }; image.onerror = function () { reject(new Error(_t('js.feed.ss.sticker_failed', 'That sticker could not load.'))); }; image.src = url; });
    });
  }
  // the sticker picker; a chosen sticker lands in the middle, selected, ready to be dragged, pinched and twisted
  function stickerSheet(s) {
    if (!s.d.decoded || s.d.legacy) return; var box = sheet(s, 'sticker', _t('js.feed.ss.sticker', '🧸 Sticker'));
    var note = add(box, el('p', 'sst-help', _t('js.feed.sc.loading', 'Loading…')));
    var catalog = s.catalog ? Promise.resolve(s.catalog) : req('/api/stickers').then(function (data) { s.catalog = data; return data; });
    catalog.then(function (data) {
      if (!live(s) || !box.isConnected) return; note.remove();
      var packs = (data.packs || []).filter(function (p) { return p.owned; }); if (!packs.length) add(box, el('p', null, _t('js.feed.ss.no_stickers', 'Your sticker packs will appear here.')));
      packs.forEach(function (p) { add(box, el('h4', 'ds-label', p.name)); var grid = add(box, el('div', 'sst-stickers')); (p.stickers || []).forEach(function (st) {
        var b = add(grid, button(null, function () {
          if (s.d.stickers.length + (s.pendingStickers || 0) >= (s.caps.stickersMax || 10)) { say(s, _t('js.feed.ss.sticker_limit', 'You can add up to {n} stickers.', { n: s.caps.stickersMax || 10 }), true); return; }
          b.disabled = true; var draft = s.d; s.pendingStickers = (s.pendingStickers || 0) + 1; paintControls(s);
          stickerImage(s, st).then(function (img) { if (!live(s) || s.d !== draft || s.busy || s.d.stickers.length >= (s.caps.stickersMax || 10)) return; var t = { type: 'sticker', id: 'sticker-' + (++serial), pack: p.id, sticker: st.id, name: st.name, img: img, size: 240, rot: 0, x: .5, y: .5 }; s.d.stickers.push(t); if (s.sheetName === 'sticker') closeSheet(s); s.selected = t; changed(s, true); }).catch(function (e) { if (live(s)) say(s, e.message, true); }).finally(function () { b.disabled = false; s.pendingStickers--; if (live(s)) paintControls(s); });
        }, 'quiet sst-sticker')); var im = add(b, el('img')); im.src = st.url; im.alt = ''; add(b, el('span', null, st.name));
      }); });
      var more = add(box, el('a', 'ds-btn link', _t('js.feed.ss.more_stickers', 'Get more stickers'))); more.href = '/cosmetics?tab=stickers'; more.target = '_blank'; more.rel = 'noopener';
    }).catch(function (e) { if (live(s) && box.isConnected) note.textContent = e.message; });
  }
  function mentionSheet(s) {
    var box = sheet(s, 'mention', _t('js.feed.ss.mention', '👤 Mention'));
    s.d.mentions.forEach(function (m) { add(box, button('@' + m.username, function () { closeSheet(s); select(s, m); var b = s.layers[m.id]; if (b) b.focus(); })); });
    if (s.d.mentions.length >= (s.caps.mentionsMax || 5)) { add(box, el('p', null, _t('js.feed.ss.mention_limit', 'You can mention up to {n} people.', { n: s.caps.mentionsMax || 5 }))); return; }
    var f = s.mentionInput = input('text'); f.autocomplete = 'off'; f.setAttribute('role', 'combobox'); f.setAttribute('aria-expanded', 'false'); f.setAttribute('aria-autocomplete', 'list'); add(box, field(_t('js.feed.ss.find_person', 'Find a person'), f));
    var list = s.suggestions = add(box, el('div', 'ds-pop sst-suggestions')); list.id = 'sst-suggest-' + s.id; list.setAttribute('role', 'listbox'); f.setAttribute('aria-controls', list.id); list.hidden = true; var people = [], at = -1, queryId = 0;
    function choose(p) { if (!p) return; if (!s.d.mentions.some(function (m) { return m.username.toLowerCase() === p.username.toLowerCase(); })) s.d.mentions.push({ type: 'mention', id: 'mention-' + (++serial), username: p.username, display: p.display, x: .5, y: s.d.decoded ? .75 : .5 }); closeSheet(s); changed(s, false); if (!s.d.decoded) say(s, _t('js.feed.ss.mention_unpreviewed', 'Mentions will appear in the centre after this file is converted.')); }
    function highlight() { Array.prototype.forEach.call(list.children, function (n, i) { n.setAttribute('aria-selected', String(i === at)); }); if (at >= 0) f.setAttribute('aria-activedescendant', list.children[at].id); else f.removeAttribute('aria-activedescendant'); }
    f.addEventListener('input', function () { clearTimeout(s.suggestTimer); var q = f.value.trim().replace(/^@/, ''), n = ++queryId; list.hidden = true; f.setAttribute('aria-expanded', 'false'); if (!q) return;
      s.suggestTimer = setTimeout(function () { req('/api/mentions/suggest?q=' + encodeURIComponent(q)).then(function (data) { if (!live(s) || !box.isConnected || n !== queryId) return; people = data.people || []; at = -1; list.textContent = ''; people.forEach(function (p, i) { var b = add(list, button('@' + p.username + (p.display && p.display !== p.username ? ' · ' + p.display : ''), function () { choose(p); }, 'quiet sst-suggestion')); b.id = list.id + '-' + i; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', 'false'); }); list.hidden = !people.length; f.setAttribute('aria-expanded', String(!!people.length)); }).catch(function (e) { if (live(s) && box.isConnected && n === queryId) say(s, e.message, true); }); }, 250);
    });
    f.addEventListener('keydown', function (e) { if (list.hidden) return; if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = (at + (e.key === 'ArrowDown' ? 1 : -1) + people.length) % people.length; highlight(); } else if ((e.key === 'Enter' || e.key === 'Tab') && at >= 0) { e.preventDefault(); choose(people[at]); } }); f.focus();
  }
  // ── storyux: the X after a pick or a capture - back to the live camera (or the picker), the draft let go; with edits, a quiet
  // question in the editor first (no browser dialog) ──
  function cameraOK(s) { return !!window.patvStoryCamera && !s.camFailed && !s.noPost && (!window.patvStoryCamera.available || window.patvStoryCamera.available()); }
  function edited(s) {
    var d = s.d; if (!d.file) return false;
    if (d.texts.length || d.stickers.length || d.mentions.length) return true;
    if (d.decoded && d.start && (d.fit !== d.start.fit || !G.same(d.crop, d.start.crop))) return true;
    return !!(d.trim && d.trim0 && (d.trim.start !== d.trim0.start || d.trim.end !== d.trim0.end));
  }
  function goBack(s) {
    if (!live(s) || s.busy || !s.d.file) return;
    if (edited(s) && !s.ask) { ask(s); return; }
    unask(s); fresh(s);
    if (!camera(s)) { paintControls(s); var first = s.picks.querySelector('button'); (first || s.root).focus(); say(s, s.camWhy || ''); }
  }
  function ask(s) {
    var bar = s.ask = add(s.card, el('div', 'sst-ask')); bar.setAttribute('role', 'group');
    var q = _t('js.feed.ss.discard_edits', 'Discard your edits?'); bar.setAttribute('aria-label', q); add(bar, el('p', null, q));
    var keep = add(bar, button(_t('js.feed.ss.keep_editing', 'Keep editing'), function () { unask(s, true); }, 'quiet sm sst-ask-keep'));
    add(bar, button(_t('js.feed.ss.discard_go', 'Discard'), function () { goBack(s); }, 'sm sst-ask-go'));
    keep.focus();
  }
  function unask(s, refocus) { if (!s.ask) return; s.ask.remove(); s.ask = null; if (refocus && s.backButton && !s.backButton.hidden) s.backButton.focus(); }
  // the draft let go: no picture, no layers, nothing uploaded (the NSFW choice and the destination stay)
  function fresh(s) {
    if (s.ready) discard([s.ready.id]); s.ready = null; s.failed = false; closeSheet(s); revoke(s);
    if (s.media) { if (s.media.pause) s.media.pause(); s.media.remove(); s.media = null; }
    s.d = { file: null, texts: [], stickers: [], mentions: [], fit: 'fit', crop: null, nsfw: s.d.nsfw }; s.pickId++; s.sniffId = (s.sniffId || 0) + 1;
    s.selected = null; s.gesture = null; s.lastTap = null; s.empty.hidden = false; s.filename.textContent = ''; s.recovery.hidden = true; s.recovery.textContent = '';
    say(s, ''); render(s); paintControls(s);
  }
  function trimSheet(s) {
    var d = s.d; if (d.kind !== 'video' || !d.decoded || !d.trim || !(d.duration >= 1)) return;
    var box = sheet(s, 'trim', _t('js.feed.ss.trim', '✂️ Trim')), bar = add(box, el('div', 'sst-trim-bar')), fill = add(bar, el('span', 'sst-trim-fill'));
    var report = add(box, el('p', 'sst-trim-report')); report.setAttribute('aria-live', 'polite'); var inputs = {}, handles = {};
    function update(which, raw) {
      var max = Math.min(30, s.caps.secs || 30), v = Math.round(raw * 2) / 2;
      if (which === 'start') d.trim.start = clamp(v, Math.max(0, d.trim.end - max), d.trim.end - 1);
      else d.trim.end = clamp(v, d.trim.start + 1, Math.min(d.duration, d.trim.start + max));
      sync(); if (s.media.currentTime < d.trim.start || s.media.currentTime >= d.trim.end) s.media.currentTime = d.trim.start; changed(s, true);
    }
    function sync() { ['start', 'end'].forEach(function (w) { inputs[w].value = d.trim[w]; handles[w].value = d.trim[w]; handles[w].setAttribute('aria-valuetext', time(d.trim[w])); }); fill.style.insetInlineStart = d.trim.start / d.duration * 100 + '%'; fill.style.inlineSize = (d.trim.end - d.trim.start) / d.duration * 100 + '%'; report.textContent = _t('js.feed.ss.trim_range', '{start} – {end} ({n} s)', { start: time(d.trim.start), end: time(d.trim.end), n: Math.round((d.trim.end - d.trim.start) * 10) / 10 }); }
    var numbers = add(box, el('div', 'sst-position'));
    [['start', _t('js.feed.ss.trim_start', 'Start time')], ['end', _t('js.feed.ss.trim_end', 'End time')]].forEach(function (p) { var r = handles[p[0]] = add(bar, input('range', d.trim[p[0]])); r.classList.add('sst-trim-handle', 'sst-trim-' + p[0]); r.min = 0; r.max = d.duration; r.step = .5; r.setAttribute('aria-label', p[1]); r.addEventListener('input', function () { update(p[0], +r.value); }); var n = inputs[p[0]] = input('number', d.trim[p[0]]); n.min = 0; n.max = d.duration; n.step = .5; n.addEventListener('change', function () { if (isFinite(+n.value)) update(p[0], +n.value); }); add(numbers, field(p[1], n)); });
    var actions = add(box, el('div', 'sst-position'));
    add(actions, iconButton(_t('js.feed.ss.play', '▶️ Play / pause'), function () { if (s.media.paused) { if (s.media.currentTime < d.trim.start || s.media.currentTime >= d.trim.end) s.media.currentTime = d.trim.start; s.media.play().catch(function () {}); } else s.media.pause(); }));
    var mute = add(actions, iconButton(_t('js.feed.ss.mute', '🔇 Mute preview'), function () { s.media.muted = !s.media.muted; mute.setAttribute('aria-pressed', String(s.media.muted)); })); mute.setAttribute('aria-pressed', String(s.media.muted)); sync(); handles.start.focus();
  }
  function time(n) { var whole = Math.floor(n); return Math.floor(whole / 60) + ':' + ('0' + whole % 60).slice(-2) + (n % 1 ? '.5' : ''); }
  // The only mapping from an in-memory draft to the v1 edit contract (reusable by v2).
  function editFor(s, overlay) {
    var d = s.d; if (d.legacy || d.gif) return null;
    var edit = { v: 1, pad: s.target.id, fit: d.fit, text: d.texts.map(function (t) { return t.text.trim(); }).filter(Boolean), stickers: d.stickers.map(function (t) { return { pack: t.pack, sticker: t.sticker }; }) };
    // storyux: Fill's crop (inside the picture), or Fit's frame - only once the picture was pinched or dragged off the whole
    // picture (the whole picture goes with no frame, as before)
    if (d.fit === 'fill') edit.crop = { x: d.crop.x, y: d.crop.y, w: d.crop.w, h: d.crop.h };
    else if (d.crop && !G.same(d.crop, G.contain(d.w / d.h))) edit.frame = { x: d.crop.x, y: d.crop.y, w: d.crop.w, h: d.crop.h };
    // storyfix2: a camera clip says so, and any video kept whole (inside the story's length) goes with no trim - the length a
    // browser shows can run past what the file holds (an iPhone recording, chosen or just taken), so the server encodes all of
    // it (a camera clip's own trim is clamped to the file there)
    if (d.kind === 'video') {
      if (d.camera) edit.camera = true;
      if (d.trim.start > 0 || d.trim.end < d.duration) edit.trim = { start: d.trim.start, end: d.trim.end };
    }
    if (overlay) edit.overlay = overlay; return edit;
  }
  function overlay(s) { return fonts(s.d).then(function () { var c = document.createElement('canvas'); c.width = W; c.height = H; draw(c, s.d); return new Promise(function (resolve, reject) { c.toBlob(function (blob) { if (!blob || blob.size > (s.caps.overlayMb || 2) * 1024 * 1024) reject(new Error(_t('js.feed.ss.overlay_big', 'Those layers are too detailed. Remove a layer and try again.'))); else resolve(blob); }, 'image/png'); }); }); }
  function activeAttempt(s, a) { if (!live(s) || a.cancelled || s.attempt !== a) throw new Error('cancelled'); }
  function upload(s, a, blob, kind, purpose, edit) {
    var body = { kind: kind, size: blob.size, name: purpose === 'story_ovl' ? 'story-overlay.png' : String(blob.name || '').slice(0, 100), purpose: purpose }; if (edit) body.edit = edit;
    activeAttempt(s, a);
    return req('/api/feed/uploads', body).then(function (data) { a.ids.push(data.id); if (!live(s) || a.cancelled || s.attempt !== a) { discard([data.id]); throw new Error('cancelled'); }
      var id = data.id, offset = 0, chunk = data.chunk || CHUNK, failures = 0;
      function next() {
        activeAttempt(s, a);
        if (offset >= blob.size) return req('/api/feed/uploads/' + id + '/finish', {}).then(function () { return waitReady(s, a, id, kind); });
        var at = offset;
        return fetch('/api/feed/uploads/' + id + '?offset=' + at, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: blob.slice(at, Math.min(blob.size, at + chunk)) }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) { activeAttempt(s, a); if ((!r.ok && r.status !== 409) || !isFinite(j.received) || j.received < 0 || j.received > blob.size || j.received === offset) throw new Error(j.error || _t('js.feed.sc.failed', 'That didn\'t work.')); failures = 0; offset = j.received; s.meter.value = Math.round(offset / blob.size * 100); say(s, _t('js.feed.sc.uploading_pct', 'Uploading {n}%', { n: s.meter.value })); });
        }).catch(function (e) { activeAttempt(s, a); if (++failures > 3) throw e; return new Promise(function (resolve) { setTimeout(resolve, 350 * failures); }); }).then(next);
      } return next();
    });
  }
  function waitReady(s, a, id, kind) {
    say(s, kind === 'video' ? _t('js.feed.sc.converting', 'Converting your video (this can take a minute)…') : _t('js.feed.sc.processing', 'Processing…'));
    var polls = 0;
    function poll() { activeAttempt(s, a); if (++polls > 300) throw new Error(_t('js.feed.fc.too_long', 'Processing took too long.')); return req('/api/feed/uploads/' + id).then(function (d) { activeAttempt(s, a); if (d.state === 'ready') return id; if (d.state === 'failed' || d.state === 'deleted') throw new Error(d.error || _t('js.feed.fc.not_processed', 'That file couldn\'t be processed.')); return later(); }, function (e) { activeAttempt(s, a); if (e.status && e.status < 500) throw e; return later(); }); }
    function later() { return new Promise(function (resolve) { setTimeout(resolve, polls < 10 ? 800 : 2000); }).then(poll); } return poll();
  }
  function post(s) {
    if (s.post.disabled || s.busy) return; closeSheet(s); s.failed = false; s.busy = true; s.recovery.hidden = true;
    var a = s.attempt = { ids: [], cancelled: false, stage: 'upload' }; s.progress.hidden = false; paintControls(s); say(s, _t('js.feed.sc.uploading', 'Uploading…'));
    var ready = s.ready ? Promise.resolve(s.ready.id) : Promise.resolve(null).then(function () {
      if (s.d.texts.length || s.d.stickers.length) return overlay(s).then(function (blob) { return upload(s, a, blob, 'image', 'story_ovl', null); }); return null;
    }).then(function (overlayId) { activeAttempt(s, a); return upload(s, a, s.d.file, s.d.kind, 'story', editFor(s, overlayId)); });
    ready.then(function (id) { activeAttempt(s, a); s.ready = { id: id }; a.stage = 'mine'; if (a.ids.indexOf(id) < 0) a.ids.push(id); paintControls(s); say(s, _t('js.feed.sc.posting', 'Posting…')); return req('/api/stories/mine', { attachment: id, pad: s.target.id, nsfw: s.d.nsfw, mentions: s.d.mentions.map(function (m) { return { username: m.username, x: m.x, y: m.y }; }) }); }).then(function (data) {
      activeAttempt(s, a); var story = data.story || {}, circle = story.circle;
      // Decoration belongs to the returned destination, not to a possibly changed picker or a shared server object.
      if (circle && !circle.person) { circle = Object.assign({}, circle); var target = s.targets.filter(function (p) { return !p.profile && p.id === story.scope; })[0]; if (target && target.look && target.look.avatar) circle.avatar = target.look.avatar; }
      var detail = { circle: circle, item: story.item, scope: story.scope }; s.busy = false; s.ready = null; s.attempt = null; close(s, true);
      document.dispatchEvent(new CustomEvent('patv:story-posted', { detail: detail })); toast(story);
    }).catch(function (e) { if (!live(s) || a.cancelled || s.attempt !== a) return; s.busy = false; s.failed = true; s.progress.hidden = true;
      if (a.stage !== 'mine') { discard(a.ids); s.ready = null; } s.attempt = null; say(s, e.message || _t('js.feed.sc.failed', 'That didn\'t work.'), true);
      // storyprev verify: a camera clip framed on its poster (this browser couldn't show the recording) that the server refuses -
      // its crop read against the file - can still go as it is, as it did before the poster
      if (e.message === "Animated pictures can't be edited yet - post it as it is." || (s.d.poster && !s.d.legacy && a.stage !== 'mine')) { s.recovery.textContent = ''; s.recovery.hidden = false; add(s.recovery, button(_t('js.feed.ss.as_is', 'Post it as it is'), function () { asIs(s); })); }
      paintControls(s);
    });
  }
  function toast(story) {
    var host = Array.prototype.filter.call(document.body.children, function (e) { return e.classList.contains('ds-toasts'); })[0]; if (!host) host = add(document.body, el('div', 'ds-toasts'));
    var node = add(host, el('div', 'ds-toast ok', _t('js.feed.sc.posted', 'Posted! It\'s up for 24 hours.'))); node.setAttribute('role', 'status');
    var represented = story.circle && Array.prototype.some.call(document.querySelectorAll('[data-story-room]'), function (n) { return n.getAttribute('data-story-room') === story.circle.id; });
    if (!represented) { var view = add(node, el('a', 'ds-btn link', _t('js.feed.ss.view', 'View'))); view.href = story.href || '#'; view.addEventListener('click', function (e) { if (window.patvStories && story.circle && story.item) { e.preventDefault(); window.patvStories.open(story.circle.id, story.item.id, view, story.scope); } }); }
    setTimeout(function () { node.remove(); }, 9000);
  }
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-story-compose]'); if (!b || (e.button != null && e.button !== 0)) return; e.preventDefault(); open(b.getAttribute('data-pad') || '', b); });
  window.patvStoryStudio = { open: function (pad, opener) { return open(pad, opener); }, geometry: G };
  // ssfix: back from a picker as a reloaded page (WebKit: a 'back_forward' load) - reopen where the story was, and say the picture didn't arrive
  function resume() { var note = takeNote(); if (note && !current) open(note.pad, document.querySelector('[data-story-compose]'), note); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resume); else resume();
})();
