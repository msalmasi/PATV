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
//   cfsticker(set,id) -> the site's sticker image URL, or null. Downloads never call it (data:false).
//   timeTitle(ts) -> the <time>'s tooltip (full date, time and zone: scrollback and downloads). The live chat has none
//   date(ms)     -> the day in the 📜 "Earlier history opens on {date}" line. Default: day + month - from the offset and
//                `names` when there is an offset, else Intl in `lang`
//   data         false = no data-c / data-k / data-name / data-text / data-tx (the live page's ✂️ Clip / quotes read them)
//   hl           CL9: [[start, end], ...] - the search's matches in this line's text (chatlogsearch.js, over the projected text):
//                those parts of a chat / 🎙 line's or a topic's text go in <mark>s. Omitted = no marks (every other caller)
//   blk          1.99-padppl: the viewer's OWN named blocks {l: [logins], u: [PATV usernames]} (bridge.js liveView blk) - a NAMED
//                chat / 🎙 line of someone in it is folded ("A line from someone you blocked · Show"); never a veiled line or a bar
//   it.vb        1.99-padppl rework: the server's flag on a FROG-NAMED line whose person this viewer blocked under a frog name (any frog
//                name - blocks.js veilKeysOf / chatlogview.dress): folded the same way; never on a bar
//   me           1.99-padppl: {username, login, display} - the viewer: a line that @mentions them gets .is-mention, its chip .mention-me
//   it.mn        1.99-padppl: the server's mentions on a web line [{n, username, login, veil, style, flair}] - each "@n" in the
//                text becomes a .mention chip in that person's name style (a frog name: plain)
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

  // 1.99aiw: exact media tokens, shared by the renderer, exports and quote builder. Text around a token stays ordinary text.
  function mediaToken(text) {
    if (typeof text !== 'string') return null;
    var m = /^\[cfsticker:(\d{1,10})\/(\d{1,10})\]$/.exec(text);
    if (m && m[0] === text) return { type: 'cfsticker', set: Number(m[1]), id: Number(m[2]) };
    m = /^\[gif:([A-Za-z0-9_-]{1,64})\]$/.exec(text);
    return m && m[0] === text ? { type: 'gif', id: m[1] } : null;
  }
  // 1.99ajc dockfu (D3): a line is a sticker / GIF only with the SERVER's mark - it.md ("cfsticker" / "gif"), which bridge.js
  // (mediaMark) sets on a line that came through a real sticker / GIF path: Pepe's room-sticker inject, or a relayed Dock pick whose
  // say job carried that very token. Never from the words alone: a "[cfsticker:1/2]" / "[gif:x]" typed in Camfrog (or said on the
  // mic) stays plain text everywhere - the line, ✂️ Clip chat, quotes, the TXT / JSONL downloads. The mark is not text (nobody can
  // type it) and never appears in an export.
  function mediaOf(it) {
    if (!it || it.k !== 'msg') return null;
    // 1.99ajf dockclean (owner point 21): a 🧸 PATV sticker sent from the Dock - Pepe posts its readable stand-in "[sticker: Name]" (stickers
    // fallbackText), and the server marks the echo of that very say job: md "sticker" + stk "<pack>/<id>" (bridge.js mediaMark)
    if (it.md === 'sticker') {
      var m = typeof it.stk === 'string' ? /^([a-z0-9]{1,32})\/([a-z0-9]{1,32})$/.exec(it.stk) : null;
      var alt = typeof it.text === 'string' ? /^\[sticker: ([^\[\]]{1,80})\]$/.exec(it.text) : null;
      return m && alt ? { type: 'sticker', pack: m[1], id: m[2], alt: alt[1] } : null;
    }
    if (it.md !== 'cfsticker' && it.md !== 'gif') return null;
    var token = mediaToken(it.text);
    return token && token.type === it.md ? token : null;
  }
  /** The reusable text of a line's words: "[sticker]" / "[GIF]" for a marked media line, else the words as they are. */
  function tokenText(text, md) {
    if (md === 'sticker') return str(text);          // (already the readable "[sticker: Name]")
    var token = md ? mediaToken(text) : null;
    return token && token.type === md ? (token.type === 'cfsticker' ? '[sticker]' : '[GIF]') : str(text);
  }
  function itemText(it) { return it && mediaOf(it) ? tokenText(it.text, it.md) : str(it && it.text); }

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
    // wave 2 (spec C.7): a veiled person with a frog name of this pad's session ("Soggy Bullfrog") - only the server sets u.alias on
    // an anon user; a Camfrog display name that reads like one is an ordinary named user
    if (u && u.anon && veilAlias(u)) return veilAlias(u);
    return !u || u.anon ? _t('js.pad.someone', 'someone') : u.former ? _t('js.pad.chat.former', 'former member') : shownName(u, ctx);
  }
  // ── wave 2: veiled people (privacy wire v2) ──
  var ALIAS_RE = /^(?:[A-Z][A-Za-z-]{1,15} [A-Z][A-Za-z]{1,15}|Mystery Frog \d{1,4})$/;
  function veilAlias(u) { var a = u && u.anon ? str(u.alias) : ''; return ALIAS_RE.test(a) ? a : ''; }
  function veilOf(u) { return u && u.anon && (u.veil === 'incognito' || u.veil === 'hidden') ? u.veil : null; }
  function hoodOf(u) { var n = u ? Number(u.hood) : NaN; return veilAlias(u) && n >= 0 && n <= 7 && Math.floor(n) === n ? n : null; }
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
    // wave 2 (C.7 / F.4): a frog name's hooded frog in its session's hood colour ("peek" incognito, "shadow" hidden) - the picture is
    // a CSS background (public/img/anon/hood-*-N.svg) over a plain fallback, so a missing file still draws a hood-coloured bubble
    var hd = hoodOf(u);
    if (hd != null) return h('span', { 'class': 'av hood ' + (veilOf(u) === 'hidden' ? 'hood-shadow' : 'hood-peek') + ' hd' + hd, 'aria-hidden': 'true' }, null);
    var nobody = !u || u.anon || u.former;
    return h('span', { 'class': 'av' + (nobody ? ' anon' : ''), style: nobody ? null : 'background:hsl(' + hue(u.login || '') + ',55%,62%)', 'aria-hidden': 'true' },
      [nobody ? '?' : (shownName(u, ctx) || '?').charAt(0).toUpperCase()]);
  }
  /** The name: a link to their profile in its cosmetic style when the login is linked; the login as its tooltip when the
   *  display name differs; 🌐 after a line they typed on the website. Never a link for "someone" / "former member". */
  function nameNode(u, ctx, h) {
    var _t = tr(ctx);
    var vl = veilOf(u);
    if (vl) {
      // wave 2 (C.7): the frog name in italics with a TEXT tag (never only an icon), never a link; "you, as Soggy Bullfrog" for the
      // speaker themself (self view). Without a name (C.2 / B.2): "someone" + the tag
      var al = veilAlias(u), tag = h('span', { 'class': 'veil-tag veil-' + vl }, [vl === 'hidden' ? _t('js.pad.veil.hidden', 'hidden') : _t('js.pad.veil.incognito', 'incognito')]);
      var nm = al ? h('i', null, [ctx && ctx.self ? _t('js.pad.veil.self', 'you, as {name}', { name: al }) : al]) : _t('js.pad.someone', 'someone');
      return h('span', { 'class': 'who veil', title: ctx && ctx.lineHead ? (al || _t('js.pad.someone', 'someone')) : null }, [nm, ' ', tag]);
    }
    if (!u || u.anon) return h('span', { 'class': 'who' }, [_t('js.pad.someone', 'someone')]);
    if (u.former) return h('span', { 'class': 'who' }, [_t('js.pad.chat.former', 'former member')]);
    var style = u.patv && u.patv.style ? String(u.patv.style) : null;
    var a = { 'class': 'who' + (style ? ' cx-name' : ''), style: style };
    if (u.self) a.title = 'Pepe';
    else if (u.display && u.login && !u.acct && !ACCT_KEY.test(String(u.login)) && String(u.display).toLowerCase() !== String(u.login).toLowerCase()) a.title = u.login;
    if (ctx && ctx.lineHead && !a.title) a.title = shownName(u, ctx);
    if (u.patv) { a.href = linkOf(ctx, '/u/' + encodeURIComponent(u.patv.username)); a.rel = relOf(ctx); }
    var n = h(u.patv ? 'a' : 'span', a, [shownName(u, ctx)]);
    // (dock3 1.99akf: no "not the Camfrog user" tag beside a name any more - owner: "just confusing"; the web mark below and the login tooltip
    // above tell two same-named people apart)
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
    if (f.emoji) kids.push(h('span', { 'class': 'ufl-e', 'data-e': ctx && ctx.data === false ? null : f.emoji }, [f.emoji]));     // flairfix: data-e - flair.css lifts Segoe's low 📼 (a file: no data-*)
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
  function mediaImage(attrs, fallback, h) {
    var img = h('img', attrs, []);
    // DOM-only error recovery: exports never create these images, and no inline event attribute enters HTML.
    if (img && typeof img.addEventListener === 'function') img.addEventListener('error', function () {
      if (img.parentNode && img.ownerDocument) img.parentNode.replaceChild(img.ownerDocument.createTextNode(fallback), img);
    }, { once: true });
    return img;
  }
  // stkimg 1.99akg: a Camfrog sticker's line can reach the chat before its picture reaches the site - Pepe uploads a picture the site
  // hasn't seen ~30 s after he learns it (pepe_sticker.py STICKER_SYNC_SOON; his 10-minute sync if that one was missed) - so its first
  // request 404s. The line shows its words ("[sticker]") as before and asks again ~35 s, ~90 s and ~11 min after that miss, each time
  // under a fresh ?r= (a URL this page never asked for: a browser or an edge that kept the failed one can't answer with it). One timer
  // per image at a time, none once the line has left the page, words for good after the last miss. Only a line under 10 minutes old
  // (its ts; none = new) waits for a picture - scrollback, search, a 📜 card's older lines whose picture never came ask once, as before.
  // A line that misses (or whose timer fires for) a picture this page already got under a retry URL takes that URL
  var STK_RETRY_AT = [35000, 90000, 660000], STK_FRESH_MS = 600000, stkGot = {};
  function stickerImage(attrs, fallback, h, ts) {
    var img = h('img', attrs, []);
    if (!img || typeof img.addEventListener !== 'function') return img;
    var base = String(attrs.src), tries = 0, words = null, asked = null, reused = false, first = 0, fresh = false;
    function onPage(n) {
      var d = n.ownerDocument;
      return typeof n.isConnected === 'boolean' ? n.isConnected : !!(d && typeof d.contains === 'function' && d.contains(n));
    }
    function got() { return HAS.call(stkGot, base) && stkGot[base] !== asked ? stkGot[base] : null; }
    // (detached, a loading="lazy" image would never load)
    function ask(url) { asked = url; img.removeAttribute('loading'); img.src = url; }
    img.addEventListener('error', function () {
      var doc = img.ownerDocument, win = doc && doc.defaultView, now = new Date().getTime(), url;
      if (!words) {
        if (!img.parentNode || !doc) return;
        words = doc.createTextNode(fallback); img.parentNode.replaceChild(words, img);
        first = now; fresh = !(Number(ts) > 0) || now - Number(ts) < STK_FRESH_MS;
      }
      if (!reused && (url = got())) { reused = true; ask(url); return; }
      if (!fresh || tries >= STK_RETRY_AT.length || !win || typeof win.setTimeout !== 'function') return;
      win.setTimeout(function () {
        if (!onPage(words)) return;
        var u = got(); tries++;
        ask(u || base + (base.indexOf('?') < 0 ? '?' : '&') + 'r=' + tries + '.' + Math.floor(new Date().getTime() / 1000).toString(36));
      }, Math.max(1000, first + STK_RETRY_AT[tries] - now));
    });
    img.addEventListener('load', function () {
      if (!words) return;                                   // (drawn the first time)
      if (asked) stkGot[base] = asked;
      if (words.parentNode) words.parentNode.replaceChild(img, words);
    });
    return img;
  }
  function mediaKids(it, ctx, h, token, mask, rm) {
    if (!token) return null;
    var _t = tr(ctx), fallback = itemText(it);
    // Downloads never request media, including a cache-warm web GIF. Removed / masked rows never request it either.
    if (ctx.data === false || mask || rm) return [fallback];
    // 1.99ajf dockclean (owner point 21): a 🧸 PATV sticker - the site's own art (/public/stickers/<pack>/<id>.svg), its name as the alt
    if (token.type === 'sticker') {
      return [mediaImage({ 'class': 'pstk', src: '/public/stickers/' + token.pack + '/' + token.id + '.svg', alt: token.alt, title: token.alt,
        width: 64, height: 64, loading: 'lazy', decoding: 'async' }, fallback, h)];
    }
    if (token.type === 'cfsticker') {
      var src = typeof ctx.cfsticker === 'function' ? ctx.cfsticker(token.set, token.id) : null;
      return src && safeSrc(src) ? [stickerImage({ 'class': 'cfstk', src: src, alt: _t('js.pad.chat.sticker', 'sticker'),
        width: 100, height: 100, loading: 'lazy', decoding: 'async' }, fallback, h, it.ts)] : [fallback];
    }
    // Only the server's mark makes a GIF line (mediaOf; a token typed in Camfrog never gets one), and only its cache attachment
    // (gifs.attach) draws remote media. 1.99ajc dockfu (D2, owner answer 6): a veiled sender's (incognito / !bridge hide frog name, or
    // "someone") GIF draws like anyone's - the picture and its credit say nothing about who sent it; the name stays the veil's
    var g = it.gif, noGif = _t('js.pad.chat.gif', '🎞️ GIF');
    if (!g || !safeSrc(g.src) || !/^https:\/\//.test(g.src)) return [noGif];
    function size(n, d) { n = Number(n); return isFinite(n) && n > 0 ? Math.min(2048, Math.floor(n)) : d; }
    return [h('span', { 'class': 'gif-media' }, [mediaImage({ 'class': 'gif', src: g.src, alt: str(g.title).slice(0, 80) || noGif,
      width: size(g.w, 160), height: size(g.h, 120), loading: 'lazy', decoding: 'async' }, noGif, h),
      h('small', { 'class': 'gif-credit' }, [_t('js.pad.chat.gif_via', 'via KLIPY')])])];
  }
  /** A chat or mic line. CL6: rm = a hidden line as the owner / staff see it - muted, with why, and data-rmc instead of data-c
   *  (never picked by ✂️ Clip chat / 🔊 Clip); it.own = the viewer's own line (data-own: the ⋯ menu offers Remove). */
  /** 1.99-padppl: is named person u in the viewer's own block list (ctx.blk)? Never a veil, Pepe or a former member. */
  function blockedOf(b, u) {
    if (!b || !u || u.anon || u.self || u.former || veilOf(u)) return false;
    var l = String(u.login || '').toLowerCase(), n = u.patv && u.patv.username ? String(u.patv.username).toLowerCase() : '';
    return (!!l && !ACCT_KEY.test(l) && isArr(b.l) && b.l.indexOf(l) >= 0) || (!!n && isArr(b.u) && b.u.indexOf(n) >= 0);
  }
  /** 1.99-padppl: does mention entry m (or the text) name the viewer (ctx.me)? */
  function mentionsMe(m, me) {
    if (!me || !m || m.veil) return false;
    var lo = function (v) { return String(v || '').toLowerCase(); };
    return (!!m.username && !!me.username && lo(m.username) === lo(me.username)) || (!!m.login && !!me.login && lo(m.login) === lo(me.login));
  }
  function lineMentionsMe(it, ctx) {
    var me = ctx && ctx.me; if (!me || !it || it.self === 1 || (it.u && it.u.self)) return false;
    if (isArr(it.mn)) for (var i = 0; i < it.mn.length; i++) if (mentionsMe(it.mn[i], me)) return true;
    var t = ' ' + String(it.text || '').toLowerCase() + ' ';
    var names = [me.username, me.login, me.display];
    for (var j = 0; j < names.length; j++) {
      var nm = String(names[j] || '').toLowerCase();
      if (nm && nm.length >= 2 && new RegExp('(^|[^\\w@])@' + nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.\\-])').test(t)) return true;
    }
    return false;
  }
  /** 1.99-padppl: the words with each "@n" of it.mn as a .mention chip (the person's name style; a frog name plain). */
  function mentionKids(text, mn, ctx, h) {
    if (!isArr(mn) || !mn.length || !text) return null;
    var out = [], pos = 0, found = false, low = text.toLowerCase();
    var list = mn.slice(0, 10).filter(function (m) { return m && m.n; });
    while (pos < text.length) {
      var best = -1, bm = null;
      for (var i = 0; i < list.length; i++) {
        var at = low.indexOf('@' + String(list[i].n).toLowerCase(), pos);
        if (at >= 0 && (best < 0 || at < best)) { best = at; bm = list[i]; }
      }
      if (best < 0) break;
      if (best > pos) out.push(text.slice(pos, best));
      var len = 1 + String(bm.n).length, shown = text.slice(best, best + len);
      var st = !bm.veil && bm.style ? String(bm.style) : null;
      var a = { 'class': 'mention' + (st ? ' cx-name' : '') + (mentionsMe(bm, ctx.me) ? ' mention-me' : ''), style: st };
      if (!bm.veil) a.title = (bm.username ? '@' + bm.username : '') + (bm.login && (!bm.username || String(bm.login).toLowerCase() !== String(bm.username).toLowerCase()) ? (bm.username ? ' · ' : '') + 'Camfrog: ' + bm.login : '');
      var kids = [shown];
      // (review fix: the flair as its emoji only, its name as the tooltip - a whole flair pill mid-sentence was cut off and split the chip)
      if (!bm.veil && bm.flair && bm.flair.emoji) {
        kids.push(h('span', { 'class': 'mn-fl', title: bm.flair.name ? String(bm.flair.name) : null, 'aria-label': bm.flair.name ? String(bm.flair.name) : null }, [String(bm.flair.emoji).slice(0, 8)]));
      }
      out.push(!bm.veil && bm.username ? h('a', Object.assign(a, { href: linkOf(ctx, '/u/' + encodeURIComponent(bm.username)), rel: relOf(ctx) }), kids) : h('span', a, kids));
      pos = best + len; found = true;
    }
    if (!found) return null;
    if (pos < text.length) out.push(text.slice(pos));
    return out;
  }
  function chatLine(it, ctx, h, rm) {
    var _t = tr(ctx), k = it.k;
    var tx = k === 'tx', text = str(it.text);
    // wave 2 (D.2): a hidden line is a bar - never its words, never pickable by ✂️ Clip chat / 🔊 Clip / quotes; the speaker's own
    // (self: 1) shows them their words with "only you can see this"
    // 1.99aht S1: txh = a !transcripts off bar (the server's flag) - its speaker's name or frog name shows, only the words are masked
    var txh = tx && it.txh === 1;
    var mask = /^[sml]$/.test(String(it.mask || '')) ? String(it.mask) : null, mine = it.self === 1 && (!!veilOf(it.u) || txh);
    if (mask && !mine) text = '';
    // 1.99-padppl: folded for a viewer who blocked this NAMED speaker (one direction - the viewer's own list; never a veil or a bar).
    // 1.99-padppl rework: and a FROG-NAMED line the server flagged vb (the viewer blocked that person under a frog name - any frog name)
    var folded = !rm && !mask && (blockedOf(ctx.blk, it.u) || (it.vb === 1 && !!veilOf(it.u) && it.self !== 1));
    var mentionMe = !rm && !mask && !folded && lineMentionsMe(it, ctx);
    var a = { 'class': 'line' + (tx ? ' tx' : '') + (it.u && it.u.self ? ' pepe' : '') + (rm ? ' rm' : '') + (veilOf(it.u) ? ' veiled' : '') + (mask ? ' masked' : '')
      + (folded ? ' is-blocked-fold' : '') + (mentionMe ? ' is-mention' : '') };
    if (tx) a.title = _t('js.pad.chat.tx', 'Said on the mic (auto-transcribed)');
    // 1.99fp: what ✂️ Clip chat / 🔊 Clip read (public/js/chat-clip.js) - the server re-reads its own copy by id
    if (ctx.data !== false) {
      if (rm) { if (it.c) a['data-rmc'] = it.c; a['data-rm'] = rm.by || 'mod'; }
      else if (mask) {
        if (it.c) a['data-vc'] = it.c; if (it.own) a['data-own'] = '1';
        // 1.99aht RV-1 (owner Q6): a !transcripts off bar members may clip carries its 🎙 id (the server sends one only then) - 🔊 Clip
        // reads data-tx; never data-c / data-text (✂️ Clip chat and quotes never pick a bar) and never its words
        if (txh && it.id) a['data-tx'] = it.id;
      }
      else {
        if (it.c) a['data-c'] = it.c;
        a['data-k'] = k; a['data-name'] = label(it.u, ctx); a['data-text'] = mediaOf(it) ? itemText(it) : text;
        if (tx && it.id) a['data-tx'] = it.id;
        if (it.own) a['data-own'] = '1';
      }
      if (it.hold) a['data-hold'] = it.hold;                  // B.3: the live tail places a 🎙 line after its hold's drop
    }
    // The head keeps a reserved line for badges and the clock; words and privacy / moderation notes stay together below.
    // Only names in this compact head need an extra tooltip (the shared roster / mic name nodes stay as they were).
    var nameCtx = Object.assign({}, ctx, { lineHead: true });
    if (mine) nameCtx.self = true;
    var head = [nameNode(it.u, nameCtx, h)], body = [];
    // 1.99aht S1 (owner Q5): the bar's TEXT tag, beside the name (never only an icon) - "transcript hidden"
    if (txh && mask) {
      var txTag = _t('js.pad.veil.tx_hidden', 'transcript hidden');
      head.push(h('span', { 'class': 'veil-tag veil-tx', title: txTag }, [txTag]));
    }
    var fl = flairNode(it.u, ctx, h);
    if (fl) head.push(fl);
    head.push(timeNode(it.ts, ctx, h));
    var marks = hlOf(ctx), media = mediaKids(it, ctx, h, mediaOf(it), mask, rm);
    if (mask && !mine) {
      body.push(h('span', { 'class': 'redact redact-' + mask }, [h('span', { 'class': 'sr-only' },
        [tx ? _t('js.pad.veil.hidden_tx', 'hidden transcript') : _t('js.pad.veil.hidden_msg', 'hidden message')])]));
    } else if (media) body.push.apply(body, media);
    else if (marks) {
      // CL9: a search hit - the matched words in <mark>s (the same text, in pieces)
      if (tx) body.push('\u201c');
      body.push.apply(body, markKids(text, marks, h));
      if (tx) body.push('\u201d');
    } else {
      var mk = !tx && !rm ? mentionKids(text, it.mn, ctx, h) : null;      // 1.99-padppl: @mention chips
      if (mk) body.push.apply(body, mk);
      else body.push(tx ? '\u201c' + text + '\u201d' : text);
    }
    // B.3: when a \ud83c\udf99 line was said, and how long its turn ran ("said 11:53:41")
    // 1.99ajf dockclean (owner point 33x): not when it repeats the line's own time at the head
    if (tx && Number(it.at) > 0 && fmtTime(Number(it.at), ctx) !== fmtTime(it.ts, ctx)) body.push(h('span', { 'class': 'said' }, [_t('js.pad.veil.said', 'said {time}', { time: fmtTime(Number(it.at), ctx) })]));
    if (mine) body.push(h('span', { 'class': 'veil-self' }, [_t('js.pad.veil.only_you', 'only you can see this')]));
    // E.2: a viewer who may see through frog names here (an admin, the pad's owner in their era) gets a Reveal control - a flag only
    if (it.rv === 1 && it.c && ctx.data !== false) body.push(h('button', { type: 'button', 'class': 'veil-reveal', 'data-reveal': it.c }, [_t('js.pad.veil.reveal', 'Reveal')]));
    if (rm) body.push(h('span', { 'class': 'rm-note' }, [removedNote(rm, ctx)]));
    if (folded) {
      body = [h('span', { 'class': 'blk-fold' }, [_t('js.pad.chat.blocked_line', 'A line from someone you blocked'), ' ',
                h('button', { type: 'button', 'class': 'blk-show', 'data-blk-show': '1' }, [_t('js.pad.chat.blocked_show', 'Show')])]),
              h('span', { 'class': 'blk-body', hidden: true }, body)];
    }
    return h('div', a, [avatarNode(it.u, ctx, h), h('div', { 'class': 'body' },
      [h('div', { 'class': 'line-head' }, head), h('div', { 'class': 'line-text' }, body)])]);
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
    var sk = [txt + ' · ' + fmtTime(it.ts, ctx)];
    // wave 2 (E.2): a veiled person's join / leave / mic line - the Reveal control for a viewer who may see through it
    if (it.rv === 1 && it.c && veilOf(it.u) && ctx.data !== false) sk.push(' ', h('button', { type: 'button', 'class': 'veil-reveal', 'data-reveal': it.c }, [tr(ctx)('js.pad.veil.reveal', 'Reveal')]));
    var sa = { 'class': 'sys' + (k === 'topic' ? ' topic' : '') + (veilOf(it.u) ? ' veiled' : '') };
    if (ctx.data !== false && it.hold) sa['data-hold'] = it.hold;     // B.3: a 🎙 line of this hold goes right after it (room-bridge.js)
    return h('div', sa, sk);
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
      // wave 2 (D.4, J-9): a hidden line in a download is "[hidden]" for every role - never its words (1.99aht S1: a !transcripts off
      // bar "[transcript hidden]", under the name it shows)
      var said = /^[sml]$/.test(String(it.mask || '')) ? (k === 'tx' && it.txh === 1 ? '[transcript hidden]' : '[hidden]') : itemText(it);
      body = k === 'tx' ? '\ud83c\udf99 ' + who + ': \u201c' + said + '\u201d' : who + ': ' + said;
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
    // wave 2 (D.4, J-9): {"masked": true, "mask": "m"} for a hidden line - never its words
    if ((k === 'msg' || k === 'tx') && /^[sml]$/.test(String(it.mask || ''))) {
      o.masked = true; o.mask = String(it.mask);
      // (1.99aht S1: a !transcripts off bar - only the words are masked)
      if (k === 'tx' && it.txh === 1) o.transcript_hidden = true;
    }
    else if (k === 'msg' || k === 'tx' || k === 'topic') o.text = k === 'topic' ? str(it.text) : itemText(it);
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
    markKids: markKids, mediaToken: mediaToken, tokenText: tokenText, mediaOf: mediaOf, itemText: itemText,
    domH: domH, htmlH: htmlH, esc: esc, safeLink: safeLink, safeSrc: safeSrc,
    blockedOf: blockedOf, lineMentionsMe: lineMentionsMe, mentionKids: mentionKids
  };
});
