// pad-owner-filter.js — the owner panel's "🧹 Content filter" card (1.99ux, feedfilter.js, views/padOwner.ejs #safety).
// Each control: POST /api/rooms/:slug/owner/filter {key, value} (or {key, reset: true}); the answer is the card's new
// state, painted at once. Release: POST /api/rooms/:slug/owner/filter/release {id} (un-hides it, closes the filter's
// report, tells the writer). A refused change flips back. Server text via textContent.
(function () {
  'use strict';
  var card = document.getElementById('safety');
  if (!card || !card.getAttribute('data-slug')) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var base = '/api/rooms/' + encodeURIComponent(card.getAttribute('data-slug')) + '/owner/filter';
  function q(sel) { return Array.prototype.slice.call(card.querySelectorAll(sel)); }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  function status(key, text, kind) {
    q('[data-pf-st="' + key + '"]').forEach(function (s) { s.textContent = text || ''; s.className = 'po-st' + (kind ? ' ' + kind : ''); });
  }
  function paint(st) {
    if (!st) return;
    var rows = { on: st.on };
    (st.cats || []).forEach(function (c) { rows['act_' + c] = st.actions[c]; });
    Object.keys(rows).forEach(function (k) {
      var it = rows[k];
      if (!it) return;
      q('[data-pf-set="' + k + '"]').forEach(function (c) { if (c.type === 'checkbox') c.checked = it.value === true; else c.value = String(it.value); });
      q('[data-pf-def="' + k + '"]').forEach(function (d) { d.hidden = !!it.own; });
      q('[data-pf-reset="' + k + '"]').forEach(function (b) { b.hidden = !it.own || !!st.locked; });
    });
  }
  function rowCtl(key, on) {
    q('[data-pf-row="' + key + '"] input, [data-pf-row="' + key + '"] select, [data-pf-row="' + key + '"] button').forEach(function (c) { c.disabled = !on; });
  }
  function send(key, body, revert) {
    status(key, _t('js.owner.saving', 'Saving…'), 'wait');
    rowCtl(key, false);
    post(base, Object.assign({ key: key }, body)).then(function (d) {
      rowCtl(key, true);
      if (!d || !d.ok) { if (revert) revert(); return status(key, (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
      paint(d.filter);
      status(key, body.reset ? _t('js.owner.site_reset_done', 'Back to the default.') : _t('js.owner.flt_saved', 'Saved - it applies to the next post or comment.'), 'ok');
    }).catch(function () { rowCtl(key, true); if (revert) revert(); status(key, _t('js.owner.unreachable_set', 'Couldn\'t reach the site.'), 'bad'); });
  }
  q('[data-pf-set]').forEach(function (c) {
    var key = c.getAttribute('data-pf-set');
    var shown = c.type === 'checkbox' ? c.checked : c.value;
    c.addEventListener('change', function () {
      var old = shown;
      var v = c.type === 'checkbox' ? c.checked : c.value;
      shown = v;
      send(key, { value: v }, function () { if (c.type === 'checkbox') c.checked = old; else c.value = old; shown = old; });
    });
  });
  q('[data-pf-reset]').forEach(function (b) {
    b.addEventListener('click', function () { send(b.getAttribute('data-pf-reset'), { reset: true }); });
  });
  q('[data-pf-release]').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      status('release', _t('js.owner.saving', 'Saving…'), 'wait');
      post(base + '/release', { id: Number(b.getAttribute('data-pf-release')) }).then(function (d) {
        if (!d || !d.ok) { b.disabled = false; return status('release', (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
        var li = b.closest('li');
        if (li) {
          var chip = li.querySelector('.ds-chip');
          if (chip) { chip.className = 'ds-chip ok'; chip.textContent = _t('js.owner.flt_released', 'Released'); }
        }
        b.remove();
        status('release', _t('js.owner.flt_released_msg', 'Released - the writer has been told.'), 'ok');
      }).catch(function () { b.disabled = false; status('release', _t('js.owner.unreachable_set', 'Couldn\'t reach the site.'), 'bad'); });
    });
  });
})();
