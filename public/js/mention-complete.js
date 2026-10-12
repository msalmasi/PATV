// mention-complete.js — @username autocomplete in the feed's text boxes (1.99kk, feedmentions.js).
// Works on every post / comment / reply / edit box (textarea[name=body] inside a form, or any textarea[data-mentions]),
// including ones added later (event delegation). Typing "@" + a letter or two asks GET /api/mentions/suggest; arrow
// keys move, Enter / Tab pick, Escape closes. Names are inserted as text ("@name "), never as markup.
(function () {
  'use strict';
  if (window.__mentionComplete) return;
  window.__mentionComplete = true;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  var SEL = 'form textarea[name=body], textarea[data-mentions]';
  // 1.99ui: usernamerules.USERNAME_MAX on the server (was 40) - test/username-limit.test.js keeps them equal
  var USERNAME_MAX = 48;
  var TOKEN_RE = new RegExp('(^|[^A-Za-z0-9_.@\\/+-])@([A-Za-z0-9][A-Za-z0-9._-]{0,' + (USERNAME_MAX - 1) + '})$');
  var pop = null, box = null, items = [], sel = -1, timer = null, seq = 0, lastQ = null;

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('ul');
    pop.className = 'mc-pop';
    pop.id = 'mcPop';
    pop.setAttribute('role', 'listbox');
    pop.setAttribute('aria-label', _t('js.mentions.suggest_aria', 'People to mention'));
    pop.hidden = true;
    pop.addEventListener('mousedown', function (e) {
      var li = e.target.closest('li');
      if (!li) return;
      e.preventDefault();
      pick(Number(li.getAttribute('data-i')));
    });
    document.body.appendChild(pop);
    return pop;
  }
  function close() {
    if (pop) pop.hidden = true;
    if (box) { box.removeAttribute('aria-activedescendant'); box.setAttribute('aria-expanded', 'false'); }
    items = []; sel = -1; lastQ = null;
  }
  // the "@word" right before the caret, or null
  function token(ta) {
    var end = ta.selectionStart;
    if (end == null || end !== ta.selectionEnd) return null;
    var before = ta.value.slice(Math.max(0, end - (USERNAME_MAX + 2)), end);
    var m = TOKEN_RE.exec(before);
    return m ? { q: m[2], start: end - m[2].length - 1, end: end } : null;
  }
  function place(ta) {
    var r = ta.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (window.scrollY + r.bottom + 4) + 'px';
  }
  function paint() {
    ensurePop();
    pop.textContent = '';
    items.forEach(function (p, i) {
      var li = document.createElement('li');
      li.id = 'mcOpt' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('data-i', String(i));
      li.setAttribute('aria-selected', i === sel ? 'true' : 'false');
      var n = document.createElement('span'); n.textContent = '@' + p.username; li.appendChild(n);
      if (p.display) { var d = document.createElement('span'); d.className = 'mc-d'; d.textContent = p.display; li.appendChild(d); }
      pop.appendChild(li);
    });
    pop.hidden = !items.length;
    if (box) {
      box.setAttribute('aria-expanded', items.length ? 'true' : 'false');
      if (sel >= 0) box.setAttribute('aria-activedescendant', 'mcOpt' + sel); else box.removeAttribute('aria-activedescendant');
      if (items.length) place(box);
    }
  }
  function pick(i) {
    var p = items[i];
    if (!p || !box) return;
    var tk = token(box);
    if (!tk) { close(); return; }
    var v = box.value, ins = '@' + p.username + ' ';
    box.value = v.slice(0, tk.start) + ins + v.slice(tk.end);
    var at = tk.start + ins.length;
    box.setSelectionRange(at, at);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    box.focus();
  }
  function lookup(ta) {
    var tk = token(ta);
    if (!tk) { close(); return; }
    if (tk.q === lastQ) return;
    lastQ = tk.q;
    clearTimeout(timer);
    var my = ++seq;
    timer = setTimeout(function () {
      fetch('/api/mentions/suggest?q=' + encodeURIComponent(tk.q), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
        .then(function (r) { return r.ok ? r.json() : { ok: false }; })
        .then(function (d) {
          if (my !== seq || box !== ta) return;
          items = d && d.ok && Array.isArray(d.people) ? d.people : [];
          sel = items.length ? 0 : -1;
          paint();
        }).catch(function () { /* no suggestions */ });
    }, 150);
  }
  function prep(ta) {
    if (ta.getAttribute('data-mc')) return;
    ta.setAttribute('data-mc', '1');
    ta.setAttribute('aria-autocomplete', 'list');
    ta.setAttribute('aria-controls', 'mcPop');
    ta.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('input', function (e) {
    var ta = e.target;
    if (!ta || !ta.matches || !ta.matches(SEL)) return;
    prep(ta);
    box = ta;
    ensurePop();
    lookup(ta);
  });
  document.addEventListener('keydown', function (e) {
    if (!pop || pop.hidden || e.target !== box || !items.length) return;
    if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; paint(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { if (sel >= 0) { pick(sel); e.preventDefault(); } }
    else if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('focusout', function (e) { if (e.target === box) setTimeout(function () { if (document.activeElement !== box) close(); }, 150); });
  window.addEventListener('resize', function () { if (pop && !pop.hidden && box) place(box); });
})();
