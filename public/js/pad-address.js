// pad-address.js — the pad settings hub's "Pad address" card (1.99iy, padaddress.js): checks the typed address as you
// type (GET /api/rooms/<slug>/address?slug=), then changes it (POST, JSON, same-site) and moves the page to the new address.
(function () {
  'use strict';
  var card = document.getElementById('pad-address');
  var form = document.getElementById('padAddrForm');
  if (!card || !form) return;
  var url = card.getAttribute('data-url');
  var cur = card.getAttribute('data-slug');
  var input = document.getElementById('padAddrIn');
  var btn = document.getElementById('padAddrSave');
  var msg = document.getElementById('padAddrMsg');
  var timer = null, seq = 0, okSlug = null;
  function say(t, bad) { msg.textContent = t || ''; msg.style.color = bad ? 'var(--bad, #e55)' : ''; }
  function check() {
    var v = input.value;
    var my = ++seq;
    okSlug = null;
    btn.disabled = true;
    if (!v.trim()) { say(''); return; }
    fetch(url + '?slug=' + encodeURIComponent(v), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (my !== seq) return;
        if (!d || d.ok === false) { say((d && d.error) || 'Could not check that.', true); return; }
        if (d.same) { say('That is the current address.'); return; }
        if (d.problem) { say(d.problem, true); return; }
        okSlug = d.slug;
        btn.disabled = false;
        say('✓ p/' + d.slug + ' is free.');
      })
      .catch(function () { if (my === seq) say('Could not check that right now.', true); });
  }
  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(check, 300); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!okSlug) return;
    if (!window.confirm('Change the address from p/' + cur + ' to p/' + okSlug + '? Old links will redirect to the new one.')) return;
    btn.disabled = true;
    say('Changing…');
    fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                 body: JSON.stringify({ slug: okSlug }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
      .then(function (d) {
        if (!d || d.ok === false) { say((d && d.error) || 'Could not change it.', true); btn.disabled = false; return; }
        say('Done - moving to p/' + d.slug + '…');
        if (d.href && /^\/(?![\/\\])/.test(d.href)) location.href = d.href;
      })
      .catch(function () { say('Could not change it right now.', true); btn.disabled = false; });
  });
})();
