// admin-twitchcp.js - 1.99afh: the Twitch channel points card on /admin/economy#twitchcp (views/partials/admin-twitchcp.ejs;
// twitchcp.js). Rows of {reward id, exact title, PAT} + the cap; "Rewards seen" pins a seen reward's id onto its row.
(function () {
  'use strict';
  var f = document.getElementById('tcpForm'), rows = document.getElementById('tcpRows'), seenT = document.getElementById('tcpSeen');
  var msg = document.getElementById('tcpMsg'), addB = document.getElementById('tcpAdd'), saveB = document.getElementById('tcpSave');
  if (!f || !rows) return;
  var canEdit = false, n = 0;
  function say(t) { if (msg) msg.textContent = t; }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function field(label, cls, value, attrs) {
    var id = 'tcp' + cls + (++n);
    var l = el('label', { for: id }, label);
    var i = el('input', Object.assign({ id: id, 'data-k': cls }, attrs || {}));
    i.value = value == null ? '' : String(value);
    if (!canEdit) i.disabled = true;
    l.appendChild(i);
    return l;
  }
  function addRow(r) {
    r = r || {};
    var d = el('div', { class: 'adm-inline', role: 'listitem' });
    d.appendChild(field('Reward id (optional)', 'id', r.id, { type: 'text', maxlength: '64', placeholder: 'Twitch reward UUID', spellcheck: 'false' }));
    d.appendChild(field('Exact title', 'title', r.title, { type: 'text', maxlength: '45', placeholder: 'Buy 5000 PAT' }));
    d.appendChild(field('PAT', 'amount', r.amount, { type: 'number', min: '1', max: '25000', step: '1', inputmode: 'numeric' }));
    var x = el('button', { type: 'button', class: 'ds-btn sm ghost' }, 'Remove');
    x.disabled = !canEdit;
    x.addEventListener('click', function () { d.remove(); });
    d.appendChild(x);
    rows.appendChild(d);
    return d;
  }
  function val(d, k) { var i = d.querySelector('[data-k="' + k + '"]'); return i ? String(i.value).trim() : ''; }
  function show(cfg) {
    rows.textContent = '';
    (cfg.rewards || []).forEach(addRow);
    f.cap.value = String(cfg.cap);
  }
  function when(ts) { try { return ts ? new Date(ts).toLocaleString() : ''; } catch (e) { return ''; } }
  function pin(s) {
    // the row with this exact title (and no id yet) gets the id; else a new row
    var all = rows.querySelectorAll('.adm-inline'), hit = null;
    for (var i = 0; i < all.length; i++) if (val(all[i], 'title') === (s.title || '') && !val(all[i], 'id')) { hit = all[i]; break; }
    if (!hit) hit = addRow({ id: '', title: s.title || '', amount: '' });
    hit.querySelector('[data-k="id"]').value = s.reward_id;
    say('Pinned - Save to keep it.');
  }
  function showSeen(list) {
    seenT.textContent = '';
    if (!list || !list.length) { var tr0 = el('tr'); tr0.appendChild(el('td', { colspan: '6', class: 'empty' }, 'None yet.')); seenT.appendChild(tr0); return; }
    list.forEach(function (s) {
      var tr = el('tr');
      tr.appendChild(el('td', null, s.title || ''));
      tr.appendChild(el('td', null, s.reward_id || ''));
      tr.appendChild(el('td', { class: 'num' }, String(s.n || 0)));
      tr.appendChild(el('td', null, s.last_outcome || ''));
      tr.appendChild(el('td', null, when(s.last_ts)));
      var td = el('td');
      if (canEdit && s.reward_id) {
        var b = el('button', { type: 'button', class: 'ds-btn sm ghost' }, 'Pin id');
        b.addEventListener('click', function () { pin(s); });
        td.appendChild(b);
      }
      tr.appendChild(td);
      seenT.appendChild(tr);
    });
  }
  function load() {
    fetch('/api/admin/twitch-cp', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { say((j && j.error) || 'Could not load.'); return; }
        canEdit = !!j.can_edit;
        if (addB) addB.disabled = !canEdit;
        if (saveB) saveB.disabled = !canEdit;
        f.cap.disabled = !canEdit;
        show(j.cfg);
        showSeen(j.seen);
      }).catch(function () { say('Could not load.'); });
  }
  if (addB) addB.addEventListener('click', function () { addRow({}).querySelector('input').focus(); });
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!canEdit) return;
    var list = [];
    rows.querySelectorAll('.adm-inline').forEach(function (d) {
      var id = val(d, 'id'), title = val(d, 'title'), amount = val(d, 'amount');
      if (!id && !title && !amount) return;   // an empty row is dropped
      list.push({ id: id || null, title: title || null, amount: amount === '' ? null : Number(amount) });
    });
    var cap = String(f.cap.value).trim();
    say('Saving…');
    fetch('/api/admin/twitch-cp', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ rewards: list, cap: cap === '' ? null : Number(cap) }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { show(j.cfg); say('Saved - applies to the next redemption.'); } else say((j && j.error) || 'Not saved.'); })
      .catch(function () { say('Not saved.'); });
  });
  load();
})();
