// pad-bridge-blocks.js — 1.99xa: the "Blocked from the web relay" part of the owner page's "Moderate your room" card
// (views/padOwner.ejs #poBblk). Lists this room's web-relay blocks (and the admins' global ones) and blocks / unblocks a web sender
// through /api/rooms/:slug/blocks (bridgeblocks.js: the pad's owner, site staff and the room's mods by Pepe's roles). Pepe enforces
// the same rows. Strings: __t (js.owner.bblk_*); user-visible text via textContent.
(function () {
  'use strict';
  var box = document.getElementById('poBblk');
  if (!box) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var slug = box.getAttribute('data-slug');
  var form = document.getElementById('poBblkForm'), msg = document.getElementById('poBblkMsg'), list = document.getElementById('poBblkList');
  var url = '/api/rooms/' + encodeURIComponent(slug) + '/blocks';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function when(ms) { var d = new Date(ms); return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function say(text, bad) { msg.textContent = text || ''; msg.className = 'ds-meta' + (bad ? ' bad' : ''); }
  function post(body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
      body: JSON.stringify(body) }).then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  function draw(rows) {
    list.textContent = '';
    if (!rows.length) { list.appendChild(el('li', 'muted', _t('js.owner.bblk_none', 'Nobody is blocked from the web relay here.'))); return; }
    rows.forEach(function (b) {
      var li = el('li');
      li.appendChild(el('b', null, '🌐 ' + (b.username || '?')));
      var bits = [b.until ? _t('js.owner.bblk_until', 'until {when}', { when: when(b.until) }) : _t('js.owner.bblk_lifted', 'until lifted')];
      if (b.global) bits.push(_t('js.owner.bblk_global', 'every room (PATV admins)'));
      if (b.reason) bits.push(b.reason);
      if (b.by) bits.push(_t('js.owner.bblk_by', 'by {name}', { name: b.by }));
      li.appendChild(el('span', 'ds-meta', ' · ' + bits.join(' · ') + ' '));
      if (!b.global) {
        var u = el('button', 'pm-btn', _t('js.owner.bblk_unblock', 'Unblock')); u.type = 'button';
        u.addEventListener('click', function () {
          u.disabled = true;
          post({ op: 'unblock', target: 'u:' + b.userId }).then(function () { say(_t('js.owner.bblk_unblocked', 'Unblocked.')); load(); })
            .catch(function (e) { u.disabled = false; say(e.message, true); });
        });
        li.appendChild(u);
      }
      list.appendChild(li);
    });
  }
  function load() {
    fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
      .then(function (d) { draw(d.blocks || []); })
      .catch(function (e) { say(e.message, true); });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var target = form.elements.target.value.trim();
    if (!target) return;
    say(_t('js.owner.bblk_working', 'Blocking…'));
    post({ op: 'block', target: target, hours: form.elements.hours.value, reason: form.elements.reason.value.trim() })
      .then(function (d) { form.reset(); say(_t('js.owner.bblk_done', '{name} can\'t talk into this room from the website now.', { name: (d.target && d.target.username) || target })); load(); })
      .catch(function (err) { say(err.message, true); });
  });
  load();
})();
