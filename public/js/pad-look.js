// pad-look.js — the Look card on the pad settings hub (1.99es, padlook.js): upload an avatar / banner in 512 KB
// chunks (open -> PUT chunks -> finish), remove them, pick the banner's focal point and the accent colour.
// The preview updates live; the server re-encodes, safety-checks and stores (owner-only).
(function () {
  'use strict';
  var card = document.getElementById('look');
  if (!card) return;
  var base = card.getAttribute('data-url');
  var max = Number(card.getAttribute('data-max')) || 5242880;
  var msg = document.getElementById('plMsg');
  var bn = card.querySelector('.pl-bn'), av = card.querySelector('.pl-av');
  var yWrap = card.querySelector('.pl-y'), y = card.querySelector('input[name=banner_y]');
  var hex = card.querySelector('input[name=custom]');
  var PRESET = {};
  card.querySelectorAll('.pl-c[style]').forEach(function (l) {
    var i = l.querySelector('input'); PRESET[i.value] = l.style.getPropertyValue('--c').trim();
  });

  function say(t, ok) { msg.textContent = t || ''; msg.classList.toggle('ok', !!ok); }
  function jpost(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  function setImg(box, src, fallback) {
    box.textContent = '';
    if (src) { var im = document.createElement('img'); im.src = src; im.alt = ''; box.appendChild(im); box.classList.add('has'); }
    else { box.classList.remove('has'); if (fallback) box.textContent = fallback; }
  }
  var mono = av.getAttribute('data-mono') || '?';
  function paint(L) {
    if (!L) return;
    setImg(av, L.avatar, mono);
    setImg(bn, L.banner, '');
    card.querySelector('[data-remove=avatar]').hidden = !L.avatar;
    card.querySelector('[data-remove=banner]').hidden = !L.banner;
    yWrap.hidden = !L.banner;
    if (L.banner) { y.value = L.bannerY; card.style.setProperty('--pad-banner-y', L.bannerY + '%'); }
    if (L.accent) card.style.setProperty('--pad-accent', L.accent); else card.style.removeProperty('--pad-accent');
  }

  function upload(kind, file) {
    if (!file) return;
    if (file.size > max) { say('Pictures can be up to ' + Math.round(max / 1048576) + ' MB.'); return; }
    card.classList.add('busy'); say('Uploading…');
    jpost(base + '/uploads', { kind: kind, size: file.size }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Upload refused.');
      var id = j.id, chunk = j.chunk || 524288, off = 0;
      function next() {
        if (off >= file.size) return jpost(base + '/uploads/' + id + '/finish', { banner_y: Number(y.value) });
        var part = file.slice(off, Math.min(file.size, off + chunk));
        return fetch(base + '/uploads/' + id + '?offset=' + off, { method: 'PUT', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: part })
          .then(function (r) { return r.json(); }).then(function (c) {
            if (!c.ok) throw new Error(c.error || 'Upload failed.');
            off = c.received; say('Uploading… ' + Math.round(off / file.size * 100) + '%');
            return next();
          });
      }
      return next();
    }).then(function (f) {
      if (!f || !f.ok) throw new Error((f && f.error) || 'That picture couldn\'t be used.');
      paint(f.look); say(kind === 'avatar' ? 'Avatar saved.' : 'Banner saved.', true);
    }).catch(function (e) { say(e.message || 'Upload failed.'); })
      .then(function () { card.classList.remove('busy'); });
  }
  card.querySelectorAll('input[type=file][data-kind]').forEach(function (inp) {
    inp.addEventListener('change', function () { var f = inp.files && inp.files[0]; upload(inp.getAttribute('data-kind'), f); inp.value = ''; });
  });
  card.querySelectorAll('[data-remove]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.getAttribute('data-remove');
      if (!window.confirm('Remove the pad\'s ' + kind + '?')) return;
      card.classList.add('busy');
      jpost(base + '/remove', { kind: kind }).then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Couldn\'t remove it.');
        paint(j.look); say(kind === 'avatar' ? 'Avatar removed.' : 'Banner removed.', true);
      }).catch(function (e) { say(e.message); }).then(function () { card.classList.remove('busy'); });
    });
  });

  // live preview: focal point + colour
  y.addEventListener('input', function () { card.style.setProperty('--pad-banner-y', y.value + '%'); });
  var HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  function picked() {
    var c = (hex.value || '').trim();
    if (c) return HEX.test(c) ? (c.charAt(0) === '#' ? c : '#' + c) : null;
    var r = card.querySelector('input[name=accent]:checked');
    return r ? r.value : '';
  }
  function preview() {
    var v = picked();
    var col = v && v.charAt(0) === '#' ? v : PRESET[v];
    if (col) card.style.setProperty('--pad-accent', col); else card.style.removeProperty('--pad-accent');
  }
  card.querySelectorAll('input[name=accent]').forEach(function (r) { r.addEventListener('change', function () { hex.value = ''; preview(); }); });
  hex.addEventListener('input', preview);
  document.getElementById('plSave').addEventListener('click', function () {
    var v = picked();
    if (v === null) { say('Colours are a hex value like #4caf50.'); hex.focus(); return; }
    var body = { accent: v };
    if (!yWrap.hidden) body.banner_y = Number(y.value);
    card.classList.add('busy');
    jpost(base, body).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Couldn\'t save.');
      paint(j.look);
      if (j.adjusted && j.look.accent) { hex.value = j.look.accent; say('Saved. ' + j.requested + ' was too dark to read on the dark theme, so it was lightened to ' + j.look.accent + '.', true); }
      else say('Saved.', true);
    }).catch(function (e) { say(e.message); }).then(function () { card.classList.remove('busy'); });
  });
})();
