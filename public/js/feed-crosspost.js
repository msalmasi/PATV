// feed-crosspost.js — the Crosspost dialog (1.99ci; multi-pad 1.99ct). Opened from a post's "more" menu or
// the post page's bar (feed.js -> patvCrosspost.open(postId, title)). Lists the pads with checkboxes
// (GET /api/feed/communities?post=<id>: canPost per the owners' settings and bans; where the post already is,
// or is already crossposted, shows greyed out with the reason), up to crosspostMax of them at once, plus an
// optional new title for all of them. POST /api/feed/posts/:id/crosspost {communities: [...], title} makes one
// crosspost per pad; the dialog then shows each pad's result (crossposted / waiting for approval / refused +
// why) with links to the new crossposts. 1.99cu: under the chips, "Pepe announces it in the Camfrog room" per
// picked pad - ticked when he can (announcements on, the default for Camfrog pads, and Pepe in the room), greyed
// out with the reason otherwise; the ticked ones go as announce: [...]. Everything is built with DOM calls (textContent), nothing
// user-supplied goes through innerHTML.
(function () {
  'use strict';
  if (window.patvCrosspost) return;

  function api(url, body, method) {
    return fetch(url, {
      method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) { var e = new Error(d.error || ('HTTP ' + r.status)); e.code = d.code; throw e; }
        return d;
      });
    });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function badge(c) {
    var b = el('span', 'cbadge sm');
    b.setAttribute('aria-hidden', 'true');
    b.style.setProperty('--h', String(hue(c.slug || '')));
    b.textContent = c.community ? '🛋️' : c.house ? '🐸' : (String(c.title || '?').replace(/^[^A-Za-z0-9]+/, '').charAt(0) || '?').toUpperCase();
    return b;
  }
  // 1.99x: the pad's platform badge (same look as pads.js padBadge, compact)
  var PLAT = { camfrog: ['🐸', 'Camfrog Pad'], site: ['🌐', 'Site Pad'], twitch: ['🟣', 'Twitch Pad'], discord: ['💬', 'Discord Pad'] };
  function platBadge(c) {
    var p = PLAT[c.platform] ? c.platform : (c.community ? 'site' : 'camfrog');
    var b = el('span', 'pad-plat sm pp-' + p, PLAT[p][0]);
    b.title = PLAT[p][1];
    return b;
  }

  var dlg = null, state = null;
  function build() {
    dlg = el('dialog', 'xp-dlg');
    dlg.setAttribute('aria-labelledby', 'xpH');
    // the picker
    var f = el('form', 'xp-f');
    f.setAttribute('novalidate', '');
    var h = el('h2', null, 'Crosspost'); h.id = 'xpH';
    var sub = el('p', 'xp-sub', '');
    var lrow = el('div', 'xp-lrow');
    var l1 = el('div', 'xp-l', 'Pads');
    var sum = el('span', 'xp-sum', '');
    sum.setAttribute('aria-live', 'polite');
    lrow.appendChild(l1); lrow.appendChild(sum);
    var sw = el('label', 'cb-search');
    var si = el('input'); si.type = 'search'; si.placeholder = 'Search pads'; si.setAttribute('aria-label', 'Search pads'); si.autocomplete = 'off';
    sw.appendChild(si);
    var list = el('div', 'xp-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Pads');
    var chips = el('div', 'xp-chips');
    var anns = el('div', 'xp-anns');
    var l2 = el('label', 'xp-l', 'Title '); l2.appendChild(el('small', null, '(optional, for every pad - leave it to keep the original\'s)'));
    var ti = el('input', 'xp-title'); ti.name = 'title'; ti.maxLength = 140; ti.autocomplete = 'off';
    l2.htmlFor = ti.id = 'xpTitle';
    var err = el('p', 'fc-err xp-err'); err.setAttribute('role', 'alert');
    var row = el('div', 'xp-btns');
    var cancel = el('button', 'btn-g', 'Cancel'); cancel.type = 'button';
    var go = el('button', 'btn-s', 'Crosspost'); go.type = 'submit';
    row.appendChild(cancel); row.appendChild(go);
    [h, sub, lrow, sw, list, chips, anns, l2, ti, err, row].forEach(function (x) { f.appendChild(x); });
    // the results
    var res = el('div', 'xp-res hide');
    res.setAttribute('role', 'status');
    dlg.appendChild(f); dlg.appendChild(res);
    document.body.appendChild(dlg);
    state = { f: f, sub: sub, sum: sum, si: si, list: list, chips: chips, anns: anns, ann: {}, annOff: {}, ti: ti, err: err, go: go, res: res, max: 5, made: 0 };
    cancel.addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });     // the backdrop
    dlg.addEventListener('close', function () { if (state.made) location.reload(); });
    si.addEventListener('input', filter);
    si.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var first = list.querySelector('.xp-it:not(.hide) input:not([disabled]):not(:checked)');
      if (first) { first.checked = true; sync(); }
    });
    list.addEventListener('change', sync);
    chips.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-id]');
      if (!b) return;
      var box = list.querySelector('input[value="' + CSS.escape(b.getAttribute('data-id')) + '"]');
      if (box) { box.checked = false; sync(); }
    });
    f.addEventListener('submit', submit);
  }
  function filter() {
    var n = state.si.value.trim().toLowerCase(), any = false;
    state.list.querySelectorAll('.xp-it').forEach(function (it) { var hit = !n || it.getAttribute('data-name').indexOf(n) >= 0; it.classList.toggle('hide', !hit); any = any || hit; });
    var none = state.list.querySelector('.xp-none'); if (none) none.classList.toggle('hide', any);
  }
  function picked() { return Array.prototype.slice.call(state.list.querySelectorAll('input[name=community]:checked')); }
  // the "N selected" summary, the chips, the cap (usable boxes lock once max are ticked) and the button label
  function sync() {
    var on = picked(), full = on.length >= state.max;
    state.list.querySelectorAll('.xp-it').forEach(function (it) {
      var box = it.querySelector('input');
      if (it.classList.contains('off')) return;
      var lock = full && !box.checked;
      box.disabled = lock;
      it.classList.toggle('capped', lock);
      it.title = lock ? 'You can pick up to ' + state.max + ' pads at a time' : '';
    });
    state.sum.textContent = on.length ? on.length + ' of ' + state.max + ' selected' : 'Pick up to ' + state.max;
    state.sum.classList.toggle('full', full);
    state.chips.textContent = '';
    on.forEach(function (box) {
      var c = el('button', 'xp-chip'); c.type = 'button';
      c.setAttribute('data-id', box.value);
      c.setAttribute('aria-label', 'Remove p/' + box.getAttribute('data-slug'));
      c.appendChild(document.createTextNode('p/' + box.getAttribute('data-slug')));
      c.appendChild(el('span', 'x', '×'));
      state.chips.appendChild(c);
    });
    syncAnn(on);
    state.go.textContent = on.length > 1 ? 'Crosspost to ' + on.length + ' pads' : 'Crosspost';
    if (on.length && !state.go.disabled) state.err.textContent = '';
  }
  // 1.99cu: one announce line per picked pad (enabled + ticked, or greyed out with the reason)
  function syncAnn(on) {
    var A = state.anns;
    A.textContent = '';
    on.forEach(function (box) {
      var id = box.value, a = state.ann[id] || { ok: false, why: 'Announcements are off for this pad' };
      var w = el('div', 'xp-ann-w');
      var l = el('label', 'xp-ann' + (a.ok ? '' : ' off'));
      var c = el('input'); c.type = 'checkbox'; c.name = 'announce'; c.value = id;
      if (a.ok) { c.checked = !state.annOff[id]; c.addEventListener('change', function () { state.annOff[id] = !c.checked; }); }
      else { c.disabled = true; l.setAttribute('aria-disabled', 'true'); l.title = a.why || ''; }
      l.appendChild(c);
      l.appendChild(document.createTextNode(' 🐸📣 Pepe announces it in p/' + box.getAttribute('data-slug')));
      w.appendChild(l);
      if (!a.ok) {
        var why = el('small', 'xp-ann-why', ' ' + (a.why || ''));
        if (a.manage) {
          why.appendChild(document.createTextNode(' · '));
          var link = el('a', null, 'turn on in Moderate'); link.href = '/p/' + encodeURIComponent(box.getAttribute('data-slug')) + '/mod#announce';
          why.appendChild(link);
        }
        w.appendChild(why);
      }
      A.appendChild(w);
    });
  }
  function fill(comms) {
    var L = state.list;
    L.textContent = '';
    var usable = 0;
    state.ann = {}; state.annOff = {};
    comms.forEach(function (c) {
      if (c.ann) state.ann[c.id] = c.ann;
      var it = el('label', 'xp-it');
      it.setAttribute('data-name', (c.title + ' ' + c.slug).toLowerCase());
      var r = el('input'); r.type = 'checkbox'; r.name = 'community'; r.value = c.id;
      r.setAttribute('data-slug', c.slug); r.setAttribute('data-title', c.title);
      var off = !c.canPost || c.here;
      if (off) { r.disabled = true; it.classList.add('off'); it.title = c.here ? 'Already there' : (c.refusal || 'You can\'t post there'); }
      else usable++;
      var t = el('span', 't');
      t.appendChild(el('b', null, c.title));
      var sm = el('small'); sm.appendChild(platBadge(c)); t.appendChild(sm);
      sm.appendChild(document.createTextNode(' p/' + c.slug + (c.here ? ' · already there' : !c.canPost ? ' · ' + (c.refusal || 'you can\'t post here') : ' · ' + plural(c.followers, 'follower'))));
      it.appendChild(r); it.appendChild(el('span', 'xp-ck')); it.appendChild(badge(c)); it.appendChild(t);
      L.appendChild(it);
    });
    L.appendChild(el('p', 'cb-none xp-none hide', 'No pad matches.'));
    // usable ones first, greyed-out ones after
    Array.prototype.slice.call(L.querySelectorAll('.xp-it.off')).forEach(function (x) { L.insertBefore(x, L.querySelector('.xp-none')); });
    if (!usable) state.err.textContent = 'There\'s no other pad you can crosspost this to right now.';
    sync();
  }
  var ST = { created: ['✔', 'Crossposted', 'ok'], pending: ['⏳', 'Waiting for the pad owner\'s approval', 'wait'], refused: ['✖', 'Not crossposted', 'no'] };
  function showResults(d) {
    var R = state.res;
    R.textContent = '';
    var h = el('h2', null, 'Crosspost'); h.id = 'xpH2';
    var bits = [];
    if (d.created) bits.push(d.created + ' crossposted');
    if (d.pending) bits.push(d.pending + ' waiting for approval');
    if (d.refused) bits.push(d.refused + ' refused');
    var s = el('p', 'xp-sub', bits.join(' · ') || 'Nothing was crossposted.');
    var ul = el('ul', 'xp-rl');
    (d.results || []).forEach(function (x) {
      var st = ST[x.status] || ST.refused;
      var li = el('li', 'xp-r xp-r-' + st[2]);
      li.appendChild(el('span', 'xp-ri', st[0]));
      var t = el('span', 't');
      var top = el('span', 'xp-rt');
      top.appendChild(el('b', null, x.pad ? x.pad.title : x.community));
      if (x.pad) top.appendChild(el('small', null, ' p/' + x.pad.slug));
      t.appendChild(top);
      t.appendChild(el('small', 'xp-rs', x.status === 'refused' ? (x.error || st[1]) : st[1]));
      li.appendChild(t);
      if (x.url) { var a = el('a', 'xp-ro', 'Open'); a.href = x.url; li.appendChild(a); }
      ul.appendChild(li);
    });
    var row = el('div', 'xp-btns');
    var done = el('button', 'btn-s', 'Done'); done.type = 'button';
    done.addEventListener('click', function () { dlg.close(); });
    row.appendChild(done);
    [h, s, ul, row].forEach(function (x) { R.appendChild(x); });
    state.made = (d.created || 0) + (d.pending || 0);
    state.f.classList.add('hide'); R.classList.remove('hide');
    dlg.setAttribute('aria-labelledby', 'xpH2');
    done.focus();
  }
  function submit(ev) {
    ev.preventDefault();
    var on = picked();
    state.err.classList.remove('ok');
    if (!on.length) { state.err.textContent = 'Choose at least one pad.'; return; }
    state.err.textContent = '';
    state.go.disabled = true; state.go.textContent = 'Crossposting…';
    var body = { pads: on.map(function (b) { return b.value; }), title: state.ti.value.trim(),
                 announce: on.map(function (b) { return b.value; }).filter(function (id) { return state.ann[id] && state.ann[id].ok && !state.annOff[id]; }) };
    var url = '/api/feed/posts/' + encodeURIComponent(state.post) + '/crosspost';
    api(url, body).catch(function (e) {
      if (e.code !== 'terms' || !window.patvSafety) throw e;
      return window.patvSafety.termsAsk().then(function (yes) {
        if (!yes) throw new Error('You need to accept the Terms of Service to post.');
        body.acceptTerms = true;
        return api(url, body);
      });
    }).then(showResults).catch(function (e) {
      state.err.textContent = e.message;
      state.go.disabled = false; sync();
    });
  }

  window.patvCrosspost = {
    open: function (postId, title) {
      if (!postId) return;
      if (!dlg) build();
      state.post = postId; state.made = 0;
      state.f.classList.remove('hide'); state.res.classList.add('hide'); state.res.textContent = '';
      dlg.setAttribute('aria-labelledby', 'xpH');
      state.ti.value = ''; state.ti.placeholder = title || 'Same title as the original';
      state.si.value = ''; state.err.textContent = ''; state.err.classList.remove('ok');
      state.go.disabled = false; state.go.textContent = 'Crosspost';
      state.sum.textContent = ''; state.chips.textContent = '';
      state.sub.textContent = 'Share this post in other pads. Each crosspost links back to the original; votes and comments there are its own, and each pad\'s rules apply.';
      state.list.textContent = '';
      state.list.appendChild(el('p', 'mut', 'Loading pads…'));
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      api('/api/feed/communities?post=' + encodeURIComponent(postId)).then(function (d) {
        state.max = Math.max(1, Number(d.crosspostMax) || 5);
        fill(d.communities || []); filter();
      }).catch(function (e) { state.list.textContent = ''; state.err.textContent = e.message; });
    }
  };
})();
