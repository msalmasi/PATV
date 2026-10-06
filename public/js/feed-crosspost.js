// feed-crosspost.js — the Crosspost dialog (1.99ci). Opened from a post's "more" menu or the post page's
// bar (feed.js -> patvCrosspost.open(postId, title)). Lists the communities this account may post in
// (GET /api/feed/communities?post=<id>: canPost per the owners' settings and bans; where the post already
// is shows greyed out), an optional new title, then POST /api/feed/posts/:id/crosspost and opens the new
// post. Everything is built with DOM calls (textContent), nothing user-supplied goes through innerHTML.
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
    var f = el('form', 'xp-f');
    f.setAttribute('novalidate', '');
    var h = el('h2', null, 'Crosspost'); h.id = 'xpH';
    var sub = el('p', 'xp-sub', 'Share this post in another pad. It links back to the original; votes and comments there are its own, and that pad\'s rules apply.');
    var l1 = el('div', 'xp-l', 'Pad');
    var sw = el('label', 'cb-search');
    var si = el('input'); si.type = 'search'; si.placeholder = 'Search pads'; si.setAttribute('aria-label', 'Search pads'); si.autocomplete = 'off';
    sw.appendChild(si);
    var list = el('div', 'xp-list'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', 'Pads');
    var l2 = el('label', 'xp-l', 'Title '); l2.appendChild(el('small', null, '(optional - leave it to keep the original\'s)'));
    var ti = el('input', 'xp-title'); ti.name = 'title'; ti.maxLength = 140; ti.autocomplete = 'off';
    l2.htmlFor = ti.id = 'xpTitle';
    var err = el('p', 'fc-err xp-err'); err.setAttribute('role', 'alert');
    var row = el('div', 'xp-btns');
    var cancel = el('button', 'btn-g', 'Cancel'); cancel.type = 'button';
    var go = el('button', 'btn-s', 'Crosspost'); go.type = 'submit';
    row.appendChild(cancel); row.appendChild(go);
    [h, sub, l1, sw, list, l2, ti, err, row].forEach(function (x) { f.appendChild(x); });
    dlg.appendChild(f);
    document.body.appendChild(dlg);
    state = { f: f, si: si, list: list, ti: ti, err: err, go: go };
    cancel.addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });     // the backdrop
    si.addEventListener('input', filter);
    si.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var first = list.querySelector('.xp-it:not(.hide) input:not([disabled])');
      if (first) first.checked = true;
    });
    f.addEventListener('submit', submit);
  }
  function filter() {
    var n = state.si.value.trim().toLowerCase(), any = false;
    state.list.querySelectorAll('.xp-it').forEach(function (it) { var hit = !n || it.getAttribute('data-name').indexOf(n) >= 0; it.classList.toggle('hide', !hit); any = any || hit; });
    var none = state.list.querySelector('.xp-none'); if (none) none.classList.toggle('hide', any);
  }
  function fill(comms) {
    var L = state.list;
    L.textContent = '';
    var usable = 0;
    comms.forEach(function (c) {
      var it = el('label', 'xp-it');
      it.setAttribute('data-name', (c.title + ' ' + c.slug).toLowerCase());
      var r = el('input'); r.type = 'radio'; r.name = 'community'; r.value = c.id;
      var off = !c.canPost || c.here;
      if (off) { r.disabled = true; it.classList.add('off'); it.title = c.here ? 'Already there' : (c.refusal || 'You can\'t post there'); }
      else usable++;
      var t = el('span', 't');
      t.appendChild(el('b', null, c.title));
      var sm = el('small'); sm.appendChild(platBadge(c)); t.appendChild(sm);
      sm.appendChild(document.createTextNode(' p/' + c.slug + (c.here ? ' · already there' : !c.canPost ? ' · ' + (c.refusal || 'you can\'t post here') : ' · ' + c.followers + ' follower' + (c.followers === 1 ? '' : 's'))));
      it.appendChild(r); it.appendChild(badge(c)); it.appendChild(t);
      L.appendChild(it);
    });
    L.appendChild(el('p', 'cb-none xp-none hide', 'No pad matches.'));
    // usable ones first, greyed-out ones after
    Array.prototype.slice.call(L.querySelectorAll('.xp-it.off')).forEach(function (x) { L.insertBefore(x, L.querySelector('.xp-none')); });
    if (!usable) state.err.textContent = 'There\'s no other pad you can crosspost this to right now.';
  }
  function submit(ev) {
    ev.preventDefault();
    var pick = state.list.querySelector('input[name=community]:checked');
    state.err.classList.remove('ok');
    if (!pick) { state.err.textContent = 'Choose a pad.'; return; }
    state.err.textContent = '';
    state.go.disabled = true; state.go.textContent = 'Crossposting…';
    var body = { community: pick.value, title: state.ti.value.trim() };
    var url = '/api/feed/posts/' + encodeURIComponent(state.post) + '/crosspost';
    api(url, body).catch(function (e) {
      if (e.code !== 'terms' || !window.patvSafety) throw e;
      return window.patvSafety.termsAsk().then(function (yes) {
        if (!yes) throw new Error('You need to accept the Terms of Service to post.');
        body.acceptTerms = true;
        return api(url, body);
      });
    }).then(function (d) {
      state.err.classList.add('ok');
      state.err.textContent = d.pending ? 'Sent - it shows once the pad\'s owner approves it.' : 'Crossposted ✔';
      setTimeout(function () { location.href = d.url; }, d.pending ? 1400 : 300);
    }).catch(function (e) {
      state.err.textContent = e.message;
      state.go.disabled = false; state.go.textContent = 'Crosspost';
    });
  }

  window.patvCrosspost = {
    open: function (postId, title) {
      if (!postId) return;
      if (!dlg) build();
      state.post = postId;
      state.ti.value = ''; state.ti.placeholder = title || 'Same title as the original';
      state.si.value = ''; state.err.textContent = ''; state.err.classList.remove('ok');
      state.go.disabled = false; state.go.textContent = 'Crosspost';
      state.list.textContent = '';
      state.list.appendChild(el('p', 'mut', 'Loading pads…'));
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      api('/api/feed/communities?post=' + encodeURIComponent(postId)).then(function (d) { fill(d.communities || []); filter(); })
        .catch(function (e) { state.list.textContent = ''; state.err.textContent = e.message; });
    }
  };
})();
