// stage-capture.js — the stage player's 📸 Snap / 🎬 Clip buttons (1.99cr, server side: stagecap.js).
//
//   var bar = PATVStage.capture({ host, room })
//     host   element the buttons render into (under the player)
//     room   function () -> the pad slug whose stage is showing (the homepage's front pad changes)
//   bar.update(sel)   called by the stage switcher (stage-room.js onShow) with what's selected:
//     null (nothing on) | { stream: 'pepe' | <slot id>, label, capture: bool, nsfw: bool, embed: bool, pending?: true (upnext: a 📼 card - the row greyed) }
//
// The browser never sends a picture: the server cuts the frame / the last N seconds out of the live
// HLS on its own disk, or records the next N seconds of the mic stage. A capture is a PREVIEW first (only you see it); "Save" sends it to Pepe, who
// charges the room's !snap / !clip price and posts it to the pad's story. Discard = nothing charged.
// 1.99cw: /api/stage/captures/me also says which kinds the site admin allows (`enabled`: a kind
// that's off is hidden, both off hides the bar) and whether the pad's Camfrog room has !snap off
// (`room_off`: the buttons show greyed with that reason). Re-read every minute and on a pad change.
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-US'); };
  function req(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Something went wrong.' }; }).then(function (j) { if (j && !r.ok && r.status) j.status = r.status; return j; }); });
  }

  function capture(o) {
    var host = o.host, sel = null, me = null, busy = false, secs = 20, meRoom = null, loadGen = 0;
    host.classList.add('stcap');
    function load() {
      var room = o.room() || '', generation = ++loadGen, changed = room !== meRoom;
      if (changed) { me = null; meRoom = room; render(); }
      return req('GET', '/api/stage/captures/me?room=' + encodeURIComponent(room) + '&surface=' + (location.pathname === '/' ? 'home' : 'pad')).then(function (j) {
        if (generation !== loadGen || room !== (o.room() || '')) return;
        if (j && j.ok) { me = j; if (changed && j.clip && j.clip.def) secs = j.clip.def; }
        render();
      }).catch(function () {});
    }
    function render() {
      var en = me && me.enabled ? me.enabled : { snap: true, clip: true };
      if (!en.snap && !en.clip) { host.innerHTML = ''; host.classList.add('hide'); return; }   // 1.99cw: the admin switched them off
      var mic = !!(sel && sel.stream === 'mic'), micCaps = mic && me && me.mic;
      // The mic selection deliberately still says embed/capture:false. Its own server gates win.
      if (mic && !micCaps) { host.innerHTML = ''; host.classList.add('hide'); return; }
      // upnext (review V3): a 📼 "Coming up next" card (stage-room.js: pending) - the row its stream will have, greyed until it plays (the same
      // height: nothing under the player moves at the hand-over; never the YouTube / Twitch note)
      var pend = !mic && !!(sel && sel.pending === true && sel.stream);
      if (!mic && !pend && (!sel || sel.embed || !sel.stream)) {
        host.innerHTML = sel && sel.embed ? '<span class="stcap-note">YouTube and Twitch streams can\'t be snapped or clipped here.</span>' : '';
        host.classList.toggle('hide', !(sel && sel.embed));
        return;
      }
      host.classList.remove('hide');
      if (!mic && !pend && sel.capture === false) {
        host.innerHTML = '<span class="stcap-note">📵 ' + esc(sel.label) + ' turned off snaps and clips of their stream.</span>';
        return;
      }
      var p = me && me.prices ? me.prices : { snap: 25000, clip: 50000 };
      var max = me && me.clip ? me.clip.max : 30;
      var opts = [10, 20, 30].filter(function (n) { return n <= max; });
      if (opts.indexOf(secs) < 0) secs = opts[0] || 10;
      var roomOff = mic ? micCaps.why : me && me.room_off ? me.room_off : null;
      var clipText = mic ? _t('js.stagecap.mic.clip_next', '🎬 Clip the next {n} s', { n: secs }) : '🎬 Clip';
      var clipTitle = mic ? _t('js.stagecap.mic.clip_title', 'Record the next {n} s of the mic stage for the pad\'s story', { n: secs }) : 'Save the last ' + secs + ' s of ' + sel.label + ' to the pad\'s story';
      var price = (en.snap ? 'snap ' + fmt(p.snap) : '') + (en.snap && en.clip ? ' · ' : '') + (en.clip ? 'clip ' + fmt(p.clip) : '') + ' PAT · preview first, pay only if you save';
      host.innerHTML =
        (en.snap ? '<button type="button" class="stcap-btn" data-k="snap" title="Save a still of ' + esc(sel.label) + ' to the pad\'s story">📸 Snap</button>' : '') +
        (en.clip ? '<span class="stcap-clip"><button type="button" class="stcap-btn" data-k="clip" title="' + esc(clipTitle) + '">' + esc(clipText) + '</button>' +
        '<select class="stcap-secs" aria-label="Clip length">' + opts.map(function (n) { return '<option value="' + n + '"' + (n === secs ? ' selected' : '') + '>' + (mic ? esc(_t('js.stagecap.mic.next_seconds', 'next {n} s', { n: n })) : 'last ' + n + ' s') + '</option>'; }).join('') + '</select></span>' : '') +
        '<span class="stcap-price">' + (roomOff ? '🚫 ' + esc(roomOff) : me && me.signed && !me.eligible ? esc(me.why || '') : price) + '</span>' +
        (sel.nsfw ? '<span class="stcap-nsfw" title="The streamer marked this stream NSFW - captures of it are marked NSFW">🔞 NSFW</span>' : '');
      // 1.99cw: the pad's Camfrog room has !snap off -> greyed, with the reason (a mod can `!snap on`)
      if (roomOff || (me && me.signed && !me.eligible)) {
        if (!mic) host.querySelectorAll('.stcap-btn, .stcap-secs').forEach(function (b) { b.disabled = true; if (roomOff) b.title = roomOff; });
      }
      if (pend) host.querySelectorAll('.stcap-btn, .stcap-secs').forEach(function (b) { b.disabled = true; b.title = _t('js.stagecap.upnext', 'Snaps and clips work once the next title is playing'); });
      if (mic) host.querySelectorAll('.stcap-btn, .stcap-secs').forEach(function (b) {
        var kind = b.classList.contains('stcap-secs') ? 'clip' : b.getAttribute('data-k');
        b.disabled = busy || !micCaps[kind];
        if (!micCaps[kind]) b.title = micCaps[kind + '_why'] || micCaps.why || _t('js.stagecap.mic.unavailable', 'Mic-stage captures are not available right now.');
      });
    }
    host.addEventListener('change', function (e) { if (e.target.classList.contains('stcap-secs')) { secs = Number(e.target.value) || 20; if (sel && sel.stream === 'mic') render(); } });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('.stcap-btn');
      if (!b || busy || !sel || b.disabled) return;
      if (me && !me.signed) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      var kind = b.getAttribute('data-k');
      var mic = sel.stream === 'mic', started = Date.now();
      busy = true; b.disabled = true;
      var was = b.textContent; b.textContent = mic && kind === 'clip' ? _t('js.stagecap.mic.starting', '🎬 Starting recording…') : kind === 'clip' ? '🎬 Cutting…' : '📸 Snapping…';
      req('POST', '/api/stage/capture', { room: o.room(), stream: sel.stream, kind: kind, secs: secs, surface: location.pathname === '/' ? 'home' : 'pad' }).then(function (j) {
        busy = false; b.disabled = false; b.textContent = was;
        if (!j || !j.ok || !j.capture) return toast(j && j.error || (mic ? _t('js.stagecap.mic.capture_failed', 'Could not capture the mic stage. Nothing was charged.') : 'Could not capture that.'));
        dialog(j.capture, started);
      }).catch(function () { busy = false; b.disabled = false; b.textContent = was; toast('Could not reach the site.'); });
    });

    var toastT = null;
    function toast(msg) {
      var t = host.querySelector('.stcap-toast');
      if (!t) { t = document.createElement('span'); t.className = 'stcap-toast'; t.setAttribute('role', 'status'); host.appendChild(t); }
      t.textContent = msg;
      clearTimeout(toastT); toastT = setTimeout(function () { if (t.parentNode) t.remove(); }, 7000);
    }

    function audioNote(note) {
      if (!note || typeof note !== 'object') return '';
      if (note.kind === 'muted') return _t('js.stagecap.mic.audio_muted', '🔇 {n} s muted: a hidden or private speaker had the mic', { n: Math.max(0, Math.round((Number(note.secs) || 0) * 10) / 10) });
      if (note.kind === 'off') return _t('js.stagecap.mic.audio_off', 'No room audio: the pad\'s audio is off.');
      if (note.kind === 'old-pepe') return _t('js.stagecap.mic.audio_old', 'No room audio: this capture needs a newer Pepe.');
      return '';
    }
    // A recording owns its id and timers independently of later stage/pad selections.
    function recording(c, started) {
      var box = document.createElement('div'), previousFocus = document.activeElement;
      box.className = 'stcap-dlg'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', _t('js.stagecap.mic.recording_title', 'Mic-stage recording'));
      box.innerHTML = '<div class="stcap-card"><div class="stcap-h"><b>' + esc(_t('js.stagecap.mic.recording_title', 'Mic-stage recording')) + '</b>' +
        '<button type="button" class="stcap-x" aria-label="' + esc(_t('js.stagecap.mic.cancel', 'Cancel recording')) + '">✕</button></div>' +
        '<p class="stcap-info">' + esc(_t('js.stagecap.mic.preview_privacy', 'This capture shows the stage as you see it. Veiled speakers appear only as their cover tile or the neutral speaking card.')) + '</p>' +
        '<p class="stcap-msg" role="status" aria-live="polite"></p><p class="stcap-note" role="status"></p>' +
        '<div class="stcap-row"><button type="button" class="stcap-discard">' + esc(_t('js.stagecap.mic.cancel', 'Cancel recording')) + '</button></div></div>';
      document.body.appendChild(box);
      var msg = box.querySelector('.stcap-msg'), note = box.querySelector('.stcap-note'), cancel = box.querySelector('.stcap-discard'), x = box.querySelector('.stcap-x');
      x.style.minWidth = '44px'; x.style.minHeight = '44px';
      var closed = false, terminal = false, cancelling = false, timedOut = false, poller = null, countdown = null, deadline = null;
      var duration = Math.max(10, Math.min(30, Number(c.secs) || 20)), end = started + duration * 1000;
      if (typeof c.ready_by === 'number' && isFinite(c.ready_by)) end = Math.min(end, c.ready_by);
      var state = c.state, base = '/api/stage/captures/' + encodeURIComponent(c.id);
      function stopTimers() { clearTimeout(poller); clearInterval(countdown); clearTimeout(deadline); }
      function remove() {
        if (closed) return; closed = true; stopTimers(); box.remove(); document.removeEventListener('keydown', onKey);
        if (previousFocus && previousFocus.isConnected !== false && previousFocus.focus) previousFocus.focus();
      }
      function bounded(method, url) {
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () { reject(new Error('timeout')); }, 8000);
          req(method, url).then(function (j) { clearTimeout(timer); resolve(j); }, function (e) { clearTimeout(timer); reject(e); });
        });
      }
      function paint() {
        if (closed || terminal || cancelling || timedOut) return;
        var left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
        msg.textContent = state === 'cutting' ? _t('js.stagecap.mic.cutting', '🎬 Cutting…') : left > 0
          ? _t('js.stagecap.mic.recording', '🎬 Recording… {n} s', { n: left }) : _t('js.stagecap.mic.finishing', '🎬 Finishing recording…');
      }
      function schedule() { if (!closed && !terminal && !cancelling && !timedOut) poller = setTimeout(check, 2000); }
      function cancelRecording() {
        if (closed || cancelling) return;
        if (terminal) { remove(); return; }
        cancelling = true; clearTimeout(poller); cancel.disabled = true; x.disabled = true;
        note.textContent = _t('js.stagecap.mic.cancelling', 'Cancelling recording…');
        bounded('POST', base + '/discard').then(function (j) {
          if (closed) return;
          if (!j || !j.ok) throw new Error(j && j.error || 'cancel');
          if (!timedOut) { remove(); return; }
          terminal = true; cancelling = false; stopTimers(); note.textContent = ''; cancel.disabled = false; x.disabled = false;
          cancel.textContent = _t('js.stagecap.mic.close', 'Close'); x.setAttribute('aria-label', _t('js.stagecap.mic.close', 'Close'));
        }).catch(function () {
          if (closed) return;
          cancelling = false; cancel.disabled = false; x.disabled = false;
          cancel.textContent = _t('js.stagecap.mic.retry_cancel', 'Retry cancellation');
          note.textContent = _t('js.stagecap.mic.cancel_failed', 'Could not cancel yet. Try again to stop the recording.'); schedule();
        });
      }
      function check() {
        poller = null;
        bounded('GET', base).then(function (j) {
          if (closed || cancelling || timedOut) return;
          if (!j || !j.ok || !j.capture) {
            if (j && j.status && j.status >= 500) throw new Error('retry');
            terminal = true; stopTimers(); msg.textContent = j && j.error || _t('js.stagecap.mic.capture_failed', 'Could not capture the mic stage. Nothing was charged.');
          } else if (j.capture.state === 'preview') {
            terminal = true; remove(); dialog(j.capture); return;
          } else if (j.capture.state === 'recording' || j.capture.state === 'cutting') {
            state = j.capture.state; note.textContent = ''; paint(); schedule(); return;
          } else {
            terminal = true; stopTimers(); msg.textContent = j.capture.message || _t('js.stagecap.mic.capture_failed', 'Could not capture the mic stage. Nothing was charged.');
          }
          cancel.textContent = _t('js.stagecap.mic.close', 'Close'); x.setAttribute('aria-label', _t('js.stagecap.mic.close', 'Close')); note.textContent = '';
        }).catch(function () {
          if (closed || cancelling || timedOut) return;
          note.textContent = _t('js.stagecap.mic.check_retry', 'Connection interrupted. Checking the recording again…'); schedule();
        });
      }
      function onKey(e) {
        if (e.key === 'Escape') cancelRecording();
        if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === x ? cancel : x).focus(); }
      }
      document.addEventListener('keydown', onKey); x.addEventListener('click', cancelRecording); cancel.addEventListener('click', cancelRecording);
      box.addEventListener('click', function (e) { if (e.target === box) cancelRecording(); });
      deadline = setTimeout(function () {
        if (closed || terminal) return;
        timedOut = true; clearTimeout(poller); clearInterval(countdown);
        msg.textContent = _t('js.stagecap.mic.timeout', 'This recording took too long. Nothing was charged.'); cancelRecording();
      }, Math.max(0, started + (duration + 60) * 1000 - Date.now()));
      paint(); countdown = setInterval(paint, 1000); schedule(); cancel.focus();
    }

    // ── the preview dialog ──
    function dialog(c, started) {
      if (c.state === 'recording' || c.state === 'cutting') { recording(c, started || Date.now()); return; }
      var box = document.createElement('div');
      box.className = 'stcap-dlg'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      var what = c.kind === 'clip' ? 'Stage clip' : 'Stage snap';
      box.setAttribute('aria-label', what + ' preview');
      box.innerHTML = '<div class="stcap-card">' +
        '<div class="stcap-h"><b>📺 ' + what + ' of ' + esc(c.stream) + '</b>' + (c.nsfw ? ' <span class="stcap-nsfw">🔞 NSFW</span>' : '') +
        '<button type="button" class="stcap-x" aria-label="Close">✕</button></div>' +
        '<div class="stcap-media">' + (c.kind === 'clip'
          ? '<video src="' + esc(c.preview) + '" controls playsinline autoplay muted loop></video>'
          : '<img src="' + esc(c.preview) + '" alt="Preview of the snap">') + '</div>' +
        '<p class="stcap-info">' + (c.kind === 'clip' ? Math.round(c.secs) + ' s · ' : '') + 'Only you can see this preview. Save it to put it in the pad\'s story' +
        (c.price > 0 ? ' for <b>' + fmt(c.price) + ' PAT</b> (same as <code>!' + (c.kind === 'clip' ? 'clip' : 'snap') + '</code>; admins free).' : '.') + '</p>' +
        (c.source === 'mic' ? '<p class="stcap-info">' + esc(_t('js.stagecap.mic.preview_privacy', 'This capture shows the stage as you see it. Veiled speakers appear only as their cover tile or the neutral speaking card.')) + '</p>' +
          (audioNote(c.audio_note) ? '<p class="stcap-info">' + esc(audioNote(c.audio_note)) + '</p>' : '') : '') +
        '<p class="stcap-msg" role="status" aria-live="polite"></p>' +
        '<div class="stcap-row"><button type="button" class="stcap-save">💾 Save to the story</button><button type="button" class="stcap-discard">Discard</button></div></div>';
      document.body.appendChild(box);
      var msg = box.querySelector('.stcap-msg'), save = box.querySelector('.stcap-save'), disc = box.querySelector('.stcap-discard');
      var done = false, poller = null;
      function close() {
        clearInterval(poller);
        if (!done && !save.disabled) req('POST', '/api/stage/captures/' + encodeURIComponent(c.id) + '/discard').catch(function () {});
        box.remove(); document.removeEventListener('keydown', onKey);
      }
      var onKey = function (e) { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);
      box.addEventListener('click', function (e) { if (e.target === box) close(); });
      box.querySelector('.stcap-x').addEventListener('click', close);
      disc.addEventListener('click', close);
      save.addEventListener('click', function () {
        save.disabled = true; disc.disabled = true; msg.textContent = 'Sent to Pepe - saving…';
        req('POST', '/api/stage/captures/' + encodeURIComponent(c.id) + '/save', { idem: c.id + 'save' + Date.now().toString(36) }).then(function (j) {
          if (!j.ok) { msg.textContent = j.error || 'Could not save it.'; save.disabled = false; disc.disabled = false; return; }
          poller = setInterval(check, 2000);
        }).catch(function () { msg.textContent = 'Could not reach the site.'; save.disabled = false; disc.disabled = false; });
      });
      function check() {
        req('GET', '/api/stage/captures/' + encodeURIComponent(c.id)).then(function (j) {
          if (!j.ok) return;
          var s = j.capture;
          if (s.state === 'done') {
            done = true; clearInterval(poller);
            msg.innerHTML = '✅ Saved to the pad\'s story. <a href="' + esc(s.url) + '">Open it ›</a>';
            save.textContent = 'Saved'; disc.textContent = 'Close'; disc.disabled = false;
          } else if (s.state === 'preview') {
            clearInterval(poller);
            msg.textContent = (s.message ? 'Pepe: ' + s.message : 'Not saved.') + ' Nothing was charged.';
            save.disabled = false; disc.disabled = false;
          } else if (s.state !== 'saving') {
            clearInterval(poller);
            msg.textContent = (s.message ? 'Pepe: ' + s.message + ' - ' : '') + 'that preview expired. Nothing was charged.';
            disc.textContent = 'Close'; disc.disabled = false; done = true;
          }
        }).catch(function () {});
      }
      save.focus();
    }

    load();
    setInterval(function () { if (!document.hidden) load(); }, 60000);   // 1.99cw: the switches can change
    return { update: function (s) { var r = !sel || !s || sel.stream !== s.stream || sel.capture !== s.capture || sel.embed !== s.embed || sel.nsfw !== s.nsfw || !sel.pending !== !s.pending; sel = s; if (meRoom !== (o.room() || '')) load(); else if (r) render(); }, reload: load };
  }
  window.PATVStage = window.PATVStage || {};
  window.PATVStage.capture = capture;
})();
