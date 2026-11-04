// pad-roompm.js — 1.99?? roompm: Pepe's private answers in the pad's chat ("room PMs", roompm.js on the site).
//
// A "!" command you type in the pad's chat box that Pepe answers privately (-p, a chat spin's "spinning..." and its result, a private
// usage line, the site's own !commands) shows here as one of Pepe's lines with a dashed edge and "only you can see this · from Pepe".
// The site sends them in YOUR /live answers only (`rpm`, while the page asks with ?rpm=<the last one it has>), so every tab and the
// Dock pop-out of your account show them and nobody else's page ever gets them. The site keeps them 24 hours (memory only).
//
// A private line is never pickable: no data-c / data-text / data-name / data-k (✂️ Clip chat, quotes, 🔊 Clip, the ⋯ menu and the
// downloads only take lines with those), and _c = 0 (refilter / dropRemoved / redoLines skip it). While the site has them on
// (rpm.on = 1) the page's root gets `rpm-on`, and the composer's "Your commands" list (room-bridge.js) stops repeating the answers as
// 🔒 rows (roompm.css) - it still says "› !spin" and how it went. No `rpm` in an answer (an older site, signed out) = off.
// review (privacy): a shared computer never shows one account's private answers to anyone else - an answer with no block (signed out
// in another tab), {on: 0} (switched off) or another account's tag (rpm.w: someone else signed in under this open page) takes every
// private line off the page and asks again from the start; so does a page going into the back/forward cache (pagehide, persisted).
//
// Placement: by time among the chat's lines (Pepe's clock: an answer's ts is the end of the second Pepe sent it in - after his room echo
// of the command), never below your own lines still on their way (they stay last). An answer usually reaches the site before the echo
// of its command (the echo rides Pepe's bridge sync), so for YOUNG ms after it shows each update moves it below any line that came in
// since with an earlier time. The page keeps at most MAX_NODES of them (the live log's own 300-line trim applies too).
// Strings: __t (js.pad.rpm.*).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var STRIP = ['data-c', 'data-k', 'data-name', 'data-text', 'data-tx', 'data-own', 'data-vc', 'data-rmc', 'data-rm', 'data-hold', 'data-reveal'];
  var MAX_NODES = 50, YOUNG = 15000, SCAN = 300;
  var PEPE = { login: 'pepefrog', display: 'Pepe', self: true };

  function init(o) {
    o = o || {};
    var feed = o.feed, line = o.line, root = o.root || null;
    if (!feed || typeof line !== 'function') return null;
    var cursor = 0, nodes = [], have = {}, haveList = [], isOn = false, who = null;
    if (root) {
      try { root.style.setProperty('--rpm-cmd-done', JSON.stringify(_t('js.pad.rpm.cmd_done', 'answered privately in the chat'))); } catch (e) { /* old browser */ }
    }
    function setOn(on) {
      isOn = !!on;
      if (root) root.classList.toggle('rpm-on', isOn);
    }
    // review (privacy): every private line off the page (the ones it tracks, and any other in the chat), and ask from the start
    function clear() {
      nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      Array.prototype.slice.call(feed.childNodes || []).forEach(function (n) { if (n && n._rpm && n.parentNode) n.parentNode.removeChild(n); });
      nodes = []; have = {}; haveList = []; cursor = 0;
    }
    try {
      if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('pagehide', function (e) { if (e && e.persisted) clear(); });
    } catch (e) { /* no back/forward cache events */ }
    function hist() { try { return typeof o.hist === 'function' ? o.hist() : null; } catch (e) { return null; } }
    // one of the page's own lines, ordered by time (it carries _ts) - not a pending line of yours, not a private one
    function timed(n) { return !!(n && n.nodeType === 1 && n._ts > 0 && !n._rpm && !(n.classList && n.classList.contains('rb-opt'))); }
    function ordered(n) { return timed(n) || !!(n && n._rpm); }

    function build(r, u) {
      var n = line({ k: 'msg', u: u || PEPE, text: String(r.text || ''), ts: Number(r.ts) || Date.now() });
      if (!n || !n.setAttribute) return null;
      (function strip(x) {             // the line and everything in it (a Reveal button carries data-reveal)
        STRIP.forEach(function (a) { x.removeAttribute(a); });
        Array.prototype.forEach.call(x.childNodes || [], function (k) { if (k.nodeType === 1) strip(k); });
      })(n);
      n.classList.add('rpm');
      n.setAttribute('data-rpm', String(r.id));
      n.setAttribute('title', r.cmd ? _t('js.pad.rpm.tip_cmd', 'Pepe’s private answer to your {cmd} — only you can see it, for up to 24 hours', { cmd: r.cmd })
        : _t('js.pad.rpm.tip', 'Pepe’s private answer to your command — only you can see it, for up to 24 hours'));
      n._c = 0; n._ts = Number(r.ts) || Date.now(); n._k = 'rpm'; n._rpm = Number(r.id) || 1; n._got = Date.now();
      var lt = (n.querySelector && n.querySelector('.line-text')) || n;
      var sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = _t('js.pad.rpm.sr', 'Private answer from Pepe:') + ' ';
      lt.insertBefore(sr, lt.firstChild);
      var chip = document.createElement('span');
      chip.className = 'rpm-chip';
      chip.textContent = _t('js.pad.rpm.chip', 'only you can see this · from Pepe');
      lt.appendChild(chip);
      return n;
    }
    // right after the last line said at or before it (scanning back from the end); every line in reach newer: before the oldest
    // of those; a chat with no lines: above your pending lines (o.anchor) or at the end
    function place(n) {
      var kids = feed.childNodes, stop = Math.max(0, kids.length - SCAN), k, x;
      for (k = kids.length - 1; k >= stop; k--) {
        x = kids[k];
        if (x !== n && ordered(x) && x._ts <= n._ts) { feed.insertBefore(n, x.nextSibling); return; }
      }
      for (k = stop; k < kids.length; k++) {
        x = kids[k];
        if (x !== n && ordered(x)) { feed.insertBefore(n, x); return; }
      }
      var a = null;
      try { a = typeof o.anchor === 'function' ? o.anchor() : null; } catch (e) { a = null; }
      if (a && a.parentNode === feed) feed.insertBefore(n, a); else feed.appendChild(n);
    }
    // a young answer that showed before the echo of its own command (or before another line said earlier): below those lines now.
    // Newest first, so answers in a row keep their order.
    function settle() {
      var t = Date.now();
      nodes.slice().sort(function (a, b) { return b._rpm - a._rpm; }).forEach(function (n) {
        if (n.parentNode !== feed || t - n._got > YOUNG) return;
        var nx = n.nextSibling, last = null;
        while (nx && timed(nx) && nx._ts <= n._ts) { last = nx; nx = nx.nextSibling; }
        if (last) feed.insertBefore(n, last.nextSibling);
      });
    }

    function update(d) {
      if (!d) return;
      var R = d.rpm;
      // signed out / switched off: nothing private stays on the page (review: a shared computer)
      if (!R || typeof R !== 'object' || R.on !== 1) { setOn(false); if (nodes.length || cursor) clear(); who = null; return; }
      setOn(true);
      // another account under this open page (it signed in in another tab): the first one's lines go; this answer only carried the
      // new account's rows newer than the old cursor, so the next one is asked from the start (rows already drawn aren't drawn twice)
      var fresh = false;
      if (R.w != null) {
        var w = String(R.w);
        if (who !== null && w !== who) { clear(); fresh = true; }
        who = w;
      }
      var rows = Array.isArray(R.rows) ? R.rows : [], add = [];
      rows.forEach(function (r) {
        var id = Number(r && r.id) || 0;
        if (id > cursor && !fresh) cursor = id;
        if (!id || have[id]) return;
        have[id] = 1; haveList.push(id);
        add.push(r);
      });
      while (haveList.length > 500) delete have[haveList.shift()];
      if (!fresh && Number(R.v) > cursor) cursor = Number(R.v);
      nodes = nodes.filter(function (n) { return n.parentNode === feed; });
      if (add.length) {
        var h = hist(), stick = typeof o.nearBottom === 'function' ? !!o.nearBottom() : false;
        // "Nothing said yet" goes, as when the first room line comes in
        if (feed.childNodes.length === 1 && feed.firstChild.tagName === 'P') feed.removeChild(feed.firstChild);
        add.forEach(function (r) {
          var n = build(r, R.u);
          if (!n) return;
          place(n);
          nodes.push(n);
        });
        while (nodes.length > MAX_NODES) { var old = nodes.shift(); if (old.parentNode) old.parentNode.removeChild(old); }
        if (stick && !(h && h.detached && h.detached()) && typeof o.toBottom === 'function') o.toBottom();
      }
      settle();
    }

    return {
      update: update,
      /** what the page adds to its /live long-poll: the last private answer it has. The page cleared its chat (a fresh view once its
       *  join cursor ran out): what it had been shown comes back with the next answer. */
      query: function () {
        if (nodes.length && !feed.childNodes.length) { nodes = []; have = {}; haveList = []; cursor = 0; }
        return '&rpm=' + cursor;
      },
      on: function () { return isOn; },
      _nodes: function () { return nodes.slice(); }
    };
  }
  window.PATVRoomPm = { init: init };
})();
