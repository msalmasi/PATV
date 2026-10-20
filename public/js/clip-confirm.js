// clip-confirm.js (clipmodal) — the clip confirm card the pad's Live tab uses for BOTH its clips (public/js/chat-clip.js):
//   🔊 mic clip    a 🎙 line's audio: Pepe's free preview, trim, Post (the room's !clip price)
//   ✂️ chat clip   picked chat lines: the server's preview of the quote, title, "also on my profile", Post (the quote price)
// One card, one structure (it is the 🔊 mic clip's card, made reusable - its visible markup is unchanged):
//   .cc-panel  role=region, named by its label ("Mic clip" / "Chat clip"); tabindex=-1 (focus lands here while it loads)
//     loading:           the status line + Cancel
//     div.cc-row         head: <b role=heading aria-level=3 tabindex=-1>title</b> <span.cc-hint>"a free preview, only for you · …"</span>
//     …body            what will be posted (audio + transcript + trim / the quote as the feed shows it + where it goes + title)
//     div.cc-row         actions: the primary (Post to the pad — N PAT / (free) / Can't post…), then the secondary (Discard)
//     div.cc-msg         the rule (who can remove it) or why it can't be posted; errors in .bad
//   error: the status line (.bad) + a Close button; done: .mc-done-box "✅ Clip posted to the pad", View it → / Close and a
//   12 s bar (hovering it, or focus anywhere in it, holds it open).
// Screen readers: every status goes out through ONE polite live region per card that is always rendered (div.cc-sr, next to
// the card, never inside it): a live region inserted or un-hidden with its text already in it is often not read.
// It is an inline card under the chat, not a modal (nothing is trapped; the live chat stays usable while you trim - see
// docs/design-system.md 6.10). One card is open at a time: opening one dismisses the other the way Esc would.
// Keyboard: Esc inside the card presses its Cancel / Discard / Close; Enter in a text field presses the primary. Focus moves
// into the card when it opens from its button (or when that button goes away), to the heading once when the preview is ready
// (only if it was still on the button, in the card or nowhere - never out of the chat box), to the done card's heading when
// you posted from the keyboard (then the card waits for you instead of closing itself), and back to the button that opened it
// (else o.fallback()) when the card closes with focus inside. Everything user-visible goes in via textContent.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var cards = [];
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  // focusable now: connected, not disabled, nothing hidden on the way up, and rendered (CSS display: none, e.g. 🔊 Clip while
  // ✂️ picking, has no boxes)
  function usable(n) {
    if (!n || !n.isConnected || n.disabled) return false;
    for (var x = n; x && x.nodeType === 1; x = x.parentNode) if (x.hidden) return false;
    if (typeof n.getClientRects === 'function' && !n.getClientRects().length) return false;
    return true;
  }
  function focusOn(n) { try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); } }

  /**
   * create(host, {cls, label, fallback}) -> the card (appended to host, hidden). cls: extra class on the .cc-panel; label: the
   * region's name; fallback(): where focus goes back when the button that opened it is gone.
   */
  function create(host, o) {
    o = o || {};
    var box = el('div', 'cc-panel' + (o.cls ? ' ' + o.cls : '')); box.hidden = true;
    box.setAttribute('role', 'region');
    if (o.label) box.setAttribute('aria-label', o.label);
    box.tabIndex = -1;
    host.appendChild(box);
    var sr = el('div', 'cc-sr sr-only'); sr.setAttribute('role', 'status'); sr.setAttribute('aria-live', 'polite'); sr.setAttribute('aria-atomic', 'true');
    host.appendChild(sr);
    var C = { el: box, opener: null, primary: null, secondary: null, heading: null, hintEl: null };
    var pOff = false, busy = false, focused = false, timer = null, keyed = false, viaKeys = false, cancelBtn = null;

    function focusOk() { var a = document.activeElement; return !a || a === document.body || a === C.opener || box.contains(a); }
    function take(n) { if (n && focusOk()) { focusOn(n); return true; } return false; }
    function stop() { clearTimeout(timer); timer = null; }
    function btn(cls, text, esc) { var b = el('button', cls, text); b.type = 'button'; if (esc) b._ccEsc = true; return b; }
    // the live region: the same words twice in a row still get read (a no-break space tells them apart)
    function say(t) { if (t) sr.textContent = sr.textContent === t ? t + '\u00a0' : t; }
    function escBtn() {
      var bs = box.querySelectorAll('button');
      for (var i = bs.length - 1; i >= 0; i--) if (bs[i]._ccEsc && usable(bs[i])) return bs[i];
      return null;
    }
    function dropCancel() { if (cancelBtn) { cancelBtn.remove(); cancelBtn = null; } }

    // Esc -> Cancel / Discard / Close; Enter in a text field -> the primary
    box.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        var b = escBtn();
        if (b) { e.preventDefault(); e.stopPropagation(); b.click(); }
      } else if (e.key === 'Enter' && !e.shiftKey && e.target && e.target.tagName === 'INPUT' && /^(text|search|)$/.test(e.target.type || '')) {
        if (C.primary && usable(C.primary)) { e.preventDefault(); keyed = true; C.primary.click(); keyed = false; }
      }
    });

    /**
     * Show it, loading (a new clip): the status line + Cancel (Esc). opener: the button that opened it (focus goes back there);
     * onCancel: what Cancel does (else close()). Any other open card is dismissed first.
     */
    C.open = function (opener, onCancel) {
      cards.forEach(function (c) { if (c !== C && c.isOpen()) c.dismiss(); });
      stop();
      box.hidden = false; box.textContent = ''; box.classList.remove('mc-done');
      C.primary = C.secondary = C.heading = C.hintEl = null; busy = false; focused = false; viaKeys = false;
      if (opener) C.opener = opener;
      C.status('');
      cancelBtn = btn('cc-btn', _t('js.pad.cc.cancel', 'Cancel'), true);
      cancelBtn.addEventListener('click', function () { if (onCancel) onCancel(); else C.close(); });
      box.appendChild(cancelBtn);
      // focus follows into the card when it was on its button (or nowhere - the button hid itself): Esc and Tab work there
      var a = document.activeElement;
      if (!a || a === document.body || a === C.opener) focusOn(box);
    };
    C.isOpen = function () { return !box.hidden; };
    /** What Esc would do: Cancel / Discard / Close (nothing while it's posting). */
    C.dismiss = function () { var b = escBtn(); if (b) b.click(); };
    /** The status line: kept where it is, or added at the end; read out. */
    C.status = function (t, bad) {
      var s = box.querySelector('.cc-msg');
      if (!s) { s = el('div', 'cc-msg'); box.appendChild(s); }
      s.textContent = t; s.classList.toggle('bad', !!bad);
      say(t);
      return s;
    };
    /** A Close button at the end (after a refusal / an error / a long wait); it replaces the loading Cancel. */
    C.addClose = function (onClose) {
      dropCancel();
      var b = btn('cc-btn', _t('js.pad.snap.close', 'Close'), true);
      b.addEventListener('click', function () { if (onClose) onClose(); else C.close(); });
      box.appendChild(b);
      return b;
    };
    /**
     * The confirm layout: {title, hint, body: [nodes], primary: {text, disabled}, secondary: text, note, bad, onPrimary,
     * onSecondary} -> {primary, secondary, status}. Focus goes to the heading the first time after open().
     */
    C.ready = function (r) {
      stop();
      box.textContent = ''; cancelBtn = null;
      var head = el('div', 'cc-row');
      var h = el('b', null, r.title); h.tabIndex = -1; h.setAttribute('role', 'heading'); h.setAttribute('aria-level', '3');
      C.heading = h;
      head.appendChild(h);
      C.hintEl = el('span', 'cc-hint', r.hint || '');
      head.appendChild(C.hintEl);
      box.appendChild(head);
      (r.body || []).forEach(function (n) { if (n) box.appendChild(n); });
      var row = el('div', 'cc-row');
      var p = btn('cc-btn primary', r.primary.text);
      pOff = !!r.primary.disabled; busy = false;
      p.disabled = pOff;
      var s = btn('cc-btn', r.secondary, true);
      row.appendChild(p); row.appendChild(s); box.appendChild(row);
      C.primary = p; C.secondary = s;
      // pressed from the keyboard (Enter / Space on it: a click with detail 0; Enter in a text field)? the done card then
      // takes focus and waits
      p.addEventListener('click', function (e) { viaKeys = keyed || !!(e && e.detail === 0); });
      var moved = false;
      if (!focused) { focused = true; moved = take(h); }
      var st = C.status(r.note || '', r.bad);
      if (!moved && r.note) say(r.title + ' · ' + r.note);
      if (r.onSecondary) s.addEventListener('click', r.onSecondary);
      if (r.onPrimary) p.addEventListener('click', r.onPrimary);
      return { primary: p, secondary: s, status: st };
    };
    C.hint = function (t) { if (C.hintEl) C.hintEl.textContent = t; };
    /** The primary's label (null keeps it) and whether it can be pressed (once the card isn't busy). */
    C.setPrimary = function (text, disabled) {
      if (!C.primary) return;
      if (text != null) C.primary.textContent = text;
      pOff = !!disabled;
      if (!busy) C.primary.disabled = pOff;
    };
    /** Posting: both buttons off, the status says so. */
    C.busy = function (text) {
      busy = true;
      if (C.primary) C.primary.disabled = true;
      if (C.secondary) C.secondary.disabled = true;
      if (text != null) C.status(text);
    };
    /** Back to the confirm state (after a failed post). */
    C.idle = function () {
      busy = false;
      if (C.primary) C.primary.disabled = pOff;
      if (C.secondary) C.secondary.disabled = false;
    };
    /**
     * Posted: {heading, url, message, ms, onClose} - View it / Close; closes itself after ms (12 s) unless the pointer is on it
     * or focus is in it. Posted from the keyboard: focus goes to its heading, so it waits until you close it or move on.
     */
    C.done = function (d) {
      stop();
      box.textContent = ''; box.classList.add('mc-done'); cancelBtn = null;
      C.primary = C.secondary = null;
      var dbox = el('div', 'mc-done-box');
      var head = d.heading || _t('js.pad.cc.posted', '✅ Clip posted to the pad');
      var h = el('div', 'mc-done-h', head); h.tabIndex = -1; h.setAttribute('role', 'heading'); h.setAttribute('aria-level', '3');
      C.heading = h;
      dbox.appendChild(h);
      if (d.message) dbox.appendChild(el('div', 'cc-msg', d.message));
      var row = el('div', 'cc-row');
      if (d.url) { var a = el('a', 'cc-btn primary', _t('js.pad.cc.view', 'View it →')); a.href = d.url; row.appendChild(a); }
      var x = btn('cc-btn', _t('js.pad.snap.close', 'Close'), true); row.appendChild(x);
      dbox.appendChild(row);
      var bar = el('div', 'mc-done-bar'); var fill = el('i'); bar.appendChild(fill); dbox.appendChild(bar);
      box.appendChild(dbox);
      var ms = d.ms || 12000, left = ms, held = false, inside = false, t0 = Date.now();
      function shut() { stop(); if (d.onClose) d.onClose(); else C.close(); }
      function tick() {
        if (!held && !inside) left -= Date.now() - t0;
        t0 = Date.now();
        fill.style.width = Math.max(0, left / (ms / 100)) + '%';
        if (left <= 0) return shut();
        timer = setTimeout(tick, 200);
      }
      dbox.addEventListener('pointerenter', function () { held = true; });
      dbox.addEventListener('pointerleave', function () { held = false; });
      dbox.addEventListener('focusin', function () { inside = true; });
      dbox.addEventListener('focusout', function (e) { if (!e.relatedTarget || !dbox.contains(e.relatedTarget)) inside = false; });
      x.addEventListener('click', shut);
      tick();
      if (!(viaKeys && take(h))) say(head + (d.message ? ' · ' + d.message : ''));
      else if (d.message) say(d.message);
    };
    /** Hide it. Focus (when it was in the card) goes back to focusTo, else the opener, else o.fallback(). */
    C.close = function (focusTo) {
      var a = document.activeElement, inside = !!a && box.contains(a);
      stop();
      box.hidden = true; box.textContent = ''; box.classList.remove('mc-done');
      C.primary = C.secondary = C.heading = C.hintEl = null; busy = false; cancelBtn = null; viaKeys = false;
      sr.textContent = '';
      if (!inside) return;
      var to = [focusTo, C.opener, o.fallback ? o.fallback() : null].filter(usable)[0];
      if (to) focusOn(to);
    };
    cards.push(C);
    return C;
  }

  window.PATVClipConfirm = { create: create };
})();
