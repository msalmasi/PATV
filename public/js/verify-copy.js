// public/js/verify-copy.js - verifyfix: the Camfrog !verify code box's Copy button (views/partials/account-flash.ejs, on
// Settings -> Account and Edit profile). The owner, 2026-11-08: "when i click the 'copy' button on the verify code it just
// copies the word 'Copy'" - the button wrote the command from an inline onclick, then the click bubbled to crypto-link.js,
// whose document-wide [data-copy] handler copied the button's data-copy ATTRIBUTE (its label) over it. The button now has
// no inline handler and no data-copy: data-verify-copy holds "!verify CODE", data-verify-label / -done / -manual its words.
//   1. navigator.clipboard.writeText (iPhone Chrome / Safari = WebKit, desktop Chrome: inside the tap, so it is allowed)
//   2. refused or missing (an http page, an old browser): a hidden-textarea copy (document.execCommand('copy'))
//   3. that fails too: the "!verify CODE" text is SELECTED, and the button says so - copy it by hand
// "Copied!" (or the manual hint) shows for 2 s, then the label comes back.
(function () {
  'use strict';
  var timers = typeof WeakMap === 'function' ? new WeakMap() : null;
  function say(b, text) {
    b.textContent = text;
    var label = b.getAttribute('data-verify-label') || '';
    var prev = timers && timers.get(b);
    if (prev) clearTimeout(prev);
    var t = setTimeout(function () { b.textContent = label; }, 2000);
    if (timers) timers.set(b, t);
  }
  function legacyCopy(text) {
    var ta = null, ok = false;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0'; ta.style.opacity = '0'; ta.style.fontSize = '16px';   // 16px: no iOS zoom
      document.body.appendChild(ta);
      ta.select();
      if (ta.setSelectionRange) ta.setSelectionRange(0, text.length);
      ok = !!document.execCommand('copy');
    } catch (e) { ok = false; }
    try { if (ta && ta.remove) ta.remove(); else if (ta && ta.parentNode) ta.parentNode.removeChild(ta); } catch (e) { /* gone already */ }
    return ok;
  }
  function selectCommand(b) {
    var wrap = b.closest && b.closest('.verify-code-wrap');
    var cmd = wrap && wrap.querySelector('.verify-cmd');
    if (!cmd) return false;
    try {
      var sel = window.getSelection && window.getSelection();
      var range = document.createRange && document.createRange();
      if (!sel || !range) return false;
      range.selectNodeContents(cmd);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) { return false; }
  }
  function fallback(b, text) {
    if (legacyCopy(text)) return say(b, b.getAttribute('data-verify-done') || '');
    selectCommand(b);
    say(b, b.getAttribute('data-verify-manual') || b.getAttribute('data-verify-label') || '');
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-verify-copy]') : null;
    if (!b) return;
    ev.preventDefault();
    var text = b.getAttribute('data-verify-copy');
    if (!text) return;
    var cb = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    var p = null;
    if (cb && cb.writeText && window.isSecureContext !== false) {
      try { p = cb.writeText(text); } catch (e) { p = null; }
    }
    if (p && typeof p.then === 'function') {
      p.then(function () { say(b, b.getAttribute('data-verify-done') || ''); }, function () { fallback(b, text); });
    } else {
      fallback(b, text);
    }
  });
})();
