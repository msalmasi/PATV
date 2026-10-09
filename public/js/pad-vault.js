// pad-vault.js - economy v2 E-3: the pad owner's daily payout rate on the 🏦 Room vault card (views/room.ejs About
// tab; roomvaults.js on the server). POST /api/rooms/:slug/vault/rate {rate}. Stored for the payout recipe that comes
// later (nothing pays out yet); 2-15%, once a week. Server text goes in via textContent.
(function () {
  'use strict';
  var form = document.getElementById('rvRate');
  if (!form) return;
  var slug = form.getAttribute('data-slug');
  var input = form.querySelector('input[name="rate"]');
  var submit = form.querySelector('button[type="submit"]');
  var msg = document.getElementById('rvRateMsg');
  var busy = false;
  function say(t, err) { msg.textContent = t || ''; msg.className = 'rv-msg' + (err ? ' err' : ''); }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var rate = Number(input.value);
    if (!(rate > 0)) { say('Pick a rate.', true); return; }
    busy = true; submit.disabled = true; say('Saving...');
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/vault/rate', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rate: rate })
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Unexpected answer from the site.' }; }); })
      .then(function (d) {
        if (!d || !d.ok) { say((d && d.error) || 'Not saved.', true); return; }
        input.value = d.rate;
        var v = d.vault || {};
        if (v.rate_locked_until) { input.disabled = true; submit.disabled = true; }
        say(d.changed ? 'Saved: ' + d.rate + '% a day, used when payouts start. You can change it again in a week.'
                      : 'That is already the rate.');
      })
      .catch(function () { say('Couldn\'t reach the site - try again.', true); })
      .then(function () { busy = false; if (!input.disabled) submit.disabled = false; });
  });
})();
