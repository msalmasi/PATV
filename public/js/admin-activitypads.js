// admin-activitypads.js (2026-10-12) - /admin/economy's 🎁 Activity → pad vaults card (views/partials/econ-activity-pads.ejs).
// Status: GET /api/admin/econ/activity-pads. Actions are !econ commands Pepe runs (website action econ.cmd) behind the same
// single-use nonce + account password step-up as the Protocol pools card: "activitypads preview" (a dry run of yesterday),
// "activitypads on|off" (one switch: the activity group funds the pad top-up pool and the global activity rewards stop),
// "profilevaults on|off". Pepe's answer is shown as text (textContent).
(function () {
  'use strict';
  var box = document.getElementById('apAdm');
  if (!box) return;
  var csrf = box.getAttribute('data-csrf');
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var st = null, pending = null, nonce = null;
  function msg(t, bad) { var m = $('apMsg'); m.textContent = t || ''; m.style.color = bad ? 'var(--ds-danger, #ef5350)' : ''; }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: { 'x-csrf-token': csrf } };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'failed'); return j; }); });
  }
  function render() {
    var on = !!st.activity_pads, recipe = !!st.recipe_on, prof = !!st.profile_vaults;
    $('apState').textContent = on ? 'ON' : 'OFF';
    $('apStateSub').textContent = on ? (recipe ? 'the activity budget tops up pads' : 'waiting for room payouts') : 'global activity rewards pay';
    $('apGlobal').textContent = on && recipe ? 'OFF' : (st.activity_rewards ? 'ON' : 'OFF');
    $('apProfile').textContent = prof ? 'ON' : 'OFF';
    var p = st.pool;
    $('apPool').textContent = p && p.day ? fmt(p.paid) + ' PAT' : '—';
    $('apPoolSub').textContent = p && p.day ? p.day + ' · ' + fmt(p.pads) + ' pads · pool ' + fmt(p.pool) : 'no day yet';
    $('apToggle').textContent = on ? 'Turn off (global rewards return)' : 'Turn on';
    $('apToggle').className = on ? 'adm-btn ghost' : 'adm-btn';
    $('apToggle').disabled = false;
    $('apProfToggle').textContent = prof ? 'Turn profile vaults off' : 'Turn profile vaults on';
    $('apProfToggle').disabled = false;
  }
  function load() { return api('/api/admin/econ/activity-pads').then(function (j) { st = j; render(); }).catch(function (e) { msg(e.message, true); }); }
  function cancel() { pending = null; nonce = null; $('apConfirm').hidden = true; $('apPw').value = ''; }
  function ask(what, text) {
    cancel();
    pending = text;
    $('apWhat').textContent = what;
    $('apConfirm').hidden = false;
    msg('');
    api('/api/admin/econ/edit/nonce', {}).then(function (j) { nonce = j.nonce; $('apPw').focus(); }).catch(function (e) { msg(e.message, true); cancel(); });
  }
  $('apPreview').addEventListener('click', function () {
    ask('Dry run: yesterday\'s pad payouts with the activity top-up pool, and what the global activity rewards would have paid. Nothing moves.', 'activitypads preview');
  });
  $('apToggle').addEventListener('click', function () {
    if (!st) return;
    ask(st.activity_pads ? 'Turn activity → pads OFF: the activity group pays players directly again (if activity_rewards is on).'
                         : 'Turn activity → pads ON: from the next epoch the activity group tops up pad vaults and the global activity rewards stop.',
        'activitypads ' + (st.activity_pads ? 'off' : 'on'));
  });
  $('apProfToggle').addEventListener('click', function () {
    if (!st) return;
    ask(st.profile_vaults ? 'Turn profile vaults OFF: profiles keep what their vaults hold; new profile spending goes to Fort Knox.'
                          : 'Turn profile vaults ON: profile pads get vaults (filled by others\' spending there, donations and the top-up pool) and payouts.',
        'profilevaults ' + (st.profile_vaults ? 'off' : 'on'));
  });
  $('apNo').addEventListener('click', function () { cancel(); msg('Cancelled - nothing sent.'); });
  $('apYes').addEventListener('click', function () {
    if (!pending || !nonce) { msg('Start again.', true); return; }
    var body = { op: 'cmd', text: pending, nonce: nonce, password: $('apPw').value };
    cancel();
    msg('Sending to Pepe…');
    api('/api/admin/econ/edit', body).then(function (j) {
      var id = j.request.id, tries = 0;
      (function poll() {
        api('/api/admin/econ/edit/' + id).then(function (a) {
          var s = a.action.status;
          if (s === 'done' || s === 'failed' || s === 'expired') { msg(a.action.message || s, s !== 'done'); setTimeout(load, 1500); return; }
          if (++tries > 40) { msg('Queued for Pepe (#' + id + ') - he runs it when he is online.'); return; }
          msg('Waiting for Pepe… (' + s + ')');
          setTimeout(poll, 3000);
        }).catch(function (e) { msg(e.message, true); });
      })();
    }).catch(function (e) { msg(e.message, true); });
  });
  load();
})();
