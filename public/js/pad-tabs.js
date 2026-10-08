// pad-tabs.js — the pad page's section tabs (1.99dx, views/room.ejs): Live (or Stage) · Feed · About.
//
//   PATVPadTabs.init({ slug, platform, active, tabs: ['live','feed','about'], posts: [{id, created}], more })
//
// Which tab opens: an explicit request (?tab=feed, #feed, a feed sort / page in the query, #rules) beats the
// visitor's last pick for this pad (localStorage) which beats the smart default: Live when the pad's Camfrog
// room is active (people in it, or its stage on air), else Feed; pads without a Camfrog room (site / profile
// pads) always default to Feed.
// 1.99eb: only Live and Feed are remembered ("feed@<ms>" / "live@<ms>"); About never is (an old stored
// "about" is ignored), so a plain /p/<slug> link ("Open pad", a pad name) can't land on About. And while the
// room is live, a remembered Feed only wins when it was picked in the last FEED_STICKY_MS (30 min - long
// enough to read the feed, click away and come back; short enough that tomorrow's visit opens on Live). Panels are only HIDDEN (the hidden attribute) - never unmounted - so the
// chat relay polling, push-to-talk, mic state, the stage player and the 30 s schedule refresh keep running
// whichever tab is showing.
// The Feed tab carries an "N new" badge: posts newer than this visitor's last look at the feed (a timestamp
// per pad in localStorage, set whenever the Feed tab is shown). Every storage access is in try/catch.
// 1.99ex: signed in, the seen time belongs to the ACCOUNT (feedseen.js; o.account = {scope, upto} rendered with the
// page): this browser's local value is merged in (max) and sent up when newer, and each Feed view syncs it (debounced
// POST /api/feed/seen). Signed out it's localStorage only, as before. The remembered TAB stays per browser.
// 1.99ec: the badge is a count pill PLUS a dot (#padFeedDot) on the tab while another tab shows; a first visit counts
// the last 3 days; opening the Feed clears the count for next time, but when the Feed opens WITH new posts (the
// default tab, a click) the pill stays a few seconds, then fades, and those posts get a "new" edge - so the visitor
// sees what was new instead of the badge vanishing before it's ever seen. #rules means About (the rules live there
// since 1.99ec - the Feed tab is one column).
// The pure helpers (pickTab, defaultTab, requestedTab, newCount) are exported for node tests.
(function (root) {
  'use strict';
  var ALIAS = { live: 'live', stage: 'live', chat: 'live', feed: 'feed', posts: 'feed', rules: 'about', about: 'about', info: 'about', schedule: 'live' };
  var FEED_Q = /(?:^|[?&])(?:sort|fsort|t|ft|p|fp)=/;
  var FIRST_LOOK_MS = 3 * 24 * 3600 * 1000;   // a first visit counts the last 3 days' posts as new
  var FEED_STICKY_MS = 30 * 60 * 1000;        // 1.99eb: a picked Feed beats Live-when-live for this long
  var REMEMBER = { live: true, feed: true };   // 1.99eb: About is never remembered

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
    if (/^rules/.test(h)) return 'about';
    if (/^(?:feed|post-)/.test(h)) return 'feed';
    if (FEED_Q.test(s)) return 'feed';
    return null;
  }

  /** The stored last pick ("feed@<ms>", "live@<ms>"; a pre-1.99eb bare "feed" / "live" has no time) ->
   *  {tab, at} or null. About (or anything else) is never a remembered tab. */
  function parseStored(raw) {
    if (raw && typeof raw === 'object') raw = raw.tab + '@' + (raw.at || 0);
    var m = /^([a-z]+)(?:@(\d+))?$/.exec(String(raw == null ? '' : raw).trim().toLowerCase());
    if (!m || !REMEMBER[m[1]]) return null;
    return { tab: m[1], at: m[2] ? Number(m[2]) : 0 };
  }
  function storedValue(t, now) { return REMEMBER[t] ? t + '@' + Math.floor(now || Date.now()) : null; }

  /** requested > the visitor's last pick (Live / Feed only) > the smart default (each only when that tab
   *  exists). When the smart default is Live (the room is live), a remembered Feed only wins when it was
   *  picked within FEED_STICKY_MS. */
  function pickTab(o) {
    var tabs = o.tabs || [];
    if (has(tabs, o.requested)) return o.requested;
    var def = defaultTab(o);
    var st = parseStored(o.stored);
    if (st && has(tabs, st.tab)) {
      if (!(def === 'live' && st.tab === 'feed')) return st.tab;
      var age = (o.now || Date.now()) - st.at;
      if (st.at && age >= 0 && age < FEED_STICKY_MS) return 'feed';
    }
    return def;
  }

  /** How many posts are newer than `seen` (ms; null = first visit: the last 3 days). */
  function newCount(posts, seen, now) {
    var since = seen == null || !isFinite(seen) ? (now || Date.now()) - FIRST_LOOK_MS : Number(seen);
    var n = 0;
    (posts || []).forEach(function (p) { if (p && Number(p.created) > since) n++; });
    return n;
  }

  /** The ids of the posts newer than `seen` (same rule as newCount) - the ones the Feed marks "new" when it opens. */
  function newIds(posts, seen, now) {
    var since = seen == null || !isFinite(seen) ? (now || Date.now()) - FIRST_LOOK_MS : Number(seen);
    return (posts || []).filter(function (p) { return p && Number(p.created) > since; }).map(function (p) { return String(p.id); });
  }
  /** 1.99ex: a member's seen time = the later of the account's (server) and this browser's (local) - so signing in
   *  merges what this browser had already seen. null when neither is known. */
  function mergeSeen(server, local) {
    var a = server != null && server !== '' && isFinite(server) ? Number(server) : null;
    var b = local != null && local !== '' && isFinite(local) ? Number(local) : null;
    return a == null ? b : b == null ? a : Math.max(a, b);
  }
  /** Should this browser's value be sent up (it's newer than what the account has)? */
  function needsPush(server, local) {
    var b = local != null && local !== '' && isFinite(local) ? Number(local) : null;
    if (b == null || b <= 0) return false;
    return server == null || server === '' || !isFinite(server) || b > Number(server);
  }

  /** The pill's text: "3 new", "10+ new" when every post we know of is new and there are more. */
  function badgeText(n, total, more) { return n ? (n >= total && more ? n + '+' : n) + ' new' : ''; }

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
    // 1.99ex: signed in, the seen time is the ACCOUNT's (feedseen.js, rendered with the page); this browser's
    // localStorage value is merged in (max) and sent up when it's newer, then every Feed view syncs (debounced)
    var acct = o.account && o.account.scope ? o.account : null;
    var syncTimer = null, pendingUpto = 0;
    function pushSeen(now) {
      clearTimeout(syncTimer); syncTimer = null;
      if (!acct || !pendingUpto || !root.fetch) return;
      var body = JSON.stringify({ scope: acct.scope, upto: pendingUpto }); pendingUpto = 0;
      try {
        root.fetch('/api/feed/seen', { method: 'POST', credentials: 'same-origin', keepalive: !!now,
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body }).catch(function () { /* offline: next view retries */ });
      } catch (e) { /* old browser */ }
    }
    function syncSeen(upto) {
      if (!acct) return;
      pendingUpto = Math.max(pendingUpto, Number(upto) || 0);
      clearTimeout(syncTimer); syncTimer = setTimeout(pushSeen, 1500);
    }
    if (acct) {
      if (needsPush(acct.upto, seen)) syncSeen(seen);
      seen = mergeSeen(acct.upto, seen);
      root.addEventListener('pagehide', function () { if (pendingUpto) pushSeen(true); });
    }
    var badge = doc.getElementById('padFeedNew'), dot = doc.getElementById('padFeedDot');
    var current = null, flashTimer = null;
    var total = (o.posts || []).length;

    function paintBadge() {
      var n = current === 'feed' ? 0 : newCount(o.posts, seen);
      if (badge && !(current === 'feed' && badge.classList.contains('is-flash'))) {
        badge.hidden = !n;
        badge.classList.remove('is-flash', 'is-fade');
        badge.textContent = badgeText(n, total, o.more);
      }
      if (dot) dot.hidden = !n;
      var fb = doc.getElementById('padTab-feed');
      if (fb) { if (n) fb.setAttribute('aria-label', 'Feed, ' + badgeText(n, total, o.more) + ' post' + (n === 1 ? '' : 's')); else fb.removeAttribute('aria-label'); }
    }
    // the Feed just opened with new posts in it: keep the pill a moment and mark those posts, then let it go
    function flashNew(ids) {
      if (!ids.length) return;
      var panel = doc.getElementById('padPanel-feed');
      ids.forEach(function (id) { var el = panel ? panel.querySelector('#p-' + id.replace(/[^A-Za-z0-9_-]/g, '')) : null; if (el) el.classList.add('fp-new'); });
      if (!badge) return;
      badge.textContent = badgeText(ids.length, total, o.more);
      badge.hidden = false;
      badge.classList.remove('is-fade');
      badge.classList.add('is-flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        badge.classList.add('is-fade');
        flashTimer = setTimeout(function () { badge.classList.remove('is-flash', 'is-fade'); paintBadge(); }, 700);
      }, 6000);
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
      if (t === 'feed') {
        var fresh = newIds(o.posts, seen);
        var newest = (o.posts || []).reduce(function (m, p) { return Math.max(m, Number(p && p.created) || 0); }, 0);
        seen = Math.max(Date.now(), newest); store(keySeen, seen); syncSeen(seen);
        flashNew(fresh);
      } else if (badge && badge.classList.contains('is-flash')) { clearTimeout(flashTimer); badge.classList.remove('is-flash', 'is-fade'); }
      paintBadge();
      if (opts.remember && REMEMBER[t]) store(keyTab, storedValue(t));   // 1.99eb: never About
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
    if (/^#rules$/i.test(root.location.hash)) { var r = doc.getElementById('rules'); if (r) { r.open = true; try { r.scrollIntoView({ block: 'start' }); } catch (x) { /* */ } } }
    return { show: show, current: function () { return current; } };
  }

  var api = { init: init, pickTab: pickTab, defaultTab: defaultTab, requestedTab: requestedTab, newCount: newCount, newIds: newIds, badgeText: badgeText, mergeSeen: mergeSeen, needsPush: needsPush,
              parseStored: parseStored, storedValue: storedValue, FEED_STICKY_MS: FEED_STICKY_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PATVPadTabs = api;
})(typeof window !== 'undefined' ? window : globalThis);
