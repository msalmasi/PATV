// onair-bar.js — 📺 on Pepe's OBS from his stream player (1.99aan; onair.js decides everything). Site staff only (Admin /
// Staff - GET /api/stage/admin/onair answers 403 to anyone else and this script then does nothing). Below Pepe's player,
// on the same row as the Snap / Clip bar (1.99aao; the bar sits at the right end of it):
//   "On air: <what> · 0:24 left" + ✂ Cut   only while something is on air (or waiting for an owner's OK); a confirm step, then
//                                  the same action as the card's Take off / !onair off (audited the same way) - both lanes
//   "↗ Corner: <what>" + ✂         1.99acw: a picture / card / live page in the corner lane (✂ there clears only the corner)
//   ⛔ (per lane)                  1.99acw review: Cut + block a picture / card / live page - off air, its stored picture deleted,
//                                  that picture / link never again; the Image tab lists recent pictures with ⛔ Block too
//   📺 Play content here          a compact picker of everything that can go on Pepe's OBS, in TABS (1.99acw; the tab you
//                                  used last is remembered in this browser):
//                                  📺 Streams & cams: live pad slots (streams, embeds, 📼) and cams - with the card's rules
//                                  (the rights tick for an embed, "Ask the owner" for an Approved-only pad / a cam without an
//                                  opt-in),
//                                  ▶ YouTube / Twitch: a link pasted straight in (1.99aao; the rights tick every time),
//                                  🖼 Image (1.99acw): a picture link or an upload - fetched, re-encoded and safety-checked by
//                                  the site, shown full screen or in a corner with a caption for a set time; "Load directly
//                                  (staff)" skips the check (only offered to those who may),
//                                  🔗 Link (1.99acw): a link as a card (title, picture, site) or - staff, when live pages are
//                                  on - the live page itself,
//                                  🎥 Go live (1.99aaq): a slot on Pepe's pad - OBS key / WHIP / browser on /stage - that goes
//                                  on air the moment it's live (nothing on OBS before that),
//                                  📼 Plex: a title searched and played on Pepe's own pad (1.99aao; needs allow_library).
//                                  The server applies everything (IRL wins, the Main scene).
//                                  1.99abj: ⏰ Queue instead - next up (after what's on) or at a time picked here (your
//                                  browser's clock; Pepe's chat uses New York time) - and the shared "Up next" list.
// stage-room.js calls PATVOnAirBar.sync(playerBox) whenever the stage view changes.
(function () {
  'use strict';
  var data = null, dead = false, row = null, bar = null, panel = null, box = null, timer = null, ticker = null, RIGHTS = {}, PLEX = null, plexBusy = false;
  var skew = 0, jobTimer = null, uploading = false;
  var TABS = [['streams', '📺 Streams & cams'], ['link', '▶ YouTube / Twitch'], ['image', '🖼 Image'], ['card', '🔗 Link'], ['golive', '🎥 Go live'], ['plex', '📼 Plex']];
  var TAB_KEY = 'patv.onair.tab';
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function getTab() { try { var t = window.localStorage.getItem(TAB_KEY); return TABS.some(function (x) { return x[0] === t; }) ? t : 'streams'; } catch (e) { return 'streams'; } }
  function setTab(t) { try { window.localStorage.setItem(TAB_KEY, t); } catch (e) { /* private window */ } }
  function api(body) {
    return fetch('/api/stage/admin/onair', body ? { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) } : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { if (!body) dead = true; }
        return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; });
      });
  }
  function took(j) { if (j && j.now) skew = Number(j.now) - Date.now(); }
  function load() {
    if (dead) return;
    api().then(function (j) { if (j && j.ok) { data = j; took(j); paint(); } else if (dead) teardown(); }).catch(function () { /* next poll */ });
  }
  function teardown() {
    if (panel) panel.remove();
    if (row) {                                      // give the Snap / Clip bar back its own place
      var cap = row.querySelector('.stcap');
      if (cap) row.parentNode.insertBefore(cap, row);
      row.remove();
    }
    row = bar = panel = null;
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function css() {
    var s = document.createElement('style');
    s.textContent =
      '.oab-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 10px;margin:10px 0 0;min-width:0}' +
      '.oab-row>.stcap{margin:0!important;flex:1 1 auto;min-width:0}' +
      '.oab{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;margin:0 0 0 auto;font:13px var(--ds-font,sans-serif);min-width:0}' +
      '.oab .oab-now{color:var(--ds-text-2,#ccc);min-width:0;overflow-wrap:anywhere}.oab .oab-now b{color:var(--ds-text-strong,#fff)}' +
      '.oab .oab-left{font-variant-numeric:tabular-nums;color:var(--ds-text-muted,#aaa)}' +
      '.oab button,.oap button{min-height:36px;padding:0 12px;border-radius:999px;border:1px solid var(--ds-line-strong,#444);background:#161616;color:#eee;font:13px var(--ds-font,sans-serif);cursor:pointer}' +
      '.oab button:hover,.oap button:hover{border-color:#5fd0e6}.oab .oab-cut{border-color:#b3261e;color:#ffb4ab}.oap button:disabled{opacity:.55;cursor:default}' +
      '.oap{margin:8px 0 0;padding:10px 12px;border:1px solid var(--ds-line-strong,#333);border-radius:12px;background:var(--card,#111);font:13px var(--ds-font,sans-serif)}' +
      '.oap h4{margin:10px 0 6px;font-size:13px;color:var(--ds-text-2,#bbb)}.oap ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}' +
      '.oap li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;padding:6px 0;border-top:1px solid #222}' +
      '.oap .oap-who{min-width:0;overflow-wrap:anywhere}.oap .oap-why{color:var(--ds-text-muted,#999);font-size:12px}.oap .oap-msg{color:var(--ds-warn,#e8b);min-height:16px;margin:8px 0 0;overflow-wrap:anywhere}' +
      '.oap label{font-size:12px;color:var(--ds-text-2,#ccc)}.oap .oap-top{display:flex;justify-content:space-between;align-items:center;gap:8px}' +
      '.oap form{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}' +
      '.oap input[type=url],.oap input[type=search],.oap input[type=text]{flex:1 1 220px;min-width:0;min-height:36px;padding:0 12px;border-radius:999px;border:1px solid var(--ds-line-strong,#444);background:#0d0d0d;color:#eee;font:13px var(--ds-font,sans-serif)}' +
      '.oap input[type=file]{max-width:100%;font:12px var(--ds-font,sans-serif);color:#ccc}' +
      '.oap select,.oap .oap-gl input{min-height:36px;padding:0 10px;border-radius:8px;border:1px solid var(--ds-line-strong,#444);background:#0d0d0d;color:#eee;font:13px var(--ds-font,sans-serif);max-width:100%}' +
      '.oap .oap-gl p{margin:6px 0;overflow-wrap:anywhere}.oap .oap-gl input{width:min(340px,100%)}' +
      '.oap .oap-plex li img{width:32px;height:48px;object-fit:cover;border-radius:4px;background:#222;flex:0 0 auto}' +
      '.oap .oap-plex .oap-who{display:flex;align-items:center;gap:8px;flex:1 1 200px}' +
      '.oap input[type=datetime-local]{min-height:36px;padding:0 10px;border-radius:8px;border:1px solid var(--ds-line-strong,#444);background:#0d0d0d;color:#eee;font:13px var(--ds-font,sans-serif);max-width:100%;color-scheme:dark}' +
      '.oap .oap-q b{font-variant-numeric:tabular-nums}' +
      '.oap .oap-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px}.oap .oap-tabs button{min-height:32px;padding:0 10px}' +
      '.oap .oap-tabs button[aria-selected=true]{border-color:#76ff03;color:#c8ff9e;background:#14200f}' +
      '.oap .oap-sec{margin:6px 0 0}.oap .oap-warn{margin:6px 0 0;padding:8px 10px;border-radius:8px;border:1px solid #8a5a00;background:#2a1d00;color:#ffd68a;font-size:12px;width:100%}' +
      '.oap .oap-job{margin:8px 0 0;font-size:12px;color:var(--ds-text-2,#ccc);display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.oap .oap-job img{max-width:120px;max-height:68px;border-radius:6px;background:#000}.oap .oap-or{color:var(--ds-text-muted,#999);font-size:12px}' +
      '.oap .oap-rec{margin:8px 0 0}.oap .oap-rec summary{cursor:pointer;color:var(--ds-text-2,#bbb)}' +
      '.oap .oap-rec .oap-who{display:flex;align-items:center;gap:8px;flex:1 1 220px}.oap .oap-rec img{width:64px;height:36px;object-fit:contain;border-radius:4px;background:#000;flex:0 0 auto}';
    document.head.appendChild(s);
  }
  var waiting = function (T) { return !!(T && T.start_until && !T.went_live); };   // a go-live / 📼 pick whose stream hasn't started
  function msg(text) { var m = panel && panel.querySelector('.oap-msg'); if (m) m.textContent = text || ''; }
  function act(body, done) {
    msg('Working…');
    return api(body).then(function (j) {
      if (!j.ok) {
        if (j.code === 'no_optin' || j.code === 'pad_private') { msg(j.error); done && done(j); return; }
        msg(j.error || 'Couldn’t do that.'); return;
      }
      data = j; took(j); paint();
      done && done(j);
      var T = j.target;
      msg(!T ? 'Off Pepe’s stream.' : (T.pending || []).length ? 'Asked the owner - it goes on air once they allow it.' : waiting(T) ? 'Waiting for the stream - it goes on air as soon as it’s live.' : 'On Pepe’s stream now (Pepe switches OBS in a few seconds).');
    }).catch(function () { msg('Couldn’t reach the site.'); });
  }
  // the Snap / Clip bar and this bar share one row under the player (no half-empty rows)
  function place() {
    if (!row) row = el('div', 'oab-row');
    if (row.parentNode !== box.parentNode || row.previousSibling !== box) box.parentNode.insertBefore(row, box.nextSibling);
    var cap = row.nextElementSibling && row.nextElementSibling.classList.contains('stcap') ? row.nextElementSibling : null;
    if (cap) row.insertBefore(cap, row.firstChild);
    if (bar.parentNode !== row) row.appendChild(bar);
    if (panel && panel.previousSibling !== row) row.parentNode.insertBefore(panel, row.nextSibling);
  }
  function fmtLeft(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function leftOf(T) { return T && T.kind === 'media' && T.media && T.media.until ? fmtLeft(T.media.until - (Date.now() + skew)) : ''; }
  function tick() {
    if (!bar) return;
    Array.prototype.forEach.call(bar.querySelectorAll('[data-left]'), function (s) {
      var T = s.getAttribute('data-left') === 'corner' ? data && data.overlay : data && data.target;
      s.textContent = T ? ' · ' + leftOf(T) + ' left' : '';
    });
  }
  function paint() {
    if (!data || !box) return;
    if (!bar) {
      bar = el('div', 'oab');
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', 'Pepe’s OBS (staff)');
      bar.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        var what = b.getAttribute('data-oab');
        if (what === 'cut') {
          var T = data && data.target, O = data && data.overlay;
          var label = [T && T.label, O && ('corner: ' + O.label)].filter(Boolean).join(' and ');
          if (!label || !window.confirm('Take “' + label + '” off Pepe’s stream?')) return;
          api({ action: 'off' }).then(function (j) { if (j.ok) { data = j; took(j); paint(); } else window.alert(j.error || 'Couldn’t take it off.'); });
        }
        if (what === 'cutcorner') {
          var O2 = data && data.overlay;
          if (!O2 || !window.confirm('Take “' + O2.label + '” out of the corner?')) return;
          api({ action: 'off', lane: 'corner' }).then(function (j) { if (j.ok) { data = j; took(j); paint(); } else window.alert(j.error || 'Couldn’t take it off.'); });
        }
        // 1.99acw review: ⛔ Cut + block - off air AND never again (its stored picture deleted, its hash + link remembered)
        if (what === 'block' || what === 'blockcorner') {
          var B = what === 'block' ? data && data.target : data && data.overlay;
          if (!B || !window.confirm('Cut “' + B.label + '” AND block it - its picture is deleted and that picture / link can never go on Pepe’s stream again?')) return;
          api({ action: 'off', lane: what === 'block' ? 'main' : 'corner', block: true })
            .then(function (j) { if (j.ok) { data = j; took(j); paint(); } else window.alert(j.error || 'Couldn’t block it.'); });
        }
        if (what === 'play') { if (panel) { panel.remove(); panel = null; } else openPanel(); }
      });
    }
    place();
    var T = data.target, O = data.overlay, C = data.cfg || {};
    var canBlock = !!(data.media && data.media.can && data.media.can.block);
    var h = '';
    if (T) h += '<span class="oab-now">' + ((T.pending || []).length ? '⏳ Waiting for the owner: ' : waiting(T) ? '⏳ Waiting for the stream: ' : '📺 On air: ') + '<b>' + esc(T.label) + '</b>' +
      (T.kind === 'media' ? '<span class="oab-left" data-left="main"></span>' : '') + '</span>' +
      (T.kind === 'media' && canBlock ? '<button type="button" class="oab-cut" data-oab="block" title="Cut + block: never on Pepe’s stream again" aria-label="Cut and block the main picture or link">⛔</button>' : '');
    if (O) h += '<span class="oab-now">↗ Corner: <b>' + esc(O.label) + '</b><span class="oab-left" data-left="corner"></span></span>' +
      '<button type="button" class="oab-cut" data-oab="cutcorner" aria-label="Clear the corner">✂</button>' +
      (canBlock ? '<button type="button" class="oab-cut" data-oab="blockcorner" title="Cut + block: never on Pepe’s stream again" aria-label="Cut and block the corner picture or link">⛔</button>' : '');
    if (T || O) h += '<button type="button" class="oab-cut" data-oab="cut">✂ Cut</button>';
    h += '<button type="button" data-oab="play"' + (C.enabled ? '' : ' disabled title="On-air is switched off (/stage/admin)"') + '>📺 Play content here</button>';
    bar.innerHTML = h;
    tick();
    if ((T && T.kind === 'media') || O) { if (!ticker) ticker = setInterval(tick, 1000); }
    else if (ticker) { clearInterval(ticker); ticker = null; }
    if (panel) fillPanel();
  }
  function plexList() {
    if (PLEX == null) return '';
    if (!PLEX.length) return '<li class="oap-why">Nothing found.</li>';
    return PLEX.map(function (it) {
      var sub = [it.year, it.type === 'episode' && it.show ? it.show : null, it.duration ? Math.round(it.duration / 60) + ' min' : null].filter(Boolean).join(' · ');
      var playable = it.type === 'movie' || it.type === 'episode';
      return '<li><span class="oap-who"><img alt="" loading="lazy" onerror="this.style.visibility=\'hidden\'" src="/api/medialib/poster/' + encodeURIComponent(it.key) + '"><span>📼 ' + esc(it.title) +
        (sub ? ' <span class="oap-why">' + esc(sub) + '</span>' : '') + '</span></span>' +
        (playable ? '<button type="button" data-plex="' + esc(it.key) + '">📺 Play</button>'
          : it.type === 'show' ? '<button type="button" data-show="' + esc(it.key) + '">Episodes</button>' : '') + '</li>';
    }).join('');
  }
  // ── 1.99acw: pictures / cards / live pages ──
  var DURS = [[10, '10 s'], [30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']];
  function durOptions(max, def) {
    var list = DURS.filter(function (d) { return d[0] <= max; });
    if (!list.length) list = [[max, max + ' s']];
    var pick = list.reduce(function (a, d) { return d[0] <= def ? d : a; }, list[0]);
    return list.map(function (d) { return '<option value="' + d[0] + '"' + (d === pick ? ' selected' : '') + '>' + esc(d[1]) + '</option>'; }).join('');
  }
  function layoutFields() {
    return '<select name="layout" aria-label="Layout"><option value="full">Full screen</option><option value="corner">Corner</option></select>' +
      '<select name="corner" aria-label="Which corner" disabled><option value="tl">↖ top left</option><option value="tr" selected>↗ top right</option>' +
      '<option value="bl">↙ bottom left</option><option value="br">↘ bottom right</option></select>';
  }
  function laterFields(what) {
    return '<label><input type="checkbox" name="rights"> I have the rights to rebroadcast this</label>' +
      '<button type="submit">📺 Show now</button>' +
      '<button type="submit" data-later="1" title="Next up when its spot is free, or at the time you pick">⏰ Queue</button>' +
      '<label>at <input type="datetime-local" name="at" aria-label="' + esc(what) + ' at (optional)"></label>';
  }
  function mediaTabs() {
    var MD = (data && data.media) || {}, max = MD.max || {}, def = MD.defaults || {}, can = MD.can || {};
    var img = '<form class="oap-img" autocomplete="off">' +
      '<input type="url" name="url" placeholder="Paste a picture link (PNG, JPEG, GIF, WebP)" aria-label="Picture link">' +
      '<span class="oap-or">or</span><input type="file" name="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Upload a picture">' +
      '<input type="text" name="caption" maxlength="' + esc(max.caption || 120) + '" placeholder="Caption (optional)" aria-label="Caption">' +
      '<select name="secs" aria-label="How long" data-max="' + esc(max.media_s || 600) + '" data-direct-max="' + esc(max.direct_s || 120) + '" data-def="' + esc(def.media_secs || 30) + '">' +
      durOptions(max.media_s || 600, def.media_secs || 30) + '</select>' + layoutFields() +
      (can.direct ? '<label title="Skips the safety check: Pepe’s OBS loads it straight from its site"><input type="checkbox" name="direct"> Load directly (staff)</label>' +
        '<p class="oap-warn" data-warn="direct" hidden>⚠ Not safety-scanned. Pepe’s OBS loads it straight from that site - the site sees Pepe’s home internet address and can change the picture while it’s up. At most ' + esc(fmtSecs(max.direct_s || 120)) + '.' +
        (MD.direct_why && MD.ready ? ' ' + esc(MD.direct_why) : '') + '</p>' : '') +
      laterFields('Show the picture') + '</form><div class="oap-job" data-job="image"></div>' +
      '<p class="oap-why">The site fetches the picture, re-encodes it and runs the safety check (Pepe’s stream is relayed to Twitch) - anything not clearly safe is refused, never shown. Up to ' + esc(max.image_mb || 8) + ' MB; animations up to 20 s and 36 different frames.</p>' +
      '<div class="oap-recent"></div>';
    var liveOk = can.live && MD.live_pages;
    var card = '<form class="oap-card" autocomplete="off">' +
      '<input type="url" name="url" placeholder="Paste a link" aria-label="Link">' +
      '<select name="mode" aria-label="Show as"><option value="card">Card (title, picture, site)</option>' +
      (liveOk ? '<option value="live">Live page (staff)</option>' : '') + '</select>' +
      (liveOk ? '<label data-live-only hidden><input type="checkbox" name="sound"> With sound</label>' : '') +
      '<input type="text" name="caption" maxlength="' + esc(max.caption || 120) + '" placeholder="Caption (optional)" aria-label="Caption">' +
      '<select name="secs" aria-label="How long" data-max="' + esc(max.media_s || 600) + '" data-live-max="' + esc(max.live_s || 600) + '" data-def="' + esc(def.media_secs || 30) + '" data-live-def="' + esc(def.live_secs || 60) + '">' +
      durOptions(max.media_s || 600, def.media_secs || 30) + '</select>' + layoutFields() +
      (liveOk ? '<p class="oap-warn" data-warn="live" hidden>⚠ Pepe’s OBS opens the page itself: the site sees Pepe’s home internet address. Muted unless With sound. At most ' + esc(fmtSecs(max.live_s || 600)) + '.</p>' : '') +
      laterFields('Show the link') + '</form><div class="oap-job" data-job="card"></div>' +
      (can.live && !MD.live_pages ? '<p class="oap-why">Live pages are switched off (/stage/admin).</p>' : '');
    return { img: img, card: card };
  }
  function fmtSecs(s) { s = Number(s) || 0; return s >= 60 ? Math.round(s / 60) + ' min' : s + ' s'; }
  function syncMediaForm(f) {
    if (!f) return;
    var corner = f.layout && f.layout.value === 'corner';
    if (f.corner) f.corner.disabled = !corner;
    var sel = f.secs;
    if (f.classList.contains('oap-img')) {
      var direct = !!(f.direct && f.direct.checked);
      if (f.file) f.file.disabled = direct;
      var w = f.querySelector('[data-warn=direct]'); if (w) w.hidden = !direct;
      var max = Number(sel.getAttribute(direct ? 'data-direct-max' : 'data-max')) || 600, cur = Number(sel.value);
      if (sel.getAttribute('data-for') !== String(direct)) { sel.innerHTML = durOptions(max, Math.min(cur || Number(sel.getAttribute('data-def')), max)); sel.setAttribute('data-for', String(direct)); }
    } else if (f.classList.contains('oap-card')) {
      var live = f.mode && f.mode.value === 'live';
      Array.prototype.forEach.call(f.querySelectorAll('[data-live-only]'), function (x) { x.hidden = !live; });
      var lw = f.querySelector('[data-warn=live]'); if (lw) lw.hidden = !live;
      if (sel.getAttribute('data-for') !== String(live)) {
        sel.innerHTML = live ? durOptions(Number(sel.getAttribute('data-live-max')) || 600, Number(sel.getAttribute('data-live-def')) || 60)
          : durOptions(Number(sel.getAttribute('data-max')) || 600, Number(sel.getAttribute('data-def')) || 30);
        sel.setAttribute('data-for', String(live));
      }
    }
  }
  function jobBox(which, html) { var b = panel && panel.querySelector('[data-job=' + which + ']'); if (b) b.innerHTML = html || ''; }
  function previewOf(id) {
    var T = [data && data.target, data && data.overlay].filter(function (x) { return x && x.id === id; })[0];
    var a = T && T.media && T.media.asset;
    return a && /^[a-f0-9]{32}\.webp$/.test(a.file) ? '<img alt="" src="/onair/m/' + esc(a.file) + '">' : '';
  }
  // 1.99acw review: the form is cleared only once its job is DONE; a refusal (often seconds later: not clearly safe, a page not a
  // picture, too big...) keeps the link, caption, layout, corner and time - only the rights tick has to be given again
  var FORMS = {};
  function settle(which, done) {
    var f = FORMS[which];
    if (!f || !f.isConnected) return;
    if (done) { f.reset(); syncMediaForm(f); FORMS[which] = null; }
    else if (f.rights) f.rights.checked = false;
  }
  function showJob(which, job) {
    if (!job) return;
    if (job.final) {
      jobBox(which, (job.state === 'done' && job.result && job.result.id ? previewOf(job.result.id) : '') + '<span>' + esc(job.msg) + '</span>');
      msg(job.state === 'done' ? '' : job.msg);
      settle(which, job.state === 'done');
      load();
      return;
    }
    jobBox(which, '<span>⏳ ' + esc(job.msg) + '</span>');
    if (jobTimer) clearTimeout(jobTimer);
    jobTimer = setTimeout(function () {
      fetch('/api/stage/admin/onair/job/' + encodeURIComponent(job.id), { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); })
        .then(function (j) { if (j.ok && j.job) showJob(which, j.job); else { jobBox(which, '<span>' + esc(j.error || 'That check is gone - try again.') + '</span>'); } })
        .catch(function () { showJob(which, job); });
    }, 1500);
  }
  function sendMedia(which, body, f) {
    msg('Working…');
    jobBox(which, '<span>⏳ Starting…</span>');
    FORMS[which] = f || null;
    return api(body).then(function (j) {
      if (j.now) took(j);
      if (j.target !== undefined) { data = j; paint(); }
      if (!j.ok) { jobBox(which, ''); msg(j.error || 'Couldn’t do that.'); settle(which, false); return; }
      msg('');
      showJob(which, j.job);
    }).catch(function () { jobBox(which, ''); msg('Couldn’t reach the site.'); });
  }
  function uploadPicture(file) {
    var CHUNK = 512 * 1024;
    var post = function (url, body) {
      return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
    };
    return post('/api/feed/uploads', { kind: 'image', size: file.size, name: String(file.name || '').slice(0, 100), purpose: 'onair' }).then(function (d) {
      var id = d.id, chunk = d.chunk || CHUNK, off = 0;
      function next() {
        if (off >= file.size) return post('/api/feed/uploads/' + id + '/finish', {}).then(function () { return id; });
        var part = file.slice(off, Math.min(file.size, off + chunk));
        return fetch('/api/feed/uploads/' + id + '?offset=' + off, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' }, body: part })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
          .then(function (j) { off = j.received; jobBox('image', '<span>⏳ Uploading… ' + Math.round((off / file.size) * 100) + '%</span>'); return next(); });
      }
      return next();
    }).then(function (id) {
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          fetch('/api/feed/uploads/' + id, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
            if (j.state === 'ready') return resolve(id);
            if (j.state === 'failed' || j.state === 'deleted' || !j.ok) return reject(new Error(j.error || 'That file couldn’t be processed.'));
            if (++tries > 150) return reject(new Error('Processing took too long.'));
            setTimeout(poll, tries < 10 ? 800 : 2000);
          }).catch(function () { setTimeout(poll, 3000); });
        })();
      });
    });
  }
  function mediaSubmit(f, later) {
    var which = f.classList.contains('oap-img') ? 'image' : 'card';
    var url = f.url.value.trim(), file = f.file && f.file.files && f.file.files[0];
    var direct = !!(f.direct && f.direct.checked);
    if (!url && !file) { msg(which === 'image' ? 'Paste a picture link or pick a file.' : 'Paste a link.'); return; }
    if (!f.rights.checked) { msg('Tick “I have the rights to rebroadcast this” first.'); return; }
    if (!later && f.at.value) later = true;
    var at = f.at.value ? new Date(f.at.value).getTime() : null;
    if (f.at.value && !isFinite(at)) { msg('That time isn’t valid.'); return; }
    var mode = which === 'image' ? 'image' : (f.mode.value === 'live' ? 'live' : 'card');
    if (mode === 'live' && !window.confirm('Pepe’s OBS will open this page itself - the site sees Pepe’s home internet address. Continue?')) return;
    if (direct && !window.confirm('Show it without the safety check, loaded straight from its site (it sees Pepe’s home internet address)?')) return;
    var body = { action: 'media', mode: mode, caption: f.caption.value.trim(), secs: Number(f.secs.value), layout: f.layout.value,
                 corner: f.layout.value === 'corner' ? f.corner.value : undefined, rights: true, queue: !!later, at: later ? at : null };
    if (mode === 'image') body.direct = direct;
    if (mode === 'live') body.sound = !!(f.sound && f.sound.checked);
    if (which === 'image' && file && !url) {
      if (uploading) return;
      uploading = true;
      jobBox('image', '<span>⏳ Uploading…</span>');
      uploadPicture(file).then(function (id) { body.upload = id; return sendMedia('image', body, f); })
        .catch(function (e) { jobBox('image', ''); msg(e.message || 'The upload failed.'); })
        .then(function () { uploading = false; });
      return;
    }
    body.url = url;
    sendMedia(which, body, f);
  }
  function openPanel() {
    panel = el('div', 'oap');
    var C = (data && data.cfg) || {}, MD = (data && data.media) || {};
    var mt = mediaTabs();
    var tab = getTab();
    var mediaOff = !MD.enabled ? '<p class="oap-why">Pictures and links are switched off (/stage/admin).</p>'
      : !MD.ready && MD.why ? '<p class="oap-why">' + esc(MD.why) + '</p>' : '';
    panel.innerHTML = '<div class="oap-top"><b>📺 Play on Pepe’s stream + his Camfrog cam</b><button type="button" data-x="1" aria-label="Close">✕</button></div>' +
      '<div class="oap-tabs" role="tablist">' + TABS.map(function (t) {
        return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (t[0] === tab ? 'true' : 'false') + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div>' +
      '<div class="oap-sec" data-sec="streams"><div class="oap-live"></div></div>' +
      '<div class="oap-sec" data-sec="link"><h4>▶ YouTube / Twitch link</h4>' +
      '<form class="oap-link"><input type="url" name="url" placeholder="Paste a YouTube or Twitch link" aria-label="YouTube or Twitch link" autocomplete="off">' +
      '<label><input type="checkbox" name="rights"> I have the rights to rebroadcast this</label><button type="submit">📺 Play</button>' +
      '<button type="submit" data-later="1" title="Next up after what’s on now, or at the time you pick">⏰ Queue</button>' +
      '<label>at <input type="datetime-local" name="at" aria-label="Play at (optional)"></label></form></div>' +
      '<div class="oap-sec" data-sec="image"><h4>🖼 A picture</h4>' + mediaOff + mt.img + '</div>' +
      '<div class="oap-sec" data-sec="card"><h4>🔗 A link</h4>' + mediaOff + mt.card + '</div>' +
      '<div class="oap-sec" data-sec="golive"><h4>🎥 Go live on Pepe’s stream</h4>' +
      '<form class="oap-golive"><select name="minutes" aria-label="How long"><option value="30">30 min</option><option value="60" selected>1 hour</option>' +
      '<option value="120">2 hours</option><option value="180">3 hours</option></select>' +
      '<input type="search" name="title" placeholder="Title (optional)" aria-label="Title" maxlength="80" autocomplete="off"><button type="submit">🎥 Get my stream key</button></form>' +
      '<div class="oap-gl"></div></div>' +
      '<div class="oap-sec" data-sec="plex"><h4>📼 Plex</h4>' +
      (C.allow_library
        ? '<form class="oap-plexq"><input type="search" name="q" placeholder="Search the library" aria-label="Search the Plex library" autocomplete="off"><button type="submit">Search</button></form>' +
          '<ul class="oap-plex"></ul>'
        : '<p class="oap-why">Plex on Pepe’s stream is switched off (Allow library plays on /stage/admin) - his stream is relayed to Twitch.</p>') + '</div>' +
      '<div class="oap-queue"></div>' +
      '<p class="oap-msg" role="status" aria-live="polite"></p>' +
      '<p class="oap-why">Your IRL feed always wins over the pick; OBS switches to the on-air scene by itself. Settings and the log: /stage/admin.</p>';
    row.parentNode.insertBefore(panel, row.nextSibling);
    var showTab = function (t) {
      Array.prototype.forEach.call(panel.querySelectorAll('[data-sec]'), function (s) { s.hidden = s.getAttribute('data-sec') !== t; });
      Array.prototype.forEach.call(panel.querySelectorAll('[data-tab]'), function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === t ? 'true' : 'false'); });
    };
    showTab(tab);
    Array.prototype.forEach.call(panel.querySelectorAll('form.oap-img, form.oap-card'), syncMediaForm);
    panel.addEventListener('change', function (e) {
      var r = e.target.closest('[data-rights]'); if (r) RIGHTS[r.getAttribute('data-rights')] = r.checked;
      var mf = e.target.closest('form.oap-img, form.oap-card'); if (mf) syncMediaForm(mf);
    });
    panel.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      if (f.classList.contains('oap-img') || f.classList.contains('oap-card')) {
        mediaSubmit(f, !!(e.submitter && e.submitter.hasAttribute('data-later')));
        return;
      }
      if (f.classList.contains('oap-golive')) {
        var T0 = data && data.target;
        if (T0 && !window.confirm('This replaces “' + T0.label + '” on Pepe’s stream as soon as you go live. Continue?')) return;
        act({ action: 'golive', minutes: Number(f.minutes.value), title: f.title.value.trim() }, function (j) {
          var g = j && j.ok && j.golive, gbox = panel && panel.querySelector('.oap-gl');
          if (!g || !gbox) return;
          gbox.innerHTML = '<p>Stream from <b>OBS</b> (Settings → Stream → Custom), within ' + esc(g.wait_min) + ' minutes - it goes on Pepe’s stream as soon as it’s live:</p>' +
            '<p><label>Server <input type="text" readonly value="' + esc(g.rtmp ? g.rtmp.server : '') + '"></label> <button type="button" data-copy="0">Copy</button></p>' +
            '<p><label>Stream key <input type="password" readonly value="' + esc(g.rtmp ? g.rtmp.key : '') + '"></label> <button type="button" data-copy="1">Copy</button></p>' +
            // 1.99aay: WHIP right here (OBS 30+: Settings → Stream → Service "WHIP"; lower delay than RTMP)
            (g.whip ? '<p><b>Or WHIP</b> (OBS 30+: Service → WHIP):</p>' +
              '<p><label>Server <input type="text" readonly value="' + esc(g.whip.url) + '"></label> <button type="button" data-copy="2">Copy</button></p>' +
              '<p><label>Bearer token <input type="password" readonly value="' + esc(g.whip.token) + '"></label> <button type="button" data-copy="3">Copy</button></p>' : '') +
            '<p class="oap-why">In OBS: audio on (AAC, track 1) and keyframe interval 2 s - a stream without audio frames won’t play on the site. ' +
            'Browser camera: <a href="' + esc(g.page) + '" target="_blank" rel="noopener">your slot on /stage</a>. ✂ Cut or ending the slot takes it off.</p>';
        });
      } else if (f.classList.contains('oap-link')) {
        var url = f.url.value.trim();
        if (!url) { msg('Paste a YouTube or Twitch link.'); return; }
        if (!f.rights.checked) { msg('Tick “I have the rights to rebroadcast this” first.'); return; }
        var later = !!(e.submitter && e.submitter.hasAttribute('data-later'));
        if (!later && f.at.value) later = true;              // a time picked = queue it, even from 📺 Play
        if (later) {
          var at = f.at.value ? new Date(f.at.value).getTime() : null;
          if (f.at.value && !isFinite(at)) { msg('That time isn’t valid.'); return; }
          msg('Working…');
          api({ action: 'queue', url: url, at: at, rights: true }).then(function (j) {
            if (!j.ok) { msg(j.error || 'Couldn’t queue that.'); return; }
            data = j; took(j); paint(); f.reset();
            msg(at ? '⏰ Queued for ' + new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' - it replaces whatever is on then.' : '⏰ Queued - it plays after what’s on now.');
          }).catch(function () { msg('Couldn’t reach the site.'); });
          return;
        }
        act({ action: 'embed', url: url, rights: true }, function (j) { if (j && j.ok) { f.reset(); } });
      } else if (f.classList.contains('oap-plexq')) {
        var q = f.q.value.trim();
        if (q.length < 2) { msg('Type at least 2 characters.'); return; }
        if (plexBusy) return;
        plexBusy = true; msg('Searching…');
        fetch('/api/medialib/search?q=' + encodeURIComponent(q), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); })
          .then(function (j) {
            if (!j.ok) { msg(j.error || 'Couldn’t search the library.'); return; }
            PLEX = j.results || []; msg('');
            var ul = panel && panel.querySelector('.oap-plex'); if (ul) ul.innerHTML = plexList();
          })
          .catch(function () { msg('Couldn’t reach the site.'); })
          .then(function () { plexBusy = false; });
      }
    });
    panel.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || b.type === 'submit') return;
      if (b.getAttribute('data-x') === '1') { panel.remove(); panel = null; return; }
      if (b.hasAttribute('data-tab')) { var t = b.getAttribute('data-tab'); setTab(t); showTab(t); msg(''); return; }
      if (b.hasAttribute('data-mblock')) {
        if (!window.confirm('Block this picture? It goes off Pepe’s stream wherever it shows, is deleted, and that picture / link can never go on again.')) return;
        b.disabled = true;
        api({ action: 'media_block', asset: b.getAttribute('data-mblock') }).then(function (j) {
          if (j.ok) { data = j; took(j); paint(); msg('Blocked.'); } else { b.disabled = false; msg(j.error || 'Couldn’t block it.'); }
        }).catch(function () { b.disabled = false; msg('Couldn’t reach the site.'); });
        return;
      }
      if (b.hasAttribute('data-unq')) {
        b.disabled = true;
        api({ action: 'unqueue', id: b.getAttribute('data-unq') }).then(function (j) {
          if (j.ok) { data = j; took(j); paint(); msg('Removed from the queue.'); } else { b.disabled = false; msg(j.error || 'Couldn’t remove it.'); }
        }).catch(function () { b.disabled = false; msg('Couldn’t reach the site.'); });
        return;
      }
      if (b.hasAttribute('data-copy')) {
        var inp = panel.querySelectorAll('.oap-gl input')[Number(b.getAttribute('data-copy'))];
        if (!inp) return;
        var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inp.value).then(done, function () { inp.type = 'text'; inp.select(); });
        else { inp.type = 'text'; inp.select(); }
        return;
      }
      if (b.hasAttribute('data-show')) {                     // a show: list its episodes in place of the results
        msg('Loading…');
        fetch('/api/medialib/item/' + encodeURIComponent(b.getAttribute('data-show')), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); })
          .then(function (j) {
            if (!j.ok || !j.item) { msg(j.error || 'Couldn’t load that show.'); return; }
            PLEX = (j.item.episodes || []).slice().sort(function (a, c) { return (a.season - c.season) || (a.episode - c.episode); }).map(function (ep) {
              return { key: ep.key, type: 'episode', show: j.item.title, duration: ep.duration, title: 'S' + ep.season + 'E' + ep.episode + (ep.title ? ' ' + ep.title : '') };
            });
            msg('');
            var ul = panel && panel.querySelector('.oap-plex'); if (ul) ul.innerHTML = plexList();
          })
          .catch(function () { msg('Couldn’t reach the site.'); });
        return;
      }
      if (b.hasAttribute('data-plex')) {
        b.disabled = true;
        msg('Starting it on Pepe’s pad…');
        act({ action: 'library', key: b.getAttribute('data-plex') }).then(function () { b.disabled = false; });
        return;
      }
      var ask = b.getAttribute('data-ask') === '1';
      if (b.hasAttribute('data-slot')) {
        var id = b.getAttribute('data-slot');
        if (b.hasAttribute('data-embed') && !RIGHTS[id]) { msg('Tick “I have the rights to rebroadcast this” first.'); return; }
        act({ action: 'slot', slot_id: id, rights: !!RIGHTS[id], ask: ask });
      } else if (b.hasAttribute('data-login')) {
        act({ action: 'cam', room: b.getAttribute('data-room'), login: b.getAttribute('data-login'), ask: ask });
      }
    });
    fillPanel();
    load();
    var u = panel.querySelector('[data-sec="' + tab + '"] input[type=url]'); if (u) u.focus();
  }
  function line(label, sub, attrs, why, ask, rights, onNow) {
    var right;
    if (onNow) right = '<span class="oap-why">on air</span>';
    else if (why) right = '<span class="oap-why">' + esc((data.why || {})[why] || why) + '</span>';
    else right = (rights ? '<label><input type="checkbox" data-rights="' + esc(rights) + '"' + (RIGHTS[rights] ? ' checked' : '') + '> I have the rights to rebroadcast this</label> ' : '') +
      '<button type="button" ' + attrs + (ask ? ' data-ask="1"' : '') + '>' + (ask ? '📨 Ask the owner' : '📺 Play') + '</button>';
    return '<li><span class="oap-who">' + label + (sub ? ' <span class="oap-why">' + sub + '</span>' : '') + '</span><span>' + right + '</span></li>';
  }
  // only the live lists repaint on the 15 s poll; the forms and the Plex search keep what was typed
  // 1.99acw review: the recent on-air pictures (staff): a thumbnail, who sent it, where from - ⛔ Block takes it off wherever it
  // shows, deletes it and keeps that picture / link off Pepe's stream for good
  function recentList() {
    var MD = (data && data.media) || {}, R = MD.recent || [];
    if (!R.length) return '';
    return '<details class="oap-rec"><summary>🖼 Recent pictures (' + R.length + ')</summary><ul>' + R.map(function (a) {
      var thumb = a.file && /^[a-f0-9]{32}\.webp$/.test(a.file) ? '<img alt="" loading="lazy" src="/onair/m/' + esc(a.file) + '">' : '<span class="oap-why">' + esc(a.status) + '</span>';
      var src = a.src ? String(a.src) : (a.kind === 'upload' ? 'an upload' : '');
      return '<li><span class="oap-who">' + thumb + '<span>' + esc(new Date(a.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) +
        ' · by ' + esc(String(a.by || '?').replace(/^(web|pepe):/, '')) + (a.kind === 'card' ? ' · a card’s picture' : '') +
        (src ? ' · <span class="oap-why" title="' + esc(src) + '">' + esc(src.length > 70 ? src.slice(0, 69) + '…' : src) + '</span>' : '') + '</span></span>' +
        (a.status === 'ready' && MD.can && MD.can.block ? '<button type="button" data-mblock="' + esc(a.id) + '" title="Off air, deleted, never again">⛔ Block</button>' : '') + '</li>';
    }).join('') + '</ul></details>';
  }
  function fillPanel() {
    var rb = panel && panel.querySelector('.oap-recent');
    if (rb) { var open = !!rb.querySelector('details[open]'); rb.innerHTML = recentList(); if (open) { var d = rb.querySelector('details'); if (d) d.open = true; } }
    var qb = panel && panel.querySelector('.oap-queue');
    if (qb) {
      var Q = data.queue || [];
      qb.innerHTML = Q.length ? '<h4>⏰ Up next</h4><ul class="oap-q">' + Q.map(function (r) {
        return '<li><span class="oap-who"><b>' + (r.at ? esc(new Date(r.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : 'Next up') +
          '</b> ' + esc(r.label) + (r.lane === 'corner' ? ' <span class="oap-why">(corner)</span>' : '') + ' <span class="oap-why">by ' + esc(String(r.by || '').replace(/^(web|pepe):/, '')) + '</span></span>' +
          '<button type="button" data-unq="' + esc(r.id) + '" aria-label="Remove from the queue">✕</button></li>';
      }).join('') + '</ul>' : '';
    }
    var live = panel && panel.querySelector('.oap-live'); if (!live) return;
    var T = data.target;
    var slots = (data.slots || []).map(function (s) {
      var on = T && T.kind !== 'cam' && T.slot_id === s.id;
      return line(esc(s.display) + (s.title ? ' - ' + esc(s.title) : '') + (s.library ? ' 📼' : ''), esc(s.pad) + (s.embed ? ' · ' + esc(s.embed) : ''),
        'data-slot="' + esc(s.id) + '"' + (s.embed ? ' data-embed="1"' : ''), s.why, s.ask, s.embed ? s.id : null, on);
    }).join('');
    var cams = (data.cams || []).map(function (c) {
      var on = T && T.kind === 'cam' && T.room === c.room && T.login === c.login;
      return line('📷 ' + esc(c.display), esc(c.roomName), 'data-room="' + esc(c.room) + '" data-login="' + esc(c.login) + '"', c.why, c.ask, null, on);
    }).join('');
    live.innerHTML = '<h4>Live pad streams</h4><ul>' + (slots || '<li class="oap-why">No live slots.</li>') + '</ul>' +
      '<h4>Cams</h4><ul>' + (cams || '<li class="oap-why">Nobody is on cam in a live room.</li>') + '</ul>';
  }
  window.PATVOnAirBar = {
    sync: function (where) {
      if (dead || !where || !where.parentNode) return;
      if (!bar && !panel && !timer) css();
      box = where;
      if (!data) load(); else paint();
      if (!timer) timer = setInterval(function () { if (!document.hidden) load(); }, 15000);
    },
  };
})();
