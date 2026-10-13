// admin-gscale.js (Q11, 2026-10-13) - /admin/economy's 📐 Activity-scaled guarantee card (views/partials/econ-gscale.ejs).
// Status: GET /api/admin/econ/gscale (policy/gscale.js). The switch is `!econ set guarantee_scaled on|off`, a website action
// Pepe runs (econ.cmd) behind the single-use nonce + account password step-up of the other economy cards. Pepe's answer is
// shown as text (textContent).
(function () {
  'use strict';
  var box = document.getElementById('gsAdm');
  if (!box) return;
  var csrf = box.getAttribute('data-csrf');
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var dash = function (n) { return n === null || n === undefined ? '—' : fmt(n); };
  var refTxt = function (r) { return r === null || r === undefined ? '—' : (Math.round(Number(r) * 10) / 10).toLocaleString('en-US'); };
  var st = null, pending = null, nonce = null;
  function msg(t, bad) { var m = $('gsMsg'); m.textContent = t || ''; m.style.color = bad ? 'var(--ds-danger, #ef5350)' : ''; }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: { 'x-csrf-token': csrf } };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'failed'); return j; }); });
  }
  function td(text) { var c = document.createElement('td'); c.textContent = text; return c; }
  function render() {
    var s = st.settings || {};
    $('gsState').textContent = st.on ? 'ON' : 'OFF (dry run)';
    $('gsStateSub').textContent = st.on ? 'in force: ' + fmt(st.in_force) + ' PAT'
                                        : 'in force: the fixed ' + fmt(st.fixed_target) + ' PAT';
    $('gsLast').textContent = dash(st.last_week.participants);
    $('gsLastSub').textContent = 'week of ' + new Date(st.last_week.start * 1000).toISOString().slice(0, 10);
    $('gsNow').textContent = fmt(st.this_week.participants);
    $('gsNowSub').textContent = st.epoch + ' (counts at the next Monday)';
    if (st.collecting) {
      $('gsRef').textContent = 'collecting';
      $('gsRefSub').textContent = st.weeks_have + ' of ' + s.ref_weeks + ' weeks in';
    } else {
      $('gsRef').textContent = refTxt(st.reference);
      $('gsRefSub').textContent = 'median of the first ' + s.ref_weeks + ' weeks';
    }
    $('gsRaw').textContent = fmt(st.raw);
    $('gsRawSub').textContent = 'base ' + fmt(s.base) + ', clamp ' + fmt(s.min) + '..' + fmt(s.max);
    $('gsTarget').textContent = fmt(st.target);
    $('gsTargetSub').textContent = (st.on ? 'this week' : 'would be this week') + ' · mean of ' + s.smooth_weeks + ' wk';
    $('gsToggle').textContent = st.on ? 'Turn off (back to the fixed target)' : 'Turn on';
    $('gsToggle').className = st.on ? 'adm-btn ghost' : 'adm-btn';
    $('gsToggle').disabled = false;
    $('gsHistNote').textContent = st.on ? '' : '(dry run: the switch is off)';
    var rows = $('gsRows');
    rows.textContent = '';
    if (!st.history || !st.history.length) {
      var tr = document.createElement('tr'), c = td('No pad payouts recorded yet.');
      c.colSpan = 5; c.className = 'empty'; tr.appendChild(c); rows.appendChild(tr);
      return;
    }
    st.history.forEach(function (h) {
      var tr = document.createElement('tr');
      tr.appendChild(td(new Date(h.monday * 1000).toISOString().slice(0, 10)));
      tr.appendChild(td(dash(h.participants)));
      tr.appendChild(td(h.collecting ? 'collecting' : refTxt(h.reference)));
      tr.appendChild(td(fmt(h.raw)));
      tr.appendChild(td(fmt(h.target)));
      rows.appendChild(tr);
    });
  }
  function load() { return api('/api/admin/econ/gscale').then(function (j) { st = j; render(); }).catch(function (e) { msg(e.message, true); }); }
  function cancel() { pending = null; nonce = null; $('gsConfirm').hidden = true; $('gsPw').value = ''; }
  function ask(what, text) {
    cancel();
    pending = text;
    $('gsWhat').textContent = what;
    $('gsConfirm').hidden = false;
    msg('');
    api('/api/admin/econ/edit/nonce', {}).then(function (j) { nonce = j.nonce; $('gsPw').focus(); }).catch(function (e) { msg(e.message, true); cancel(); });
  }
  $('gsToggle').addEventListener('click', function () {
    if (!st) return;
    ask(st.on ? 'Turn the scaled target OFF: from the next Monday the guarantee tops up to the fixed target (' + fmt(st.fixed_target) + ' PAT) again.'
              : 'Turn the scaled target ON: from the next Monday the guarantee tops up to the scaled target (' + fmt(st.target) +
                ' PAT if it ran now), and the heist vaults\' % caps follow it.',
        'set guarantee_scaled ' + (st.on ? 'off' : 'on'));
  });
  $('gsNo').addEventListener('click', function () { cancel(); msg('Cancelled - nothing sent.'); });
  $('gsYes').addEventListener('click', function () {
    if (!pending || !nonce) { msg('Start again.', true); return; }
    var body = { op: 'cmd', text: pending, nonce: nonce, password: $('gsPw').value };
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
