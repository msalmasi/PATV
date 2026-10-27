// account-delete.js - /settings/account/delete (accountdelete.js: POST /api/account/delete {password?, confirm, hide_lines?,
// remove_public?, delete_recordings?}). 1.99wj; CL6: hide_lines; S1 V4: remove_public (the checkbox exists only while it is offered); mic
// retention: delete_recordings (likewise).
(function () {
  'use strict';
  var f = document.getElementById('delForm');
  if (!f) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  var c = document.getElementById('delConfirm'), pw = document.getElementById('delPw'), btn = document.getElementById('delBtn'), st = document.getElementById('delStatus');
  var hl = document.getElementById('delHideLines');
  var rp = document.getElementById('delRemovePublic');
  var rec = document.getElementById('delRecordings');   // mic retention: only while it's offered
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
    var body = { confirm: c.value.trim(), password: pw ? pw.value : '', hide_lines: !!(hl && hl.checked) };   // CL6: unticked by default
    if (rp && !rp.disabled) body.remove_public = !!rp.checked;                                                // S1 V4: unticked by default
    if (rec) body.delete_recordings = !!rec.checked;                                                          // mic retention: unticked by default
    fetch('/api/account/delete', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify(body) })
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
