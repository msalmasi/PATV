// admin-stagecover.js — 1.99?? /admin/imagesafety's "Stage covers" card (views/admin/imagesafety.ejs, stagecover.js): Take down a
// member's uploaded 🎙 stage cover (POST /api/admin/stage-cover/remove {user_id}; Admins only - the route checks). Text via textContent.
(function () {
  'use strict';
  var list = document.getElementById('scvList');
  if (!list) return;
  list.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('button[data-scv-del]') : null;
    if (!b) return;
    if (typeof window.confirm === 'function' && !window.confirm('Take this stage cover down? Their stage shows their default cover instead.')) return;
    var out = b.parentNode && b.parentNode.querySelector('.adm-msg');
    b.disabled = true;
    fetch('/api/admin/stage-cover/remove', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ user_id: b.getAttribute('data-scv-del') }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        if (out) out.textContent = d && d.ok ? 'Taken down.' : (d && d.error) || 'Couldn\'t do that.';
        if (!(d && d.ok)) b.disabled = false;
      })
      .catch(function () { b.disabled = false; if (out) out.textContent = 'Couldn\'t do that.'; });
  });
})();
