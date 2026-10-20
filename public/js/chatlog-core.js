// chatlog-core.js - CL5: ONE renderer for the pad chat's lines (chat-history spec §3.7), for the browser and for Node (UMD,
// plain ES5, no dependencies; the pad-tabs.js / helpsearch.js / tz-core.js pattern). The live chat (views/room.ejs) builds
// every line with it; scrollback, search results and the downloads (HTML / TXT / JSONL) use the same calls, so a line looks
// the same wherever it shows.
//
//   renderItem(it, ctx, h) -> a line built with h(tag, attrs, children), or null for a kind the chat doesn't show
//       h = domH(document) in the browser (DOM nodes) or htmlH on the server (escaped HTML - String(node) is the markup).
//       attrs: null / undefined / false leave an attribute out; children: nodes and strings (text - never markup).
//   avatarNode / nameNode / flairNode / timeNode (u or ts, ctx, h) - the pieces (the pad's mic and people lists use them too)
//   textItem(it, ctx) -> one TXT line, "[HH:MM] ..." (the "PATV chat log v1" item grammar, spec §3.8; the file's header and
//       footer are the export's) · jsonItem(it, ctx) -> the JSONL object ({c, ts, local, kind, ...}; no account ids)
//   fmtTime(ts, ctx) -> "HH:MM" · dayLabel(ts, ctx) -> "Today" / "Yesterday" (ctx.relative) / "Saturday 18 October" [2026]
//   label(u, ctx), sysText(it, ctx), liveText(it, ctx), noteText(it, ctx), spanOf(s, ctx), chipSpan(s, ctx), dur(ms), hue(s)
//
// it = a projected feed item, as the live view sends it (bridge.js feedItem + chatlogview.dress + withPatv):
//   {k: msg|tx|join|leave|mic|unmic|topic|live|note, c, ts (ms), u: {login, display, self, web, acct, bot, anon, former,
//    patv: {username, avatar, style, flair}}, text, id (a 🎙 line's tx id), ms (mic held), who/pad/what/link/np (🎥 / 📼),
//    w/s/o/sc (📜 settings note), own (CL6: the viewer's own line), removed (CL6: {purged} | {at, by: mod|staff|self|report, who?,
//    why} - a hidden line as only the pad's owner and staff get it)}
//
// ctx (every field optional):
//   t(key, englishDefault, vars) -> PLAIN text: the page's __t (default), or on the server a translator that interpolates
//                raw (h escapes; i18n-core's t() HTML-escapes {name}, so decode or use the raw variant there)
//   lang         the page's language, for the browser's Intl dates (noteText's day, dayLabel without `names`)
//   offset       minutes east of UTC - a number or fn(ms) -> number. Downloads pass the zone's offset (tz-core), so a file
//                never depends on the ICU build (Node 16 vs 20) or the machine's zone: with an offset nothing here calls Intl -
//                the times, day labels and the 📜 note's day all come from it and `names` (English without them). Omitted =
//                the browser's own clock, and Intl in `lang` for day names (the live chat, scrollback, search)
//   names        {weekdays: [7, Sunday first], months: [12]} - dayLabel and the 📜 note's day built from these, without Intl
//   relative     dayLabel says Today / Yesterday (scrollback); `now` (ms) = what "today" is (default Date.now())
//   year         dayLabel's year: true = always (downloads), false = never, unset = when it isn't this year
//   origin       e.g. "https://publicaccess.tv": profile and 🎥 links become absolute, rel="nofollow noopener" (downloads)
//   avatar(u)    -> an image src or null (= the letter bubble). Default: the profile picture the live view carries, by the
//                server's own rule (bridge.js safeImg); downloads pass () => null (a file never loads a picture from anywhere)
//   avatarCls(u) -> CL10: the name of a rule in a download's own stylesheet that carries this person's picture, or null - a
//                file embeds each picture ONCE, as a data: URI (.av.av-N), and the line's .av gets that name (no img, no letter)
//   timeTitle(ts) -> the <time>'s tooltip (full date, time and zone: scrollback and downloads). The live chat has none
//   date(ms)     -> the day in the 📜 "Earlier history opens on {date}" line. Default: day + month - from the offset and
//                `names` when there is an offset, else Intl in `lang`
//   data         false = no data-c / data-k / data-name / data-text / data-tx (the live page's ✂️ Clip / quotes read them)
//   hl           CL9: [[start, end], ...] - the search's matches in this line's text (chatlogsearch.js, over the projected text):
//                those parts of a chat / 🎙 line's or a topic's text go in <mark>s. Omitted = no marks (every other caller)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.PATVChatlog = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  var HAS = Object.prototype.hasOwnProperty;
  var isArr = Array.isArray || function (x) { return Object.prototype.toString.call(x) === '[object Array]'; };
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var SPAN_D = { one: '{count} day', other: '{count} days' }, SPAN_H = { one: '{count} hour', other: '{count} hours' },
      SPAN_M = { one: '{count} minute', other: '{count} minutes' };
  var WD_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MO_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // chat item kind -> the JSONL kind (spec §3.8); 🎥 is "live" or "now_playing"
  var KIND = { msg: 'chat', tx: 'mic', join: 'join', leave: 'leave', mic: 'mic_grab', unmic: 'mic_drop', topic: 'topic', note: 'note' };
  var BY_PERSON = { msg: 1, tx: 1, join: 1, leave: 1, mic: 1, unmic: 1 };

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function str(v) { return v == null ? '' : String(v); }
  function pad2(n) { return ('0' + n).slice(-2); }

  // the translator: ctx.t, else the page's __t, else the English default with its {placeholders} filled in
  function interp(d, v) {
    if (d && typeof d === 'object') d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  }
  function tr(ctx) {
    var f = ctx && typeof ctx.t === 'function' ? ctx.t : root && typeof root.__t === 'function' ? root.__t : null;
    return function (k, d, v) { return f ? str(f(k, d, v)) : interp(d, v); };
  }

  // ── the two h()s: DOM nodes (browser) and escaped HTML (server) ──
  function kidList(kids) { return kids == null ? [] : isArr(kids) ? kids : [kids]; }
  function domH(doc) {
    doc = doc || (root && root.document);
    return function (tag, attrs, kids) {
      var e = doc.createElement(tag);
      if (attrs) for (var k in attrs) {
        if (!HAS.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'style') e.style.cssText = String(v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
      var ks = kidList(kids);
      for (var i = 0; i < ks.length; i++) {
        var c = ks[i];
        if (c == null || c === false) continue;
        e.appendChild(typeof c === 'object' ? c : doc.createTextNode(String(c)));
      }
      return e;
    };
  }
  function Html(s) { this.html = s; }
  Html.prototype.toString = function () { return this.html; };
  var VOID = { area: 1, br: 1, col: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, wbr: 1 };
  function htmlH(tag, attrs, kids) {
    var s = '<' + tag;
    if (attrs) for (var k in attrs) {
      if (!HAS.call(attrs, k)) continue;
      var v = attrs[k];
      if (v == null || v === false) continue;
      s += ' ' + k + (v === true ? '' : '="' + esc(v) + '"');
    }
    s += '>';
    if (VOID[tag]) return new Html(s);
    var ks = kidList(kids);
    for (var i = 0; i < ks.length; i++) {
      var c = ks[i];
      if (c == null || c === false) continue;
      s += c instanceof Html ? c.html : esc(c);
    }
    return new Html(s + '</' + tag + '>');
  }

  // ── links and pictures: only what the server would send (defence in depth - the live view already checks) ──
  function safeLink(p) { return typeof p === 'string' && (/^\/(?!\/)[^\s"'<>\\]*$/.test(p) || /^https:\/\/[^\s"'<>\\]+$/.test(p)); }
  // CL5 fix-up: a site path never starts "//" (that is another host) and has no "." / ".." segment - stricter than bridge.js
  // safeImg, which still lets both through; anything else gets the letter bubble
  function safeSrc(p) {
    return typeof p === 'string' && (/^https:\/\/[^\s"'<>]+$/.test(p) || (/^\/(?!\/)[A-Za-z0-9/_.\-]+$/.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p)));
  }
  function linkOf(ctx, p) { return ctx && ctx.origin && p.charAt(0) === '/' ? String(ctx.origin).replace(/\/+$/, '') + p : p; }
  function relOf(ctx) { return ctx && ctx.origin ? 'nofollow noopener' : null; }

  // ── time ──
  function msOf(ts) {
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(ts)) return Date.parse(ts);
    return Number(ts);
  }
  function offsetOf(ms, ctx) {
    if (!ctx || ctx.offset == null) return null;
    var o = typeof ctx.offset === 'function' ? ctx.offset(ms) : ctx.offset;
    return isFinite(Number(o)) ? Number(o) : null;
  }
  // the wall clock at ts: in ctx.offset's zone, else the browser's own
  function clock(ts, ctx) {
    var ms = msOf(ts), off = offsetOf(ms, ctx);
    if (off == null) {
      var d = new Date(ts);
      return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), wd: d.getDay(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), off: -d.getTimezoneOffset() };
    }
    var u = new Date(ms + off * 60000);
    return { y: u.getUTCFullYear(), mo: u.getUTCMonth(), d: u.getUTCDate(), wd: u.getUTCDay(), h: u.getUTCHours(), mi: u.getUTCMinutes(), s: u.getUTCSeconds(), off: off };
  }
  function fmtTime(ts, ctx) { var p = clock(ts, ctx); return isNaN(p.h) ? '' : pad2(p.h) + ':' + pad2(p.mi); }   // CL5 fix-up: a bad ts, no "aN:aN"
  function isoOf(ts) { var d = new Date(msOf(ts)); return isNaN(d.getTime()) ? null : d.toISOString(); }
  function localIso(ts, ctx) {
    var p = clock(ts, ctx);
    if (isNaN(p.y)) return null;
    var a = Math.abs(p.off), sign = p.off < 0 ? '-' : '+';
    return p.y + '-' + pad2(p.mo + 1) + '-' + pad2(p.d) + 'T' + pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s) +
      sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
  }
  function dayNo(p) { return Math.floor(Date.UTC(p.y, p.mo, p.d) / 864e5); }
  /** A day divider: "Today" / "Yesterday" (ctx.relative), else "Saturday 18 October" (+ the year, see ctx.year). */
  function dayLabel(ts, ctx) {
    ctx = ctx || {};
    var _t = tr(ctx), p = clock(ts, ctx), n = clock(ctx.now != null ? ctx.now : Date.now(), ctx);
    if (ctx.relative) {
      var diff = dayNo(n) - dayNo(p);
      if (diff === 0) return _t('js.pad.chat.today', 'Today');
      if (diff === 1) return _t('js.pad.chat.yesterday', 'Yesterday');
    }
    if (isNaN(p.y)) return '';
    var withYear = ctx.year === true || (ctx.year !== false && p.y !== n.y);
    var names = ctx.names;
    // the browser (no offset, no names): Intl in the page's language. CL5 fix-up: with an offset (a download) never Intl - the
    // names, else English, so a file reads the same on every ICU build
    if (!names && offsetOf(msOf(ts), ctx) == null) {
      try {
        var o = { weekday: 'long', day: 'numeric', month: 'long' };
        if (withYear) o.year = 'numeric';
        return new Date(msOf(ts)).toLocaleDateString(ctx.lang || undefined, o);
      } catch (e) { names = null; }
    }
    var wd = names && names.weekdays && names.weekdays[p.wd] ? names.weekdays[p.wd] : WD_EN[p.wd];
    var mo = names && names.months && names.months[p.mo] ? names.months[p.mo] : MO_EN[p.mo];
    return wd + ' ' + p.d + ' ' + mo + (withYear ? ' ' + p.y : '');
  }
  function dur(ms) { var s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h'; }
  /** A history window in words: "15 minutes", "24 hours", "7 days" (the 📜 note line). */
  function spanOf(s, ctx) {
    var _t = tr(ctx);
    if (s % 86400 === 0 && s >= 172800) return _t('js.pad.chat.span_d', SPAN_D, { count: s / 86400 });
    if (s % 3600 === 0) return _t('js.pad.chat.span_h', SPAN_H, { count: s / 3600 });
    return _t('js.pad.chat.span_min', SPAN_M, { count: Math.max(1, Math.round(s / 60)) });
  }
  /** The same, short, for the 📜 chip: "15 min", "24 h", "7 d". */
  function chipSpan(s, ctx) {
    var _t = tr(ctx);
    if (s % 86400 === 0 && s >= 172800) return _t('js.pad.chat.chip_d', '{n} d', { n: s / 86400 });
    if (s % 3600 === 0) return _t('js.pad.chat.chip_h', '{n} h', { n: s / 3600 });
    return _t('js.pad.chat.chip_min', '{n} min', { n: Math.max(1, Math.round(s / 60)) });
  }

  // ── people ──
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  // CL5 fix-up: an account key "u:<userId>" (a web member with no chat login - bridge.js ACCT_RE) is an internal id: never the
  // name, the tooltip, data-name or a file's author. A web member whose name didn't resolve (a name-cache miss: the live view
  // then carries the key as the display) reads "a PATV member", as bridge.js names one that came without a display
  var ACCT_KEY = /^u:[A-Za-z0-9-]{6,64}$/i;
  function shownName(u, ctx) {
    var l = str(u.login), d = str(u.display), acct = !l || ACCT_KEY.test(l), _t;
    if (d && !(acct && ACCT_KEY.test(d))) return d;
    if (l && !acct) return l;
    if (!d && !l) return '';
    _t = tr(ctx);
    return _t('js.pad.chat.member', 'a PATV member');
  }
  /** The name a line shows: "someone" (hidden at send time), "former member" (a web member whose account is gone), else
   *  the display name (the PATV one when the login is linked), else the login - never an account key ("a PATV member"). */
  function label(u, ctx) {
    var _t = tr(ctx);
    return !u || u.anon ? _t('js.pad.someone', 'someone') : u.former ? _t('js.pad.chat.former', 'former member') : shownName(u, ctx);
  }
  function avatarSrc(u, ctx) {
    if (!u || u.anon || u.former) return null;
    if (ctx && typeof ctx.avatar === 'function') return ctx.avatar(u) || null;
    return u.patv && safeSrc(u.patv.avatar) ? u.patv.avatar : null;
  }
  /** The picture: their profile photo, else a letter bubble in the colour of their login ("?" for nobody). CL10: ctx.avatarCls(u)
   *  -> the name of a rule in a download's own stylesheet that carries the picture - each one embedded once, not on every line. */
  function avatarNode(u, ctx, h) {
    var cls = u && !u.anon && !u.former && ctx && typeof ctx.avatarCls === 'function' ? ctx.avatarCls(u) : null;
    if (typeof cls === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(cls)) return h('span', { 'class': 'av ' + cls, 'aria-hidden': 'true' }, null);
    var src = avatarSrc(u, ctx);
    if (src) return h('img', { 'class': 'av', src: src, alt: '', loading: 'lazy' });
    var nobody = !u || u.anon || u.former;
    return h('span', { 'class': 'av' + (nobody ? ' anon' : ''), style: nobody ? null : 'background:hsl(' + hue(u.login || '') + ',55%,62%)', 'aria-hidden': 'true' },
      [nobody ? '?' : (shownName(u, ctx) || '?').charAt(0).toUpperCase()]);
  }
  /** The name: a link to their profile in its cosmetic style when the login is linked; the login as its tooltip when the
   *  display name differs; 🌐 after a line they typed on the website. Never a link for "someone" / "former member". */
  function nameNode(u, ctx, h) {
    var _t = tr(ctx);
    if (!u || u.anon) return h('span', { 'class': 'who' }, [_t('js.pad.someone', 'someone')]);
    if (u.former) return h('span', { 'class': 'who' }, [_t('js.pad.chat.former', 'former member')]);
    var style = u.patv && u.patv.style ? String(u.patv.style) : null;
    var a = { 'class': 'who' + (style ? ' cx-name' : ''), style: style };
    if (u.self) a.title = 'Pepe';
    else if (u.display && u.login && !u.acct && !ACCT_KEY.test(String(u.login)) && String(u.display).toLowerCase() !== String(u.login).toLowerCase()) a.title = u.login;
    if (u.patv) { a.href = linkOf(ctx, '/u/' + encodeURIComponent(u.patv.username)); a.rel = relOf(ctx); }
    var n = h(u.patv ? 'a' : 'span', a, [shownName(u, ctx)]);
    if (!u.web) return n;
    // 1.99xa: a line they sent from the website (Pepe relayed it) - their own chat, marked so the room can tell
    return h('span', { 'class': 'who-web' }, [n, h('span', { 'class': 'web-mark', title: _t('js.pad.chat.web', 'Sent from the website') }, ['\u00a0\ud83c\udf10'])]);
  }
  /** 1.99ir: their flair in this pad (padflair.js) - text only, colours must be strict hex. */
  function flairNode(u, ctx, h) {
    var f = u && !u.anon && u.patv && u.patv.flair;
    if (!f || !f.name) return null;
    var _t = tr(ctx), st = [], kids = [];
    if (/^#[0-9a-f]{6}$/.test(f.color || '')) st.push('--fl:' + f.color);
    if (/^#[0-9a-f]{6}$/.test(f.ink || '')) st.push('--fli:' + f.ink);
    if (f.emoji) kids.push(h('span', { 'class': 'ufl-e' }, [f.emoji]));
    kids.push(h('span', { 'class': 'ufl-n' }, [f.name]));     // 1.99xm: its own span so a long name ellipsizes
    return h('span', { 'class': 'ufl', title: _t('js.pad.flair', 'Pad flair: {name}', { name: f.name }), style: st.length ? st.join(';') : null }, kids);
  }
  function timeNode(ts, ctx, h) {
    var title = ctx && typeof ctx.timeTitle === 'function' ? ctx.timeTitle(ts) : null;
    return h('time', { 'class': 'when', datetime: isoOf(ts), title: title || null }, [fmtTime(ts, ctx)]);
  }

  // ── the system lines' text (the viewer's language) ──
  function sysText(it, ctx) {
    var _t = tr(ctx), k = it.k;
    return k === 'join' ? _t('js.pad.chat.joined', '→ {name} joined', { name: label(it.u, ctx) })
      : k === 'leave' ? _t('js.pad.chat.left', '← {name} left', { name: label(it.u, ctx) })
      : k === 'mic' ? _t('js.pad.chat.mic', '🎙️ {name} grabbed the mic', { name: label(it.u, ctx) })
      : k === 'unmic' ? (it.ms ? _t('js.pad.chat.unmic_after', '🎙️ {name} dropped the mic after {dur}', { name: label(it.u, ctx), dur: dur(it.ms) })
        : _t('js.pad.chat.unmic', '🎙️ {name} dropped the mic', { name: label(it.u, ctx) }))
      : k === 'topic' ? _t('js.pad.chat.topic', '📌 topic: {text}', { text: it.text }) : null;
  }
  /** 1.99kp: 🎥 a stream started on this pad's stage (golive.js -> bridge.liveNotice); 1.99lr: np = a 📼 queue's next title. */
  function liveText(it, ctx) {
    var _t = tr(ctx);
    return it.np ? _t('js.pad.chat.np', '📼 Now playing on {pad}: {what}', { pad: it.pad, what: it.what })
      : it.what ? _t('js.pad.chat.live_what', '🎥 {name} just went live on {pad} — {what}', { name: it.who, pad: it.pad, what: it.what })
      : _t('js.pad.chat.live', '🎥 {name} just went live on {pad}', { name: it.who, pad: it.pad });
  }
  function noteDay(ms, ctx) {
    if (ctx && typeof ctx.date === 'function') return str(ctx.date(ms));
    // CL5 fix-up: with an offset (a download) the day + month come from it and ctx.names (English without them) - never Intl,
    // so the text doesn't change with the ICU build or the machine's zone
    if (offsetOf(msOf(ms), ctx) != null) {
      var p = clock(ms, ctx), mo = ctx.names && ctx.names.months && ctx.names.months[p.mo] ? ctx.names.months[p.mo] : MO_EN[p.mo];
      return isNaN(p.d) ? '' : p.d + ' ' + mo;
    }
    var day = '';
    try { day = new Date(ms).toLocaleDateString(ctx && ctx.lang || undefined, { day: 'numeric', month: 'long' }); } catch (e) { day = new Date(ms).toDateString(); }
    return day;
  }
  /** CL3: 📜 a pad's chat-history settings line (padchat.js / chatlogview.js), or null for a kind this build doesn't know. */
  function noteText(it, ctx) {
    var _t = tr(ctx);
    if (it.w === 'window') return it.s == null ? _t('js.pad.chat.note_all', '📜 Chat history on this pad: everything it keeps')
      : it.s === 0 ? _t('js.pad.chat.note_off', '📜 Chat history on this pad: off') : _t('js.pad.chat.note_window', '📜 Chat history on this pad: last {span}', { span: spanOf(it.s, ctx) });
    if (it.w === 'search') return it.s ? _t('js.pad.chat.note_search_on', '📜 Search is on again on this pad, for lines said from now on') : _t('js.pad.chat.note_search_off', '📜 Search is now off on this pad');
    if (it.w === 'open') return _t('js.pad.chat.note_open', '📜 Earlier history opens on {date}', { date: noteDay(it.o, ctx) });
    if (it.w === 'open_done') return _t('js.pad.chat.note_open_done', '📜 Earlier history is open on this pad now');
    return null;
  }

  /** CL9: ctx.hl as clean [start, end] pairs, or null. */
  function hlOf(ctx) {
    var r = ctx && ctx.hl;
    if (!isArr(r) || !r.length) return null;
    var out = [];
    for (var i = 0; i < r.length; i++) {
      var p = r[i];
      if (isArr(p) && isFinite(Number(p[0])) && isFinite(Number(p[1])) && Number(p[1]) > Number(p[0])) out.push([Math.floor(Number(p[0])), Math.floor(Number(p[1]))]);
    }
    return out.length ? out : null;
  }
  /** CL9: a text with its marked ranges -> [text, <mark>text</mark>, text, ...] (ranges sorted, never overlapping, inside s). */
  function markKids(s, ranges, h) {
    var out = [], at = 0;
    s = str(s);
    for (var i = 0; i < ranges.length; i++) {
      var a = Math.max(at, ranges[i][0]), b = Math.min(s.length, ranges[i][1]);
      if (!(b > a)) continue;
      if (a > at) out.push(s.slice(at, a));
      out.push(h('mark', null, [s.slice(a, b)]));
      at = b;
    }
    if (at < s.length || !out.length) out.push(s.slice(at));
    return out;
  }

  /** CL6: why a line is hidden, as the pad's owner and staff see it ("Hidden by @mae · spam", "Removed by its author"). */
  function removedNote(rm, ctx) {
    var _t = tr(ctx);
    if (rm.purged) return _t('js.pad.chat.removed', 'Removed');
    // (CL6 fix-up: a staff member is "PATV staff" to the pad's owner - their name only to other staff)
    var base = rm.by === 'self' ? _t('js.pad.chat.removed_self', 'Removed by its author')
      : rm.by === 'report' ? _t('js.pad.chat.hidden_report', 'Hidden after a report')
      : rm.who ? _t('js.pad.chat.hidden_by', 'Hidden by {who}', { who: '@' + rm.who })
      : rm.by === 'staff' ? _t('js.pad.chat.hidden_staff', 'Hidden by PATV staff') : _t('js.pad.chat.hidden_mod', 'Hidden by a moderator');
    return rm.why ? base + ' \u00b7 ' + rm.why : base;
  }
  /** A chat or mic line. CL6: rm = a hidden line as the owner / staff see it - muted, with why, and data-rmc instead of data-c
   *  (never picked by ✂️ Clip chat / 🔊 Clip); it.own = the viewer's own line (data-own: the ⋯ menu offers Remove). */
  function chatLine(it, ctx, h, rm) {
    var _t = tr(ctx), k = it.k;
    var tx = k === 'tx', text = str(it.text);
    var a = { 'class': 'line' + (tx ? ' tx' : '') + (it.u && it.u.self ? ' pepe' : '') + (rm ? ' rm' : '') };
    if (tx) a.title = _t('js.pad.chat.tx', 'Said on the mic (auto-transcribed)');
    // 1.99fp: what ✂️ Clip chat / 🔊 Clip read (public/js/chat-clip.js) - the server re-reads its own copy by id
    if (ctx.data !== false) {
      if (rm) { if (it.c) a['data-rmc'] = it.c; a['data-rm'] = rm.by || 'mod'; }
      else {
        if (it.c) a['data-c'] = it.c;
        a['data-k'] = k; a['data-name'] = label(it.u, ctx); a['data-text'] = text;
        if (tx && it.id) a['data-tx'] = it.id;
        if (it.own) a['data-own'] = '1';
      }
    }
    var body = [nameNode(it.u, ctx, h)];
    var fl = flairNode(it.u, ctx, h);
    if (fl) body.push(fl, ' ');
    var marks = hlOf(ctx);
    if (marks) {
      // CL9: a search hit - the matched words in <mark>s (the same text, in pieces)
      if (tx) body.push('\u201c');
      body.push.apply(body, markKids(text, marks, h));
      if (tx) body.push('\u201d');
      body.push(timeNode(it.ts, ctx, h));
    } else body.push(tx ? '\u201c' + text + '\u201d' : text, timeNode(it.ts, ctx, h));
    if (rm) body.push(h('span', { 'class': 'rm-note' }, [removedNote(rm, ctx)]));
    return h('div', a, [avatarNode(it.u, ctx, h), h('div', { 'class': 'body' }, body)]);
  }

  /** One chat item as the pad chat shows it - the live markup (.line / .line.tx / .line.pepe / .sys / .sys.topic / .sys.live /
   *  .sys.note, public/css/chatlog.css), or null for a kind the chat doesn't show. CL6: a hidden / removed line (it.removed -
   *  only the pad's owner and staff ever get one) is .line.rm with why; a purged one, a sealed one (CL6 fix-up: the owner's view of
   *  a self-removal or a report's hide - no words), or a hidden system line, a .sys.rm. */
  function renderItem(it, ctx, h) {
    if (!it) return null;
    ctx = ctx || {};
    var k = it.k;
    if (it.removed && typeof it.removed === 'object') {
      var rm = it.removed;
      if (!rm.purged && !rm.sealed && (k === 'msg' || k === 'tx')) return chatLine(it, ctx, h, rm);
      var ra = { 'class': 'sys rm' };
      if (ctx.data !== false && it.c) { ra['data-rmc'] = it.c; ra['data-rm'] = rm.purged ? 'purged' : (rm.by || 'mod'); }
      return h('div', ra, [removedNote(rm, ctx) + ' \u00b7 ' + fmtTime(it.ts, ctx)]);
    }
    if (k === 'msg' || k === 'tx') return chatLine(it, ctx, h, null);
    if (k === 'live') {
      var lt = liveText(it, ctx), ok = safeLink(it.link);
      return h('div', { 'class': 'sys live' }, [ok ? h('a', { href: linkOf(ctx, it.link), rel: relOf(ctx) }, [lt]) : lt, ' · ' + fmtTime(it.ts, ctx)]);
    }
    if (k === 'note') { var nt = noteText(it, ctx); return nt ? h('div', { 'class': 'sys note' }, [nt + ' · ' + fmtTime(it.ts, ctx)]) : null; }
    var txt = sysText(it, ctx);
    if (!txt) return null;
    var marks = k === 'topic' ? hlOf(ctx) : null, at = marks ? txt.indexOf(str(it.text)) : -1;
    if (marks && at >= 0 && str(it.text)) {
      // CL9: a search hit on the topic - the marks inside the topic's own text
      var tt = str(it.text);
      return h('div', { 'class': 'sys topic' }, [txt.slice(0, at)].concat(markKids(tt, marks, h), [txt.slice(at + tt.length) + ' · ' + fmtTime(it.ts, ctx)]));
    }
    return h('div', { 'class': 'sys' + (k === 'topic' ? ' topic' : '') }, [txt + ' · ' + fmtTime(it.ts, ctx)]);
  }

  // ── the downloads' item formats (spec §3.8) ──
  // CL5 fix-up: one line per item whatever the text holds - every break a viewer may honour (CR, LF, VT, FF, U+001C-001E, NEL
  // U+0085, U+2028, U+2029) is " ⏎ ", so no text can start a forged "[hh:mm] Name: ..." row; other control characters (an ESC
  // sequence moves a terminal's cursor) are U+FFFD; a tab stays
  function oneLine(s) {
    return String(s).replace(/\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/g, ' \u23ce ')
      .replace(/[\u0000-\u0008\u000e-\u001b\u001f\u007f-\u0084\u0086-\u009f]/g, '\ufffd');
  }
  /** One TXT line: "[21:04] Plantbaked: hello room", "[21:05] 🎙 Bob: “said on the mic”", "[21:06] → Bob joined" ... */
  function textItem(it, ctx) {
    if (!it) return null;
    ctx = ctx || {};
    var k = it.k, body;
    if (k === 'msg' || k === 'tx') {
      var who = label(it.u, ctx) + (it.u && it.u.web && !it.u.anon && !it.u.former ? ' \ud83c\udf10' : '');
      body = k === 'tx' ? '\ud83c\udf99 ' + who + ': \u201c' + str(it.text) + '\u201d' : who + ': ' + str(it.text);
    } else if (k === 'live') body = liveText(it, ctx) + (safeLink(it.link) ? ' <' + linkOf(ctx, it.link) + '>' : '');
    else if (k === 'note') body = noteText(it, ctx);
    else body = sysText(it, ctx);
    return body ? '[' + fmtTime(it.ts, ctx) + '] ' + oneLine(body) : null;
  }
  /** Who said it, for the JSONL: never an account id; the Camfrog login only where the live chat shows it. */
  function author(u, ctx) {
    if (!u || u.anon || u.former) return { name: label(u, ctx), patv: null, camfrog: null, web: false, pepe: false, bot: false, someone: !u || !!u.anon };
    var login = u.acct || /^u:/i.test(str(u.login)) ? null : (u.login ? String(u.login) : null);
    return { name: shownName(u, ctx), patv: u.patv && u.patv.username ? String(u.patv.username) : null, camfrog: login,
             web: !!u.web, pepe: !!u.self, bot: !!u.bot, someone: false };
  }
  /** One JSONL object: {c, ts, local, kind, [auto], [author], text | held_ms | who/pad/what/link}. */
  function jsonItem(it, ctx) {
    if (!it) return null;
    ctx = ctx || {};
    var k = it.k, kind = k === 'live' ? (it.np ? 'now_playing' : 'live') : KIND[k];
    if (!kind) return null;
    var o = { c: it.c ? Number(it.c) : null, ts: isoOf(it.ts), local: localIso(it.ts, ctx), kind: kind };
    if (k === 'tx') o.auto = true;
    if (BY_PERSON[k]) o.author = author(it.u, ctx);
    if (k === 'msg' || k === 'tx' || k === 'topic') o.text = str(it.text);
    else if (k === 'unmic') o.held_ms = Math.max(0, Number(it.ms) || 0);
    else if (k === 'note') o.text = noteText(it, ctx) || '';
    else if (k === 'live') {
      o.who = str(it.who); o.pad = str(it.pad);
      if (it.what) o.what = str(it.what);
      o.link = safeLink(it.link) ? linkOf(ctx, it.link) : null;
    }
    return o;
  }

  return {
    renderItem: renderItem, avatarNode: avatarNode, nameNode: nameNode, flairNode: flairNode, timeNode: timeNode,
    textItem: textItem, jsonItem: jsonItem, fmtTime: fmtTime, dayLabel: dayLabel, isoOf: isoOf, localIso: localIso,
    label: label, sysText: sysText, liveText: liveText, noteText: noteText, removedNote: removedNote, spanOf: spanOf, chipSpan: chipSpan, dur: dur, hue: hue,
    markKids: markKids,
    domH: domH, htmlH: htmlH, esc: esc, safeLink: safeLink, safeSrc: safeSrc
  };
});
