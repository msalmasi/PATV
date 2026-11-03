// pad-reveal.js - wave 2 (incognito / mic-stage spec F.4, E.1, E.2; owner J-18): the pad page's Reveal client for the mic stage's
// hooded-frog COVER tiles. stage-mic.js asks it; the server decides and logs (seethrough.js, POST /api/chatlog/reveal {room, tile}:
// an Admin, or the pad's owner now; one seethrough_log row per Reveal, or counted on the viewer's J-18 toggle row).
//   PATVReveal.tile(slug, id[, {toggle: true}]) -> Promise<{ok: true, login, display} | {ok: false, error?, off?}>
//       a press on a cover's Reveal: one POST (scope stage_line). {toggle: true} = the toggle's auto-reveal (stage-mic.js, while it
//       is on): counted on the toggle's row; a 409 means the toggle is off (state -> false: not asked again until it goes on).
//   PATVReveal.state()       the J-18 toggle as this page knows it: true (on) | false (off) | null (not known yet)
//   PATVReveal.setState(v)   the pad chat's toggle bar (room.ejs) says what it learned or did
//   PATVReveal.on(fn)        fn(state) on every change; -> an unsubscribe
//   PATVReveal.offer()       a cover with Reveal is up: the pad chat offers its "Show real names" bar (room.ejs: onOffer(fn))
//   PATVReveal.can()         may this viewer turn the toggle on: true | false | null (not known yet) - the toggle's auto-reveal
//                            learns it (ok / 409 toggle_off = yes; 409 toggle_na = no: a role the toggle's rule refuses, e.g. an
//                            owner whose era nothing dates - integration review T-3). stage-mic.js offers the bar only when true.
// An answer is shown only on this page (stage-mic.js: a dashed edge + "{login} · only you can see this"); never kept or re-sent.
(function () {
  'use strict';
  if (window.PATVReveal) return;
  var ID_RE = /^anon-[0-9a-f]{8}$/, LOGIN_RE = /^[\w.\-]{1,40}$/;
  var state = null, can = null, subs = [], offers = [];
  function each(list, arg) { list.slice().forEach(function (fn) { try { fn(arg); } catch (e) { /* the listener's own */ } }); }
  function setState(v) {
    var s = v === true ? true : v === false ? false : null;
    if (s === state) return;
    state = s;
    each(subs, state);
  }
  function post(body) {
    return fetch('/api/chatlog/reveal', { method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { d = d && typeof d === 'object' ? d : {}; return { status: r.status, ok: !!(r.ok && d.ok), d: d }; });
      });
  }
  function tile(slug, id, opts) {
    var auto = !!(opts && opts.toggle === true);
    if (typeof slug !== 'string' || !slug || typeof id !== 'string' || !ID_RE.test(id)) return Promise.resolve({ ok: false });
    if (auto && state === false) return Promise.resolve({ ok: false, off: true });
    var body = { room: slug, tile: id };
    if (auto) body.toggle = true;
    if (opts && typeof opts.reason === 'string') body.reason = opts.reason;
    return post(body).then(function (r) {
      // 1.99aid (privacy controls S4t): a staff / moderator / owner Reveal while text reveal roles are on needs a reason - asked once
      if (!auto && r.status === 409 && r.d.code === 'reason_needed' && !(opts && typeof opts.reason === 'string') && typeof window.prompt === 'function') {
        var tr = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
        var why = window.prompt(tr('js.pad.veil.reveal_why', 'Why are you revealing this? (at least 3 characters - it\'s logged)'), '');
        if (why != null && String(why).trim().length >= 3) return tile(slug, id, { reason: String(why).trim().slice(0, 200) });
      }
      if (r.ok && typeof r.d.login === 'string' && LOGIN_RE.test(r.d.login)) {
        if (auto) { can = true; setState(true); }
        return { ok: true, login: r.d.login, display: typeof r.d.display === 'string' ? r.d.display : null };
      }
      if (auto && r.status === 409) {
        if (r.d.code === 'toggle_off') can = true;
        else if (r.d.code === 'toggle_na') can = false;          // (they can't turn it on here: never offered the bar)
        if (r.d.code !== 'privwire_off') setState(false);       // (the toggle is off; a switched-off wire has no rv covers anyway)
        return { ok: false, off: true };
      }
      return { ok: false, error: typeof r.d.error === 'string' ? r.d.error : '' };
    }, function () { return { ok: false, error: '' }; });
  }
  window.PATVReveal = {
    tile: tile,
    state: function () { return state; },
    can: function () { return can; },
    setState: setState,
    on: function (fn) {
      if (typeof fn !== 'function') return function () {};
      subs.push(fn);
      return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
    },
    offer: function () { each(offers); },
    onOffer: function (fn) { if (typeof fn === 'function') offers.push(fn); }
  };
})();
