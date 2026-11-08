/* ⚡ Fast mic grab - Pepe's !mic fastgrab switches and caps for one room, the global default or every room
   (grabcard 1.99amm; /admin/pepe/rooms#fastgrab - fastgrab.js -> website action mic.fastgrab -> camfrog-bot pepe_fastgrabweb.py).
   The values shown are the ones Pepe reports (his rooms state push); a save sends only the fields you changed, as ONE change,
   and shows what Pepe stored (and clamped) when he answers. window.PatvFastGrab = the pure part (the tests run it in node).
   1.99amu micblock: + Block break / Self-unblock (switches) and Unblock code (the card's one text box - checked here like the site
   and Pepe check it: 1-20 characters, never starting with / or !, nothing his chat would change; empty = none). v3: that last check.
   1.99anf micreplies (v4): + -mic replies fast-grab (!mic fastgrab replies - his -mic command answers fast-grab too). */
(function () {
  'use strict';
  var TOGGLES = ['on', 'contest', 'fair', 'web', 'chatty', 'replies', 'blockbreak', 'selfunblock'];
  var TEXTS = ['unblockcode'], CODE_MAX = 20;
  var ARITY = { rate: 1, shots: 1, tries: 1, breaker: 3, pause: 4, fairwait: 2, ceiling: 1 };
  // [field, label, units (one per number), what it does]
  var ROWS = [
    ['on', 'Fast grab', null, "While a soundboard clip, a paid !say or an alert waits for a full mic, Pepe's grab goes out the instant someone drops it."],
    ['contest', 'Contest', null, 'Stay armed through every drop of a fight for the mic (one grab per drop). On = also fast grab on, fair off, claim swallow - like !mic fastgrab contest on.'],
    ['fair', 'Fairness wait', null, 'A drop after a very short hold (a double-click) waits for that person to re-grab.'],
    ['claim', 'Claim', null, "How a won grab meets Pepe's own Talk click: swallow (default), release, or plain (a staging drill)."],
    ['web', 'Push-to-talk web clips fast-grab', null, 'Web clips take the mic the instant it frees (no 2 s wait) and follow contest.'],
    ['chatty', 'Chatty mic-ups fast-grab', null, "Pepe's chatty lines fast-grab too."],
    ['replies', '-mic replies fast-grab', null, '!ask / !roast / !look ... -mic answers fast-grab too (they already paid the -mic surcharge); a -mic !remind / !relay too.'],
    ['rate', 'Rate', ['grabs / min'], 'Grabs a minute Pepe may send in the room while contesting.'],
    ['shots', 'Shots', ['refused tries / clip'], 'Refused tries one clip may use in contest, then the normal grab.'],
    ['tries', 'Tries', ['a clip'], 'Fast-grab tries per clip the room can see (past 2: more lost races only).'],
    ['breaker', 'Breaker', ['misses in', 'min, rest', 'min'], 'That many grabs that did not play in that many minutes rest the fast grab there (rest 0 = never).'],
    ['pause', 'Contested pause', ['lost in', 's, pause', 's, up to', 's'], "Pepe's own pause on a mic he keeps losing (count 0 or first 0 = off; doubling up to the cap)."],
    ['fairwait', 'Fairness wait times', ['ms hold, wait', 'ms'], 'With fair on: a drop after a hold under the first number waits the second.'],
    ['ceiling', 'Ceiling (every room)', ['grabs / min, all rooms'], "Pepe's fast grabs a minute across every room together - always every room's."],
    ['blockbreak', 'Block break', null, "Someone blocking Pepe's mic puts this room's mic on a 30-minute break (paid lines are refused before the charge meanwhile). Off = no break: Pepe tries again once the block is lifted."],
    ['selfunblock', 'Self-unblock', null, "When someone blocks Pepe's mic here, he types the room's unblock code (below) a moment later - for a room bot that unblocks whoever types it. Once more 30 s later if no unblock comes; at most 3 in 10 min; never when the room's own bot blocked him."],
    ['unblockcode', 'Unblock code', null, 'What Pepe types to unblock himself (Players Lounge: 1). 1-20 characters, never starting with / or !, no * ` __ ~~ and no word starting with -; empty = none.']
  ];
  var FIELDS = ROWS.map(function (r) { return r[0]; });
  var LABELS = {}; ROWS.forEach(function (r) { LABELS[r[0]] = r[1]; });
  var WORD = { on: 'fast grab', contest: 'contest', fair: 'fair', claim: 'claim', web: 'web clips', chatty: 'chatty', replies: '-mic replies',
               blockbreak: 'block break', selfunblock: 'self-unblock', unblockcode: 'unblock code' };

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function isToggle(f) { return TOGGLES.indexOf(f) >= 0; }
  function isText(f) { return TEXTS.indexOf(f) >= 0; }
  /** An unblock code typed in the card -> {code, err} (the site's codeClean: trimmed; empty / none = no code). */
  function codeOf(v) {
    var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
    if (['', 'none', 'off', '-'].indexOf(s.toLowerCase()) >= 0) return { code: '', err: null };
    if ((Array.from ? Array.from(s).length : s.length) > CODE_MAX) return { code: '', err: 'at most ' + CODE_MAX + ' characters' };
    if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(s)) return { code: '', err: 'printable characters only' };
    if (s.charAt(0) === '/' || s.charAt(0) === '!') return { code: '', err: "it can't start with / or ! (that would be a command)" };
    // micblock review F8: nothing Pepe's chat would change (its markdown strip; a word starting with - is a chat flag)
    if (/\*|`|__|~~/.test(s)) return { code: '', err: 'no * or ` and no __ or ~~ (the chat would strip them)' };
    if (s.split(/\s+/).some(function (w) { return w.charAt(0) === '-'; })) return { code: '', err: 'no word may start with - (that is a chat flag)' };
    return { code: s, err: null };
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function copy(o) { var out = {}; for (var k in (o || {})) if (has(o, k)) out[k] = o[k]; return out; }
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
    var out = copy(v);
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
  /** The rooms with a value of their own for f - the global doesn't change them, every room (-all) clears them (never the
      ceiling: it is every room's). */
  function overriders(fg, f) {
    if (!fg || f === 'ceiling') return [];
    return (fg.rooms || []).filter(function (r) { return !!(r.own && r.own[f]); });
  }
  function fmt(f, v) {
    if (v == null) return '–';
    if (isToggle(f)) return v ? 'on' : 'off';
    if (isText(f)) return v ? String(v) : 'none';
    return Array.isArray(v) ? v.join(' / ') : String(v);
  }
  /** "Players Lounge 15, Houseplants 6 / 10 / 15 (partly) +2 more" */
  function ownList(fg, f) {
    var rs = overriders(fg, f);
    var t = rs.slice(0, 3).map(function (r) { return r.name + ' ' + fmt(f, r.values && r.values[f]) + (r.own[f] === 'mixed' ? ' (partly)' : ''); }).join(', ');
    return t + (rs.length > 3 ? ' +' + (rs.length - 3) + ' more' : '');
  }
  /** What !mic fastgrab contest on|off also sets: on = fast grab on + fair off + claim swallow; off = fair on. Pepe applies
      contest FIRST, then the change's own on / fair / claim - so an admin's on / fair / claim that differs from this is sent
      even when it equals his value now (grabcard review). */
  function implied(contest) {
    return contest === true ? { on: true, fair: false, claim: 'swallow' } : contest === false ? { fair: true } : {};
  }
  /** What the card shows for f: the admin's edit, else what a contest edit's bundle sets, else Pepe's value. */
  function shown(cur, edits, f) {
    if (has(edits, f)) return edits[f];
    var imp = has(edits, 'contest') ? implied(edits.contest) : {};
    return has(imp, f) ? imp[f] : cur[f];
  }
  /** Drops (in place) the edits that would change nothing: one equal to what Pepe would store anyway - his value now, or for
      on / fair / claim beside a contest edit, what its bundle sets. Every room (-all): an edit equal to the global's value
      still clears the rooms with their own value for it, so it stays. */
  function prune(fg, w, edits) {
    var cur = current(fg, w);
    var spread = function (f) { return w.scope === 'all' && overriders(fg, f).length > 0; };
    if (has(edits, 'contest') && same(edits.contest, cur.contest) && !spread('contest')) delete edits.contest;
    var imp = has(edits, 'contest') ? implied(edits.contest) : {};
    Object.keys(edits).forEach(function (f) {
      if (f === 'contest') return;
      if (has(imp, f)) { if (same(edits[f], imp[f])) delete edits[f]; return; }   // (the bundle sets it - with -all, everywhere)
      if (same(edits[f], cur[f]) && !spread(f)) delete edits[f];
    });
    return edits;
  }
  /** The change to send: {field: value | 'follow'} or null - the edits that change something, + a room's "follow the global"
      boxes (its own value dropped). (Every room's "every room to this value" box is an edit of the value shown: prune keeps
      it while a room has its own.) */
  function change(fg, w, edits, follows) {
    var e = prune(fg, w, copy(edits));
    var set = {}, n = 0;
    FIELDS.forEach(function (f) {
      if (w.scope === 'room' && follows && follows[f] && f !== 'ceiling') { set[f] = 'follow'; n++; return; }
      if (has(e, f)) { set[f] = e[f]; n++; }
    });
    return n ? set : null;
  }
  function rangeText(fg, f) {
    var r = fg && fg.ranges && fg.ranges[f], d = fg && fg.defaults && fg.defaults[f];
    var s = r ? r.map(function (p) { return p[0] + '-' + p[1]; }).join(' / ') : '';
    if (d != null) s += (s ? ' · ' : '') + 'default ' + fmt(f, d);
    return s;
  }
  /** One number input's text -> an int, or null (not a whole number). */
  function num(s) { var t = String(s == null ? '' : s).trim(); return /^-?\d{1,7}$/.test(t) ? parseInt(t, 10) : null; }

  var api = { FIELDS: FIELDS, ROWS: ROWS, ARITY: ARITY, TOGGLES: TOGGLES, TEXTS: TEXTS, codeOf: codeOf, whereOf: whereOf, current: current, sourceOf: sourceOf,
              overriders: overriders, ownList: ownList, implied: implied, shown: shown, prune: prune, change: change, fmt: fmt,
              rangeText: rangeText, num: num };
  if (typeof window !== 'undefined') window.PatvFastGrab = api;
  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('fastgrab')) return;

  // ── the card ──
  var $ = function (id) { return document.getElementById(id); };
  var V = null;
  try { V = JSON.parse(($('fgData') || {}).textContent || 'null'); } catch (e) { V = null; }
  V = V || { online: false, fg: null, actions: [] };
  // EDIT: the admin's values; FOLLOW: the row boxes (follow the global / every room to this). SENT: the last save, until Pepe
  // answers (his answer clears only what it saved). STALE: his answer came while the admin was in a box - redraw when they leave.
  var EDIT = {}, FOLLOW = {}, PENDING = null, SENT = null, BUSY = false, STALE = false;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function when(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
  function where() { return whereOf(($('fgWhere') || {}).value, !!($('fgAll') || {}).checked); }
  function wkey(w) { return w.scope + ':' + w.room; }
  function msg(t, cls) { var m = $('fgMsg'); if (m) { m.textContent = t; m.className = 'adm-msg' + (cls ? ' ' + cls : ''); } }
  function dirty() { return Object.keys(EDIT).length + Object.keys(FOLLOW).length > 0; }
  function each(list, fn) { for (var i = 0; i < ((list && list.length) || 0); i++) fn(list[i]); }

  var WHERE_KEY = null, NAMES = {};
  /** The Where list, rebuilt only when Pepe's room list changed (a rebuild under an open dropdown would close it). -> the id of
      the picked room when it dropped out of his list (grabcard review: the select fell back to the global quietly, and a
      Save sent the room's edits there) - its edits are dropped and the card says so. */
  function drawWhere() {
    var sel = $('fgWhere'); if (!sel) return null;
    var keep = sel.value || 'global', lost = null;
    var rooms = (V.fg && V.fg.rooms) || [];
    var key = JSON.stringify(rooms.map(function (r) { return [r.id, r.name, r.joined]; }));
    if (key !== WHERE_KEY) {
      WHERE_KEY = key;
      var before = NAMES; NAMES = {};
      sel.textContent = '';
      var g = el('option', null, 'Global default (every room without its own)'); g.value = 'global'; sel.appendChild(g);
      rooms.forEach(function (r) {
        NAMES[r.id] = r.name;
        var o = el('option', null, r.name + (r.name !== r.id ? ' (' + r.id + ')' : '') + (r.joined ? '' : ' - Pepe is not in it now'));
        o.value = 'room:' + r.id; sel.appendChild(o);
      });
      sel.value = keep;
      if (sel.value !== keep) {
        sel.value = 'global';
        if (keep.indexOf('room:') === 0) {
          lost = keep.slice(5);
          var had = dirty();
          EDIT = {}; FOLLOW = {};
          var all = $('fgAll'); if (all) all.checked = false;     // (ticked before the room was picked: never every room now)
          msg('⚠ Pepe no longer reports ' + (before[lost] || lost) + ' (he left it or restarted)'
              + (had ? ' - your unsaved changes for it were dropped' : '') + '. Showing the global default.', 'err');
        }
      }
    }
    var allL = $('fgAllL'); if (allL) allL.hidden = where().scope === 'room';
    return lost;
  }

  function control(f, cur, label) {
    var v = shown(cur, EDIT, f);
    var box = el('span', 'fg-ctl');
    if (isToggle(f) || f === 'claim') {
      var s = el('select', 'ds-in'); s.setAttribute('data-fg', f); s.setAttribute('aria-label', label);
      var opts = isToggle(f) ? [['on', 'on'], ['off', 'off']] : ((V.fg && V.fg.claims) || ['swallow', 'release', 'plain']).map(function (c) { return [c, c]; });
      opts.forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; s.appendChild(op); });
      s.value = isToggle(f) ? (v ? 'on' : 'off') : String(v || '');
      s.addEventListener('change', function () {
        EDIT[f] = isToggle(f) ? s.value === 'on' : s.value;
        prune(V.fg, where(), EDIT); sync();
      });
      box.appendChild(s);
      return box;
    }
    if (isText(f)) {                     // 1.99amu micblock: the unblock code (a text box; checked on change, never sent bad)
      var t = el('input', 'ds-in'); t.type = 'text'; t.setAttribute('maxlength', String(CODE_MAX)); t.setAttribute('autocomplete', 'off');
      t.setAttribute('data-fg', f); t.setAttribute('aria-label', label); t.setAttribute('placeholder', 'none');
      t.value = v == null ? '' : String(v);
      t.addEventListener('change', function () {
        var c = codeOf(t.value);
        if (c.err) { delete EDIT[f]; msg('⚠ ' + label + ': ' + c.err + '.', 'err'); prune(V.fg, where(), EDIT); sync(); return; }
        EDIT[f] = c.code;
        prune(V.fg, where(), EDIT); sync();
      });
      box.appendChild(t);
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
    var nums = [];
    each($('fgRows').querySelectorAll('input'), function (n) { if (n.getAttribute('data-fg') === f) nums.push(num(n.value)); });
    if (nums.some(function (n) { return n === null; })) { msg('⚠ ' + f + ': whole numbers only.', 'err'); return; }
    EDIT[f] = ARITY[f] === 1 ? nums[0] : nums;
    // (no redraw: the box the admin moves to - the next of a breaker's / pause's numbers - must stay the same box)
    prune(V.fg, where(), EDIT); sync();
  }
  function edited(cur, f) { return has(EDIT, f) || !!FOLLOW[f] || !same(shown(cur, EDIT, f), cur[f]); }
  /** A row box: a room's "follow the global" (FOLLOW) / every room's "every room to this value" (= an edit of the value shown:
      a contest one brings its bundle like any contest edit; unticked, the edit goes). */
  function rowBox(f, attr, text) {
    var every = attr === 'data-every';
    var lab = el('label', 'adm-help fg-follow'), cb = el('input'); cb.type = 'checkbox'; cb.setAttribute(attr, f);
    cb.checked = every ? has(EDIT, f) : !!FOLLOW[f];
    cb.addEventListener('change', function () {
      if (every) { if (cb.checked) EDIT[f] = shown(current(V.fg, where()), EDIT, f); else delete EDIT[f]; prune(V.fg, where(), EDIT); }
      else if (cb.checked) FOLLOW[f] = true; else delete FOLLOW[f];
      sync();
    });
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + text));
    return lab;
  }

  function drawRows() {
    var body = $('fgRows'); if (!body) return;
    body.textContent = '';
    STALE = false;
    var w = where(), cur = current(V.fg, w), fg = V.fg;
    ['fgNow', 'fgRoomsNow'].forEach(function (id) { var n = $(id); if (n) n.hidden = !!fg; });   // (the page's snapshot: the table has it now)
    if (!fg) {
      var tr0 = el('tr'), td0 = el('td', 'adm-help', V.online ? "This Pepe doesn't report his fast-grab settings yet - use !mic fastgrab in a room (or his own panel) until his update runs."
        : 'No report from Pepe right now (offline?).');
      td0.colSpan = 4; tr0.appendChild(td0); body.appendChild(tr0);
    } else {
      ROWS.forEach(function (row) {
        var f = row[0], tr = el('tr');
        tr.setAttribute('data-row', f);
        tr.className = edited(cur, f) ? 'fg-edited' : '';
        var name = el('td'); name.appendChild(el('b', null, row[1])); name.appendChild(el('div', 'adm-help', row[3])); tr.appendChild(name);
        var c = el('td'); c.appendChild(control(f, cur, row[1])); tr.appendChild(c);
        var src = sourceOf(fg, w, f), s = el('td');
        s.appendChild(el('span', 'adm-pill' + (src === 'room' ? ' ok' : ''), src === 'room' ? "this room's own" : src === 'mixed' ? 'room + global' : src));
        if (w.scope === 'room' && (src === 'room' || src === 'mixed')) s.appendChild(rowBox(f, 'data-follow', 'follow the global'));
        // (grabcard review) the global / every room: which rooms keep a value of their own for this setting
        var own = w.scope !== 'room' ? ownList(fg, f) : '';
        if (own && w.scope === 'global') s.appendChild(el('div', 'adm-help', 'Rooms with their own (not changed by the global): ' + own));
        if (own && w.scope === 'all') s.appendChild(rowBox(f, 'data-every', 'every room to this value (clears their own: ' + own + ')'));
        tr.appendChild(s);
        tr.appendChild(el('td', 'adm-help', rangeText(fg, f)));
        body.appendChild(tr);
      });
    }
    info(w, cur);
    saveState();
  }
  /** After an edit (or a poll while the admin edits): the rows' marks, every box's value - the switches a contest edit's
      bundle moves, Pepe's newer values - and the summary, in place, never a rebuild (a rebuild replaced the box the admin was
      moving to, and closed a phone's keyboard; grabcard review). The box the admin is in is left as it is. */
  function sync() {
    var body = $('fgRows'), w = where(), cur = current(V.fg, w), a = document.activeElement;
    if (body && V.fg && body.querySelectorAll) {
      each(body.querySelectorAll('tr'), function (tr) {
        var f = tr.getAttribute('data-row'); if (f) tr.className = edited(cur, f) ? 'fg-edited' : '';
      });
      each(body.querySelectorAll('select'), function (s) {
        var f = s.getAttribute('data-fg'); if (!f || s === a) return;
        var v = shown(cur, EDIT, f);
        s.value = isToggle(f) ? (v ? 'on' : 'off') : String(v || '');
      });
      each(body.querySelectorAll('input'), function (n) {
        if (n === a) return;
        var f = n.getAttribute('data-fg');
        if (f && ARITY[f]) {
          var v = shown(cur, EDIT, f), x = ARITY[f] === 1 ? v : (v || [])[Number(n.getAttribute('data-i'))];
          n.value = x == null ? '' : String(x);
        } else if (f && isText(f)) {
          var tv = shown(cur, EDIT, f);
          if (codeOf(n.value).err == null || has(EDIT, f)) n.value = tv == null ? '' : String(tv);   // (a refused code stays for fixing)
        } else if (n.getAttribute('data-every')) n.checked = has(EDIT, n.getAttribute('data-every'));
        else if (n.getAttribute('data-follow')) n.checked = !!FOLLOW[n.getAttribute('data-follow')];
      });
    }
    info(w, cur);
    saveState();
  }
  function info(w, cur) {
    var box = $('fgContest'); if (!box) return;
    var bits = [];
    if (w.scope === 'room' && cur.contest) bits.push(cur.contest_active ? '⚔️ Contest is active here.' : '⚔️ Contest is set but not active here: ' + (cur.contest_why || 'see !mic fastgrab') + '.');
    if (w.scope === 'room' && cur.resting_min) bits.push('⏸ The breaker rests the fast grab here for ' + cur.resting_min + ' more min.');
    if (w.scope === 'all') bits.push('Every room: sets the global and clears each room\'s own value for what you change (-all).');
    if (V.fg && has(EDIT, 'contest')) {
      var imp = implied(EDIT.contest), also = Object.keys(imp).filter(function (f) { return !has(EDIT, f); });
      if (also.length) bits.push('⚔️ Contest ' + (EDIT.contest ? 'on' : 'off') + ' also sets ' + also.map(function (f) { return WORD[f] + ' ' + fmt(f, imp[f]); }).join(', ')
                                 + ' (like !mic fastgrab contest ' + (EDIT.contest ? 'on' : 'off') + '); a switch you set yourself wins.');
    }
    var set = V.fg ? change(V.fg, w, EDIT, FOLLOW) : null, n = set ? Object.keys(set).length : 0;
    if (n) bits.push('✏️ ' + n + ' change(s) not saved yet.');
    box.textContent = bits.join(' ');
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
        // done: the edits it saved are done - not the ones made since (grabcard review: those were thrown away)
        if (a.status === 'done' && SENT && SENT.key === wkey(where())) {
          Object.keys(SENT.set).forEach(function (f) {
            if (FOLLOW[f] && SENT.follow[f]) delete FOLLOW[f];
            if (has(EDIT, f) && same(EDIT[f], SENT.set[f])) delete EDIT[f];
          });
        }
        PENDING = null; SENT = null;
        prune(V.fg, where(), EDIT);
        if (typing()) { STALE = true; sync(); } else drawRows();      // (never under a box being typed in)
      }
    }
  }

  function load() {
    return fetch('/api/admin/pepe/fastgrab', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        var before = JSON.stringify([V.fg, V.online]);
        V = d;
        var changed = JSON.stringify([V.fg, V.online]) !== before;
        var lost = drawWhere();
        // redrawn when the picked room is gone, when Pepe stopped reporting the block, when his answer waited for the admin to
        // leave a box, or when his values changed and nobody is editing or typing in the card (else: updated in place)
        if (lost || (changed && !V.fg) || (STALE && !typing()) || (changed && !dirty() && !typing())) drawRows();
        else { prune(V.fg, where(), EDIT); sync(); }
        drawStatus();
      }).catch(function () {});
  }

  function save() {
    var w = where();
    if (w.scope === 'room' && !roomOf(V.fg, w.room)) { msg('⚠ Pepe no longer reports that room - pick it again (or another).', 'err'); return; }
    prune(V.fg, w, EDIT);
    var set = change(V.fg, w, EDIT, FOLLOW);
    if (!set) { msg('Nothing changed.'); sync(); return; }
    if (w.scope === 'all' && !confirm('Every room: this sets the global and clears every room\'s own value for these settings. Go on?')) return;
    var reason = ($('fgReason') || {}).value || '';
    var sent = { key: wkey(w), set: set, follow: copy(FOLLOW) };
    BUSY = true; msg('…'); saveState();
    return fetch('/api/admin/pepe/fastgrab', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ scope: w.scope, room: w.room, set: set, reason: reason.trim() || undefined }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        BUSY = false;
        if (d && d.ok) { PENDING = d.id; SENT = sent; msg('Sent to Pepe - his answer (what he stored) shows here in a few seconds.'); }
        else msg('❌ ' + ((d && d.error) || 'failed'), 'err');
        sync();
        return load();
      })
      .catch(function () { BUSY = false; msg('❌ The site did not answer.', 'err'); sync(); });
  }

  var sel = $('fgWhere');
  if (sel) sel.addEventListener('change', function () { EDIT = {}; FOLLOW = {}; drawWhere(); drawRows(); msg(''); });
  var all = $('fgAll');
  if (all) all.addEventListener('change', function () { EDIT = {}; FOLLOW = {}; drawRows(); });
  var sb = $('fgSave'); if (sb) sb.addEventListener('click', save);
  var ub = $('fgUndo'); if (ub) ub.addEventListener('click', function () { EDIT = {}; FOLLOW = {}; msg(''); drawRows(); });
  drawWhere(); drawRows(); drawStatus();
  api._card = { save: save, load: load, state: function () { return { V: V, EDIT: EDIT, FOLLOW: FOLLOW, PENDING: PENDING, SENT: SENT }; } };
  setInterval(function () { if (!document.hidden) load(); }, 4000);
})();
