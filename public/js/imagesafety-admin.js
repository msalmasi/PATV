// imagesafety-admin.js — the /admin/imagesafety page (1.99fc): save the settings, mark checks fp / fn / ok.
(function () {
  'use strict';
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || 'Something went wrong.'); return d; }); });
  }
  var form = document.getElementById('isfSettings');
  if (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msg = form.querySelector('.adm-msg');
      var E = form.elements;
      var surfaces = {};
      Array.prototype.forEach.call(form.querySelectorAll('input[name=surface]'), function (c) { surfaces[c.value] = c.checked; });
      var thresholds = {}, policy = { profile: {}, media: {} };
      Array.prototype.forEach.call(form.querySelectorAll('input[name^=th_]'), function (i) { thresholds[i.name.slice(3)] = Number(i.value); });
      Array.prototype.forEach.call(form.querySelectorAll('select[name^=pol_]'), function (s) {
        var rest = s.name.slice(4), g = rest.slice(0, rest.indexOf('_')), k = rest.slice(rest.indexOf('_') + 1);
        if (policy[g]) policy[g][k] = s.value;
      });
      var settings = {
        image_safety_enabled: E.image_safety_enabled.checked, image_safety_shadow: E.image_safety_shadow.checked,
        image_safety_fail_mode: E.image_safety_fail_mode.value, image_safety_timeout_secs: Number(E.image_safety_timeout_secs.value),
        image_safety_video_frames: Number(E.image_safety_video_frames.value), image_safety_retention_days: Number(E.image_safety_retention_days.value),
        image_safety_notify_minor: E.image_safety_notify_minor.checked, image_safety_surfaces: surfaces,
        image_safety_thresholds: thresholds, image_safety_policy: policy
      };
      if (settings.image_safety_enabled && !settings.image_safety_shadow &&
          !window.confirm('Switch image safety ON? Uploads will be refused or marked NSFW by the policy. (Shadow mode first is recommended.)')) return;
      if (msg) { msg.textContent = 'Saving…'; msg.className = 'adm-msg'; }
      api('/api/admin/imagesafety/settings', { settings: settings }).then(function () {
        if (msg) { msg.textContent = 'Saved.'; msg.className = 'adm-msg ok'; }
        setTimeout(function () { window.location.reload(); }, 600);
      }, function (e) { if (msg) { msg.textContent = e.message; msg.className = 'adm-msg err'; } });
    });
  }
  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('.isf-rev button[data-mark]') : null;
    if (!b) return;
    var row = b.closest('.isf-row');
    var id = row && row.getAttribute('data-id');
    var on = b.getAttribute('aria-pressed') === 'true';
    var msg = row.querySelector('.isf-rev .adm-msg');
    api('/api/admin/imagesafety/review/' + encodeURIComponent(id), { mark: on ? null : b.getAttribute('data-mark') }).then(function (d) {
      Array.prototype.forEach.call(row.querySelectorAll('.isf-rev button[data-mark]'), function (x) {
        var sel = d.row && d.row.review === x.getAttribute('data-mark');
        x.setAttribute('aria-pressed', sel ? 'true' : 'false');
        x.classList.toggle('on', !!sel);
      });
      if (msg) { msg.textContent = d.row && d.row.review ? 'Marked by ' + d.row.reviewedBy : 'Cleared'; msg.className = 'adm-msg ok'; }
    }, function (e) { if (msg) { msg.textContent = e.message; msg.className = 'adm-msg err'; } });
  });
})();
