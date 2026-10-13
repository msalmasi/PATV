// public/js/shopart.js - 1.99xr: the "🎨 Generate image" button on shop item forms (views/partials/shopart-gen.ejs, shopart.js).
// Every widget starts hidden; one GET /api/shopart/status decides whether this account may generate (else they stay hidden).
// Generate / Regenerate: POST /api/shopart/generate with the form's title, description and category + the widget's spotlight
// and picture notes -> a private preview. "Use this picture": POST /api/shopart/accept -> the public path goes into the
// form's image_url field (saved with the item like any picture path). All strings come from the widget's data-s-* attributes.
(function () {
  'use strict';
  if (window.__shopartLoaded) return;
  window.__shopartLoaded = true;

  function post(url, body) {
    return fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (j) { j = j || {}; j.httpOk = r.ok; return j; });
    });
  }
  function fill(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? String(vars[k]) : m; });
  }
  function field(form, sel) { var el = form && form.querySelector(sel); return el ? String(el.value || '').trim() : ''; }

  function wire(w, st) {
    var form = w.closest('form');
    var msg = w.querySelector('[data-sa-msg]'), left = w.querySelector('[data-sa-left]');
    var prev = w.querySelector('[data-sa-prev]'), img = w.querySelector('[data-sa-img]');
    var current = null;
    function say(text, cls) { msg.textContent = text || ''; msg.className = 'sa-msg' + (cls ? ' ' + cls : ''); }
    function showLeft(l) { if (left && l) left.textContent = fill(w.getAttribute('data-s-left'), { hour: l.hour, day: l.day }); }
    showLeft(st.left);
    function go() {
      if (w.classList.contains('busy')) return;
      var title = field(form, '[name="title"]') || field(form, '[name="prizeName"]');
      if (title.length < 3) { say(w.getAttribute('data-s-need-title'), 'err'); return; }
      w.classList.add('busy');
      say(w.getAttribute('data-s-working'));
      post('/api/shopart/generate', {
        title: title, description: field(form, '[name="description"]'), category: field(form, '[name="category"]'),
        shelf: field(w, '[data-sa-shelf]'), extra: field(w, '[data-sa-extra]')
      }).then(function (j) {
        if (!j.ok) { say(j.error || w.getAttribute('data-s-failed'), 'err'); return; }
        current = j;
        img.src = j.preview;
        prev.hidden = false;
        showLeft(j.left);
        say('');
      }).catch(function () { say(w.getAttribute('data-s-failed'), 'err'); })
        .then(function () { w.classList.remove('busy'); });
    }
    w.querySelector('[data-sa-go]').addEventListener('click', go);
    w.querySelector('[data-sa-again]').addEventListener('click', go);
    w.querySelector('[data-sa-use]').addEventListener('click', function () {
      if (!current || w.classList.contains('busy')) return;
      w.classList.add('busy');
      post('/api/shopart/accept', { id: current.id }).then(function (j) {
        if (!j.ok) { say(j.error || w.getAttribute('data-s-failed'), 'err'); return; }
        var input = form && form.querySelector('[name="image_url"]');
        if (input) {
          input.value = j.url;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        say(w.getAttribute('data-s-used'), 'ok');
      }).catch(function () { say(w.getAttribute('data-s-failed'), 'err'); })
        .then(function () { w.classList.remove('busy'); });
    });
    // a form reset (the classic editor's dialog) clears the preview too
    if (form) form.addEventListener('reset', function () { current = null; prev.hidden = true; img.removeAttribute('src'); say(''); });
    w.hidden = false;
  }

  function start() {
    var ws = document.querySelectorAll('[data-shopart]');
    if (!ws.length) return;
    fetch('/api/shopart/status', { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (st) {
        if (!st || !st.ok || !st.available) return;          // no key / switched off / below the level: stays hidden
        Array.prototype.forEach.call(ws, function (w) { wire(w, st); });
      })
      .catch(function () { /* stays hidden */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
