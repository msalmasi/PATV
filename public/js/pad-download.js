// pad-download.js - CL10: ⬇ Download chat log (the chat-history spec §2.4, §3.14) -> chatlogexport.js
// (POST /api/rooms/:slug/chatlog/export, then GET /p/:slug/chatlog/dl/:token). Plain ES5, no dependencies.
//
// The ⋯ in the chat card's heading opens a menu with "⬇ Download chat log…" - while the history block says this viewer may ask for
// a file here (history.dl: signed in, history allowed, the pad allows downloads or they own it / are staff, chatlog.downloads on);
// a signed-out viewer of a pad that allows downloads gets "⬇ Sign in to download the chat log" instead (history.dl_signin). The
// dialog: the range (Today, Last 24 hours, Last 7 days, Custom from / to - dates in the downloader's own time zone, which the
// server uses: their account zone, else the patv_tz cookie, else UTC), the format (Web page .html / Text .txt / Data .jsonl), "Include
// joins, leaves and mic" (only the last 24 hours unless this viewer has full history - history.dl_full) and the copy notice. The
// file is made by the server and handed over as a download (a single-use link, good for 2 minutes); the dialog closes and says how
// big it will be. Refusals stay in the dialog (established accounts only, the pad's switch, 10 a day, busy). Everything
// user-visible goes in via textContent. The menu is a .ds-pop, the dialog .ds-scrim.sheet > .ds-modal: focus moves in (and back
// to the ⋯), Tab stays inside, Esc and a click on the scrim close them.
// CL10 fix-up: Custom takes an optional time with each date (a file cut inside a day - 50,000 lines, or 31 days not at midnight -
// says where the next one starts, and this is how it's continued). A link the server refuses (expired or used, busy, the pad's
// gates) sends the browser back to the pad with ?cldl=<code>: this script says why in a toast, in the page's language, and takes
// the code out of the address.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    if (d && typeof d === 'object') d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  var uid = 0;
  function pad2(n) { return ('0' + n).slice(-2); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtN(n) { try { return Number(n).toLocaleString(document.documentElement.lang || undefined); } catch (e) { return String(n); } }

  // what the server's refusal codes say, in the page's language
  function refusal(code, status) {
    switch (code) {
      case 'established': return _t('js.pad.dl.established', 'Downloads need an established account: reach level 2, or link your Camfrog, Discord or Twitch account.');
      case 'off_pad': return _t('js.pad.dl.off_pad', 'This pad doesn’t allow downloads of its chat.');
      case 'no_history': case 'not_found': return _t('js.pad.dl.no_history', 'This pad’s chat history isn’t available to you.');
      case 'limit_day': return _t('js.pad.dl.limit_day', 'That’s 10 chat-log downloads in a day — try again tomorrow.');
      case 'busy': return _t('js.pad.dl.busy', 'Too many chat logs are being made right now — try again in a minute.');
      case 'busy_me': return _t('js.pad.dl.busy_me', 'Your other download is still being made — try again when it’s done.');
      case 'gone': return _t('js.pad.dl.gone', 'That download link has expired or was already used — start a new one from the chat’s ⋯ menu.');
      case 'file_failed': return _t('js.pad.dl.file_failed', 'Couldn’t make the file — try again.');
      case 'off': return _t('js.pad.dl.off', 'Chat downloads aren’t available here right now.');
      case 'rate': return _t('js.pad.dl.slow', 'Slow down — try again in a minute.');
      case 'bad_range': return _t('js.pad.dl.bad_range', 'Pick a start date on or before the end date.');
      case 'signin': return _t('js.pad.dl.signin_first', 'Sign in to download this pad’s chat.');
      default: return status === 429 ? _t('js.pad.dl.slow', 'Slow down — try again in a minute.') : _t('js.pad.dl.failed', 'Couldn’t start the download — try again.');
    }
  }

  var toasts = null;
  function toast(text, kind) {
    if (!toasts || !toasts.isConnected) { toasts = el('div', 'ds-toasts'); toasts.setAttribute('aria-live', 'polite'); document.body.appendChild(toasts); }
    var t = el('div', 'ds-toast' + (kind ? ' ' + kind : ''), text);
    toasts.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 8000);
  }
  // a refused download link came back here (chatlogexport.js backTo: 303 /p/<slug>?cldl=<code>)
  var NOTE_CODES = { gone: 1, signin: 1, off: 1, rate: 1, busy: 1, busy_me: 1, no_history: 1, off_pad: 1, established: 1, not_found: 1, failed: 1 };
  function notice() {
    var m = /[?&]cldl=([a-z_]{1,20})(?:&|$)/.exec(location.search || '');
    if (!m || !NOTE_CODES[m[1]]) return;
    try {
      var q = location.search.replace(/([?&])cldl=[^&]*(&|$)/, function (s, a, b) { return b ? a : ''; });
      if (q === '?') q = '';
      history.replaceState(history.state, '', location.pathname + q + location.hash);
    } catch (e) { /* the address keeps it */ }
    toast(refusal(m[1] === 'failed' ? 'file_failed' : m[1], 0), 'warn');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notice); else notice();

  /**
   * o: {slug, btn (the ⋯ in the chat heading), hist() -> the history block (dl, dl_signin, dl_full), tz (the zone the server dates
   *     in: the page's res.locals.tz), signin (the sign-in address)}
   */
  function init(o) {
    var btn = o.btn, slug = o.slug;
    if (!btn) return null;
    var api = '/api/rooms/' + encodeURIComponent(slug) + '/chatlog/export';
    var scope = el('div', 'chatlog la-host');        // the menu and the dialog: a .chatlog box of their own (public/css/chatlog.css)
    document.body.appendChild(scope);
    var pop = null, dlg = null;
    function H() { try { return typeof o.hist === 'function' ? o.hist() || null : null; } catch (e) { return null; } }

    // ── the ⋯ menu ──
    function items() {
      var h = H(), out = [];
      if (h && h.dl) out.push({ id: 'dl', label: _t('js.pad.dl.menu', '⬇ Download chat log…') });
      else if (h && h.dl_signin) out.push({ id: 'signin', label: _t('js.pad.dl.signin', '⬇ Sign in to download the chat log') });
      return out;
    }
    function closeMenu(refocus) {
      if (!pop) return;
      var p = pop; pop = null;
      document.removeEventListener('pointerdown', p._outside, true);
      document.removeEventListener('keydown', p._keys, true);
      window.removeEventListener('resize', p._shut);
      if (p.parentNode) p.parentNode.removeChild(p);
      btn.setAttribute('aria-expanded', 'false');
      if (refocus && btn.isConnected) btn.focus();
    }
    function openMenu() {
      closeMenu(false);
      var list = items();
      if (!list.length) return;
      var p = el('div', 'ds-pop la-pop');
      p.setAttribute('role', 'menu');
      p.setAttribute('aria-label', _t('js.pad.dl.more', 'More chat options'));
      p.style.position = 'fixed';
      list.forEach(function (it) {
        var mi = el('button', 'ds-menu-item', it.label);
        mi.type = 'button'; mi.setAttribute('role', 'menuitem'); mi.tabIndex = -1;
        mi.addEventListener('click', function (e) { e.preventDefault(); closeMenu(false); run(it.id); });
        p.appendChild(mi);
      });
      scope.appendChild(p);
      var r = btn.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
      var vw = document.documentElement.clientWidth, vh = window.innerHeight;
      var top = r.bottom + 6;
      if (top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
      p.style.left = Math.max(8, Math.min(r.right - w, vw - w - 8)) + 'px';
      p.style.top = Math.max(8, top) + 'px';
      btn.setAttribute('aria-expanded', 'true');
      pop = p;
      function els() { return Array.prototype.slice.call(p.querySelectorAll('[role="menuitem"]')); }
      function focusAt(i) { var bs = els(); if (bs.length) bs[(i + bs.length) % bs.length].focus(); }
      p._keys = function (e) {
        if (pop !== p) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
        if (e.key === 'Tab') { closeMenu(false); return; }
        var bs = els(), i = bs.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i < 0 ? -1 : i - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
        else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
      };
      p._outside = function (e) { if (pop === p && !p.contains(e.target) && e.target !== btn) closeMenu(false); };
      p._shut = function () { closeMenu(false); };
      document.addEventListener('keydown', p._keys, true);
      document.addEventListener('pointerdown', p._outside, true);
      window.addEventListener('resize', p._shut);
      focusAt(0);
    }
    function run(id) {
      if (id === 'signin') { location.href = o.signin || ('/login?next=' + encodeURIComponent(location.pathname)); return; }
      if (id === 'dl') openDialog();
    }

    // ── the dialog ──
    function closeDlg() {
      if (!dlg) return;
      var d = dlg; dlg = null;
      document.removeEventListener('keydown', d._keys, true);
      if (d.scrim.parentNode) d.scrim.parentNode.removeChild(d.scrim);
      try { if (btn.isConnected && !btn.hidden) btn.focus(); } catch (e) { /* gone */ }
    }
    function radios(name, legend, opts, picked) {
      var fs = el('fieldset', 'la-reasons cldl-opts');
      fs.appendChild(el('legend', 'ds-label', legend));
      opts.forEach(function (op) {
        var lab = el('label');
        var r = el('input'); r.type = 'radio'; r.name = name; r.value = op.v; r.checked = op.v === picked;
        var txt = el('span', null, op.label);
        if (op.hint) txt.appendChild(el('small', null, op.hint));
        lab.appendChild(r); lab.appendChild(txt); fs.appendChild(lab);
      });
      return fs;
    }
    function picked(fs) { var r = fs.querySelector('input:checked'); return r ? r.value : null; }
    // a date and an optional time (blank: From starts at 00:00, To runs to the end of its day)
    function dateField(labelText, value, timeLabel) {
      var f = el('div', 'cldl-date'), lab = el('span', null, labelText);
      lab.id = 'cldlD' + (++uid);
      f.setAttribute('role', 'group'); f.setAttribute('aria-labelledby', lab.id);
      var row = el('div', 'cldl-dt');
      var i = el('input', 'ds-in'); i.type = 'date'; i.value = value; i.max = ymd(new Date()); i.setAttribute('aria-label', labelText);
      var tm = el('input', 'ds-in cldl-time'); tm.type = 'time'; tm.step = '60'; tm.setAttribute('aria-label', timeLabel);
      row.appendChild(i); row.appendChild(tm);
      f.appendChild(lab); f.appendChild(row);
      return { box: f, input: i, time: tm };
    }
    function openDialog() {
      closeDlg();
      var h = H() || {};
      var n = ++uid;
      var scrim = el('div', 'ds-scrim sheet');
      var m = el('div', 'ds-modal la-modal cldl');
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'cldlH' + n);
      var hd = el('div', 'ds-modal-h'), h2 = el('h2', null, _t('js.pad.dl.title', 'Download chat log'));
      h2.id = 'cldlH' + n;
      var x = el('button', 'ds-close', '×'); x.type = 'button'; x.setAttribute('aria-label', _t('js.pad.chat.close', 'Close'));
      x.addEventListener('click', closeDlg);
      hd.appendChild(h2); hd.appendChild(x); m.appendChild(hd);

      var range = radios('cldlR' + n, _t('js.pad.dl.range', 'Range'), [
        { v: 'today', label: _t('js.pad.dl.range_today', 'Today') }, { v: '24h', label: _t('js.pad.dl.range_24h', 'Last 24 hours') },
        { v: '7d', label: _t('js.pad.dl.range_7d', 'Last 7 days') }, { v: 'custom', label: _t('js.pad.dl.range_custom', 'Custom') }], '24h');
      var now = new Date(), wk = new Date(now.getTime() - 6 * 864e5);
      var from = dateField(_t('js.pad.dl.from', 'From'), ymd(wk), _t('js.pad.dl.from_time', 'From time'));
      var to = dateField(_t('js.pad.dl.to', 'To'), ymd(now), _t('js.pad.dl.to_time', 'To time'));
      var dates = el('div', 'cldl-dates'); dates.appendChild(from.box); dates.appendChild(to.box);
      dates.appendChild(el('p', 'ds-hint cldl-hint', _t('js.pad.dl.time_hint', 'Times are optional: From starts at 00:00 and To runs to the end of its day.')));
      dates.hidden = true;
      range.appendChild(dates);
      range.addEventListener('change', function () { dates.hidden = picked(range) !== 'custom'; });
      var zone = o.tz ? _t('js.pad.dl.zone', 'Dates and times in {zone}.', { zone: String(o.tz).replace(/_/g, ' ') }) + ' ' : '';
      range.appendChild(el('p', 'ds-hint cldl-hint', zone + _t('js.pad.dl.max', 'At most 31 days and 50,000 lines per file — a longer range is cut there, and the file says where to continue.')));
      m.appendChild(range);

      var fmt = radios('cldlF' + n, _t('js.pad.dl.fmt', 'Format'), [
        { v: 'html', label: _t('js.pad.dl.fmt_html', 'Web page (.html)'), hint: _t('js.pad.dl.fmt_html_hint', 'Looks like the pad chat and opens offline') },
        { v: 'txt', label: _t('js.pad.dl.fmt_txt', 'Text (.txt)'), hint: _t('js.pad.dl.fmt_txt_hint', 'One line per item') },
        { v: 'jsonl', label: _t('js.pad.dl.fmt_jsonl', 'Data (.jsonl)'), hint: _t('js.pad.dl.fmt_jsonl_hint', 'For tools') }], 'html');
      m.appendChild(fmt);

      var sysBox = el('label', 'cldl-chk');
      var sys = el('input'); sys.type = 'checkbox';
      var sysTxt = el('span', null, _t('js.pad.dl.sys', 'Include joins, leaves and mic'));
      if (!h.dl_full) sysTxt.appendChild(el('small', null, _t('js.pad.dl.sys_24h', 'Only from the last 24 hours.')));
      sysBox.appendChild(sys); sysBox.appendChild(sysTxt);
      m.appendChild(sysBox);
      m.appendChild(el('p', 'ds-note cldl-notice', _t('js.pad.dl.notice', 'The file names you as the person who downloaded it, and it’s a copy: later removals and privacy changes can’t reach it.')));

      var msg = el('p', 'la-msg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
      m.appendChild(msg);
      var ft = el('div', 'ds-modal-f');
      var cancel = el('button', 'ds-btn ghost sm', _t('js.pad.chat.cancel', 'Cancel')); cancel.type = 'button';
      cancel.addEventListener('click', closeDlg);
      var go = el('button', 'ds-btn sm', _t('js.pad.dl.go', '⬇ Download')); go.type = 'button';
      ft.appendChild(cancel); ft.appendChild(go); m.appendChild(ft);
      scrim.appendChild(m);
      scrim.addEventListener('click', function (e) { if (e.target === scrim) closeDlg(); });

      go.addEventListener('click', function () {
        var r = picked(range) || '24h';
        var body = { range: r, fmt: picked(fmt) || 'html', sys: !!sys.checked };
        if (r === 'custom') {
          var fd = from.input.value, td = to.input.value, ft = String(from.time.value || '').slice(0, 5), tt = String(to.time.value || '').slice(0, 5);
          if (!fd || !td || fd > td || (fd === td && ft && tt && ft >= tt)) { msg.textContent = refusal('bad_range'); return; }
          body.from = fd + (ft ? 'T' + ft : ''); body.to = td + (tt ? 'T' + tt : '');
        }
        go.disabled = true; msg.textContent = _t('js.pad.dl.preparing', 'Preparing your file…');
        fetch(api, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
          .then(function (res) {
            return res.json().catch(function () { return { ok: false }; }).then(function (d) {
              if (!res.ok || !d || !d.ok || typeof d.url !== 'string' || d.url.charAt(0) !== '/') {
                if (d && d.code === 'signin') { location.href = o.signin || ('/login?next=' + encodeURIComponent(location.pathname)); return; }
                go.disabled = false; msg.textContent = refusal(d && d.code, res.status); return;
              }
              // the file: a same-origin link the server answers with an attachment (the page stays where it is)
              var a = el('a'); a.href = d.url; a.rel = 'nofollow'; a.style.display = 'none';
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              // the estimate is exactly what the file will hold (nulls when the site is busy counting)
              var est = d.estimate || {};
              var say = est.more ? _t('js.pad.dl.started_more', 'Your download is starting. This range has more than 50,000 lines, so the file stops there and says where to continue.')
                : est.lines == null ? _t('js.pad.dl.started_plain', 'Your download is starting.')
                : Number(est.lines) === 0 ? _t('js.pad.dl.started_none', 'Your download is starting — there are no lines in this range that you can see.')
                : _t('js.pad.dl.started', 'Your download is starting (up to {n} lines).', { n: fmtN(Number(est.lines) || 0) });
              if (d.cut && d.cut.next) {
                var when = '';
                try { when = new Date(Number(d.cut.next)).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
                catch (e) { when = new Date(Number(d.cut.next)).toISOString().slice(0, 16).replace('T', ' '); }
                say += ' ' + _t('js.pad.dl.cut', 'Only 31 days fit in one file: this one ends {when}, and it says where to continue.', { when: when });
              }
              closeDlg();
              toast(say);
            });
          }, function () { go.disabled = false; msg.textContent = refusal(null, 0); });
      });
      var d = { scrim: scrim };
      d._keys = function (e) {
        if (dlg !== d) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDlg(); return; }
        if (e.key !== 'Tab') return;
        var f = Array.prototype.filter.call(m.querySelectorAll(FOCUSABLE), function (q) { return q.offsetParent !== null || q === document.activeElement; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', d._keys, true);
      scope.appendChild(scrim);
      dlg = d;
      var first = range.querySelector('input:checked') || go;
      first.focus();
    }

    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function (e) { e.preventDefault(); if (pop) closeMenu(true); else openMenu(); });
    function update() {
      var ok = items().length > 0;
      btn.hidden = !ok;
      if (!ok) { closeMenu(false); closeDlg(); }
    }
    update();
    return { update: update, open: openDialog, close: function () { closeMenu(false); closeDlg(); }, _items: items };
  }
  window.PATVPadDownload = { init: init };
})();
