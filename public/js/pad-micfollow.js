// pad-micfollow.js — Pad settings → Stage → 🎙 Mic follows (micfollow.js): the pad's switch, layout, when it shows, how many
// people / live cams, how long recent speakers stay up (mfix), and the people kept off the mic stage (add by Camfrog or PATV name - the owner says which - for 1 h / 24 h / always; ✕
// removes). JSON + X-Requested-With (the routes are fetch-only, same site). All text via textContent.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var form = document.getElementById('mfForm'), msg = document.getElementById('mfMsg');
  var rows = document.getElementById('mfExRows'), exForm = document.getElementById('mfExForm'), exMsg = document.getElementById('mfExMsg');
  if (!form || !rows) return;
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function el(tag, text) { var e = document.createElement(tag); if (text != null) e.textContent = text; return e; }
  var REASON = { owner: _t('js.padset.mf.r_owner', 'you'), cut: _t('js.padset.mf.r_cut', 'cut from the stage'), staff: _t('js.padset.mf.r_staff', 'site staff'),
                 ended_by: _t('js.padset.mf.r_ended_by', 'their relay was ended'), reported: _t('js.padset.mf.r_reported', 'two reports (site staff review it)') };
  function when(ms) { if (ms == null) return _t('js.padset.mf.always', 'always'); try { return new Date(Number(ms)).toLocaleString(); } catch (e) { return String(ms); } }
  function paint(list) {
    rows.textContent = '';
    if (!list || !list.length) { var tr0 = el('tr'), td0 = el('td', _t('js.padset.mf.none', 'Nobody is excluded.')); td0.colSpan = 5; td0.className = 'muted'; tr0.appendChild(td0); rows.appendChild(tr0); return; }
    list.forEach(function (e) {
      var tr = el('tr');
      tr.appendChild(el('td', e.login));
      tr.appendChild(el('td', when(e.until)));
      tr.appendChild(el('td', REASON[e.reason] || e.reason || ''));
      tr.appendChild(el('td', e.by || ''));
      var td = el('td'), b = el('button', _t('js.padset.mf.remove', 'Remove'));
      b.type = 'button'; b.className = 'btn';
      b.addEventListener('click', function () {
        b.disabled = true;
        post(rows.getAttribute('data-url'), { login: e.login, remove: true }).then(function (d) {
          if (d && d.ok && d.state) { paint(d.state.excluded); status(d.state); } else { exMsg.textContent = (d && d.error) || _t('js.padset.mf.failed', 'Not saved - try again.'); b.disabled = false; }
        }).catch(function () { exMsg.textContent = _t('js.padset.mf.failed', 'Not saved - try again.'); b.disabled = false; });
      });
      td.appendChild(b); tr.appendChild(td);
      rows.appendChild(tr);
    });
  }
  var first = [];
  try { first = JSON.parse(rows.getAttribute('data-list') || '[]'); } catch (e) { first = []; }
  paint(first);
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = form.elements;
    var body = { on: !!f.on.checked, layout: f.layout.value, default_view: f.default_view.value, max_people: Number(f.max_people.value), max_live: Number(f.max_live.value) };
    if (f.keep_recent) body.keep_recent = Number(f.keep_recent.value);   // mfix: recent speakers (minutes, 0 = off)
    msg.textContent = '…';
    post(form.getAttribute('data-url'), body).then(function (d) {
      msg.textContent = d && d.ok ? _t('js.padset.mf.saved', 'Saved.') : (d && d.error) || _t('js.padset.mf.failed', 'Not saved - try again.');
      if (d && d.ok) status(d.state);
    }).catch(function () { msg.textContent = _t('js.padset.mf.failed', 'Not saved - try again.'); });
  });
  // the status line under the form ("Ready…", "Running: 2 on the mic stage.", why it can't run) - the server words it
  var statusEl = document.getElementById('mfStatus');
  function unesc(s) { return String(s).replace(/&(amp|lt|gt|quot|#34|#39);/g, function (m, e) { return { amp: '&', lt: '<', gt: '>', quot: '"', '#34': '"', '#39': '\'' }[e]; }); }
  function status(st) {
    if (statusEl && st && typeof st.status_text === 'string') statusEl.textContent = unesc(st.status_text);
  }
  if (exForm) exForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = String(exForm.elements.name.value || '').trim();
    if (!name) return;
    exMsg.textContent = '…';
    // kind: "camfrog" (the login as typed) or "patv" (that account's linked Camfrog name) - never guessed
    var kind = exForm.elements.kind && exForm.elements.kind.value === 'patv' ? 'patv' : 'camfrog';
    post(rows.getAttribute('data-url'), { name: name, kind: kind, hours: Number(exForm.elements.hours.value) }).then(function (d) {
      if (d && d.ok && d.state) { paint(d.state.excluded); status(d.state); exForm.elements.name.value = ''; exMsg.textContent = ''; }
      else exMsg.textContent = (d && d.error) || _t('js.padset.mf.failed', 'Not saved - try again.');
    }).catch(function () { exMsg.textContent = _t('js.padset.mf.failed', 'Not saved - try again.'); });
  });
})();
