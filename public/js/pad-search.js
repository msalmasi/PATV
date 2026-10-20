// pad-search.js - CL9: 🔍 search the pad chat (the chat-history spec §2.3, §3.14) -> chatlogsearch.js (POST /api/rooms/:slug/search).
// Plain ES5, no dependencies but PATVChatlog (chatlog-core.js: the lines, their dates) and PATVPadHistory (pad-history.js: a result
// opens the history around its line).
//
// The 🔍 in the chat card's heading opens a search bar over the chat: the words (a 🔍 inset in the field), Both / Chat / Mic, Hide
// Pepe, From (a name or login - suggestions only from names already on the screen) and Before (a date). Results come newest first,
// 20 at a time with "More results": each is the line exactly as the chat renders it (chatlog-core.js renderItem, the matched words
// in <mark>s) under its date; the date - or the line itself - opens the history AROUND that line, highlighted (Back to live
// returns), and the bar closes with its results kept (🔍 brings them back). The result count goes to a polite live region; Esc
// closes the bar. The page makes the results container before chat-lines.js starts, so each result has the ⋯ line menu (⚑ Report…).
// With the pad's search off, viewers with full history (the owner, staff, the room's mods) still search and read "Only you and this
// pad's mods can search here."; everyone else has no 🔍 (history.find). Nothing here logs a query or a line.
// CL9 fix-up: when the last word was too common to match longer words too, the server matched it whole and says so (`exact`: a note
// under the bar); a page that spent the server's budget without a hit asks for the next one itself (AUTO_MAX in a row).
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    if (d && typeof d === 'object') d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var PAGE = 20, uid = 0;

  function pad2(n) { return ('0' + n).slice(-2); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();      // local midnight: "before" that day
    return isFinite(t) ? t : null;
  }
  function fullTime(ts, lang) {
    try {
      return new Date(ts).toLocaleString(lang || undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    } catch (e) { return new Date(ts).toString(); }
  }
  function closest(n, stop, test) {
    for (; n && n !== stop; n = n.parentNode) if (n.nodeType === 1 && test(n)) return n;
    return null;
  }

  /**
   * o: {slug, btn (the 🔍 in the chat heading), host (the chat card), before (the bar goes right above it: the scroller), results (the
   *     results container - made by the page BEFORE chat-lines.js starts, so the ⋯ line menu reaches the results), render(it, ctx) ->
   *     node, ctx (the page's renderer ctx), hist() -> the history block (find, search), history (PATVPadHistory: around(c)),
   *     onActs(acts), names() -> [usernames / logins on the screen] (From's suggestions)}
   */
  function init(o) {
    var btn = o.btn, slug = o.slug, hits = o.results || el('div');
    var api = '/api/rooms/' + encodeURIComponent(slug) + '/search';
    var CORE = window.PATVChatlog || null;
    var base = o.ctx || {};
    var panel = null, input = null, kindBtns = {}, pepeIn = null, fromIn = null, listEl = null, beforeIn = null, note = null, statusEl = null,
        partialEl = null, exactEl = null, moreEl = null, goBtn = null;
    var kind = 'all', cursor = null, busy = false, gen = 0, count = 0, asked = null, open = false, autoN = 0;
    var AUTO_MAX = 2;          // CL9 fix-up: a page that read its whole budget without a hit asks for the next one itself (at most twice)
    if (!/(^|\s)srch-hits(\s|$)/.test(hits.className)) hits.className = (hits.className ? hits.className + ' ' : '') + 'srch-hits';
    hits.setAttribute('role', 'region');
    hits.setAttribute('aria-label', _t('js.pad.search.results', 'Search results'));

    function H() { try { return typeof o.hist === 'function' ? o.hist() : null; } catch (e) { return null; } }
    function can() { var h = H(); return !!(h && h.find); }
    function ctxFor(hl) {
      var c = {};
      for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) c[k] = base[k];
      c.hl = hl || null;
      c.timeTitle = function (ts) { return fullTime(ts, base.lang); };
      return c;
    }

    // ── the bar ──
    function build() {
      var id = 'srch' + (++uid) + Math.random().toString(36).slice(2, 6);
      panel = el('div', 'srch');
      panel.id = id;
      panel.setAttribute('role', 'search');
      panel.setAttribute('aria-label', _t('js.pad.search.aria', 'Search this pad’s chat'));
      var form = el('form', 'srch-form');
      form.setAttribute('novalidate', '');
      var q = el('div', 'ds-in-group srch-q');
      var ic = el('span', 'srch-ic', '🔍'); ic.setAttribute('aria-hidden', 'true');
      input = el('input', 'ds-in');
      input.type = 'search'; input.maxLength = 100; input.autocomplete = 'off'; input.spellcheck = false;
      input.placeholder = _t('js.pad.search.placeholder', 'Search this pad’s chat');
      input.setAttribute('aria-label', _t('js.pad.search.placeholder', 'Search this pad’s chat'));
      goBtn = el('button', 'ds-in-addon srch-go', _t('js.pad.search.go', 'Search'));
      goBtn.type = 'submit';
      q.appendChild(ic); q.appendChild(input); q.appendChild(goBtn);
      form.appendChild(q);

      var opts = el('div', 'srch-opts');
      var seg = el('div', 'ds-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', _t('js.pad.search.kind', 'Which lines'));
      [['all', _t('js.pad.search.kind_all', 'Both')], ['chat', _t('js.pad.search.kind_chat', 'Chat')], ['mic', _t('js.pad.search.kind_mic', '🎙 Mic')]].forEach(function (p) {
        var b = el('button', null, p[1]);
        b.type = 'button';
        b.setAttribute('aria-pressed', p[0] === kind ? 'true' : 'false');
        b.addEventListener('click', function () { setKind(p[0]); if (asked) run(false); });
        kindBtns[p[0]] = b;
        seg.appendChild(b);
      });
      opts.appendChild(seg);
      var pl = el('label', 'srch-chk');
      pepeIn = el('input'); pepeIn.type = 'checkbox';
      pepeIn.addEventListener('change', function () { if (asked) run(false); });
      pl.appendChild(pepeIn); pl.appendChild(document.createTextNode(_t('js.pad.search.hide_pepe', 'Hide Pepe')));
      opts.appendChild(pl);
      var fl = el('label', 'srch-f');
      fl.appendChild(el('span', null, _t('js.pad.search.from', 'From')));
      fromIn = el('input', 'ds-in');
      fromIn.type = 'text'; fromIn.maxLength = 64; fromIn.autocomplete = 'off'; fromIn.spellcheck = false;
      fromIn.placeholder = _t('js.pad.search.from_hint', 'name or login');
      listEl = el('datalist'); listEl.id = id + 'from';
      fromIn.setAttribute('list', listEl.id);
      fromIn.addEventListener('focus', suggest);
      fl.appendChild(fromIn); fl.appendChild(listEl);
      opts.appendChild(fl);
      var bl = el('label', 'srch-f');
      bl.appendChild(el('span', null, _t('js.pad.search.before', 'Before')));
      beforeIn = el('input', 'ds-in');
      beforeIn.type = 'date';
      beforeIn.max = ymd(new Date());
      bl.appendChild(beforeIn);
      opts.appendChild(bl);
      form.appendChild(opts);
      form.addEventListener('submit', function (e) { e.preventDefault(); run(false); });
      panel.appendChild(form);

      note = el('p', 'srch-note', _t('js.pad.search.mods_only', 'Only you and this pad’s mods can search here.'));
      note.hidden = true;
      panel.appendChild(note);
      statusEl = el('p', 'hist-msg srch-status');
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
      panel.appendChild(statusEl);
      partialEl = el('p', 'srch-note', _t('js.pad.search.partial', 'Some lines may be missing from these results while the search index catches up.'));
      partialEl.hidden = true;
      panel.appendChild(partialEl);
      // CL9 fix-up: the last word was too common to match the start of longer words too - the server says which word it matched whole
      exactEl = el('p', 'srch-note');
      exactEl.hidden = true;
      panel.appendChild(exactEl);
      panel.appendChild(hits);
      moreEl = el('div', 'srch-more');
      panel.appendChild(moreEl);
      panel.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      });
      hits.addEventListener('click', onHit);
      hits.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var line = closest(e.target, hits, function (n) { return n.classList.contains('line') || n.classList.contains('sys'); });
        if (line && line === e.target) { e.preventDefault(); openLine(line._c); }
      });
      if (btn) btn.setAttribute('aria-controls', id);
    }
    function setKind(k) {
      kind = k;
      for (var x in kindBtns) if (Object.prototype.hasOwnProperty.call(kindBtns, x)) kindBtns[x].setAttribute('aria-pressed', x === k ? 'true' : 'false');
    }
    function suggest() {
      if (!listEl) return;
      var names = [];
      try { names = typeof o.names === 'function' ? o.names() || [] : []; } catch (e) { names = []; }
      listEl.textContent = '';
      names.slice(0, 50).forEach(function (n) { var op = el('option'); op.value = n; listEl.appendChild(op); });
    }
    function paintNote() {
      var h = H();
      if (note) note.hidden = !(h && h.find && h.search === false);
    }
    function openBar() {
      if (!can()) return;
      if (!panel) build();
      if (!panel.parentNode) o.host.insertBefore(panel, o.before);
      paintNote();
      open = true;
      if (btn) btn.setAttribute('aria-expanded', 'true');
      input.focus();
    }
    function close(refocus) {
      open = false;
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
    }
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', function () { if (open) close(true); else openBar(); });
    }

    // ── asking ──
    function errText(e) {
      var c = e && e.code;
      return c === 'too_short' ? _t('js.pad.search.too_short', 'Type at least one word of 2 or more letters.')
        : c === 'too_broad' ? _t('js.pad.search.too_broad', 'Too broad — add a word.')
        : c === 'busy' ? _t('js.pad.search.busy', 'Search is busy — try again in a moment.')
        : c === 'rate' ? _t('js.pad.search.slow', 'Slow down — try again in a minute.')
        : c === 'daily' ? _t('js.pad.search.daily', 'You’ve searched a lot today — try again tomorrow.')
        : c === 'bad_cursor' ? _t('js.pad.search.stale', 'Those results are out of date — search again.')
        : c === 'search_off' ? _t('js.pad.chat.chip_search_off', 'Search is off on this pad')
        : _t('js.pad.search.failed', 'Couldn’t search — try again.');
    }
    function status(text) { if (statusEl) statusEl.textContent = text || ''; }
    function paintMore(more) {
      moreEl.textContent = '';
      if (!more) return;
      var b = el('button', 'ds-btn ghost sm', _t('js.pad.search.more', 'More results'));
      b.type = 'button';
      b.addEventListener('click', function () { run(true); });
      moreEl.appendChild(b);
    }
    function addHit(hit) {
      var it = hit && hit.item;
      if (!it || !it.c) return;
      var n = null;
      try { n = o.render(it, ctxFor(hit.hl)); } catch (e) { n = null; }
      if (!n) return;
      n._c = Number(it.c) || 0;
      n.tabIndex = 0;
      var day = CORE ? CORE.dayLabel(it.ts, { t: base.t, lang: base.lang, relative: true }) : new Date(it.ts).toDateString();
      var time = CORE ? CORE.fmtTime(it.ts, base) : '';
      // the line's own time is on the line: its date, and what the button does
      var when = el('button', 'srch-when', day + ' · ' + _t('js.pad.search.open_line', 'show in chat'));
      when.type = 'button';
      when._c = n._c;
      when.title = fullTime(it.ts, base.lang);
      when.setAttribute('aria-label', _t('js.pad.search.show', 'Show it in the chat: {when}', { when: day + ' ' + time }));
      hits.appendChild(when);
      hits.appendChild(n);
    }
    function clear() { hits.textContent = ''; count = 0; cursor = null; if (moreEl) moreEl.textContent = ''; if (partialEl) partialEl.hidden = true; if (exactEl) exactEl.hidden = true; }
    function paintExact(word) {
      if (!exactEl) return;
      exactEl.hidden = !word;
      exactEl.textContent = word ? _t('js.pad.search.exact', '“{word}” is too common to also match longer words: showing whole words only.', { word: String(word) }) : '';
    }
    function body(more) {
      var b = { q: asked.q, kind: asked.kind, limit: PAGE };
      if (asked.hide) b.hide_pepe = true;
      if (asked.from) b.from = asked.from;
      if (asked.before != null) b.before = asked.before;
      if (more && cursor) b.cursor = cursor;
      return b;
    }
    function run(more) {
      if (!panel) return;
      if (busy && more) return;
      if (!more) {
        var q = String(input.value || '').trim();
        if (!q) { status(errText({ code: 'too_short' })); input.focus(); return; }
        asked = { q: q, kind: kind, hide: !!pepeIn.checked, from: String(fromIn.value || '').trim() || null, before: parseYmd(beforeIn.value) };
        autoN = 0;
      } else if (!cursor) return;
      var g = ++gen;
      busy = true;
      status(_t('js.pad.search.searching', 'Searching…'));
      if (more) paintMore(false);
      fetch(api, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body(more)) })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok || !d || d.ok === false) { var e = new Error((d && d.error) || 'HTTP ' + r.status); e.code = (d && d.code) || 'http'; throw e; }
            return d;
          });
        })
        .then(function (d) {
          if (g !== gen) return;
          busy = false;
          if (!more) clear();
          (d.hits || []).forEach(addHit);
          count += (d.hits || []).length;
          cursor = d.more ? d.cursor || null : null;
          if (partialEl) partialEl.hidden = !d.partial;
          if (!more || d.exact) paintExact(d.exact || null);
          // a page that spent its budget without a hit: go on looking further back by itself (at most AUTO_MAX pages in a row)
          if (!(d.hits || []).length && cursor && autoN < AUTO_MAX) { autoN++; run(true); return; }
          if ((d.hits || []).length) autoN = 0;
          paintMore(!!cursor);
          status(count ? _t('js.pad.search.count', { one: '{count} line found', other: '{count} lines found' }, { count: count }) + (cursor ? ' ' + _t('js.pad.search.count_more', '(more below)') : '')
            : _t('js.pad.search.none', 'No lines found.'));
          if (typeof o.onActs === 'function') { try { o.onActs(d.acts || null); } catch (e) { /* the menu's problem */ } }
        }, function (e) {
          if (g !== gen) return;
          busy = false;
          if (!more) clear();
          else paintMore(!!cursor);
          status(errText(e));
        });
    }
    function openLine(c) {
      if (!c || !o.history || typeof o.history.around !== 'function') return;
      // the bar goes first, so the chat has its final place when the line is scrolled into view; it comes back (results kept)
      // with the reason when the line can't be shown
      close(false);
      o.history.around(c).then(function (ok) {
        if (ok) return;
        openBar();
        status(_t('js.pad.chat.line_unavailable', 'That line isn’t available.'));
      });
    }
    function onHit(e) {
      var t = e.target;
      if (closest(t, hits, function (n) { return n.tagName === 'A' || (n.tagName === 'BUTTON' && !n.classList.contains('srch-when')); })) return;
      var hit = closest(t, hits, function (n) { return n._c > 0; });
      if (hit) openLine(hit._c);
    }

    function update() {
      var ok = can();
      if (btn) btn.hidden = !ok;
      if (!ok && open) close(false);
      paintNote();
    }
    update();

    return {
      update: update,
      /** the pad's settings changed (the floors moved), the page re-joined: what the results showed may be gone - search again */
      reset: function () { gen++; busy = false; asked = null; clear(); status(''); },
      /** lines taken down (hidden, removed, deleted) or whose speaker is hidden now leave the results */
      drop: function (cs) {
        var gone = {}, n = 0;
        (cs || []).forEach(function (c) { gone[c] = 1; });
        Array.prototype.slice.call(hits.childNodes).forEach(function (x) {
          var c = x._c || Number(x.getAttribute && (x.getAttribute('data-c') || x.getAttribute('data-rmc'))) || 0;
          if (c && gone[c]) { hits.removeChild(x); if (x.classList && !x.classList.contains('srch-when')) n++; }
        });
        return n;
      },
      open: openBar,
      close: close,
      isOpen: function () { return open; },
      _state: function () { return { open: open, busy: busy, count: count, cursor: cursor, kind: kind }; },
    };
  }
  /** From's suggestions: the people whose lines are on the screen now (their PATV username from the profile link, else the login
   *  the name's tooltip carries, else the name as shown) - never a list from the server. */
  function screenNames(boxes) {
    var seen = {}, out = [];
    (boxes || []).forEach(function (b) {
      if (!b || !b.querySelectorAll) return;
      Array.prototype.forEach.call(b.querySelectorAll('.line:not(.pepe) .who'), function (w) {         // Pepe: Hide Pepe's job
        if (out.length >= 50) return;
        var v = '', href = w.getAttribute('href') || '';
        var m = /^(?:https:\/\/[^/]+)?\/u\/([^/?#]+)$/.exec(href);
        if (m) { try { v = decodeURIComponent(m[1]); } catch (e) { v = ''; } }
        if (!v) v = w.getAttribute('title') || '';
        if (!v || v === 'Pepe') v = w.textContent || '';
        v = String(v).replace(/\s+/g, ' ').trim();
        if (!v || v.length > 64 || seen[v.toLowerCase()]) return;
        seen[v.toLowerCase()] = 1;
        out.push(v);
      });
    });
    return out;
  }
  window.PATVPadSearch = { init: init, screenNames: screenNames, PAGE: PAGE };
})();
