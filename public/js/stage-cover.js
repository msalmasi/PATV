// stage-cover.js — 1.99?? Settings -> 🎙 Stage cover (views/stageCover.ejs, stagecover.js): save the choice (POST /api/stage-cover
// {kind, sticker?}), upload a picture of your own in chunks (POST /api/stage-cover/uploads -> PUT ?offset= -> /finish; only while the
// page offers it - the server refuses otherwise), take it down (POST /api/stage-cover/upload/remove), and keep the "On the stage
// right now" preview in step with what the server answers. All text via textContent (never innerHTML).
// Review fix (UX-4): picking an option previews it at once (each option's data-pv / data-pk = what the stage would show for it, from
// the server; a sticker = the sticker picked), marked as not saved until Save.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var root = document.getElementById('scov');
  var form = document.getElementById('scForm');
  if (!root || !form) return;
  var msg = document.getElementById('scMsg');
  var saveBtn = document.getElementById('scSave');
  var maxMb = Number(root.getAttribute('data-max-mb')) || 5;
  var letter = root.getAttribute('data-letter') || '?';
  var KIND = { gtf: _t('js.scov.k.gtf', 'GTF avatar'), photo: _t('js.scov.k.photo', 'Profile picture'), sticker: _t('js.scov.k.sticker', 'A sticker'),
               upload: _t('js.scov.k.upload', 'Your own picture') };
  var URL_OK = /^(https:\/\/|\/(?!\/))[^\s"'<>()\\]+$/;

  function say(text, tone) { msg.textContent = text || ''; msg.className = 'sc-msg' + (tone ? ' ' + tone : ''); }
  function api(url, body, opts) {
    opts = opts || {};
    return fetch(url, { method: opts.method || 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: opts.raw ? { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' } : { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: opts.raw ? body : JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function radio(kind) { return form.querySelector('input[name="kind"][value="' + kind + '"]'); }
  function img(url) { var i = document.createElement('img'); i.src = url; i.alt = ''; i.decoding = 'async'; i.setAttribute('referrerpolicy', 'no-referrer'); return i; }
  function letterEl(cls) { var s = document.createElement('span'); if (cls) s.className = cls; s.setAttribute('aria-hidden', 'true'); s.textContent = letter; return s; }
  function fill(box, url, cls) {
    if (!box) return;
    var cur = box.querySelector('img');
    if (url && URL_OK.test(url)) { if (cur && cur.getAttribute('src') === url) return; box.textContent = ''; box.appendChild(img(url)); }
    else { box.textContent = ''; box.appendChild(letterEl(cls)); }
  }
  /** The "On the stage right now" tile: now = {url, k} | null (the letter); draft = a pick not saved yet. */
  function showNow(now, draft) {
    var tile = document.getElementById('scNowTile');
    if (tile) {
      tile.setAttribute('data-k', now ? now.k : '');
      tile.classList.toggle('draft', !!draft);
      fill(tile.querySelector('.sc-pic'), now && now.url, 'sc-letter');
    }
    var txt = document.getElementById('scNowTxt');
    if (!txt) return;
    if (draft) txt.textContent = now ? _t('js.scov.preview_k', 'Preview: {kind} - press Save to use it.', { kind: KIND[now.k] || now.k })
      : _t('js.scov.preview_none', 'Preview: a plain card with your first letter - press Save to use it.');
    else txt.textContent = now ? _t('js.scov.now_k', 'Showing: {kind}', { kind: KIND[now.k] || now.k }) : _t('js.scov.now_none', 'A plain card with your first letter.');
  }
  /** What the stage would show for an option (its data-pv / data-pk; a sticker: the one picked). undefined = can't tell yet. */
  function previewOf(kind) {
    if (kind === 'sticker') {
      var s = form.querySelector('input[name="sticker"]:checked');
      var im = s && s.parentNode ? s.parentNode.querySelector('img') : null;
      return im && URL_OK.test(im.getAttribute('src') || '') ? { url: im.getAttribute('src'), k: 'sticker' } : undefined;
    }
    var o = form.querySelector('.sc-opt[data-kind="' + kind + '"]');
    if (!o) return undefined;
    var u = o.getAttribute('data-pv') || '';
    return u && URL_OK.test(u) ? { url: u, k: o.getAttribute('data-pk') || 'photo' } : null;
  }
  var saved = null;      // the server's answer last painted ({now, kind, sticker}) - a pick equal to it isn't a draft
  (function () {         // (the page as the server rendered it)
    var k0 = form.querySelector('input[name="kind"]:checked'), s0 = form.querySelector('input[name="sticker"]:checked');
    var tile0 = document.getElementById('scNowTile'), im0 = document.getElementById('scNowImg');
    saved = { kind: k0 ? k0.value : null, sticker: s0 ? s0.value : null,
              now: im0 && im0.getAttribute('src') ? { url: im0.getAttribute('src'), k: (tile0 && tile0.getAttribute('data-k')) || 'photo' } : null };
  })();
  /** The server's state -> the preview, each option's preview, the upload option and the radios. */
  function paint(st) {
    if (!st) return;
    saved = st;
    showNow(st.now, false);
    if (st.preview) for (var pk in st.preview) {
      var o = form.querySelector('.sc-opt[data-kind="' + pk + '"]');
      if (o) { o.setAttribute('data-pv', st.preview[pk] ? st.preview[pk].url : ''); o.setAttribute('data-pk', st.preview[pk] ? st.preview[pk].k : ''); }
    }
    fill(document.getElementById('scUpThumb'), st.upload && st.upload.url);
    var stk = null;
    for (var i = 0; st.sticker && Array.isArray(st.stickers) && i < st.stickers.length; i++) if (st.stickers[i] && st.stickers[i].ref === st.sticker) stk = st.stickers[i];
    if (stk) fill(form.querySelector('.sc-opt[data-kind="sticker"] .sc-thumb'), stk.url);
    var ur = document.getElementById('scUpRadio');
    if (ur) ur.disabled = !st.upload;
    var del = document.getElementById('scUpDel');
    if (del) del.hidden = !st.upload;
    var us = document.getElementById('scUpState');
    if (us) us.textContent = !st.upload ? '' : st.upload.state === 'held' ? _t('js.scov.st_held', 'Your picture is waiting for a check by the admins. Until then the stage shows your default cover.')
      : _t('js.scov.st_ok', 'Your picture is up.');
    var r = radio(st.kind);
    if (r && !r.disabled) r.checked = true;
  }

  // a sticker picked = the sticker cover picked; any pick previews at once (not saved until Save)
  form.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el && el.name === 'sticker') { var r = radio('sticker'); if (r && !r.disabled) r.checked = true; }
    say('');
    var k = form.querySelector('input[name="kind"]:checked');
    if (!k) return;
    var pv = previewOf(k.value);
    if (pv === undefined) return;
    var same = saved && saved.kind === k.value && (k.value !== 'sticker' || saved.sticker === (form.querySelector('input[name="sticker"]:checked') || {}).value);
    showNow(same ? saved.now : pv, !same);
  });
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var k = form.querySelector('input[name="kind"]:checked');
    if (!k) return;
    var body = { kind: k.value };
    if (k.value === 'sticker') {
      var s = form.querySelector('input[name="sticker"]:checked');
      if (!s) { say(_t('js.scov.pick_sticker', 'Pick a sticker first.'), 'bad'); return; }
      body.sticker = s.value;
    }
    saveBtn.disabled = true;
    say(_t('js.scov.saving', 'Saving…'));
    api('/api/stage-cover', body).then(function (d) {
      saveBtn.disabled = false;
      if (d && d.ok) { paint(d); say(_t('js.scov.saved', 'Saved - pad stages show it from their next update.'), 'ok'); }
      else say((d && d.error) || _t('js.scov.err', 'Couldn\'t do that - try again.'), 'bad');
    }).catch(function () { saveBtn.disabled = false; say(_t('js.scov.err', 'Couldn\'t do that - try again.'), 'bad'); });
  });

  // ── a picture of your own (only where the page offers it) ──
  var file = document.getElementById('scFile'), upBtn = document.getElementById('scUpBtn'), delBtn = document.getElementById('scUpDel');
  function upload(f) {
    if (f.size > maxMb * 1024 * 1024) return Promise.resolve({ ok: false, error: _t('js.scov.too_big', 'Pictures can be up to {n} MB.', { n: maxMb }) });
    return api('/api/stage-cover/uploads', { size: f.size }).then(function (o) {
      if (!o || !o.ok) return o;
      var chunk = Math.max(64 * 1024, Number(o.chunk) || 512 * 1024), off = 0;
      function next() {
        if (off >= f.size) { say(_t('js.scov.checking', 'Checking the picture…')); return api('/api/stage-cover/uploads/' + encodeURIComponent(o.id) + '/finish', {}); }
        var part = f.slice(off, Math.min(f.size, off + chunk));
        say(_t('js.scov.uploading', 'Uploading… {pct}%', { pct: Math.floor((off / f.size) * 100) }));
        return api('/api/stage-cover/uploads/' + encodeURIComponent(o.id) + '?offset=' + off, part, { method: 'PUT', raw: true }).then(function (c) {
          if (!c || !c.ok) return c;
          off = Number(c.received) || off + part.size;
          return next();
        });
      }
      return next();
    });
  }
  if (upBtn && file) upBtn.addEventListener('click', function () {
    var f = file.files && file.files[0];
    if (!f) { say(_t('js.scov.pick_file', 'Pick a picture first.'), 'bad'); return; }
    upBtn.disabled = true;
    upload(f).then(function (d) {
      upBtn.disabled = false;
      if (d && d.ok) { paint(d); file.value = ''; say(d.held ? _t('js.scov.held', 'Uploaded - it\'s waiting for a check by the admins.') : _t('js.scov.uploaded', 'Uploaded - your picture is up.'), 'ok'); }
      else say((d && d.error) || _t('js.scov.err', 'Couldn\'t do that - try again.'), 'bad');
    }).catch(function () { upBtn.disabled = false; say(_t('js.scov.err', 'Couldn\'t do that - try again.'), 'bad'); });
  });
  if (delBtn) delBtn.addEventListener('click', function () {
    delBtn.disabled = true;
    api('/api/stage-cover/upload/remove', {}).then(function (d) {
      delBtn.disabled = false;
      if (d && d.ok) { paint(d); say(_t('js.scov.removed', 'Removed.'), 'ok'); }
      else say((d && d.error) || _t('js.scov.err', 'Couldn\'t do that - try again.'), 'bad');
    }).catch(function () { delBtn.disabled = false; say(_t('js.scov.err', 'Couldn\'t do that - try again.'), 'bad'); });
  });
})();
