// stage-capture.js — the stage player's 📸 Snap / 🎬 Clip buttons (1.99cr, server side: stagecap.js).
//
//   var bar = PATVStage.capture({ host, room })
//     host   element the buttons render into (under the player)
//     room   function () -> the pad slug whose stage is showing (the homepage's front pad changes)
//   bar.update(sel)   called by the stage switcher (stage-room.js onShow) with what's selected:
//     null (nothing on) | { stream: 'pepe' | <slot id>, label, capture: bool, nsfw: bool, embed: bool }
//
// The browser never sends a picture: the server cuts the frame / the last N seconds out of the live
// HLS on its own disk. A capture is a PREVIEW first (only you see it); "Save" sends it to Pepe, who
// charges the room's !snap / !clip price and posts it to the pad's story. Discard = nothing charged.
// 1.99cw: /api/stage/captures/me also says which kinds the site admin allows (`enabled`: a kind
// that's off is hidden, both off hides the bar) and whether the pad's Camfrog room has !snap off
// (`room_off`: the buttons show greyed with that reason). Re-read every minute and on a pad change.
(function () {
  'use strict';
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-US'); };
  function req(method, url, body) {
    return fetch(url, { method: method, credentials: 'same-origin', cache: 'no-store',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Something went wrong.' }; }); });
  }

  function capture(o) {
    var host = o.host, sel = null, me = null, busy = false, secs = 20;
    host.classList.add('stcap');
    function load() {
      return req('GET', '/api/stage/captures/me?room=' + encodeURIComponent(o.room() || '')).then(function (j) {
        if (j && j.ok) { me = j; if (j.clip && j.clip.def) secs = j.clip.def; }
        render();
      }).catch(function () {});
    }
    function render() {
      var en = me && me.enabled ? me.enabled : { snap: true, clip: true };
      if (!en.snap && !en.clip) { host.innerHTML = ''; host.classList.add('hide'); return; }   // 1.99cw: the admin switched them off
      if (!sel || sel.embed || !sel.stream) {
        host.innerHTML = sel && sel.embed ? '<span class="stcap-note">YouTube and Twitch streams can\'t be snapped or clipped here.</span>' : '';
        host.classList.toggle('hide', !(sel && sel.embed));
        return;
      }
      host.classList.remove('hide');
      if (sel.capture === false) {
        host.innerHTML = '<span class="stcap-note">📵 ' + esc(sel.label) + ' turned off snaps and clips of their stream.</span>';
        return;
      }
      var p = me && me.prices ? me.prices : { snap: 25000, clip: 50000 };
      var max = me && me.clip ? me.clip.max : 30;
      var opts = [10, 20, 30].filter(function (n) { return n <= max; });
      var roomOff = me && me.room_off ? me.room_off : null;
      var price = (en.snap ? 'snap ' + fmt(p.snap) : '') + (en.snap && en.clip ? ' · ' : '') + (en.clip ? 'clip ' + fmt(p.clip) : '') + ' PAT · preview first, pay only if you save';
      host.innerHTML =
        (en.snap ? '<button type="button" class="stcap-btn" data-k="snap" title="Save a still of ' + esc(sel.label) + ' to the pad\'s story">📸 Snap</button>' : '') +
        (en.clip ? '<span class="stcap-clip"><button type="button" class="stcap-btn" data-k="clip" title="Save the last ' + secs + ' s of ' + esc(sel.label) + ' to the pad\'s story">🎬 Clip</button>' +
        '<select class="stcap-secs" aria-label="Clip length">' + opts.map(function (n) { return '<option value="' + n + '"' + (n === secs ? ' selected' : '') + '>last ' + n + ' s</option>'; }).join('') + '</select></span>' : '') +
        '<span class="stcap-price">' + (roomOff ? '🚫 ' + esc(roomOff) : me && me.signed && !me.eligible ? esc(me.why || '') : price) + '</span>' +
        (sel.nsfw ? '<span class="stcap-nsfw" title="The streamer marked this stream NSFW - captures of it are marked NSFW">🔞 NSFW</span>' : '');
      // 1.99cw: the pad's Camfrog room has !snap off -> greyed, with the reason (a mod can `!snap on`)
      if (roomOff || (me && me.signed && !me.eligible)) {
        host.querySelectorAll('.stcap-btn, .stcap-secs').forEach(function (b) { b.disabled = true; if (roomOff) b.title = roomOff; });
      }
    }
    host.addEventListener('change', function (e) { if (e.target.classList.contains('stcap-secs')) secs = Number(e.target.value) || 20; });
    host.addEventListener('click', function (e) {
      var b = e.target.closest('.stcap-btn');
      if (!b || busy || !sel || b.disabled) return;
      if (me && !me.signed) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      var kind = b.getAttribute('data-k');
      busy = true; b.disabled = true;
      var was = b.textContent; b.textContent = kind === 'clip' ? '🎬 Cutting…' : '📸 Snapping…';
      req('POST', '/api/stage/capture', { room: o.room(), stream: sel.stream, kind: kind, secs: secs }).then(function (j) {
        busy = false; b.disabled = false; b.textContent = was;
        if (!j.ok) return toast(j.error || 'Could not capture that.');
        dialog(j.capture);
      }).catch(function () { busy = false; b.disabled = false; b.textContent = was; toast('Could not reach the site.'); });
    });

    var toastT = null;
    function toast(msg) {
      var t = host.querySelector('.stcap-toast');
      if (!t) { t = document.createElement('span'); t.className = 'stcap-toast'; t.setAttribute('role', 'status'); host.appendChild(t); }
      t.textContent = msg;
      clearTimeout(toastT); toastT = setTimeout(function () { if (t.parentNode) t.remove(); }, 7000);
    }

    // ── the preview dialog ──
    function dialog(c) {
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
    return { update: function (s) { var r = !sel || !s || sel.stream !== s.stream || sel.capture !== s.capture || sel.embed !== s.embed || sel.nsfw !== s.nsfw; sel = s; if (r) render(); }, reload: load };
  }
  window.PATVStage = window.PATVStage || {};
  window.PATVStage.capture = capture;
})();
