// Story Studio (1.99alq): local drafts, one shared overlay renderer, and a versioned server edit.
// No media leaves the device before Post. Mentions remain removable data, never overlay pixels.
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
  function iconButton(label, fn, cls) {
    var b = button(null, fn, cls || 'icon sm quiet'), bits = chars(label), first = bits.shift();
    if (bits[0] === '\ufe0f') first += bits.shift();
    b.setAttribute('aria-label', label); b.title = label;
    var ic = add(b, el('span', 'ds-ic', first)); ic.setAttribute('aria-hidden', 'true');
    add(b, el('span', 'sst-button-label', bits.join('').trim())); return b;
  }
  function field(label, input) { var l = el('label', 'sst-field'); add(l, el('span', 'ds-label', label)); add(l, input); return l; }
  function input(type, value) { var i = el('input', 'ds-in'); i.type = type; if (value != null) i.value = value; return i; }
  function live(s) { return current === s && !s.closed; }
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
    s.closed = true; settle(s); clearTimeout(s.suggestTimer); revoke(s);
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
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (s.cam) s.cam.cancel(); else if (s.suggestions && !s.suggestions.hidden) { s.suggestions.hidden = true; if (s.mentionInput) s.mentionInput.setAttribute('aria-expanded', 'false'); } else if (s.sheet) closeSheet(s); else close(s); return; }
    if (e.key === 'Tab') {
      var list = focusables(s.sheet || s.root); if (s.sheetName === 'crop') list.unshift(s.preview); var i = list.indexOf(document.activeElement);
      if (!list.length) { e.preventDefault(); s.root.focus(); }
      else if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && (i < 0 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
    }
  }
  function open(pad, opener, resumed) {
    if (current) return;
    var s = { id: ++serial, opener: opener || document.activeElement, pad: String(pad || ''), urls: [], d: { file: null, texts: [], stickers: [], mentions: [], fit: 'fit', crop: null, zoom: 1, nsfw: false }, caps: {}, targets: [], busy: false, closed: false, selected: null, drawId: 0, pickId: 0 };
    current = s; s.root = el('div', 'sst ds-scrim sheet'); s.root.setAttribute('role', 'dialog'); s.root.setAttribute('aria-modal', 'true'); s.root.tabIndex = -1; s.root.setAttribute('aria-label', _t('js.feed.sc.title', 'Add your story'));
    s.root.addEventListener('click', function (e) { if (e.target === s.root) close(s); });
    s.oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; add(document.body, s.root);
    s.card = add(s.root, el('section', 'ds-modal sst-card'));
    var head = add(s.card, el('header', 'sst-head'));
    s.closeButton = add(head, iconButton(_t('js.feed.ss.close', '⬅️ Close story editor'), function () { close(s); }, 'icon sm quiet sst-icon-only'));
    add(head, el('h2', 'ds-pixel-h', _t('js.feed.ss.title', 'Your story')));
    add(head, el('span', 'sst-lifetime', _t('js.feed.ss.hours_short', '24 h')));
    s.more = add(head, iconButton(_t('js.feed.ss.options', '⚙️ Story options'), function () { optionsSheet(s); }, 'icon sm quiet sst-icon-only'));
    s.body = add(s.card, el('div', 'sst-body')); var work = add(s.body, el('div', 'sst-work'));
    s.previewWrap = add(work, el('div', 'sst-preview-wrap')); s.preview = add(s.previewWrap, el('div', 'sst-preview')); s.preview.tabIndex = 0;
    s.preview.setAttribute('aria-label', _t('js.feed.ss.preview', 'Story preview. Use the editing tools to make it yours.'));
    s.empty = add(s.preview, el('div', 'sst-empty')); var emptyIcon = add(s.empty, el('span', 'ds-ic', _t('js.feed.ss.camera_icon', '📷'))); emptyIcon.setAttribute('aria-hidden', 'true'); add(s.empty, el('p', null, _t('js.feed.ss.choose', 'Choose a picture or video')));
    s.canvas = add(s.preview, el('canvas', 'sst-overlay')); s.canvas.width = W; s.canvas.height = H; s.canvas.setAttribute('aria-hidden', 'true');
    s.handles = add(s.preview, el('div', 'sst-handles')); s.picks = add(work, el('div', 'sst-picks'));
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
    s.retake = add(s.picks, iconButton(_t('js.feed.ss.retake', '📸 Retake'), function () { if (!camera(s)) choose(s, 'camera'); })); s.retake.setAttribute('data-picker', 'retake'); s.retake.hidden = true;
    s.filename = add(s.picks, el('span', 'sst-filename'));
    s.summary = add(s.body, el('aside', 'sst-summary')); add(s.summary, el('h3', 'ds-eyebrow', _t('js.feed.ss.summary', 'Story details')));
    add(s.summary, el('p', null, _t('js.feed.ss.canvas', 'Canvas 9:16'))); add(s.summary, el('p', null, _t('js.feed.ss.lifetime', 'Appears for 24 hours')));
    s.summaryPad = add(s.summary, el('p')); s.summaryAs = add(s.summary, el('p'));
    s.tools = add(s.card, el('div', 'sst-tools')); s.toolButtons = {};
    [['crop', _t('js.feed.ss.crop', '📐 Crop')], ['text', _t('js.feed.ss.text', '🔤 Text')], ['sticker', _t('js.feed.ss.sticker', '🧸 Sticker')], ['mention', _t('js.feed.ss.mention', '👤 Mention')], ['trim', _t('js.feed.ss.trim', '✂️ Trim')]].forEach(function (p) {
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
    cropGestures(s); paintControls(s); say(s, _t('js.feed.sc.loading', 'Loading…')); s.root.focus();
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
      close: function () { s.cam = null; if (!s.d.file) close(s); else (s.retake.hidden ? s.picks.querySelector('[data-picker="camera"]') : s.retake).focus(); },
      unavailable: function (why) { s.cam = null; s.camWhy = why; s.camFailed = true; if (live(s)) say(s, why); } });
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
    s.destination.disabled = s.busy || !s.targets.length; s.more.disabled = s.busy;
    Array.prototype.forEach.call(s.picks.querySelectorAll('button'), function (b) { b.disabled = s.busy; });
    // storyfix2: a video under a second has no 1 s window to trim
    Object.keys(s.toolButtons).forEach(function (k) { var b = s.toolButtons[k]; b.disabled = s.busy || !d.file || !d.valid || (k !== 'mention' && (!d.decoded || d.legacy || d.gif)) || (k === 'trim' && (d.kind !== 'video' || !(d.duration >= 1))); b.setAttribute('aria-pressed', String(s.sheetName === k)); });
    s.post.textContent = s.failed ? _t('js.feed.ss.retry', 'Retry') : _t('js.feed.sc.post', 'Post story');
  }
  function changed(s, pixels) { s.failed = false; if (pixels && s.ready) { discard([s.ready.id]); s.ready = null; } render(s); paintControls(s); }
  function closeSheet(s) { if (!s.sheet) return; var opener = s.sheetOpener; s.sheetSlot.textContent = ''; s.sheet = null; s.sheetName = null; s.suggestions = null; s.mentionInput = null; clearTimeout(s.suggestTimer); s.root.classList.remove('sst-has-sheet'); s.root.removeAttribute('data-sheet'); paintControls(s); if (opener && opener.isConnected) opener.focus(); }
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
  function framing(d) {
    var ratio = W / H, own = d.w / d.h;
    var w = own > ratio ? ratio / own : 1, h = own > ratio ? 1 : own / ratio;
    w /= d.zoom; h /= d.zoom; var x = d.crop ? d.crop.x + d.crop.w / 2 : .5, y = d.crop ? d.crop.y + d.crop.h / 2 : .5;
    d.crop = { x: clamp(x - w / 2, 0, 1 - w), y: clamp(y - h / 2, 0, 1 - h), w: w, h: h };
  }
  function canFill(d) { var r = d.w / d.h / (W / H); return Math.min(r, 1 / r) >= .05; }
  function resetFrame(d) { d.zoom = 1; d.crop = null; framing(d); d.fit = Math.abs(d.w / d.h / (W / H) - 1) <= .2 ? 'fill' : 'fit'; }
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
    // after a capture Retake takes 📷 Camera's place (one way back to the camera, not two)
    var captured = !!(info && info.camera); s.retake.hidden = !captured; s.picks.querySelector('[data-picker="camera"]').hidden = captured; s.camWhy = '';
    if (s.ready) discard([s.ready.id]); s.ready = null; closeSheet(s); revoke(s); if (s.media) { if (s.media.pause) s.media.pause(); s.media.remove(); }
    if (s.still) { s.still.remove(); s.still = null; }
    var id = ++s.pickId, d = s.d = { file: file, kind: kind, gif: !!gif || /\.gif$/i.test(file.name || ''), decoded: false, valid: true, texts: [], stickers: [], mentions: [], fit: 'fit', crop: null, zoom: 1, nsfw: s.d.nsfw, camera: captured && kind === 'video' };
    s.selected = null; s.failed = false; s.recovery.hidden = true; s.recovery.textContent = ''; s.filename.textContent = file.name || ''; s.empty.hidden = true;
    var m = s.media = el(kind === 'video' ? 'video' : 'img', 'sst-source'); s.preview.insertBefore(m, s.canvas);
    m.setAttribute('aria-label', _t('js.feed.ss.source', 'Selected story media')); if (kind === 'image') m.alt = _t('js.feed.sc.pic_alt', 'Your story picture');
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
      else { d.trim = { start: 0, end: Math.min(d.duration, s.caps.secs || 30) }; if (d.duration > (s.caps.secs || 30)) { say(s, _t('js.feed.ss.trim_needed', 'Choose up to {n} seconds to keep.', { n: s.caps.secs || 30 })); tool(s, 'trim'); } }
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
    if (!live(s)) return; var d = s.d, m = s.media;
    if (m && d.decoded) {
      m.style.transform = ''; m.style.inlineSize = '100%'; m.style.blockSize = '100%'; m.style.insetInlineStart = '0'; m.style.insetBlockStart = '0';
      if (d.fit === 'fill' && !d.legacy) { m.style.objectFit = 'fill'; m.style.inlineSize = 100 / d.crop.w + '%'; m.style.blockSize = 100 / d.crop.h + '%'; m.style.insetInlineStart = -d.crop.x / d.crop.w * 100 + '%'; m.style.insetBlockStart = -d.crop.y / d.crop.h * 100 + '%'; }
      else m.style.objectFit = 'contain';
    }
    if (m && d.decoded && s.still) ['objectFit', 'inlineSize', 'blockSize', 'insetInlineStart', 'insetBlockStart', 'transform'].forEach(function (k) { s.still.style[k] = m.style[k]; });   // storyprev: the poster frames like its video
    var n = ++s.drawId;
    fonts(d).then(function () { if (!live(s) || n !== s.drawId) return; draw(s.canvas, d); layoutHandles(s); }).catch(function () { if (live(s)) say(s, _t('js.feed.ss.font_failed', 'The text font could not load. Try again before posting.'), true); });
  }
  function fonts(d) { if (!document.fonts || !document.fonts.load) return Promise.resolve(); return Promise.all(d.texts.map(function (t) { return document.fonts.load(font(t), t.text); })); }
  function font(t) { return '700 ' + t.size + 'px ' + (t.style === 'pixel' ? '"Press Start 2P", monospace' : 'Ubuntu, system-ui, sans-serif'); }
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
  function draw(canvas, d) {
    var ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, W, H);
    d.texts.forEach(function (t) {
      ctx.save(); ctx.font = font(t); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = /[\u0590-\u08ff]/.test(t.text) ? 'rtl' : 'ltr';
      var lines = textLines(ctx, t.text, W * .86), height = lines.length * t.size * 1.3, width = Math.max.apply(Math, lines.map(function (x) { return ctx.measureText(x).width; }).concat([t.size]));
      t.bounds = { w: width + 32, h: height + 20 }; t.x = clamp(t.x, Math.min(.5, t.bounds.w / W / 2), Math.max(.5, 1 - t.bounds.w / W / 2)); t.y = clamp(t.y, Math.min(.5, t.bounds.h / H / 2), Math.max(.5, 1 - t.bounds.h / H / 2));
      var x = t.x * W, y = t.y * H;
      if (t.style === 'box') { ctx.fillStyle = t.color === '#000000' ? '#ffffff' : '#000000'; ctx.fillRect(x - width / 2 - 16, y - height / 2 - 10, width + 32, height + 20); }
      if (t.style === 'plain') { ctx.shadowColor = '#000000'; ctx.shadowBlur = 7; ctx.shadowOffsetY = 3; }
      ctx.fillStyle = t.color; ctx.strokeStyle = t.color === '#000000' ? '#ffffff' : '#000000'; ctx.lineWidth = Math.max(4, t.size / 9); ctx.lineJoin = 'round';
      lines.forEach(function (line, i) { var ly = y + (i - (lines.length - 1) / 2) * t.size * 1.3; if (t.style === 'outline') ctx.strokeText(line, x, ly); ctx.fillText(line, x, ly); }); ctx.restore();
    });
    d.stickers.forEach(function (t) { if (t.img) { ctx.imageSmoothingEnabled = false; ctx.drawImage(t.img, Math.round(t.x * W - t.size / 2), Math.round(t.y * H - t.size / 2), t.size, t.size); } });
  }
  function layerName(t) { return t.type === 'text' ? t.text : t.type === 'mention' ? '@' + t.username : t.name; }
  function layoutHandles(s) {
    if (!live(s)) return; var d = s.d, active = document.activeElement, focusId = active && active.getAttribute && active.getAttribute('data-layer');
    // Unedited media keeps its original aspect ratio. Its mention fractions refer to the
    // contained picture, matching the viewer; edited media always fills the 9:16 output.
    var mw = W, mh = H;
    if (d.legacy && d.decoded) { var scale = Math.min(W / d.w, H / d.h); mw = d.w * scale; mh = d.h * scale; }
    s.handles.style.insetInlineStart = (W - mw) / W * 50 + '%'; s.handles.style.insetBlockStart = (H - mh) / H * 50 + '%';
    s.handles.style.inlineSize = mw / W * 100 + '%'; s.handles.style.blockSize = mh / H * 100 + '%'; s.handles.hidden = !d.decoded;
    s.handles.textContent = '';
    d.texts.concat(d.stickers, d.mentions).forEach(function (t) {
      var b = add(s.handles, button(t.type === 'mention' ? '@' + t.username : '', function () { selectLayer(s, t); }, 'sst-layer' + (t.type === 'mention' ? ' sst-mention' : '') + (s.selected === t ? ' selected' : '')));
      b.setAttribute('data-layer', t.id); b.setAttribute('aria-label', _t('js.feed.ss.layer', 'Edit {name}', { name: layerName(t) })); b.style.insetInlineStart = t.x * 100 + '%'; b.style.insetBlockStart = t.y * 100 + '%';
      if (t.type !== 'mention') { b.style.inlineSize = ((t.bounds ? t.bounds.w : t.size) / W * 100) + '%'; b.style.blockSize = ((t.bounds ? t.bounds.h : t.size) / H * 100) + '%'; }
      b.addEventListener('keydown', function (e) { if (s.busy) return; var step = e.shiftKey ? .1 : .01, used = true; if (e.key === 'ArrowLeft') t.x -= step; else if (e.key === 'ArrowRight') t.x += step; else if (e.key === 'ArrowUp') t.y -= step; else if (e.key === 'ArrowDown') t.y += step; else used = false; if (used) { e.preventDefault(); t.x = clamp(t.x, .05, .95); t.y = clamp(t.y, .05, .95); changed(s, t.type !== 'mention'); } });
      drag(b, function () { return !s.busy; }, function (dx, dy) { var r = s.handles.getBoundingClientRect(); t.x = clamp(t.x + dx / r.width, .05, .95); t.y = clamp(t.y + dy / r.height, .05, .95); b.style.insetInlineStart = t.x * 100 + '%'; b.style.insetBlockStart = t.y * 100 + '%'; if (t.type !== 'mention') { if (s.ready) { discard([s.ready.id]); s.ready = null; } draw(s.canvas, d); } }, function () { layoutHandles(s); });
      if (focusId === t.id) b.focus();
    });
  }
  function drag(node, allowed, move, end) { var point = null;
    node.addEventListener('pointerdown', function (e) { if (!allowed() || (e.button != null && e.button !== 0)) return; point = { x: e.clientX, y: e.clientY, id: e.pointerId }; if (node.setPointerCapture) node.setPointerCapture(e.pointerId); e.stopPropagation(); });
    node.addEventListener('pointermove', function (e) { if (!point || point.id !== e.pointerId) return; if (!allowed()) { point = null; return; } var dx = e.clientX - point.x, dy = e.clientY - point.y; point.x = e.clientX; point.y = e.clientY; move(dx, dy); });
    ['pointerup', 'pointercancel'].forEach(function (event) { node.addEventListener(event, function () { if (!point) return; point = null; if (end) end(); }); });
  }
  function cropGestures(s) {
    var points = {}, distance = 0;
    s.preview.addEventListener('pointerdown', function (e) { if (s.sheetName !== 'crop' || s.d.fit !== 'fill' || s.busy || e.target.closest('.sst-layer')) return; points[e.pointerId] = { x: e.clientX, y: e.clientY }; s.preview.setPointerCapture(e.pointerId); distance = pinch(); });
    function pinch() { var a = Object.keys(points); return a.length === 2 ? Math.hypot(points[a[0]].x - points[a[1]].x, points[a[0]].y - points[a[1]].y) : 0; }
    s.preview.addEventListener('pointermove', function (e) { var p = points[e.pointerId]; if (!p || s.busy) return; var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; var next = pinch(); if (next && distance) zoom(s, s.d.zoom * next / distance); else moveCrop(s, dx / s.preview.getBoundingClientRect().width * s.d.crop.w, dy / s.preview.getBoundingClientRect().height * s.d.crop.h); distance = next; });
    ['pointerup', 'pointercancel'].forEach(function (t) { s.preview.addEventListener(t, function (e) { delete points[e.pointerId]; distance = pinch(); }); });
    s.preview.addEventListener('keydown', function (e) { if (e.target !== s.preview || s.sheetName !== 'crop' || s.busy) return; var q = e.shiftKey ? .1 : .01, used = true; if (e.key === 'ArrowLeft') moveCrop(s, -q, 0); else if (e.key === 'ArrowRight') moveCrop(s, q, 0); else if (e.key === 'ArrowUp') moveCrop(s, 0, -q); else if (e.key === 'ArrowDown') moveCrop(s, 0, q); else if (e.key === '+' || e.key === '=') zoom(s, s.d.zoom + .1); else if (e.key === '-') zoom(s, s.d.zoom - .1); else used = false; if (used) e.preventDefault(); });
  }
  function moveCrop(s, dx, dy) { var c = s.d.crop; c.x = clamp(c.x - dx, 0, 1 - c.w); c.y = clamp(c.y - dy, 0, 1 - c.h); changed(s, true); }
  function zoom(s, value) { var d = s.d; if (!canFill(d)) return; var own = d.w / d.h, base = own > W / H ? (W / H) / own : own / (W / H); d.zoom = clamp(value, 1, Math.min(8, base / .05)); framing(d); d.fit = 'fill'; if (s.zoomInput) s.zoomInput.value = d.zoom; changed(s, true); }
  function tool(s, name) { if (s.busy || !s.d.file || !s.d.valid) return; if (name === 'crop') cropSheet(s); else if (name === 'text') textSheet(s); else if (name === 'sticker') stickerSheet(s); else if (name === 'mention') mentionSheet(s); else if (name === 'trim') trimSheet(s); }
  function cropSheet(s) {
    if (!s.d.decoded || s.d.legacy) return; var box = sheet(s, 'crop', _t('js.feed.ss.crop', '📐 Crop')), seg = add(box, el('div', 'ds-seg'));
    [[ 'fit', _t('js.feed.ss.fit', 'Fit') ], [ 'fill', _t('js.feed.ss.fill', 'Fill') ]].forEach(function (p) { var b = add(seg, button(p[1], function () { if (p[0] === 'fill' && !canFill(s.d)) return; s.d.fit = p[0]; changed(s, true); cropSheet(s); })); b.setAttribute('aria-pressed', String(s.d.fit === p[0])); b.disabled = p[0] === 'fill' && !canFill(s.d); });
    var z = s.zoomInput = input('range', s.d.zoom); z.min = 1; z.max = 8; z.step = .05; z.disabled = !canFill(s.d); z.addEventListener('input', function () { zoom(s, +z.value); }); add(box, field(_t('js.feed.ss.zoom', 'Zoom'), z));
    add(box, el('p', 'sst-help', _t('js.feed.ss.crop_help', 'Drag or pinch the picture. Focus it and use arrows to move, + or − to zoom.')));
    add(box, button(_t('js.feed.ss.reset', 'Reset'), function () { resetFrame(s.d); changed(s, true); cropSheet(s); })); s.preview.focus();
  }
  function selectLayer(s, t) { if (s.busy) return; s.selected = t; if (t.type === 'text') textSheet(s, t); else if (t.type === 'sticker') stickerSheet(s, t); else mentionSheet(s, t); render(s); }
  function positionControls(s, box, t) {
    var group = add(box, el('div', 'sst-position'));
    if (t.type === 'mention' && !s.d.decoded) add(group, el('p', 'sst-help', _t('js.feed.ss.mention_unpreviewed', 'Mentions will appear in the centre after this file is converted.')));
    else [[ 'x', _t('js.feed.ss.horizontal', 'Horizontal position') ], [ 'y', _t('js.feed.ss.vertical', 'Vertical position') ]].forEach(function (p) { var r = input('range', Math.round(t[p[0]] * 100)); r.min = 5; r.max = 95; r.step = 1; r.addEventListener('input', function () { t[p[0]] = +r.value / 100; changed(s, t.type !== 'mention'); }); add(group, field(p[1], r)); });
    add(box, button(_t('js.feed.ss.delete_layer', 'Delete layer'), function () { var list = t.type === 'text' ? s.d.texts : t.type === 'sticker' ? s.d.stickers : s.d.mentions, index = list.indexOf(t); if (index >= 0) list.splice(index, 1); s.selected = null; closeSheet(s); changed(s, t.type !== 'mention'); }, 'quiet sm sst-delete'));
  }
  function textSheet(s, t) {
    if (!s.d.decoded || s.d.legacy) return; var box = sheet(s, 'text', _t('js.feed.ss.text', '🔤 Text'));
    if (!t) {
      s.d.texts.forEach(function (layer) { add(box, button(layer.text || _t('js.feed.ss.empty_text', 'Empty text'), function () { selectLayer(s, layer); })); });
      if (s.d.texts.length >= (s.caps.textsMax || 3)) { add(box, el('p', null, _t('js.feed.ss.text_limit', 'You can add up to {n} text layers.', { n: s.caps.textsMax || 3 }))); return; }
      t = { id: 'text-' + (++serial), type: 'text', text: '', size: 72, x: .5, y: .3, color: COLORS[0], style: 'plain' };
    }
    s.selected = t; var ta = add(box, el('textarea', 'ds-in sst-text-input')); ta.rows = 2; ta.value = t.text; ta.setAttribute('aria-label', _t('js.feed.ss.words', 'Story text')); var count = add(box, el('span', 'sst-help'));
    function update() { ta.value = chars(ta.value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')).slice(0, s.caps.textLen || 120).join(''); t.text = ta.value; count.textContent = _t('js.feed.ss.characters', '{used}/{max} characters', { used: chars(t.text).length, max: s.caps.textLen || 120 }); if (t.text.trim() && s.d.texts.indexOf(t) < 0) s.d.texts.push(t); if (!t.text.trim() && s.d.texts.indexOf(t) >= 0) s.d.texts.splice(s.d.texts.indexOf(t), 1); changed(s, true); }
    ta.addEventListener('input', update); count.textContent = _t('js.feed.ss.characters', '{used}/{max} characters', { used: chars(t.text).length, max: s.caps.textLen || 120 });
    var styles = add(box, el('div', 'ds-seg'));
    [['plain', _t('js.feed.ss.plain', 'Plain')], ['box', _t('js.feed.ss.box', 'Box')], ['pixel', _t('js.feed.ss.pixel', 'Pixel')], ['outline', _t('js.feed.ss.outline', 'Outline')]].forEach(function (p) { var b = add(styles, button(p[1], function () { t.style = p[0]; Array.prototype.forEach.call(styles.children, function (n) { n.setAttribute('aria-pressed', String(n === b)); }); changed(s, true); })); b.setAttribute('aria-pressed', String(t.style === p[0])); });
    var palette = add(box, el('div', 'sst-colors')); COLORS.forEach(function (c, index) { var b = add(palette, button(null, function () { t.color = c; changed(s, true); })); b.style.setProperty('--sst-ink', c); b.setAttribute('aria-label', _t('js.feed.ss.color', 'Text colour {n}', { n: index + 1 })); });
    var size = input('range', t.size); size.min = 36; size.max = 144; size.step = 6; size.addEventListener('input', function () { t.size = +size.value; changed(s, true); }); add(box, field(_t('js.feed.ss.size', 'Size'), size)); positionControls(s, box, t); ta.focus(); render(s);
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
  function stickerSheet(s, layer) {
    if (!s.d.decoded || s.d.legacy) return; var box = sheet(s, 'sticker', _t('js.feed.ss.sticker', '🧸 Sticker'));
    if (layer) { var size = input('range', layer.size / 24); size.min = 2; size.max = 24; size.step = 1; size.addEventListener('input', function () { layer.size = Math.round(+size.value) * 24; changed(s, true); }); add(box, field(_t('js.feed.ss.size', 'Size'), size)); positionControls(s, box, layer); return; }
    var note = add(box, el('p', 'sst-help', _t('js.feed.sc.loading', 'Loading…')));
    var catalog = s.catalog ? Promise.resolve(s.catalog) : req('/api/stickers').then(function (data) { s.catalog = data; return data; });
    catalog.then(function (data) {
      if (!live(s) || !box.isConnected) return; note.remove();
      var packs = (data.packs || []).filter(function (p) { return p.owned; }); if (!packs.length) add(box, el('p', null, _t('js.feed.ss.no_stickers', 'Your sticker packs will appear here.')));
      packs.forEach(function (p) { add(box, el('h4', 'ds-label', p.name)); var grid = add(box, el('div', 'sst-stickers')); (p.stickers || []).forEach(function (st) {
        var b = add(grid, button(null, function () {
          if (s.d.stickers.length + (s.pendingStickers || 0) >= (s.caps.stickersMax || 10)) { say(s, _t('js.feed.ss.sticker_limit', 'You can add up to {n} stickers.', { n: s.caps.stickersMax || 10 }), true); return; }
          b.disabled = true; var draft = s.d; s.pendingStickers = (s.pendingStickers || 0) + 1; paintControls(s);
          stickerImage(s, st).then(function (img) { if (!live(s) || s.d !== draft || s.busy || s.d.stickers.length >= (s.caps.stickersMax || 10)) return; var t = { type: 'sticker', id: 'sticker-' + (++serial), pack: p.id, sticker: st.id, name: st.name, img: img, size: 240, x: .5, y: .5 }; s.d.stickers.push(t); changed(s, true); selectLayer(s, t); }).catch(function (e) { if (live(s)) say(s, e.message, true); }).finally(function () { b.disabled = false; s.pendingStickers--; if (live(s)) paintControls(s); });
        }, 'quiet sst-sticker')); var im = add(b, el('img')); im.src = st.url; im.alt = ''; add(b, el('span', null, st.name));
      }); });
      var more = add(box, el('a', 'ds-btn link', _t('js.feed.ss.more_stickers', 'Get more stickers'))); more.href = '/cosmetics?tab=stickers'; more.target = '_blank'; more.rel = 'noopener';
    }).catch(function (e) { if (live(s) && box.isConnected) note.textContent = e.message; });
  }
  function mentionSheet(s, layer) {
    var box = sheet(s, 'mention', _t('js.feed.ss.mention', '👤 Mention'));
    if (layer) { add(box, el('p', null, '@' + layer.username)); positionControls(s, box, layer); return; }
    s.d.mentions.forEach(function (m) { add(box, button('@' + m.username, function () { selectLayer(s, m); })); });
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
    if (d.fit === 'fill') edit.crop = { x: d.crop.x, y: d.crop.y, w: d.crop.w, h: d.crop.h };
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
  window.patvStoryStudio = { open: function (pad, opener) { return open(pad, opener); } };
  // ssfix: back from a picker as a reloaded page (WebKit: a 'back_forward' load) - reopen where the story was, and say the picture didn't arrive
  function resume() { var note = takeNote(); if (note && !current) open(note.pad, document.querySelector('[data-story-compose]'), note); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resume); else resume();
})();
