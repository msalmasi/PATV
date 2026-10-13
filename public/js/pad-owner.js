// pad-owner.js — the room owner's Pepe control panel (1.99qr, views/padOwner.ejs, padowner.js):
//   * Top up the vault: POST /api/rooms/:slug/vault/topup {amount, idem} - one idem per attempt (a double click or a retry of
//     the same attempt is one deposit); then the action's status (GET /api/rooms/action/:id) until Pepe answered, then the
//     vault's numbers (GET /api/rooms/:slug/owner/state).
//   * The owner's Pepe settings (1.99tf: every key of padowner.OWNER_SETTINGS + language / vibe / roasts / strikes / the greeting
//     note): POST /api/rooms/:slug/owner/setting {key, value}; website-bridge switches: the existing POST /api/rooms/:slug/bridge
//     {key, on}. A control keeps showing Pepe's value with "Waiting for Pepe…" until he answered AND a settings report newer
//     than his answer arrived (GET /api/rooms/:slug/owner/state, Pepe re-syncs right after a change) - then it shows what
//     that report says. The card's "Last synced" chip ticks, and the card re-reads Pepe's state every minute.
// Server / Pepe text goes in via textContent.
(function () {
  'use strict';
  var root = document.getElementById('po');
  if (!root || !root.getAttribute('data-slug')) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var slug = root.getAttribute('data-slug');
  var base = '/api/rooms/' + encodeURIComponent(slug);
  function fmt(n) { return Number(n || 0).toLocaleString(window.PATV_I18N && PATV_I18N.lang || undefined); }
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  function say(el, text, kind) { if (!el) return; el.textContent = text || ''; el.className = 'po-msg' + (kind ? ' ' + kind : ''); }
  function newKey() {
    try { if (window.crypto && crypto.randomUUID) return 'po' + crypto.randomUUID().replace(/-/g, ''); } catch (e) { /* old browser */ }
    return 'po' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  /** Poll a website action until Pepe answered -> cb(ok, message). */
  function watch(id, cb, n) {
    n = n || 0;
    api('/api/rooms/action/' + encodeURIComponent(id)).then(function (a) {
      if (a && a.ok && (a.status === 'done' || a.status === 'failed' || a.status === 'expired')) return cb(a.status === 'done', a.message || '', a.updated || null);
      if (n > 80) return cb(null, _t('js.owner.slow', 'Pepe hasn\'t answered yet - it will happen when he does.'));
      setTimeout(function () { watch(id, cb, n + 1); }, 1500);
    }).catch(function () { setTimeout(function () { watch(id, cb, n + 1); }, 3000); });
  }
  function refresh() {
    api(base + '/owner/state').then(function (d) {
      if (!d || !d.ok || !d.vault) return;
      Array.prototype.forEach.call(document.querySelectorAll('[data-po="balance"]'), function (b) { b.textContent = fmt(d.vault.balance); });
      var amt = document.getElementById('poAmt');
      if (amt) { amt.setAttribute('data-room', Math.max(0, d.vault.cap - d.vault.balance)); amt.setAttribute('data-bal', d.balance); }
    });
  }

  // ── Top up ──
  var form = document.getElementById('poTopup');
  var amt = document.getElementById('poAmt');
  if (form && amt) {
    var msg = document.getElementById('poTopMsg');
    var go = form.querySelector('button[type="submit"]');
    var key = newKey(), lastAmt = null, busy = false, armed = null, goLabel = null;
    amt.addEventListener('input', function () { if (armed !== null) { armed = null; if (goLabel) go.textContent = goLabel; say(msg, ''); } });
    Array.prototype.forEach.call(form.querySelectorAll('[data-amt]'), function (b) {
      b.addEventListener('click', function () { amt.value = b.getAttribute('data-amt'); amt.dispatchEvent(new Event('input')); amt.focus(); amt.removeAttribute('aria-invalid'); say(msg, ''); });
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var v = parseInt(String(amt.value).replace(/[,\s.]/g, ''), 10);
      var min = Number(amt.getAttribute('data-min')) || 1000, room = Number(amt.getAttribute('data-room')) || 0, bal = Number(amt.getAttribute('data-bal')) || 0;
      var err = !(v > 0) ? _t('js.owner.amt_whole', 'Type a whole number of PAT.')
        : v < min ? _t('js.owner.amt_min', 'Top up at least {n} PAT.', { n: fmt(min) })
        : v > room ? _t('js.owner.amt_room', 'The vault can take {n} PAT more.', { n: fmt(room) })
        : v > bal ? _t('js.owner.amt_bal', 'You have {n} PAT.', { n: fmt(bal) }) : '';
      if (err) { amt.setAttribute('aria-invalid', 'true'); say(msg, err, 'bad'); amt.focus(); return; }
      amt.removeAttribute('aria-invalid');
      // the confirm step, in place: the first press asks, the second (same amount) sends
      if (armed !== v) {
        armed = v;
        goLabel = goLabel || go.textContent;
        go.textContent = _t('js.owner.topup_yes', 'Yes, deposit {n} PAT', { n: fmt(v) });
        say(msg, _t('js.owner.topup_confirm', 'Deposit {n} PAT into the pad vault? Deposits can\'t be taken back out, and they never count as the pad\'s income.', { n: fmt(v) }));
        return;
      }
      armed = null; go.textContent = goLabel;
      if (lastAmt !== null && lastAmt !== v) key = newKey();           // a new amount is a new attempt
      lastAmt = v;
      busy = true; go.disabled = true; go.setAttribute('aria-busy', 'true');
      say(msg, _t('js.owner.topup_sending', 'Sending to Pepe…'));
      api(base + '/vault/topup', { amount: v, idem: key }).then(function (d) {
        if (!d || !d.ok) { busy = false; go.disabled = false; go.removeAttribute('aria-busy'); return say(msg, (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
        say(msg, _t('js.owner.topup_waiting', 'Pepe is moving it…'));
        watch(d.id, function (ok, m) {
          busy = false; go.disabled = false; go.removeAttribute('aria-busy');
          key = newKey(); lastAmt = null;                             // done: the next one is a new deposit
          say(msg, m || (ok ? _t('js.owner.topup_done', 'Deposited.') : _t('js.owner.refused', 'Pepe refused it.')), ok ? 'ok' : ok === false ? 'bad' : '');
          if (ok) { amt.value = ''; refresh(); }
        });
      }).catch(function () { busy = false; go.disabled = false; go.removeAttribute('aria-busy'); say(msg, _t('js.owner.unreachable', 'Couldn\'t reach the site - try again (it won\'t be charged twice).'), 'bad'); });
    });
  }

  // ── 1.99tf: the 🐸 card - Pepe's REAL state, a change is "waiting for Pepe" until his own report confirms it ──
  var card = document.getElementById('pepe');
  var synced = card ? Number(card.getAttribute('data-synced')) || 0 : 0;
  var chip = document.getElementById('poSync');
  var pending = {};                                   // key -> true while a change waits for Pepe
  function q(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function ctls(key) { return key.indexOf('br:') === 0 ? q('[data-po-bridge="' + key.slice(3) + '"]') : q('[data-po-set="' + key + '"]'); }
  function valOf(c) { return c.type === 'checkbox' ? c.checked : c.value; }
  function setVal(c, v) {
    if (c.type === 'checkbox') c.checked = v === true;
    else if (v !== undefined && v !== null) c.value = String(v);
  }
  function status(key, text, kind) {
    q('[data-po-st="' + key + '"]').forEach(function (s) { s.textContent = text || ''; s.className = 'po-st' + (kind ? ' ' + kind : ''); });
    q('[data-po-row="' + key + '"]').forEach(function (r) { r.classList.toggle('pending', kind === 'wait'); });
  }
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return _t('js.owner.synced_s', 'Last synced {n} s ago', { n: s });
    if (s < 3600) return _t('js.owner.synced_m', 'Last synced {n} min ago', { n: Math.round(s / 60) });
    return _t('js.owner.synced_h', 'Last synced {n} h ago', { n: Math.round(s / 3600) });
  }
  function paintSync() {
    if (!chip || !synced) return;
    chip.textContent = ago(synced);
    var stale = Date.now() - synced > 10 * 60 * 1000;
    chip.className = 'ds-chip ' + (stale ? 'warn' : 'ok');
  }
  /** Pepe's report -> every control that isn't waiting on a change (and isn't being typed in). */
  function applyState(p) {
    if (!p) return;
    if (p.updated) synced = p.updated;
    Object.keys(p.owner || {}).forEach(function (k) {
      if (pending[k]) return;
      ctls(k).forEach(function (c) {
        if (c === document.activeElement && c.type === 'text') return;
        setVal(c, p.owner[k]);
        c.disabled = !!(p.masters_off && p.masters_off[k]);   // 1.99vc: switched off by PATV admins (value kept)
      });
    });
    Object.keys(p.bridge || {}).forEach(function (k) {
      if (pending['br:' + k]) return;
      ctls('br:' + k).forEach(function (c) { setVal(c, p.bridge[k]); c.disabled = !!(p.masters_off && p.masters_off['br:' + k]); });
    });
    paintStatus(p.status);
    paintSync();
  }
  // ── 1.99ti: Pepe in the room - status chip + join / leave / rejoin (Prime Time Plus pads) ──
  var stBox = document.getElementById('poStatus');
  var ST_TXT = {
    in: function () { return _t('js.owner.ps_in', 'Pepe is in the room'); },
    joining: function () { return _t('js.owner.ps_joining', 'Pepe is joining…'); },
    recovering: function () { return _t('js.owner.ps_recovering', 'Pepe is reconnecting (recovery mode)'); },
    out: function () { return _t('js.owner.ps_out', 'Pepe isn\'t in the room'); },
    paused: function () { return _t('js.owner.ps_paused', 'Pepe stays out (you sent him away)'); },
  };
  var ST_CHIP = { in: 'ok', joining: 'info', recovering: 'warn', out: 'mute', paused: 'mute' };
  function paintStatus(st) {
    if (!stBox || !st || !ST_TXT[st.state]) return;
    stBox.setAttribute('data-state', st.state);
    var chipEl = document.getElementById('poState');
    if (chipEl) { chipEl.textContent = ST_TXT[st.state](); chipEl.className = 'ds-chip ' + ST_CHIP[st.state]; }
    var j = document.getElementById('poJoined');
    if (j) j.textContent = st.state === 'in' && st.joined_at
      ? _t('js.owner.ps_joined', 'joined {when}', { when: new Date(st.joined_at).toLocaleString(window.PATV_I18N && PATV_I18N.lang || undefined) }) : '';
    var rm = document.getElementById('poRooms');
    if (rm) rm.textContent = _t('js.owner.ps_rooms', 'in {n} of his {max} rooms', { n: st.rooms, max: st.max });
    var home = stBox.getAttribute('data-home') === '1';
    q('[data-po-ctl]').forEach(function (b) {
      var v = b.getAttribute('data-po-ctl');
      b.hidden = v === 'join' ? st.state === 'in' : (st.state !== 'in' || home);
    });
  }
  var ctlMsg = document.getElementById('poCtlMsg');
  var ctlArmed = null, ctlLabels = {};
  q('[data-po-ctl]').forEach(function (b) {
    var verb = b.getAttribute('data-po-ctl');
    ctlLabels[verb] = b.textContent;
    b.addEventListener('click', function () {
      // the confirm step, in place: the first press asks, the second sends
      if (ctlArmed !== verb) {
        q('[data-po-ctl]').forEach(function (x) { x.textContent = ctlLabels[x.getAttribute('data-po-ctl')]; });
        ctlArmed = verb;
        b.textContent = _t('js.owner.ps_yes', 'Yes, {verb}', { verb: ctlLabels[verb].replace(/^\S+\s/, '') });
        say(ctlMsg, verb === 'leave' ? _t('js.owner.ps_q_leave', 'Ask Pepe to leave your room? He stays out until you ask him back.')
          : verb === 'rejoin' ? _t('js.owner.ps_q_rejoin', 'Ask Pepe to leave and come straight back in?')
          : _t('js.owner.ps_q_join', 'Ask Pepe to join your room?'));
        return;
      }
      ctlArmed = null; b.textContent = ctlLabels[verb];
      q('[data-po-ctl]').forEach(function (x) { x.disabled = true; });
      say(ctlMsg, _t('js.owner.pending', 'Waiting for Pepe…'), 'wait');
      api(base + '/owner/pepe-room', { verb: verb }).then(function (d) {
        if (!d || !d.ok) { q('[data-po-ctl]').forEach(function (x) { x.disabled = false; }); return say(ctlMsg, (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
        watch(d.id, function (ok, m) {
          q('[data-po-ctl]').forEach(function (x) { x.disabled = false; });
          say(ctlMsg, m || (ok ? _t('js.owner.saved', 'Done.') : _t('js.owner.refused', 'Pepe refused it.')), ok ? 'ok' : ok === false ? 'bad' : '');
          // a join / leave takes a while: re-read his status a few times
          [3000, 10000, 25000, 60000].forEach(function (ms) { setTimeout(function () { poll(applyState); }, ms); });
        });
      }).catch(function () { q('[data-po-ctl]').forEach(function (x) { x.disabled = false; }); say(ctlMsg, _t('js.owner.unreachable_set', 'Couldn\'t reach the site.'), 'bad'); });
    });
  });
  function poll(cb) { api(base + '/owner/state').then(function (d) { cb(d && d.ok ? d.pepe : null); }).catch(function () { cb(null); }); }
  /** After Pepe answered at `after` (ms): wait for a settings report newer than that, then show what it says. */
  function confirm(key, want, after, msg) {
    var n = 0;
    (function again() {
      poll(function (p) {
        var fresh = p && p.updated && (!after || p.updated >= after);
        if (!fresh && ++n < 15) return setTimeout(again, 2000);
        delete pending[key];
        ctls(key).forEach(function (c) { c.disabled = false; });
        if (!fresh) {
          ctls(key).forEach(function (c) { setVal(c, want); });
          return status(key, (msg ? msg + ' - ' : '') + _t('js.owner.applied_wait', 'Pepe did it; this panel catches up with his next report.'), 'ok');
        }
        applyState(p);
        var real = key.indexOf('br:') === 0 ? (p.bridge || {})[key.slice(3)] : (p.owner || {})[key];
        var same = real === undefined || want === 'default' || String(real) === String(want);
        status(key, same ? _t('js.owner.confirmed', 'Pepe confirmed it.') : _t('js.owner.differs', 'Pepe reports it\'s still {v} - try again, or ask a Pepe admin.', { v: String(real) }), same ? 'ok' : 'bad');
      });
    })();
  }
  /** One change: send it, keep the control showing the OLD value + "waiting for Pepe" until he confirms. */
  function change(key, want, value, old) {
    var bridge = key.indexOf('br:') === 0;
    pending[key] = true;
    ctls(key).forEach(function (c) { setVal(c, old); c.disabled = true; });
    status(key, _t('js.owner.pending', 'Waiting for Pepe…'), 'wait');
    var req = bridge ? api(base + '/bridge', { key: key.slice(3), on: want })
      : api(base + '/owner/setting', { key: key, value: value });
    req.then(function (d) {
      if (!d || !d.ok) {
        delete pending[key];
        ctls(key).forEach(function (c) { c.disabled = false; });
        return status(key, (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad');
      }
      watch(d.id, function (ok, m, upd) {
        if (ok === null) {                     // Pepe hasn't picked it up: keep waiting, but give the control back
          delete pending[key];
          ctls(key).forEach(function (c) { c.disabled = false; });
          return status(key, m, 'wait');
        }
        if (!ok) {
          delete pending[key];
          ctls(key).forEach(function (c) { c.disabled = false; setVal(c, old); });
          return status(key, m || _t('js.owner.refused', 'Pepe refused it.'), 'bad');
        }
        confirm(key, want, upd, m);
      });
    }).catch(function () {
      delete pending[key];
      ctls(key).forEach(function (c) { c.disabled = false; });
      status(key, _t('js.owner.unreachable_set', 'Couldn\'t reach the site.'), 'bad');
    });
  }
  // what each control last showed (Pepe's value), so a refused change flips back to it
  var shown = {};
  q('[data-po-set], [data-po-bridge]').forEach(function (c) {
    var key = c.hasAttribute('data-po-bridge') ? 'br:' + c.getAttribute('data-po-bridge') : c.getAttribute('data-po-set');
    shown[key] = valOf(c);
    if (c.type === 'text') return;                                // the note saves with its button
    c.addEventListener('change', function () {
      if (pending[key]) return;
      var want = valOf(c), old = shown[key];
      var value = c.type === 'checkbox' ? (want ? 'on' : 'off') : want;
      if (key.indexOf('br:') !== 0 && c.type !== 'checkbox' && /^\d+$/.test(String(want)) && key === 'strikes') want = Number(want);
      shown[key] = valOf(c);
      change(key, want, value, old);
    });
  });
  q('[data-po-note]').forEach(function (f) {
    var inp = f.querySelector('[data-po-set]');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!inp || pending.greeter_note) return;
      var want = String(inp.value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      change('greeter_note', want, want, want);
    });
  });
  // ── 1.99up: the room topic -> website action "room.topic"; "Waiting for Pepe…" until his report shows the new topic ──
  var tForm = document.getElementById('poTopic');
  if (tForm) {
    var tIn = tForm.querySelector('input[name="topic"]');
    var tBtn = tForm.querySelector('button[type="submit"]');
    var tNow = document.getElementById('poTopicNow');
    var tBusy = false;
    var showTopic = function (p) {
      if (tNow && p && p.topic && p.topic.text) tNow.textContent = _t('js.owner.topic_now', 'In the room now: {topic}', { topic: p.topic.text });
    };
    tForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (tBusy) return;
      var want = String(tIn.value || '').replace(/\s+/g, ' ').trim();
      if (want.length < 2) { status('topic', _t('js.owner.topic_short', 'Type a topic first.'), 'bad'); tIn.focus(); return; }
      tBusy = true; tBtn.disabled = true; tIn.disabled = true;
      status('topic', _t('js.owner.pending', 'Waiting for Pepe…'), 'wait');
      api(base + '/owner/topic', { text: want }).then(function (d) {
        if (!d || !d.ok) { tBusy = false; tBtn.disabled = false; tIn.disabled = false; return status('topic', (d && d.error) || _t('js.owner.not_sent', 'Not sent.'), 'bad'); }
        watch(d.id, function (ok, m) {
          tBusy = false; tBtn.disabled = false; tIn.disabled = false;
          if (!ok) return status('topic', m || _t('js.owner.refused', 'Pepe refused it.'), ok === false ? 'bad' : 'wait');
          tIn.value = '';
          // confirm from his own report: the room's topic as he saw it come back from the room
          var n = 0;
          (function again() {
            poll(function (p) {
              var seen = p && p.topic && p.topic.text && p.topic.text.indexOf(want.slice(0, 60)) !== -1;
              if (seen) { showTopic(p); applyState(p); return status('topic', _t('js.owner.confirmed', 'Pepe confirmed it.'), 'ok'); }
              if (++n < 15) return setTimeout(again, 2000);
              status('topic', (m ? m + ' - ' : '') + _t('js.owner.applied_wait', 'Pepe did it; this panel catches up with his next report.'), 'ok');
            });
          })();
        });
      }).catch(function () { tBusy = false; tBtn.disabled = false; tIn.disabled = false; status('topic', _t('js.owner.unreachable_set', 'Couldn\'t reach the site.'), 'bad'); });
    });
  }
  // the "everything else" disclosure remembers being open (per browser)
  var more = document.getElementById('poMore');
  if (more) {
    try { if (localStorage.getItem('po.more') === '1') more.open = true; } catch (e) { /* storage off */ }
    more.addEventListener('toggle', function () { try { localStorage.setItem('po.more', more.open ? '1' : '0'); } catch (e) { /* storage off */ } });
  }
  paintSync();
  if (card && synced) {
    setInterval(paintSync, 15000);
    // keep the card truthful while it's open: Pepe re-reports every 2 minutes
    setInterval(function () { if (!document.hidden) poll(applyState); }, 60000);
  }
})();
