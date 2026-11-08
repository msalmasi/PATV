/* ⏱ Mic timing - Pepe's mic timing pads, his speed-ups and the !mic yield list (micspeed 1.99anb; /admin/pepe/rooms#mictiming -
   mictiming.js -> website action mic.timing -> camfrog-bot pepe_micspeed.py). All global (one mic, one set of timings).
   The values shown are the ones Pepe reports (his rooms state push); a save sends only the fields you changed, as ONE change, and
   shows what Pepe stored (and clamped) when he answers. window.PatvMicTiming = the pure part (the tests run it in node). */
(function () {
  'use strict';
  var SECS = ['grabconfirm', 'leadin', 'tailout', 'websettle'], TOGGLES = ['talkplay'], MILLIS = ['confirm', 'clickretry', 'ttspoll'];
  var LISTS = ['yieldlist'], YIELD_MAX = 20, LOGIN_MAX = 40;
  // [field, label, unit, what it does]
  var ROWS = [
    ['grabconfirm', 'Grab confirm', 's', 'After a normal Talk click, how long Pepe checks nobody beat him to the mic before he plays.'],
    ['leadin', 'Lead-in', 's', 'Silence held on the mic before the clip starts. Raise it (about 0.1 s) if the first syllable gets clipped.'],
    ['tailout', 'Tail-out', 's', 'Silence held on the mic after the clip ends, before Pepe lets go - so the last word is not cut off.'],
    ['websettle', 'Web clip settle', 's', 'Push-to-talk web clips: how long a free mic must stay free before Pepe goes for it (a room with fast grab for web clips skips it).'],
    ['talkplay', 'Talk check during the clip', null, 'On: the clip starts as soon as Talk is on and Talk is read again while it plays; if it switched itself off (a muted win) the clip stops, Pepe gives the mic back, clicks once more and plays it again from the start - never charged twice. Off: Talk is read first, then the clip (0.5 s later).'],
    ['confirm', 'Fast-grab confirm window', 'ms', "After the fast grab's own grab request, how long Pepe waits for proof someone else got the mic before he clicks Talk. Shorter = sooner; a loss is then found after the click. In a contest room each shot keeps at least 350 ms (racers there come in later)."],
    ['clickretry', 'Second-click retry', 'ms', 'After a room-tab switch Camfrog often swallows the first Talk click: how long Pepe waits for it before clicking once more (clicks that land show in 60-160 ms). Only when turning Talk on - letting go always waits the full 1 s.'],
    ['ttspoll', 'TTS ready poll', 'ms', 'How often Pepe asks VoiceBox whether a spoken line is ready.'],
    ['yieldlist', 'Yield list', null, 'Camfrog logins (up to 20, comma-separated). With !mic yield on, in a room where one of them is Pepe never races them for the mic: no fast grab, contest, regrab or bump; his clips there wait for a quiet mic or are refunded ("Pepe is giving <name> the mic").']
  ];
  var FIELDS = ROWS.map(function (r) { return r[0]; });

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function isSec(f) { return SECS.indexOf(f) >= 0; }
  function isMs(f) { return MILLIS.indexOf(f) >= 0; }
  function isToggle(f) { return TOGGLES.indexOf(f) >= 0; }
  function isList(f) { return LISTS.indexOf(f) >= 0; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function copy(o) { var out = {}; for (var k in (o || {})) if (has(o, k)) out[k] = o[k]; return out; }
  /** A yield list typed in the card -> {logins, err} (the site's listClean: lower case, trimmed, deduped, 1-40 characters each). */
  function listOf(v) {
    var parts = Array.isArray(v) ? v.map(String) : String(v == null ? '' : v).split(/[\s,;]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = String(parts[i]).replace(/^\s+|\s+$/g, '').toLowerCase();
      if (!s) continue;
      if ((s === 'none' || s === '-') && parts.length === 1) return { logins: [], err: null };
      if ((Array.from ? Array.from(s).length : s.length) > LOGIN_MAX) return { logins: [], err: 'a login is at most ' + LOGIN_MAX + ' characters' };
      if (/[\u0000-\u001f\u007f-\u009f,;]/.test(s)) return { logins: [], err: 'printable logins only' };
      if (out.indexOf(s) < 0) out.push(s);
    }
    if (out.length > YIELD_MAX) return { logins: [], err: 'at most ' + YIELD_MAX + ' logins' };
    return { logins: out, err: null };
  }
  /** One number box's text -> a number (seconds: up to 2 decimals; ms: whole) or null. */
  function numOf(f, s) {
    var t = String(s == null ? '' : s).trim();
    if (isSec(f)) return /^-?\d{1,3}(\.\d{1,3})?$/.test(t) ? Math.round(parseFloat(t) * 100) / 100 : null;
    return /^-?\d{1,6}$/.test(t) ? parseInt(t, 10) : null;
  }
  function fmt(f, v) {
    if (v == null) return '–';
    if (isToggle(f)) return v ? 'on' : 'off';
    if (isList(f)) return v.length ? v.join(', ') : 'nobody';
    return String(v) + (isSec(f) ? ' s' : ' ms');
  }
  function rangeText(mt, f) {
    var r = mt && mt.ranges && mt.ranges[f], d = mt && mt.defaults && has(mt.defaults, f) ? mt.defaults[f] : null;
    var s = r ? r[0] + '-' + r[1] + (isSec(f) ? ' s' : ' ms') : (isList(f) ? 'up to ' + YIELD_MAX + ' logins' : '');
    if (d != null) s += (s ? ' · ' : '') + 'default ' + fmt(f, d);
    return s;
  }
  /** Drops (in place) the edits equal to Pepe's value now. */
  function prune(mt, edits) {
    var cur = (mt && mt.values) || {};
    Object.keys(edits).forEach(function (f) { if (same(edits[f], cur[f])) delete edits[f]; });
    return edits;
  }
  /** The change to send: {field: value} (only what changes something) or null. */
  function change(mt, edits) {
    var e = prune(mt, copy(edits)), set = {}, n = 0;
    FIELDS.forEach(function (f) { if (has(e, f)) { set[f] = e[f]; n++; } });
    return n ? set : null;
  }
  /** The yield's state in words. */
  function yieldText(y) {
    if (!y || !y.on) return 'Yield is off - turn it on with !mic yield on [minutes] in a room (default ' + ((y && y.default_min) || 60) + ' min, at most ' + Math.round(((y && y.max_min) || 720) / 60) + ' h).';
    var bits = ['🤝 Yield is ON' + (y.left_min ? ' for ' + y.left_min + ' more min' : '') + (y.by ? ' (by ' + y.by + ')' : '') + '.'];
    if (y.present && y.present.length) {
      bits.push('Holding back in ' + y.present.map(function (r) {
        return r.name + ': ' + r.who.map(function (w) { return w + (r.holding.indexOf(w) >= 0 ? ' (on the mic)' : ''); }).join(', ');
      }).join('; ') + '.');
    } else bits.push('Nobody on the list is in his rooms right now.');
    return bits.join(' ');
  }

  var api = { FIELDS: FIELDS, ROWS: ROWS, SECS: SECS, MILLIS: MILLIS, TOGGLES: TOGGLES, LISTS: LISTS, listOf: listOf, numOf: numOf,
              fmt: fmt, rangeText: rangeText, prune: prune, change: change, yieldText: yieldText };
  if (typeof window !== 'undefined') window.PatvMicTiming = api;
  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('mictiming')) return;

  // ── the card ──
  var $ = function (id) { return document.getElementById(id); };
  var V = null;
  try { V = JSON.parse(($('mtData') || {}).textContent || 'null'); } catch (e) { V = null; }
  V = V || { online: false, mt: null, actions: [] };
  var EDIT = {}, PENDING = null, SENT = null, BUSY = false, STALE = false;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function when(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
  function msg(t, cls) { var m = $('mtMsg'); if (m) { m.textContent = t; m.className = 'adm-msg' + (cls ? ' ' + cls : ''); } }
  function each(list, fn) { for (var i = 0; i < ((list && list.length) || 0); i++) fn(list[i]); }
  function cur() { return (V.mt && V.mt.values) || {}; }
  function shown(f) { return has(EDIT, f) ? EDIT[f] : cur()[f]; }
  function typing() { var a = document.activeElement, b = $('mtRows'); return !!(a && b && typeof b.contains === 'function' && b.contains(a)); }

  function control(f, label) {
    var v = shown(f), box = el('span', 'mt-ctl');
    if (isToggle(f)) {
      var s = el('select', 'ds-in'); s.setAttribute('data-mt', f); s.setAttribute('aria-label', label);
      [['on', 'on'], ['off', 'off']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; s.appendChild(op); });
      s.value = v ? 'on' : 'off';
      s.addEventListener('change', function () { EDIT[f] = s.value === 'on'; prune(V.mt, EDIT); sync(); });
      box.appendChild(s);
      return box;
    }
    if (isList(f)) {
      var t = el('input', 'ds-in'); t.type = 'text'; t.setAttribute('autocomplete', 'off'); t.setAttribute('data-mt', f);
      t.setAttribute('aria-label', label); t.setAttribute('placeholder', 'nobody');
      t.value = (v || []).join(', ');
      t.addEventListener('change', function () {
        var c = listOf(t.value);
        if (c.err) { delete EDIT[f]; msg('⚠ ' + label + ': ' + c.err + '.', 'err'); prune(V.mt, EDIT); sync(); return; }
        EDIT[f] = c.logins; prune(V.mt, EDIT); sync();
      });
      box.appendChild(t);
      return box;
    }
    var inp = el('input', 'ds-in mt-num'); inp.type = 'number'; inp.step = isSec(f) ? '0.05' : '10';
    inp.setAttribute('inputmode', isSec(f) ? 'decimal' : 'numeric'); inp.setAttribute('data-mt', f);
    inp.setAttribute('aria-label', label + (isSec(f) ? ' (seconds)' : ' (milliseconds)'));
    inp.value = v == null ? '' : String(v);
    inp.addEventListener('change', function () {
      var n = numOf(f, inp.value);
      if (n === null) { msg('⚠ ' + label + ': ' + (isSec(f) ? 'seconds, up to 2 decimals.' : 'whole milliseconds.'), 'err'); return; }
      EDIT[f] = n; prune(V.mt, EDIT); sync();
    });
    box.appendChild(inp);
    box.appendChild(el('span', 'adm-help mt-unit', isSec(f) ? ' s' : ' ms'));
    return box;
  }

  function drawRows() {
    var body = $('mtRows'); if (!body) return;
    body.textContent = '';
    STALE = false;
    var mtNow = $('mtNow'); if (mtNow) mtNow.hidden = !!V.mt;
    if (!V.mt) {
      var tr0 = el('tr'), td0 = el('td', 'adm-help', V.online ? "This Pepe doesn't report his mic timing yet - use his own panel until his update runs." : 'No report from Pepe right now (offline?).');
      td0.colSpan = 3; tr0.appendChild(td0); body.appendChild(tr0);
    } else {
      ROWS.forEach(function (row) {
        var f = row[0], tr = el('tr');
        tr.setAttribute('data-row', f);
        tr.className = has(EDIT, f) ? 'mt-edited' : '';
        var name = el('td'); name.appendChild(el('b', null, row[1])); name.appendChild(el('div', 'adm-help', row[3])); tr.appendChild(name);
        var c = el('td'); c.appendChild(control(f, row[1])); tr.appendChild(c);
        tr.appendChild(el('td', 'adm-help', rangeText(V.mt, f)));
        body.appendChild(tr);
      });
    }
    info();
    saveState();
  }
  /** After an edit or a poll: the marks and the boxes in place (never under the box the admin is in). */
  function sync() {
    var body = $('mtRows'), a = document.activeElement;
    if (body && V.mt && body.querySelectorAll) {
      each(body.querySelectorAll('tr'), function (tr) { var f = tr.getAttribute('data-row'); if (f) tr.className = has(EDIT, f) ? 'mt-edited' : ''; });
      each(body.querySelectorAll('select'), function (s) { var f = s.getAttribute('data-mt'); if (f && s !== a) s.value = shown(f) ? 'on' : 'off'; });
      each(body.querySelectorAll('input'), function (n) {
        var f = n.getAttribute('data-mt'); if (!f || n === a) return;
        if (isList(f)) { if (has(EDIT, f) || !listOf(n.value).err) n.value = (shown(f) || []).join(', '); }
        else { var v = shown(f); n.value = v == null ? '' : String(v); }
      });
    }
    info();
    saveState();
  }
  function info() {
    var y = $('mtYield'); if (y) y.textContent = yieldText(V.mt && V.mt.yield);
    var box = $('mtPending'); if (!box) return;
    var set = V.mt ? change(V.mt, EDIT) : null, n = set ? Object.keys(set).length : 0;
    box.textContent = n ? '✏️ ' + n + ' change(s) not saved yet.' : '';
  }
  function saveState() { var s = $('mtSave'); if (s) s.disabled = !V.mt || !V.online || BUSY; }

  function drawStatus() {
    var on = $('mtOnline');
    if (on) on.textContent = V.online ? (V.mt ? 'live' : 'live (older Pepe)') : 'offline' + (V.at ? ' (last seen ' + when(V.at) + ')' : '');
    var log = $('mtLog');
    if (log) {
      log.textContent = '';
      (V.actions || []).forEach(function (x) {
        var mark = x.status === 'done' ? '✅ ' : x.status === 'failed' ? '❌ ' : '⏳ ';
        log.appendChild(el('li', null, mark + when(x.created) + ' ' + (x.username || '') + ': ' + (x.label || '') + (x.message ? ' - ' + x.message : '')));
      });
    }
    if (PENDING) {
      var a = (V.actions || []).filter(function (x) { return String(x.id) === String(PENDING); })[0];
      if (a && (a.status === 'done' || a.status === 'failed')) {
        var rec = ((V.mt && V.mt.last) || []).filter(function (x) { return String(x.id) === String(PENDING); })[0];
        var cl = rec && rec.clamped ? Object.keys(rec.clamped).map(function (f) {
          return f + ' ' + fmt(f, rec.clamped[f].asked) + ' → ' + fmt(f, rec.clamped[f].stored);
        }) : [];
        msg((a.status === 'done' ? '✅ ' : '❌ ') + (a.message || (a.status === 'done' ? 'Saved.' : 'Pepe refused it.'))
            + (cl.length ? ' Clamped: ' + cl.join(', ') + '.' : ''), a.status === 'done' ? 'ok' : 'err');
        if (a.status === 'done' && SENT) Object.keys(SENT).forEach(function (f) { if (has(EDIT, f) && same(EDIT[f], SENT[f])) delete EDIT[f]; });
        PENDING = null; SENT = null;
        prune(V.mt, EDIT);
        if (typing()) { STALE = true; sync(); } else drawRows();
      }
    }
  }

  function load() {
    return fetch('/api/admin/pepe/mictiming', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        var before = JSON.stringify([V.mt, V.online]);
        V = d;
        var changed = JSON.stringify([V.mt, V.online]) !== before;
        if ((changed && !V.mt) || (STALE && !typing()) || (changed && !Object.keys(EDIT).length && !typing())) drawRows();
        else { prune(V.mt, EDIT); sync(); }
        drawStatus();
      }).catch(function () {});
  }

  function save() {
    prune(V.mt, EDIT);
    var set = change(V.mt, EDIT);
    if (!set) { msg('Nothing changed.'); sync(); return; }
    var reason = ($('mtReason') || {}).value || '';
    BUSY = true; msg('…'); saveState();
    return fetch('/api/admin/pepe/mictiming', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ set: set, reason: reason.trim() || undefined }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        BUSY = false;
        if (d && d.ok) { PENDING = d.id; SENT = copy(set); msg('Sent to Pepe - his answer (what he stored) shows here in a few seconds.'); }
        else msg('❌ ' + ((d && d.error) || 'failed'), 'err');
        sync();
        return load();
      })
      .catch(function () { BUSY = false; msg('❌ The site did not answer.', 'err'); sync(); });
  }

  var sb = $('mtSave'); if (sb) sb.addEventListener('click', save);
  var ub = $('mtUndo'); if (ub) ub.addEventListener('click', function () { EDIT = {}; msg(''); drawRows(); });
  drawRows(); drawStatus();
  api._card = { save: save, load: load, state: function () { return { V: V, EDIT: EDIT, PENDING: PENDING, SENT: SENT }; } };
  setInterval(function () { if (!document.hidden) load(); }, 4000);
})();
