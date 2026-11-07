// plex-play.js — 1.99ajw casino2 (owner 2026-11-04: "Did we ever get the ability for users to start a Plex play from the room?"): "📼 Play from
// Plex" - search the library, pick a movie / an episode (or a show's queue), the scope / start point / quality / audio / subtitles, see the
// price, confirm, play now or (on /stage) book it for later. FACTORED out of stage-plex.js (1.99jn / 1.99lr / 1.99lw - the code below is
// that flow, unchanged but for where it finds its parts) so /stage's Go-live panel and the Room Dock's 📼 sheet (pad-dock.js) run ONE copy;
// the server (medialib.js / mediaqueue.js) decides everything again: access, slot rules, the pad's limit, the price, the daily caps.
//   PATVPlexPlay.mount(host, opts) -> { info(), drawPrice(), noteQueues(j), myQueue() }
//     host: the panel; its parts are [data-px=info|search|results|pick|msg] (stageBook.ejs marks them; build() makes them)
//     opts: { roomId(), roomTitle(), balance() (text), free, member, perHour, quality, queues, days, later (the 'When' row - /stage
//             only), listId, onStarted(answer), pollNow(), inlineConfirm (the Dock: the price confirm is a row in the sheet above the
//             button, like the Dock's other confirms - /stage keeps the browser's confirm) }
//     review: the 📺 on-air box sits in the pick, above ▶ Play; the picked result is marked; after a start the button says so and stays off
//   PATVPlexPlay.build(host, {rights, note}) - the parts, for a host that has none (the Dock's sheet)
//   PATVPlexPlay.util - the helpers stage-plex.js shares (api, hms, parseTime, day, label, noticeText, fmt, esc)
// Every string goes through __t (js.plex.*).
// plexreplace (owner 2026-11-05: "a one-step 'play this instead'"): while something from the library is on THIS pad and you may change it (its
// starter, the pad's owner / staff, the library admins - medialib.mine's on_pad.can_replace), a pick's button reads "▶ Play this instead" and its
// confirm names what comes off; yes = ONE request ({replace: <its slot id>}): the server swaps the title, the stage's feature and the "Coming up
// next" card carry straight over. A busy refusal that says you may replace (can_replace - the pad changed under the sheet) turns into that
// confirm, never a dead end. Someone who may not change it sees what's on and why the pick waits.
// Review fix: the replace names the slot the confirm named (on_pad.slot_id / a refusal's playing_slot) - something else on by the yes ->
// replace_changed and the sheet asks again with what's on NOW; any other failed replace asks /mine again (never a stale "Now on").
// upnext2 (owner 2026-11-05: "unless there is an existing queue, Plex doesn't show the 'add to the queue' button. Just a play this instead
// button."): the "+" next to ▶ follows what's on THIS pad (medialib.mine on_pad): a queue you may grow (on_pad.can_add) -> "+ Add to the
// queue that's playing" (it used to add to your queue on whatever pad it ran - another pad's sheet included), a single title -> "+ Add to the
// queue" (on_pad.can_after: a queue of yours that plays after it - POST /api/medialib/queue/after, the price confirmed like a queue's),
// anything else -> "+ My list". A paid add says what it adds before it's added (the server's `estimate`).
// upnext2 review fixes (1.99alc): someone who can't change what's on (F8) gets no pink "▶ Play on <pad>" the server would refuse as busy - it
// is off, "+ Add to the queue" is the way forward and the line under the pick says so; titles of yours waiting behind it can be taken out
// (✕ Take them out - POST /api/medialib/queue/after/cancel, safety F4).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var LANG = (window.PATV_I18N && window.PATV_I18N.lang) || 'en';
  var fmt = function (n) { var x = Math.round(Number(n) || 0); try { return x.toLocaleString(LANG === 'en' ? 'en-US' : LANG); } catch (e) { return x.toLocaleString('en-US'); } };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function hms(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }
  function parseTime(v) {
    var p = String(v || '').trim().split(':').map(Number);
    if (!p.length || p.some(function (n) { return !isFinite(n) || n < 0; })) return null;
    var t = 0;
    for (var i = 0; i < p.length; i++) t = t * 60 + p[i];
    return Math.floor(t);
  }
  function day(ms) { try { return new Date(ms).toLocaleDateString(LANG === 'en' ? undefined : LANG); } catch (e) { return new Date(ms).toLocaleDateString(); } }
  // -> resolves the JSON; rejects with an Error carrying .data (the JSON: error, price…)
  function api(method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: _t('js.stage.e_server', 'Server error ({status})', { status: r.status }) }; }).then(function (j) {
        if (!r.ok || j.ok === false) { var e = new Error(j.error || ('HTTP ' + r.status)); e.data = j; throw e; }
        return j;
      });
    });
  }
  // 1.99lr: a title as a queue lists it
  function label(it) {
    if (!it) return '';
    return it.type === 'episode' && it.show ? it.show + ' — S' + (it.season == null ? 0 : it.season) + 'E' + (it.episode == null ? 0 : it.episode) + ' ' + (it.title || '')
      : (it.title || '') + (it.year ? ' (' + it.year + ')' : '');
  }
  function noticeText(q) {
    if (!q || !q.notice) return '';
    if (q.notice === 'after_cancelled') return _t('js.plex.qn_after', '📼 Your titles up next didn’t start: what they waited behind ended first. Nothing was charged.');
    if (q.notice === 'after_removed') return _t('js.plex.qn_after_removed', '📼 Your titles up next were taken out by the pad’s owner or an admin. Nothing was charged.');
    if (q.notice === 'out_of_pat') return _t('js.plex.qn_out_of_pat', '📼 Your queue ended: you’re out of PAT - top up to keep watching.');
    if (q.notice === 'failed') return _t('js.plex.qn_failed', '📼 Your queue ended: several titles in a row didn’t play.');
    if (q.notice === 'no_encoder') return _t('js.plex.qn_no_encoder', '📼 Your queue ended: no library stream came free in time.');
    // upnext3 (1.99ali, item 10): a queue of yours paused for a booked stream / one that then couldn't carry on
    if (q.notice === 'held') return _t('js.plex.qn_held', '📼 Your queue is paused for a stream booked for this time - it carries on right after it. Nothing more is charged until it does.');
    if (q.notice === 'held_cancelled') return _t('js.plex.qn_held_cancelled', '📼 Your paused queue didn’t carry on. Nothing more was charged.');
    return '';
  }

  function parts(host) {
    var q = function (k) { return host.querySelector('[data-px="' + k + '"]'); };
    return { info: q('info'), search: q('search'), results: q('results'), pick: q('pick'), msg: q('msg') };
  }
  /** the panel's parts for a host that has none (the Room Dock's sheet): the rights line, the info line, search, results, the pick, the message */
  function build(host, o) {
    o = o || {};
    host.innerHTML = '<p class="pxnote"><span class="ds-ic" aria-hidden="true">⚖️</span> ' + esc(o.rights || _t('js.plex.q_rights', 'Only show what we have the rights to show - every play is logged.')) + '</p>' +
      '<p class="muted" data-px="info" aria-live="polite"></p>' +
      '<form data-px="search" class="row" autocomplete="off" role="search"><input type="search" name="q" minlength="2" maxlength="100" placeholder="' +
      esc(_t('js.plex.search_ph', 'Search Plex: a movie, a show…')) + '" aria-label="' + esc(_t('js.plex.search_aria', 'Search the Plex library')) + '">' +
      '<button type="submit" class="btn">' + esc(_t('js.plex.search', 'Search')) + '</button></form>' +
      '<div data-px="results" class="px-grid"></div><div data-px="pick" class="px-pick hide"></div>' +
      (o.onair ? '<label class="px-onair"><input type="checkbox" data-px="onair"> ' + esc(_t('js.plex.onair_too', '📺 Also put it on Pepe’s stream')) + '</label>' : '') +
      '<p class="msg" data-px="msg" role="status" aria-live="polite"></p>' + (o.note ? '<p class="muted px-foot"></p>' : '');
    if (o.note) host.querySelector('.px-foot').textContent = o.note;
    return host;
  }

  function mount(host, opts) {
    opts = opts || {};
    var P = parts(host);
    if (!P.search || !P.results || !P.pick || !P.msg) return null;
    var myQueue = null;            // my running queue (from /api/medialib/mine), or null
    var balNow = null;
    var bal = function () { try { return opts.balance ? String(opts.balance()) : balNow != null ? fmt(balNow) : '?'; } catch (e) { return '?'; } };
    // (the Dock's sheet: your balance from the site, as the 💸 Tip modal reads it - /stage passes its own)
    if (!opts.balance && opts.me) {
      fetch('/api/u/' + encodeURIComponent(opts.me) + '/balance', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { if (j && typeof j.balance === 'number') { balNow = Math.floor(j.balance); drawPrice(); } })
        .catch(function () { /* stays '?' */ });
    }
    // 1.99ajw casino2: staff who run Pepe's on-air may put the new play on his stream too (onair.js: allow_library, the IRL feed wins,
    // audited) - its slot goes on air once it's live (a few seconds); "not live yet" is asked again for about a minute
    var onairBox = host.querySelector('[data-px="onair"]');
    var onairLbl = onairBox ? onairBox.closest('label') : null;
    if (onairLbl && onairLbl.parentNode) onairLbl.parentNode.removeChild(onairLbl);   // (it goes into the pick, above ▶ Play - placeOnair)
    var pageStarted = opts.onStarted;
    opts = Object.assign({}, opts, { onStarted: function (j) {
      if (onairBox && onairBox.checked && j && j.slot && j.slot.id) toPepe(j.slot.id, 0);
      if (pageStarted) pageStarted(j);
    } });
    // plexreplace: what's on this pad (medialib.mine on_pad: {title, queue, left, by, mine, can_replace, slot_id}) - from info(), or a refusal
    var onPad = null;
    var replacing = function () { return !!(onPad && onPad.can_replace && onPad.title) && when() !== 'later'; };
    // (review fix) what a replace names: the slot the confirm named - an older server without it: whatever is on
    var replaceArg = function () { return onPad && onPad.slot_id ? String(onPad.slot_id) : true; };
    var FREE = !!opts.free;
    var MEMBER = !!opts.member;
    var PER_HOUR = Number(opts.perHour) || 0;
    var QUALITY = Number(opts.quality) || 720;
    var QUEUES = !!opts.queues;
    var picked = null, quote = null, qPrev = null, qTimer = null, qSeq = 0;
    var say = function (t, good) { P.msg.textContent = t || ''; P.msg.style.color = good ? '#9ccc65' : ''; };
    // review: the Dock's confirm is a row in the sheet (above the button that asked), never the browser's dialog; /stage keeps the browser's
    var askBox = null;
    var closeAsk = function (refocus) {
      if (!askBox) return;
      var b = askBox; askBox = null;
      var opener = b._opener;
      if (b.parentNode) b.parentNode.removeChild(b);
      if (opener) { opener.hidden = false; if (refocus && opener.isConnected) opener.focus(); }
    };
    var ask = function (msg, yesLabel, btn, yes) {
      if (!opts.inlineConfirm) { if (confirm(msg)) yes(); return; }
      closeAsk(false);
      var box = document.createElement('div');
      box.className = 'px-ask'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', _t('js.plex.ask_aria', 'Confirm'));
      String(msg).split('\n\n').forEach(function (line, i) { var p = document.createElement('p'); p.textContent = line; if (i === 0) p.className = 'px-ask-q'; box.appendChild(p); });
      var row = document.createElement('div'); row.className = 'row';
      var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn primary'; ok.textContent = yesLabel;
      var no = document.createElement('button'); no.type = 'button'; no.className = 'btn'; no.textContent = _t('js.plex.ask_no', 'Cancel');
      ok.addEventListener('click', function () { closeAsk(false); yes(); });
      no.addEventListener('click', function () { closeAsk(true); });
      row.appendChild(ok); row.appendChild(no); box.appendChild(row);
      box._opener = btn || null;
      var at = btn && btn.closest ? btn.closest('.row') : null;
      if (at && at.parentNode) at.parentNode.insertBefore(box, at); else P.pick.appendChild(box);
      if (btn) btn.hidden = true;          // (one way forward at a time: the confirm's own button)
      askBox = box;
      ok.focus();
      if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
    };
    /** after a start: the button says so and stays off (another pick starts over) */
    var done = function (btn) { if (!btn) return; btn.disabled = true; btn.setAttribute('data-done', '1'); btn.textContent = _t('js.plex.started_btn', '✓ Started'); };
    var placeOnair = function () {
      if (!onairLbl) return;
      var go = P.pick.querySelector('[data-play], [data-series]');
      var row = go && go.closest ? go.closest('.row') : null;
      if (row && row.parentNode) row.parentNode.insertBefore(onairLbl, row);
      else if (onairLbl.parentNode) onairLbl.parentNode.removeChild(onairLbl);
    };
    // the same rule as the server (medialib.priceFor): per started hour of what's left from the start point, >= 1 h
    var hoursAt = function (dur, off) { return Math.max(1, Math.ceil(Math.max(0, (Number(dur) || 0) - Math.max(0, off || 0)) / 3600)); };
    var priceAt = function (dur, off) { return FREE || !PER_HOUR ? 0 : PER_HOUR * hoursAt(dur, off); };
    var info = function () {
      api('GET', '/api/medialib/mine?room=' + encodeURIComponent(opts.roomId())).then(function (j) {
        var bits = [];
        if (j.streams && j.streams.max) bits.push(_t('js.plex.streams_used', '📼 {used} of {max} library streams in use right now', { used: j.streams.used, max: j.streams.max }));
        if (j.daily_left != null) bits.push(_t('js.plex.plays_left', '{left} of {cap} plays left today', { left: j.daily_left, cap: j.daily_cap }));
        if (j.access && j.access.until) bits.push(_t('js.plex.access_until', 'your Plex access runs until {date}', { date: day(j.access.until) }));
        noteQueues(j);
        var ended = (j.queues || []).filter(function (q) { return (q.state === 'ended' || (q.state === 'after' && q.held)) && q.notice; })[0];   // (upnext3: + a paused one)
        P.info.textContent = (ended ? noticeText(ended) + ' ' : '') + bits.join(' · ');
        noteOnPad(j.on_pad || null);
      }).catch(function (e) { P.info.textContent = e.message; });
    };
    // plexreplace: the pick says what's on (and whether ▶ swaps it), the button says "instead"
    var noteOnPad = function (x) {
      onPad = x && x.title ? { title: String(x.title), queue: !!x.queue, left: Math.max(0, Number(x.left) || 0), by: x.by || null, mine: !!x.mine, can_replace: !!x.can_replace,
                               slot_id: x.slot_id ? String(x.slot_id) : null, can_add: x.can_add === true, can_after: x.can_after === true,
                               // upnext3: + where you are in the line after it (place of line), a queue of yours paused for a booking, a booking due next
                               after: x.after && typeof x.after === 'object' ? { count: Math.max(0, Number(x.after.count) || 0), mine: x.after.mine === true,
                                                                                place: Number(x.after.place) > 0 ? Number(x.after.place) : null, line: Math.max(0, Number(x.after.line) || 0),
                                                                                held: x.after.held === true } : null,
                               booking: x.booking && Number(x.booking.at) > 0 ? { at: Number(x.booking.at), mine: x.booking.mine === true } : null } : null;
      drawNow();
      drawPrice();
      drawAdd();
    };
    // (review F8: something is on and this viewer may not replace it - ▶ now would only be refused "busy")
    var blocked = function () { return !!(onPad && onPad.title && !onPad.can_replace) && when() !== 'later'; };
    // (while ▶ is off the sheet looks again every BLOCK_LOOK_MS - the title ends and ▶ comes back without reopening it; a closed sheet stops)
    var BLOCK_LOOK_MS = 20000, blockT = null;
    var blockLook = function () {
      if (blockT) return;
      blockT = setTimeout(function () { blockT = null; if (host.isConnected === false || !blocked()) return; info(); }, BLOCK_LOOK_MS);
      if (blockT && blockT.unref) blockT.unref();
    };
    var drawNow = function () {
      var el = P.pick.querySelector('[data-now]');
      if (!el) return;
      var b0 = P.pick.querySelector('[data-play]');
      if (b0 && !b0.hasAttribute('data-done')) {
        // review F8: the way forward is the primary button - "+ Add to the queue" when ▶ can't play it now
        var bl = blocked(), adds = addMode() !== 'list';
        if (bl) { b0.setAttribute('data-blocked', '1'); b0.disabled = true; blockLook(); }
        else if (b0.hasAttribute('data-blocked')) { b0.removeAttribute('data-blocked'); b0.disabled = false; }
        b0.classList.toggle('primary', !(bl && adds));
        P.pick.querySelectorAll('[data-add]').forEach(function (b) { b.classList.toggle('primary', bl && adds); });
      }
      if (!onPad || when() === 'later' || (b0 && b0.hasAttribute('data-done'))) { el.classList.add('hide'); el.textContent = ''; return; }
      el.classList.remove('hide');
      // upnext3 (1.99ali): a booking due next (item 10: it plays right after the title on now - nothing replaces it meanwhile); someone else's
      // running queue you may line up after (item 5)
      el.textContent = onPad.booking ? _t('js.plex.now_on_booking', '📼 Now on {pad}: “{now}” - a stream booked for {time} starts right after it, so a new pick waits until then.', { pad: opts.roomTitle(), now: onPad.title, time: whenTxt(onPad.booking.at) })
        : onPad.can_replace ? _t('js.plex.now_on', '📼 Now on {pad}: “{now}” - ▶ swaps it for your pick.', { pad: opts.roomTitle(), now: onPad.title })
        : onPad.queue && onPad.can_after ? _t('js.plex.now_on_after_q', '📼 Now on {pad}: “{now}” from someone’s queue - you can’t change it, but + Line up my queue plays yours when that queue ends.', { pad: opts.roomTitle(), now: onPad.title })
        : !onPad.queue && onPad.can_after ? _t('js.plex.now_on_after', '📼 Now on {pad}: “{now}” - you can’t change it, but + Add to the queue plays your pick after it.', { pad: opts.roomTitle(), now: onPad.title })
        : _t('js.plex.now_on_locked', '📼 Now on {pad}: “{now}” - only whoever started it, the pad’s owner or an admin can change it, so a new pick waits until it ends.', { pad: opts.roomTitle(), now: onPad.title });
      // safety F4: titles of yours waiting behind it - take them out before they start (they'd be charged as they play)
      if (onPad.after && onPad.after.mine && onPad.after.count) {
        var mineL = document.createElement('span'), x = document.createElement('button');
        // (upnext3: your place in the line when others are in it too; a queue of yours paused for a booking)
        mineL.textContent = ' ' + (onPad.after.held ? _t('js.plex.after_held', 'Your queue is paused for a booked stream - it carries on right after it.')
          : onPad.after.line > 1 && onPad.after.place ? _t('js.plex.after_mine_place', 'Your queue is {place} of {line} in line after it.', { place: onPad.after.place, line: onPad.after.line })
          : _t('js.plex.after_mine', 'Your titles up next after it: {n}.', { n: onPad.after.count })) + ' ';
        x.type = 'button'; x.className = 'btn'; x.setAttribute('data-after-x', '1'); x.textContent = _t('js.plex.after_x', '✕ Take them out');
        el.appendChild(mineL); el.appendChild(x);
      }
    };
    var withdrawAfter = function (btn) {
      btn.disabled = true;
      api('POST', '/api/medialib/queue/after/cancel', { room: opts.roomId() }).then(function () {
        say(_t('js.plex.after_x_done', 'Taken out - nothing was charged.'), true);
      }).catch(function (e) { say(e.message); }).then(function () { info(); });
    };
    // the confirm's lines about what comes off: someone else's play, a queue (its titles after this one don't play)
    var insteadLines = function () {
      if (!onPad) return '';
      var out = '';
      if (onPad.by && !onPad.mine) out += _t('js.plex.instead_by', '“{now}” was started by {who} - it stops for everyone watching.', { now: onPad.title, who: onPad.by }) + '\n\n';
      if (onPad.queue) out += (onPad.left === 1 ? _t('js.plex.instead_queue_1', 'It ends the 📼 queue that’s playing too (1 more title after this one).')
        : onPad.left > 1 ? _t('js.plex.instead_queue_n', 'It ends the 📼 queue that’s playing too ({n} more titles after this one).', { n: onPad.left })
        : _t('js.plex.instead_queue_last', 'It ends the 📼 queue that’s playing too (it’s on its last title).')) + '\n\n';
      // upnext3 (item 7): what's lined up after it keeps waiting - behind yours now
      if (onPad.after && onPad.after.line) out += _t('js.plex.instead_after', 'What’s lined up after it ({n}) keeps waiting - it plays after yours.', { n: onPad.after.line }) + '\n\n';
      return out;
    };
    // a refusal that says you may replace what's on: -> true (the caller asks again, as a replace naming what's on NOW) - the pad got busy under
    // the sheet (busy_*, a plain play), or (review fix) what's on changed between the confirm and the yes (replace_changed)
    var insteadAgain = function (e, body) {
      var d = e && e.data;
      if (!d) return false;
      var again = d.code === 'replace_changed' || (!body.replace && /^busy_/.test(String(d.code || '')));
      if (!d.can_replace || !d.playing || !again) return false;
      noteOnPad({ title: d.playing, queue: !!d.playing_queue, left: d.playing_left || 0, by: d.playing_by || null, mine: !!d.playing_mine, can_replace: true,
                  slot_id: d.playing_slot || null });
      return true;
    };
    // the line above the new confirm: why it asks again (what's on changed) - nothing for a pad that got busy (the confirm says it all)
    var changedLine = function (e) {
      return e.data.code === 'replace_changed' ? _t('js.plex.now_changed', 'What’s on {pad}’s stage just changed - it’s “{now}” now.', { pad: opts.roomTitle(), now: e.data.playing }) : '';
    };
    // (review fix) any other failed replace - or a busy pad - says what's on may have changed: ask /mine again (the "Now on" line, the button)
    var reread = function (e, body) {
      var d = (e && e.data) || {};
      if (body.replace || d.code === 'replace_gone' || /^busy_/.test(String(d.code || ''))) info();
    };
    var card = function (it) {
      var sub = it.type === 'episode' ? (esc(it.show) + ' · S' + it.season + 'E' + it.episode)
        : it.type === 'show' ? esc(_t('js.plex.show', 'Show')) + (it.leafs ? ' · ' + esc(_t('js.plex.episodes', '{count} episodes', { count: it.leafs })) : '')
        : (it.year || esc(_t('js.plex.movie', 'Movie')));
      return '<button type="button" class="px-it" data-key="' + esc(it.key) + '">' +
        (it.poster ? '<img loading="lazy" alt="" src="/api/medialib/poster/' + encodeURIComponent(it.key) + '">' : '<span class="px-ph"></span>') +
        '<b>' + esc(it.title) + '</b><small>' + sub + (it.duration ? ' · ' + hms(it.duration) : '') + '</small></button>';
    };
    P.search.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = P.search.q.value.trim();
      if (q.length < 2) { say(_t('js.plex.type_2', 'Type at least 2 characters.')); return; }
      say(_t('js.plex.searching', 'Searching…'), true);
      P.pick.classList.add('hide');
      api('GET', '/api/medialib/search?q=' + encodeURIComponent(q)).then(function (j) {
        P.results.innerHTML = (j.results || []).map(card).join('') || '<p class="muted">' + esc(_t('js.plex.nothing', 'Nothing found.')) + '</p>';
        say('');
      }).catch(function (e) { say(e.message); });
    });
    P.results.addEventListener('click', function (ev) {
      var b = ev.target.closest('.px-it');
      if (b) openItem(b.getAttribute('data-key'));
    });
    P.pick.addEventListener('click', function (ev) {
      var ep = ev.target.closest('[data-ep]');
      if (ep) { openItem(ep.getAttribute('data-ep')); return; }
      var all = ev.target.closest('[data-series]');
      if (all) { openItem(all.getAttribute('data-series'), 'series_from'); return; }
      var ax = ev.target.closest('[data-after-x]');
      if (ax) { withdrawAfter(ax); return; }
      var add = ev.target.closest('[data-add]');
      if (add) { addToList(add); return; }
      var go = ev.target.closest('[data-play]');
      if (go) play(go);
    });
    P.pick.addEventListener('input', function (ev) { if (ev.target.hasAttribute('data-o')) drawPrice(); });
    P.pick.addEventListener('change', function (ev) {
      if (ev.target.hasAttribute('data-when')) { var at = P.pick.querySelector('[data-at]'); if (at) at.classList.toggle('hide', ev.target.value !== 'later'); }
      if (ev.target.hasAttribute('data-scope') || ev.target.hasAttribute('data-when') || ev.target.hasAttribute('data-at')) { drawNow(); drawPrice(); drawAdd(); }
    });
    var scope = function () { var s = P.pick.querySelector('[data-scope]'); return s ? s.value : 'episode'; };
    // 1.99lw: ▶ now, or 📅 book a slot for later (sized to the runtime)
    var when = function () { var s = P.pick.querySelector('[data-when]'); return s ? s.value : 'now'; };
    var atMs = function () { var a = P.pick.querySelector('[data-at]'); var t = a && a.value ? new Date(a.value).getTime() : NaN; return isFinite(t) ? t : null; };
    var atLocal = function (d) { var p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
    var whenRow = function () {
      if (!opts.later) return '';
      var d = new Date(Date.now() + 20 * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
      var days = Number(opts.days) || 14;
      return '<label>' + esc(_t('js.plex.b_when', 'When')) + ' <select data-when><option value="now">' + esc(_t('js.plex.b_now', 'Now')) + '</option><option value="later">' +
        esc(_t('js.plex.b_later', 'Later (book a slot)')) + '</option></select></label>' +
        '<input type="datetime-local" class="hide" data-at value="' + atLocal(d) + '" min="' + atLocal(new Date()) + '" max="' + atLocal(new Date(Date.now() + days * 86400000)) + '" aria-label="' + esc(_t('js.plex.b_at', 'Start time')) + '">';
    };
    var whenTxt = function (ms) { try { return new Date(ms).toLocaleString(LANG === 'en' ? undefined : LANG, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }); } catch (e) { return new Date(ms).toLocaleString(); } };
    var playLabel = function (price, n) {
      if (replacing()) {                     // plexreplace
        return n > 1 ? (price ? _t('js.plex.q_play_instead_for', '▶ Play {n} titles instead (about {price} PAT)', { n: n, price: fmt(price) })
                              : _t('js.plex.q_play_instead', '▶ Play {n} titles instead', { n: n }))
          : price ? _t('js.plex.play_instead_for', '▶ Play this instead for {price} PAT', { price: fmt(price) }) : _t('js.plex.play_instead', '▶ Play this instead');
      }
      return n > 1 ? (price ? _t('js.plex.q_play_on_for', '▶ Play {n} titles on {pad} (about {price} PAT)', { n: n, pad: opts.roomTitle(), price: fmt(price) })
                            : _t('js.plex.q_play_on', '▶ Play {n} titles on {pad}', { n: n, pad: opts.roomTitle() }))
        : price ? _t('js.plex.play_on_for', '▶ Play on {pad} for {price} PAT', { pad: opts.roomTitle(), price: fmt(price) })
                : _t('js.plex.play_on', '▶ Play on {pad}', { pad: opts.roomTitle() });
    };
    var drawPrice = function () {
      if (!picked || !P.pick.querySelector('[data-o]')) return;
      var b0 = P.pick.querySelector('[data-play]'); if (b0 && b0.hasAttribute('data-done')) return;   // (started: it says so)
      var off = parseTime(P.pick.querySelector('[data-o]').value) || 0;
      var pr = P.pick.querySelector('[data-price]'), btn = P.pick.querySelector('[data-play]');
      qPrev = null;
      if (scope() !== 'episode' || when() === 'later') {
        // 1.99lr: a queue - the server builds it and prices it
        var seq = ++qSeq;
        pr.innerHTML = '<span class="muted">' + esc(_t('js.plex.loading', 'Loading…')) + '</span>';
        clearTimeout(qTimer);
        qTimer = setTimeout(function () {
          api('POST', '/api/medialib/queue/preview', { key: picked.key, scope: scope(), offset: off, room: opts.roomId(), when: when() }).then(function (j) {
            if (seq !== qSeq) return;
            qPrev = j;
            var head = esc(_t('js.plex.q_titles', '{count} titles', { count: j.items.length })) + ' · ' + hms(j.total_sec);
            var first = j.items[0], last = j.items[j.items.length - 1];
            var span = first && last && first !== last ? ' <span class="muted">(' + esc(label(first)) + ' → ' + esc(label(last)) + ')</span>' : '';
            pr.innerHTML = '<div>' + head + span + '</div>' + (j.estimate
              ? '<div>' + esc(_t('js.plex.q_estimate', 'About')) + ' <b>' + fmt(j.estimate) + ' PAT</b> <span class="muted">· ' +
                esc(_t('js.plex.q_as_it_plays', 'charged as it plays, {per} per started hour: {first} PAT when it starts · you have {bal}',
                       { per: fmt(j.per_hour), first: fmt(j.first_charge), bal: bal() })) + '</span></div>'
              : '<div><b>' + esc(_t('js.plex.free', 'Free')) + '</b> <span class="muted">' + esc(MEMBER ? _t('js.plex.free_member', '(Plex member)') : _t('js.plex.free_admin', '(site admin)')) +
                ' · ' + esc(_t('js.plex.q_one_play', 'the whole queue counts as one play')) + '</span></div>') +
              (j.truncated ? '<div class="muted">' + esc(_t('js.plex.q_cut', 'Cut to fit: a queue holds at most {hours} hours and {max} titles.', { hours: j.max_hours, max: j.max_items })) + '</div>' : '') +
              (j.slot_minutes ? '<div class="muted">' + esc(_t('js.plex.b_slot', '📅 A {min}-minute slot: the runtime plus a few minutes. It starts by itself at that time; the price rules are the same, charged as it plays.', { min: j.slot_minutes })) +
                                ' ' + esc(_t('js.plex.b_waits', 'If something from the library is still on then, yours waits for that title to finish and starts right after it.')) + '</div>' : '');
            var at = atMs();
            btn.textContent = when() === 'later' ? (at ? _t('js.plex.b_book_for', '📅 Book it for {time}', { time: whenTxt(at) }) : _t('js.plex.b_pick', 'Pick a start time')) : playLabel(j.estimate, j.items.length);
          }).catch(function (e) { if (seq === qSeq) pr.textContent = e.message; });
        }, 250);
        return;
      }
      quote = priceAt(picked.duration, off);
      var hours = hoursAt(picked.duration, off);
      var balTxt = bal();
      pr.innerHTML = quote
        ? esc(_t('js.plex.price', 'Price:')) + ' <b>' + fmt(quote) + ' PAT</b> <span class="muted">· ' +
          esc(_t('js.plex.price_detail', '{count} started hours × {per} · you have {bal}', { count: hours, per: fmt(PER_HOUR), bal: balTxt })) + '</span>'
        : '<b>' + esc(_t('js.plex.free', 'Free')) + '</b> <span class="muted">' + esc(MEMBER ? _t('js.plex.free_member', '(Plex member)') : _t('js.plex.free_admin', '(site admin)')) + '</span>';
      btn.textContent = playLabel(quote, 1);
    };
    // upnext2: where "+" adds on THIS pad - 'running' (a queue here you may grow), 'after' (behind the single title on), 'list' (this tab's list)
    // upnext3 (1.99ali, item 5): 'after' behind someone else's RUNNING queue too - "+ Line up my queue" (a queue of yours that plays when it ends)
    var addMode = function () {
      if (onPad && onPad.queue && onPad.can_add) return 'running';
      if (onPad && onPad.can_after) return 'after';
      return 'list';
    };
    var lineMode = function () { return addMode() === 'after' && !!(onPad && onPad.queue); };
    var addLabel = function () {
      var m = addMode();
      return m === 'running' ? _t('js.plex.q_add_running', '+ Add to the queue that’s playing')
        : m === 'after' ? (lineMode() ? _t('js.plex.q_add_line', '+ Line up my queue') : _t('js.plex.q_add_after', '+ Add to the queue')) : _t('js.plex.q_add', '+ My list');
    };
    var addBtn = function (key) {
      var tip = addMode() !== 'after' ? '' : lineMode() ? _t('js.plex.q_add_line_title', 'Your own queue, charged to you - it plays when the queue that’s on ends') : _t('js.plex.q_add_after_title', 'Plays after what’s on now');
      return QUEUES ? '<button type="button" class="btn" data-add="' + esc(key) + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(addLabel()) + '</button>' : '';
    };
    var drawAdd = function () { host.querySelectorAll('[data-add]').forEach(function (b) { if (!b.disabled) b.textContent = addLabel(); }); drawNow(); };
    var openItem = function (key, wantScope) {
      say(_t('js.plex.loading', 'Loading…'), true);
      closeAsk(false);
      api('GET', '/api/medialib/item/' + encodeURIComponent(key)).then(function (j) {
        var it = j.item;
        picked = it;
        // (review: the picked result is marked - a show's episode keeps its show marked)
        Array.prototype.forEach.call(P.results.querySelectorAll('.px-it'), function (b) {
          var on = b.getAttribute('data-key') === String(key) || (it.show_key && b.getAttribute('data-key') === String(it.show_key));
          b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        var h = '<div><b>' + esc(it.type === 'episode' ? it.show + ' · S' + it.season + 'E' + it.episode + ' · ' + it.title : it.title) + '</b>' +
                (it.year ? ' (' + it.year + ')' : '') + (it.duration ? ' <span class="muted">· ' + hms(it.duration) + '</span>' : '') + '</div>';
        if (it.summary) h += '<p class="muted" style="margin:0">' + esc(it.summary) + '</p>';
        if (it.type === 'show') {
          var eps = (it.episodes || []).slice().sort(function (a, b) { return (a.season - b.season) || (a.episode - b.episode); });
          var main = eps.filter(function (e) { return e.season !== 0; });
          var firstEp = main[0] || eps[0];
          if (QUEUES && firstEp) {
            h += '<div class="row"><button type="button" class="btn primary" data-series="' + esc(firstEp.key) + '">' +
                 esc(_t('js.plex.q_series', '▶ The whole series ({count} episodes)', { count: (main.length || eps.length) })) + '</button>' +
                 addBtn(it.key) + '</div>';
          }
          h += '<div class="px-eps">' + (it.episodes || []).map(function (e) {
            return '<button type="button" class="btn" data-ep="' + esc(e.key) + '">S' + e.season + 'E' + e.episode + ' · ' + esc(e.title) + (e.duration ? ' <span class="muted">' + hms(e.duration) + '</span>' : '') + '</button>';
          }).join('') + '</div>';
        } else {
          var q = [1080, 720, 480].map(function (v) { return '<option value="' + v + '"' + (v === QUALITY ? ' selected' : '') + '>' + v + 'p</option>'; }).join('');
          var au = (it.audio || []).map(function (a) { return '<option value="' + a.index + '"' + (a['default'] ? ' selected' : '') + '>' + esc(a.label) + '</option>'; }).join('');
          var su = '<option value="">' + esc(_t('js.plex.none', 'None')) + '</option>' + (it.subs || []).filter(function (s) { return s.burnable; }).map(function (s) {
            return '<option value="' + s.index + '">' + esc(s.label) + (s.forced ? ' ' + esc(_t('js.plex.forced', '(forced)')) : '') + '</option>';
          }).join('');
          // 1.99lr: what to play from this episode
          var sc = '';
          if (QUEUES && it.type === 'episode') {
            var scopes = [['episode', _t('js.plex.q_this', 'Just this episode')]];
            if (it.show_key) {
              scopes.push(['season_rest', _t('js.plex.q_season_rest', 'The rest of season {n}, from here', { n: it.season })]);
              scopes.push(['season', _t('js.plex.q_season', 'All of season {n}', { n: it.season })]);
              scopes.push(['series_from', _t('js.plex.q_series_from', 'The series from here')]);
            }
            sc = '<label>' + esc(_t('js.plex.q_what', 'Play')) + ' <select data-scope>' + scopes.map(function (o) {
              return '<option value="' + o[0] + '"' + (o[0] === (wantScope || 'episode') ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
            }).join('') + '</select></label>';
          }
          h += '<div class="row">' + sc +
            '<label>' + esc(_t('js.plex.quality', 'Quality')) + ' <select data-q>' + q + '</select></label>' +
            (au ? '<label>' + esc(_t('js.plex.audio', 'Audio')) + ' <select data-a>' + au + '</select></label>' : '') +
            '<label>' + esc(_t('js.plex.subs', 'Subtitles (burnt in)')) + ' <select data-s>' + su + '</select></label>' +
            '<label>' + esc(_t('js.plex.start_at', 'Start at')) + ' <input type="text" data-o value="0:00" inputmode="numeric" aria-label="' + esc(_t('js.plex.start_aria', 'Start at (h:mm:ss)')) + '"></label>' +
            '</div><div class="row">' + whenRow() + '</div>' +
            (sc ? '<p class="muted" style="margin:0">' + esc(_t('js.plex.q_tracks', 'The next episodes keep your quality, audio language and subtitle language.')) + '</p>' : '') +
            (it.hdr ? '<p class="muted" style="margin:0">' + esc(_t('js.plex.hdr', 'HDR: shown in SDR, at up to 720p.')) + '</p>' : '') +
            '<p class="muted px-now hide" data-now></p><div class="px-price" data-price></div>' +
            '<div class="row"><button type="button" class="btn primary" data-play>' + esc(_t('js.plex.play', '▶ Play')) + '</button>' + addBtn(it.key) + '</div>';
        }
        if (onairLbl && onairLbl.parentNode) onairLbl.parentNode.removeChild(onairLbl);   // (kept across picks: its tick stays)
        P.pick.innerHTML = h;
        P.pick.classList.remove('hide');
        placeOnair();
        drawNow();
        drawPrice();
        say('');
        P.pick.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }).catch(function (e) { say(e.message); });
    };
    var started = function (j) {
      info();
      if (opts.onStarted) { try { opts.onStarted(j || {}); } catch (e) { /* the page's own */ } }
    };
    // 1.99lr: start a queue (an episode + scope, or my list's keys): confirm the estimate, then it's charged as it plays
    var startQueue = function (btn, body, pv, confirmedEst) {
      var go = function (pv) {
        var n = pv.items.length, est = confirmedEst != null ? confirmedEst : pv.estimate;
        var rep = replacing(), was = rep ? onPad.title : '';          // plexreplace: "instead of" what's on
        var msg = (rep ? _t('js.plex.q_instead_n', 'Play {n} titles ({time}) back to back on {pad}’s stage instead of “{now}”?', { n: n, time: hms(pv.total_sec), pad: opts.roomTitle(), now: was }) + '\n\n' + insteadLines()
                       : _t('js.plex.q_confirm', 'Play {n} titles ({time}) back to back on {pad}’s stage?', { n: n, time: hms(pv.total_sec), pad: opts.roomTitle() }) + '\n\n') +
          (est ? _t('js.plex.q_confirm_cost', 'About {price} PAT in all, charged as it plays: {first} PAT now, the rest as each new hour starts (only what actually plays). If you run out, it stops after the title that’s on.', { price: fmt(est), first: fmt(pv.first_charge) }) + '\n\n' : '') +
          _t('js.plex.q_rights', 'Only show what we have the rights to show - every play is logged.');
        ask(msg, rep ? _t('js.plex.ask_instead', 'Yes, play it instead') : _t('js.plex.ask_play', 'Yes, play it'), btn, function () {
        if (est) body.estimate = est;
        if (rep) body.replace = replaceArg(); else delete body.replace;
        btn.disabled = true;
        var ok = false;
        say(_t('js.plex.starting', 'Starting… (opening a library slot and the encoder)'), true);
        api('POST', '/api/medialib/queue/start', body).then(function (j) {
          ok = true;
          say((j.replaced ? _t('js.plex.q_started_instead', '▶ {title} is starting on {pad} instead of “{now}” - {n} titles queued.', { title: j.title, pad: opts.roomTitle(), n: j.items, now: j.replaced.title || was })
                          : _t('js.plex.q_started', '▶ {title} is starting on {pad} - {n} titles queued.', { title: j.title, pad: opts.roomTitle(), n: j.items })) +
              (j.price ? ' ' + _t('js.plex.paid', '{price} PAT paid.', { price: fmt(j.price) }) : ''), true);
          if (body.keys) { list = []; saveList(); drawList(); }
          else done(btn);
          started(j);
        }).catch(function (e) {
          if (e.data && e.data.estimate && e.data.estimate !== est) {
            say(e.message);
            btn.disabled = false;
            startQueue(btn, body, Object.assign({}, pv, { estimate: e.data.estimate }), e.data.estimate);
            return;
          }
          // plexreplace: the pad got busy under the sheet (or what's on changed) and you may replace it - ask that, never a dead end
          if (insteadAgain(e, body)) { say(changedLine(e)); btn.disabled = false; startQueue(btn, body, pv, confirmedEst); return; }
          reread(e, body);
          say(e.message);
        }).then(function () { if (!ok || body.keys) btn.disabled = false; });
        });
      };
      if (pv) { go(pv); return; }
      api('POST', '/api/medialib/queue/preview', body).then(go).catch(function (e) { say(e.message); });
    };
    // 1.99lw: book a 📼 slot for later
    var bookIt = function (btn, body, pv, confirmedEst) {
      var at = atMs();
      if (!at || at < Date.now() + 90 * 1000) { say(_t('js.plex.b_future', 'Pick a start time at least a couple of minutes from now.')); return; }
      if (!pv) { say(_t('js.plex.loading', 'Loading…'), true); return; }
      var est = confirmedEst != null ? confirmedEst : pv.estimate;
      var msg = _t('js.plex.b_confirm', 'Book a {min}-minute slot on {pad}’s stage for {time} ({n} titles)?', { min: pv.slot_minutes, pad: opts.roomTitle(), time: whenTxt(at), n: pv.items.length }) + '\n\n' +
        (est ? _t('js.plex.b_confirm_cost', 'Nothing is taken now. When it starts it costs about {price} PAT, charged as it plays; if you don’t have enough then, it doesn’t start.', { price: fmt(est) }) + '\n\n' : '') +
        _t('js.plex.q_rights', 'Only show what we have the rights to show - every play is logged.');
      ask(msg, _t('js.plex.ask_book', 'Yes, book it'), btn, function () {
      body.start_at = at;
      if (est) body.estimate = est;
      btn.disabled = true;
      api('POST', '/api/medialib/book', body).then(function (j) {
        say((j.status === 'requested' ? _t('js.plex.b_requested', '📅 Asked the pad’s owner for {time} ({min} min) - you’ll get a notice when they answer.', { time: whenTxt(j.slot.start_at), min: j.minutes })
                                      : _t('js.plex.b_booked', '📅 Booked for {time} ({min} min). It starts by itself - it’s in your upcoming slots.', { time: whenTxt(j.slot.start_at), min: j.minutes })), true);
        if (window.PATVStageRefresh) window.PATVStageRefresh();
      }).catch(function (e) {
        if (e.data && e.data.estimate && e.data.estimate !== est) { say(e.message); btn.disabled = false; bookIt(btn, body, Object.assign({}, pv, { estimate: e.data.estimate }), e.data.estimate); return; }
        say(e.message);
      }).then(function () { btn.disabled = false; });
      });
    };
    var play = function (btn, confirmed) {
      if (!picked) return;
      var pk = P.pick;
      var off = parseTime(pk.querySelector('[data-o]').value);
      if (off == null) { say(_t('js.plex.time_fmt', 'Type the start time like 1:02:30.')); return; }
      var a = pk.querySelector('[data-a]'), s = pk.querySelector('[data-s]');
      var body = { room: opts.roomId(), key: picked.key, quality: Number(pk.querySelector('[data-q]').value), offset: off,
                   audio: a ? a.value : null, sub: s && s.value !== '' ? s.value : null };
      if (when() === 'later') { body.scope = scope(); bookIt(btn, body, qPrev); return; }
      if (scope() !== 'episode') { body.scope = scope(); startQueue(btn, body, qPrev); return; }
      var price = confirmed != null ? confirmed : priceAt(picked.duration, off);
      var what = (picked.type === 'episode' ? picked.show + ' S' + picked.season + 'E' + picked.episode : picked.title);
      var rep = replacing(), was = rep ? onPad.title : '';            // plexreplace: "instead of" what's on - ONE request
      var q = rep ? (off ? _t('js.plex.q_instead_from', 'Play “{what}” on {pad}’s stage from {time} instead of “{now}”?', { what: what, pad: opts.roomTitle(), time: hms(off), now: was })
                         : _t('js.plex.q_instead', 'Play “{what}” on {pad}’s stage instead of “{now}”?', { what: what, pad: opts.roomTitle(), now: was }))
        : off ? _t('js.plex.q_play_from', 'Play “{what}” on {pad}’s stage from {time}?', { what: what, pad: opts.roomTitle(), time: hms(off) })
                  : _t('js.plex.q_play', 'Play “{what}” on {pad}’s stage?', { what: what, pad: opts.roomTitle() });
      var msg = q + '\n\n' + (rep ? insteadLines() : '') + (price ? _t('js.plex.q_cost', 'It costs {price} PAT, taken now. If it never gets on the stage, it all comes back.', { price: fmt(price) }) + '\n\n' : '') +
                _t('js.plex.q_rights', 'Only show what we have the rights to show - every play is logged.');
      var yes = rep ? (price ? _t('js.plex.ask_instead_pay', 'Yes, play it instead for {price} PAT', { price: fmt(price) }) : _t('js.plex.ask_instead', 'Yes, play it instead'))
        : price ? _t('js.plex.ask_pay', 'Yes, play it for {price} PAT', { price: fmt(price) }) : _t('js.plex.ask_play', 'Yes, play it');
      ask(msg, yes, btn, function () {
      if (price) body.price = price;
      if (rep) body.replace = replaceArg();
      btn.disabled = true;
      var ok = false;
      say(_t('js.plex.starting', 'Starting… (opening a library slot and the encoder)'), true);
      api('POST', '/api/medialib/play', body).then(function (j) {
        ok = true;
        say((j.replaced ? _t('js.plex.started_instead', '▶ {title} is starting on {pad} instead of “{now}” - it shows on the stage within a few seconds.', { title: j.title, pad: opts.roomTitle(), now: j.replaced.title || was })
                        : _t('js.plex.started', '▶ {title} is starting on {pad} - it shows on the stage within a few seconds.', { title: j.title, pad: opts.roomTitle() })) +
            (j.price ? ' ' + _t('js.plex.paid', '{price} PAT paid.', { price: fmt(j.price) }) : ''), true);
        done(btn);
        drawNow();
        started(j);
      }).catch(function (e) {
        // the price moved (or wasn't confirmed): show the server's and ask again
        if (e.data && e.data.price && e.data.price !== price) {
          say(e.message);
          btn.disabled = false;
          quote = e.data.price;
          play(btn, e.data.price);
          return;
        }
        // plexreplace: the pad got busy under the sheet (or what's on changed) and you may replace it - ask that, never a dead end
        if (insteadAgain(e, body)) { say(changedLine(e)); btn.disabled = false; play(btn, confirmed); return; }
        reread(e, body);
        say(e.message);
      }).then(function () { if (!ok) btn.disabled = false; });
      });
    };

    // ── 1.99lr: my list (a hand-made queue; kept in this tab) ──
    var list = [];
    try { list = JSON.parse(sessionStorage.getItem('patv.plexList') || '[]') || []; } catch (e) { list = []; }
    var saveList = function () { try { sessionStorage.setItem('patv.plexList', JSON.stringify(list)); } catch (e) { /* private mode */ } };
    var listBox = document.createElement('div');
    listBox.className = 'px-list hide';
    if (opts.listId) listBox.id = opts.listId;
    P.pick.parentNode.insertBefore(listBox, P.msg);
    var drawList = function () {
      listBox.classList.toggle('hide', !list.length || !QUEUES);
      if (!list.length) { listBox.innerHTML = ''; return; }
      var tot = list.reduce(function (t, x) { return t + (Number(x.duration) || 0); }, 0);
      listBox.innerHTML = '<div class="px-lh"><b>' + esc(_t('js.plex.q_my_list', '📋 My list')) + '</b> <span class="muted">· ' +
        esc(_t('js.plex.q_titles', '{count} titles', { count: list.length })) + (tot ? ' · ' + hms(tot) : '') + '</span></div>' +
        '<ol>' + list.map(function (x, i) {
          return '<li><span>' + esc(x.label) + '</span><span class="px-ctl">' +
            '<button type="button" class="btn sm" data-lup="' + i + '" aria-label="' + esc(_t('js.plex.q_up', 'Move up')) + '"' + (i ? '' : ' disabled') + '>↑</button>' +
            '<button type="button" class="btn sm" data-ldown="' + i + '" aria-label="' + esc(_t('js.plex.q_down', 'Move down')) + '"' + (i < list.length - 1 ? '' : ' disabled') + '>↓</button>' +
            '<button type="button" class="btn sm" data-lrm="' + i + '" aria-label="' + esc(_t('js.plex.q_remove', 'Remove')) + '">✕</button></span></li>';
        }).join('') + '</ol>' +
        '<div class="row"><button type="button" class="btn primary" data-lplay>' + esc(_t('js.plex.q_play_list', '▶ Play my list')) + '</button>' +
        '<button type="button" class="btn" data-lclear>' + esc(_t('js.plex.q_clear', 'Clear')) + '</button></div>';
    };
    var addToList = function (btn) {
      var key = btn.getAttribute('data-add');
      var it = picked && String(picked.key) === key ? picked : null;
      var entry = { key: key, label: it ? (it.type === 'show' ? it.title + ' · ' + _t('js.plex.q_whole_series', 'whole series') : label(it)) : key,
                    duration: it && it.type !== 'show' ? it.duration : null };
      var mode = addMode();
      if (mode === 'running') { addRunning(btn, key); return; }
      if (mode === 'after') { addAfter(btn, key); return; }
      list.push(entry);
      saveList(); drawList();
      say(_t('js.plex.q_added', 'Added to my list.'), true);
    };
    // upnext2: "+ Add to the queue that's playing" - on THIS pad (review: it used to add to your queue on any pad); a paid queue says what it adds
    var addRunning = function (btn, key, est) {
      var body = { room: opts.roomId(), op: 'add', keys: [key] };
      if (est != null) body.estimate = est;
      btn.disabled = true;
      api('POST', '/api/medialib/queue/edit', body).then(function (j) {
        say(_t('js.plex.q_added_running', 'Added to the queue that’s playing ({n} titles now).', { n: j.items }), true);
        if (opts.pollNow) opts.pollNow();
      }).catch(function (e) {
        var d = e.data || {};
        if (d.code === 'estimate' && d.estimate && d.estimate !== est) {
          btn.disabled = false;
          ask(_t('js.plex.q_add_cost', 'That adds about {price} PAT to the queue, charged as it plays (only what actually plays). Add it?', { price: fmt(d.estimate) }),
              _t('js.plex.ask_add', 'Yes, add it'), btn, function () { addRunning(btn, key, d.estimate); });
          return;
        }
        say(e.message); info();
      }).then(function () { btn.disabled = false; });
    };
    // upnext2 (E): "+ Add to the queue" behind the single title on this pad - a queue of yours that plays after it (the pick's choices when
    // it's the picked title: scope, start point, quality, audio, subtitles)
    var addAfter = function (btn, key, est) {
      var pk = P.pick, body = { room: opts.roomId(), keys: [key], quality: QUALITY };
      if (picked && String(picked.key) === String(key) && pk.querySelector('[data-q]')) {
        var a = pk.querySelector('[data-a]'), s = pk.querySelector('[data-s]'), off = parseTime(pk.querySelector('[data-o]').value) || 0;
        body = { room: opts.roomId(), key: key, scope: scope(), offset: off, quality: Number(pk.querySelector('[data-q]').value),
                 audio: a ? a.value : null, sub: s && s.value !== '' ? s.value : null };
      }
      if (est != null) body.estimate = est;
      var now = onPad ? onPad.title : '';
      btn.disabled = true;
      api('POST', '/api/medialib/queue/after', body).then(function (j) {
        // (upnext3: in a line - behind someone else's queue, or others already lined up - it says where)
        say(j.line > 1 || j.behind_queue ? _t('js.plex.q_added_line', 'Lined up - your queue plays after “{now}”: {place} of {line} in line.', { now: j.behind || now, place: j.place || 1, line: j.line || 1 })
          : _t('js.plex.q_added_after', 'Added - it plays after “{now}” ({n} up next).', { now: j.behind || now, n: j.items }), true);
        info();
        if (opts.onStarted) { try { opts.onStarted({ after: true }); } catch (e) { /* the page's own */ } }
      }).catch(function (e) {
        var d = e.data || {};
        if (d.code === 'estimate' && d.estimate && d.estimate !== est) {
          btn.disabled = false;
          ask((lineMode() ? _t('js.plex.q_line_cost', 'Line up your own queue to play when “{now}”’s queue ends? About {price} points, charged to you as it plays (only what actually plays) - nothing is taken until it starts.', { now: now, price: fmt(d.estimate) })
                          : _t('js.plex.q_after_cost', 'Add it to play after “{now}”? About {price} PAT, charged as it plays (only what actually plays) - nothing is taken until it starts.', { now: now, price: fmt(d.estimate) })) + '\n\n' +
              _t('js.plex.q_rights', 'Only show what we have the rights to show - every play is logged.'),
              _t('js.plex.ask_add', 'Yes, add it'), btn, function () { addAfter(btn, key, d.estimate); });
          return;
        }
        say(e.message); info();
      }).then(function () { btn.disabled = false; });
    };
    listBox.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      var i;
      if (b.hasAttribute('data-lup')) { i = +b.getAttribute('data-lup'); list.splice(i - 1, 0, list.splice(i, 1)[0]); }
      else if (b.hasAttribute('data-ldown')) { i = +b.getAttribute('data-ldown'); list.splice(i + 1, 0, list.splice(i, 1)[0]); }
      else if (b.hasAttribute('data-lrm')) { list.splice(+b.getAttribute('data-lrm'), 1); }
      else if (b.hasAttribute('data-lclear')) { list = []; }
      else if (b.hasAttribute('data-lplay')) { startQueue(b, { room: opts.roomId(), keys: list.map(function (x) { return x.key; }), quality: QUALITY }); return; }
      saveList(); drawList();
    });
    drawList();
    var noteQueues = function (j) {
      var was = myQueue;
      myQueue = (j.queues || []).filter(function (q) { return q.state === 'active'; })[0] || null;
      if (!!was !== !!myQueue) drawAdd();                      // (upnext2: the "+" buttons say where they add to on THIS pad - on_pad)
    };
    function toPepe(id, n) {
      fetch('/api/stage/admin/onair', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ action: 'slot', slot_id: id }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (j) {
          var was = P.msg.textContent ? P.msg.textContent + ' ' : '';      // (review: after the started line, not instead of it)
          if (j && j.ok) { say(was + _t('js.plex.onair_on', '📺 It’s on Pepe’s stream too.'), true); return; }
          if (j && j.code === 'not_live' && n < 15) { setTimeout(function () { toPepe(id, n + 1); }, 4000); return; }
          say(was + _t('js.plex.onair_fail', '📺 Not on Pepe’s stream: {why}', { why: (j && j.error) || '?' }));
        }).catch(function () { say(_t('js.plex.onair_fail', '📺 Not on Pepe’s stream: {why}', { why: '?' })); });
    }
    return { info: info, drawPrice: drawPrice, noteQueues: noteQueues, myQueue: function () { return myQueue; } };
  }

  window.PATVPlexPlay = { mount: mount, build: build,
    util: { api: api, hms: hms, parseTime: parseTime, day: day, label: label, noticeText: noticeText, fmt: fmt, esc: esc } };
})();
