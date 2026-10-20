// account-delete.js - /settings/account/delete (accountdelete.js: POST /api/account/delete {password?, confirm}). 1.99wj.
(function () {
  'use strict';
  var f = document.getElementById('delForm');
  if (!f) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  var c = document.getElementById('delConfirm'), pw = document.getElementById('delPw'), btn = document.getElementById('delBtn'), st = document.getElementById('delStatus');
  var hl = document.getElementById('delHideLines');
  var want = c ? c.getAttribute('data-want') : '';
  function say(msg, bad) { st.textContent = msg || ''; st.className = 'status ' + (bad ? 'err' : 'ok'); }
  function check() { btn.disabled = !c || c.value.trim() !== want; }
  if (c) c.addEventListener('input', check);
  check();
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    if (btn.disabled) return;
    if (!window.confirm(_t('js.acctdel.sure', 'Delete your account? Every device is signed out now; signing in again in the next 14 days cancels it.'))) return;
    btn.disabled = true;
    say(_t('js.acctdel.working', 'Scheduling…'));
    fetch('/api/account/delete', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' },
      // CL6: "Also hide my past public chat lines" (unticked by default)
      body: JSON.stringify({ confirm: c.value.trim(), password: pw ? pw.value : '', hide_lines: !!(hl && hl.checked) }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (j && j.ok) {
          var d = new Date(Number(j.execute_at)).toISOString().slice(0, 10);
          f.remove();
          say(_t('js.acctdel.done', 'Done. Your account will be deleted on {date}, and every device is signed out. Sign in again before then to cancel.').replace('{date}', d));
          return;
        }
        btn.disabled = false;
        if (j && j.code === 'E_BLOCKED') { location.reload(); return; }
        say((j && j.error) || _t('js.acctdel.failed', "Couldn't schedule it - try again."), true);
      })
      .catch(function () { btn.disabled = false; say(_t('js.acctdel.failed', "Couldn't schedule it - try again."), true); });
  });
})();
