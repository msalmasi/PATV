// pad-boost.js — 🚀 Boost this pad (1.99ee, views/room.ejs Go live card; boosts.js on the server).
// The button opens a small form: preset amounts or any amount, then POST /api/rooms/:slug/boost
// {amount, ref}. ONE ref per attempt: a double click / a retry after a network error sends the same ref,
// so the server charges once (it answers dup: true). A fresh ref only after a boost went through or the
// amount changed. Opens by itself when the page is reached with #boost. Server text goes in via textContent.
(function () {
  'use strict';
  var box = document.getElementById('rmBoostBox');
  var btn = document.getElementById('rmBoostBtn');
  if (!box || !btn) return;
  var slug = box.getAttribute('data-slug');
  var input = box.querySelector('input[name="amount"]');
  var msg = document.getElementById('rmBoostMsg');
  var submit = box.querySelector('button[type="submit"]');
  var ref = null, busy = false;
  function newRef() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, ''); } catch (e) { /* older browser */ }
    var s = ''; for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16); return s;
  }
  function say(t, err) { msg.textContent = t || ''; msg.className = 'bx-msg' + (err ? ' err' : ''); }
  function open(on) {
    box.hidden = !on;
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { ref = ref || newRef(); try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); } }
  }
  btn.addEventListener('click', function () { open(box.hidden); });
  box.querySelectorAll('[data-amt]').forEach(function (b) {
    b.addEventListener('click', function () { input.value = b.getAttribute('data-amt'); ref = newRef(); say(''); });
  });
  input.addEventListener('input', function () { ref = newRef(); });
  function line(lastHour) {
    var t = document.getElementById('rmBoostTxt');
    if (!t) return;
    var n = Number(lastHour) || 0;
    t.hidden = n <= 0;
    var b = t.querySelector('b');
    if (b) b.textContent = n.toLocaleString('en-US');
  }
  box.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var amt = Math.floor(Number(input.value));
    if (!(amt > 0)) { say('Pick an amount.', true); return; }
    ref = ref || newRef();
    busy = true; submit.disabled = true; say('Boosting…');
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/boost', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amt, ref: ref })
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Unexpected answer from the site.' }; }); })
      .then(function (d) {
        if (!d || !d.ok) { say((d && d.error) || 'Not done.', true); if (d && d.error && !/reach/i.test(d.error)) ref = newRef(); return; }
        say((d.dup ? 'Already done: ' : '🚀 Boosted with ') + Number(d.amount).toLocaleString('en-US') + ' PAT' +
            (d.boost ? ' · ' + Number(d.boost.last_hour).toLocaleString('en-US') + ' PAT in the last hour' : '') + '. Thanks!');
        if (d.boost) line(d.boost.last_hour);
        ref = newRef();
      })
      .catch(function () { say('Couldn\'t reach the site - try again (you won\'t be charged twice).', true); })
      .then(function () { busy = false; submit.disabled = false; });
  });
  if (location.hash === '#boost') open(true);
  // room-schedule.js refreshes the line every 30 s; this keeps it in step right after a boost
  window.PATVBoostLine = line;
})();
