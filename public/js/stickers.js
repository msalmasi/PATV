/* stickers.js — the 🧸 sticker picker (1.99iw, stickers.js on the server).
   Any <button data-sticker-picker="<textarea selector>"> opens a small panel of the stickers the signed-in account
   owns; picking one puts its [sticker:<pack>/<id>] token at the caret (an "input" event follows, so drafts and
   auto-grow keep working). The server turns tokens into pictures when it renders messages and posts. */
(function () {
  'use strict';
  var data = null, loading = null, panel = null, owner = null;
  function css() {
    if (document.getElementById('stkCss')) return;
    var s = document.createElement('style');
    s.id = 'stkCss';
    s.textContent = '.stk-pop{position:fixed;z-index:9999;width:min(320px,calc(100vw - 24px));max-height:min(360px,60vh);overflow:auto;background:#121212;border:1px solid #2f2f2f;' +
      'border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.55);padding:8px;font:13px Ubuntu,sans-serif;color:#ddd}' +
      '.stk-pop h6{margin:6px 4px 4px;font-size:12px;color:#9be39f;font-weight:700}.stk-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}' +
      '.stk-grid button{background:#1b1b1b;border:1px solid #262626;border-radius:8px;padding:4px;cursor:pointer;aspect-ratio:1}' +
      '.stk-grid button:hover,.stk-grid button:focus-visible{border-color:#43a047;background:#163019;outline:none}' +
      '.stk-grid img{width:100%;height:100%;image-rendering:pixelated}.stk-pop p{margin:6px 4px;color:#bbb}.stk-pop a{color:#7ee08a}';
    document.head.appendChild(s);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function load() {
    if (data) return Promise.resolve(data);
    if (!loading) loading = fetch('/api/stickers', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
      .then(function (j) { data = j && j.ok ? j : { packs: [], signed: false }; return data; })
      .catch(function () { loading = null; return { packs: [], signed: false, failed: true }; });
    return loading;
  }
  function close() { if (panel) { panel.remove(); panel = null; } if (owner) { owner.setAttribute('aria-expanded', 'false'); owner = null; } }
  function insert(ta, token) {
    var a = ta.selectionStart == null ? ta.value.length : ta.selectionStart, b = ta.selectionEnd == null ? a : ta.selectionEnd;
    var before = ta.value.slice(0, a), after = ta.value.slice(b);
    var pre = before && !/\s$/.test(before) ? ' ' : '', post = after && !/^\s/.test(after) ? ' ' : '';
    ta.value = before + pre + token + post + after;
    var at = (before + pre + token + post).length;
    try { ta.setSelectionRange(at, at); } catch (e) { /* not focusable */ }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }
  function open(btn) {
    var ta = document.querySelector(btn.getAttribute('data-sticker-picker'));
    if (!ta) return;
    css();
    close();
    owner = btn;
    btn.setAttribute('aria-expanded', 'true');
    panel = document.createElement('div');
    panel.className = 'stk-pop';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Stickers');
    panel.innerHTML = '<p>Loading stickers…</p>';
    document.body.appendChild(panel);
    place(btn);
    load().then(function (d) {
      if (!panel) return;
      var mine = (d.packs || []).filter(function (p) { return p.owned; });
      var h = '';
      if (!d.signed) h = '<p>Sign in to use stickers.</p>';
      else if (!mine.length) h = '<p>No sticker packs yet. 🧸 <a href="/premium#stickers">Get one</a>' + (d.allowance && d.allowance.left ? ' - your 🎟️ Season Pass has a free one waiting.' : '.') + '</p>';
      mine.forEach(function (p) {
        h += '<h6>' + esc(p.emoji) + ' ' + esc(p.name) + '</h6><div class="stk-grid">' + p.stickers.map(function (s) {
          return '<button type="button" data-token="' + esc(s.token) + '" title="' + esc(s.name) + '"><img src="' + esc(s.url) + '" alt="' + esc(s.name) + '"></button>';
        }).join('') + '</div>';
      });
      if (mine.length) h += '<p><a href="/premium#stickers">More packs…</a></p>';
      panel.innerHTML = h;
      place(btn);
      var first = panel.querySelector('button');
      if (first) first.focus();
      panel.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-token]');
        if (!b) return;
        insert(ta, b.getAttribute('data-token'));
        close();
      });
    });
  }
  function place(btn) {
    if (!panel) return;
    var r = btn.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight;
    var left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left));
    var top = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.min(window.innerHeight - h - 8, r.bottom + 6);
    panel.style.left = left + 'px';
    panel.style.top = Math.max(8, top) + 'px';
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-sticker-picker]');
    if (btn) { e.preventDefault(); if (owner === btn) close(); else open(btn); return; }
    if (panel && !panel.contains(e.target)) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel) { var o = owner; close(); if (o) o.focus(); } });
  window.addEventListener('resize', close);
})();
