// /admin/soundboards (1.99rh): soundboard reports + renders, the voice catalogue, voice clones, likeness royalties, settings.
(function () {
  'use strict';
  var root = document.getElementById('sbAdm');
  if (!root) return;
  var msg = document.getElementById('saMsg');
  function say(t, c) { msg.textContent = t || ''; msg.className = 'sa-msg' + (c ? ' ' + c : ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function when(t) { return t ? new Date(Number(t)).toISOString().slice(0, 16).replace('T', ' ') : '—'; }
  function get(u) { return fetch(u, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); }); }
  function post(u, b) {
    return fetch(u, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) { if (!d || !d.ok) throw new Error((d && d.error) || 'failed'); return d; });
  }
  function box(k) { return root.querySelector('[data-sa="' + k + '"]'); }
  function table(head, rows) {
    if (!rows.length) return '<p class="ds-meta">Nothing here.</p>';
    return '<table><thead><tr>' + head.map(function (h) { return '<th scope="col"' + (h.r ? ' class="r"' : '') + '>' + esc(h.t || h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }
  function play(a) { return a ? '<audio controls preload="none" src="' + esc(a) + '" style="height:28px;max-width:180px"></audio>' : ''; }
  function cfgForm(form, cfg, skip) {
    if (!form) return;   // 1.99ack: a part this viewer can't use isn't on the page
    form.innerHTML = Object.keys(cfg).filter(function (k) { return typeof cfg[k] !== 'object' && (!skip || skip.indexOf(k) < 0); }).map(function (k) {
      var v = cfg[k];
      if (typeof v === 'boolean') return '<label><span>' + esc(k) + '</span><select name="' + esc(k) + '"><option value="1"' + (v ? ' selected' : '') + '>on</option><option value="0"' + (!v ? ' selected' : '') + '>off</option></select></label>';
      return '<label><span>' + esc(k) + '</span><input type="number" name="' + esc(k) + '" value="' + esc(v) + '"></label>';
    }).join('') + '<div><button class="ds-btn sm" type="submit">Save</button></div>';
    form._cfg = cfg;
  }
  function readForm(form) {
    var out = {};
    form.querySelectorAll('[name]').forEach(function (i) { var k = i.name, v = form._cfg[k]; out[k] = typeof v === 'boolean' ? i.value === '1' : Number(i.value); });
    return out;
  }

  function loadSb() {
    if (!box('reports')) return Promise.resolve();
    return get('/api/soundboards/admin').then(function (d) {
      if (!d.ok) { box('reports').textContent = 'Staff only.'; return; }
      box('reports').innerHTML = table(['Clip', 'Board', 'Status', { t: 'Reports', r: 1 }, 'Audio', ''], d.reported.map(function (c) {
        return '<tr><td>' + esc(c.label) + '<br><small>' + esc(c.id) + '</small></td><td>' + esc(c.board) + '</td><td>' + esc(c.status) + '<br><small>' + esc(c.note || '') + '</small></td><td class="r">' + c.reports + '</td><td>' + play(c.audio) +
          '</td><td class="sa-acts"><button class="ds-btn sm" data-clip="' + esc(c.id) + '" data-act="restore">Restore</button><button class="ds-btn sm ghost" data-clip="' + esc(c.id) + '" data-act="hide">Hide</button><button class="ds-btn sm danger" data-clip="' + esc(c.id) + '" data-act="remove">Remove</button></td></tr>';
      }));
      box('renders').innerHTML = table(['Clip', 'Board', 'Note', { t: 'Tries', r: 1 }, ''], d.failed.map(function (c) {
        return '<tr><td>' + esc(c.label) + '<br><small>' + esc(c.id) + '</small></td><td>' + esc(c.board) + '</td><td>' + esc(c.note || '') + '</td><td class="r">' + (c.tries || 0) +
          '</td><td><button class="ds-btn sm" data-clip="' + esc(c.id) + '" data-act="rerender">Render again</button></td></tr>';
      }));
      box('sales').innerHTML = table(['Item', { t: 'Sold', r: 1 }, { t: 'PAT', r: 1 }], d.sales.map(function (s) { return '<tr><td>' + esc(s.item) + '</td><td class="r">' + s.n + '</td><td class="r">' + num(s.pat) + '</td></tr>'; }));
      box('plays').innerHTML = table(['Clip', { t: 'Plays', r: 1 }, { t: 'PAT', r: 1 }], d.plays.map(function (s) { return '<tr><td>' + esc(s.clip_id) + '</td><td class="r">' + s.n + '</td><td class="r">' + num(s.pat) + '</td></tr>'; }));
      cfgForm(root.querySelector('[data-sa-cfg="sb"]'), d.cfg);
    });
  }
  function loadVoices() {
    if (!box('voices')) return Promise.resolve();
    return get('/api/voices/admin').then(function (d) {
      if (!d.ok) { box('voices').textContent = 'Staff only.'; return; }
      box('voices').innerHTML = table(['Voice', 'Owner', { t: 'Per use', r: 1 }, { t: 'Unlock', r: 1 }, { t: 'Cut %', r: 1 }, 'Flags', 'Status', ''], d.voices.map(function (v) {
        var flag = function (k, label) { return '<label style="display:block"><input type="checkbox" data-v="' + esc(v.id) + '" data-flag="' + k + '"' + (v[k] ? ' checked' : '') + '> ' + label + '</label>'; };
        return '<tr data-row="' + esc(v.id) + '"><td><b>' + esc(v.display) + '</b><br><small>' + esc(v.kind) + (v.in_voicebox ? '' : ' · not in VoiceBox') + '</small></td>' +
          '<td><input type="text" data-k="owner" value="' + esc(v.owner || '') + '" placeholder="stock"></td>' +
          '<td class="r"><input type="number" data-k="price_use" value="' + v.price_use + '"></td><td class="r"><input type="number" data-k="price_unlock" value="' + v.price_unlock + '"></td>' +
          '<td class="r"><input type="number" data-k="royalty_pct" value="' + v.royalty_pct + '"></td>' +
          '<td>' + flag('listed', 'listed') + flag('allow_free_text', 'free text') + flag('allow_soundboard', 'soundboards') + flag('consent_manual', 'consent on file (manual)') + '</td>' +
          '<td><select data-k="status">' + ['active', 'paused', 'pending', 'revoked'].map(function (s) { return '<option' + (s === v.status ? ' selected' : '') + (s === 'revoked' ? ' disabled' : '') + '>' + s + '</option>'; }).join('') + '</select></td>' +
          '<td><button class="ds-btn sm" data-save-voice="' + esc(v.id) + '">Save</button></td></tr>';
      }));
    });
  }
  function loadLikeness() {
    if (!box('likeness')) return Promise.resolve();
    return get('/api/likeness/admin').then(function (d) {
      if (!d.ok) { box('likeness').textContent = 'Staff only.'; return; }
      var tot = d.totals || {};
      var head = '<p>Held <b>' + num((tot.held || {}).amount) + '</b> · paid <b>' + num((tot.paid || {}).amount) + '</b> · forfeited (stays with the platform) <b>' + num((tot.forfeit || {}).amount) +
        '</b> · people with an opt-out <b>' + d.optouts + '</b> <button class="ds-btn sm ghost" data-lk-release="1">Run the release now</button></p>';
      var top = table(['Subject', { t: 'Held', r: 1 }, { t: 'Paid', r: 1 }, ''], d.top.map(function (r) {
        return '<tr><td>' + esc(r.username || r.user_id) + ' <small>' + esc(r.camfrog || '') + '</small>' + (r.frozen ? ' <span class="ds-chip warn">frozen</span>' : '') + '</td><td class="r">' + num(r.held) + '</td><td class="r">' + num(r.paid) +
          '</td><td class="sa-acts"><button class="ds-btn sm ghost" data-lk-freeze="' + esc(r.user_id) + '" data-on="' + (r.frozen ? 0 : 1) + '">' + (r.frozen ? 'Unfreeze' : 'Freeze') +
          '</button><button class="ds-btn sm danger" data-lk-claw="' + esc(r.user_id) + '">Claw back held</button></td></tr>';
      }));
      var why = table(['Not paid because', { t: 'Rows', r: 1 }, { t: 'PAT', r: 1 }], (d.reasons || []).map(function (r) { return '<tr><td>' + esc(r.reason) + '</td><td class="r">' + r.n + '</td><td class="r">' + num(r.t) + '</td></tr>'; }));
      box('likeness').innerHTML = head + top + '<h3 class="ds-h3">Forfeits</h3>' + why;
      var cfg = Object.assign({}, d.config);
      var pct = cfg.pct || {};
      delete cfg.pct;
      Object.keys(pct).forEach(function (k) { cfg['pct.' + k] = pct[k]; });
      cfgForm(root.querySelector('[data-sa-cfg="lk"]'), cfg);
    });
  }
  function loadClones() {
    if (!box('clones')) return Promise.resolve();
    return get('/api/voiceclone/admin').then(function (d) {
      if (!d || !d.ok) { box('clones').innerHTML = '<p class="ds-meta">Not available.</p>'; return; }
      box('clones').innerHTML = table(['Who', 'Status', 'Checks', 'Audio', 'Created', ''], d.rows.map(function (c) {
        var acts = c.status === 'review' ? '<button class="ds-btn sm" data-vc="' + c.id + '" data-act="approve">Approve</button><button class="ds-btn sm danger" data-vc="' + c.id + '" data-act="deny">Deny</button>' :
          (c.status === 'active' ? '<button class="ds-btn sm danger" data-vc="' + c.id + '" data-act="revoke">Revoke + delete</button>' : '');
        return '<tr><td>' + esc(c.username) + '<br><small>' + esc(c.login) + '</small></td><td>' + esc(c.status) + (c.why ? '<br><small>' + esc(c.why) + '</small>' : '') + '</td><td><small>' + esc(c.checks || '') + '</small></td><td>' +
          (c.audio ? play(c.audio) : '') + '</td><td>' + when(c.created) + '</td><td class="sa-acts">' + acts + '</td></tr>';
      }));
      cfgForm(root.querySelector('[data-sa-cfg="vc"]'), d.cfg);
    }).catch(function () { box('clones').innerHTML = '<p class="ds-meta">Not available.</p>'; });
  }
  function all() { return Promise.all([loadSb(), loadVoices(), loadLikeness(), loadClones()]).catch(function (e) { say(e.message, 'bad'); }); }

  root.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    var p = null;
    if (b.getAttribute('data-clip')) p = post('/api/soundboards/admin', { clip: b.getAttribute('data-clip'), action: b.getAttribute('data-act') });
    else if (b.getAttribute('data-save-voice')) {
      var id = b.getAttribute('data-save-voice'), row = root.querySelector('[data-row="' + id + '"]'), body = { voice: id };
      row.querySelectorAll('[data-k]').forEach(function (i) { var k = i.getAttribute('data-k'); body[k] = k === 'owner' || k === 'status' ? i.value : Number(i.value); });
      row.querySelectorAll('[data-flag]').forEach(function (i) { body[i.getAttribute('data-flag')] = !!i.checked; });
      p = post('/api/voices/admin', body);
    } else if (b.getAttribute('data-lk-release')) p = post('/api/likeness/admin', { release: true });
    else if (b.getAttribute('data-lk-freeze')) p = post('/api/likeness/admin', { freeze: { user: b.getAttribute('data-lk-freeze'), on: b.getAttribute('data-on') === '1', reason: window.prompt('Why?') || '' } });
    else if (b.getAttribute('data-lk-claw')) {
      if (!window.confirm('Forfeit everything still held for this person? (The PAT stays with the platform.)')) return;
      p = post('/api/likeness/admin', { clawback: { user: b.getAttribute('data-lk-claw'), reason: window.prompt('Why?') || '' } });
    } else if (b.getAttribute('data-vc')) {
      var act = b.getAttribute('data-act');
      if (act !== 'approve' && !window.confirm(act === 'revoke' ? 'Revoke this voice and delete it from both VoiceBox hosts?' : 'Deny this clone?')) return;
      p = post('/api/voiceclone/admin', { id: Number(b.getAttribute('data-vc')), action: act, reason: act === 'approve' ? '' : (window.prompt('Reason (shown to them)?') || '') });
    }
    if (!p) return;
    b.disabled = true;
    p.then(function () { say('Saved.', 'ok'); return all(); }).catch(function (e) { b.disabled = false; say(e.message, 'bad'); });
  });
  root.addEventListener('submit', function (ev) {
    var f = ev.target, kind = f.getAttribute('data-sa-cfg');
    if (!kind) return;
    ev.preventDefault();
    var v = readForm(f), p;
    if (kind === 'sb') p = post('/api/soundboards/admin', { config: v });
    else if (kind === 'vc') p = post('/api/voiceclone/admin', { config: v });
    else {
      var cfg = { pct: {} };
      Object.keys(v).forEach(function (k) { if (k.indexOf('pct.') === 0) cfg.pct[k.slice(4)] = v[k]; else cfg[k] = v[k]; });
      p = post('/api/likeness/admin', { config: cfg });
    }
    p.then(function () { say('Saved.', 'ok'); return all(); }).catch(function (e) { say(e.message, 'bad'); });
  });
  all();
})();
