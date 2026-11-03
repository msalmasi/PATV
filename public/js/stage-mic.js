// stage-mic.js — 🎙 "On the mic": the pad stage's mic-follows view (micfollow.js on the server). Whoever holds the pad's
// Camfrog mic is on it; several people at once are shown together. The layout is drawn HERE from one WebRTC (WHEP)
// stream per cam - nothing is mixed or re-encoded on a server:
//   single  one tile                       split  two side by side
//   grid4   2 x 2                          grid9  3 x 3 (empty cells stay black - the "Brady Bunch" look)
//   pip     the newest speaker fills the stage, the one before in a corner inset
// The newest speaker is highlighted (a green ring + "newest speaker" for screen readers). A tile without live video is a
// still (a snapshot every few seconds, "📷 still") or a name card with the reason (cam off, starting, live cams full,
// members only, not available). Each live tile asks POST /api/rooms/<slug>/micfollow/watch for a ticket of its own, plays
// it with PATVRtc.watch (muted: the room's sound is the 🔊 room audio) and beats every 15 s; a tile that leaves closes its
// session. After 30 s in a hidden tab every session closes and stills stop polling; they come back when the tab does (1.99ahn: a
// tile whose picture the pause took away says "resuming…" meanwhile, not "cam starting…" - the cam never stopped, only this
// tab's player did; a tile that had no picture yet, or came on while the tab was hidden, says "cam starting…"). The player box keeps its
// 16:9 size whatever the layout, so the page never moves. Owners / staff (program.manage) get a bar ABOVE the tiles (it
// never covers one): ⋯ Manage (❄ freeze, the layout for this session, ✕ to keep someone off the mic stage 1 h / 24 h /
// always) and 🧹 Clear the stage (everyone off now, frozen). Signed-in viewers get ⚑ on each tile (on narrow grids, in a
// bar above them): a reason, and the tile hides for them at once (program.report). While the mic is held only by people
// nobody can show - or Pepe alone - the stage shows a neutral card (program.speaking: "Someone is speaking" / Pepe's card),
// never the last speaker's face. All text via textContent.
// mfix (owner 2026-10-25): a speaker who let go of the mic stays up a while (a recent tile - no ring); 📌 pinned cams take the
// first places (owners / staff pin them from ⋯ Manage → 📌 Pin a cam, unpin with 📌✕ on the tile); while someone nobody can show
// - or Pepe - talks with tiles still up, the tiles dim and a strip says so (program.speaking with src); a tile showing the
// viewer's OWN cam has 🙈 Take me off (POST /api/stage/leave); an empty program (the page keeps the view a moment) says nobody
// is on the mic; every card says why there's no picture (cold opens off, the rate limit, Pepe's cams busy, ...).
// 1.99afl (S2-S4): "Pepe couldn't open their cam" only for his refusal - his relay offline, the room's people list he can't read,
// "checking their cam…" (the roster can't say yet), this browser not connecting to the video and a video that kept dropping each
// say so; every tile carries data-why (the reason code of its card).
// 1.99ahq stage cover (owner 2026-11-02): a card shows the person's STAGE COVER instead of the letter - the program's avatar (a URL)
// + ck (gtf | photo | sticker | upload): their GTF pixel avatar by default, or what they picked in Settings -> 🎙 Stage cover
// (stagecover.js); the reason ("cam starting…") stays as a small label under it. Set only when the URL changes; never on a cover
// tile (the hood), a tile the viewer reported or one blocked for them.
//
// wave2 WP-4 (the incognito / mic-stage spec F.3): the pad layout "dynamic" - program.dyn {n, t: "d1".."d9", main} beside the
// legacy layout: templates d1-d9 (DYN - they equal stagemiccap.rects, so a capture is what you see), the main cell for the
// active speaker, the others in their place order. Only each tile's style.gridArea changes: an existing tile's node (and its
// video) is never moved when the main changes; a new one is inserted at its place. Every current holder gets the mic ring
// (s.ring). When av-sync's delayed view holds a different number of tiles than dyn.n, the template is worked out here from
// the tiles shown (never the legacy grid - that would jump).
// wave2 WP-4 (F.4): a veiled speaker is a COVER tile ({kind: "cover"}): the hooded frog (/public/img/anon/hood-peek|shadow-N.svg)
// on its hood colour under static scanlines, "<frog name or someone> · incognito / hidden", the mic ring; no cam, still, ⚑ or
// 📌 for anyone; ✕ only with ex: 1, Reveal only with rv: 1 (WP-2's window.PATVReveal.tile), "this is you" with self: 1.
// wave 2 (owner J-18): while the viewer's "Show real names" toggle for the pad is on (window.PATVReveal.state(), pad-reveal.js), a
// cover with rv: 1 reveals itself (once per cover id; counted on the toggle's row on the server); "Hide again" hides those again.
// 1.99ahp STABLE SLOTS (owner 2026-11-02: two people taking turns swapped places on every turn): with program.stable a tile's
// cell is its place (pos) - an empty place is an empty (black) cell, the fillers flow into them; each tile gets its grid-area,
// so an existing node stays put (its video never re-attaches) and a new one goes in at its place (review fix C2: on the grid /
// side by side / single layouts a node out of the places' order - after a pick or a main swap, then a layout change - moves
// back, so the reading order is the cells'; dynamic and picture in picture never move one). Dynamic: the cells are the
// places, the main in cell 0 (with 3+ the server's active speaker; with 2 nobody moves); picture in picture: the big picture is
// place 0. Without it (the site knob off) today's order - and, either way, a node only moves when its place changed.
//
//   var ctl = PATVStageMic.render(host, program, {slug, onChange})    host = the stage's player box (#rmVideo)
//   ctl.update(program) · ctl.stop() · ctl.selection()
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var BEAT_MS = 15000, HIDDEN_MS = 30000, SAY_GAP = 5000, RETRY_MS = 10000;
  // 1.99ahq review fix 3 (FID-3): a cover picture that failed to load is tried again after this (the site keeps a failed photo fetch
  // for stagecover's PHOTO_FAIL_TTL = 5 min, then a capture fetches it again - the page does too, a little after)
  var COVER_RETRY_MS = 315000;
  var REWATCH_MAX = 4, REWATCH_WIN_MS = 3 * 60 * 1000;   // mfix review: a live tile's re-watches after a dropped connection
  var LAYOUTS = ['single', 'split', 'grid4', 'grid9', 'pip'];
  // wave2 WP-4 (F.3): d1-d9 - [column fractions, rows, cells]; a cell = [col, row, colspan, rowspan] (0-based), cell 0 = the main.
  // MUST equal stagemiccap.rects (test/micfollow-ui.test.js compares them for n = 1..9)
  var DYN = (function () {
    var T = {};
    function leftMain(cols, rows) { var c = [[0, 0, 1, rows]]; for (var y = 0; y < rows; y++) for (var x = 1; x < cols.length; x++) c.push([x, y, 1, 1]); return [cols, rows, c]; }
    function bigMain(nc, rows, span) {
      var cols = [], c = [[0, 0, span, span]];
      for (var i = 0; i < nc; i++) cols.push(1);
      for (var y = 0; y < rows; y++) for (var x = 0; x < nc; x++) if (x >= span || y >= span) c.push([x, y, 1, 1]);
      return [cols, rows, c];
    }
    T[1] = [[1], 1, [[0, 0, 1, 1]]];
    T[2] = [[1, 1], 1, [[0, 0, 1, 1], [1, 0, 1, 1]]];              // side by side (the owner's rule for 2-slot rooms)
    T[3] = leftMain([2, 1], 2);
    T[4] = leftMain([3, 1], 3);
    T[5] = [[2, 1, 1], 2, [[0, 0, 1, 2], [1, 0, 1, 1], [2, 0, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]]];
    T[6] = bigMain(3, 3, 2);
    T[7] = leftMain([2, 1, 1], 3);
    T[8] = bigMain(4, 4, 3);
    T[9] = bigMain(4, 3, 2);
    return T;
  })();
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function btn(cls, text, label) { var b = el('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; }
  function post(url, body, keep) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: !!keep,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function initials(n) {
    var p = String(n || '?').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '?').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }
  function short(n) { n = String(n || ''); return n.length > 10 ? n.slice(0, 10) + '…' : n; }
  function cleanProgram(p) {
    if (!p || typeof p !== 'object') return null;
    var src = Array.isArray(p.src) ? p.src.filter(function (s) { return s && typeof s.id === 'string' && /^[\w.\-]{1,40}$/.test(s.id); }).slice(0, 9) : [];
    // wave2 WP-4 (F.3): the dynamic template - only a well-formed one (else the legacy layout)
    var d = p.dyn && typeof p.dyn === 'object' && /^d[1-9]$/.test(String(p.dyn.t)) && typeof p.dyn.main === 'string' && /^[\w.\-]{1,40}$/.test(p.dyn.main) ? { n: Number(p.dyn.n) || 0, main: p.dyn.main } : null;
    return { v: p.v, layout: LAYOUTS.indexOf(p.layout) >= 0 ? p.layout : 'single', count: Math.max(0, Number(p.count) || 0), pins_n: Math.max(0, Number(p.pins_n) || 0), signin: p.signin === true, idle: p.idle === true,
             blocked: p.blocked === true, src: src, manage: p.manage && typeof p.manage === 'object' ? p.manage : null, frozen_until: Number(p.frozen_until) || 0,
             still_s: Math.max(10, Math.min(120, Number(p.still_s) || 20)), fixed: p.fixed === true, report: p.report === true,
             speaking: p.speaking === 'someone' || p.speaking === 'pepe' ? p.speaking : null, dyn: d, stable: p.stable === true };
  }
  /** Entries in place order (pos; ties keep the program's order). */
  function byPos(src) {
    return src.map(function (s, i) { return [s, i]; }).sort(function (a, b) { return (Number(a[0].pos) || 0) - (Number(b[0].pos) || 0) || a[1] - b[1]; })
      .map(function (x) { return x[0]; });
  }
  // 1.99ahp STABLE SLOTS: how many cells each legacy layout has, and its columns (MUST equal stagemiccap.slotCells / rects)
  var CELLS = { single: 1, split: 2, grid4: 4, grid9: 9, pip: 2 }, COLS = { single: 1, split: 2, grid4: 2, grid9: 3, pip: 1 };
  /** 1.99ahp STABLE SLOTS (program.stable): each entry's cell is its place (pos) - an empty place stays an empty cell; two entries
   *  on one place (a delayed view mixing an older program's places with a new pin's) take the next free one; more places than
   *  cells - or a layout without empty cells (dense: the dynamic templates) - close up, in place order. -> [entry | null] */
  function slotCells(sorted, cells, dense) {
    var out = [];
    sorted.forEach(function (s) {
      var p = Math.min(64, Math.max(0, Math.floor(Number(s.pos)) || 0));
      while (out[p]) p++;
      out[p] = s;
    });
    for (var i = 0; i < out.length; i++) if (!out[i]) out[i] = null;
    return dense || out.length > cells ? out.filter(Boolean) : out;
  }
  /** 1.99ahp STABLE SLOTS: the dynamic template's cells in order - the places, with the server's main in cell 0 once there are 3 or
   *  more (it trades places with whoever is there; the server already put it there - this only covers a view where it didn't);
   *  with 1-2 nobody moves (cell 0 is just place 0). */
  function dynSeq(sorted, P) {
    var seq = slotCells(sorted, sorted.length, true), mi = -1;
    for (var i = 0; i < seq.length; i++) if (seq[i].id === (P.dyn && P.dyn.main)) mi = i;
    if (seq.length >= 3 && mi > 0) { var m = seq[mi]; seq[mi] = seq[0]; seq[0] = m; }
    return seq;
  }
  /** wave2 WP-4 (F.3): how many cells the dynamic template has for this program (0 = not dynamic): the tiles SHOWN - av-sync's
   *  delayed view may hold fewer or more than dyn.n for a moment. */
  function dynCount(P) { return P && P.dyn && P.src.length >= 1 && P.src.length <= 9 ? P.src.length : 0; }
  // wave2 WP-4 (F.4): a veiled speaker's COVER tile ({kind: "cover", id, name: frog name | null, hood 0-7, veil}): the hooded
  // frog on its hood colour, "<frog name or someone> · incognito / hidden", the mic ring - never a cam, a still, ⚑ or 📌. ✕
  // only with ex: 1, Reveal only with rv: 1 (WP-2's window.PATVReveal.tile), "this is you" with self: 1.
  var isCover = function (s) { return !!s && s.kind === 'cover'; };
  // 1.99aid (privacy controls S5): an incognito person's CAM under their frog name ({kind: "cam", veil: "incognito", hood, id
  // "anon-<8 hex>"}) - live / still like any cam tile, but its cards show the peek hood (never initials or an avatar), its label
  // "<frog name> · incognito"; ✕ and Reveal as on a cover ({tile}, ex / rv only); no 📌
  var isVeiledCam = function (s) { return !!s && s.kind === 'cam' && s.veil === 'incognito'; };
  var veilOf = function (s) { return s && s.veil === 'hidden' ? 'hidden' : 'incognito'; };
  var hoodOf = function (s) { var h = s && Number(s.hood); return h >= 0 && h <= 7 && Math.floor(h) === h ? h : 0; };
  function veilText(s) { return veilOf(s) === 'hidden' ? _t('js.pad.veil.hidden', 'hidden') : _t('js.pad.veil.incognito', 'incognito'); }
  /** How a tile is named in labels and announcements (a cover without a frog name is "someone"). */
  function labelOf(s) {
    if (!isCover(s)) return String((s && s.name) || '');
    return (typeof s.name === 'string' && s.name ? s.name.slice(0, 40) : _t('js.stage.mf.cover_someone', 'someone'));
  }
  // 1.99ahq stage cover (stagecover.js): a NAMED tile's picture while it has no live one - {url, k} from the program's avatar + ck
  // (k: gtf | photo | sticker | upload - how the card draws it), or null = the letter. Never on a cover (a veiled speaker keeps the
  // hood), on a tile this viewer reported ("hidden for you") or one blocked for them here.
  var CKS = ['gtf', 'photo', 'sticker', 'upload'];
  function coverPic(s) {
    if (!s || isCover(s) || s.watch === 'hidden' || s.watch === 'blocked') return null;
    if (typeof s.avatar !== 'string' || !/^(https:\/\/|\/)[^\s"'<>()\\]+$/.test(s.avatar) || /^\/\//.test(s.avatar)) return null;
    return { url: s.avatar, k: CKS.indexOf(s.ck) >= 0 ? s.ck : 'photo' };
  }
  var REASONS = ['impersonation', 'sexual', 'abuse', 'minor', 'other'];
  function reasonText(r) {
    return r === 'impersonation' ? _t('js.stage.mf.r_impersonation', 'Not who they say they are') : r === 'sexual' ? _t('js.stage.mf.r_sexual', 'Nudity or sexual')
      : r === 'abuse' ? _t('js.stage.mf.r_abuse', 'Harassment or hate') : r === 'minor' ? _t('js.stage.mf.r_minor', 'May be under 18') : _t('js.stage.mf.r_other', 'Something else');
  }
  /** The reason a tile shows a card, as words. */
  function cardText(s) {
    if (s.watch === 'hidden') return _t('js.stage.mf.hidden', 'hidden for you (you reported it)');
    if (s.watch === 'members_only') return _t('js.stage.mf.members_only', 'only for members');
    if (s.watch === 'unavailable') return _t('js.stage.mf.unavailable', 'isn\'t available');
    if (s.watch === 'blocked') return _t('js.stage.mf.blocked_tile', 'blocked for you here');
    if (s.video === 'starting') return _t('js.stage.mf.starting', 'cam starting…');
    if (s.why === 'off_cam') return _t('js.stage.mf.cam_off', 'cam off');
    // 1.99afl (S4): "couldn't open" is only Pepe's refusal; his relay being offline, the room's list he can't read (S3) and a
    // cam the roster can't classify yet (S2) each say so
    if (s.why === 'failed') return _t('js.stage.mf.failed', 'Pepe couldn\'t open their cam');
    if (s.why === 'pepe') return _t('js.stage.mf.pepe_off', 'Pepe\'s cam relay is offline');
    if (s.why === 'list_unread') return _t('js.stage.mf.list_unread', 'Pepe can\'t read this room\'s people list right now');
    if (s.why === 'cam_unknown') return _t('js.stage.mf.cam_unknown', 'checking their cam…');
    // mfix: why there's no picture - not always "full"
    if (s.why === 'retry') return _t('js.stage.mf.retry', 'trying their cam again in a moment…');
    if (s.why === 'cold_off') return _t('js.stage.mf.cold_off', 'only cams already live show here right now');
    if (s.why === 'rate') return _t('js.stage.mf.rate', 'a lot of cams opened just now - this one is next');
    if (s.why === 'pool') return _t('js.stage.mf.pool', 'Pepe\'s cams are all busy right now');
    if (s.why === 'pad_cap') return _t('js.stage.mf.pad_cap', 'this stage\'s live cams are all in use');
    return _t('js.stage.mf.full', 'live cams are full right now');
  }
  /** 1.99afl (S4): the reason code a card shows (the tile's data-why). */
  function cardWhy(s) {
    if (s.watch && s.watch !== 'ok') return 'watch_' + s.watch;
    if (s.video === 'starting') return 'starting';
    return /^[a-z_]{1,24}$/.test(String(s.why || '')) ? s.why : 'full';
  }

  function render(host, program, ctx) {
    ctx = ctx || {};
    var slug = String(ctx.slug || '');
    var base = '/api/rooms/' + encodeURIComponent(slug) + '/micfollow';
    var P = cleanProgram(program) || { src: [], count: 0, layout: 'single' };
    var stopped = false, dark = false, hideTimer = null;
    var box = el('div', 'mf-stage'); box.setAttribute('role', 'group');
    var grid = el('div', 'mf-grid');
    var note = el('div', 'mf-note');
    var tapAll = btn('mf-tapall', _t('js.pad.strip.tap', '▶ Tap to play')); tapAll.hidden = true;
    var say = el('div', 'mf-sr-only'); say.setAttribute('aria-live', 'polite'); say.setAttribute('role', 'status');
    // the neutral card (DF-30 / DF-12): no name, no avatar - nobody is singled out while someone nobody can show speaks
    var neutral = el('div', 'mf-neutral'); neutral.hidden = true; neutral.setAttribute('role', 'status');
    var nIcon = el('span', 'mf-av', '🎙'), nText = el('span', 'mf-why');
    nIcon.setAttribute('aria-hidden', 'true'); neutral.appendChild(nIcon); neutral.appendChild(nText);
    // mfix: tiles kept up while someone nobody can show (or Pepe) talks - dimmed, and this strip says who speaks
    var strip = el('div', 'mf-strip'); strip.hidden = true; strip.setAttribute('role', 'status');
    box.appendChild(grid); box.appendChild(strip); box.appendChild(neutral); box.appendChild(note); box.appendChild(tapAll); box.appendChild(say);
    // the bar ABOVE the tiles: ⋯ Manage + 🧹 Clear the stage (owners / staff); ⚑ Report (viewers, on narrow grids)
    var bar = el('div', 'mf-bar');
    var mBtn = btn('mf-mbtn', '⋯', _t('js.stage.mf.manage', 'Manage the mic stage'));
    mBtn.setAttribute('aria-expanded', 'false'); mBtn.hidden = true;
    var clearBtn = btn('mf-bbtn mf-clear', _t('js.stage.mf.clear', '🧹 Clear the stage'), _t('js.stage.mf.clear_aria', 'Clear the mic stage now (and freeze it)'));
    clearBtn.hidden = true;
    var rBtn = btn('mf-bbtn mf-rbtn', _t('js.stage.mf.report_list', '⚑ Report'), _t('js.stage.mf.report_list_aria', 'Report someone on the mic stage'));
    rBtn.hidden = true; rBtn.setAttribute('aria-expanded', 'false');
    var bmsg = el('span', 'mf-bmsg'); bmsg.setAttribute('role', 'status');
    bar.appendChild(mBtn); bar.appendChild(clearBtn); bar.appendChild(rBtn); bar.appendChild(bmsg);
    // ⚑ the report panel (viewers): who, then why
    var rpanel = el('div', 'mf-panel mf-rpanel'); rpanel.hidden = true; rpanel.setAttribute('role', 'dialog');
    rpanel.setAttribute('aria-label', _t('js.stage.mf.report_list_aria', 'Report someone on the mic stage'));
    var panel = el('div', 'mf-panel'); panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', _t('js.stage.mf.manage', 'Manage the mic stage'));
    var freeze = btn('mf-pbtn', ''), layoutSel = el('select', 'mf-layout'), people = el('ul', 'mf-people'), ask = el('div', 'mf-ask'), pmsg = el('p', 'mf-pmsg');
    layoutSel.setAttribute('aria-label', _t('js.stage.mf.layout', 'Layout'));
    [['', _t('js.stage.mf.layout_pad', 'The pad\'s setting')], ['auto', _t('js.stage.mf.layout_auto', 'Auto (by how many are on the mic)')],
     ['single', _t('js.stage.mf.layout_single', 'Newest speaker only')], ['split', _t('js.stage.mf.layout_split', 'Side by side')],
     ['grid', _t('js.stage.mf.layout_grid', 'Grid')], ['pip', _t('js.stage.mf.layout_pip', 'Picture in picture')]].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; layoutSel.appendChild(op);
    });
    // wave2 WP-4 (F.3): "Dynamic" - only while the site offers it (program.manage.dyn_ok; paintPanel adds / removes it)
    var dynOpt = el('option', null, _t('js.stage.mf.layout_dynamic', 'Dynamic (fits the speakers)')); dynOpt.value = 'dynamic';
    ask.hidden = true; pmsg.setAttribute('role', 'status');
    // mfix: 📌 Pin a cam - who's on cam in the room, and a Pin / Unpin for each (the server says who can't be pinned, never why)
    var pinBtn = btn('mf-pbtn', _t('js.stage.mf.pin_open', '📌 Pin a cam…')); pinBtn.setAttribute('aria-expanded', 'false');
    var pinPanel = el('div', 'mf-pins'); pinPanel.hidden = true;
    var pinList = el('ul', 'mf-people'); pinPanel.appendChild(pinList);
    pinBtn.addEventListener('click', function () {
      pinPanel.hidden = !pinPanel.hidden;
      pinBtn.setAttribute('aria-expanded', pinPanel.hidden ? 'false' : 'true');
      if (!pinPanel.hidden) loadPins();
    });
    panel.appendChild(freeze); panel.appendChild(layoutSel); panel.appendChild(pinBtn); panel.appendChild(pinPanel); panel.appendChild(people); panel.appendChild(ask); panel.appendChild(pmsg);
    box.appendChild(bar); box.appendChild(panel); box.appendChild(rpanel);
    host.appendChild(box);

    var tiles = Object.create(null);    // id -> tile (no prototype: an id is a login)
    // ── screen readers: who came on / left, at most one line every 5 s ──
    var pending = [], sayAt = 0, sayTimer = null;
    function announce(line) {
      pending.push(line);
      if (sayTimer) return;
      var wait = Math.max(0, sayAt + SAY_GAP - Date.now());
      sayTimer = setTimeout(function () {
        sayTimer = null; sayAt = Date.now();
        say.textContent = pending.length > 1 ? _t('js.stage.mf.changed_n', '{n} people changed on the mic stage', { n: pending.length }) : pending[0];
        pending = [];
      }, wait);
    }

    function tile(s) {
      var t = { id: s.id, s: s, mode: null, gen: 0, sess: null, beat: null, still: null, failedAt: 0, failText: '', retry: null };
      var e = el('div', 'mf-tile'); e.setAttribute('data-id', s.id); e.setAttribute('role', 'group');   // (a role, so its aria-label is read)
      var v = el('video', 'rtc-video'); v.muted = true; v.autoplay = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
      var img = el('img', 'mf-still'); img.alt = ''; img.hidden = true;
      var card = el('div', 'mf-card'), av = el('span', 'mf-av'), avImg = el('img'), avTxt = el('span', 'mf-avt'), reason = el('span', 'mf-why');
      avImg.alt = ''; avImg.hidden = true; av.appendChild(avImg); av.appendChild(avTxt); card.appendChild(av); card.appendChild(reason);
      avImg.setAttribute('decoding', 'async'); avImg.setAttribute('referrerpolicy', 'no-referrer');   // 1.99ahq: (a photo may be on another host)
      var label = el('div', 'mf-label'), name = el('span', 'mf-name'), mic = el('span', 'mf-mic', '🎙'), tag = el('span', 'mf-tag'), sr = el('span', 'mf-sr-only');
      mic.setAttribute('aria-hidden', 'true');
      // mfix: 📌 on a pinned cam's label (its place is fixed: hand-overs and new speakers never move it)
      var pinTag = el('span', 'mf-pin', '📌'); pinTag.hidden = true; pinTag.setAttribute('title', _t('js.stage.mf.pinned_tag', 'pinned'));
      var pinSr = el('span', 'mf-sr-only');
      label.appendChild(mic); label.appendChild(pinTag); label.appendChild(name); label.appendChild(tag); label.appendChild(pinSr); label.appendChild(sr);
      var x = btn('mf-x', '✕');
      var rp = btn('mf-x mf-rp', _t('js.stage.mf.report', '⚑'));            // ⚑ viewers (owners have ✕)
      var pn = btn('mf-x mf-pn', '📌'); pn.hidden = true;                      // mfix: owners - pin this person here
      var off = btn('mf-off', _t('js.stage.mf.take_off', '🙈 Take me off')); off.hidden = true;   // mfix: the viewer's OWN cam
      // wave2 WP-4 (F.4): the cover's hooded frog, its Reveal (rv: 1 only) and the "this is you" / revealed chips
      var hoodImg = el('img', 'mf-hood'); hoodImg.alt = ''; hoodImg.hidden = true; hoodImg.setAttribute('aria-hidden', 'true');
      var rv = btn('mf-rv', _t('js.stage.mf.reveal', 'Reveal'), _t('js.stage.mf.reveal_aria', 'Reveal who this is (only you see it; it is logged)')); rv.hidden = true;
      var chip = el('span', 'mf-chip'); chip.hidden = true;
      // 1.99aid (privacy controls S4): "👁 View cam" on a cover whose cam is on but hidden (cv: 1 - a moderator, camreveal.js): the
      // cam for this viewer alone, logged (cam-reveal.js, loaded on first use by pad-livecam.js's PATVCamRevealOpen)
      var cvb = btn('mf-rv mf-cv', _t('js.camrv.tile', '👁 View cam'), _t('js.camrv.tile_aria', 'View this hidden cam for moderation (only you see it; it is logged)')); cvb.hidden = true;
      e.appendChild(v); e.appendChild(img); e.appendChild(hoodImg); e.appendChild(card); e.appendChild(label); e.appendChild(chip); e.appendChild(x); e.appendChild(rp); e.appendChild(pn);
      e.appendChild(off); e.appendChild(rv); e.appendChild(cvb);
      t.el = e; t.video = v;
      // 1.99ain: the corner buttons (⚑ / 📌 / ✕) are hidden until the tile is hovered or focused (webrtc.css); on a touch
      // screen a tap on the tile shows them for 4 s - the hidden buttons take no taps, so that first tap lands here
      var toolsT = 0;
      e.addEventListener('pointerup', function (ev) {
        if (ev.pointerType !== 'touch' && ev.pointerType !== 'pen') return;
        e.classList.add('mf-tools');
        clearTimeout(toolsT);
        toolsT = setTimeout(function () { e.classList.remove('mf-tools'); }, 4000);
      });
      x.addEventListener('click', function () { if (t.s && t.s.pin) pinPost(t.s.id, true); else askExclude(t.s); });
      rv.addEventListener('click', function () { revealTile(t, rv); });
      cvb.addEventListener('click', function () {
        if (t.s && isCover(t.s) && t.s.cv === 1 && typeof window.PATVCamRevealOpen === 'function') window.PATVCamRevealOpen({ slug: slug, tile: t.s.id, name: labelOf(t.s) });
      });
      rp.addEventListener('click', function () { askReport(t.s, rp); });
      pn.addEventListener('click', function () { pn.disabled = true; pinPost(t.s.id, false).then(function () { pn.disabled = false; }); });
      off.addEventListener('click', function () { takeOff(off); });
      /** the watch route's body: a pinned cam's ticket comes through its pin */
      function wb(extra) { var b = { login: t.id }; if (t.s && t.s.pin) b.pin = true; for (var k in extra) b[k] = extra[k]; return b; }
      function stopLive(tell) {
        t.gen++; clearInterval(t.beat); t.beat = null;
        if (t.sess) { try { t.sess.close(); } catch (er) { /* gone */ } t.sess = null; }
        try { v.srcObject = null; } catch (er) { /* gone */ }
        if (tell) post(base + '/watch', wb({ stop: true }), true).catch(function () {});
      }
      function stopStill() { clearInterval(t.still); t.still = null; img.hidden = true; img.removeAttribute('src'); }
      /** 1.99ahq stage cover: the card's picture (the person's GTF avatar by default - stagecover.js), or the letter (pic null). The
       *  src is set only when it CHANGES (every cover URL is immutable), so a program update never re-fetches it; a picture that
       *  fails to load falls back to the letter until a different one comes (review fix 3: or COVER_RETRY_MS passes). Decorative
       *  (alt ""): the name is in the label. */
      function setCover(pic) {
        var url = pic ? pic.url : '';
        if (url && url === t.coverBad) url = '';
        card.classList.toggle('cov', !!url);
        for (var i = 0; i < CKS.length; i++) card.classList.toggle('cv-' + CKS[i], !!url && pic.k === CKS[i]);
        if (url) {
          if (avImg.getAttribute('src') !== url) avImg.src = url;
          avImg.hidden = false; avTxt.hidden = true;
        } else {
          if (avImg.hasAttribute('src')) avImg.removeAttribute('src');
          avImg.hidden = true; avTxt.hidden = false;
        }
      }
      avImg.addEventListener('error', function () {
        var bad = avImg.getAttribute('src');
        if (!bad) return;
        t.coverBad = bad;
        setCover(null);
        // 1.99ahq review fix 3 (FID-3): not for good - the same URL is tried again after COVER_RETRY_MS (a proxied photo's URL never
        // changes, and a capture draws the photo again once the site fetches it again); a program update meanwhile keeps the letter
        clearTimeout(t.coverRetry);
        t.coverRetry = setTimeout(function () {
          t.coverRetry = null;
          if (t.coverBad !== bad) return;
          t.coverBad = null;
          if (t.s) setCover(coverPic(t.s));
        }, COVER_RETRY_MS);
      });
      /** 1.99afl (S4): the tile's data-why - why it shows a card (none while it has a picture). */
      function setWhy(w) { if (w) e.setAttribute('data-why', String(w)); else e.removeAttribute('data-why'); }
      function showCard(text) {
        card.hidden = false; v.hidden = true; img.hidden = true;
        reason.textContent = text || '';
        // 1.99ahq stage cover review fix (UX-1): a cover card's reason is at most 2 lines under the picture - its whole text here
        if (text) reason.setAttribute('title', text); else reason.removeAttribute('title');
        tag.textContent = '';
      }
      /** A live picture didn't work out: a card with the reason, and one more try after RETRY_MS (unless it's for good).
       *  why (1.99afl): its data-why code. */
      function failed(text, forGood, why) {
        t.failedAt = Date.now(); t.failText = text || ''; t.failWhy = why || 'failed'; t.mode = 'card';
        setWhy(t.failWhy);
        showCard(t.failText);
        clearTimeout(t.retry); t.retry = null;
        if (!forGood) t.retry = setTimeout(function () { t.retry = null; if (!stopped && tiles[t.id] === t) apply(t.s); }, RETRY_MS + 50);
      }
      /** 1.99ahn: the first card of a start - "resuming…" when the tile comes back from a hidden tab's pause (t.resume) */
      function startText() {
        var back = t.resuming; t.resuming = false;
        return back ? _t('js.stage.mf.resuming', 'resuming…') : _t('js.stage.mf.starting', 'cam starting…');
      }
      function startLive() {
        var my = ++t.gen;
        showCard(startText());
        if (!window.RTCPeerConnection || !window.PATVRtc || !PATVRtc.watch) { failed(_t('js.pad.live.err_browser', 'This browser can\'t play live cams.'), true); return; }
        post(base + '/watch', wb({})).then(function (d) {
          if (my !== t.gen) return;
          if (!d || !d.ok || !d.whep) {
            failed(d && d.code === 'budget' ? _t('js.stage.mf.full', 'live cams are full right now') : d && d.code === 'members_only' ? _t('js.stage.mf.members_only', 'only for members')
              : d && d.code === 'unavailable' ? _t('js.stage.mf.unavailable', 'isn\'t available') : d && d.state === 'ended' ? _t('js.stage.mf.starting', 'cam starting…')
              : window.PATVLiveCam && PATVLiveCam.why ? PATVLiveCam.why(d && d.code, d && d.error) : _t('js.stage.mf.failed', 'Pepe couldn\'t open their cam'),
              !!(d && (d.code === 'members_only' || d.code === 'unavailable' || d.code === 'blocked' || d.code === 'pad_access' || d.code === 'prime')),
              'watch_' + (d && /^[a-z_]{1,24}$/.test(String(d.code || '')) ? d.code : d && d.state === 'ended' ? 'ended' : 'failed'));
            return;
          }
          t.beat = setInterval(function () {
            post(base + '/watch', wb({ beat: true })).then(function (k) {
              if (my !== t.gen) return;
              if (k && (k.ok === false || k.state === 'ended')) { stopLive(false); failed(cardText(t.s), false, cardWhy(t.s)); }
            }).catch(function () { /* a blip: the next beat */ });
          }, BEAT_MS);
          return PATVRtc.watch(d.whep, v, { timeout: 40000, cancelled: function () { return my !== t.gen; } }).then(function (ss) { playing(ss, my); });
        // 1.99afl (S4): the server gave a ticket but this browser couldn't connect to the video (WHEP / ICE) - not Pepe's refusal
        }).catch(function (er) { if (my === t.gen && !(er && er.cancelled)) { stopLive(true); failed(_t('js.stage.mf.connect', 'couldn\'t connect to the live video'), false, 'connect'); } });
      }
      function playing(ss, my) {
        if (my !== t.gen) { ss.close(); return; }
        t.sess = ss; t.failedAt = 0;
        setWhy(null);
        card.hidden = true; v.hidden = false;
        v.setAttribute('aria-label', _t('js.pad.live.aria', '{name}\'s cam, live', { name: t.s.name }));
        if (ss.blocked) tapAll.hidden = false;
        ss.onfail = function () { if (my === t.gen) rewatch(my); };
      }
      // mfix review: the connection dropped after it played (Pepe re-opened the relay, its publisher restarted): watch again at once
      // with a fresh ticket while the tile is still live (the route says no otherwise) - no "couldn't open" card for a short
      // reconnect; at most REWATCH_MAX times in REWATCH_WIN_MS, then the card and the usual retry
      function rewatch(my) {
        var t0 = Date.now();
        t.rew = (t.rew || []).filter(function (x) { return t0 - x < REWATCH_WIN_MS; });
        // 1.99afl (S4): the reconnects are used up - the video kept dropping (not a refused open)
        var give = function () { if (my === t.gen) { stopLive(true); failed(_t('js.stage.mf.dropping', 'the live video kept dropping'), false, 'dropping'); } };
        if (t.rew.length >= REWATCH_MAX) return give();
        t.rew.push(t0);
        if (t.sess) { try { t.sess.close(); } catch (er) { /* gone */ } t.sess = null; }
        showCard(_t('js.stage.mf.reconnecting', 'reconnecting…'));
        post(base + '/watch', wb({})).then(function (d) {
          if (my !== t.gen) return null;
          if (!d || !d.ok || !d.whep) { stopLive(true); failed(cardText(t.s), false, cardWhy(t.s)); return null; }
          return PATVRtc.watch(d.whep, v, { timeout: 40000, cancelled: function () { return my !== t.gen; } }).then(function (ss) { playing(ss, my); },
            function (er) { if (!(er && er.cancelled)) give(); });
        }).catch(give);
      }
      function startStill() {
        stopStill();
        showCard(startText());
        var waits = 0, gen = t.gen;
        var load = function () {
          getJson(base + '/still/' + encodeURIComponent(t.id)).then(function (d) {
            if (t.mode !== 'still' || gen !== t.gen) return;
            if (d && d.state === 'ok' && typeof d.img === 'string' && d.img.indexOf('data:image/jpeg;base64,') === 0) {
              waits = 0;
              setWhy(null);
              img.src = d.img; img.hidden = false; card.hidden = true; v.hidden = true;
              img.alt = _t('js.stage.mf.still_alt', '{name}\'s cam, a still', { name: t.s.name });
              tag.textContent = _t('js.stage.mf.still', '📷 still');
              return;
            }
            // no picture: say why on the card instead of "starting" for ever
            if (d && d.ok === false) {
              var forGood = d.code === 'members_only' || d.code === 'unavailable' || d.code === 'blocked' || d.code === 'pad_access' || d.code === 'prime' || d.code === 'signin';
              setWhy('still_' + (/^[a-z_]{1,24}$/.test(String(d.code || '')) ? d.code : 'refused'));
              showCard(d.code === 'members_only' ? _t('js.stage.mf.members_only', 'only for members') : d.code === 'blocked' ? _t('js.stage.mf.blocked_tile', 'blocked for you here')
                : d.code === 'rate' ? _t('js.stage.mf.starting', 'cam starting…') : _t('js.stage.mf.unavailable', 'isn\'t available'));
              if (forGood) { clearInterval(t.still); t.still = null; }
              return;
            }
            if (d && d.state === 'pending' && ++waits < 2) return;          // Pepe is on it (one more round)
            if (d && (d.state === 'pending' || d.state === 'refused' || d.state === 'none') && img.hidden) { setWhy('still_' + d.state); showCard(_t('js.stage.mf.unavailable', 'isn\'t available')); }
          }).catch(function () { /* the next round */ });
        };
        load();
        t.still = setInterval(load, (P.still_s || 20) * 1000);
      }
      /** wave2 WP-4 (F.4): a cover tile - no video, no still, no card; the hood on its colour. -> true when s is a cover */
      function coverApply(s) {
        var cover = isCover(s);
        e.classList.toggle('mf-cover', cover);
        if (!cover) {
          e.removeAttribute('data-hood'); e.removeAttribute('data-veil');
          hoodImg.hidden = true; rv.hidden = true; chip.hidden = true; cvb.hidden = true; e.classList.remove('revealed');
          if (!isVeiledCam(s)) { t.revealed = null; t.revealedBy = null; t.autoId = null; }   // (1.99aid S5: a veiled cam keeps its Reveal - apply())
          return false;
        }
        if (t.mode === 'live') stopLive(true);
        if (t.mode === 'still') stopStill();
        clearTimeout(t.retry); t.retry = null;
        t.mode = 'cover';
        setCover(null);                                // 1.99ahq: a veiled speaker never carries a stage cover (only the hood)
        var hood = hoodOf(s), veil = veilOf(s), nm = labelOf(s);
        e.setAttribute('data-hood', String(hood)); e.setAttribute('data-veil', veil);
        hoodImg.src = '/public/img/anon/hood-' + (veil === 'hidden' ? 'shadow' : 'peek') + '-' + hood + '.svg';
        hoodImg.hidden = false; v.hidden = true; img.hidden = true; card.hidden = true;
        name.textContent = (tightNames() ? short(nm) : nm) + ' · ' + veilText(s);
        name.className = 'mf-name'; name.style.cssText = '';
        tag.textContent = '';
        e.setAttribute('aria-label', _t('js.stage.mf.cover_aria', '{name}, {veil}, on the mic', { name: nm, veil: veilText(s) }));
        e.classList.toggle('newest', !!s.newest);
        e.classList.toggle('pinned', false);
        e.classList.toggle('recent', !!s.recent);
        e.classList.toggle('ring', !!s.ring);
        pinTag.hidden = true; pinSr.textContent = '';
        if (s.newest) { e.setAttribute('aria-current', 'true'); sr.textContent = ', ' + _t('js.stage.mf.newest', 'newest speaker'); }
        else { e.removeAttribute('aria-current'); sr.textContent = ''; }
        setWhy('cover');
        // members never get a button on a cover; ✕ (a manager who may exclude it without seeing who) and Reveal only when the
        // server says so (WP-2 - see micfollow.coverFlags)
        rp.hidden = true; pn.hidden = true; off.hidden = true;
        x.textContent = '✕';
        x.setAttribute('aria-label', _t('js.stage.mf.exclude_cover_q', 'Keep this veiled speaker off the mic stage'));
        x.hidden = !(P.manage && s.ex === 1);
        rv.hidden = !(s.rv === 1 && window.PATVReveal && typeof window.PATVReveal.tile === 'function') || !!t.revealed;
        cvb.hidden = !(s.cv === 1 && typeof window.PATVCamRevealOpen === 'function');   // 1.99aid (privacy controls S4)
        var me = s.self === 1;
        chip.hidden = !(me || t.revealed);
        chip.textContent = t.revealed ? _t('js.stage.mf.revealed', '{login} · only you can see this', { login: t.revealed }) : me ? _t('js.stage.mf.cover_self', 'this is you') : '';
        e.classList.toggle('revealed', !!t.revealed);
        if (s.rv === 1) autoReveal(t, s);              // wave 2 (J-18): "Show real names" on -> it reveals itself
        return true;
      }
      function apply(s) {
        if (t.s && (isCover(t.s) || isVeiledCam(t.s)) && (!(isCover(s) || isVeiledCam(s)) || t.s.id !== s.id)) { t.revealed = null; t.revealedBy = null; }
        t.s = s;
        if (coverApply(s)) return;
        var vc = isVeiledCam(s);
        name.textContent = vc ? (tightNames() ? short(labelOf(s)) : labelOf(s)) + ' · ' + veilText(s) : tightNames() ? short(s.name) : s.name;
        name.className = 'mf-name' + (s.nameCss && !vc ? ' cx-name' : '');
        name.style.cssText = vc ? '' : s.nameCss || '';
        e.setAttribute('aria-label', vc ? _t('js.stage.mf.cover_aria', '{name}, {veil}, on the mic', { name: labelOf(s), veil: veilText(s) }) : s.name);
        e.classList.toggle('mf-vcam', vc);
        e.classList.toggle('newest', !!s.newest);
        // mfix: pinned / recent (let go of the mic a moment ago - no ring) / the viewer's own cam
        e.classList.toggle('pinned', !!s.pin);
        e.classList.toggle('recent', !!s.recent);
        e.classList.toggle('ring', !!s.ring);                              // wave2 WP-4 (F.3): every current holder (dynamic)
        pinTag.hidden = !s.pin;
        pinSr.textContent = s.pin ? ', ' + _t('js.stage.mf.pinned_tag', 'pinned') : '';
        pn.hidden = !P.manage || !!s.pin || !pinsFree();
        pn.setAttribute('aria-label', _t('js.stage.mf.pin_q', 'Pin {name} on the mic stage', { name: s.name }));
        off.hidden = s.mine !== true;
        off.setAttribute('aria-label', _t('js.stage.mf.take_off_aria', 'Take my cam off this pad\'s stage'));
        if (s.newest) { e.setAttribute('aria-current', 'true'); sr.textContent = ', ' + _t('js.stage.mf.newest', 'newest speaker'); }
        else { e.removeAttribute('aria-current'); sr.textContent = ''; }
        // (1.99aid privacy controls S5: a veiled cam's card picture is its peek hood - never initials, an avatar or a 1.99ahq cover)
        avTxt.textContent = vc ? '' : initials(s.name);
        if (vc) {
          card.classList.remove('cov');
          for (var ci = 0; ci < CKS.length; ci++) card.classList.remove('cv-' + CKS[ci]);
          var hood = '/public/img/anon/hood-peek-' + hoodOf(s) + '.svg';
          if (avImg.getAttribute('src') !== hood) avImg.src = hood;
          avImg.hidden = false; avTxt.hidden = true;
        } else setCover(coverPic(s));
        x.textContent = s.pin ? '📌✕' : '✕';
        x.setAttribute('aria-label', s.pin ? _t('js.stage.mf.unpin_q', 'Unpin {name}', { name: s.name }) : vc ? _t('js.stage.mf.exclude_cover_q', 'Keep this veiled speaker off the mic stage')
          : _t('js.stage.mf.exclude_q', 'Keep {name} off the mic stage', { name: s.name }));
        x.hidden = vc ? !(P.manage && s.ex === 1) : !P.manage;
        if (vc) {
          pn.hidden = true;
          rv.hidden = !(s.rv === 1 && window.PATVReveal && typeof window.PATVReveal.tile === 'function') || !!t.revealed;
          chip.hidden = !(s.self === 1 || t.revealed);
          chip.textContent = t.revealed ? _t('js.stage.mf.revealed', '{login} · only you can see this', { login: t.revealed }) : s.self === 1 ? _t('js.stage.mf.cover_self', 'this is you') : '';
          e.classList.toggle('revealed', !!t.revealed);
        } else { rv.hidden = true; chip.hidden = true; e.classList.remove('revealed'); }
        rp.setAttribute('aria-label', _t('js.stage.mf.report_aria', 'Report {name}', { name: s.name }));
        rp.hidden = !P.report || !!P.manage || s.watch === 'hidden';
        var want = s.watch !== 'ok' ? 'card' : s.video === 'live' ? 'live' : s.video === 'still' ? 'still' : 'card';
        if ((want === 'live' || want === 'still') && dark) want = 'paused';           // a hidden tab: no video, no still polling
        var held = want === 'live' && t.mode !== 'live' && t.failedAt && Date.now() - t.failedAt < RETRY_MS;   // a failed one waits a moment
        if (held) want = 'card';
        else if (want !== 'live') t.failedAt = 0;
        var text = held ? t.failText : cardText(s);
        if (want === 'card') setWhy(held ? t.failWhy : cardWhy(s));          // 1.99afl (S4): data-why
        else if (want === 'paused') setWhy(null);
        if (want !== t.mode) {
          if (t.mode === 'live') stopLive(true);
          if (t.mode === 'still') stopStill();
          t.mode = want;
          if (want !== 'paused') t.shown = false;                         // 1.99ahn (review UX-2): a card meanwhile - it starts over
          if (want === 'live') { setWhy('starting'); startLive(); }
          else if (want === 'still') { setWhy('starting'); startStill(); }
          else showCard(want === 'paused' ? '' : text);
        } else if (want === 'card') showCard(text);
      }
      t.apply = apply;
      t.stop = function (tell) { clearTimeout(t.retry); t.retry = null; clearTimeout(t.coverRetry); t.coverRetry = null; if (t.mode === 'live') stopLive(tell); stopStill(); t.mode = null; };
      // 1.99ahn (review UX-2): "resuming…" only for a tile whose picture this pause took away (t.shown: it had a live picture or a
      // still on screen) - a tile that was still "cam starting…", or that came on (or went live) while the tab was hidden, starts
      t.pause = function () {
        if (t.mode === 'live') { t.shown = card.hidden; stopLive(true); t.mode = 'paused'; }
        else if (t.mode === 'still') { t.shown = card.hidden; stopStill(); t.mode = 'paused'; }
      };
      t.resume = function () { if (t.mode === 'paused') { t.mode = null; t.resuming = !!t.shown; t.shown = false; apply(t.s); t.resuming = false; } };
      apply(s);
      return t;
    }

    /** wave2 WP-4 (F.4): Reveal on a cover (rv: 1 - a see-through role; WP-2's client does the asking and the logging):
     *  window.PATVReveal.tile(slug, id) -> Promise<{ok, login}>. Only this viewer sees the answer: a dashed edge and
     *  "{login} · only you can see this" on the tile while it stays up. */
    function revealTile(t, b) {
      if (!t.s || !(isCover(t.s) || isVeiledCam(t.s)) || t.s.rv !== 1 || !window.PATVReveal || typeof window.PATVReveal.tile !== 'function') return;
      b.disabled = true;
      Promise.resolve().then(function () { return window.PATVReveal.tile(slug, t.s.id); }).then(function (r) {
        b.disabled = false;
        if (r && r.ok && typeof r.login === 'string' && /^[\w.\-]{1,40}$/.test(r.login)) { t.revealed = r.login; t.revealedBy = 'click'; t.apply(t.s); }
        else bmsg.textContent = (r && typeof r.error === 'string' && r.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
      }, function () { b.disabled = false; bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    }
    /** wave 2 (owner J-18, spec E.1 / E.2): the viewer's "Show real names" toggle for this pad - window.PATVReveal (pad-reveal.js;
     *  the pad chat's bar turns it on / off). While it is on - or not known yet: the first ask finds out, a 409 says off - each cover
     *  with Reveal (rv: 1) reveals itself, once per cover id on this page, counted on the toggle's row on the server (never a row of
     *  its own). "Hide again" (off) hides what the toggle revealed; a Reveal pressed by hand stays until the cover leaves. A cover with
     *  Reveal also asks the pad chat to offer the toggle's bar (PATVReveal.offer). */
    function revealer() { var R = window.PATVReveal; return R && typeof R.tile === 'function' && typeof R.state === 'function' ? R : null; }
    var offered = false, unRev = null;
    function listenReveal(R) {
      if (unRev || typeof R.on !== 'function') return;
      unRev = R.on(function (on) {
        for (var id in tiles) {
          var t = tiles[id];
          if (!t.s || !isCover(t.s)) continue;
          if (on !== true && t.revealedBy === 'toggle') { t.revealed = null; t.revealedBy = null; }
          t.autoId = null;
          t.apply(t.s);
        }
      }) || function () {};
    }
    /** The pad chat's toggle bar, offered once - and (integration review T-3) only to a viewer who can turn it on: PATVReveal.can(),
     *  what the first ask learned (409 toggle_na = a stage role the toggle's rule refuses - their per-tile Reveal still works). */
    function offerBar(R) {
      if (offered || stopped || typeof R.offer !== 'function') return;
      if (typeof R.can === 'function' && R.can() !== true) return;
      offered = true;
      try { R.offer(); } catch (er) { /* the page's own */ }
    }
    function autoReveal(t, s) {
      var R = revealer();
      if (!R || stopped) return;
      listenReveal(R);
      offerBar(R);
      if (t.revealed || t.autoId === s.id || R.state() === false) return;
      var id = t.autoId = s.id;
      Promise.resolve().then(function () { return R.tile(slug, id, { toggle: true }); }).then(function (r) {
        offerBar(R);
        if (stopped || !t.s || !isCover(t.s) || t.s.id !== id || t.revealed) return;
        if (r && r.ok && typeof r.login === 'string' && /^[\w.\-]{1,40}$/.test(r.login)) { t.revealed = r.login; t.revealedBy = 'toggle'; t.apply(t.s); }
      }, function () { /* it stays a cover */ });
    }
    // ── mfix: 📌 pins (owners / staff) and 🙈 Take me off (the person shown) ──
    function pinCount() { var n = 0; P.src.forEach(function (s) { if (s && s.pin) n++; }); return n; }
    function pinsFree() { return !!(P.manage && Number(P.manage.pins_room) > pinCount()); }
    function pinPost(login, remove) {
      return post(base + '/pin', remove ? { login: login, remove: true } : { login: login }).then(function (d) {
        var m = d && d.ok ? (d.asked ? _t('js.stage.mf.pin_asked', 'Asked them - it goes up once they say OK.') : remove ? _t('js.stage.mf.unpinned', 'Unpinned.') : _t('js.stage.mf.pinned', 'Pinned.'))
          : (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
        bmsg.textContent = m; pmsg.textContent = m;
        if (!pinPanel.hidden) loadPins();
        if (ctx.onChange) { try { ctx.onChange(); } catch (er) { /* page's own */ } }
        return d;
      }).catch(function () { bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); return null; });
    }
    function takeOff(b) {
      var ok = typeof window.confirm === 'function' ? window.confirm(_t('js.stage.room.q_leave', 'Take your cam off this pad\'s Stage? This pad can\'t put it back for an hour.')) : true;
      if (!ok) return;
      b.disabled = true;
      fetch('/api/stage/leave', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ room: slug }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (j) {
          b.disabled = false;
          bmsg.textContent = j && j.ok ? _t('js.stage.mf.took_off', 'You\'re off this pad\'s stage for now.') : (j && j.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
          if (ctx.onChange) { try { ctx.onChange(); } catch (er) { /* page's own */ } }
        })
        .catch(function () { b.disabled = false; bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    }
    function pinState(c) {
      if (c.pinned) return _t('js.stage.mf.pin_s_pinned', 'pinned');
      if (c.blocked === 'opted_out') return _t('js.stage.mf.pin_s_opted_out', 'live video off');
      if (c.blocked === 'limited') return _t('js.stage.mf.pin_s_limited', 'cam only for some viewers');
      if (c.blocked) return _t('js.stage.mf.unavailable', 'isn\'t available');
      if (c.waiting) return _t('js.stage.mf.pin_s_waiting', 'waiting for their OK');
      if (c.ask) return _t('js.stage.mf.pin_s_ask', 'asks them first');
      return '';
    }
    function loadPins() {
      pinList.textContent = '';
      pinList.appendChild(el('li', 'mf-pmsg', '…'));
      getJson(base + '/pins').then(function (d) {
        pinList.textContent = '';
        if (!d || !d.ok) { pinList.appendChild(el('li', 'mf-pmsg', (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.'))); return; }
        var cams = Array.isArray(d.cams) ? d.cams : [];
        if (!cams.length) { pinList.appendChild(el('li', 'mf-pmsg', _t('js.stage.mf.pin_none', 'Nobody is on cam in the room right now.'))); return; }
        var full = (Array.isArray(d.pins) ? d.pins.length : 0) >= (Number(d.room) || 0);
        cams.forEach(function (c) {
          // (1.99aid privacy controls V-1: an incognito person's cam is listed by its opaque id + frog name - never a login)
          var key = c && c.veiled === true && typeof c.id === 'string' ? c.id : c && c.login;
          if (!c || typeof key !== 'string') return;
          var shown = String(c.display || (c.veiled ? _t('js.stage.mf.cover_someone', 'someone') : c.login));
          var li = el('li', null), nm = el('span', 'mf-pn-name', shown), st = el('span', 'mf-pn-state', pinState(c));
          li.appendChild(nm); li.appendChild(st);
          if (c.pinned) {
            var u = btn('mf-pbtn', _t('js.stage.mf.unpin', 'Unpin'), _t('js.stage.mf.unpin_q', 'Unpin {name}', { name: shown }));
            // (a veiled pin is unpinned from its tile's 📌✕ - its pin id isn't the list's id)
            if (c.veiled) u.hidden = true;
            u.addEventListener('click', function () { u.disabled = true; pinPost(key, true); });
            li.appendChild(u);
          } else if (!c.blocked && !c.waiting && !full) {
            var b = btn('mf-pbtn', c.ask ? _t('js.stage.mf.pin_ask', 'Ask to pin') : _t('js.stage.mf.pin', '📌 Pin'), _t('js.stage.mf.pin_q', 'Pin {name} on the mic stage', { name: shown }));
            b.addEventListener('click', function () { b.disabled = true; pinPost(key, false); });
            li.appendChild(b);
          }
          pinList.appendChild(li);
        });
        if (full) pinList.appendChild(el('li', 'mf-pmsg', _t('js.stage.mf.pin_full', 'No room for another pin - unpin one first.')));
      }).catch(function () { pinList.textContent = ''; pinList.appendChild(el('li', 'mf-pmsg', _t('js.stage.mf.e_do', 'Couldn\'t do that.'))); });
    }
    function askExclude(s) {
      if (!P.manage || !s) return;
      openPanel(true);
      ask.textContent = '';
      ask.hidden = false;
      // (wave2 WP-4: a cover - ex: 1 only - is kept off by its tile id; the server maps it, nobody sees who)
      ask.appendChild(el('p', null, isCover(s) || isVeiledCam(s) ? _t('js.stage.mf.exclude_cover_q', 'Keep this veiled speaker off the mic stage')
        : _t('js.stage.mf.exclude_q', 'Keep {name} off the mic stage', { name: s.name })));
      [[1, _t('js.stage.mf.exclude_1h', 'for 1 hour')], [24, _t('js.stage.mf.exclude_24h', 'for 24 hours')], [0, _t('js.stage.mf.exclude_always', 'always')]].forEach(function (o) {
        var b = btn('mf-pbtn danger', o[1]);
        b.addEventListener('click', function () {
          b.disabled = true;
          post(base + '/exclude', isCover(s) || isVeiledCam(s) ? { tile: s.id, hours: o[0] } : { login: s.id, hours: o[0] }).then(function (d) {
            pmsg.textContent = d && d.ok ? _t('js.stage.mf.excluded', 'Off the mic stage.') : (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
            ask.hidden = true; ask.textContent = '';
            if (ctx.onChange) { try { ctx.onChange(); } catch (er) { /* page's own */ } }
          }).catch(function () { pmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); b.disabled = false; });
        });
        ask.appendChild(b);
      });
      var no = btn('mf-pbtn', _t('js.stage.mf.cancel', 'Cancel'));
      no.addEventListener('click', function () { ask.hidden = true; ask.textContent = ''; });
      ask.appendChild(no);
      var first = ask.querySelector('button');
      if (first && first.focus) first.focus();
    }
    // ── ⚑ reports (viewers): the tile hides for this viewer at once; two qualified reporters take it off for everyone ──
    var rFocusBack = null;
    function closeReport() {
      if (rpanel.hidden) return;
      rpanel.hidden = true; rpanel.textContent = ''; rBtn.setAttribute('aria-expanded', 'false');
      if (rFocusBack && rFocusBack.focus) { try { rFocusBack.focus(); } catch (er) { /* gone */ } }
      rFocusBack = null;
    }
    function askReport(s, from) {
      if (!P.report || !s) return;
      openPanel(false);
      rFocusBack = from || null;
      rpanel.textContent = ''; rpanel.hidden = false; rBtn.setAttribute('aria-expanded', 'true');
      rpanel.appendChild(el('p', null, _t('js.stage.mf.report_q', 'Report {name}? Why:', { name: s.name })));
      REASONS.forEach(function (r) {
        var b = btn('mf-pbtn', reasonText(r));
        b.addEventListener('click', function () {
          b.disabled = true;
          post(base + '/report', { login: s.id, reason: r }).then(function (d) {
            closeReport();
            bmsg.textContent = d && d.ok ? _t('js.stage.mf.reported', 'Reported - it\'s hidden for you.') : (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
            var t = tiles[s.id];
            if (d && d.ok && t) { t.s.watch = 'hidden'; t.apply(t.s); }          // hidden at once (the next program says so too)
          }).catch(function () { b.disabled = false; bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
        });
        rpanel.appendChild(b);
      });
      var no = btn('mf-pbtn', _t('js.stage.mf.cancel', 'Cancel'));
      no.addEventListener('click', closeReport);
      rpanel.appendChild(no);
      var first = rpanel.querySelector('button');
      if (first && first.focus) { try { first.focus(); } catch (er) { /* none */ } }
    }
    /** ⚑ in the bar (narrow grids): pick who first. */
    function reportList() {
      openPanel(false);
      rFocusBack = rBtn;
      rpanel.textContent = ''; rpanel.hidden = false; rBtn.setAttribute('aria-expanded', 'true');
      P.src.forEach(function (s) {
        if (s.watch === 'hidden' || isCover(s)) return;            // (wave2 WP-4: a cover has nobody to report)
        var b = btn('mf-pbtn', '⚑ ' + s.name, _t('js.stage.mf.report_aria', 'Report {name}', { name: s.name }));
        b.addEventListener('click', function () { askReport(s, rBtn); });
        rpanel.appendChild(b);
      });
      var no = btn('mf-pbtn', _t('js.stage.mf.cancel', 'Cancel'));
      no.addEventListener('click', closeReport);
      rpanel.appendChild(no);
      var first = rpanel.querySelector('button');
      if (first && first.focus) { try { first.focus(); } catch (er) { /* none */ } }
    }
    rBtn.addEventListener('click', function () { if (rpanel.hidden) reportList(); else closeReport(); });
    rpanel.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); closeReport(); } });
    // 🧹 Clear the stage (owners / staff): everyone off now, frozen
    clearBtn.addEventListener('click', function () {
      clearBtn.disabled = true;
      post(base + '/clear', {}).then(function (d) {
        clearBtn.disabled = false;
        if (d && d.ok) { P.frozen_until = Number(d.frozen_until) || 0; bmsg.textContent = _t('js.stage.mf.cleared', 'Cleared - nobody new for {n} min.', { n: freezeMin() }); if (!panel.hidden) paintPanel(); }
        else bmsg.textContent = (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
        if (ctx.onChange) { try { ctx.onChange(); } catch (er) { /* page's own */ } }
      }).catch(function () { clearBtn.disabled = false; bmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    });
    function openPanel(on, focusBack) {
      if (on) closeReport();
      var was = !panel.hidden;
      panel.hidden = !on; mBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        paintPanel();
        if (!was && freeze.focus) { try { freeze.focus(); } catch (er) { /* none */ } }   // keyboard users land inside it
      } else if (was && focusBack && !mBtn.hidden && mBtn.focus) { try { mBtn.focus(); } catch (er) { /* none */ } }
    }
    // Escape closes ⋯ Manage (or its ✕ question first) and puts the focus back on ⋯
    panel.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' && ev.key !== 'Esc') return;
      ev.preventDefault();
      if (!ask.hidden) { ask.hidden = true; ask.textContent = ''; try { freeze.focus(); } catch (er) { /* none */ } return; }
      openPanel(false, true);
    });
    /** How long ❄ freezes: the server says (the site's freeze_max_min caps it), else 30 min. */
    function freezeMin() { var n = P.manage && Number(P.manage.freeze_min); return n > 0 ? Math.round(n) : 30; }
    function paintPanel() {
      var m = P.manage;
      if (!m) return;
      var frozen = P.frozen_until > Date.now();
      freeze.textContent = frozen ? _t('js.stage.mf.unfreeze', '▶ Unfreeze') : _t('js.stage.mf.freeze', '❄ Freeze (nobody new for {n} min)', { n: freezeMin() });
      freeze.setAttribute('aria-pressed', frozen ? 'true' : 'false');
      // wave2 WP-4 (F.3): "Dynamic" only while the site offers it (or the pad already uses it)
      var wantDyn = m.dyn_ok === true || m.layout_override === 'dynamic';
      if (wantDyn && dynOpt.parentNode !== layoutSel) layoutSel.appendChild(dynOpt);
      else if (!wantDyn && dynOpt.parentNode === layoutSel) layoutSel.removeChild(dynOpt);
      layoutSel.value = m.layout_override || '';
      pinBtn.hidden = !(Number(m.pins_room) > 0);
      if (pinBtn.hidden) pinPanel.hidden = true;
      people.textContent = '';
      P.src.forEach(function (s) {
        if (s.pin) return;                                        // (a pin's own 📌✕ unpins it)
        // (wave2 WP-4: a cover only with ex: 1 - by its frog name or "someone"; its ✕ posts {tile}, the server maps it. Review
        // B-privacy-ux-6: the small cells of a narrow 6-9 dynamic stage hide a tile's own ✕, so ⋯ Manage must list it)
        if (isCover(s) && s.ex !== 1) return;
        var li = el('li', null), b = isCover(s) ? btn('mf-pbtn', '✕ ' + labelOf(s), _t('js.stage.mf.exclude_cover_q', 'Keep this veiled speaker off the mic stage'))
          : btn('mf-pbtn', '✕ ' + s.name, _t('js.stage.mf.exclude_q', 'Keep {name} off the mic stage', { name: s.name }));
        b.addEventListener('click', function () { askExclude(s); });
        li.appendChild(b); people.appendChild(li);
      });
    }
    mBtn.addEventListener('click', function () { openPanel(panel.hidden, true); });
    freeze.addEventListener('click', function () {
      var frozen = P.frozen_until > Date.now();
      freeze.disabled = true;
      post(base + '/freeze', { minutes: frozen ? 0 : freezeMin() }).then(function (d) {
        freeze.disabled = false;
        if (d && d.ok) { P.frozen_until = Number(d.frozen_until) || 0; paintPanel(); pmsg.textContent = ''; } else pmsg.textContent = (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
      }).catch(function () { freeze.disabled = false; pmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    });
    layoutSel.addEventListener('change', function () {
      post(base + '/layout', { layout: layoutSel.value || null }).then(function (d) {
        pmsg.textContent = d && d.ok ? '' : (d && d.error) || _t('js.stage.mf.e_do', 'Couldn\'t do that.');
      }).catch(function () { pmsg.textContent = _t('js.stage.mf.e_do', 'Couldn\'t do that.'); });
    });
    tapAll.addEventListener('click', function () {
      // one gesture plays every tile (iOS refuses autoplay until the page is touched)
      var ok = true;
      for (var id in tiles) {
        var vv = tiles[id].video;
        if (vv && vv.srcObject) { try { var p = vv.play(); if (p && p.catch) p.catch(function () { ok = false; }); } catch (er) { ok = false; } }
      }
      setTimeout(function () { if (ok) tapAll.hidden = true; }, 50);
    });

    /** The bar above the tiles: always for owners / staff (⋯ + 🧹); for viewers only where the tiles are too small for their
     *  own ⚑ (narrow grid4 / grid9). `.barred` moves the tiles below it - it never covers one. */
    /** Short names on the small cells of a narrow stage (grid9; a dynamic template of 6 or more). */
    function tightNames() { return box.classList.contains('narrow') && (dynCount(P) ? dynCount(P) >= 6 : P.layout === 'grid9'); }
    function barState() {
      var dn = dynCount(P);
      var tight = box.classList.contains('narrow') && (dn ? dn >= 3 : P.layout === 'grid4' || P.layout === 'grid9');
      rBtn.hidden = !!P.manage || !P.report || !tight || !P.src.some(function (s) { return !isCover(s); });   // (wave2 WP-4: covers have no ⚑)
      box.classList.toggle('managed', !!P.manage);
      box.classList.toggle('barred', !!P.manage || !rBtn.hidden);
    }
    function narrow() {
      var w = host.clientWidth || (host.getBoundingClientRect ? host.getBoundingClientRect().width : 0) || 0;
      var was = box.classList.contains('narrow');
      box.classList.toggle('narrow', w > 0 && w < 480);
      if (was !== box.classList.contains('narrow') && P) barState();
    }
    var ro = null;
    if (window.ResizeObserver) { try { ro = new ResizeObserver(function () { narrow(); }); ro.observe(host); } catch (er) { ro = null; } }
    if (!ro) window.addEventListener('resize', narrow);

    function update(p) {
      if (stopped) return;
      var n = cleanProgram(p);
      if (!n) return;
      P = n;
      narrow();
      var dn = dynCount(P);                              // wave2 WP-4 (F.3): the dynamic template's cells (0 = the legacy layout)
      box.setAttribute('data-layout', dn ? 'dynamic' : P.layout);
      if (dn) box.setAttribute('data-dyn', 'd' + dn); else box.removeAttribute('data-dyn');
      var neutralText = P.speaking === 'pepe' ? _t('js.stage.mf.pepe', 'Pepe is on the mic') : P.speaking ? _t('js.stage.mf.someone', 'Someone is speaking') : '';
      // mfix: the page keeps this view a moment after the stage empties (stage-room.js): nobody is on the mic right now
      var idleText = !P.src.length && !neutralText && P.idle ? _t('js.stage.mf.idle', 'Nobody is on the mic right now') : '';
      box.setAttribute('aria-label', !P.count && (neutralText || idleText) ? neutralText || idleText
        : !P.count && P.pins_n ? _t('js.stage.mf.group_aria_pins', 'Pinned on the stage: {n}', { n: P.pins_n })      // mfix review: pins aren't "on the mic"
        : P.count === 1 ? _t('js.stage.mf.group_aria_one', 'On the mic: 1 person', { n: 1 })
        : _t('js.stage.mf.group_aria', 'On the mic: {n} people', { n: P.count }));
      // the neutral card: only while nobody is on the stage (the tiles gave way to it)
      neutral.hidden = !((neutralText || idleText) && !P.src.length && !P.signin && !P.blocked);
      nText.textContent = neutralText || idleText;
      nIcon.textContent = P.speaking === 'pepe' ? '🐸' : '🎙';
      // mfix: tiles kept up while someone nobody can show - or Pepe - talks: dimmed, nobody ringed, a strip says who speaks
      var dim = !!P.speaking && P.src.length > 0 && !P.signin && !P.blocked;
      box.classList.toggle('mf-dim', dim);
      strip.hidden = !dim;
      strip.textContent = dim ? (P.speaking === 'pepe' ? _t('js.stage.mf.pepe_strip', '🐸 Pepe is on the mic') : _t('js.stage.mf.someone_strip', 'Someone else is speaking')) : '';
      mBtn.hidden = !P.manage;
      clearBtn.hidden = !P.manage;
      barState();
      if (!P.report || P.manage || !P.src.length) closeReport();
      if (!P.manage) openPanel(false); else if (!panel.hidden) paintPanel();
      // signed out / blocked: a note, no tiles
      var msg = P.signin ? _t('js.stage.mf.tab_signin', '🎙 On the mic: sign in to watch') : P.blocked ? _t('js.stage.mf.blocked', 'Live cams from this room are blocked for you.') : '';
      note.textContent = msg; note.hidden = !msg;
      var seen = {};
      var sorted = byPos(P.src);
      // 1.99ahp STABLE SLOTS (program.stable): every tile's cell is its place - an empty place is an empty cell; the dynamic
      // template's cells are the places with the main in cell 0 (3+). Off: today's (reading order = positions, the main first)
      var stable = P.stable, slots = stable ? (dn ? dynSeq(sorted, P) : slotCells(sorted, CELLS[P.layout] || 1, false)) : null;
      sorted.forEach(function (s) { seen[s.id] = true; });
      // who left goes first (its session closes, its node goes) - so placing the others never steps around a leaving node
      Object.keys(tiles).forEach(function (id) {
        if (seen[id]) return;
        var t = tiles[id];
        announce(_t('js.stage.mf.left', '{name} left the stage', { name: labelOf(t.s) }));
        t.stop(true);
        if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
        delete tiles[id];
      });
      var fillers = grid.querySelectorAll('.mf-empty');
      for (var i = 0; i < fillers.length; i++) fillers[i].parentNode.removeChild(fillers[i]);
      sorted.forEach(function (s) {
        var t = tiles[s.id];
        if (!t) {
          t = tiles[s.id] = tile(s);
          announce(_t('js.stage.mf.joined', '{name} is on the stage', { name: labelOf(s) }));
        } else t.apply(s);
      });
      var els = sorted.map(function (s) { return tiles[s.id].el; });
      if (dn || (stable && P.layout === 'pip')) {
        // wave2 WP-4 (F.3) / 1.99ahp: an existing tile's node never moves (its video would re-attach) - the cell comes from its
        // grid-area (picture in picture: the .main class); a new one goes in at its place (before the next tile already there).
        // (Here the reading order can trail the cells after a main swap - the swap itself never moves a node.)
        els.forEach(function (e, n) {
          if (e.parentNode === grid) return;
          var next = null;
          for (var j = n + 1; j < els.length && !next; j++) if (els[j].parentNode === grid) next = els[j];
          if (next) grid.insertBefore(e, next); else grid.appendChild(e);
        });
      } else {
        // reading order = positions; 1.99ahp: only a node out of place moves - none when nothing changed (it never re-attaches).
        // 1.99ahp review fix C2: stable slots on the grid / side by side / single layouts too (the places' order is the cells'):
        // a node only moves after a picture in picture pick or a dynamic main swap left it out of place, then a layout change
        els.forEach(function (e, n) { if (grid.children[n] !== e) grid.insertBefore(e, grid.children[n] || null); });
      }
      // mfix: the tile that fills the stage in picture in picture (the others are the corner inset): the newest speaker, else
      // the latest mic tile (a pin sits in the corner while someone else is up), else the first
      var order = sorted, main = null;
      if (dn && stable) main = slots[0] || null;                  // 1.99ahp: the main cell is place 0 (the server's main with 3+)
      else if (dn) {
        // wave2 WP-4 (F.3): the server's main if it is still shown, else the newest speaker, else the first
        for (var d0 = 0; d0 < order.length && !main; d0++) if (order[d0].id === P.dyn.main) main = order[d0];
        for (var d1 = 0; d1 < order.length && !main; d1++) if (order[d1].newest) main = order[d1];
        if (!main) main = order[0];
      } else if (stable && P.layout === 'pip') {
        // 1.99ahp: the big picture is place 0 - it changes only when someone new comes on (the server picks it then)
        for (var p0 = 0; p0 < slots.length && !main; p0++) main = slots[p0];
      } else {
        for (var j = 0; j < order.length; j++) if (order[j].newest) main = order[j];
        if (!main) for (var q = order.length - 1; q >= 0 && !main; q--) if (!order[q].pin) main = order[q];
        if (!main) main = order[0] || null;
      }
      Object.keys(tiles).forEach(function (id) { tiles[id].el.classList.toggle('main', !!main && main.id === id); });
      place(dn, dn ? (stable ? slots : [main].concat(order.filter(function (s) { return s !== main; }))) : stable && P.layout !== 'pip' ? slots : null);
      // grid9 keeps its 3 x 3 cells (empty ones stay black); the dynamic templates have exactly one cell per tile. 1.99ahp: with
      // stable slots each tile has its cell, the fillers flow into the empty ones
      var cells = dn ? 0 : P.layout === 'grid9' ? 9 : P.layout === 'grid4' ? 4 : 0, have = grid.querySelectorAll('.mf-tile').length;
      for (var k = have; k < cells; k++) { var f = el('div', 'mf-empty'); f.setAttribute('aria-hidden', 'true'); grid.appendChild(f); }
    }
    /** wave2 WP-4 (F.3): the dynamic template - the grid's columns / rows and each tile's grid-area (seq: the main in cell 0, the
     *  others in place order). n = 0: back to the legacy layouts' CSS (every inline placement cleared) - 1.99ahp: with stable slots
     *  (seq = the cells, null = an empty one) each tile still gets its cell in the layout's columns. */
    function place(n, seq) {
      var T = n ? DYN[n] : null;
      grid.style.gridTemplateColumns = T ? T[0].map(function (c) { return c + 'fr'; }).join(' ') : '';
      grid.style.gridTemplateRows = T ? 'repeat(' + T[1] + ', 1fr)' : '';
      Object.keys(tiles).forEach(function (id) { tiles[id].el.style.gridArea = ''; });
      var cols = COLS[P.layout] || 1;
      (seq || []).forEach(function (s, i) {
        var tt = s && tiles[s.id];
        if (!tt) return;
        if (!T) { tt.el.style.gridArea = (Math.floor(i / cols) + 1) + ' / ' + (i % cols + 1) + ' / span 1 / span 1'; return; }
        var c = T[2][i];
        if (c) tt.el.style.gridArea = (c[1] + 1) + ' / ' + (c[0] + 1) + ' / span ' + c[3] + ' / span ' + c[2];
      });
    }
    function onVis() {
      if (document.hidden) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { dark = true; for (var id in tiles) tiles[id].pause(); }, HIDDEN_MS);
      } else {
        clearTimeout(hideTimer); hideTimer = null;
        if (dark) { dark = false; for (var id2 in tiles) tiles[id2].resume(); }
      }
    }
    document.addEventListener('visibilitychange', onVis);
    function onHide() { for (var id in tiles) tiles[id].stop(true); }
    window.addEventListener('pagehide', onHide);
    update(program);
    return {
      update: update,
      stop: function () {
        stopped = true;
        clearTimeout(hideTimer); clearTimeout(sayTimer);
        if (unRev) { try { unRev(); } catch (er) { /* gone */ } unRev = null; }
        for (var id in tiles) tiles[id].stop(true);
        tiles = Object.create(null);
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('pagehide', onHide);
        if (ro) { try { ro.disconnect(); } catch (er) { /* gone */ } } else window.removeEventListener('resize', narrow);
        if (box.parentNode) box.parentNode.removeChild(box);
      },
      selection: function () {
        return { stream: 'mic', label: P.count ? _t('js.stage.mf.tab', '🎙 On the mic ({n})', { n: P.count }) : _t('js.stage.mf.tab_speaking', '🎙 On the mic'),
                 embed: true, capture: false, nsfw: false };
      },
    };
  }
  // (_dyn: the d1-d9 templates, for the test that pins them to stagemiccap; 1.99ahp: _slotCells / _cells / _cols likewise)
  window.PATVStageMic = { render: render, _dyn: DYN, _slotCells: slotCells, _cells: CELLS, _cols: COLS };
})();
