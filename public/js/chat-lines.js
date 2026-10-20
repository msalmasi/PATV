// chat-lines.js - CL6: the ⋯ on each line of the pad chat (views/room.ejs) -> chatlogmod.js (POST /api/rooms/:slug/chatlog/:c/…):
//   ⚑ Report…            any signed-in viewer, on someone else's line: a reason (personal info, harassment, sexual content, a minor,
//                         copyright) + an optional note                                                    -> report
//   🗑 Remove my line      the line's author                                                                -> remove
//   🙈 Hide line…          the pad's owner, its room's mods, PATV staff - with a reason                     -> hide
//   ↩ Show it again        on a hidden line as the owner / staff see it (scrollback)                       -> unhide
//   ⛔ Delete for good…    PATV staff                                                                       -> purge
// What the menu offers comes from the live answer (history.acts: null = nothing - signed out, or the archive is off; lines are
// actioned in the archive). A line that leaves (hidden, removed, deleted) goes from the page at once (opts.onGone); the site also
// lists it in the next answers' `removed` for every other open page. Everything user-visible goes in via textContent. The menu is
// a .ds-pop, the dialogs .ds-scrim.sheet > .ds-modal: focus moves in (and back to the ⋯), Tab stays inside, Esc and a click on the
// scrim close them.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    if (d && typeof d === 'object') d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  function init(o) {
    var feed = o.feed, slug = o.slug;
    // CL8: o.more = other containers of lines (scrollback's older lines, the offline 📜 card); o.scroller = what scrolls (the menu
    // closes when it does) - the live log itself no longer scrolls, its scroller does
    var boxes = [feed].concat(o.more || []).filter(Boolean), scroller = o.scroller || feed;
    function all(sel) { var out = []; boxes.forEach(function (b) { out = out.concat(Array.prototype.slice.call(b.querySelectorAll(sel))); }); return out; }
    // the menu and the dialogs live in a .chatlog box of their own in <body> (out of the pad page's heading / button styles;
    // public/css/chatlog.css is scoped to .chatlog)
    var scope = el('div', 'chatlog la-host');
    document.body.appendChild(scope);
    var api0 = '/api/rooms/' + encodeURIComponent(slug) + '/chatlog/';
    var acts = null, actsKey = '', pop = null, dlg = null, toasts = null;

    // CL6 fix-up: a refusal in the viewer's language - its `code` picks the words (the server's English `error` is the fallback)
    var ERR = {
      not_found: function () { return _t('js.pad.chat.err.not_found', 'That line isn’t available.'); },
      signin: function () { return _t('js.pad.chat.err.signin', 'Sign in first.'); },
      archived: function () { return _t('js.pad.chat.err.archived', 'This account is archived.'); },
      forbidden: function () { return _t('js.pad.chat.err.forbidden', 'You can’t do that on this line.'); },
      rate: function (d) { return d && d.retry ? _t('js.pad.chat.err.rate_in', 'Slow down — try again in {n} s.', { n: d.retry }) : _t('js.pad.chat.err.rate', 'You’ve done that a lot — try again later.'); },
      rate_day: function () { return _t('js.pad.chat.err.rate_day', 'You’ve hit today’s report limit.'); },
      paused: function () { return _t('js.pad.chat.err.paused', 'You can’t report right now.'); },
      own: function () { return _t('js.pad.chat.err.own', 'That’s your own line — you can remove it instead.'); },
      bad_reason: function () { return _t('js.pad.chat.err.bad_reason', 'Pick a reason.'); },
      why: function () { return _t('js.pad.chat.err.why', 'Say why (the pad’s owner and staff see it).'); },
      too_late: function () { return _t('js.pad.chat.err.too_late', 'It was hidden more than 30 days ago — its text is gone.'); },
      held: function () { return _t('js.pad.chat.err.held', 'A legal hold covers this line.'); }
    };
    function post(c, what, body) {
      return fetch(api0 + encodeURIComponent(c) + '/' + what, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
        .then(function (r) {
          return r.json().catch(function () { return { ok: false }; }).then(function (d) {
            if (!r.ok || !d || d.ok === false) {
              var code = d && d.code, msg = code && ERR[code] ? ERR[code](d) : (d && d.error);
              var e = new Error(msg || _t('js.pad.chat.act_failed', 'That didn’t work — try again.'));
              e.code = code; throw e;
            }
            return d;
          });
        }, function () { throw new Error(_t('js.pad.chat.act_failed', 'That didn’t work — try again.')); });
    }
    function toast(text, kind) {
      if (!toasts || !toasts.isConnected) { toasts = el('div', 'ds-toasts'); toasts.setAttribute('aria-live', 'polite'); document.body.appendChild(toasts); }
      var t = el('div', 'ds-toast' + (kind ? ' ' + kind : ''), text);
      toasts.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4000);
    }
    function jc() { try { return typeof o.jc === 'function' ? o.jc() || null : null; } catch (e) { return null; } }
    function gone(c) { try { if (typeof o.onGone === 'function') o.onGone(Number(c)); } catch (e) { /* the page drops it at the next answer anyway */ } }

    // ── which lines get a ⋯, and what it offers ──
    function cOf(n) { return n.getAttribute('data-c') || n.getAttribute('data-rmc'); }
    function itemsFor(n) {
      var out = [];
      if (!acts) return out;
      var rm = n.getAttribute('data-rm');
      if (n.hasAttribute('data-rmc')) {
        // (a moderator's hide: whoever may hide; a staff or report hide: staff only - CL6 fix-up: never offered where it's refused)
        if (acts.hide && rm !== 'purged' && rm !== 'self' && (rm === 'mod' || acts.purge)) out.push({ id: 'unhide', label: _t('js.pad.chat.unhide', '↩ Show it again') });
        if (acts.purge && rm !== 'purged') out.push({ id: 'purge', label: _t('js.pad.chat.purge', '⛔ Delete for good…'), danger: true });
        return out;
      }
      if (n.getAttribute('data-own') === '1') out.push({ id: 'remove', label: _t('js.pad.chat.remove_mine', '🗑 Remove my line') });
      else if (acts.report) out.push({ id: 'report', label: _t('js.pad.chat.report', '⚑ Report…') });
      if (acts.hide) out.push({ id: 'hide', label: _t('js.pad.chat.hide', '🙈 Hide line…') });
      if (acts.purge) out.push({ id: 'purge', label: _t('js.pad.chat.purge', '⛔ Delete for good…'), danger: true });
      return out;
    }
    function decorate(nodes) {
      if (!acts) return;
      nodes.forEach(function (n) {
        if (!n || n.nodeType !== 1 || !n.classList.contains('line') && !n.hasAttribute('data-rmc')) return;
        if (!cOf(n) || n.querySelector('.la-btn') || !itemsFor(n).length) return;
        var b = el('button', 'la-btn', '⋯');
        b.type = 'button';
        b.setAttribute('aria-label', _t('js.pad.chat.acts', 'Actions for this line'));
        b.title = b.getAttribute('aria-label');
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', 'false');
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (pop && pop._btn === b) closeMenu(true); else openMenu(n, b); });
        n.classList.add('la');
        n.appendChild(b);
      });
    }
    function strip() {
      all('.la-btn').forEach(function (b) { if (b.parentNode) { b.parentNode.classList.remove('la'); b.parentNode.removeChild(b); } });
    }

    // ── the menu ──
    function closeMenu(refocus) {
      if (!pop) return;
      var p = pop; pop = null;
      document.removeEventListener('pointerdown', p._outside, true);
      document.removeEventListener('keydown', p._keys, true);
      window.removeEventListener('resize', p._shut);
      scroller.removeEventListener('scroll', p._shut);
      if (p.parentNode) p.parentNode.removeChild(p);
      if (p._btn) p._btn.setAttribute('aria-expanded', 'false');
      if (refocus && p._btn && p._btn.isConnected) p._btn.focus();
    }
    function openMenu(n, b) {
      closeMenu(false);
      var items = itemsFor(n);
      if (!items.length) return;
      var p = el('div', 'ds-pop la-pop');
      p.setAttribute('role', 'menu');
      p.setAttribute('aria-label', _t('js.pad.chat.acts', 'Actions for this line'));
      p.style.position = 'fixed';
      p._btn = b;
      items.forEach(function (it) {
        var mi = el('button', 'ds-menu-item' + (it.danger ? ' danger' : ''), it.label);
        mi.type = 'button'; mi.setAttribute('role', 'menuitem'); mi.tabIndex = -1;
        mi.addEventListener('click', function (e) { e.preventDefault(); closeMenu(false); run(it.id, n, b); });
        p.appendChild(mi);
      });
      scope.appendChild(p);
      var r = b.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight;
      var vw = document.documentElement.clientWidth, vh = window.innerHeight;
      var top = r.bottom + 6;
      if (top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
      p.style.left = Math.max(8, Math.min(r.right - w, vw - w - 8)) + 'px';
      p.style.top = Math.max(8, top) + 'px';
      b.setAttribute('aria-expanded', 'true');
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
      p._outside = function (e) { if (pop === p && !p.contains(e.target) && e.target !== b) closeMenu(false); };
      p._shut = function () { closeMenu(false); };
      document.addEventListener('keydown', p._keys, true);
      document.addEventListener('pointerdown', p._outside, true);
      window.addEventListener('resize', p._shut);
      scroller.addEventListener('scroll', p._shut);
      focusAt(0);
    }

    // ── the dialogs ──
    function closeDlg() {
      if (!dlg) return;
      var d = dlg; dlg = null;
      document.removeEventListener('keydown', d._keys, true);
      if (d.scrim.parentNode) d.scrim.parentNode.removeChild(d.scrim);
      var back = d.opener && d.opener.isConnected ? d.opener : scroller;
      try { back.focus(); } catch (e) { /* gone */ }
    }
    /** A short form in a modal: title, body nodes, a primary button. ok(done(msg?)) runs the action; a refusal stays in the modal. */
    function dialog(opener, title, body, okLabel, danger, ok) {
      closeDlg();
      var scrim = el('div', 'ds-scrim sheet');
      var m = el('div', 'ds-modal la-modal');
      var hid = 'laDlg' + Date.now();
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', hid);
      var hd = el('div', 'ds-modal-h'), h2 = el('h2', null, title);
      h2.id = hid;
      var x = el('button', 'ds-close', '×'); x.type = 'button'; x.setAttribute('aria-label', _t('js.pad.chat.close', 'Close'));
      x.addEventListener('click', closeDlg);
      hd.appendChild(h2); hd.appendChild(x); m.appendChild(hd);
      body.forEach(function (n) { m.appendChild(n); });
      var msg = el('p', 'la-msg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
      m.appendChild(msg);
      var ft = el('div', 'ds-modal-f');
      var cancel = el('button', 'ds-btn ghost sm', _t('js.pad.chat.cancel', 'Cancel')); cancel.type = 'button';
      cancel.addEventListener('click', closeDlg);
      var go = el('button', 'ds-btn sm' + (danger ? ' danger' : ''), okLabel); go.type = 'button';
      ft.appendChild(cancel); ft.appendChild(go); m.appendChild(ft);
      scrim.appendChild(m);
      scrim.addEventListener('click', function (e) { if (e.target === scrim) closeDlg(); });
      go.addEventListener('click', function () {
        go.disabled = true; msg.textContent = '';
        ok().then(function () { closeDlg(); }, function (e) { go.disabled = false; msg.textContent = e && e.message ? e.message : _t('js.pad.chat.act_failed', 'That didn’t work — try again.'); });
      });
      var d = { scrim: scrim, opener: opener, go: go };
      d._keys = function (e) {
        if (dlg !== d) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDlg(); return; }
        if (e.key !== 'Tab') return;
        var f = Array.prototype.filter.call(m.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null || n === document.activeElement; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      };
      document.addEventListener('keydown', d._keys, true);
      scope.appendChild(scrim);
      dlg = d;
      var firstField = m.querySelector('input, textarea');
      (firstField || go).focus();
      return d;
    }
    function field(labelText, input, hint) {
      var f = el('div', 'ds-field');
      var id = 'laF' + Math.random().toString(36).slice(2, 8);
      input.id = id;
      var l = el('label', 'ds-label', labelText); l.htmlFor = id;
      f.appendChild(l); f.appendChild(input);
      if (hint) f.appendChild(el('span', 'ds-hint', hint));
      return f;
    }

    // ── the actions ──
    var REASONS = [
      ['info', function () { return _t('js.pad.chat.report_info', 'Personal info / doxxing'); }],
      ['harassment', function () { return _t('js.pad.chat.report_harassment', 'Harassment'); }],
      ['sexual', function () { return _t('js.pad.chat.report_sexual', 'Sexual content'); }],
      ['minor', function () { return _t('js.pad.chat.report_minor', 'Involves a minor'); }, function () { return _t('js.pad.chat.report_minor_hint', 'It’s hidden at once and goes straight to PATV’s admins.'); }],
      ['copyright', function () { return _t('js.pad.chat.report_copyright', 'Copyright'); }, function () { return _t('js.pad.chat.report_copyright_hint', 'Goes to PATV’s admins only.'); }],
    ];
    function run(id, n, b) {
      var c = cOf(n);
      if (!c) return;
      if (id === 'report') {
        var fs = el('fieldset', 'la-reasons');
        fs.appendChild(el('legend', 'ds-label', _t('js.pad.chat.report_why', 'What’s wrong with it?')));
        var pick = null;
        REASONS.forEach(function (r) {
          var lab = el('label'), rb = el('input');
          rb.type = 'radio'; rb.name = 'laReason'; rb.value = r[0];
          rb.addEventListener('change', function () { pick = r[0]; D.go.disabled = false; });
          var tx = el('span', null, r[1]());
          if (r[2]) tx.appendChild(el('small', null, r[2]()));
          lab.appendChild(rb); lab.appendChild(tx); fs.appendChild(lab);
        });
        var note = el('textarea', 'ds-textarea'); note.maxLength = 500; note.rows = 3;
        var D = dialog(b, _t('js.pad.chat.report_h', 'Report this line'), [fs, field(_t('js.pad.chat.report_note', 'Anything else we should know? (optional)'), note)],
          _t('js.pad.chat.report_send', 'Send report'), false, function () {
            return post(c, 'report', { reason: pick, note: note.value.trim(), jc: jc() }).then(function (d) {
              if (d.already) return toast(_t('js.pad.chat.report_already', 'You already reported this line.'));
              if (d.hidden) gone(c);
              toast(d.hidden ? _t('js.pad.chat.report_urgent', 'Reported and hidden — PATV’s admins will review it now.')
                : d.admins_only ? _t('js.pad.chat.report_sent_admin', 'Reported — thanks. PATV’s admins will look at it.')
                : _t('js.pad.chat.report_sent', 'Reported — thanks. The pad’s owner and PATV’s admins will look at it.'), 'ok');
            });
          });
        D.go.disabled = true;
        var first = fs.querySelector('input'); if (first) first.focus();
        return;
      }
      if (id === 'remove') {
        dialog(b, _t('js.pad.chat.remove_h', 'Remove your line?'), [el('p', null, _t('js.pad.chat.remove_text', 'It’s left out of this pad’s chat for everyone now — the pad’s owner sees only that you removed a line, never what it said. PATV staff can still read it for 30 days in case it was reported; then its text is deleted. The Camfrog room already saw it, and copies people downloaded keep it.'))],
          _t('js.pad.chat.remove_go', 'Remove it'), true, function () {
            return post(c, 'remove', { jc: jc() }).then(function () { gone(c); toast(_t('js.pad.chat.removed_done', 'Your line was removed.'), 'ok'); });
          });
        return;
      }
      if (id === 'hide') {
        var why = el('input', 'ds-in'); why.type = 'text'; why.maxLength = 200; why.autocomplete = 'off';
        var H = dialog(b, _t('js.pad.chat.hide_h', 'Hide this line?'), [el('p', null, _t('js.pad.chat.hide_text', 'It’s left out for everyone now. For 30 days the pad’s owner and PATV staff can still read it (and show it again), then its text is deleted. The Camfrog room already saw it.')),
          field(_t('js.pad.chat.hide_why', 'Reason (the pad’s owner and staff see it)'), why)],
          _t('js.pad.chat.hide_go', 'Hide it'), true, function () {
            return post(c, 'hide', { why: why.value.trim(), jc: jc() }).then(function () { gone(c); toast(_t('js.pad.chat.hidden_done', 'Line hidden.'), 'ok'); });
          });
        H.go.disabled = true;
        why.addEventListener('input', function () { H.go.disabled = why.value.trim().length < 2; });
        return;
      }
      if (id === 'unhide') {
        post(c, 'unhide', {}).then(function () { if (n.parentNode) n.parentNode.removeChild(n); toast(_t('js.pad.chat.unhidden_done', 'The line is back.'), 'ok'); },
          function (e) { toast(e.message, 'danger'); });
        return;
      }
      if (id === 'purge') {
        var pn = el('input', 'ds-in'); pn.type = 'text'; pn.maxLength = 200; pn.autocomplete = 'off';
        dialog(b, _t('js.pad.chat.purge_h', 'Delete this line for good?'), [el('p', null, _t('js.pad.chat.purge_text', 'Its words and the speaker’s name are wiped at once — here, in quotes, mic clips and mention alerts, and Pepe’s !log skips it (only a one-way hash of the login stays, for that). Backups keep it until they expire. This can’t be undone.')),
          field(_t('js.pad.chat.purge_why', 'Note for the audit log (optional)'), pn)],
          _t('js.pad.chat.purge_go', 'Delete for good'), true, function () {
            return post(c, 'purge', { why: pn.value.trim() }).then(function () { gone(c); if (n.parentNode && n.hasAttribute('data-rmc')) n.parentNode.removeChild(n); toast(_t('js.pad.chat.purged_done', 'Deleted.'), 'ok'); });
          });
      }
    }

    var mo = new MutationObserver(function (ms) {
      if (!acts) return;
      var add = [];
      ms.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (x) { if (x.nodeType === 1) add.push(x); }); });
      if (add.length) decorate(add);
    });
    boxes.forEach(function (b) { mo.observe(b, { childList: true }); });

    return {
      /** Each live answer: what this viewer may do here (history.acts). */
      update: function (d) {
        if (!d || !d.history) return;
        var a = d.history.acts || null, key = a ? [a.report, a.hide, a.purge].join('') : '';
        if (key === actsKey) return;
        actsKey = key; acts = a;
        closeMenu(false);
        strip();
        if (acts) decorate(all('.line, [data-rmc]'));
      },
      _items: itemsFor, _run: run,
    };
  }
  window.PATVChatLines = { init: init };
})();
