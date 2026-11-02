// admin-stagecover.js — 1.99?? /admin/imagesafety's "Stage covers" card (views/admin/imagesafety.ejs, stagecover.js): Take down a
// member's uploaded 🎙 stage cover (POST /api/admin/stage-cover/remove {user_id}) or Put up a held one (POST
// /api/admin/stage-cover/release {user_id}; review fix: a picture held because its account is on hold after a take-down passed its
// check, so it has no flag to mark "false positive"). Admins only - the routes check. Text via textContent.
(function () {
  'use strict';
  var list = document.getElementById('scvList');
  if (!list) return;
  list.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('button[data-scv-del], button[data-scv-up]') : null;
    if (!b) return;
    var up = b.hasAttribute('data-scv-up');
    var q = up ? 'Put this stage cover up? Everyone watching a stage they\'re on will see it.'
      : 'Take this stage cover down? The picture can\'t be uploaded again, and their next uploads wait for a check for 30 days.';
    if (typeof window.confirm === 'function' && !window.confirm(q)) return;
    var row = b.parentNode;
    var out = row && row.querySelector('.adm-msg');
    var btns = row ? row.querySelectorAll('button') : [b];
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    fetch(up ? '/api/admin/stage-cover/release' : '/api/admin/stage-cover/remove', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ user_id: b.getAttribute(up ? 'data-scv-up' : 'data-scv-del') }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        if (out) out.textContent = d && d.ok ? (up ? 'Put up.' : 'Taken down.') : (d && d.error) || 'Couldn\'t do that.';
        if (!(d && d.ok)) for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
      })
      .catch(function () { for (var j = 0; j < btns.length; j++) btns[j].disabled = false; if (out) out.textContent = 'Couldn\'t do that.'; });
  });
})();
