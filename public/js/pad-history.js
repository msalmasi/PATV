// pad-history.js - CL8: infinite scrollback for the pad chat (the chat-history spec §2.2, §3.14) -> chatloghist.js
// (GET /api/rooms/:slug/history). Plain ES5, no dependencies but PATVChatlog (chatlog-core.js) for the day labels.
//
// The chat card's scroller holds, top to bottom: the top end (a "Load older" button - also the IntersectionObserver sentinel -,
// "Loading…", or the end marker: "Earlier messages aren't shown on this pad." / "That's the start of this pad's chat history."),
// the OLDER lines (a container of their own ABOVE the live role="log", so prepending never announces lines), the bottom end, and
// the live log. Three modes:
//   live      no older lines; the page trims the live log at 300 nodes as it always did
//   attached  older lines loaded above the live log (scrolling up loads 50 more, the reading position kept). New lines don't move
//             you: they are counted on the "Back to live (12 new)" button. Back at the bottom, the oldest nodes go again (300).
//             The page keeps at most 3,000 nodes; past that it stops loading older lines and offers 📅 Jump to a date instead.
//   detached  a 📅 date or a ?line= deep link: the history around that line (highlighted), the live log hidden (it keeps
//             updating out of sight); older lines load at the top, newer ones at the bottom; Back to live returns. The offline
//             📜 Chat history card (no live log) is always detached and starts from the newest page.
// Day dividers ("Today", "Yesterday", "Saturday 18 October") and each line's full date, time and zone (its <time> tooltip) are
// scrollback's own; the live log is unchanged. Loading older lines starts only once the reader scrolls up (or presses the
// button) - never by itself on a page load. Nothing here logs a line's text.
// CL8 fix-up:
//   - the 3,000-node cap holds while reading back in a busy room: once the older lines are all gone, the live log's oldest go too
//     (the page used to stop trimming the live log while the reader was up there, so it grew without bound);
//   - Back to live shows whenever an attached reader is away from the bottom, new lines or not;
//   - recheck(): when the page's privacy digest (history.pv) changes - someone became hidden, a name is redacted now, a line was
//     taken down - the lines scrollback holds are checked again (POST /history/check): the gone ones leave, the ones whose look
//     changed are drawn again. The offline 📜 card polls its digests (pad-chat-history.ejs);
//   - the end marker is a .ds-note, the loading state .ds-skel (spec §3.14).
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    if (d && typeof d === 'object') d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var CAP = 3000, LIVE_KEEP = 300, PAGE = 50;

  function pad2(n) { return ('0' + n).slice(-2); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();      // local midnight: the day's first line
    return isFinite(t) ? t : null;
  }
  function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function fullTime(ts, lang) {
    try {
      return new Date(ts).toLocaleString(lang || undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    } catch (e) { return new Date(ts).toString(); }
  }

  /**
   * o: {slug, scroller, older, top, bot, log (the live role="log"; null = the offline card), render(it, ctx) -> node, ctx (the
   *     page's renderer ctx), hist() -> the history block (chatlogview.historyBlock), jump (the page's "New messages" button),
   *     dateBtn (📅), dateHost (where the date form goes), toBottom() (the page lands on its newest line), onActs(acts),
   *     CL8 fix-up: extra() -> other c's the page shows (the 🔍 results: re-checked with scrollback's), onChecked({gone, redo})}
   */
  function init(o) {
    var sc = o.scroller, older = o.older, topEl = o.top, botEl = o.bot, log = o.log || null, slug = o.slug;
    var api = '/api/rooms/' + encodeURIComponent(slug) + '/history';
    var CORE = window.PATVChatlog || null;
    var mode = log ? 'live' : 'detached';
    var T = fresh(false), B = fresh(true);
    var gen = 0, armed = !log, count = 0, have = {}, hlNode = null, pendingReveal = null, lastTop = 0, paintKey = '';
    var jump = o.jump || null, jump0 = jump ? jump.textContent : '';
    var dateBtn = o.dateBtn || null, panel = null, lastErr = '';
    var base = o.ctx || {}, ctx = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) ctx[k] = base[k];
    ctx.relative = true;                                                  // Today / Yesterday
    ctx.timeTitle = function (ts) { return fullTime(ts, base.lang); };    // the full date, time and zone on hover

    function fresh(done) { return { busy: false, done: !!done, why: null, next: null, err: null }; }
    function H() { try { return typeof o.hist === 'function' ? o.hist() : null; } catch (e) { return null; } }
    function can() { var h = H(); return !!(h && h.scroll); }
    function exempt() { var h = H(); return !!(h && (h.role === 'owner' || h.role === 'staff' || h.role === 'mod')); }
    function lines(box) { return box ? Array.prototype.filter.call(box.childNodes, function (n) { return n.nodeType === 1 && n._c; }) : []; }
    function firstC(box) { for (var n = box && box.firstChild; n; n = n.nextSibling) if (n._c) return n._c; return 0; }
    function lastC(box) { for (var n = box && box.lastChild; n; n = n.previousSibling) if (n._c) return n._c; return 0; }
    function total() { return older.childElementCount + (log && !log.hidden ? log.childElementCount : 0); }
    function full() { return (mode === 'detached' ? older.childElementCount : total()) >= CAP; }

    // ── the lines ──
    function node(it) {
      var n = null;
      try { n = o.render(it, ctx); } catch (e) { n = null; }
      if (!n) return null;
      n._c = Number(it.c) || 0; n._ts = Number(it.ts) || 0; n._k = it.k; n._old = 1;
      return n;
    }
    function nodes(items) {
      var out = [];
      (items || []).forEach(function (it) {
        if (!it || (it.c && have[it.c])) return;
        var n = node(it);
        if (!n) return;
        if (it.c) have[it.c] = 1;
        out.push(n);
      });
      return out;
    }
    function divider(ts) {
      var label = CORE ? CORE.dayLabel(ts, ctx) : new Date(ts).toDateString();
      var d = el('div', 'daydiv');
      d.setAttribute('role', 'separator');
      d.setAttribute('aria-label', label);
      d.appendChild(el('span', null, label));
      return d;
    }
    /** Day dividers before each day's first line - and, attached, where the older lines meet the live log's next day. */
    function redivide() {
      Array.prototype.slice.call(older.childNodes).forEach(function (n) { if (n.nodeType === 1 && n.classList.contains('daydiv')) older.removeChild(n); });
      var prev = null;
      Array.prototype.slice.call(older.childNodes).forEach(function (n) {
        if (!n._ts) return;
        var k = dayKey(n._ts);
        if (k !== prev) { older.insertBefore(divider(n._ts), n); prev = k; }
      });
      if (mode === 'attached' && prev && log) {
        for (var x = log.firstChild; x; x = x.nextSibling) if (x._ts) { if (dayKey(x._ts) !== prev) older.appendChild(divider(x._ts)); break; }
      }
    }
    function clear() { older.textContent = ''; have = {}; hlNode = null; pendingReveal = null; }
    function rehave() { have = {}; lines(older).forEach(function (n) { have[n._c] = 1; }); }

    // ── keeping the reading position: a line on screen stays where it is whatever changes above it ──
    function anchorOf() {
      var r = sc.getBoundingClientRect();
      var cand = lines(older).concat(log && !log.hidden ? lines(log) : []);
      for (var i = 0; i < cand.length; i++) if (cand[i].getBoundingClientRect().bottom > r.top) return cand[i];
      return cand.length ? cand[cand.length - 1] : null;
    }
    function keep(fn) {
      var a = anchorOf(), y0 = a ? a.getBoundingClientRect().top : 0;
      function fix() {
        if (!a || !a.isConnected) return;
        var d = a.getBoundingClientRect().top - y0;
        if (Math.abs(d) < 1) return;
        sc.style.scrollBehavior = 'auto';                                 // .feed scrolls smoothly; never while lines go in above
        sc.scrollTop += d;
        sc.style.scrollBehavior = '';
      }
      try { fn(); } finally { fix(); }
      // the new lines can still grow before they're painted (the ⋯ line menu is added by its own observer - on touch screens
      // it keeps room beside the text, so a line may wrap once more): settle again then
      Promise.resolve().then(fix);
      if (window.requestAnimationFrame) window.requestAnimationFrame(fix);
    }
    function dropTop(n) {
      keep(function () {
        var gone = 0;
        while (gone < n && older.firstChild) { var x = older.firstChild; older.removeChild(x); if (x._c) gone++; }
        // CL8 fix-up: reading back in a busy room - once the older lines are all gone, the live log's oldest go too (the page
        // skips its own 300-node trim while the reader is up there): never more than 3,000 nodes
        if (mode === 'attached' && log) while (gone < n && log.firstChild) { var y = log.firstChild; log.removeChild(y); if (y._c) gone++; }
      });
      rehave(); redivide();
      T = fresh(false);
    }

    // ── the two ends ──
    function errText(e) {
      var c = e && e.code;
      return c === 'daily' ? _t('js.pad.chat.older_limit', 'You’ve read a lot of chat history today — try again tomorrow.')
        : c === 'rate' ? _t('js.pad.chat.older_slow', 'Slow down — try again in a minute.')
        : _t('js.pad.chat.older_failed', 'Couldn’t load earlier messages.');
    }
    function endText(why) {
      return why === 'start' || why === 'retention' ? _t('js.pad.chat.start', 'That’s the start of this pad’s chat history.')
        : _t('js.pad.chat.floor_window', 'Earlier messages aren’t shown on this pad.');
    }
    function btn(label, fn, cls) {
      var b = el('button', 'ds-btn ghost sm' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    }
    /** Loading, in place: .ds-skel bars the size of a line or two; the words for screen readers (spec §3.14). */
    function skel(text) {
      var s = el('div', 'hist-skel');
      s.setAttribute('role', 'status'); s.setAttribute('aria-busy', 'true');
      s.appendChild(el('span', 'ds-skel')); s.appendChild(el('span', 'ds-skel'));
      s.appendChild(el('span', 'ds-sr-only', text));
      return s;
    }
    /** The end marker: a quiet .ds-note (spec §3.14) - "Earlier messages aren't shown on this pad." / "That's the start ..." */
    function endNote(text) {
      var d = el('div', 'ds-note hist-end');
      var ic = el('span', 'ds-ic', '📜'); ic.setAttribute('aria-hidden', 'true');
      d.appendChild(ic); d.appendChild(el('div', null, text));
      return d;
    }
    function paintTop() {
      var h = H();
      topEl.textContent = '';
      if (h && h.signin && log) {
        // decision 7: signed out, the live tail only
        var a = el('a', 'hist-msg', _t('js.pad.chat.signin_history', 'Sign in to scroll back through earlier chat.'));
        a.href = '/login?next=' + encodeURIComponent('/p/' + slug);
        topEl.appendChild(a);
        return;
      }
      if (!can()) return;
      if (mode === 'live' && h && h.window_s === 0 && !exempt()) return;        // Off: the live log already says so (CL3)
      if (T.busy) {
        // a skeleton in the button's place while the page loads (keep() holds the lines below where they are)
        topEl.appendChild(skel(_t('js.pad.chat.loading_older', 'Loading earlier messages…')));
        return;
      }
      if (T.done) { topEl.appendChild(endNote(endText(T.why))); return; }
      if (full()) {
        topEl.appendChild(el('p', 'hist-msg', _t('js.pad.chat.jump_more', 'This page holds as many lines as it can — jump to a date to read further back.')));
        topEl.appendChild(btn(_t('js.pad.chat.jump_date', '📅 Jump to a date'), openDate));
        return;
      }
      if (T.err) {
        topEl.appendChild(el('p', 'hist-msg', T.err));
        topEl.appendChild(btn(_t('js.pad.chat.retry', 'Try again'), function () { T.err = null; armed = true; loadOlder(); }));
        return;
      }
      topEl.appendChild(btn(_t('js.pad.chat.older', 'Load older'), function () { armed = true; loadOlder(); }, 'hist-more'));
    }
    function paintBot() {
      botEl.textContent = '';
      if (mode !== 'detached' || !can()) return;
      if (B.busy) { botEl.appendChild(skel(_t('js.pad.chat.loading_newer', 'Loading newer messages…'))); return; }
      if (B.err) {
        botEl.appendChild(el('p', 'hist-msg', B.err));
        botEl.appendChild(btn(_t('js.pad.chat.retry', 'Try again'), function () { B.err = null; loadNewer(); }));
        return;
      }
      if (!B.done) botEl.appendChild(btn(_t('js.pad.chat.newer', 'Load newer'), loadNewer, 'hist-more'));
    }
    function atEnd() { return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80; }
    function label() {
      if (!jump) return;
      if (mode === 'live') { jump.textContent = jump0; return; }
      if (mode === 'attached' && !count) {
        // CL8 fix-up: nothing new yet, but a reader far up still gets ↓ Back to live (hidden only at the bottom)
        if (atEnd()) { jump.textContent = jump0; jump.style.display = 'none'; return; }
        jump.textContent = _t('js.pad.chat.back_live_0', '↓ Back to live');
        jump.style.display = 'block';
        return;
      }
      jump.textContent = count ? _t('js.pad.chat.back_live', '↓ Back to live ({n} new)', { n: count }) : _t('js.pad.chat.back_live_0', '↓ Back to live');
      jump.style.display = 'block';
    }
    function setMode(m) {
      mode = m;
      if (log) log.hidden = m === 'detached';
      label();
    }
    function acts(d) { if (d && typeof o.onActs === 'function') { try { o.onActs(d.acts || null); } catch (e) { /* the menu's problem */ } } }

    // ── loading ──
    function ask(q) {
      return fetch(api + '?' + q, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || !d || d.ok === false) { var e = new Error((d && d.error) || 'HTTP ' + r.status); e.code = (d && d.code) || 'http'; e.status = r.status; throw e; }
          return d;
        });
      });
    }
    function loadOlder() {
      if (T.busy || T.done || T.err || !can()) return;
      if (full()) { paintTop(); return; }
      var g = gen;
      var before = T.next || (mode === 'detached' ? firstC(older) : firstC(older) || (log ? firstC(log) : 0));
      if (mode === 'live' && log) setMode('attached');                    // reading back from now on: the live log stops trimming
      T.busy = true; T.err = null;
      keep(paintTop);
      ask((before ? 'before=' + encodeURIComponent(before) + '&' : '') + 'limit=' + PAGE).then(function (d) {
        if (g !== gen) return;
        keep(function () {
          T.busy = false; T.done = !d.more_before; T.why = d.floor ? d.floor.reason : null; T.next = d.next_before || null;
          var ns = nodes(d.items), first = older.firstChild;
          ns.forEach(function (n) { older.insertBefore(n, first); });
          if (mode === 'attached' && !lines(older).length) setMode('live');  // nothing older came: still live
          // the live log's "Nothing said yet" goes once there are lines above it (the page drops it with its first line anyway)
          if (ns.length && log && log.firstChild && log.firstChild.tagName === 'P' && !log.firstChild._c) log.removeChild(log.firstChild);
          redivide();
          paintTop();
        });
        label();
        acts(d);
        setTimeout(poke, 0);
      }, function (e) {
        if (g !== gen) return;
        T.busy = false; T.err = errText(e);
        if (mode === 'attached' && !lines(older).length) setMode('live');
        paintTop();
      });
    }
    function loadNewer() {
      if (B.busy || B.done || B.err || mode !== 'detached' || !can()) return;
      var g = gen, after = B.next || lastC(older);
      if (!after) return;
      B.busy = true; B.err = null;
      paintBot();
      ask('after=' + encodeURIComponent(after) + '&limit=' + PAGE).then(function (d) {
        if (g !== gen) return;
        B.busy = false; B.done = !d.more_after; B.next = d.next_after || null;
        var ns = nodes(d.items);
        ns.forEach(function (n) { older.appendChild(n); });
        redivide();
        if (older.childElementCount > CAP) dropTop(older.childElementCount - CAP);
        acts(d);
        paintBot(); paintTop();
        setTimeout(poke, 0);
      }, function (e) {
        if (g !== gen) return;
        B.busy = false; B.err = errText(e);
        paintBot();
      });
    }
    /** The history around a line (around=) or a time (at=): detached, the target highlighted. -> promise of true | false. */
    function show(q, place) {
      var g = ++gen;
      lastErr = '';
      return ask(q + '&limit=' + PAGE).then(function (d) {
        if (g !== gen) return false;
        clear();
        setMode('detached');
        T = fresh(!d.more_before); T.why = d.floor ? d.floor.reason : null; T.next = d.next_before || null;
        B = fresh(!d.more_after); B.next = d.next_after || null;
        nodes(d.items).forEach(function (n) { older.appendChild(n); });
        redivide();
        if (!d.items.length) older.appendChild(el('p', 'hist-msg', _t('js.pad.chat.history_none', 'No chat history to show here yet.')));
        acts(d);
        armed = true;
        paintTop(); paintBot(); label();
        var t = null;
        if (d.target) lines(older).forEach(function (n) { if (n._c === Number(d.target)) t = n; });
        if (t) { mark(t); pendingReveal = { n: t, place: place }; reveal(); }
        return true;
      }, function (e) {
        if (g !== gen) return false;
        lastErr = errText(e);
        return false;
      });
    }
    function mark(n) {
      if (hlNode && hlNode !== n) hlNode.classList.remove('hl');
      hlNode = n;
      n.classList.add('hl');
    }
    /** Scroll the highlighted line into view (a hidden Live tab has no height yet: the page calls this again when it shows). */
    function reveal() {
      var p = pendingReveal;
      if (!p || !p.n.isConnected || !sc.clientHeight) return false;
      pendingReveal = null;
      var off = p.place === 'top' ? 40 : sc.clientHeight / 3;
      function put() {
        if (!p.n.isConnected) return;
        var d = p.n.getBoundingClientRect().top - sc.getBoundingClientRect().top - off;
        if (Math.abs(d) < 1) return;
        sc.style.scrollBehavior = 'auto';
        sc.scrollTop += d;
        sc.style.scrollBehavior = '';
      }
      put();
      // CL9: the lines above can still grow before they're painted (the ⋯ line menu keeps room beside the text on touch screens,
      // so a line may wrap once more - a search result opened here has the menu at once): settle again then, as keep() does
      Promise.resolve().then(put);
      if (window.requestAnimationFrame) window.requestAnimationFrame(put);
      setTimeout(poke, 0);
      return true;
    }
    /** The offline card: the newest page, at its newest line. */
    function latest() {
      var g = ++gen;
      clear();
      mode = 'detached';
      T = fresh(false); T.busy = true; B = fresh(true);
      paintTop(); paintBot();
      return ask('limit=' + PAGE).then(function (d) {
        if (g !== gen) return;
        T.busy = false; T.done = !d.more_before; T.why = d.floor ? d.floor.reason : null; T.next = d.next_before || null;
        nodes(d.items).forEach(function (n) { older.appendChild(n); });
        redivide();
        if (!d.items.length) older.appendChild(el('p', 'hist-msg', _t('js.pad.chat.history_none', 'No chat history to show here yet.')));
        acts(d);
        paintTop(); paintBot();
        sc.style.scrollBehavior = 'auto'; sc.scrollTop = sc.scrollHeight; sc.style.scrollBehavior = '';
        setTimeout(poke, 0);
      }, function (e) {
        if (g !== gen) return;
        T.busy = false; T.err = errText(e);
        paintTop();
      });
    }
    /** Back to the live chat: the older lines go, the live log shows (it kept updating), the page lands on its newest line. */
    function backToLive() {
      if (!log) return latest();
      gen++;
      clear();
      T = fresh(false); B = fresh(true); count = 0; armed = false;
      setMode('live');
      while (log.childNodes.length > LIVE_KEEP) log.removeChild(log.firstChild);
      paintTop(); paintBot(); label();
      if (jump) jump.style.display = 'none';
      if (typeof o.toBottom === 'function') o.toBottom();
      return null;
    }

    // ── CL8 fix-up: checking what scrollback holds again (the page's privacy digest, history.pv, changed) ──
    // POST /history/check with the lines on the page (<= 3,000; o.extra() = other lines the caller shows, e.g. search results):
    // gone ones leave, the ones whose look changed (a name redacted since, a taken-down line's muted row) are drawn again, and
    // o.onChecked({gone, redo}) hears about it (the caller's own lines). One at a time; a change while one is in flight runs one
    // more after it. A check that fails (offline, slow down) is tried again in 5 s, 20 s and 60 s; after that what scrollback
    // shows goes (fail closed: never keep showing what may be hidden now). -> promise of {gone, redo} | null (nothing to check)
    var checking = null, checkAgain = false, retryT = null, retryN = 0;
    var RETRY_MS = [5000, 20000, 60000];
    function post(url, body) {
      return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
                          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok || !d || d.ok === false) { var e = new Error((d && d.error) || 'HTTP ' + r.status); e.code = (d && d.code) || 'http'; e.status = r.status; throw e; }
            return d;
          });
        });
    }
    function cOfNode(x) { return x && x.nodeType === 1 ? (x._c || Number(x.getAttribute('data-rmc')) || 0) : 0; }
    function checked(r) { if (r && typeof o.onChecked === 'function') { try { o.onChecked(r); } catch (e) { /* the caller's problem */ } } return r; }
    function recheck() {
      if (checking) { checkAgain = true; return checking; }
      clearTimeout(retryT); retryT = null;
      var cs = [], seen = {}, extra = [];
      function add(c) { c = Number(c) || 0; if (c > 0 && !seen[c] && cs.length < CAP) { seen[c] = 1; cs.push(c); } }
      Array.prototype.forEach.call(older.childNodes, function (x) { add(cOfNode(x)); });
      try { extra = typeof o.extra === 'function' ? o.extra() || [] : []; } catch (e) { extra = []; }
      extra.forEach(add);
      if (!cs.length) { retryN = 0; return Promise.resolve(null); }
      checking = post(api + '/check', { cs: cs }).then(function (d) {
        var gone = {}, redo = {}, redone = [];
        (d.gone || []).forEach(function (c) { gone[c] = 1; });
        (d.redo || []).forEach(function (it) { if (it && it.c) { redo[it.c] = it; redone.push(Number(it.c)); } });
        keep(function () {
          Array.prototype.slice.call(older.childNodes).forEach(function (x) {
            var c = cOfNode(x);
            if (!c) return;
            if (gone[c]) { older.removeChild(x); if (hlNode === x) hlNode = null; return; }
            if (!redo[c]) return;
            var n = null;
            try { n = o.render(redo[c], ctx); } catch (e) { n = null; }
            if (!n) { older.removeChild(x); return; }
            n._c = c; n._ts = Number(redo[c].ts) || 0; n._k = redo[c].k; n._old = 1;
            if (x.classList && x.classList.contains('hl')) { n.classList.add('hl'); if (hlNode === x) hlNode = n; }
            older.replaceChild(n, x);
          });
        });
        rehave(); redivide();
        if (d.history && d.history.acts) acts({ acts: d.history.acts });
        retryN = 0;
        return checked({ gone: (d.gone || []).map(Number), redo: redone });
      }, function () {
        if (retryN < RETRY_MS.length) { retryT = setTimeout(recheck, RETRY_MS[retryN++]); return null; }
        // it can't be checked: what scrollback holds goes (and the caller's lines too)
        retryN = 0;
        if (log) backToLive();
        else { gen++; clear(); T = fresh(false); B = fresh(true); T.err = _t('js.pad.chat.older_failed', 'Couldn’t load earlier messages.'); paintTop(); paintBot(); }
        return checked({ gone: cs.slice(), redo: [], failed: true });
      }).then(function (r) {
        checking = null;
        if (checkAgain) { checkAgain = false; return recheck().then(function (r2) { return r2 || r; }); }
        return r;
      });
      return checking;
    }

    // ── the sentinels: IntersectionObserver (once the reader scrolls up), else the buttons ──
    // The observer says WHEN to look; whether an end is near is measured now (its last answer is stale right after lines go in).
    function near(n) {
      if (!n.firstChild || !sc.clientHeight) return false;
      var a = n.getBoundingClientRect(), b = sc.getBoundingClientRect();
      return a.bottom >= b.top - 160 && a.top <= b.bottom + 160;
    }
    function poke() {
      if (!armed || !can()) return;
      if (!T.busy && !T.done && !T.err && !full() && near(topEl)) loadOlder();
      if (mode === 'detached' && !B.busy && !B.done && !B.err && near(botEl)) loadNewer();
    }
    if (typeof window.IntersectionObserver === 'function') {
      var io = new window.IntersectionObserver(function () { poke(); }, { root: sc, rootMargin: '160px 0px 160px 0px' });
      io.observe(topEl);
      io.observe(botEl);
    }
    sc.addEventListener('scroll', function () {
      var t = sc.scrollTop;
      if (t < lastTop - 2) { armed = true; poke(); }
      lastTop = t;
      if (mode === 'attached' && !count) label();                         // CL8 fix-up: ↓ Back to live away from the bottom
    }, { passive: true });
    sc.addEventListener('wheel', function (e) { if (e.deltaY < 0) { armed = true; poke(); } }, { passive: true });
    sc.addEventListener('touchstart', function () { armed = true; }, { passive: true });
    sc.addEventListener('keydown', function (e) { if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') { armed = true; setTimeout(poke, 0); } });

    // ── 📅 Jump to a date ──
    function closeDate(refocus) {
      if (!panel) return;
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
      if (dateBtn) { dateBtn.setAttribute('aria-expanded', 'false'); if (refocus !== false) dateBtn.focus(); }
    }
    function openDate() {
      if (!can()) return;
      if (panel) { closeDate(); return; }
      var host = o.dateHost || sc.parentNode;
      panel = el('form', 'hist-date');
      panel.setAttribute('aria-label', _t('js.pad.chat.jump_date', '📅 Jump to a date'));
      var id = 'histDate' + Math.random().toString(36).slice(2, 8);
      var lab = el('label', 'ds-label', _t('js.pad.chat.jump_label', 'Show the chat from')); lab.htmlFor = id;
      var inp = el('input', 'ds-in'); inp.type = 'date'; inp.id = id; inp.required = true;
      var today = new Date(), h = H();
      inp.max = ymd(today);
      if (h && h.floor && Number(h.floor.chat) > 0) inp.min = ymd(new Date(Number(h.floor.chat)));
      inp.value = ymd(today);
      var go = el('button', 'ds-btn sm', _t('js.pad.chat.jump_go', 'Go')); go.type = 'submit';
      var x = el('button', 'ds-btn ghost sm', _t('js.pad.chat.cancel', 'Cancel')); x.type = 'button';
      var msg = el('p', 'hist-msg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
      var row = el('div', 'hist-date-row');
      row.appendChild(inp); row.appendChild(go); row.appendChild(x);
      panel.appendChild(lab); panel.appendChild(row); panel.appendChild(msg);
      panel.addEventListener('submit', function (e) {
        e.preventDefault();
        var ms = parseYmd(inp.value);
        if (ms == null) return;
        go.disabled = true; msg.textContent = '';
        show('at=' + ms, 'top').then(function (ok) {
          go.disabled = false;
          if (ok) closeDate(false);
          else msg.textContent = lastErr || _t('js.pad.chat.older_failed', 'Couldn’t load earlier messages.');
        });
      });
      x.addEventListener('click', function () { closeDate(); });
      panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDate(); } });
      host.insertBefore(panel, sc);
      if (dateBtn) dateBtn.setAttribute('aria-expanded', 'true');
      inp.focus();
    }
    if (dateBtn) {
      dateBtn.setAttribute('aria-expanded', 'false');
      dateBtn.addEventListener('click', openDate);
    }

    function update() {
      var h = H();
      var key = h ? [h.scroll ? 1 : 0, h.signin ? 1 : 0, h.window_s, h.role].join('|') : '';
      if (dateBtn) dateBtn.hidden = !can() || !!(h && h.window_s === 0 && !exempt());   // Off: nothing earlier to jump to
      if (key === paintKey) return;
      paintKey = key;
      if (!can() && mode !== 'live') {
        if (log) backToLive();
        else if (paintKey !== '') {
          // CL8 fix-up: the offline card's viewer can't read back here any more (blocked, the pad's access or age gate, signed
          // out): what it showed goes
          gen++; clear(); T = fresh(true); B = fresh(true);
          older.appendChild(el('p', 'hist-msg', _t('js.pad.chat.history_closed', 'This pad’s chat history isn’t available to you now.')));
        }
      }
      paintTop(); paintBot();
    }
    update();

    return {
      update: update,
      /** reading back: older lines on the page, or a jump / deep link */
      reading: function () { return mode !== 'live'; },
      detached: function () { return mode === 'detached'; },
      has: function (c) { return !!have[c]; },
      /** the page appended n live lines while the reader was away from the bottom (or detached): counted on Back to live */
      liveAdded: function (n) { if (mode === 'live' || !(n > 0)) return; count += n; label(); },
      /** the reader is at the newest line (attached): nothing is waiting */
      atBottom: function () { if (mode === 'attached' && count) { count = 0; label(); } },
      /** at the bottom, the page trims as it always did (300) - the oldest nodes, older lines first. -> true when back to live */
      trimTop: function (max) {
        if (mode !== 'attached') return mode === 'live';
        var gone = false;
        while (total() > max && older.firstChild) { older.removeChild(older.firstChild); gone = true; }
        if (!lines(older).length) { clear(); setMode('live'); }
        if (gone) { rehave(); redivide(); T = fresh(false); paintTop(); }
        return mode === 'live';
      },
      /** reading back while the room talks: at most 3,000 nodes (the oldest go first, the reading position kept) */
      cap: function () { if (mode === 'attached' && total() > CAP) { dropTop(total() - CAP); paintTop(); } },
      /** the live log dropped its oldest lines (live mode): there is something older again */
      trimmed: function () { if (mode === 'live' && T.done) { T = fresh(false); paintTop(); } },
      backToLive: backToLive,
      /** the pad's settings changed, the site restarted, the page re-joined: what scrollback showed goes */
      reset: function () { if (log) { if (mode !== 'live') backToLive(); else { T = fresh(false); paintTop(); } } else latest(); },
      drop: function (cs) {
        var gone = {}, n = 0;
        (cs || []).forEach(function (c) { gone[c] = 1; });
        Array.prototype.slice.call(older.childNodes).forEach(function (x) {
          var c = x._c || Number(x.getAttribute && x.getAttribute('data-rmc')) || 0;
          if (c && gone[c]) { older.removeChild(x); n++; }
        });
        if (n) { rehave(); redivide(); }
        return n;
      },
      /** owner-change fix-up (review 2): lines the live answer re-dressed (its redo list: a speaker's look moved - named -> "someone",
       *  or back) are drawn again in place here too; one that won't render goes (never left with its old look). -> lines redrawn */
      redraw: function (items) {
        var by = {}, n = 0, touched = false;
        (items || []).forEach(function (it) { if (it && it.c) by[it.c] = it; });
        keep(function () {
          Array.prototype.slice.call(older.childNodes).forEach(function (x) {
            var c = x._c || 0;
            if (!c || !by[c]) return;
            touched = true;
            var m = node(by[c]);
            if (!m) { older.removeChild(x); if (hlNode === x) hlNode = null; return; }
            if (x.classList && x.classList.contains('hl')) { m.classList.add('hl'); if (hlNode === x) hlNode = m; }
            older.replaceChild(m, x);
            n++;
          });
          if (touched) { rehave(); redivide(); }
        });
        return n;
      },
      /** CL8 fix-up: the privacy digest changed - check the lines scrollback holds (+ o.extra()'s) again; o.onChecked hears */
      recheck: recheck,
      around: function (c) { return show('around=' + encodeURIComponent(c), 'center'); },
      at: function (ms) { return show('at=' + encodeURIComponent(ms), 'top'); },
      latest: latest,
      reveal: reveal,
      openDate: openDate,
      _state: function () { return { mode: mode, top: T, bot: B, count: count, total: total(), armed: armed }; },
    };
  }
  window.PATVPadHistory = { init: init, CAP: CAP, LIVE_KEEP: LIVE_KEEP, PAGE: PAGE };
})();
