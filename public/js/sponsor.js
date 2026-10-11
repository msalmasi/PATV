// sponsor.js — /sponsor: book the homepage banner slot (1.99kk, banner.js). The picture goes up in 512 KB chunks
// (open -> PUT chunks -> finish: the server re-encodes and safety-checks it), then the booking holds the PAT.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var bootEl = document.getElementById('spBoot');
  if (!bootEl) return;
  var B = JSON.parse(bootEl.textContent);
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  function jpost(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }

  // cancel a pending booking (full refund)
  Array.prototype.forEach.call(document.querySelectorAll('[data-cancel]'), function (b) {
    b.addEventListener('click', function () {
      if (!window.confirm(_t('js.sponsor.cancel_q', 'Cancel this booking? Your PAT are refunded in full.'))) return;
      b.disabled = true;
      jpost('/api/banner/bookings/' + encodeURIComponent(b.getAttribute('data-cancel')) + '/cancel', {}).then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Error');
        location.reload();
      }).catch(function (e) { b.disabled = false; window.alert(e.message); });
    });
  });

  var form = $('spForm');
  if (!form) return;
  var msg = $('spMsg'), go = $('spGo'), image = null;
  function say(t, c) { msg.textContent = t || ''; msg.className = 'msg' + (c ? ' ' + c : ''); }
  function kind() { var r = form.querySelector('input[name=kind]:checked'); return r ? r.value : 'text'; }
  function total() {
    var d = Math.max(1, Math.min(B.maxDays, Math.floor(Number($('spDays').value) || 1)));
    var p = d * B.price;
    $('spTotal').textContent = _t('js.sponsor.total', 'Total: {pat} PAT', { pat: fmt(p) }) + (B.balance != null && p > B.balance ? ' · ' + _t('js.sponsor.short', 'more than your balance') : '');
  }
  $('spDays').addEventListener('input', total);
  total();
  Array.prototype.forEach.call(form.querySelectorAll('input[name=kind]'), function (r) {
    r.addEventListener('change', function () { $('spText').hidden = kind() !== 'text'; $('spImage').hidden = kind() !== 'image'; });
  });

  $('spFile').addEventListener('change', function () {
    var file = this.files && this.files[0];
    image = null; $('spPrev').hidden = true;
    if (!file) return;
    if (file.size > B.maxBytes) { say(_t('js.sponsor.too_big', 'Pictures can be up to {mb} MB.', { mb: Math.round(B.maxBytes / 1048576) }), 'bad'); return; }
    go.disabled = true; say(_t('js.sponsor.uploading', 'Uploading…'));
    jpost('/api/banner/uploads', { size: file.size }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Upload refused.');
      var id = j.id, chunk = j.chunk || B.chunk, off = 0;
      function next() {
        if (off >= file.size) return jpost('/api/banner/uploads/' + id + '/finish', {});
        return fetch('/api/banner/uploads/' + id + '?offset=' + off, { method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: file.slice(off, Math.min(file.size, off + chunk)) })
          .then(function (r) { return r.json(); }).then(function (c) {
            if (!c.ok) throw new Error(c.error || 'Upload failed.');
            off = c.received; say(_t('js.sponsor.uploading_pct', 'Uploading… {pct}%', { pct: Math.round(off / file.size * 100) }));
            return next();
          });
      }
      return next();
    }).then(function (f) {
      if (!f || !f.ok) throw new Error((f && f.error) || 'That picture couldn\'t be used.');
      image = f.image; $('spPrevImg').src = f.url; $('spPrev').hidden = false;
      say(_t('js.sponsor.uploaded', 'Picture ready - this is how it will look.'), 'ok');
    }).catch(function (e) { say(e.message, 'bad'); this.value = ''; }.bind(this)).then(function () { go.disabled = false; });
  });

  var ref = null;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var k = kind();
    if (k === 'image' && !image) { say(_t('js.sponsor.need_pic', 'Upload the picture first.'), 'bad'); return; }
    var days = Math.floor(Number($('spDays').value) || 1);
    if (!window.confirm(_t('js.sponsor.confirm', "Hold {pat} PAT for {days} day(s) from {start}? It shows once an admin approves it. If it isn't approved, you get it all back.",
      { pat: fmt(days * B.price), days: days, start: $('spStart').value }))) return;
    ref = ref || ('b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    go.disabled = true; say(_t('js.sponsor.booking', 'Booking…'));
    jpost('/api/banner/book', { start: $('spStart').value, days: days, kind: k, headline: $('spHead').value, line: $('spLine').value,
                                image: image, alt: $('spAlt').value, link: $('spLink').value, ref: ref })
      .then(function (j) {
        if (!j.ok) { ref = null; throw new Error(j.error || 'Error'); }
        say(_t('js.sponsor.booked', "Booked. It's waiting for an admin's OK, and you'll get a notice either way."), 'ok');
        setTimeout(function () { location.reload(); }, 1200);
      }).catch(function (x) { say(x.message, 'bad'); go.disabled = false; });
  });
})();
