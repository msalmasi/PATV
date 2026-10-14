// pad-modlog.js — 1.99zf: the owner panel's "📜 Moderation history" (views/partials/po-modlog.ejs, pepemodlog.js).
// GET /api/rooms/:slug/modlog?cat=&q=&page= - this room only (the server pins it). Strings: __t (js.owner.ml_*); every
// user-visible value goes in via textContent.
(function () {
  'use strict';
  var box = document.getElementById('modlog');
  if (!box) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var slug = box.getAttribute('data-slug');
  var form = document.getElementById('poMlForm'), msg = document.getElementById('poMlMsg'), list = document.getElementById('poMlList');
  var newer = document.getElementById('poMlNewer'), older = document.getElementById('poMlOlder'), pageEl = document.getElementById('poMlPage');
  var CAT = { kick: _t('js.owner.ml_c_kick', 'kick'), ban: _t('js.owner.ml_c_ban', 'ban'), timeout: _t('js.owner.ml_c_timeout', 'time-out'),
    mic: _t('js.owner.ml_c_mic', 'mic'), roles: _t('js.owner.ml_c_roles', 'role'), automod: _t('js.owner.ml_c_automod', 'automod'),
    bridge: _t('js.owner.ml_c_bridge', 'web bridge'), room: _t('js.owner.ml_c_room', 'room'), misc: _t('js.owner.ml_c_misc', 'other') };
  var page = 0;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function when(ms) { return new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function say(text, bad) { msg.textContent = text || ''; msg.className = 'ds-meta' + (bad ? ' bad' : ''); }
  function what(r) {
    var t = String(r.type || '').replace(/^pepe_/, '').replace(/[_-]+/g, ' ');
    var s = (r.actor ? r.actor + ' · ' : '') + t + (r.target && r.target !== 'room' ? ' → ' + r.target : '');
    return s;
  }
  function draw(d) {
    list.textContent = '';
    var rows = d.rows || [];
    if (!rows.length) list.appendChild(el('li', 'muted', _t('js.owner.ml_none', 'Nothing in the moderation history yet.')));
    rows.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('span', 'po-ml-when', when(r.ts)));
      li.appendChild(el('span', 'po-ml-cat', CAT[r.cat] || r.cat || ''));
      li.appendChild(el('b', null, what(r)));
      if (r.details) li.appendChild(el('span', 'po-ml-det', ' - ' + r.details));
      list.appendChild(li);
    });
    newer.disabled = page <= 0;
    older.disabled = !d.more;
    pageEl.textContent = _t('js.owner.ml_page', 'Page {n}', { n: page + 1 });
  }
  function load() {
    var q = '?page=' + page + '&cat=' + encodeURIComponent(form.elements.cat.value) + '&q=' + encodeURIComponent(form.elements.q.value.trim());
    say(_t('js.owner.ml_loading', 'Loading…'));
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/modlog' + q, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); })
      .then(function (d) { say(''); draw(d); })
      .catch(function (e) { say(e.message, true); });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); page = 0; load(); });
  form.elements.cat.addEventListener('change', function () { page = 0; load(); });
  newer.addEventListener('click', function () { if (page > 0) { page--; load(); } });
  older.addEventListener('click', function () { page++; load(); });
  load();
})();
