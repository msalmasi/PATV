// feed-filter-admin.js — the content filter admin page's test box (1.99ux, /feed/admin/filter). Admin-only page; the
// switches and lists use pepe-feed.js's generic forms. Results shown via textContent.
(function () {
  'use strict';
  var f = document.getElementById('ffTest'), out = document.getElementById('ffOut');
  if (!f || !out) return;
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    out.textContent = '…';
    fetch('/api/feed/admin/filter', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                                      body: JSON.stringify({ test: f.elements.text.value }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { out.textContent = (d && d.error) || 'Failed.'; return; }
        var lines = (d.hits || []).map(function (h) {
          return h.cat + (h.strength ? ' (' + h.strength + ')' : '') + ': ' + h.kinds.join(', ') + (h.terms && h.terms.length ? ' - ' + h.terms.join(' | ') : '');
        });
        out.textContent = (lines.length ? lines.join('\n') : 'Nothing caught.') + '\n' + (Math.round(d.ms * 1000) / 1000) + ' ms';
      })
      .catch(function () { out.textContent = 'Couldn\'t reach the site.'; });
  });
})();
