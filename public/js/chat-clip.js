// chat-clip.js (1.99fp) — "clip it" on the pad's Live tab chat (views/room.ejs):
//   ✂️ Clip chat   a selection mode on the chat feed: tap a line, then tap another to take the whole range between them;
//                  tap a picked line to drop it; shift-click (desktop) or long-press (phone) extends from the first pick.
//                  A quote-style preview, an optional title, "also on my profile", then Post -> POST /api/rooms/:slug/quote
//                  {cs: the lines' feed ids}. The server builds the quote from its own copy of the room (quotes.js).
//   🔊 Clip        on each 🎙 line (mic transcript): ask Pepe for that mic-up's audio (a free preview, only for you),
//                  play it, trim the start / end, then Post (the room's !clip price) -> micclip.js.
// Everything user-visible goes in via textContent. Rows carry data-c (feed id), data-k, data-name, data-text, data-tx.
(function () {
  'use strict';
  var MAX = 20, LONG_MS = 500;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(url, body, method) {
    return fetch(url, { method: method || 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
          if (!r.ok || d.ok === false) { var e = new Error(d.error || ('HTTP ' + r.status)); e.code = d.code; throw e; }
          return d;
        });
      });
  }
  function fmtS(s) { s = Math.max(0, s); var m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); }
  function pat(n) { return Number(n || 0).toLocaleString('en-US') + ' PAT'; }

  function quoteCard(rows) {
    var fq = el('blockquote', 'fq');
    rows.forEach(function (r) {
      var mic = r.getAttribute('data-k') === 'tx';
      var p = el('p', 'fq-l' + (mic ? ' mic' : ''));
      p.appendChild(el('span', 'fq-n', '<' + (r.getAttribute('data-name') || 'someone') + '>'));
      p.appendChild(document.createTextNode(' '));
      if (mic) { p.appendChild(el('span', 'fq-mic', '🎙')); p.appendChild(document.createTextNode(' ')); }
      p.appendChild(el('span', 'fq-t', r.getAttribute('data-text') || ''));
      fq.appendChild(p);
    });
    return fq;
  }

  function init(o) {
    var feed = o.feed, host = o.host, slug = o.slug, linked = !!o.linked;
    var api0 = '/api/rooms/' + encodeURIComponent(slug);
    var on = false, anchor = null, room = null, canMic = false;

    // ── toolbar + the quote panel ──
    var bar = el('div', 'cc-bar');
    var tog = el('button', 'cc-toggle', '✂️ Clip chat'); tog.type = 'button'; tog.setAttribute('aria-pressed', 'false');
    tog.title = 'Pick lines to turn into a quote on this pad';
    var hint = el('span', 'cc-hint', '');
    bar.appendChild(tog); bar.appendChild(hint);
    var panel = el('div', 'cc-panel'); panel.hidden = true; panel.setAttribute('aria-label', 'Quote preview');
    var prev = el('div', 'cc-prev');
    var row1 = el('div', 'cc-row');
    var title = el('input'); title.type = 'text'; title.maxLength = 140; title.placeholder = 'Title (optional)'; title.setAttribute('aria-label', 'Quote title (optional)');
    row1.appendChild(title);
    var row2 = el('div', 'cc-row');
    var profL = el('label', 'cc-ck'); var prof = el('input'); prof.type = 'checkbox'; profL.appendChild(prof); profL.appendChild(document.createTextNode('Also on my profile'));
    var post = el('button', 'cc-btn primary', 'Post quote'); post.type = 'button';
    var clear = el('button', 'cc-btn', 'Clear'); clear.type = 'button';
    row2.appendChild(profL); row2.appendChild(post); row2.appendChild(clear);
    var msg = el('div', 'cc-msg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
    panel.appendChild(prev); panel.appendChild(row1); panel.appendChild(row2); panel.appendChild(msg);
    host.appendChild(bar); host.appendChild(panel);

    function lines() { return Array.prototype.slice.call(feed.querySelectorAll('.line[data-c]')); }
    function picked() { return lines().filter(function (r) { return r.classList.contains('cc-sel'); }); }
    function say(t, bad, link) {
      msg.textContent = t || ''; msg.classList.toggle('bad', !!bad);
      if (link) { msg.appendChild(document.createTextNode(' ')); var a = el('a', null, 'View it →'); a.href = link; msg.appendChild(a); }
    }
    function paint() {
      var sel = picked();
      prev.textContent = '';
      if (sel.length) prev.appendChild(quoteCard(sel));
      panel.hidden = !on || !sel.length;
      post.disabled = !sel.length || sel.length > MAX;
      hint.textContent = !on ? '' : sel.length ? sel.length + ' line' + (sel.length === 1 ? '' : 's') + (sel.length > MAX ? ' — at most ' + MAX : '') + ' · tap more to add, tap a picked line to drop it'
        : 'Tap a line, then tap another to take everything between. Shift-click or long-press extends.';
    }
    function setOn(v) {
      on = !!v; anchor = null;
      feed.classList.toggle('cc-on', on);
      tog.setAttribute('aria-pressed', on ? 'true' : 'false');
      tog.textContent = on ? '✂️ Done picking' : '✂️ Clip chat';
      if (!on) lines().forEach(function (r) { r.classList.remove('cc-sel'); });
      say('');
      paint();
    }
    function range(a, b) {
      var L = lines(), i = L.indexOf(a), j = L.indexOf(b);
      if (i < 0 || j < 0) return;
      if (i > j) { var t = i; i = j; j = t; }
      for (var k = i; k <= j; k++) L[k].classList.add('cc-sel');
    }
    function tap(r, extend) {
      if (!r || !r.hasAttribute('data-c')) return;
      if (extend && anchor && anchor.isConnected) range(anchor, r);
      else if (r.classList.contains('cc-sel')) r.classList.remove('cc-sel');
      else if (anchor && anchor.isConnected && picked().length === 1 && picked()[0] === anchor) range(anchor, r);
      else { r.classList.add('cc-sel'); if (!anchor || !anchor.isConnected || !picked().length || picked().length === 1) anchor = r; }
      if (!picked().length) anchor = null;
      paint();
    }
    tog.addEventListener('click', function () { setOn(!on); });
    clear.addEventListener('click', function () { lines().forEach(function (r) { r.classList.remove('cc-sel'); }); anchor = null; say(''); paint(); });
    var pressT = null, pressRow = null, longDone = false;
    feed.addEventListener('pointerdown', function (e) {
      if (!on || e.pointerType === 'mouse') return;
      var r = e.target.closest('.line[data-c]'); if (!r) return;
      pressRow = r; longDone = false;
      clearTimeout(pressT);
      pressT = setTimeout(function () { longDone = true; tap(pressRow, true); if (navigator.vibrate) { try { navigator.vibrate(15); } catch (er) { /* none */ } } }, LONG_MS);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) { feed.addEventListener(t, function () { clearTimeout(pressT); }); });
    feed.addEventListener('contextmenu', function (e) { if (on && e.target.closest('.line[data-c]')) e.preventDefault(); });
    feed.addEventListener('click', function (e) {
      if (!on) return;
      if (e.target.closest('a, button')) { if (e.target.closest('a')) e.preventDefault(); }
      var r = e.target.closest('.line[data-c]'); if (!r) return;
      if (longDone) { longDone = false; return; }
      e.preventDefault();
      tap(r, e.shiftKey);
    });
    post.addEventListener('click', function () {
      var sel = picked();
      if (!sel.length) return;
      post.disabled = true; say('Posting…');
      api(api0 + '/quote', { cs: sel.map(function (r) { return Number(r.getAttribute('data-c')); }), title: title.value.trim(), profile: prof.checked })
        .then(function (d) {
          var url = d.post && d.post.url;
          title.value = ''; prof.checked = false;
          on = false; anchor = null; feed.classList.remove('cc-on'); lines().forEach(function (r) { r.classList.remove('cc-sel'); });
          tog.setAttribute('aria-pressed', 'false'); tog.textContent = '✂️ Clip chat'; hint.textContent = '';
          panel.hidden = false; prev.textContent = ''; row1.hidden = true; row2.hidden = true;
          say('💬 Quote posted' + (d.profile && d.profile.error ? ' (not on your profile: ' + d.profile.error + ')' : '') + '.', false, url);
          setTimeout(function () { panel.hidden = true; row1.hidden = false; row2.hidden = false; say(''); }, 15000);
        })
        .catch(function (e) { post.disabled = false; say(e.message, true); });
    });

    // ── 🔊 Clip on 🎙 lines ──
    var mc = el('div', 'cc-panel mc-panel'); mc.hidden = true; mc.setAttribute('aria-label', 'Mic clip');
    host.appendChild(mc);
    var cur = null;           // {id, timer, ...}
    function mcClose(discard) {
      if (cur) { clearTimeout(cur.timer); if (discard && cur.id && cur.state === 'ready' && !cur.saving) api(api0 + '/micclip/' + cur.id + '/discard', {}).catch(function () { /* expires anyway */ }); }
      cur = null; mc.hidden = true; mc.textContent = '';
    }
    function mcStatus(t, bad) { var s = mc.querySelector('.cc-msg'); if (!s) { s = el('div', 'cc-msg'); s.setAttribute('role', 'status'); s.setAttribute('aria-live', 'polite'); mc.appendChild(s); } s.textContent = t; s.classList.toggle('bad', !!bad); return s; }
    function mcReady(v) {
      mc.textContent = '';
      var head = el('div', 'cc-row');
      head.appendChild(el('b', null, '🔊 Mic clip'));
      head.appendChild(el('span', 'cc-hint', 'a free preview, only for you · ' + Math.round(v.secs) + 's'));
      mc.appendChild(head);
      var au = el('audio'); au.controls = true; au.preload = 'auto'; au.src = v.audio; mc.appendChild(au);
      if (v.text) mc.appendChild(el('div', 'mc-text', '🎙 “' + v.text + '”'));
      var trim = el('div', 'mc-trim');
      function slider(lbl, val) {
        var l = el('label', null, lbl); var r = el('input'); r.type = 'range'; r.min = '0'; r.max = String(v.secs); r.step = '0.1'; r.value = String(val);
        var out = el('output', null, fmtS(val)); r.setAttribute('aria-label', lbl + ' (seconds)');
        trim.appendChild(l); trim.appendChild(r); trim.appendChild(out);
        return { r: r, out: out };
      }
      var A = slider('Start', 0), B = slider('End', v.secs);
      function fix(which) {
        var a = Number(A.r.value), b = Number(B.r.value);
        if (b - a < 1) { if (which === 'a') A.r.value = String(Math.max(0, b - 1)); else B.r.value = String(Math.min(v.secs, a + 1)); }
        A.out.textContent = fmtS(Number(A.r.value)); B.out.textContent = fmtS(Number(B.r.value));
      }
      A.r.addEventListener('input', function () { fix('a'); try { au.currentTime = Number(A.r.value); } catch (e) { /* not loaded */ } });
      B.r.addEventListener('input', function () { fix('b'); });
      mc.appendChild(trim);
      au.addEventListener('play', function () { if (au.currentTime < Number(A.r.value) || au.currentTime >= Number(B.r.value) - 0.05) au.currentTime = Number(A.r.value); });
      au.addEventListener('timeupdate', function () { if (au.currentTime >= Number(B.r.value)) { au.pause(); au.currentTime = Number(A.r.value); } });
      var row = el('div', 'cc-row');
      var save = el('button', 'cc-btn primary', v.save ? (v.save.cost > 0 ? 'Post to the pad — ' + pat(v.save.cost) : 'Post to the pad (free)') : 'Can\'t post here'); save.type = 'button';
      save.disabled = !v.save;
      var cancel = el('button', 'cc-btn', 'Discard'); cancel.type = 'button';
      row.appendChild(save); row.appendChild(cancel); mc.appendChild(row);
      var st = mcStatus(v.save ? 'Trim it, then post it with the transcript as its caption. Whoever is heard in it can remove it.' : 'The room\'s !clip rules don\'t let you post clips here.');
      cancel.addEventListener('click', function () { au.pause(); mcClose(true); });
      save.addEventListener('click', function () {
        save.disabled = true; cur.saving = true; st.textContent = 'Sending to Pepe…'; st.classList.remove('bad');
        api(api0 + '/micclip/' + v.id + '/save', { start: Math.round(Number(A.r.value) * 1000), end: Math.round(Number(B.r.value) * 1000) })
          .then(function () { pollSave(v.id, st, save, 0); })
          .catch(function (e) { save.disabled = false; cur.saving = false; st.textContent = e.message; st.classList.add('bad'); });
      });
    }
    function pollSave(id, st, btn, n) {
      if (!cur || cur.id !== id) return;
      cur.timer = setTimeout(function () {
        api(api0 + '/micclip/' + id + '/save', undefined, 'GET').then(function (d) {
          if (d.status === 'done') {
            st.textContent = '🔊 Posted. ';
            if (d.url) { var a = el('a', null, 'View it →'); a.href = d.url; st.appendChild(a); } else st.textContent = '🔊 ' + (d.message || 'Posted.');
            return;
          }
          if (d.status === 'failed') { st.textContent = d.message || 'Pepe couldn\'t post it.'; st.classList.add('bad'); btn.disabled = false; cur.saving = false; return; }
          if (n < 60) pollSave(id, st, btn, n + 1); else { st.textContent = 'Pepe is taking a while — check the pad\'s feed in a minute.'; }
        }).catch(function () { if (n < 60) pollSave(id, st, btn, n + 1); });
      }, n ? 2000 : 1200);
    }
    function pollClip(id, n) {
      if (!cur || cur.id !== id) return;
      cur.timer = setTimeout(function () {
        api(api0 + '/micclip/' + id, undefined, 'GET').then(function (v) {
          if (!cur || cur.id !== id) return;
          cur.state = v.state;
          if (v.state === 'ready') return mcReady(v);
          if (v.state === 'failed' || v.state === 'expired') { mcStatus(v.status || 'Pepe couldn\'t clip that.', true); addClose(); return; }
          if (n < 40) pollClip(id, n + 1); else { mcStatus('Pepe didn\'t answer — try again in a minute.', true); addClose(); }
        }).catch(function (e) { mcStatus(e.message, true); addClose(); });
      }, 1200);
    }
    function addClose() { var b = el('button', 'cc-btn', 'Close'); b.type = 'button'; b.addEventListener('click', function () { mcClose(false); }); mc.appendChild(b); }
    function micClip(tx) {
      mcClose(true);
      cur = { id: null, tx: tx };
      mc.hidden = false; mc.textContent = '';
      mcStatus('🔊 Asking Pepe for that mic-up…');
      api(api0 + '/micclip', { tx: tx }).then(function (d) { cur.id = d.id; pollClip(d.id, 0); })
        .catch(function (e) { mcStatus(e.message, true); addClose(); });
      if (mc.scrollIntoView) mc.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function decorate(nodes) {
      if (!linked || !canMic) return;
      nodes.forEach(function (r) {
        if (!r.classList || !r.classList.contains('tx') || !r.getAttribute('data-tx') || r.querySelector('.mc-btn') || r.classList.contains('pepe')) return;
        var b = el('button', 'mc-btn', '🔊 Clip'); b.type = 'button'; b.title = 'Clip the audio of this mic-up (free preview, you pay only to post)';
        b.addEventListener('click', function (e) { e.stopPropagation(); if (!on) micClip(r.getAttribute('data-tx')); });
        var body = r.querySelector('.body') || r; body.appendChild(b);
      });
    }
    new MutationObserver(function (ms) {
      var add = [];
      ms.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) add.push(n); }); });
      if (add.length) decorate(add);
      if (on) paint();
    }).observe(feed, { childList: true });

    return {
      update: function (d) {
        room = d && d.room ? d.room : null;
        bar.hidden = !room;
        // 🔊 Clip shows where the room's !clip is on (or for someone Pepe lets moderate here - the admin exemption)
        var was = canMic;
        canMic = !!(room && room.live !== false && room.transcripts !== false && (room.clip === true || d.mod));
        if (canMic && !was) decorate(Array.prototype.slice.call(feed.querySelectorAll('.line.tx')));
        if (!canMic && was) Array.prototype.forEach.call(feed.querySelectorAll('.mc-btn'), function (b) { b.remove(); });
      },
      _tap: tap, _picked: picked,
    };
  }
  window.PATVChatClip = { init: init };
})();
