// profile-mod.js - profmod: the profile's ⋯ More "Admin" group (views/profile.ejs, profilemod.js). Each item is an EXISTING staff action on
// this one account, behind its own route (which checks the viewer's capability again); this file only opens the in-page confirm sheet -
// block-sheet.js PATVSheet, the person menu's look (a bottom sheet on phones), never window.confirm - and calls that route:
//
//   ⛔ siteban / ↩️ lift   PATVBanSheet (pad-ban-sheet.js) on their profile pad, only: ['site'] -> /api/rooms/:slug/ban|unban
//   🌐 bridge             GET + POST /api/admin/bridge/blocks {target: 'u:<id>'} - the features they can't use in EVERY room, a length, a reason
//   🎬 stage / unstage    POST /api/stage/admin/ban {userId, reason} | /api/stage/admin/unban {userId}
//   ⭐ creator            POST /api/admin/creators/:userId/status {action, note}
//   🖼️ cover              POST /api/admin/stage-cover/remove {user_id}
//   🔐 signout            POST /api/admin/users/:id/sessions/revoke {reason, confirm: their username typed}
//
// The menu closes first (block-sheet.js does the same for 🚫 Block); after a change lands the page reloads, so the menu's status lines and
// items say what is in force now. Everything user-visible goes in via textContent.
(function (W, D) {
  'use strict';
  var _t = typeof W.__t === 'function' ? W.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(url, body) {
    var o = { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } };
    if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) { if (j && j.ok == null && !r.ok) j.ok = false; return j || { ok: false }; }); });
  }
  function utc(ms) { try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch (e) { return ''; } }
  function reload() { setTimeout(function () { W.location.reload(); }, 900); }
  var OFFLINE = function () { return _t('js.pfmod.offline', 'Couldn\'t reach the site.'); };
  var FAILED = function () { return _t('js.pfmod.failed', 'Not changed.'); };

  // ── shared bits of a sheet ──
  function open(c, title, anchor) {
    var S = W.PATVSheet.open({ title: title, cls: 'psh-pfmod', anchor: anchor });
    if (c.who) S.body.appendChild(el('p', 'psh-sub', c.who));
    return S;
  }
  /** A text box with its label and the "needs ..." line under it. */
  function field(S, label, o) {
    o = o || {};
    var f = el('div', 'psh-fld'), l = el('label', 'psh-k', label), i = el('input');
    i.type = 'text'; i.id = S.id + (o.id || 'W'); i.maxLength = o.max || 120; i.autocomplete = 'off'; i.spellcheck = o.spell !== false;
    if (o.placeholder) i.placeholder = o.placeholder;
    l.htmlFor = i.id;
    var need = el('p', 'psh-need', ''); need.id = i.id + 'N'; i.setAttribute('aria-describedby', need.id);
    f.appendChild(l); f.appendChild(i); f.appendChild(need); S.body.appendChild(f);
    return { input: i, need: need, value: function () { return i.value.replace(/\s+/g, ' ').trim(); } };
  }
  /** Radio chips: [[value, label]] -> {value()} */
  function chips(S, label, opts, def, onChange) {
    var k = el('p', 'psh-k', label); k.id = S.id + 'C' + (++chipSeq); S.body.appendChild(k);
    var row = el('div', 'psh-chips'); row.setAttribute('role', 'radiogroup'); row.setAttribute('aria-labelledby', k.id);
    var cur = def;
    opts.forEach(function (op) {
      var lab = el('label', 'psh-chip'), r = el('input'); r.type = 'radio'; r.name = k.id; r.value = op[0]; r.checked = op[0] === def;
      r.addEventListener('change', function () { if (r.checked) { cur = op[0]; if (onChange) onChange(cur); } });
      lab.appendChild(r); lab.appendChild(el('span', null, op[1])); row.appendChild(lab);
    });
    S.body.appendChild(row);
    return { value: function () { return cur; } };
  }
  var chipSeq = 0;
  /** Send, show the answer in the sheet's status line; done(answer) -> the success text. gone(answer) -> a text when the answer means
   *  "already so" (lifted / taken down elsewhere meanwhile): said as done, and the page reloads so the stale item goes (review fix). */
  function send(B, call, done, gone) {
    B.go.disabled = true; B.out.className = 'psh-out'; B.out.textContent = _t('js.pfmod.sending', 'One moment…');
    // (review fix: a refusal brings the button back AND focus to it - disabling the focused button had left focus on the page body)
    function again(cls, txt) { B.out.className = 'psh-out ' + cls; B.out.textContent = txt; B.go.disabled = false; try { B.go.focus(); } catch (e) { /* gone */ } }
    call().then(function (a) {
      var g = a && !a.ok && gone ? gone(a) : null;
      if (g) { B.out.className = 'psh-out'; B.out.textContent = g; reload(); return; }
      if (!a || !a.ok) { again('bad', (a && a.error) || FAILED()); return; }
      var txt = done(a);
      // (done, but not as asked - said and left on screen, never "Done", nothing to press again)
      if (txt && typeof txt === 'object') { B.out.className = 'psh-out bad'; B.out.textContent = txt.bad; return; }
      B.out.className = 'psh-out ok'; B.out.textContent = txt;
      reload();
    }).catch(function () { again('bad', OFFLINE()); });
  }

  // ── ⛔ the site-wide ban + its Lift: the person menu's own ban sheet, on their profile pad, the whole site only ──
  function siteBan(c, anchor, lift) {
    if (!W.PATVBanSheet || !c.slug) return;
    W.PATVBanSheet.open({ ref: c.ref, slug: c.slug, scope: 'site', only: ['site'], lift: !!lift, name: '@' + c.u, anchor: anchor, onDone: reload });
  }

  // ── 🌐 web bridge restrictions in every room (bridgeblocks.js global rows - /admin/users "Web bridge restrictions") ──
  var FEAT = {
    all: function () { return _t('js.pfmod.f_all', 'Everything (all of the below)'); }, chat: function () { return _t('js.pfmod.f_chat', 'Chat (relay lines)'); },
    commands: function () { return _t('js.pfmod.f_commands', 'Commands + the Pepe menu'); }, soundboard: function () { return _t('js.pfmod.f_soundboard', 'Soundboard'); },
    voice: function () { return _t('js.pfmod.f_voice', 'Voice clips (push-to-talk)'); }, snapshots: function () { return _t('js.pfmod.f_snapshots', 'Cam snapshots'); },
    livecams: function () { return _t('js.pfmod.f_livecams', 'Live cams'); }, clips: function () { return _t('js.pfmod.f_clips', 'Cam + mic clips'); }
  };
  function bridge(c, anchor) {
    var S = open(c, '🌐 ' + _t('js.pfmod.bridge_title', 'Web bridge, every room'), anchor);
    var wait = el('p', 'psh-hint', _t('js.pfmod.loading', 'Loading…')); S.body.appendChild(wait);
    var target = 'u:' + c.id;
    api('/api/admin/bridge/blocks?target=' + encodeURIComponent(target)).then(function (j) {
      if (S.done) return;
      wait.remove();
      if (!j.ok) { S.body.appendChild(el('p', 'psh-p', j.error || FAILED())); W.PATVSheet.buttons(S, null); return; }
      S.body.appendChild(el('p', 'psh-p', _t('js.pfmod.bridge_body', 'What they can\'t do from the website in every room. Tick to add, untick to lift - the ones already on keep their end and reason.')));
      var had = {}, rooms = 0;
      (j.blocks || []).forEach(function (b) { if (b.global) had[b.feature || 'all'] = b; else rooms++; });
      var fs = el('fieldset', 'psh-opts'); fs.appendChild(el('legend', 'psh-k', _t('js.pfmod.bridge_what', 'Restricted')));
      var boxes = [];
      (j.features || Object.keys(FEAT)).forEach(function (f) {
        var lab = el('label', 'psh-ck'), cb = el('input'); cb.type = 'checkbox'; cb.value = f; cb.checked = !!had[f];
        var sp = el('span', null, FEAT[f] ? FEAT[f]() : f), b = had[f];
        if (b) sp.appendChild(el('small', null, (b.until ? _t('js.pfmod.until', 'until {when}', { when: utc(b.until) }) : _t('js.pfmod.until_lifted', 'until lifted'))
          + (b.reason ? ' · ' + b.reason : '') + (b.by ? ' · ' + _t('js.pfmod.by', 'by {who}', { who: b.by }) : '')));
        cb.addEventListener('change', paint);
        lab.appendChild(cb); lab.appendChild(sp); fs.appendChild(lab); boxes.push(cb);
      });
      S.body.appendChild(fs);
      if (rooms) S.body.appendChild(el('p', 'psh-hint', _t('js.pfmod.bridge_rooms', 'They also have {n} restriction(s) in single rooms - those stay (pad owners and room mods lift them).', { n: rooms })));
      var len = chips(S, _t('js.pfmod.how_long', 'How long (for the ones you add)'), [['1', _t('js.pfmod.dur_1h', '1 hour')], ['24', _t('js.pfmod.dur_1d', '1 day')],
        ['168', _t('js.pfmod.dur_7d', '7 days')], ['0', _t('js.pfmod.dur_lifted', 'Until lifted')]], '24');
      var why = field(S, _t('js.pfmod.reason_seen', 'Reason (they see it)'), { max: 200 });
      // (review fix: Save adds only what was newly ticked and lifts what was unticked - the ones already on keep their own end and reason;
      // it was: every ticked one re-sent with this sheet's length and reason (1 day, empty). Changing one already on is this box, said)
      var re = null;
      if (Object.keys(had).length) {
        var rl = el('label', 'psh-ck'); re = el('input'); re.type = 'checkbox'; re.value = 'reapply';
        rl.appendChild(re); rl.appendChild(el('span', null, _t('js.pfmod.reapply', 'Also give the ones already on this length and reason')));
        re.addEventListener('change', paint);
        S.body.appendChild(rl);
      }
      var B = W.PATVSheet.buttons(S, '🌐 ' + _t('js.pfmod.save', 'Save'), 'danger');
      function diff() {
        var want = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
        var lift = Object.keys(had).filter(function (f) { return want.indexOf(f) < 0; });
        var add = want.filter(function (f) { return !had[f] || (re && re.checked); });
        return { want: want, lift: lift, add: add };
      }
      function paint() {
        var d = diff();
        // (only lifting: a green button; any restriction: red. Nothing to add and nothing to lift: nothing to send)
        B.go.className = 'psh-btn ' + (d.add.length ? 'danger' : 'go');
        B.go.disabled = !d.add.length && !d.lift.length;
      }
      paint();
      B.go.addEventListener('click', function () {
        var d = diff();
        send(B, function () {
          var p = Promise.resolve({ ok: true });
          if (d.lift.length) p = p.then(function () { return api('/api/admin/bridge/blocks', { op: 'unblock', room: '', target: target, features: d.lift }); });
          if (d.add.length) p = p.then(function (a) { if (!a || !a.ok) return a; return api('/api/admin/bridge/blocks', { op: 'block', room: '', target: target, features: d.add, hours: len.value(), reason: why.value() }); });
          return p;
        }, function () { return d.add.length ? _t('js.pfmod.bridge_done', 'Saved - restricted in every room.') : _t('js.pfmod.bridge_lifted', 'Lifted in every room.'); });
      });
      B.no.focus();
    }).catch(function () { if (!S.done) { wait.textContent = OFFLINE(); W.PATVSheet.buttons(S, null); } });
  }

  // ── 🎬 the main stage (mainstage.js stage_bans - /stage/admin's Bans) ──
  function stage(c, anchor) {
    var S = open(c, '🎬 ' + _t('js.pfmod.stage_title', 'Ban @{name} from the stage?', { name: c.u }), anchor);
    S.body.appendChild(el('p', 'psh-p', _t('js.pfmod.stage_body', 'Their open stage slots end now and they leave every stage queue; they can\'t book a stage (the main stage or a pad\'s) until it\'s lifted. They see “You can\'t book the stage.”')));
    var why = field(S, _t('js.pfmod.reason_staff', 'Reason (kept for the staff)'), { max: 200 });
    var B = W.PATVSheet.buttons(S, '🎬 ' + _t('js.pfmod.stage_go', 'Ban from the stage'), 'danger');
    B.go.addEventListener('click', function () {
      // (review fix: by account id - a name could match a case-only twin, mainstage.ban took the first row; the answer's name is checked)
      send(B, function () { return api('/api/stage/admin/ban', { userId: c.id, reason: why.value() }); }, function (a) {
        return a.username && a.username !== c.u ? { bad: _t('js.pfmod.stage_other', 'That banned @{name} from the stage - not this profile\'s account. Check /stage/admin.', { name: a.username }) }
          : _t('js.pfmod.stage_done', 'Banned from the stage.');
      });
    });
    why.input.focus();
  }
  function unstage(c, anchor) {
    var S = open(c, '↩️ ' + _t('js.pfmod.unstage_title', 'Lift @{name}\'s stage ban?', { name: c.u }), anchor);
    var b = c.stageBan || {};
    if (c.stageBan) S.body.appendChild(el('p', 'psh-refuse', (b.at ? _t('js.pfmod.since', 'since {when}', { when: utc(b.at) }) : '') + (b.reason ? ' · ' + b.reason : '') + (b.by ? ' · ' + _t('js.pfmod.by', 'by {who}', { who: b.by }) : '')));
    S.body.appendChild(el('p', 'psh-p', _t('js.pfmod.unstage_body', 'They can book the stage again.')));
    var B = W.PATVSheet.buttons(S, '↩️ ' + _t('js.pfmod.lift_go', 'Lift it'), 'go');
    B.go.addEventListener('click', function () {
      // (review fix: {ok: false} with no error = lifted elsewhere meanwhile - said, and the page reloads)
      send(B, function () { return api('/api/stage/admin/unban', { userId: c.id }); }, function () { return _t('js.pfmod.lifted', 'Lifted.'); },
        function (a) { return a.ok === false && !a.error ? _t('js.pfmod.unstage_none', 'There\'s no stage ban on them any more.') : null; });
    });
    B.no.focus();
  }

  // ── ⭐ PATV Creators status (creators.staffSet - /admin/creators) ──
  var CR = {
    active: function () { return [_t('js.pfmod.cr_active', 'Active'), _t('js.pfmod.cr_active_sub', 'Their creator page, subscriptions and payouts work again.')]; },
    paused: function () { return [_t('js.pfmod.cr_paused', 'Paused'), _t('js.pfmod.cr_paused_sub', 'New subscriptions and payouts stop until it\'s reinstated. They\'re told, with your note.')]; },
    pending: function () { return [_t('js.pfmod.cr_pending', 'Waiting for approval'), '']; },
    banned: function () { return [_t('js.pfmod.cr_banned', 'Banned'), _t('js.pfmod.cr_banned_sub', 'Every held payment goes back to its fan and every subscription ends - reinstating later doesn\'t bring them back. They\'re told, with your note.')]; }
  };
  function creator(c, anchor) {
    var now = (c.creator && c.creator.status) || 'active';
    var S = open(c, '⭐ ' + _t('js.pfmod.creator_title', 'Creator status for @{name}', { name: c.u }), anchor);
    S.body.appendChild(el('p', 'psh-p', _t('js.pfmod.creator_now', 'Now: {status}', { status: CR[now] ? CR[now]()[0] : now })));
    var choices = ['active', 'paused', 'banned'].filter(function (s) { return s !== now; });
    var fs = el('fieldset', 'psh-opts'); fs.appendChild(el('legend', 'psh-k', _t('js.pfmod.creator_to', 'Change to')));
    var pick = choices[0];
    choices.forEach(function (st) {
      var lab = el('label', 'psh-opt'), r = el('input'); r.type = 'radio'; r.name = S.id + 'R'; r.value = st; r.checked = st === pick;
      var tx = CR[st](), sp = el('span', null, tx[0]); sp.appendChild(el('small', null, tx[1]));
      r.addEventListener('change', function () { if (r.checked) { pick = st; paint(); } });
      lab.appendChild(r); lab.appendChild(sp); fs.appendChild(lab);
    });
    S.body.appendChild(fs);
    var note = field(S, _t('js.pfmod.note_seen', 'Note (they see it)'), { max: 300 });
    var B = W.PATVSheet.buttons(S, '⭐ ' + _t('js.pfmod.save', 'Save'), 'danger');
    function paint() { B.go.className = 'psh-btn ' + (pick === 'active' ? 'go' : 'danger'); }
    paint();
    B.go.addEventListener('click', function () {
      send(B, function () { return api('/api/admin/creators/' + encodeURIComponent(c.id) + '/status', { action: pick, note: note.value() }); },
        function (a) { return a.refunded ? _t('js.pfmod.creator_refunded', 'Saved - {n} held payment(s) went back to fans.', { n: a.refunded }) : _t('js.pfmod.saved', 'Saved.'); });
    });
    var first = fs.querySelector('input:checked'); if (first) first.focus();
  }

  // ── 🖼️ their uploaded stage cover (stagecover.removeUpload - /admin/imagesafety's Stage covers) ──
  function cover(c, anchor) {
    var S = open(c, '🖼️ ' + _t('js.pfmod.cover_title', 'Take down @{name}\'s stage cover?', { name: c.u }), anchor);
    S.body.appendChild(el('p', 'psh-p', _t('js.pfmod.cover_body', 'The picture they uploaded comes off the mic stage and can\'t be uploaded again. It counts as a strike, and for 30 days their new uploads wait for a check.')));
    var B = W.PATVSheet.buttons(S, '🖼️ ' + _t('js.pfmod.cover_go', 'Take it down'), 'danger');
    B.go.addEventListener('click', function () {
      // (review fix: the route's code 'gone' - taken down elsewhere meanwhile - is said, and the page reloads)
      send(B, function () { return api('/api/admin/stage-cover/remove', { user_id: c.id }); }, function () { return _t('js.pfmod.cover_done', 'Taken down.'); },
        function (a) { return a.code === 'gone' ? (a.error || _t('js.pfmod.cover_gone', 'That cover is already gone.')) : null; });
    });
    B.no.focus();
  }

  // ── 🔐 sign out everywhere (sessions.js - /admin/accounts): a reason and their username typed, as the route asks ──
  function signout(c, anchor) {
    var S = open(c, '🔐 ' + _t('js.pfmod.signout_title', 'Sign @{name} out everywhere?', { name: c.u }), anchor);
    S.body.appendChild(el('p', 'psh-p', _t('js.pfmod.signout_body', 'Every sign-in on every device ends now - they can sign back in. Their account and password don\'t change.')));
    var why = field(S, _t('js.pfmod.reason_log', 'Reason (kept in the admin log)'), { max: 200, id: 'W' });
    // (review fix: no placeholder - their name greyed in the box read as already typed; the hint under it names them)
    var typed = field(S, _t('js.pfmod.confirm_name', 'Type their username to confirm'), { max: 64, id: 'T', spell: false });
    var B = W.PATVSheet.buttons(S, '🔐 ' + _t('js.pfmod.signout_go', 'Sign them out'), 'danger');
    function paint() {
      var okWhy = why.value().length >= 3, okName = typed.input.value.trim() === c.u;
      why.need.textContent = okWhy ? '' : _t('js.pfmod.need_reason', 'A reason is needed (3 characters or more).');
      typed.need.textContent = okName ? '' : _t('js.pfmod.need_name', 'Type @{name} exactly (without the @).', { name: c.u });
      B.go.disabled = !(okWhy && okName);
    }
    why.input.addEventListener('input', paint); typed.input.addEventListener('input', paint);
    paint();
    B.go.addEventListener('click', function () {
      send(B, function () { return api('/api/admin/users/' + encodeURIComponent(c.id) + '/sessions/revoke', { reason: why.value(), confirm: typed.input.value.trim() }); },
        function (a) { return _t('js.pfmod.signout_done', 'Signed out - {n} sign-in(s) ended.', { n: a.revoked || 0 }); });
    });
    why.input.focus();
  }

  var ACT = { siteban: function (c, a) { siteBan(c, a, false); }, lift: function (c, a) { siteBan(c, a, true); }, bridge: bridge, stage: stage, unstage: unstage,
              creator: creator, cover: cover, signout: signout };

  D.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-pfmod]') : null;
    if (!b || !W.PATVSheet) return;
    var fn = ACT[b.getAttribute('data-pfmod')];
    if (!fn) return;
    e.preventDefault();
    var c = null, box = D.querySelector('[data-pfmod-cfg]');
    try { c = JSON.parse(box.getAttribute('data-pfmod-cfg')); } catch (err) { c = null; }
    if (!c || !c.id || !c.u) return;
    // (the ⋯ More menu closes first - it never stays open behind the sheet; focus returns to its button)
    var det = b.closest('details[open]'), anchor = b;
    if (det) { det.open = false; anchor = det.querySelector('summary') || b; }
    fn(c, anchor);
  });
  // 🔍 Abuse details is feed-safety.js's own panel (data-safety="details"): only the menu closes here, so it isn't left open behind it.
  // Review fix: in the CAPTURE phase - before feed-safety.js's handler opens its modal <dialog> - and focus moves to ⋯ More first: the
  // browser returns focus to what had it when the dialog opened, and the hidden menu item it was left it on the page body.
  D.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.pf-menu [data-safety="details"]') : null;
    var det = b && b.closest('details[open]');
    if (!det) return;
    det.open = false;
    var sum = det.querySelector('summary');
    if (sum) { try { sum.focus(); } catch (err) { /* gone */ } }
  }, true);
  W.PATVProfileMod = { _act: ACT };
})(window, document);
