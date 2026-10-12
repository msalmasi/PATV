// admin-donlimit.js (1.99ts) - Users & Accounts → "Donation limit (one member)": look up / set one member's daily donation
// limit override (donationpromo.js setOverride; audit-logged). Empty = the default, 0 = no limit for this member.
(function () {
  'use strict';
  var form = document.getElementById('dlUserForm');
  if (!form) return;
  var $ = function (id) { return document.getElementById(id); };
  var usd = function (c) { return '$' + Math.floor(Number(c || 0) / 100).toLocaleString('en-US'); };
  function msg(t, bad) { var m = $('dlMsg'); m.textContent = t || ''; m.className = 'adm-msg' + (t ? (bad ? ' err' : ' ok') : ''); }
  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  function describe(name, override, today, dflt) {
    var lim = override ? (override.limit_usd ? '$' + override.limit_usd + '/day (override)' : 'no limit (override)') : (dflt ? '$' + dflt + '/day (default)' : 'no limit (default)');
    return name + ': ' + lim + (today ? ' - ' + usd(today.used_cents) + ' used today, ' + usd(today.left_cents) + ' left' : '');
  }
  $('dlLook').addEventListener('click', function () {
    var u = $('dlUser').value.trim();
    if (!u) return;
    api('/api/admin/donlimit/user?username=' + encodeURIComponent(u)).then(function (j) {
      $('dlUsd').value = j.override ? j.override.limit_usd : '';
      msg(describe(j.user.username, j.override, j.today, j.default_usd));
    }, function (e) { msg(e.message, true); });
  });
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('/api/admin/donlimit/user', { username: $('dlUser').value.trim(), limit_usd: $('dlUsd').value, note: $('dlNote').value })
      .then(function (j) { msg('Saved. ' + describe(j.username, j.limit_usd === null ? null : { limit_usd: j.limit_usd }, j.today, j.default_usd)); },
        function (e) { msg(e.message, true); });
  });
})();
