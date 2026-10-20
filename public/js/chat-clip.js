// chat-clip.js (1.99fp) — "clip it" on the pad's Live tab chat (views/room.ejs):
//   ✂️ Clip chat   a selection mode on the chat feed: tap a line, then tap another to take the whole range between them;
//                  tap a picked line to drop it; shift-click (desktop) or long-press (phone) extends from the first pick.
//                  clipmodal: from the keyboard too - while picking, every line is a checkbox (one tab stop: ↑ ↓ Home End move,
//                  Space / Enter picks, Shift+Space takes everything from the first pick, Esc cancels).
//                  "Clip N lines" opens the clip confirm card (public/js/clip-confirm.js - the 🔊 mic clip's card): the
//                  server's own preview of the quote (POST /api/rooms/:slug/quote {cs, preview: true}: the lines with the names
//                  the post will show, anyone private as "someone", where it goes and who can see it, its price or why it
//                  can't be posted), an optional title, "also on my profile", then Post -> the same POST without preview
//                  {cs: the previewed lines' feed ids, title, profile}. Picking more (or fewer) lines while it's open updates
//                  the preview. The server builds the quote from its own copy of the room (quotes.js).
//   🔊 Clip        on each 🎙 line (mic transcript): ask Pepe for that mic-up's audio (a free preview, only for you),
//                  play it, trim the start / end, then Post (the room's !clip price) -> micclip.js.
// Everything user-visible goes in via textContent. Rows carry data-c (feed id), data-k, data-name, data-text, data-tx.
(function () {
  'use strict';
  var MAX = 20, LONG_MS = 500, FOLLOW_MS = 400, FEED_LINES = 8;   // FEED_LINES: what a feed card shows before "+ N more lines"
  var uid = 0;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(url, body, method) {
    return fetch(url, { method: method || 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
          if (!r.ok || d.ok === false) { var e = new Error(d.error || ('HTTP ' + r.status)); e.code = d.code; e.open = d.open; throw e; }
          return d;
        });
      });
  }
  // CL3 (cl-site): the server's one refusal for lines outside your view (code not_quotable), in your language
  function quoteErr(e) { return e && e.code === 'not_quotable' ? _t('js.pad.quote.not_quotable', 'Those lines can’t be quoted.') : e.message; }
  function micErr(e) { return e && e.code === 'not_quotable' ? _t('js.pad.clip.not_clippable', 'That mic line can’t be clipped.') : e.message; }
  function fmtS(s) { s = Math.max(0, s); var m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function secs(s) { return _t('js.pad.cc.secs', '{n}s', { n: Math.round(s) }); }
  function nLines(n) { return _t('js.pad.cc.n_lines', n === 1 ? '{count} line' : '{count} lines', { count: n }); }
  function focusOn(n) { try { n.focus({ preventScroll: false }); } catch (e) { n.focus(); } }
  // the price on the primary, as the 🔊 mic clip shows it (cant: what it says when it can't be posted)
  function postLabel(save, cant) {
    if (!save) return cant || _t('js.pad.cc.cant_post', 'Can\'t post here');
    return save.cost > 0 ? _t('js.pad.cc.post_cost', 'Post to the pad — {n} PAT', { n: num(save.cost) }) : _t('js.pad.cc.post_free', 'Post to the pad (free)');
  }

  // the server's preview as the feed shows a quote (views/partials/feed-post-content.ejs): <name> text, 🎙 on mic lines,
  // "someone" (anyone private) muted - names only, never an avatar or a look; the first 8 lines and "+ N more lines" (here a
  // button that shows the rest, so you can check every line before posting)
  function quoteCard(d, all, onMore) {
    var lines = d.lines || [], shown = all ? lines : lines.slice(0, FEED_LINES);
    var fig = el('figure', 'fq'); fig.setAttribute('aria-label', _t('js.pad.cc.quote_aria', 'Quote from the pad\'s chat room'));
    var bq = el('blockquote', 'fq-lines');
    shown.forEach(function (l) {
      var p = el('p', 'fq-l' + (l.mic ? ' mic' : '') + (l.name === 'someone' ? ' anon' : '') + (l.me ? ' me' : ''));
      p.appendChild(el('span', 'fq-n', '<' + l.name + '>'));
      p.appendChild(document.createTextNode(' '));
      if (l.mic) {
        var m = el('span', 'fq-mic', '🎙'); m.title = _t('js.pad.chat.tx', 'Said on the mic (auto-transcribed)'); m.setAttribute('aria-label', _t('js.pad.cc.on_mic', 'on the mic'));
        p.appendChild(m); p.appendChild(document.createTextNode(' '));
      }
      p.appendChild(el('span', 'fq-t', l.text));
      bq.appendChild(p);
    });
    if (lines.length > shown.length) {
      var more = el('p', 'fq-more');
      var n = lines.length - shown.length;
      var mb = el('button', 'cc-more', '+ ' + _t('js.pad.cc.more_lines', n === 1 ? '{count} more line' : '{count} more lines', { count: n }));
      mb.type = 'button'; mb.addEventListener('click', onMore);
      more.appendChild(mb); bq.appendChild(more);
    }
    fig.appendChild(bq);
    var who = _t('js.pad.cc.n_people', d.speakers === 1 ? '{count} person' : '{count} people', { count: d.speakers || 0 });
    fig.appendChild(el('figcaption', 'fq-cap', '💬 ' + who + ' · ' + nLines(lines.length)));
    return fig;
  }
  // where the quote goes and who can read it (the server's answer)
  function whereText(w) {
    if (!w) return '';
    var who = w.who === 'approved' ? _t('js.pad.cc.who_approved', 'only the pad\'s approved members can see it')
      : w.who === 'adult' ? _t('js.pad.cc.who_adult', 'only signed-in people who confirmed they\'re 18+ can see it')
      : _t('js.pad.cc.who_all', 'anyone can see it');
    var t = _t('js.pad.cc.where', 'Goes on the {pad} feed · {who}', { pad: w.pad || '', who: who });
    if (w.pending) t += ' · ' + _t('js.pad.cc.pending_note', 'the pad owner approves it first');
    return t;
  }

  function init(o) {
    var CC = window.PATVClipConfirm;
    if (!CC) return null;
    var feed = o.feed, host = o.host, slug = o.slug, linked = !!o.linked;
    var api0 = '/api/rooms/' + encodeURIComponent(slug);
    var on = false, anchor = null, room = null, canMic = false, roving = null;

    // ── ✂️ Clip chat: the toolbar (toggle, "Clip N lines", hint) + its clip confirm card ──
    var bar = el('div', 'cc-bar');
    var tog = el('button', 'cc-toggle', _t('js.pad.cc.chat_btn', '✂️ Clip chat')); tog.type = 'button';
    tog.title = _t('js.pad.cc.chat_btn_title', 'Pick lines to turn into a quote on this pad');
    var go = el('button', 'cc-btn primary cc-go', ''); go.type = 'button'; go.hidden = true;
    var hint = el('span', 'cc-hint', '');
    var keysId = 'ccKeys' + (++uid);
    var keys = el('span', 'sr-only', _t('js.pad.cc.pick_keys', 'Up and down arrows move between lines, Space picks one, Shift+Space takes everything from your first pick, Escape cancels.'));
    keys.id = keysId;
    bar.appendChild(tog); bar.appendChild(go); bar.appendChild(hint); bar.appendChild(keys);
    host.appendChild(bar);
    // focus goes back to ✂️ when a card's button is gone (else the chat itself)
    function fallback() { return !tog.hidden && !bar.hidden ? tog : feed; }
    var qc = CC.create(host, { cls: 'qc-panel', label: _t('js.pad.cc.chat_aria', 'Chat clip'), fallback: fallback });
    var q = null;             // the open chat clip: {key, cs (shown), shown, stale, posting, done, failed, timer, prev, title, prof, all, d}

    function lines() { return Array.prototype.slice.call(feed.querySelectorAll('.line[data-c]')); }
    function picked() { return lines().filter(function (r) { return r.classList.contains('cc-sel'); }); }
    function csOf(rows) { return rows.map(function (r) { return Number(r.getAttribute('data-c')); }); }
    // keyboard picking: while ✂️ is on every line is a checkbox, one of them in the tab order (roving)
    function arm(L) {
      L.forEach(function (r) {
        r.setAttribute('role', 'checkbox'); r.setAttribute('aria-checked', r.classList.contains('cc-sel') ? 'true' : 'false');
        r.setAttribute('aria-describedby', keysId); r.tabIndex = -1; r._cc = true;
      });
      if (!roving || !roving.isConnected || L.indexOf(roving) < 0) roving = L[L.length - 1] || null;
      if (roving) roving.tabIndex = 0;
    }
    function disarm() {
      lines().forEach(function (r) { if (!r._cc) return; ['role', 'aria-checked', 'aria-describedby', 'tabindex'].forEach(function (a) { r.removeAttribute(a); }); r._cc = false; });
      roving = null;
    }
    function paint() {
      var L = lines(), sel = L.filter(function (r) { return r.classList.contains('cc-sel'); }), n = sel.length;
      if (on) arm(L);
      go.hidden = !on || !n || !!(q && !q.done);
      go.disabled = n > MAX;
      go.textContent = _t('js.pad.cc.go', n === 1 ? 'Clip {count} line' : 'Clip {count} lines', { count: n });
      hint.textContent = !on ? '' : !n ? _t('js.pad.cc.pick_hint', 'Tap a line, then tap another to take everything between. Shift-click or long-press extends.')
        : n > MAX ? _t('js.pad.cc.too_many', 'A clip is at most {max} lines — drop some.', { max: MAX })
        : _t('js.pad.cc.pick_more', 'Tap more to add, tap a picked line to drop it.');
      if (q) follow(sel);
    }
    function setOn(v) {
      var a = document.activeElement, onLine = !!(a && a._cc && feed.contains(a));
      on = !!v; anchor = null;
      feed.classList.toggle('cc-on', on);
      tog.classList.toggle('on', on);
      tog.textContent = on ? _t('js.pad.cc.chat_cancel', '✕ Cancel clip') : _t('js.pad.cc.chat_btn', '✂️ Clip chat');
      tog.title = on ? _t('js.pad.cc.chat_cancel_title', 'Stop picking lines and drop the ones picked') : _t('js.pad.cc.chat_btn_title', 'Pick lines to turn into a quote on this pad');
      if (!on) {
        lines().forEach(function (r) { r.classList.remove('cc-sel'); });
        disarm();
        if (q && !q.done) closeQuote();
        if (onLine) focusOn(tog);                                    // the line it was on left the tab order
      }
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

    // the card: Clip N lines -> the server's preview -> Post / Discard; it follows the picks while it's open
    function closeQuote(focusTo) {
      if (q) clearTimeout(q.timer);
      q = null;
      paint();
      qc.close(focusTo);
    }
    function preview(cs) {
      var me = q, key = cs.join(',');
      me.failed = null;
      api(api0 + '/quote', { cs: cs, preview: true }).then(function (d) {
        if (q !== me || me.key !== key || me.posting) return;            // a newer pick, Discard or a post won
        show(d, cs);
      }).catch(function (e) {
        if (q !== me || me.key !== key || me.posting) return;
        me.failed = cs;
        if (!me.shown) { qc.status(quoteErr(e), true); qc.addClose(function () { closeQuote(); }); return; }   // like the mic's refusals
        // a later preview failed: the card stays, its primary tries that preview again
        qc.setPrimary(_t('js.pad.cc.retry', 'Try again'), false); qc.status(quoteErr(e), true);
      });
    }
    function render() {
      q.prev.textContent = '';
      var t = q.title.value.trim();
      q.ptitle.textContent = t; q.ptitle.hidden = !t;
      q.prev.appendChild(q.ptitle);
      q.prev.appendChild(quoteCard(q.d, q.all, function () {
        q.all = true; render();
        var first = q.prev.querySelectorAll('.fq-l')[FEED_LINES];
        if (first) { first.tabIndex = -1; focusOn(first); }
      }));
      q.where.textContent = whereText(q.d.where);
      q.where.hidden = !q.where.textContent;
    }
    function show(d, cs) {
      q.cs = cs; q.stale = false; q.failed = null; q.d = d;
      var n = (d.lines || []).length;
      var hintT = _t('js.pad.cc.hint', 'a free preview, only for you · {what}', { what: nLines(n) });
      var note = d.save ? _t('js.pad.cc.chat_note', 'Add a title if you like, then post it. Anyone quoted can show their lines as “someone”.')
        : (d.why || _t('js.pad.cc.chat_cant', 'You can\'t post this clip.'));
      var label = postLabel(d.save, _t('js.pad.cc.cant_post_chat', 'Can\'t post'));
      if (!q.shown) {
        q.shown = true;
        q.prev = el('div', 'cc-prev');
        q.ptitle = el('div', 'cc-ptitle');
        q.where = el('div', 'cc-where');
        var row = el('div', 'cc-row');
        q.title = el('input'); q.title.type = 'text'; q.title.maxLength = 140; q.title.placeholder = _t('js.pad.cc.title_ph', 'Title (optional)');
        q.title.setAttribute('aria-label', _t('js.pad.cc.title_aria', 'Clip title (optional)'));
        q.title.addEventListener('input', function () { var t = q && q.title ? q.title.value.trim() : ''; if (q && q.ptitle) { q.ptitle.textContent = t; q.ptitle.hidden = !t; } });
        var profL = el('label', 'cc-ck'); q.prof = el('input'); q.prof.type = 'checkbox';
        profL.appendChild(q.prof); profL.appendChild(document.createTextNode(_t('js.pad.cc.profile', 'Also on my profile')));
        row.appendChild(q.title); row.appendChild(profL);
        render();
        qc.ready({ title: _t('js.pad.cc.chat_h', '✂️ Chat clip'), hint: hintT, body: [q.prev, q.where, row],
          primary: { text: label, disabled: !d.save }, secondary: _t('js.pad.clip.discard', 'Discard'), note: note,
          onPrimary: postQuote, onSecondary: function () { closeQuote(tog); setOn(false); } });
      } else {
        render();
        qc.hint(hintT); qc.setPrimary(label, !d.save); qc.status(note);
      }
    }
    // the picks changed while the card is open: preview again (after a pause), Post waits for it
    function follow(sel) {
      if (!q || q.posting || q.done) return;
      var cs = csOf(sel), key = cs.join(',');
      if (key === q.key) return;
      if (!cs.length) { closeQuote(); return; }
      q.key = key; q.stale = true; q.failed = null;
      clearTimeout(q.timer);
      qc.setPrimary(q.d ? postLabel(q.d.save, _t('js.pad.cc.cant_post_chat', 'Can\'t post')) : null, true);   // (it may have said Try again)
      if (cs.length > MAX) { qc.status(_t('js.pad.cc.too_many', 'A clip is at most {max} lines — drop some.', { max: MAX }), true); return; }
      qc.status(q.shown ? _t('js.pad.cc.updating', 'Updating the preview…') : _t('js.pad.cc.building', 'Building your clip…'));
      q.timer = setTimeout(function () { preview(cs); }, FOLLOW_MS);
    }
    function postQuote() {
      if (!q || q.posting) return;
      if (q.failed) { var cs = q.failed; qc.setPrimary(null, true); qc.status(_t('js.pad.cc.updating', 'Updating the preview…')); preview(cs); return; }
      if (!q.cs || q.stale) return;
      var me = q;
      me.posting = true; clearTimeout(me.timer);
      qc.busy(_t('js.pad.cc.posting', 'Posting…'));
      api(api0 + '/quote', { cs: me.cs, title: me.title.value.trim(), profile: me.prof.checked })
        .then(function (d) {
          if (q !== me) return;
          me.done = true;
          setOn(false);
          var perr = d.profile && d.profile.error;
          qc.done({ url: d.post && d.post.url, heading: d.pending ? _t('js.pad.cc.posted_pending', '✅ Clip sent — it shows once the pad owner approves it') : null,
                    message: perr ? _t('js.pad.cc.not_profile', 'It isn\'t on your profile: {why}', { why: perr }) : '',
                    onClose: function () { if (q === me) closeQuote(); } });
        })
        .catch(function (e) {
          if (q !== me) return;
          me.posting = false; qc.idle(); qc.status(quoteErr(e), true);
          follow(picked());                                   // picks changed while it was posting
        });
    }
    go.addEventListener('click', function () {
      var sel = picked();
      if (!sel.length || sel.length > MAX) return;
      var cs = csOf(sel);
      if (q) closeQuote();
      q = { key: cs.join(','), shown: false, all: false };
      // open first: focus follows from this button into the card before the button hides itself
      qc.open(go, function () { closeQuote(go); });
      paint();
      qc.status(_t('js.pad.cc.building', 'Building your clip…'));
      preview(cs);
      if (qc.el.scrollIntoView) qc.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    tog.addEventListener('click', function (e) {
      setOn(!on);
      // turned on from the keyboard: straight to the newest line
      if (on && e && e.detail === 0 && roving) focusOn(roving);
    });
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
      if (r._cc) roving = r;                                          // the keyboard carries on from the line you tapped
      tap(r, e.shiftKey);
    });
    feed.addEventListener('keydown', function (e) {
      if (!on || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      var r = e.target;
      if (!r || !r._cc || !feed.contains(r)) return;                  // only a line itself (not a link or button inside it)
      var L = lines(), i = L.indexOf(r), to = null;
      if (e.key === 'ArrowDown' || e.key === 'Down') to = L[i + 1];
      else if (e.key === 'ArrowUp' || e.key === 'Up') to = L[i - 1];
      else if (e.key === 'Home') to = L[0];
      else if (e.key === 'End') to = L[L.length - 1];
      else if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') { e.preventDefault(); roving = r; tap(r, e.shiftKey); return; }
      else if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); setOn(false); return; }
      else return;
      e.preventDefault();
      if (!to) return;
      roving = to; arm(L);
      focusOn(to);
    });

    // ── 🔊 Clip on 🎙 lines (the same clip confirm card) ──
    var mcCard = CC.create(host, { cls: 'mc-panel', label: _t('js.pad.cc.mic_aria', 'Mic clip'), fallback: fallback });
    var mc = mcCard.el;
    var cur = null;           // {id, timer, ...}
    function mcClose(discard) {
      // 1.99sh: a request still in flight is discarded too (it holds one of your 2 slots until Pepe answers), never a posted one
      if (cur) { clearTimeout(cur.timer); if (discard && cur.id && (cur.state === 'ready' || cur.state === 'pending') && !cur.saving && !cur.posted) api(api0 + '/micclip/' + cur.id + '/discard', {}).catch(function () { /* expires anyway */ }); }
      cur = null; mcCard.close();
    }
    function mcStatus(t, bad) { return mcCard.status(t, bad); }
    function mcReady(v) {
      var au = el('audio'); au.controls = true; au.preload = 'auto'; au.src = v.audio;
      var body = [au];
      if (v.text) body.push(el('div', 'mc-text', _t('js.pad.cc.mic_text', '🎙 “{text}”', { text: v.text })));
      var trim = el('div', 'mc-trim');
      function slider(lbl, val) {
        var l = el('label', null, lbl); var r = el('input'); r.type = 'range'; r.min = '0'; r.max = String(v.secs); r.step = '0.1'; r.value = String(val);
        var out = el('output', null, fmtS(val)); r.setAttribute('aria-label', _t('js.pad.cc.secs_aria', '{what} (seconds)', { what: lbl }));
        trim.appendChild(l); trim.appendChild(r); trim.appendChild(out);
        return { r: r, out: out };
      }
      var A = slider(_t('js.pad.cc.start', 'Start'), 0), B = slider(_t('js.pad.cc.end', 'End'), v.secs);
      function fix(which) {
        var a = Number(A.r.value), b = Number(B.r.value);
        if (b - a < 1) { if (which === 'a') A.r.value = String(Math.max(0, b - 1)); else B.r.value = String(Math.min(v.secs, a + 1)); }
        A.out.textContent = fmtS(Number(A.r.value)); B.out.textContent = fmtS(Number(B.r.value));
      }
      A.r.addEventListener('input', function () { fix('a'); try { au.currentTime = Number(A.r.value); } catch (e) { /* not loaded */ } });
      B.r.addEventListener('input', function () { fix('b'); });
      body.push(trim);
      au.addEventListener('play', function () { if (au.currentTime < Number(A.r.value) || au.currentTime >= Number(B.r.value) - 0.05) au.currentTime = Number(A.r.value); });
      au.addEventListener('timeupdate', function () { if (au.currentTime >= Number(B.r.value)) { au.pause(); au.currentTime = Number(A.r.value); } });
      mcCard.ready({
        title: _t('js.pad.cc.mic_h', '🔊 Mic clip'),
        hint: _t('js.pad.cc.hint', 'a free preview, only for you · {what}', { what: secs(v.secs) }),
        body: body,
        primary: { text: postLabel(v.save), disabled: !v.save },
        secondary: _t('js.pad.clip.discard', 'Discard'),
        note: v.save ? _t('js.pad.cc.mic_note', 'Trim it, then post it with the transcript as its caption. Whoever is heard in it can remove it.')
          : _t('js.pad.cc.mic_rules', 'The room\'s !clip rules don\'t let you post clips here.'),
        onSecondary: function () { au.pause(); mcClose(true); },
        onPrimary: function () {
          var me = cur;
          mcCard.busy(_t('js.pad.cc.cutting', 'Posting… Pepe is cutting your clip.')); cur.saving = true;
          api(api0 + '/micclip/' + v.id + '/save', { start: Math.round(Number(A.r.value) * 1000), end: Math.round(Number(B.r.value) * 1000) })
            .then(function () { if (cur !== me) return; me.posted = true; pollSave(v.id, 0); })   // a late answer never marks a newer clip
            .catch(function (e) { if (cur !== me) return; mcCard.idle(); cur.saving = false; mcStatus(micErr(e), true); });
        },
      });
    }
    function pollSave(id, n) {
      if (!cur || cur.id !== id) return;
      cur.timer = setTimeout(function () {
        api(api0 + '/micclip/' + id + '/save', undefined, 'GET').then(function (d) {
          if (!cur || cur.id !== id) return;
          if (d.status === 'done') { mcDone(d); return; }
          if (d.status === 'failed') { mcStatus(d.message || _t('js.pad.cc.cut_failed', 'Pepe couldn\'t post it.'), true); mcCard.idle(); cur.saving = false; cur.posted = false; return; }
          // clipmodal: after ~2 min it stops asking; a Close (Esc) lets you put the card away (the post isn't touched)
          if (n < 60) pollSave(id, n + 1); else { mcStatus(_t('js.pad.cc.slow', 'Pepe is taking a while — check the pad\'s feed in a minute.')); addClose(); }
        }).catch(function () { if (n < 60) pollSave(id, n + 1); });
      }, n ? 2000 : 1200);
    }
    // 1.99abj: once posted the editor is done - swap it for a clear "posted" card (View it + Close) that closes on its own
    function mcDone(d) {
      var me = cur; if (me) clearTimeout(me.timer);
      mc.querySelectorAll('audio').forEach(function (a) { a.pause(); });
      mcCard.done({ url: d.url, message: d.message && !d.url ? d.message : '', onClose: function () { if (cur === me) mcClose(false); } });
    }
    function pollClip(id, n) {
      if (!cur || cur.id !== id) return;
      cur.timer = setTimeout(function () {
        api(api0 + '/micclip/' + id, undefined, 'GET').then(function (v) {
          if (!cur || cur.id !== id) return;
          cur.state = v.state;
          if (v.state === 'ready') return mcReady(v);
          if (v.state === 'failed' || v.state === 'expired') { mcStatus(v.status || _t('js.pad.cc.clip_failed', 'Pepe couldn\'t clip that.'), true); addClose(); return; }
          // 1.99sh: give up after ~60 s (the site's PENDING_HOLD) and withdraw the request so it stops holding a slot
          if (n < 50) pollClip(id, n + 1); else { api(api0 + '/micclip/' + id + '/discard', {}).catch(function () { /* times out anyway */ }); cur.state = 'failed'; mcStatus(_t('js.pad.cc.no_answer', 'Pepe didn\'t answer — try again in a minute.'), true); addClose(); }
        }).catch(function (e) { if (!cur || cur.id !== id) return; mcStatus(micErr(e), true); addClose(); });
      }, 1200);
    }
    // 1.99sh: "Post or discard the clips you have first." lists the open ones, each with a Discard (the last one asks again)
    function openList(list, tx, from) {
      var box = el('div', 'mc-open');
      list.forEach(function (o) {
        var row = el('div', 'cc-row');
        var who = o.login || _t('js.pad.cc.a_mic_up', 'a mic-up');
        var what = (o.state === 'ready' ? _t('js.pad.cc.open_ready', '🔊 unposted preview of {who}', { who: who }) : _t('js.pad.cc.open_wait', '⏳ still waiting on Pepe for {who}', { who: who })) + (o.secs ? ' · ' + secs(o.secs) : '');
        if (o.until) {
          var mins = Math.ceil((o.until - Date.now()) / 60000);
          what += ' · ' + _t('js.pad.cc.frees', 'frees itself in {when}', { when: mins <= 1 ? _t('js.pad.cc.a_minute', 'a minute') : _t('js.pad.people.n_min', '{n} min', { n: mins }) });
        }
        row.appendChild(el('span', 'cc-hint', what));
        var b = el('button', 'cc-btn', _t('js.pad.clip.discard', 'Discard')); b.type = 'button';
        b.addEventListener('click', function () {
          b.disabled = true;
          api('/api/rooms/' + encodeURIComponent(o.room) + '/micclip/' + encodeURIComponent(o.id) + '/discard', {})
            .then(function () { row.remove(); if (!box.querySelector('.cc-btn')) micClip(tx, from); })
            .catch(function (e) { b.disabled = false; mcStatus(e.message, true); });
        });
        row.appendChild(b); box.appendChild(row);
      });
      mc.appendChild(box);
    }
    function addClose() { mcCard.addClose(function () { mcClose(false); }); }
    function micClip(tx, from) {
      mcClose(true);
      cur = { id: null, tx: tx };
      // clipmodal: Cancel (Esc) while Pepe looks for it - the request is withdrawn as Discard does (mcClose(true); a late id is
      // discarded on arrival)
      mcCard.open(from, function () { mcClose(true); });
      mcStatus(_t('js.pad.cc.asking', '🔊 Asking Pepe for that mic-up…'));
      var me = cur;
      api(api0 + '/micclip', { tx: tx }).then(function (d) {
        if (cur !== me) { api(api0 + '/micclip/' + d.id + '/discard', {}).catch(function () { /* closed meanwhile */ }); return; }
        cur.id = d.id; cur.state = 'pending'; pollClip(d.id, 0);
      }).catch(function (e) {
        if (cur !== me) return;
        mcStatus(micErr(e), true);
        if (e.code === 'E_CLIPS_OPEN' && e.open && e.open.length) openList(e.open, tx, from);
        addClose();
      });
      if (mc.scrollIntoView) mc.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function decorate(nodes) {
      if (!linked || !canMic) return;
      nodes.forEach(function (r) {
        if (!r.classList || !r.classList.contains('tx') || !r.getAttribute('data-tx') || r.querySelector('.mc-btn')) return;   // 1.99md: Pepe's own 🎙 lines too
        var b = el('button', 'mc-btn', _t('js.pad.cc.mic_btn', '🔊 Clip')); b.type = 'button'; b.title = _t('js.pad.cc.mic_btn_title', 'Clip the audio of this mic-up (free preview, you pay only to post)');
        b.addEventListener('click', function (e) { e.stopPropagation(); if (!on) micClip(r.getAttribute('data-tx'), b); });
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
