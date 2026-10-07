// room-mod.js — the pad page's "Manage" panel (1.99co, padmod.js): Camfrog room moderation from the web.
//
//   PATVRoom.mod(host, slug, opts) -> { update(d), active(), key(), open(user) }
//
// Shown only when the live view carries `mod` (Pepe says this viewer's linked Camfrog login has mod
// powers in this room); it lists only the actions in mod.actions. Every click is a STRUCTURED request
// {action, target, args} to /api/rooms/<slug>/mod - the site builds the command line, Pepe runs it as the
// viewer's Camfrog name (same permissions, PAT prices, automod, mod log) and his answer shows here.
// Destructive actions get a confirm step with a reason (Pepe's mod log; !fine also says it in the room).
// Everything user-visible goes in via textContent.
(function () {
  'use strict';
  var P = window.PATVRoom = window.PATVRoom || {};

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, onclick) { var b = el('button', 'pm-btn' + (cls ? ' ' + cls : ''), text); b.type = 'button'; if (onclick) b.addEventListener('click', onclick); return b; }
  function pat(n) { return Number(n).toLocaleString('en-US') + ' PAT'; }
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }

  // action -> how it looks. `confirm`: destructive (a confirm step + reason); `arg`: an extra input.
  var A = {
    kick:          { label: 'Kick', icon: '👢', cmd: '!kick', confirm: 'Kick {u} out of the room?', group: 'room' },
    ban:           { label: 'Ban', icon: '🔨', cmd: '!ban', confirm: 'Ban {u} from the room? (Camfrog bans don\'t take a length - unban to lift it.)', group: 'room' },
    unban:         { label: 'Unban', icon: '🔓', cmd: '!unban', group: 'room' },
    punish:        { label: 'Punish', icon: '🤐', cmd: '!punish', confirm: 'Punish (mute) {u}? Camfrog sets how long.', group: 'voice' },
    unpunish:      { label: 'Unpunish', icon: '🗣️', cmd: '!unpunish', group: 'voice' },
    blockmic:      { label: 'Block mic', icon: '🎤🚫', cmd: '!blockmic', confirm: 'Block {u}\'s mic?', group: 'voice' },
    unblockmic:    { label: 'Unblock mic', icon: '🎤', cmd: '!unblockmic', group: 'voice' },
    timeout:       { label: 'Time out', icon: '⏳', cmd: '!timeout', confirm: 'Time {u} out? Pepe pulls their red list and mutes them.', arg: 'hours', group: 'voice' },
    fine:          { label: 'Fine', icon: '⚖️', cmd: '!fine', confirm: 'Fine {u}? The PAT goes to the Federal Reserve.', arg: 'amount', group: 'pat' },
    casinoban:     { label: 'Casino ban', icon: '🎰🚫', cmd: '!casinoban', confirm: 'Ban {u} from the casino (web, chat and Discord)?', group: 'pat' },
    casinounban:   { label: 'Casino unban', icon: '🎰', cmd: '!casinounban', group: 'pat' },
    djban:         { label: 'DJ ban', icon: '🎧🚫', cmd: '!djban', confirm: 'Suspend {u}\'s music commands in this room?', group: 'pat' },
    djunban:       { label: 'DJ unban', icon: '🎧', cmd: '!djunban', group: 'pat' },
    strike:        { label: 'Strikes', icon: '📋', cmd: '!strike', group: 'strikes' },
    strike_appeal: { label: 'Appeal last strike', icon: '⚖️', cmd: '!strike appeal', confirm: 'Take {u}\'s last strike off and lift any time-out / red-list cooldown?', group: 'strikes' },
  };
  var GROUPS = [['room', 'Room'], ['voice', 'Voice & mic'], ['pat', 'PAT & games'], ['strikes', 'Automod strikes']];
  var HOURS = [[1, '1 hour'], [6, '6 hours'], [12, '12 hours'], [24, '24 hours'], [72, '3 days'], [168, '1 week'], [720, '30 days']];
  var FINES = [1000, 10000, 25000, 100000];
  var ROLE_TXT = { owner: 'Pepe owner', admin: 'Pepe admin', staff: 'Pepe staff', trusted: 'trusted', redlist: 'red list', everyone: 'regular' };
  var UN = { banned: ['unban', 'Unban'], punished: ['unpunish', 'Unpunish'], 'mic-blocked': ['unblockmic', 'Unblock mic'] };
  var TOPIC_MAX = 200, REASON_MAX = 120;

  function preview(action, login, args) {
    var a = A[action]; if (!a) return '';
    if (action === 'topic') return '!topic ' + (args.text || '');
    var s = a.cmd + ' ' + login;
    if (action === 'timeout') s += ' ' + (args.hours || 24);
    if (action === 'fine') s += ' ' + (args.amount || '?') + (args.reason ? ' ' + args.reason : '');
    return s;
  }

  function mod(host, slug, opts) {
    opts = opts || {};
    var base = '/api/rooms/' + encodeURIComponent(slug) + '/mod';
    var caps = null, room = null, lastKey = '';
    var results = [];                    // [{line, st, ok, replies}]

    // ── the panel ──
    host.textContent = '';
    host.classList.add('pm');
    var h = el('h2', null, 'Manage room'); h.id = 'pmH' + slug; host.setAttribute('aria-labelledby', h.id);
    var badges = el('small', 'pm-badges'); h.appendChild(badges);
    var off = el('p', 'pm-note warn hide', '🛑 Web moderation is off in this room — an admin turns it on in Camfrog with !bridge cmds on.');
    var blocked = el('p', 'pm-note warn hide');
    var body = el('div', 'pm-body');
    host.appendChild(h); host.appendChild(off); host.appendChild(blocked); host.appendChild(body);

    // topic
    var tWrap = el('div', 'pm-sec pm-topic');
    tWrap.appendChild(el('div', 'pm-k', 'Room topic'));
    var tCur = el('div', 'pm-topic-cur');
    var tEdit = btn('', '✏️ Edit topic');
    var tForm = el('form', 'pm-topic-form hide'); tForm.setAttribute('autocomplete', 'off');
    var tLab = el('label', 'pm-sr', 'New room topic'); tLab.htmlFor = 'pmTopic' + slug;
    var tIn = el('textarea'); tIn.id = 'pmTopic' + slug; tIn.maxLength = TOPIC_MAX; tIn.rows = 2; tIn.placeholder = 'What\'s the room about right now?';
    var tCount = el('div', 'pm-count');
    var tPrev = el('div', 'pm-preview'); tPrev.setAttribute('aria-live', 'polite');
    var tRow = el('div', 'pm-row');
    var tGo = el('button', 'pm-btn go'); tGo.type = 'submit';
    var tCancel = btn('', 'Cancel', function () { tForm.classList.add('hide'); tEdit.classList.remove('hide'); });
    tRow.appendChild(tGo); tRow.appendChild(tCancel);
    tForm.appendChild(tLab); tForm.appendChild(tIn); tForm.appendChild(tCount); tForm.appendChild(tPrev); tForm.appendChild(tRow);
    tWrap.appendChild(tCur); tWrap.appendChild(tEdit); tWrap.appendChild(tForm);
    function cleanTopic(v) { return String(v || '').replace(/\s+/g, ' ').replace(/^[\s/!]+/, '').trim().slice(0, TOPIC_MAX); }
    function paintTopic() {
      var v = cleanTopic(tIn.value);
      tCount.textContent = tIn.value.length + ' / ' + TOPIC_MAX;
      tPrev.textContent = '';
      if (v) { tPrev.appendChild(el('span', 'pm-k', 'Preview')); tPrev.appendChild(el('div', 'pm-topic-line', '📌 topic: ' + v)); }
      tGo.disabled = !v;
    }
    tIn.addEventListener('input', paintTopic);
    tEdit.addEventListener('click', function () {
      tIn.value = room && room.topic ? room.topic : ''; paintTopic();
      tForm.classList.remove('hide'); tEdit.classList.add('hide'); tIn.focus();
    });
    tForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = cleanTopic(tIn.value); if (!v) return;
      run('topic', '', { text: v }, function (ok) { if (ok) { tForm.classList.add('hide'); tEdit.classList.remove('hide'); } }, tGo);
    });
    body.appendChild(tWrap);

    // people not in the room + the banned list
    var fWrap = el('div', 'pm-sec');
    fWrap.appendChild(el('div', 'pm-k', 'Someone who isn\'t here'));
    var fForm = el('form', 'pm-find'); fForm.setAttribute('autocomplete', 'off');
    var fLab = el('label', 'pm-sr', 'Camfrog name'); fLab.htmlFor = 'pmFind' + slug;
    var fIn = el('input'); fIn.id = 'pmFind' + slug; fIn.type = 'text'; fIn.maxLength = 40; fIn.placeholder = 'Camfrog name'; fIn.spellcheck = false;
    fIn.autocapitalize = 'off';
    var fGo = el('button', 'pm-btn'); fGo.type = 'submit'; fGo.textContent = 'Manage';
    fForm.appendChild(fLab); fForm.appendChild(fIn); fForm.appendChild(fGo);
    fForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = fIn.value.trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9_.][\w.\-]{0,39}$/.test(v)) { fIn.setCustomValidity('A Camfrog name: letters, numbers, _ . -'); fIn.reportValidity(); return; }
      fIn.setCustomValidity('');
      open({ login: v, display: v });
    });
    fIn.addEventListener('input', function () { fIn.setCustomValidity(''); });
    var bList = btn('keep', '🚫 Banned & punished', function () { openBanned(); });   // read-only: works with web moderation off too
    fWrap.appendChild(fForm); fWrap.appendChild(bList);
    body.appendChild(fWrap);

    // room settings (Pepe admins, password every time)
    var sWrap = el('div', 'pm-sec pm-settings hide');
    sWrap.appendChild(el('div', 'pm-k', 'Pepe in this room (admins)'));
    var sGrid = el('div', 'pm-set-grid');
    sWrap.appendChild(sGrid);
    sWrap.appendChild(el('p', 'pm-hint', 'Each change asks for your PATV password and is logged.'));
    body.appendChild(sWrap);

    var hint = el('p', 'pm-hint', 'Tip: click someone in the room list to manage them. Actions run as your Camfrog name — the room sees "🌐 you (web): !kick …".');
    body.appendChild(hint);
    var res = el('ul', 'pm-results'); res.setAttribute('aria-live', 'polite'); res.setAttribute('aria-label', 'Your moderation results');
    body.appendChild(res);

    function paintResults() {
      res.textContent = '';
      results.slice(-4).reverse().forEach(function (r) {
        var li = el('li', 'pm-res' + (r.ok === false ? ' bad' : r.ok ? ' ok' : ''));
        var hd = el('div', 'pm-res-h');
        hd.appendChild(el('span', 'pm-res-t', '› ' + r.line));
        hd.appendChild(el('span', 'pm-res-s', r.st));
        li.appendChild(hd);
        (r.replies || []).slice(0, 3).forEach(function (t) { li.appendChild(el('div', 'pm-res-r', 'Pepe: ' + t)); });
        res.appendChild(li);
      });
    }

    // run one action; cb(ok) when Pepe has answered (or it was refused)
    function run(action, login, args, cb, button) {
      var r = { line: preview(action, login, args), st: 'sending…', ok: null, replies: [] };
      results.push(r); results = results.slice(-8); paintResults();
      if (button) button.disabled = true;
      return api(base, { action: action, target: login, args: args }).then(function (d) {
        if (!d.ok) { r.st = 'not sent — ' + (d.error || 'refused'); r.ok = false; paintResults(); if (cb) cb(false, r); return; }
        r.line = d.line || r.line; r.st = 'waiting for Pepe…'; paintResults();
        return watch(d.id, r, cb);
      }).catch(function () { r.st = 'couldn\'t reach the site'; r.ok = false; paintResults(); if (cb) cb(false, r); })
        .then(function () { if (button) setTimeout(function () { button.disabled = false; }, 1200); });
    }
    function watch(id, r, cb, n) {
      n = n || 0;
      return new Promise(function (resolve) {
        setTimeout(function () {
          api(base + '/job/' + encodeURIComponent(id)).then(function (j) {
            if (!j.ok) { r.st = j.error || 'expired'; r.ok = false; paintResults(); if (cb) cb(false, r); return resolve(); }
            if (j.done) {
              r.ok = !!j.success; r.replies = j.replies || []; r.info = j.info || null;
              r.st = j.success ? (r.replies.length ? '✓' : '✓ ' + (j.msg || 'done')) : '✗ ' + (j.msg || 'refused');
              paintResults(); if (cb) cb(r.ok, r); return resolve();
            }
            if (n > 45) { r.st = 'Pepe hasn\'t answered yet — check the room chat'; paintResults(); if (cb) cb(null, r); return resolve(); }
            r.st = j.state === 'running' ? 'Pepe is on it…' : 'waiting for Pepe…'; paintResults();
            watch(id, r, cb, n + 1).then(resolve);
          }).catch(function () { r.st = 'couldn\'t reach the site'; paintResults(); resolve(); });
        }, n ? 1200 : 700);
      });
    }
    function info(target) {
      return api(base + '/info', { target: target || '' }).then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Not right now.');
        return new Promise(function (resolve, reject) {
          var n = 0;
          (function poll() {
            api(base + '/job/' + encodeURIComponent(d.id)).then(function (j) {
              if (!j.ok) return reject(new Error(j.error || 'expired'));
              if (j.done) return j.success ? resolve(j.info || {}) : reject(new Error(j.msg || 'Pepe said no.'));
              if (++n > 30) return reject(new Error('Pepe hasn\'t answered yet - try again in a bit.'));
              setTimeout(poll, 900);
            }).catch(function () { reject(new Error('Couldn\'t reach the site.')); });
          })();
        });
      });
    }

    // ── dialogs ──
    var dlg = null;
    function closeDlg() { if (dlg) { var d = dlg; dlg = null; if (d.open && d.close) d.close(); d.remove(); } }
    function dialog(title, label) {
      closeDlg();
      var d = el('dialog', 'pm-dlg'); d.setAttribute('aria-label', label || title);
      var inner = el('div', 'pm-dlg-in');
      var top = el('div', 'pm-dlg-h');
      var t = el('h3', null, title);
      top.appendChild(t); top.appendChild(btn('pm-x', '×', closeDlg));
      top.lastChild.setAttribute('aria-label', 'Close');
      var b = el('div', 'pm-dlg-b');
      inner.appendChild(top); inner.appendChild(b); d.appendChild(inner);
      d.addEventListener('click', function (e) { if (e.target === d) closeDlg(); });
      d.addEventListener('cancel', function (e) { e.preventDefault(); closeDlg(); });
      document.body.appendChild(d);
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
      dlg = d;
      return { d: d, head: top, title: t, body: b };
    }
    function badge(text, cls) { return el('span', 'pm-badge' + (cls ? ' ' + cls : ''), text); }

    // the user menu
    function open(u) {
      if (!caps || !u || !u.login) return;
      var who = u.display || u.login;
      var D = dialog(who, 'Manage ' + who);
      var sub = el('div', 'pm-who');
      sub.appendChild(el('span', 'pm-login', u.login));
      var bWrap = el('span', 'pm-badges'); sub.appendChild(bWrap);
      D.head.insertBefore(sub, D.head.lastChild);
      var main = el('div', 'pm-menu'); D.body.appendChild(main);
      var conf = el('div', 'pm-confirm hide'); D.body.appendChild(conf);
      var out = el('div', 'pm-out'); out.setAttribute('aria-live', 'polite'); D.body.appendChild(out);
      if (!caps.on) main.appendChild(el('p', 'pm-note warn', '🛑 Web moderation is off in this room.'));
      if (caps.blocked) main.appendChild(el('p', 'pm-note warn', '⚠️ Pepe won\'t take commands from you right now: ' + caps.blocked));
      GROUPS.forEach(function (g) {
        var acts = caps.actions.filter(function (a) { return A[a] && A[a].group === g[0]; });
        if (!acts.length) return;
        var sec = el('div', 'pm-grp');
        sec.appendChild(el('div', 'pm-k', g[1]));
        var row = el('div', 'pm-acts');
        acts.forEach(function (a) {
          var b = btn(A[a].confirm ? 'danger' : '', A[a].icon + ' ' + A[a].label, function () { act(a); });
          b.disabled = !caps.on;
          row.appendChild(b);
        });
        sec.appendChild(row); main.appendChild(sec);
      });
      // links
      var links = el('div', 'pm-grp');
      links.appendChild(el('div', 'pm-k', 'Profile'));
      var lrow = el('div', 'pm-acts');
      if (u.patv && u.patv.username) {
        var pa = el('a', 'pm-btn', '👤 View profile'); pa.href = '/u/' + encodeURIComponent(u.patv.username); lrow.appendChild(pa);
        if (opts.dms) { var ma = el('a', 'pm-btn', '✉️ Message'); ma.href = '/messages?to=' + encodeURIComponent(u.patv.username); lrow.appendChild(ma); }
        if (window.patvSafety && window.patvSafety.report) lrow.appendChild(btn('', '🚩 Report', function () { closeDlg(); window.patvSafety.report({ user: u.patv.username }); }));
      } else {
        lrow.appendChild(el('span', 'pm-hint', 'No PATV account linked to this Camfrog name.'));
      }
      links.appendChild(lrow); main.appendChild(links);
      // roles + recent history (mods only - Pepe checks)
      var hist = el('div', 'pm-grp pm-hist');
      hist.appendChild(el('div', 'pm-k', 'Recent moderation here'));
      var hl = el('div', 'pm-hint', 'Loading from Pepe\'s mod log…'); hist.appendChild(hl);
      main.appendChild(hist);
      info(u.login).then(function (i) {
        if (!dlg || dlg !== D.d) return;
        bWrap.textContent = '';
        bWrap.appendChild(badge(ROLE_TXT[i.role] || i.role || 'regular', i.role && i.role !== 'everyone' ? 'role' : ''));
        if (i.redlist) bWrap.appendChild(badge('red list', 'red'));
        if (i.owner) bWrap.appendChild(badge('pad owner', 'own'));
        if (i.strikes) bWrap.appendChild(badge(i.strikes + ' strike' + (i.strikes === 1 ? '' : 's'), 'warn'));
        if (i.timeout) bWrap.appendChild(badge('timed out', 'warn'));
        if (i.mutedUntil) bWrap.appendChild(badge('muted until ' + i.mutedUntil.replace('T', ' '), 'warn'));
        if (i.djbanned) bWrap.appendChild(badge('DJ-banned', 'warn'));
        hist.removeChild(hl);
        var hs = i.history || [];
        if (!hs.length) { hist.appendChild(el('div', 'pm-hint', 'Nothing in the last ' + (i.days || 30) + ' days.')); return; }
        var ul = el('ul', 'pm-hlist');
        hs.forEach(function (x) {
          var li = el('li');
          li.appendChild(el('time', null, (x.ts || '').replace('T', ' ').slice(0, 16)));
          li.appendChild(el('b', null, x.type.replace(/^pepe_/, '').replace(/_/g, ' ')));
          li.appendChild(el('span', null, (x.actor ? 'by ' + x.actor : '') + (x.details ? ' — ' + x.details : '')));
          ul.appendChild(li);
        });
        hist.appendChild(ul);
      }).catch(function (e) { if (hl.isConnected) hl.textContent = e.message; });

      function say(text, cls) { out.textContent = ''; if (text) out.appendChild(el('p', 'pm-note' + (cls ? ' ' + cls : ''), text)); }
      function act(a) {
        var def = A[a];
        if (!def.confirm) {
          say('Sending ' + preview(a, u.login, {}) + '…');
          run(a, u.login, {}, function (ok, r) { say(r.st + (r.replies && r.replies.length ? ' ' + r.replies[0] : ''), ok ? 'ok' : ok === false ? 'bad' : ''); });
          return;
        }
        // confirm step: what will happen, the extra input, a reason, the exact command Pepe runs
        main.classList.add('hide'); conf.classList.remove('hide'); conf.textContent = ''; say('');
        var form = el('form', 'pm-cform'); form.setAttribute('autocomplete', 'off');
        form.appendChild(el('p', 'pm-q', def.confirm.replace('{u}', who)));
        var args = {};
        var hoursSel = null, amtIn = null;
        if (def.arg === 'hours') {
          var lh = el('label', 'pm-lab', 'How long'); lh.htmlFor = 'pmHours';
          hoursSel = el('select'); hoursSel.id = 'pmHours';
          HOURS.forEach(function (x) { var o = el('option', null, x[1]); o.value = String(x[0]); if (x[0] === 24) o.selected = true; hoursSel.appendChild(o); });
          form.appendChild(lh); form.appendChild(hoursSel);
        }
        if (def.arg === 'amount') {
          var la = el('label', 'pm-lab', 'Amount (PAT)'); la.htmlFor = 'pmAmt';
          amtIn = el('input'); amtIn.id = 'pmAmt'; amtIn.type = 'number'; amtIn.min = '1'; amtIn.step = '1'; amtIn.value = '25000'; amtIn.inputMode = 'numeric'; amtIn.required = true;
          var chips = el('div', 'pm-chips');
          FINES.forEach(function (f) { chips.appendChild(btn('chip', f >= 1000 ? f / 1000 + 'k' : String(f), function () { amtIn.value = String(f); paint(); })); });
          form.appendChild(la); form.appendChild(amtIn); form.appendChild(chips);
        }
        var lr = el('label', 'pm-lab', a === 'fine' ? 'Reason (Pepe says it in the room with the fine)' : 'Reason (optional — goes in Pepe\'s mod log)');
        lr.htmlFor = 'pmReason';
        var rIn = el('input'); rIn.id = 'pmReason'; rIn.type = 'text'; rIn.maxLength = REASON_MAX; rIn.placeholder = a === 'fine' ? 'e.g. spamming the wheel' : 'e.g. slurs in chat';
        form.appendChild(lr); form.appendChild(rIn);
        var pv = el('div', 'pm-cmd');
        form.appendChild(pv);
        var row = el('div', 'pm-row');
        var go = el('button', 'pm-btn danger go'); go.type = 'submit'; go.textContent = def.icon + ' ' + def.label + ' ' + who;
        var back = btn('', 'Cancel', function () { conf.classList.add('hide'); main.classList.remove('hide'); say(''); });
        row.appendChild(go); row.appendChild(back); form.appendChild(row);
        function paint() {
          args = {};
          if (hoursSel) args.hours = parseInt(hoursSel.value, 10);
          if (amtIn) args.amount = parseInt(amtIn.value, 10) || 0;
          var rs = rIn.value.replace(/\s+/g, ' ').trim();
          if (rs) args.reason = rs;
          pv.textContent = '';
          pv.appendChild(el('span', 'pm-k', 'Pepe runs'));
          pv.appendChild(el('code', null, preview(a, u.login, args)));
          go.disabled = !!amtIn && !(args.amount >= 1);
        }
        [hoursSel, amtIn, rIn].forEach(function (x) { if (x) { x.addEventListener('input', paint); x.addEventListener('change', paint); } });
        paint();
        form.addEventListener('submit', function (e) {
          e.preventDefault(); paint();
          go.disabled = true; say('Sending to Pepe…');
          run(a, u.login, args, function (ok, r) {
            say(r.st + (r.replies && r.replies.length ? ' ' + r.replies[0] : ''), ok ? 'ok' : ok === false ? 'bad' : '');
            if (ok !== false) { conf.classList.add('hide'); main.classList.remove('hide'); } else go.disabled = false;
          });
        });
        conf.appendChild(form);
        (hoursSel || amtIn || rIn).focus();
      }
    }

    // the banned / punished list
    function openBanned() {
      var D = dialog('Banned & punished', 'Banned and punished users');
      var note = el('p', 'pm-hint', 'Loading from Pepe\'s mod log…'); D.body.appendChild(note);
      var out = el('div', 'pm-out'); out.setAttribute('aria-live', 'polite');
      info('').then(function (i) {
        note.textContent = 'Last state Pepe saw in this room over the past ' + (i.days || 30) + ' days (bans made while Pepe was away won\'t show).';
        var rows = i.list || [];
        if (!rows.length) { D.body.appendChild(el('p', 'pm-note', 'Nobody is banned, punished or mic-blocked here as far as Pepe knows.')); D.body.appendChild(out); return; }
        var ul = el('ul', 'pm-blist');
        rows.forEach(function (r) {
          var li = el('li');
          var w = el('div', 'pm-bwho');
          w.appendChild(el('b', null, r.login));
          w.appendChild(badge(r.state, 'warn'));
          w.appendChild(el('small', null, (r.ts || '').replace('T', ' ').slice(0, 16) + (r.by ? ' · by ' + r.by : '')));
          li.appendChild(w);
          var un = UN[r.state];
          if (un && caps && caps.actions.indexOf(un[0]) >= 0) {
            var b = btn('', un[1]);
            b.disabled = !caps.on;
            b.addEventListener('click', function () {
              b.disabled = true;
              run(un[0], r.login, {}, function (ok, res) {
                out.textContent = ''; out.appendChild(el('p', 'pm-note ' + (ok ? 'ok' : 'bad'), res.line + ': ' + res.st + (res.replies && res.replies.length ? ' ' + res.replies[0] : '')));
                if (ok) { li.classList.add('done'); b.textContent = '✓ ' + un[1]; } else b.disabled = false;
              });
            });
            li.appendChild(b);
          }
          ul.appendChild(li);
        });
        D.body.appendChild(ul); D.body.appendChild(out);
      }).catch(function (e) { note.textContent = e.message; });
    }

    // room settings: a change asks for the password (step-up) every time
    function settingRow(key, label, choices, cur) {
      var row = el('div', 'pm-set');
      var id = 'pmSet' + key + slug;
      var lab = el('label', null, label); lab.htmlFor = id;
      var sel = el('select'); sel.id = id;
      choices.forEach(function (c) { var o = el('option', null, c[1]); o.value = c[0]; if (c[0] === cur) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () {
        var v = sel.value;
        sel.value = cur;                         // only changes once Pepe has done it
        stepUp(key, v, label + ': ' + (choices.filter(function (c) { return c[0] === v; })[0] || [0, v])[1]);
      });
      row.appendChild(lab); row.appendChild(sel);
      return row;
    }
    function stepUp(key, value, what) {
      var D = dialog('Confirm with your password', 'Confirm a room setting');
      var form = el('form', 'pm-cform'); form.setAttribute('autocomplete', 'off');
      form.appendChild(el('p', 'pm-q', 'Change "' + what + '" for this room? Pepe admins only; logged with your name.'));
      var lp = el('label', 'pm-lab', 'Your PATV password'); lp.htmlFor = 'pmPw';
      var pw = el('input'); pw.id = 'pmPw'; pw.type = 'password'; pw.autocomplete = 'current-password'; pw.required = true; pw.maxLength = 200;
      var row = el('div', 'pm-row');
      var go = el('button', 'pm-btn go'); go.type = 'submit'; go.textContent = 'Confirm';
      row.appendChild(go); row.appendChild(btn('', 'Cancel', closeDlg));
      var out = el('div', 'pm-out'); out.setAttribute('aria-live', 'polite');
      form.appendChild(lp); form.appendChild(pw); form.appendChild(row); form.appendChild(out);
      D.body.appendChild(form);
      pw.focus();
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        go.disabled = true; out.textContent = '';
        var r = { line: what, st: 'sending…', ok: null, replies: [] };
        api(base + '/setting', { key: key, value: value, password: pw.value }).then(function (d) {
          pw.value = '';
          if (!d.ok) { go.disabled = false; out.appendChild(el('p', 'pm-note bad', d.error || 'Not changed.')); return; }
          r.line = d.line; results.push(r); paintResults(); closeDlg();
          watch(d.id, r);
        }).catch(function () { go.disabled = false; out.appendChild(el('p', 'pm-note bad', 'Couldn\'t reach the site.')); });
      });
    }
    function paintSettings() {
      var s = caps && caps.admin ? caps.settings || {} : null;
      sWrap.classList.toggle('hide', !s);
      if (!s) return;
      var k = JSON.stringify(s) + (caps.on ? 1 : 0);
      if (sWrap.dataset.k === k) return;
      sWrap.dataset.k = k;
      sGrid.textContent = '';
      if (typeof s.chatty === 'boolean') sGrid.appendChild(settingRow('chatty', 'Chatty mode', [['on', 'On'], ['off', 'Off']], s.chatty ? 'on' : 'off'));
      if (s.chattydepth) sGrid.appendChild(settingRow('chattydepth', 'Chatty depth', [['off', 'Off'], ['short', 'Short'], ['normal', 'Normal'], ['long', 'Long']], s.chattydepth));
      if (typeof s.greeter === 'boolean') sGrid.appendChild(settingRow('greeter', 'Greeter', [['on', 'On'], ['off', 'Off']], s.greeter ? 'on' : 'off'));
      Array.prototype.forEach.call(sGrid.querySelectorAll('select'), function (x) { x.disabled = !caps.on; });
    }

    function update(d) {
      caps = d && d.mod ? d.mod : null;
      room = d && d.room ? d.room : null;
      host.hidden = !caps;
      if (!caps) { closeDlg(); lastKey = ''; return; }
      var k = JSON.stringify(caps);
      if (k !== lastKey) {
        lastKey = k;
        badges.textContent = '';
        (caps.roles || []).forEach(function (r) { badges.appendChild(badge(ROLE_TXT[r] || r, r === 'redlist' ? 'red' : 'role')); });
      }
      off.classList.toggle('hide', !!caps.on);
      blocked.classList.toggle('hide', !caps.blocked);
      blocked.textContent = caps.blocked ? '⚠️ Pepe won\'t take commands from you right now: ' + caps.blocked : '';
      body.classList.toggle('pm-off', !caps.on);
      var hasTopic = caps.topicPrice != null;
      tWrap.classList.toggle('hide', !hasTopic);
      tCur.textContent = room && room.topic ? room.topic : '(no topic)';
      tGo.textContent = 'Set topic' + (caps.topicPrice ? ' · ' + pat(caps.topicPrice) : ' (free for you)');
      tEdit.disabled = !caps.on;
      bList.disabled = false;
      fGo.disabled = !caps.on;
      paintSettings();
    }

    return {
      update: update,
      active: function () { return !!caps; },
      key: function () { return caps ? (caps.on ? 'm1' : 'm0') : ''; },
      open: open,
    };
  }

  P.mod = mod;
  P._modPreview = preview;
})();
