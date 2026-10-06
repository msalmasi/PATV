// admin-shell.js — the admin area's shared behaviour (1.99cv), loaded by views/partials/admin-close.ejs.
//  - a filter box on every long table (more than FILTER_MIN rows, or any table marked data-filter),
//    including tables that fill in later (stage admin, welcome bonus, the Pepe audit log)
//  - opens a collapsed "advanced" block when the URL's #anchor points inside it
//  - marks the section sub-link you're reading
(function () {
  'use strict';
  var FILTER_MIN = 10;
  var main = document.getElementById('admMain');
  if (!main) return;

  function rowsOf(t) { return t.tBodies.length ? Array.prototype.slice.call(t.tBodies[0].rows) : Array.prototype.slice.call(t.rows, 1); }
  function wrapOf(t) {
    var w = t.parentElement;
    return (w && w !== main && /\b(adm-tbl|tblwrap|fa-scroll|tbl|pc-logwrap)\b/.test(w.className)) ? w : t;
  }
  function addFilter(t) {
    if (t.getAttribute('data-filtered') === '1') return;
    var rows = rowsOf(t);
    if (!t.hasAttribute('data-filter') && rows.length <= FILTER_MIN) return;
    t.setAttribute('data-filtered', '1');
    var bar = document.createElement('div');
    bar.className = 'adm-filterbar';
    var inp = document.createElement('input');
    inp.type = 'search'; inp.className = 'adm-filter'; inp.placeholder = 'Filter rows…';
    var lbl = t.getAttribute('aria-label') || (t.closest('section, .adm-card') && (t.closest('section, .adm-card').querySelector('h2, h3') || {}).textContent) || 'table';
    inp.setAttribute('aria-label', 'Filter ' + String(lbl).trim().slice(0, 60));
    var count = document.createElement('span');
    count.className = 'adm-count';
    bar.appendChild(inp); bar.appendChild(count);
    var w = wrapOf(t);
    w.parentNode.insertBefore(bar, w);
    function apply() {
      var q = inp.value.trim().toLowerCase(), all = rowsOf(t), shown = 0;
      all.forEach(function (r) {
        var hit = !q || r.textContent.toLowerCase().indexOf(q) >= 0;
        r.classList.toggle('adm-hide', !hit);
        if (hit) shown++;
      });
      var txt = q ? shown + ' of ' + all.length : all.length + ' rows';
      if (count.textContent !== txt) count.textContent = txt;   // no change, no mutation (the observer below)
    }
    inp.addEventListener('input', apply);
    t._admFilter = apply;
    apply();
  }
  function scan() { main.querySelectorAll('table').forEach(function (t) { if (t._admFilter) t._admFilter(); else addFilter(t); }); }
  scan();
  // tables that are filled in by their own scripts
  if (window.MutationObserver) {
    var pending = null;
    new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () { pending = null; scan(); }, 150);
    }).observe(main, { childList: true, subtree: true });
  }

  // #anchor inside a collapsed block -> open it and scroll there
  function openFor(hash) {
    if (!hash || hash.length < 2) return;
    var el;
    try { el = document.getElementById(decodeURIComponent(hash.slice(1))); } catch (e) { el = null; }
    if (!el) return;
    var d = el.closest('details');
    while (d) { d.open = true; d = d.parentElement && d.parentElement.closest('details'); }
    if (el.tagName === 'DETAILS') el.open = true;
    setTimeout(function () { el.scrollIntoView({ block: 'start' }); }, 0);
  }
  openFor(location.hash);
  window.addEventListener('hashchange', function () { openFor(location.hash); });

  // the sub-link of the card you're reading
  var links = Array.prototype.slice.call(document.querySelectorAll('.adm-sub a, .adm-subbar a'));
  if (links.length && 'IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (a) { var id = (a.getAttribute('href') || '').slice(1); (byId[id] = byId[id] || []).push(a); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('on'); });
        (byId[en.target.id] || []).forEach(function (a) { a.classList.add('on'); });
      });
    }, { rootMargin: '0px 0px -70% 0px' });
    Object.keys(byId).forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
  }
})();
