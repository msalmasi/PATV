// pad-create.js — /pads/new (1.99iz, padcreate.js): the address follows the name until it's edited, is checked as it changes
// (GET /api/pads/check-slug), and the form posts JSON (same-site) to /api/pads/create, then opens the new pad's settings.
(function () {
  'use strict';
  var form = document.getElementById('pcForm');
  if (!form) return;
  var title = document.getElementById('pcTitle');
  var slug = document.getElementById('pcSlug');
  var slugMsg = document.getElementById('pcSlugMsg');
  var hint = slugMsg.textContent;
  var msg = document.getElementById('pcMsg');
  var go = document.getElementById('pcGo');
  var touched = false, timer = null, seq = 0, okSlug = null;
  function fold(s) {
    return String(s || '').trim().toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  }
  function say(el, t, cls) { el.textContent = t || ''; el.className = (el === slugMsg ? 'muted ' : 'msg ') + (cls || ''); }
  function check() {
    var v = slug.value.trim();
    var my = ++seq;
    okSlug = null;
    if (!v) { say(slugMsg, hint); return; }
    fetch('/api/pads/check-slug?slug=' + encodeURIComponent(v), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (my !== seq) return;
        if (!d || d.ok === false) { say(slugMsg, (d && d.error) || 'Could not check that.', 'pc-bad'); return; }
        if (d.problem) { say(slugMsg, d.problem, 'pc-bad'); return; }
        okSlug = d.slug;
        say(slugMsg, '✓ p/' + d.slug + ' is free.', 'pc-ok');
      })
      .catch(function () { if (my === seq) say(slugMsg, 'Could not check that right now.', 'pc-bad'); });
  }
  function later() { clearTimeout(timer); timer = setTimeout(check, 300); }
  title.addEventListener('input', function () { if (!touched) { slug.value = fold(title.value); later(); } });
  slug.addEventListener('input', function () { touched = slug.value.trim() !== ''; later(); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; return; }
      o[el.name] = el.value;
    });
    if (!o.slug) o.slug = fold(o.title);
    go.disabled = true;
    say(msg, 'Creating…');
    fetch('/api/pads/create', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(o) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (d) {
        if (!d || d.ok === false) { say(msg, (d && d.error) || 'Could not create it.', 'pc-bad'); go.disabled = false; return; }
        say(msg, 'Done - opening p/' + d.slug + '…', 'pc-ok');
        if (d.href && /^\/(?![\/\\])/.test(d.href)) location.href = d.href;
      })
      .catch(function () { say(msg, 'Could not create it right now.', 'pc-bad'); go.disabled = false; });
  });
})();
