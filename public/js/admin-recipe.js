// admin-recipe.js (1.99ada) - /admin/economy's 💸 Pad-vault payout recipe card (views/partials/econ-recipe.ejs, recipecfg.js).
// Read: GET /api/admin/econ/recipe (saved values, what Pepe applies, state, the change log, the biggest vaults' last payout
// day). Save (a Pepe owner only - the server re-checks): the /admin/economy step-up - a single-use nonce from
// POST /api/admin/econ/edit/nonce + the account password - then POST /api/admin/econ/recipe {nonce, password, base_rev, cfg,
// note}. The form works in whole percents and sends fractions (0.2 = 20%). The live sum line mirrors the server's rules
// (recipecfg.clean); the server's answer is what counts. Everything from the server is shown as text (textContent).
(function () {
  'use strict';
  var box = document.getElementById('rcfgAdm');
  if (!box) return;
  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var $ = function (id) { return document.getElementById(id); };
  var csrf = box.getAttribute('data-csrf');
  var canEdit = box.getAttribute('data-edit') === '1';
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var when = function (ms) { return ms ? new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') : '—'; };
  var FIELDS = [['owner_pct', 'rcfgOwner'], ['gang_pct', 'rcfgGang'], ['streamer_pct', 'rcfgStreamers'], ['people_pct', 'rcfgPeople'], ['games_pct', 'rcfgGames']];
  var LABEL = {
    owner_pct: _t('js.admrcfg.lbl_owner', 'owner'), gang_pct: _t('js.admrcfg.lbl_gang', 'gang'), streamer_pct: _t('js.admrcfg.lbl_streamers', 'streamers'),
    people_pct: _t('js.admrcfg.lbl_people', 'regulars'), games_pct: _t('js.admrcfg.lbl_games', 'room games')
  };
  var st = null, pending = null, nonce = null;

  function msg(t, bad) { var m = $('rcfgMsg'); m.textContent = t || ''; m.className = 'adm-msg rcfg-out' + (bad ? ' rcfg-bad' : ''); }
  function kv(el, label, value) { var d = document.createElement('div'), b = document.createElement('b'), s = document.createElement('span'); b.textContent = label; s.textContent = value; d.appendChild(b); d.appendChild(s); el.appendChild(d); }
  function row(tbody, cells, cls) {
    var tr = document.createElement('tr');
    cells.forEach(function (c, i) { var td = document.createElement('td'); td.textContent = c == null ? '' : String(c); if (cls && cls[i]) td.className = cls[i]; tr.appendChild(td); });
    tbody.appendChild(tr);
    return tr;
  }
  function empty(tbody, cols, text) { tbody.textContent = ''; var tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = cols; td.className = 'empty'; td.textContent = text; tr.appendChild(td); tbody.appendChild(tr); }
  function dur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return _t('js.admrcfg.dur_s', '{n}s', { n: s });
    if (s < 5400) return _t('js.admrcfg.dur_m', '{n}m', { n: Math.round(s / 60) });
    if (s < 172800) return _t('js.admrcfg.dur_h', '{n}h', { n: Math.round(s / 3600) });
    return _t('js.admrcfg.dur_d', '{n}d', { n: Math.round(s / 86400) });
  }
  var pc = function (v) { return Math.round(Number(v) * 100); };
  var onOff = function (v) { return Number(v) === 1 ? _t('js.admrcfg.on', 'on') : _t('js.admrcfg.off', 'off'); };

  function api(path, body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: { 'x-csrf-token': csrf, 'X-Requested-With': 'fetch' } };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); });
  }

  // the values the form starts from: saved on the website, else Pepe's last reported values, else the defaults
  function base() {
    if (!st) return null;
    if (st.saved) return st.saved.cfg;
    var out = {}, p = st.pepe.cfg || {};
    FIELDS.forEach(function (f) { out[f[0]] = p[f[0]] != null ? Number(p[f[0]]) : st.defaults[f[0]]; });
    out.games_unpaid = p.games_unpaid != null ? Number(p.games_unpaid) : st.defaults.games_unpaid;
    return out;
  }
  function fill(c) {
    FIELDS.forEach(function (f) { $(f[1]).value = String(pc(c[f[0]])); });
    $('rcfgUnpaid').checked = Number(c.games_unpaid) === 1;
    sum();
  }
  // the form -> {cfg} (fractions) or {err}; the same rules as the server
  function read() {
    var cfg = {}, n = {}, bad = false;
    FIELDS.forEach(function (f) {
      var s = String($(f[1]).value).trim(), v = /^\d{1,3}$/.test(s) ? parseInt(s, 10) : NaN;
      if (!(v >= 0 && v <= 100)) bad = true;
      n[f[0]] = v; cfg[f[0]] = v / 100;
    });
    cfg.games_unpaid = $('rcfgUnpaid').checked ? 1 : 0;
    if (bad) return { err: _t('js.admrcfg.err_whole', 'Each slice is a whole percent from 0 to 100.') };
    var paid = n.owner_pct + n.gang_pct + n.streamer_pct + n.people_pct, total = paid + n.games_pct;
    if (paid > 100) return { err: _t('js.admrcfg.err_paid', "owner + gang + streamers + regulars can't be more than 100% (they would pay out more than the day's budget)"), total: total };
    if (total > 150) return { err: _t('js.admrcfg.err_total', "all five slices can't add up to more than 150%"), total: total };
    var warn = total > 100 ? _t('js.admrcfg.warn_over', "the slices add up to {total}%: on a day every slice pays in full, room games get only what's left of the budget", { total: total })
      : total < 100 ? _t('js.admrcfg.warn_under', "{n}% of each day's budget is never assigned and always stays in the vault", { n: 100 - total }) : '';
    return { cfg: cfg, total: total, warn: warn };
  }
  function sum() {
    var r = read(), el = $('rcfgSum');
    el.textContent = r.total != null ? _t('js.admrcfg.total', 'Total {total}%', { total: r.total }) + (r.err || r.warn ? ' - ' + (r.err || r.warn) : '') : (r.err || '');
    el.className = 'adm-help rcfg-wide' + (r.err ? ' rcfg-bad' : '');
    if (canEdit) $('rcfgSave').disabled = !!r.err;
    return r;
  }
  function diff(from, to) {
    var out = [];
    FIELDS.forEach(function (f) {
      var k = f[0];
      if (!from || from[k] == null || pc(from[k]) !== pc(to[k])) out.push(_t('js.admrcfg.diff_pct', '{label} {from}% → {to}%', { label: LABEL[k], from: from && from[k] != null ? pc(from[k]) : '?', to: pc(to[k]) }));
    });
    if (!from || from.games_unpaid == null || Number(from.games_unpaid) !== Number(to.games_unpaid)) out.push(_t('js.admrcfg.lbl_unpaid', 'unpaid shares → games: {v}', { v: onOff(to.games_unpaid) }));
    return out;
  }
  function changedText(d) {
    if (!d) return '—';
    var keys = d.changed || [], out = [];
    keys.forEach(function (k) {
      if (k === 'games_unpaid') out.push(_t('js.admrcfg.lbl_unpaid', 'unpaid shares → games: {v}', { v: onOff((d.to || {})[k]) }));
      else if (LABEL[k]) out.push(_t('js.admrcfg.diff_pct', '{label} {from}% → {to}%', { label: LABEL[k], from: d.from && d.from[k] != null ? pc(d.from[k]) : '?', to: pc((d.to || {})[k]) }));
    });
    return (d.rev ? 'rev ' + d.rev + ': ' : '') + (out.join(', ') || '—');
  }

  function render() {
    var k = $('rcfgKv'); k.textContent = '';
    var S = st.saved, P = st.pepe;
    kv(k, _t('js.admrcfg.saved_k', 'Saved on the website'), S ? _t('js.admrcfg.saved_v', 'rev {rev} by {by}, {when} UTC', { rev: S.rev, by: S.by || '?', when: when(S.at) })
      : _t('js.admrcfg.not_set', "Not set on the website: Pepe's own values apply (shown). Saving makes the website the source of truth for these six values."));
    var age = P.synced ? Date.now() - Number(P.synced) : null, applies;
    if (st.state === 'applied') applies = _t('js.admrcfg.applied', 'rev {rev} (his last sync {ago})', { rev: S.rev, ago: age == null ? _t('js.admrcfg.never', 'never') : _t('js.admrcfg.ago', '{d} ago', { d: dur(age) }) });
    else if (st.state === 'pending') {
      applies = _t('js.admrcfg.pending', "Pending: Pepe hasn't picked up rev {rev} yet (he syncs about every 5 minutes)", { rev: S.rev });
      if (age == null) applies += '. ' + _t('js.admrcfg.never_synced', "Pepe hasn't synced yet; he keeps his last values until he does");
      else if (age > 15 * 60 * 1000) applies += '. ' + _t('js.admrcfg.stale_sync', "Pepe hasn't synced for {ago}; he keeps his last values until he does", { ago: dur(age) });
    } else if (st.state === 'refused') applies = _t('js.admrcfg.refused', 'Pepe refused rev {rev}: {errors}', { rev: S.rev, errors: ((P.cfg_error || {}).errors || []).join('; ') || '?' });
    else if (st.state === 'old_pepe') applies = _t('js.admrcfg.old_pepe', "Pepe doesn't report a recipe revision yet (needs Pepe 1.99adb)");
    else applies = _t('js.admrcfg.own', 'his own values (set in chat)');
    kv(k, _t('js.admrcfg.pepe_k', 'Pepe applies'), applies);
    var hr = Number((P.cfg || {}).hour);
    kv(k, _t('js.admrcfg.effect_k', 'Takes effect'), _t('js.admrcfg.effect_v', "the next daily payout, ~{hour}:00 Pepe's time", { hour: (hr >= 0 && hr < 24 ? (hr < 10 ? '0' : '') + hr : '05') }));
    kv(k, _t('js.admrcfg.payouts_k', 'Room payouts'), P.on ? _t('js.admrcfg.on', 'on') : _t('js.admrcfg.payouts_off', 'off (saving is allowed; the values apply when payouts start)'));
    var o = $('rcfgOther'); o.textContent = '';
    var any = false;
    (st.pepe_keys || []).forEach(function (key) { var v = (P.cfg || {})[key]; if (v != null) any = true; kv(o, key, v == null ? '—' : String(v)); });
    if (!any) { o.textContent = ''; kv(o, _t('js.admrcfg.status', 'Status'), _t('js.admrcfg.other_none', "Pepe hasn't reported his rules yet.")); }
    var L = $('rcfgLast');
    if (!(st.last || []).length) empty(L, 7, _t('js.admrcfg.none_last', 'No payout day reported yet.'));
    else {
      L.textContent = '';
      var n = ['', '', 'num', 'num', 'num', 'num', 'num'];
      // capped (1.99ada): the five slices add up to more than 100 %, so the allowance is below slice + unpaid shares (Pepe caps
      // it at the budget left after everything paid) - say so instead of a sum that doesn't add up
      st.last.forEach(function (x) {
        var tr = row(L, [x.title, x.day, fmt(x.B), fmt(x.games_base), fmt(x.games_from_unpaid),
          x.capped ? _t('js.admrcfg.allow_capped', '{n} (capped)', { n: fmt(x.games_allow) }) : fmt(x.games_allow), x.used == null ? '—' : fmt(x.used)], n);
        if (x.capped) tr.children[5].title = _t('js.admrcfg.capped_t', 'Capped: the five slices add up to more than 100%, so the room games got only what was left of the budget after everything paid.');
      });
    }
    var G = $('rcfgLog');
    if (!(st.log || []).length) empty(G, 5, _t('js.admrcfg.none_log', 'No changes yet.'));
    else {
      G.textContent = '';
      st.log.forEach(function (x) {
        var d = x.detail || {};
        row(G, [when(x.at), x.admin || '?', d.via === 'chat' ? _t('js.admrcfg.via_chat', 'chat') : _t('js.admrcfg.via_web', 'web'), changedText(d), x.reason || '']);
      });
    }
    if (canEdit && st.can_edit !== true) {        // the server's answer wins (a role changed since the page loaded)
      canEdit = false;
      Array.prototype.forEach.call($('rcfgForm').querySelectorAll('input, button'), function (el) { el.disabled = true; });
    }
  }
  function load(refill) {
    return api('/api/admin/econ/recipe').then(function (r) {
      if (r.status !== 200 || !r.j.ok) throw new Error(r.j.error || _t('js.admrcfg.failed', 'That did not work - try again.'));
      st = r.j; render();
      if (refill !== false) fill(base());
    }).catch(function (e) { msg(e.message, true); });
  }
  function cancel() { pending = null; nonce = null; $('rcfgConfirm').hidden = true; $('rcfgPw').value = ''; }

  $('rcfgForm').addEventListener('input', function () { sum(); });
  $('rcfgForm').addEventListener('change', function () { sum(); });
  $('rcfgDefaults').addEventListener('click', function () {
    if (!st || !canEdit) return;
    fill(st.defaults);
    msg(_t('js.admrcfg.defaults_filled', 'Defaults filled in - press Save to keep them.'));
  });
  $('rcfgForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!st || !canEdit) return;
    var r = sum();
    if (r.err) { msg(r.err, true); return; }
    var d = diff(st.saved ? st.saved.cfg : base(), r.cfg);
    if (st.saved && !d.length) { msg(_t('js.admrcfg.confirm_same', "No change from what's saved.")); return; }
    cancel();
    pending = r.cfg;
    $('rcfgWhat').textContent = _t('js.admrcfg.confirm', "Save the payout recipe: {diff}. It applies from the next daily payout; today's prize pool doesn't change.", { diff: d.join(', ') || _t('js.admrcfg.first_save', 'the values shown (the website becomes the source of truth for them)') })
      + (r.warn ? ' ' + r.warn + '.' : '');
    $('rcfgConfirm').hidden = false;
    msg('');
    api('/api/admin/econ/edit/nonce', {}).then(function (x) {
      if (!x.j.nonce) throw new Error(x.j.error || _t('js.admrcfg.failed', 'That did not work - try again.'));
      nonce = x.j.nonce; $('rcfgPw').focus();
    }).catch(function (e2) { msg(e2.message, true); cancel(); });
  });
  $('rcfgNo').addEventListener('click', function () { cancel(); msg(_t('js.admrcfg.cancelled', 'Cancelled - nothing saved.')); });
  $('rcfgYes').addEventListener('click', function () {
    if (!pending || !nonce) { msg(_t('js.admrcfg.start_again', 'Start again.'), true); return; }
    var body = { nonce: nonce, password: $('rcfgPw').value, base_rev: st.saved ? st.saved.rev : null, cfg: pending, note: $('rcfgNote').value };
    cancel();
    msg(_t('js.admrcfg.saving', 'Saving…'));
    api('/api/admin/econ/recipe', body).then(function (r) {
      var j = r.j || {};
      if (r.status === 200 && j.ok) {
        var w = (j.warnings || []).length ? ' ' + j.warnings.join('; ') + '.' : '';
        msg(j.unchanged ? _t('js.admrcfg.unchanged', 'Those values are already saved - nothing changed.')
          : _t('js.admrcfg.saved', 'Saved as rev {rev}. Pepe picks it up within about 5 minutes and applies it from the next daily payout.', { rev: j.saved.rev }) + w);
        $('rcfgNote').value = '';
        return load();
      }
      if (j.code === 'stale') { msg(_t('js.admrcfg.stale', 'Someone changed the recipe meanwhile; review it and save again'), true); return load(); }
      if (j.code === 'owner_only') { msg(_t('js.admrcfg.not_owner', 'Only a Pepe owner can change the payout recipe.'), true); return null; }
      msg((j.errors && j.errors.length ? j.errors.join('; ') : j.error) || _t('js.admrcfg.failed', 'That did not work - try again.'), true);
      return null;
    }).catch(function (e) { msg(e.message, true); });
  });
  load();
})();
