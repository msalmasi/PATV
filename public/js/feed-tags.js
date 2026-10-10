// feed-tags.js — content tags in the browser (1.99iq, feedtags.js):
//   * a pad mod's ✕ on a post's tag (.ftag-x[data-tagrm]) takes it off (POST /api/feed/posts/<id>/tags/remove)
//   * the composer's tag box: suggestion chips (the picked pad's popular tags, else the site's) add a tag; the box
//     itself is plain text ("plants, diy") - the server normalises it
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  if (window.__patvTags) return;
  window.__patvTags = true;

  function api(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('.ftag-x[data-tagrm]');
    if (!b) return;
    ev.preventDefault();
    var art = b.closest('.fp');
    var id = art && art.getAttribute('data-id');
    var tag = b.getAttribute('data-tagrm');
    if (!id || !tag) return;
    if (!window.confirm(_t('js.feed.tags.remove', 'Remove the tag #{tag} from this post? The author can\'t put it back.', { tag: tag }))) return;
    b.disabled = true;
    api('/api/feed/posts/' + encodeURIComponent(id) + '/tags/remove', { tag: tag, room: b.getAttribute('data-room') || undefined }).then(function () {
      var w = b.closest('.ftag-w');
      if (w) w.remove();
      var row = art.querySelector('.fp-tags');
      if (row && !row.querySelector('.ftag')) row.remove();
    }).catch(function (e) { b.disabled = false; alert(e.message); });
  });

  // ── the composer's suggestions ──
  var form = document.getElementById('fcForm');
  var box = form && form.querySelector('input[name=tags]');
  var chips = form && form.querySelector('[data-tag-suggest]');
  if (!form || !box || !chips) return;
  var all = {};
  try { all = JSON.parse(chips.getAttribute('data-tag-suggest') || '{}') || {}; } catch (e) { all = {}; }
  var max = Number(chips.getAttribute('data-max')) || 5;
  function current() { return box.value.split(/[,#\n]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean); }
  function picked() { var x = form.querySelector('input[name=community]:checked'); return x ? x.value : ''; }
  function paint() {
    var list = (all[picked()] || []).slice();
    (all[''] || []).forEach(function (t) { if (list.indexOf(t) < 0) list.push(t); });
    var have = current();
    list = list.filter(function (t) { return have.indexOf(t) < 0; }).slice(0, 10);
    chips.textContent = '';
    chips.hidden = !list.length || have.length >= max;
    list.forEach(function (t) {
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'ftag sug'; c.textContent = '#' + t;
      c.setAttribute('aria-label', _t('js.feed.tags.add', 'Add the tag {tag}', { tag: t }));
      c.addEventListener('click', function () {
        var h = current();
        if (h.length >= max || h.indexOf(t) >= 0) return;
        h.push(t);
        box.value = h.join(', ');
        box.dispatchEvent(new Event('input', { bubbles: true }));
        paint();
      });
      chips.appendChild(c);
    });
  }
  form.addEventListener('change', function (ev) { if (ev.target && ev.target.name === 'community') paint(); });
  box.addEventListener('input', paint);
  paint();
})();
