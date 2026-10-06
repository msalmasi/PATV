// pepe-feed.js — Pepe's feed settings forms (1.99cg): a room owner's card on /rooms/:slug/feed/mod, and the
// All (site-wide settings) + caps on /feed/admin. Same-site JSON fetches; the server checks who may change what.
(function () {
  'use strict';
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          return d;
        });
      });
  }
  function values(f) {
    var out = {};
    Array.prototype.forEach.call(f.elements, function (el) {
      if (!el.name) return;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }
  document.querySelectorAll('form.pf-form').forEach(function (f) {
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = f.querySelector('.fc-err');
      if (err) { err.textContent = ''; err.classList.remove('ok'); }
      var wrap = f.getAttribute('data-wrap') || 'settings', body = {};
      body[wrap] = values(f);
      var btn = f.querySelector('button[type=submit]');
      if (btn) btn.disabled = true;
      api(f.getAttribute('data-url'), body).then(function () {
        if (err) { err.textContent = 'Saved ✔'; err.classList.add('ok'); }
        setTimeout(function () { location.reload(); }, 600);
      }, function (e) {
        if (btn) btn.disabled = false;
        if (err) err.textContent = e.message; else alert(e.message);
      });
    });
  });
})();
