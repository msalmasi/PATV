// pad-owner-site.js — the owner panel's "🌐 Pepe on your pad's page" card (1.99up, padsite.js, views/padOwner.ejs #site).
// Each control: POST /api/rooms/:slug/owner/site {key, value} (or {key, reset: true}); the answer is the card's new
// state (the effective values, which ones follow the default) - the site applies these itself, so the control shows the
// saved value at once; Pepe follows it from his next feed check. A refused change flips back. Server text via textContent.
(function () {
  'use strict';
  var card = document.getElementById('site');
  if (!card || !card.getAttribute('data-slug')) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var base = '/api/rooms/' + encodeURIComponent(card.getAttribute('data-slug')) + '/owner/site';
  function q(sel) { return Array.prototype.slice.call(card.querySelectorAll(sel)); }
  function post(body) {
    return fetch(base, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  function status(key, text, kind) {
    q('[data-ps-st="' + key + '"]').forEach(function (s) { s.textContent = text || ''; s.className = 'po-st' + (kind ? ' ' + kind : ''); });
  }
  function paint(st) {
    if (!st || !st.values) return;
    Object.keys(st.values).forEach(function (k) {
      var it = st.values[k];
      q('[data-ps-set="' + k + '"]').forEach(function (c) {
        if (c.type === 'checkbox') c.checked = it.value === true;
        else if (it.value !== 'custom') c.value = String(it.value);
      });
      if (k === 'post_kinds') {
        q('[data-ps-kind]').forEach(function (c) { c.checked = it.value === null || (it.value || []).indexOf(c.getAttribute('data-ps-kind')) !== -1; });
      }
      q('[data-ps-def="' + k + '"]').forEach(function (d) { d.hidden = !!it.own; });
      q('[data-ps-reset="' + k + '"]').forEach(function (b) { b.hidden = !it.own || !!it.locked; });
    });
  }
  function send(key, body, revert) {
    status(key, _t('js.owner.saving', 'Saving…'), 'wait');
    q('[data-ps-row="' + key + '"] input, [data-ps-row="' + key + '"] select, [data-ps-row="' + key + '"] button').forEach(function (c) { c.disabled = true; });
    var done = function () { q('[data-ps-row="' + key + '"] input, [data-ps-row="' + key + '"] select, [data-ps-row="' + key + '"] button').forEach(function (c) { c.disabled = false; }); };
    post(Object.assign({ key: key }, body)).then(function (d) {
      done();
      if (!d || !d.ok) { if (revert) revert(); return status(key, (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
      paint(d.site);
      status(key, body.reset ? _t('js.owner.site_reset_done', 'Back to the default.') : _t('js.owner.site_saved', 'Saved - Pepe follows it from his next feed check.'), 'ok');
    }).catch(function () { done(); if (revert) revert(); status(key, _t('js.owner.unreachable_set', 'Couldn\'t reach the site.'), 'bad'); });
  }
  q('[data-ps-set]').forEach(function (c) {
    var key = c.getAttribute('data-ps-set');
    var shown = c.type === 'checkbox' ? c.checked : c.value;
    c.addEventListener('change', function () {
      var old = shown;
      var v = c.type === 'checkbox' ? c.checked : c.value;
      shown = v;
      send(key, { value: v }, function () { if (c.type === 'checkbox') c.checked = old; else c.value = old; shown = old; });
    });
  });
  q('[data-ps-kind]').forEach(function (c) {
    c.addEventListener('change', function () {
      var picked = q('[data-ps-kind]').filter(function (x) { return x.checked; }).map(function (x) { return x.getAttribute('data-ps-kind'); });
      send('post_kinds', { value: picked }, function () { c.checked = !c.checked; });
    });
  });
  q('[data-ps-reset]').forEach(function (b) {
    b.addEventListener('click', function () { send(b.getAttribute('data-ps-reset'), { reset: true }); });
  });
})();
