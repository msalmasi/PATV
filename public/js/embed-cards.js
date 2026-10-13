/* embed-cards.js - live link-preview cards on the feed (embedcards.js serves GET /api/embeds).
   A post or comment that links to a prediction market, a betting pool, a poll or a bounty on this site (absolute links on
   publicaccess.tv / staging / this host, or relative /markets/12) gets a card after its text: the question, prices / pool
   split / vote split, pot or volume, a live countdown, the status and the pad. The feed has no SSE, so live items are
   re-fetched in one batched request every ~25 s while the tab is visible (backing off on errors, paused while hidden).
   A post's own link-preview card (feedmedia.js) for the same item is hidden once the live card is in - one card per link.
   Pure helpers (refFromHref, fmtLeft, pct) are exported for node tests. */
(function () {
  'use strict';
  var HOSTS = ['publicaccess.tv', 'www.publicaccess.tv', 'staging.publicaccess.tv'];
  var MAX_REFS = 30, MAX_PER_BOX = 3, EVERY = 25000, MAX_BACKOFF = 300000;
  var FINAL = { settled: 1, void: 1, ended: 1, expired: 1 };

  /** An href (absolute or relative) -> "M12" | "P:poll_ab" | "BT3" | null. Only this site's own hosts count. */
  function refFromHref(href, base, hosts) {
    if (!href || typeof href !== 'string') return null;
    var u;
    try { u = new URL(href, base || 'https://publicaccess.tv/'); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    var host = u.hostname.toLowerCase(), list = (hosts || HOSTS).map(function (h) { return String(h).toLowerCase(); });
    var baseHost = '';
    try { baseHost = new URL(base || 'https://publicaccess.tv/').hostname.toLowerCase(); } catch (e) { baseHost = ''; }
    if (list.indexOf(host) < 0 && host !== baseHost) return null;
    if (u.port && host !== baseHost) return null;
    var p = u.pathname, m;
    if ((m = p.match(/^\/markets\/m?(\d{1,9})\/?$/i))) return 'M' + parseInt(m[1], 10);
    if ((m = p.match(/^\/bounties\/(?:bt)?(\d{1,9})\/?$/i))) return 'BT' + parseInt(m[1], 10);
    if ((m = p.match(/^\/polls\/([A-Za-z0-9_-]{1,40})\/?$/))) return 'P:' + m[1];
    return null;
  }

  /** ms left -> {k: i18n key suffix, v: vars} (null when it's over). */
  function leftParts(msLeft) {
    var s = Math.floor(msLeft / 1000);
    if (!(s > 0)) return null;
    if (s >= 86400) return { k: 'd', v: { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600) } };
    if (s >= 3600) return { k: 'h', v: { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) } };
    return { k: 'm', v: { m: Math.floor(s / 60), s: s % 60 } };
  }
  /** English countdown text (the page uses the translated forms of the same parts). */
  function fmtLeft(msLeft) {
    var p = leftParts(msLeft);
    if (!p) return '';
    return p.k === 'd' ? p.v.d + 'd ' + p.v.h + 'h' : p.k === 'h' ? p.v.h + 'h ' + p.v.m + 'm' : p.v.m + 'm ' + p.v.s + 's';
  }
  /** a price 0..1 -> "62%" ("<1%" / ">99%" at the ends, never a misleading 0 or 100 while it's still trading). */
  function pct(x) {
    x = Number(x);
    if (!isFinite(x)) return '';
    var v = x * 100;
    if (v > 0 && v < 1) return '<1%';
    if (v < 100 && v > 99) return '>99%';
    return Math.round(v) + '%';
  }

  var api = { refFromHref: refFromHref, fmtLeft: fmtLeft, leftParts: leftParts, pct: pct, HOSTS: HOSTS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------- browser ----
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var NUM = (function () { try { return new Intl.NumberFormat((window.PATV_I18N && window.PATV_I18N.lang) || undefined); } catch (e) { return null; } })();
  var num = function (n) { n = Math.floor(Number(n) || 0); return NUM ? NUM.format(n) : String(n); };
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var cards = {};      // ref -> [card element]
  var data = {};       // ref -> last item (or null)
  var skew = 0;        // server now - local now
  var timer = null, backoff = EVERY, inflight = false, queued = false, lastFetch = 0;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function kindLabel(k) {
    return k === 'market' ? _t('js.embed.market', 'Market') : k === 'pool' ? _t('js.embed.pool', 'Betting pool')
      : k === 'poll' ? _t('js.embed.poll', 'Poll') : _t('js.embed.bounty', 'Bounty');
  }
  var ICON = { market: '📈', pool: '🎲', poll: '🗳️', bounty: '🎯' };
  function stLabel(s) {
    switch (s) {
      case 'open': return _t('js.embed.st.open', 'Open');
      case 'closed': return _t('js.embed.st.closed', 'Closed');
      case 'settling': return _t('js.embed.st.settling', 'Settling');
      case 'settled': return _t('js.embed.st.settled', 'Settled');
      case 'void': return _t('js.embed.st.void', 'Voided');
      case 'ended': return _t('js.embed.st.ended', 'Ended');
      case 'expired': return _t('js.embed.st.expired', 'Expired');
      default: return s;
    }
  }
  function leftText(msLeft) {
    var p = leftParts(msLeft);
    if (!p) return _t('js.embed.closing', 'closing now');
    return p.k === 'd' ? _t('js.embed.left_d', '{d}d {h}h', p.v) : p.k === 'h' ? _t('js.embed.left_h', '{h}h {m}m', p.v) : _t('js.embed.left_m', '{m}m {s}s', p.v);
  }
  function whenText(it) {
    var now = Date.now() + skew;
    if (it.status === 'open' && it.closes) {
      var l = leftText(it.closes - now);
      return it.kind === 'bounty' ? _t('js.embed.ends_in', 'ends in {left}', { left: l }) : _t('js.embed.closes_in', 'closes in {left}', { left: l });
    }
    if (it.status === 'closed' || it.status === 'settling') return it.kind === 'bounty' ? _t('js.embed.bounty_wait', 'waiting for the payout') : _t('js.embed.awaiting', 'waiting for the result');
    if (it.status === 'settled' && it.result) return _t('js.embed.result', 'Result: {result}', { result: it.result });
    return '';
  }

  /** One option row: a bar (its share), its name and the figures. */
  function optRow(name, w, val, title, on) {
    var r = el('span', 'ec-opt' + (on ? ' on' : ''));
    var bar = el('span', 'ec-bar'); bar.style.width = Math.max(0, Math.min(100, w)) + '%'; bar.setAttribute('aria-hidden', 'true');
    r.appendChild(bar);
    r.appendChild(el('span', 'ec-on', (on ? '✓ ' : '') + name));
    var v = el('span', 'ec-ov', val); if (title) v.title = title;
    r.appendChild(v);
    return r;
  }

  function fill(card, it) {
    var ref = it.ref;
    card.className = 'ec ec-' + it.kind + ' is-' + it.status;
    card.setAttribute('data-status', it.status);
    while (card.firstChild) card.removeChild(card.firstChild);
    var top = el('span', 'ec-top');
    var kd = el('span', 'ec-kind'); var ic = el('span', 'ec-ic', ICON[it.kind] || '🔗'); ic.setAttribute('aria-hidden', 'true');
    kd.appendChild(ic); kd.appendChild(document.createTextNode(kindLabel(it.kind)));
    top.appendChild(kd);
    if (it.kind !== 'poll') top.appendChild(el('span', 'ec-ref', ref));
    top.appendChild(el('span', 'ec-st', stLabel(it.status)));
    var w = el('span', 'ec-when', whenText(it)); w.setAttribute('data-when', '1');
    top.appendChild(w);
    card.appendChild(top);
    var main = el('a', 'ec-main', it.title || ref);
    main.href = it.url;
    main.setAttribute('aria-label', _t('js.embed.open_aria', 'Open {kind} {ref}: {title}', { kind: kindLabel(it.kind), ref: it.kind === 'poll' ? '' : ref, title: it.title || '' }).replace(/\s+/g, ' '));
    var q = el('span', 'ec-q'); q.appendChild(main); card.appendChild(q);

    var opts = it.options || [];
    if (opts.length) {
      var box = el('span', 'ec-opts');
      var shown = opts.slice(0, 4);
      shown.forEach(function (o) {
        if (it.kind === 'market') {
          box.appendChild(optRow(o.name, (o.price || 0) * 100, pct(o.price), _t('js.embed.price_title', '{price} PAT per share', { price: (Number(o.price) || 0).toFixed(3) }), o.won));
        } else if (it.kind === 'pool') {
          var v = o.share + '%' + (o.mult ? ' · ' + _t('js.embed.mult', 'pays ×{mult}', { mult: Number(o.mult).toFixed(2) }) : '');
          box.appendChild(optRow(o.name, o.share, v, _t('js.embed.pool_title', '{pat} PAT on this option', { pat: num(o.pool) }), o.won));
        } else {
          box.appendChild(optRow(o.name, o.pct, o.pct + '% · ' + num(o.count), _t('js.embed.votes', '{count} votes', { count: o.count }), it.status === 'ended' && o.lead));
        }
      });
      if (opts.length > shown.length) box.appendChild(el('span', 'ec-more', _t('js.embed.more', '+{count} more', { count: opts.length - shown.length })));
      card.appendChild(box);
    }

    var foot = el('span', 'ec-foot');
    var facts = [];
    if (it.kind === 'market') facts.push(_t('js.embed.volume', '{pat} PAT traded', { pat: num(it.volume) }), _t('js.embed.traders', '{count} traders', { count: it.traders || 0 }));
    else if (it.kind === 'pool') facts.push(_t('js.embed.pot', '{pat} PAT in the pot', { pat: num(it.pot) }), _t('js.embed.bettors', '{count} bettors', { count: it.bettors || 0 }));
    else if (it.kind === 'poll') facts.push(_t('js.embed.votes', '{count} votes', { count: it.votes || 0 }));
    else facts.push(_t('js.embed.reward', '{pat} PAT reward', { pat: num(it.pot) }), _t('js.embed.claims', '{count} claims', { count: it.claims || 0 }));
    facts.forEach(function (f, i) { if (i) foot.appendChild(el('span', 'ec-dot', '·')).setAttribute('aria-hidden', 'true'); foot.appendChild(el('span', 'ec-fact', f)); });
    foot.appendChild(el('span', 'ec-dot', '·')).setAttribute('aria-hidden', 'true');
    if (it.pad && it.pad.url) {
      var pa = el('a', 'ec-pad', it.pad.title);
      pa.href = it.pad.url;
      pa.title = _t('js.embed.pad_title', 'The pad it belongs to');
      foot.appendChild(pa);
    } else {
      foot.appendChild(el('span', 'ec-pad ec-site', _t('js.embed.sitewide', 'Site-wide')));
    }
    card.appendChild(foot);
  }

  function flash(card) {
    if (reduce) return;
    card.classList.remove('ec-flash'); void card.offsetWidth; card.classList.add('ec-flash');
  }
  var sig = function (it) { return it ? JSON.stringify([it.status, it.options, it.volume, it.pot, it.votes, it.claims, it.result]) : ''; };

  function apply(items) {
    Object.keys(items).forEach(function (ref) {
      var it = items[ref], prev = data[ref];
      data[ref] = it;
      (cards[ref] || []).forEach(function (c) {
        if (!it) { // gone / not visible to this viewer: no card, the plain link (and its own preview) stay
          if (c.parentNode) c.parentNode.removeChild(c);
          if (c._lp) c._lp.style.display = '';
          return;
        }
        var changed = prev !== undefined && sig(prev) !== sig(it);
        var ae = document.activeElement, refocus = ae && c.contains(ae) ? (ae.classList.contains('ec-pad') ? '.ec-pad' : '.ec-main') : null;
        fill(c, it);
        if (refocus) { var f = c.querySelector(refocus); if (f && f.focus) f.focus(); }   // a refresh never drops keyboard focus
        if (!c.parentNode && c._at && c._at.parentNode) {
          var after = c._at._ecLast && c._at._ecLast.parentNode ? c._at._ecLast : c._at;   // several cards keep the links' order
          after.parentNode.insertBefore(c, after.nextSibling);
          c._at._ecLast = c;
        }
        if (c._lp) c._lp.style.display = 'none';   // one card per link: the live card replaces the post's own preview
        if (changed) flash(c);
      });
      if (!it) cards[ref] = [];
    });
  }

  function liveRefs() {
    return Object.keys(cards).filter(function (r) { var d = data[r]; return cards[r].length && (d === undefined || (d && !FINAL[d.status])); });
  }

  function fetchRefs(refs) {
    if (inflight) { queued = true; return Promise.resolve(); }
    if (!refs.length) return Promise.resolve();
    inflight = true;
    var chunks = [];
    for (var i = 0; i < refs.length; i += MAX_REFS) chunks.push(refs.slice(i, i + MAX_REFS));
    return Promise.all(chunks.map(function (c) {
      return fetch('/api/embeds?refs=' + encodeURIComponent(c.join(',')), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { if (!j || !j.ok) throw new Error('bad'); if (j.now) skew = j.now - Date.now(); apply(j.items || {}); });
    })).then(function () { backoff = EVERY; lastFetch = Date.now(); }, function () { backoff = Math.min(MAX_BACKOFF, backoff * 2); })
      .then(function () {
        inflight = false;
        if (queued) {   // links that showed up while a request was out: fetch them now, not on the next tick
          queued = false;
          var fresh = Object.keys(cards).filter(function (r) { return cards[r].length && data[r] === undefined; });
          if (fresh.length) return fetchRefs(fresh);
        }
        schedule();
      });
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (document.visibilityState === 'hidden') return;
    if (!liveRefs().length) return;
    timer = setTimeout(function () { timer = null; fetchRefs(liveRefs()); }, backoff);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { if (timer) { clearTimeout(timer); timer = null; } return; }
    if (Date.now() - lastFetch >= EVERY) fetchRefs(liveRefs()); else schedule();
  });

  // the countdowns tick once a second (text only - no motion)
  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    Object.keys(cards).forEach(function (ref) {
      var it = data[ref];
      if (!it || it.status !== 'open' || !it.closes) return;
      cards[ref].forEach(function (c) { var w = c.querySelector('[data-when]'); if (w) w.textContent = whenText(it); });
    });
  }, 1000);

  /** Find links in post bodies / comments / a post's link card and give each new item a card. */
  function scan(root) {
    var hosts = HOSTS.concat([location.hostname]);
    var links = (root || document).querySelectorAll('.fp-body a[href], .cm-body a[href], a.fp-link[href]');
    var fresh = [];
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.getAttribute('data-ec')) continue;
      a.setAttribute('data-ec', '1');
      if (a.closest('.ec')) continue;
      var ref = refFromHref(a.getAttribute('href'), location.href, hosts);
      if (!ref) continue;
      var isLp = a.classList.contains('fp-link');
      var body = isLp ? a : a.closest('.fp-body, .cm-body');
      var box = body && body.parentNode;
      if (!box) continue;
      box._ecRefs = box._ecRefs || {};
      var have = box._ecRefs[ref];
      if (have) { if (isLp) { have._lp = a; if (have.parentNode) a.style.display = 'none'; } continue; }
      if (Object.keys(box._ecRefs).length >= MAX_PER_BOX) continue;
      var card = el('div', 'ec');
      card.setAttribute('data-ref', ref);
      card._at = isLp ? a : body;
      if (isLp) card._lp = a;
      box._ecRefs[ref] = card;
      (cards[ref] = cards[ref] || []).push(card);
      if (data[ref] !== undefined) apply((function () { var o = {}; o[ref] = data[ref]; return o; })());
      else if (fresh.indexOf(ref) < 0) fresh.push(ref);
    }
    if (fresh.length) fetchRefs(fresh);
  }

  var pending = false;
  function later() { if (pending) return; pending = true; setTimeout(function () { pending = false; scan(document); }, 150); }
  function boot() {
    scan(document);
    if (window.MutationObserver) new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) if (ms[i].addedNodes && ms[i].addedNodes.length) { later(); return; }
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('patv:feed-swapped', later);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
