// pad-chipfit.js (1.99xt) - pad badge chips that collapse to fit one line ([data-fit] rows from padcosmetics.fx():
// badgesMini on the homepage's Top Pads, badgesFit on the /p cards).
// Order of giving way: the chips go first, never the pad's name. The name keeps at least FLOOR_CH characters
// (it ellipsizes past that, the full name stays in the row's title / link), the chips then get what is left: the first
// chips that fit + a "+N" chip (the hidden ones' names in its title and for screen readers); if not even "+N" fits, the
// chips hide. Counts / buttons outside the name box are never touched. Without JS padfx.css still keeps one line
// (the chips wrap into a clipped second line, whole chips drop).
(function () {
  'use strict';
  var FLOOR_CH = 8;
  function px(v) { return parseFloat(v) || 0; }
  function outerW(e) { var cs = getComputedStyle(e); return e.getBoundingClientRect().width + px(cs.marginLeft) + px(cs.marginRight); }
  function shown(e) { var cs = getComputedStyle(e); return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed'; }
  function chPx(e) { return px(getComputedStyle(e).fontSize) * 0.56; }

  function fit(bs) {
    var box = bs.parentElement;
    if (!box || !bs.isConnected) return;
    var chips = [].filter.call(bs.children, function (c) { return c.classList.contains('pfx-b') && !c.classList.contains('pfx-more'); });
    if (!chips.length) return;
    var more = bs.querySelector('.pfx-more');
    // measure everything at its natural width, on one line
    bs.classList.remove('pfx-fitted', 'pfx-none');
    bs.classList.add('pfx-measure');
    chips.forEach(function (c) { c.classList.remove('pfx-off'); });
    if (more) more.classList.add('pfx-off');

    var avail = box.clientWidth;
    var gap = px(getComputedStyle(box).columnGap);
    var name = box.querySelector(':scope > .nt, :scope > .t, :scope > [data-fit-name]');
    var kids = [].filter.call(box.children, shown);
    var other = 0;
    kids.forEach(function (k) { if (k !== bs && k !== name) other += outerW(k); });
    var gaps = gap * Math.max(0, kids.length - 1);
    var nameW = name ? name.scrollWidth : 0;
    var floor = name ? Math.min(nameW, FLOOR_CH * chPx(name)) : 0;
    var room = avail - other - gaps - floor;                  // what the chips may use
    var cg = px(getComputedStyle(bs).columnGap);
    var ws = chips.map(outerW);
    var total = ws.reduce(function (a, b) { return a + b; }, 0) + cg * (ws.length - 1);

    if (total <= room + 0.5) { bs.classList.remove('pfx-measure'); bs.classList.add('pfx-fitted'); return; }

    if (!more) {
      more = document.createElement('span');
      more.className = 'pfx-b pfx-more' + (bs.classList.contains('mini') ? ' mini' : '');
      bs.appendChild(more);
    }
    more.classList.remove('pfx-off');
    var k = chips.length - 1;
    for (; k >= 0; k--) {
      setMore(more, chips.slice(k));
      var w = outerW(more) + (k ? ws.slice(0, k).reduce(function (a, b) { return a + b; }, 0) + cg * k : 0);
      if (w <= room + 0.5) break;
    }
    chips.forEach(function (c, i) { c.classList.toggle('pfx-off', i >= Math.max(k, 0)); });
    bs.classList.remove('pfx-measure');
    if (k < 0) bs.classList.add('pfx-none');                 // not even "+N" fits: the name has the row
    else bs.classList.add('pfx-fitted');
  }
  function label(c) {   // a mini chip's title, else the full pill's words (not its aria-hidden icon)
    var t = c.getAttribute('title');
    if (t) return t;
    var s = '';
    [].forEach.call(c.childNodes || [], function (n) { if (!(n.getAttribute && n.getAttribute('aria-hidden') === 'true')) s += n.textContent; });
    return (s || c.textContent).trim();
  }
  function setMore(more, hidden) {
    var names = hidden.map(label).join(' · ');
    more.textContent = '+' + hidden.length;
    more.title = names;
    var sr = document.createElement('span');
    sr.className = 'pfx-sr';
    sr.textContent = ' ' + names;
    more.appendChild(sr);
  }

  var queued = false;
  function runAll() {
    queued = false;
    [].forEach.call(document.querySelectorAll('.pfx-bs[data-fit]'), fit);
  }
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(runAll); } }

  var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
  function observe() {
    if (!ro) return;
    [].forEach.call(document.querySelectorAll('.pfx-bs[data-fit]'), function (bs) {
      // watch the row / card (sized from outside), not the name box we change
      var host = bs.closest('li, .ch, article, section') || (bs.parentElement && bs.parentElement.parentElement);
      if (host && (!seen || !seen.has(host))) { if (seen) seen.add(host); ro.observe(host); }
    });
  }
  function start() { observe(); runAll(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('resize', schedule);
  window.addEventListener('load', schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  // pages that draw rows later call this
  window.PATVChipFit = { run: function () { observe(); schedule(); } };
})();
