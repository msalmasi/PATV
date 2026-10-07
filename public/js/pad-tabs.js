// pad-tabs.js — the pad page's section tabs (1.99dx, views/room.ejs): Live (or Stage) · Feed · About.
//
//   PATVPadTabs.init({ slug, platform, active, tabs: ['live','feed','about'], posts: [{id, created}], more })
//
// Which tab opens: an explicit request (?tab=feed, #feed, a feed sort / page in the query, #rules) beats the
// visitor's last pick for this pad (localStorage) which beats the smart default: Live when the pad's Camfrog
// room is active (people in it, or its stage on air), else Feed; pads without a Camfrog room (site / profile
// pads) always default to Feed. Panels are only HIDDEN (the hidden attribute) - never unmounted - so the
// chat relay polling, push-to-talk, mic state, the stage player and the 30 s schedule refresh keep running
// whichever tab is showing.
// The Feed tab carries an "N new" badge: posts newer than this visitor's last look at the feed (a timestamp
// per pad in localStorage, set whenever the Feed tab is shown). Every storage access is in try/catch.
// The pure helpers (pickTab, defaultTab, requestedTab, newCount) are exported for node tests.
(function (root) {
  'use strict';
  var ALIAS = { live: 'live', stage: 'live', chat: 'live', feed: 'feed', posts: 'feed', rules: 'feed', about: 'about', info: 'about', schedule: 'live' };
  var FEED_Q = /(?:^|[?&])(?:sort|fsort|t|ft|p|fp)=/;
  var FIRST_LOOK_MS = 3 * 24 * 3600 * 1000;   // a first visit counts the last 3 days' posts as new

  function has(tabs, t) { return !!t && tabs.indexOf(t) >= 0; }

  /** The smart default: Live when the room is active, else Feed; non-Camfrog pads always Feed. */
  function defaultTab(o) {
    var tabs = o.tabs || [];
    var feedOr = has(tabs, 'feed') ? 'feed' : tabs[0] || null;
    if (o.platform !== 'camfrog') return feedOr;
    return o.active && has(tabs, 'live') ? 'live' : feedOr;
  }

  /** ?tab=<name> or #<name> (and a feed sort / page in the query, which only the Feed uses) -> a tab id, or null. */
  function requestedTab(search, hash) {
    var s = String(search || ''), h = String(hash || '').replace(/^#/, '').toLowerCase();
    var m = /(?:^|[?&])tab=([^&#]*)/.exec(s);
    if (m) { var q = ALIAS[decodeURIComponent(m[1]).toLowerCase()]; if (q) return q; }
    if (h && ALIAS[h]) return ALIAS[h];
    if (/^(?:feed|rules|post-)/.test(h)) return 'feed';
    if (FEED_Q.test(s)) return 'feed';
    return null;
  }

  /** requested > the visitor's last pick > the smart default (each only when that tab exists). */
  function pickTab(o) {
    var tabs = o.tabs || [];
    if (has(tabs, o.requested)) return o.requested;
    if (has(tabs, o.stored)) return o.stored;
    return defaultTab(o);
  }

  /** How many posts are newer than `seen` (ms; null = first visit: the last 3 days). */
  function newCount(posts, seen, now) {
    var since = seen == null || !isFinite(seen) ? (now || Date.now()) - FIRST_LOOK_MS : Number(seen);
    var n = 0;
    (posts || []).forEach(function (p) { if (p && Number(p.created) > since) n++; });
    return n;
  }

  function store(key, val) {
    try {
      if (val === undefined) return root.localStorage ? root.localStorage.getItem(key) : null;
      if (root.localStorage) root.localStorage.setItem(key, String(val));
    } catch (e) { /* private mode / blocked storage: the page works without it */ }
    return null;
  }

  function init(o) {
    var doc = root.document;
    var bar = doc.getElementById('padTabs');
    if (!bar) return null;
    var btns = Array.prototype.slice.call(bar.querySelectorAll('[role="tab"]'));
    var tabs = btns.map(function (b) { return b.getAttribute('data-tab'); });
    var keyTab = 'patvPadTab:' + o.slug, keySeen = 'patvPadFeedSeen:' + o.slug;
    var seenRaw = store(keySeen), seen = seenRaw != null && seenRaw !== '' ? Number(seenRaw) : null;
    var badge = doc.getElementById('padFeedNew');
    var current = null;

    function paintBadge() {
      if (!badge) return;
      var n = current === 'feed' ? 0 : newCount(o.posts, seen);
      badge.hidden = !n;
      badge.textContent = n ? (n >= (o.posts || []).length && o.more ? n + '+' : n) + ' new' : '';
    }
    function show(t, opts) {
      opts = opts || {};
      if (!has(tabs, t)) return;
      current = t;
      btns.forEach(function (b) {
        var on = b.getAttribute('data-tab') === t;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        var p = doc.getElementById(b.getAttribute('aria-controls'));
        if (p) p.hidden = !on;
      });
      if (t === 'feed') { seen = Date.now(); store(keySeen, seen); }
      paintBadge();
      if (opts.remember) store(keyTab, t);
      if (opts.url && root.history && root.history.replaceState) {
        try {
          var u = new URL(root.location.href);
          u.searchParams.set('tab', t === 'live' ? (o.platform === 'camfrog' ? 'live' : 'stage') : t);
          if (u.hash && ALIAS[u.hash.slice(1).toLowerCase()]) u.hash = '';
          root.history.replaceState(root.history.state, '', u.pathname + u.search + u.hash);
        } catch (e) { /* old browser */ }
      }
      if (opts.focus) { var b = bar.querySelector('[data-tab="' + t + '"]'); if (b) b.focus(); }
      if (opts.scroll) { try { bar.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { bar.scrollIntoView(); } }
      try { doc.dispatchEvent(new CustomEvent('patv:padtab', { detail: { tab: t } })); } catch (e) { /* IE */ }
    }

    btns.forEach(function (b, i) {
      b.addEventListener('click', function () { show(b.getAttribute('data-tab'), { remember: true, url: true }); });
      b.addEventListener('keydown', function (e) {
        var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : null;
        if (j == null) return;
        e.preventDefault();
        j = (j + btns.length) % btns.length;
        show(btns[j].getAttribute('data-tab'), { remember: true, url: true, focus: true });
      });
    });
    // any link / button with data-pad-tab="feed" switches (the Live tab's "Open feed ›", the header chips)
    doc.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('[data-pad-tab]') : null;
      if (!a || bar.contains(a)) return;
      var t = a.getAttribute('data-pad-tab');
      if (!has(tabs, t)) return;
      e.preventDefault();
      show(t, { remember: true, url: true, scroll: true });
      var open = a.getAttribute('data-open');
      if (open) { var d = doc.getElementById(open); if (d) { d.open = true; try { d.scrollIntoView({ block: 'start' }); } catch (x) { /* */ } } }
    });
    root.addEventListener('hashchange', function () {
      var t = requestedTab('', root.location.hash);
      if (t) show(t, {});
    });

    var requested = requestedTab(root.location.search, root.location.hash);
    show(pickTab({ tabs: tabs, platform: o.platform, active: o.active, requested: requested, stored: store(keyTab) }), {});
    if (requested === 'feed' && /^#rules$/i.test(root.location.hash)) { var r = doc.getElementById('rules'); if (r) r.open = true; }
    return { show: show, current: function () { return current; } };
  }

  var api = { init: init, pickTab: pickTab, defaultTab: defaultTab, requestedTab: requestedTab, newCount: newCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PATVPadTabs = api;
})(typeof window !== 'undefined' ? window : globalThis);
