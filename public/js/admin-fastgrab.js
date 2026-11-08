/* ⚡ Fast mic grab - Pepe's !mic fastgrab switches and caps for one room, the global default or every room
   (grabcard 1.99??; /admin/pepe/rooms#fastgrab - fastgrab.js -> website action mic.fastgrab -> camfrog-bot pepe_fastgrabweb.py).
   The values shown are the ones Pepe reports (his rooms state push); a save sends only the fields you changed, as ONE change,
   and shows what Pepe stored (and clamped) when he answers. window.PatvFastGrab = the pure part (the tests run it in node). */
(function () {
  'use strict';
  var TOGGLES = ['on', 'contest', 'fair', 'web', 'chatty'];
  var ARITY = { rate: 1, shots: 1, tries: 1, breaker: 3, pause: 4, fairwait: 2, ceiling: 1 };
  // [field, label, units (one per number), what it does]
  var ROWS = [
    ['on', 'Fast grab', null, "While a soundboard clip, a paid !say or an alert waits for a full mic, Pepe's grab goes out the instant someone drops it."],
    ['contest', 'Contest', null, 'Stay armed through every drop of a fight for the mic (one grab per drop). On = also fast grab on, fair off, claim swallow - like !mic fastgrab contest on.'],
    ['fair', 'Fairness wait', null, 'A drop after a very short hold (a double-click) waits for that person to re-grab.'],
    ['claim', 'Claim', null, "How a won grab meets Pepe's own Talk click: swallow (default), release, or plain (a staging drill)."],
    ['web', 'Push-to-talk web clips fast-grab', null, 'Web clips take the mic the instant it frees (no 2 s wait) and follow contest.'],
    ['chatty', 'Chatty mic-ups fast-grab', null, "Pepe's chatty lines fast-grab too."],
    ['rate', 'Rate', ['grabs / min'], 'Grabs a minute Pepe may send in the room while contesting.'],
    ['shots', 'Shots', ['refused tries / clip'], 'Refused tries one clip may use in contest, then the normal grab.'],
    ['tries', 'Tries', ['a clip'], 'Fast-grab tries per clip the room can see (past 2: more lost races only).'],
    ['breaker', 'Breaker', ['misses in', 'min, rest', 'min'], 'That many grabs that did not play in that many minutes rest the fast grab there (rest 0 = never).'],
    ['pause', 'Contested pause', ['lost in', 's, pause', 's, up to', 's'], "Pepe's own pause on a mic he keeps losing (count 0 or first 0 = off; doubling up to the cap)."],
    ['fairwait', 'Fairness wait times', ['ms hold, wait', 'ms'], 'With fair on: a drop after a hold under the first number waits the second.'],
    ['ceiling', 'Ceiling (every room)', ['grabs / min, all rooms'], "Pepe's fast grabs a minute across every room together - always every room's."]
  ];
  var FIELDS = ROWS.map(function (r) { return r[0]; });

  function isToggle(f) { return TOGGLES.indexOf(f) >= 0; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  /** "global" | "all" | "room:<id>" -> {scope, room} */
  function whereOf(sel, all) {
    var s = String(sel || 'global');
    if (s.indexOf('room:') === 0) return { scope: 'room', room: s.slice(5) };
    return { scope: all ? 'all' : 'global', room: '' };
  }
  function roomOf(fg, id) { return ((fg && fg.rooms) || []).filter(function (r) { return r.id === id; })[0] || null; }
  /** The values the card starts from: the room's, else the global's. */
  function current(fg, where) {
    if (!fg) return {};
    var r = where.scope === 'room' ? roomOf(fg, where.room) : null;
    var v = r ? r.values : fg.global;
    var out = {};
    for (var k in (v || {})) out[k] = v[k];
    if (fg.global && fg.global.ceiling != null) out.ceiling = fg.global.ceiling;
    return out;
  }
  /** Where a field's value comes from: 'room' (its own) | 'mixed' | 'global' | 'every room' (the ceiling). */
  function sourceOf(fg, where, f) {
    if (f === 'ceiling') return 'every room';
    if (where.scope !== 'room') return where.scope === 'all' ? 'every room' : 'global';
    var r = roomOf(fg, where.room);
    return (r && r.own && r.own[f]) || 'global';
  }
  /** contest on = fast grab on + fair off + claim swallow; off = fair on (the command's bundle, mirrored so the card shows it). */
  function bundle(edits, f, v) {
    edits[f] = v;
    if (f === 'contest' && v === true) { edits.on = true; edits.fair = false; edits.claim = 'swallow'; }
    if (f === 'contest' && v === false) edits.fair = true;
    return edits;
  }
  /** The change to send: only the fields whose edit differs from Pepe's value, + the follows (a room's own value dropped). */
  function change(cur, edits, follows) {
    var set = {}, n = 0;
    FIELDS.forEach(function (f) {
      if (follows && follows[f]) { set[f] = 'follow'; n++; return; }
      if (!edits || !Object.prototype.hasOwnProperty.call(edits, f)) return;
      if (!same(edits[f], cur[f])) { set[f] = edits[f]; n++; }
    });
    return n ? set : null;
  }
  function fmt(f, v) {
    if (v == null) return '–';
    if (isToggle(f)) return v ? 'on' : 'off';
    return Array.isArray(v) ? v.join(' / ') : String(v);
  }
  function rangeText(fg, f) {
    var r = fg && fg.ranges && fg.ranges[f], d = fg && fg.defaults && fg.defaults[f];
    var s = r ? r.map(function (p) { return p[0] + '-' + p[1]; }).join(' / ') : '';
    if (d != null) s += (s ? ' · ' : '') + 'default ' + fmt(f, d);
    return s;
  }
  /** One number input's text -> an int, or null (not a whole number). */
  function num(s) { var t = String(s == null ? '' : s).trim(); return /^-?\d{1,7}$/.test(t) ? parseInt(t, 10) : null; }

  var api = { FIELDS: FIELDS, ROWS: ROWS, ARITY: ARITY, TOGGLES: TOGGLES, whereOf: whereOf, current: current, sourceOf: sourceOf,
              bundle: bundle, change: change, fmt: fmt, rangeText: rangeText, num: num };
  if (typeof window !== 'undefined') window.PatvFastGrab = api;
  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('fastgrab')) return;

  // ── the card ──
  var $ = function (id) { return document.getElementById(id); };
  var V = null;
  try { V = JSON.parse(($('fgData') || {}).textContent || 'null'); } catch (e) { V = null; }
  V = V || { online: false, fg: null, actions: [] };
  var EDIT = {}, FOLLOW = {}, PENDING = null, BUSY = false;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function when(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
  function where() { return whereOf(($('fgWhere') || {}).value, !!($('fgAll') || {}).checked); }
  function msg(t, cls) { var m = $('fgMsg'); if (m) { m.textContent = t; m.className = 'adm-msg' + (cls ? ' ' + cls : ''); } }
  function dirty() { return Object.keys(EDIT).length + Object.keys(FOLLOW).length > 0; }

  var WHERE_KEY = null;
  function drawWhere() {
    var sel = $('fgWhere'); if (!sel) return;
    var keep = sel.value || 'global';
    // rebuilt only when Pepe's room list changed (a rebuild under an open dropdown would close it)
    var key = JSON.stringify(((V.fg && V.fg.rooms) || []).map(function (r) { return [r.id, r.name, r.joined]; }));
    var allL0 = $('fgAllL'); if (allL0) allL0.hidden = where().scope === 'room';
    if (key === WHERE_KEY) return;
    WHERE_KEY = key;
    sel.textContent = '';
    var g = el('option', null, 'Global default (every room without its own)'); g.value = 'global'; sel.appendChild(g);
    ((V.fg && V.fg.rooms) || []).forEach(function (r) {
      var o = el('option', null, r.name + (r.name !== r.id ? ' (' + r.id + ')' : '') + (r.joined ? '' : ' - Pepe is not in it now'));
      o.value = 'room:' + r.id; sel.appendChild(o);
    });
    sel.value = keep;
    if (sel.value !== keep) sel.value = 'global';
    var allL = $('fgAllL'); if (allL) allL.hidden = where().scope === 'room';
  }

  function control(f, cur, label) {
    var v = Object.prototype.hasOwnProperty.call(EDIT, f) ? EDIT[f] : cur[f];
    var box = el('span', 'fg-ctl');
    if (isToggle(f) || f === 'claim') {
      var s = el('select', 'ds-in'); s.setAttribute('data-fg', f); s.setAttribute('aria-label', label);
      var opts = isToggle(f) ? [['on', 'on'], ['off', 'off']] : ((V.fg && V.fg.claims) || ['swallow', 'release', 'plain']).map(function (c) { return [c, c]; });
      opts.forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; s.appendChild(op); });
      s.value = isToggle(f) ? (v ? 'on' : 'off') : String(v || '');
      s.addEventListener('change', function () {
        bundle(EDIT, f, isToggle(f) ? s.value === 'on' : s.value);
        prune(); drawRows();
      });
      box.appendChild(s);
      return box;
    }
    var units = ROWS.filter(function (r) { return r[0] === f; })[0][2] || [];
    var vals = ARITY[f] === 1 ? [v] : (v || []);
    for (var i = 0; i < ARITY[f]; i++) {
      var inp = el('input', 'ds-in fg-num'); inp.type = 'number'; inp.step = '1'; inp.setAttribute('inputmode', 'numeric');
      inp.setAttribute('data-fg', f); inp.setAttribute('data-i', String(i)); inp.value = vals[i] == null ? '' : String(vals[i]);
      inp.setAttribute('aria-label', label + (ARITY[f] > 1 ? ' ' + (i + 1) + ' of ' + ARITY[f] : '') + (units[i] ? ' (' + units[i] + ')' : ''));
      inp.addEventListener('change', onNum);
      box.appendChild(inp);
      if (units[i]) box.appendChild(el('span', 'adm-help fg-unit', ' ' + units[i] + ' '));
    }
    return box;
  }
  function onNum(ev) {
    var f = ev.target.getAttribute('data-fg');
    var inputs = ($('fgRows').querySelectorAll ? $('fgRows').querySelectorAll('input') : []);
    var nums = [];
    for (var i = 0; i < inputs.length; i++) if (inputs[i].getAttribute('data-fg') === f) nums.push(num(inputs[i].value));
    if (nums.some(function (n) { return n === null; })) { msg('⚠ ' + f + ': whole numbers only.', 'err'); return; }
    EDIT[f] = ARITY[f] === 1 ? nums[0] : nums;
    prune(); drawRows();
  }
  /** An edit back at Pepe's value is no edit. */
  function prune() {
    var cur = current(V.fg, where());
    Object.keys(EDIT).forEach(function (f) { if (same(EDIT[f], cur[f])) delete EDIT[f]; });
  }

  function drawRows() {
    var body = $('fgRows'); if (!body) return;
    body.textContent = '';
    var w = where(), cur = current(V.fg, w), fg = V.fg;
    ['fgNow', 'fgRoomsNow'].forEach(function (id) { var n = $(id); if (n) n.hidden = !!fg; });   // (the page's snapshot: the table has it now)
    if (!fg) {
      var tr0 = el('tr'), td0 = el('td', 'adm-help', V.online ? "This Pepe doesn't report his fast-grab settings yet - use !mic fastgrab in a room (or his own panel) until his update runs."
        : 'No report from Pepe right now (offline?).');
      td0.colSpan = 4; tr0.appendChild(td0); body.appendChild(tr0);
    } else {
      ROWS.forEach(function (row) {
        var f = row[0], tr = el('tr');
        if (Object.prototype.hasOwnProperty.call(EDIT, f) || FOLLOW[f]) tr.className = 'fg-edited';
        var name = el('td'); name.appendChild(el('b', null, row[1])); name.appendChild(el('div', 'adm-help', row[3])); tr.appendChild(name);
        var c = el('td'); c.appendChild(control(f, cur, row[1])); tr.appendChild(c);
        var src = sourceOf(fg, w, f), s = el('td');
        s.appendChild(el('span', 'adm-pill' + (src === 'room' ? ' ok' : ''), src === 'room' ? "this room's own" : src === 'mixed' ? 'room + global' : src));
        if (w.scope === 'room' && (src === 'room' || src === 'mixed')) {
          var lab = el('label', 'adm-help fg-follow'), cb = el('input'); cb.type = 'checkbox'; cb.checked = !!FOLLOW[f]; cb.setAttribute('data-follow', f);
          cb.addEventListener('change', function () { if (cb.checked) FOLLOW[f] = true; else delete FOLLOW[f]; drawRows(); });
          lab.appendChild(cb); lab.appendChild(document.createTextNode(' follow the global')); s.appendChild(lab);
        }
        tr.appendChild(s);
        tr.appendChild(el('td', 'adm-help', rangeText(fg, f)));
        body.appendChild(tr);
      });
    }
    var info = $('fgContest');
    if (info) {
      var bits = [];
      if (w.scope === 'room' && cur.contest) bits.push(cur.contest_active ? '⚔️ Contest is active here.' : '⚔️ Contest is set but not active here: ' + (cur.contest_why || 'see !mic fastgrab') + '.');
      if (w.scope === 'room' && cur.resting_min) bits.push('⏸ The breaker rests the fast grab here for ' + cur.resting_min + ' more min.');
      if (w.scope === 'all') bits.push('Every room: sets the global and clears each room\'s own value for what you change (-all).');
      if (dirty()) bits.push('✏️ ' + (Object.keys(EDIT).length + Object.keys(FOLLOW).length) + ' change(s) not saved yet.');
      info.textContent = bits.join(' ');
    }
    saveState();
  }
  function saveState() { var save = $('fgSave'); if (save) save.disabled = !V.fg || !V.online || BUSY; }
  /** Is the admin in one of the card's boxes right now? (a redraw would throw away what they are typing) */
  function typing() {
    var a = document.activeElement, body = $('fgRows');
    return !!(a && body && typeof body.contains === 'function' && body.contains(a));
  }

  function drawStatus() {
    var on = $('fgOnline');
    if (on) on.textContent = V.online ? (V.fg ? 'live' : 'live (older Pepe)') : 'offline' + (V.at ? ' (last seen ' + when(V.at) + ')' : '');
    var log = $('fgLog');
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
        var rec = ((V.fg && V.fg.last) || []).filter(function (x) { return String(x.id) === String(PENDING); })[0];
        var cl = rec && rec.clamped ? Object.keys(rec.clamped).map(function (f) {
          return f + ' ' + rec.clamped[f].asked.join('/') + ' → ' + rec.clamped[f].stored.join('/');
        }) : [];
        msg((a.status === 'done' ? '✅ ' : '❌ ') + (a.message || (a.status === 'done' ? 'Saved.' : 'Pepe refused it.'))
            + (cl.length ? ' Clamped: ' + cl.join(', ') + '.' : ''), a.status === 'done' ? 'ok' : 'err');
        if (a.status === 'done') { EDIT = {}; FOLLOW = {}; }
        PENDING = null;
        drawRows();
      }
    }
  }

  function load() {
    return fetch('/api/admin/pepe/fastgrab', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        var before = JSON.stringify([V.fg, V.online]);
        V = d;
        drawWhere();
        // redrawn only when Pepe's values changed and nobody is editing or typing in the card
        if (!dirty() && !typing() && JSON.stringify([V.fg, V.online]) !== before) drawRows(); else prune();
        saveState();
        drawStatus();
      }).catch(function () {});
  }

  function save() {
    var w = where(), cur = current(V.fg, w);
    var set = change(cur, EDIT, FOLLOW);
    if (!set) { msg('Nothing changed.'); return; }
    if (w.scope === 'all' && !confirm('Every room: this sets the global and clears every room\'s own value for these settings. Go on?')) return;
    var reason = ($('fgReason') || {}).value || '';
    BUSY = true; msg('…'); drawRows();
    return fetch('/api/admin/pepe/fastgrab', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ scope: w.scope, room: w.room, set: set, reason: reason.trim() || undefined }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        BUSY = false;
        if (d && d.ok) { PENDING = d.id; msg('Sent to Pepe - his answer (what he stored) shows here in a few seconds.'); }
        else msg('❌ ' + ((d && d.error) || 'failed'), 'err');
        drawRows();
        return load();
      })
      .catch(function () { BUSY = false; msg('❌ The site did not answer.', 'err'); drawRows(); });
  }

  var sel = $('fgWhere');
  if (sel) sel.addEventListener('change', function () { EDIT = {}; FOLLOW = {}; drawWhere(); drawRows(); msg(''); });
  var all = $('fgAll');
  if (all) all.addEventListener('change', function () { EDIT = {}; FOLLOW = {}; drawRows(); });
  var sb = $('fgSave'); if (sb) sb.addEventListener('click', save);
  var ub = $('fgUndo'); if (ub) ub.addEventListener('click', function () { EDIT = {}; FOLLOW = {}; msg(''); drawRows(); });
  drawWhere(); drawRows(); drawStatus();
  api._card = { save: save, load: load, state: function () { return { V: V, EDIT: EDIT, FOLLOW: FOLLOW, PENDING: PENDING }; } };
  setInterval(function () { if (!document.hidden) load(); }, 4000);
})();
