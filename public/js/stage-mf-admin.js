// /stage/admin — 🎙 Mic follows (micfollow.js): the site-wide kill switch (staff, micfollow.kill), the pads using it with
// "turn off here", the last 24 hours' counts, and for admins (micfollow.admin) the knobs and the 30-day appearance log.
// Data: #mfState (the server's adminView) then GET /api/stage/admin/micfollow every 10 s. All text via textContent.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var holder = $('mfState');
  if (!holder) return;
  var V = null;
  try { V = JSON.parse(holder.textContent || 'null'); } catch (e) { V = null; }
  if (!V) return;
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function when(ms) { if (!ms) return '–'; var d = new Date(Number(ms)); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  var WHY = { site_off: 'switched off site-wide', livecams_off: 'live cams off', webrtc_off: 'WebRTC off', room_off: 'room: !bridge cams / livecams off', prime: 'no 💎 bridge perk',
              pepe: 'Pepe not polling', pepe_old: 'Pepe needs the update', stale: 'no fresh sync', pad_off: 'off on this pad', adult: '18+ pad (not available yet)' };
  var RWHY = { impersonation: 'not who they say', sexual: 'nudity / sexual', abuse: 'harassment / hate', minor: 'may be under 18', other: 'something else' };
  function paintReports() {
    var tb = $('mfReports');
    if (!tb) return;
    tb.textContent = '';
    var list = V.reports || [];
    if (!list.length) { var tr0 = el('tr'), td0 = el('td', 'Nothing to review.', 'muted'); td0.colSpan = 8; tr0.appendChild(td0); tb.appendChild(tr0); return; }
    list.forEach(function (r) {
      var tr = el('tr');
      var a = el('a', r.title || r.room); a.href = '/p/' + encodeURIComponent(r.slug || r.room);
      var td = el('td'); td.appendChild(a); tr.appendChild(td);
      tr.appendChild(el('td', r.login));
      tr.appendChild(el('td', String(r.n), 'num'));
      tr.appendChild(el('td', String(r.qualified), 'num'));
      tr.appendChild(el('td', (r.reasons || []).map(function (x) { return RWHY[x] || x; }).join(', ')));
      tr.appendChild(el('td', when(r.last)));
      tr.appendChild(el('td', r.cut ? 'off the mic stage (24 h)' : 'open'));
      var act = el('td');
      [['dismiss', 'Dismiss', 'btn'], ['uphold', 'Uphold', 'btn danger']].forEach(function (o) {
        var b = el('button', o[1]); b.type = 'button'; b.className = o[2];
        b.addEventListener('click', function () {
          b.disabled = true;
          post('/api/stage/admin/micfollow/report', { room: r.room, login: r.login, action: o[0] }).then(function (d) {
            if (d.ok && d.view) { var keep = V.fields; V = d.view; if (!V.fields) V.fields = keep; paint(); } else { alert(d.error || 'Could not do that.'); b.disabled = false; }
          });
        });
        act.appendChild(b);
      });
      tr.appendChild(act);
      tb.appendChild(tr);
    });
  }
  /** 1.99afl (S3/S4): a pad's health - Pepe's people list (age of his last complete read, fresh or not, a list pause), the
   *  last hour's failed opens / stills by code, the cards its tiles show now by reason. */
  function ago(s) { return s == null ? 'never' : s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'; }
  function healthText(p) {
    var parts = [], l = p.list || {};
    parts.push('list ' + (l.at ? ago(l.age_s) + ' old' : 'not read') + (l.fresh === true ? ' (fresh)' : l.fresh === false ? ' (stale)' : ''));
    if (l.paused != null) parts.push('⏸ paused ' + ago(l.paused) + ' (list unread)');
    var f = p.fails_1h || {}, fk = Object.keys(f);
    parts.push(fk.length ? 'failed 1 h: ' + fk.sort().map(function (k) { return k + ' ' + f[k]; }).join(', ') : 'no failures 1 h');
    var c = p.cards || {}, ck = Object.keys(c);
    if (ck.length) parts.push('cards: ' + ck.sort().map(function (k) { return k + ' ' + c[k]; }).join(', '));
    return parts.join(' · ');
  }
  function paintPads() {
    var tb = $('mfPads');
    if (!tb) return;
    tb.textContent = '';
    if (!V.pads || !V.pads.length) { var tr0 = el('tr'), td0 = el('td', 'No pad uses it right now.', 'muted'); td0.colSpan = 8; tr0.appendChild(td0); tb.appendChild(tr0); return; }
    V.pads.forEach(function (p) {
      var tr = el('tr');
      var a = el('a', p.title || p.room); a.href = '/p/' + encodeURIComponent(p.slug || p.room);
      var td = el('td'); td.appendChild(a); tr.appendChild(td);
      tr.appendChild(el('td', p.layout));
      tr.appendChild(el('td', String(p.tiles), 'num'));
      tr.appendChild(el('td', String(p.live), 'num'));
      tr.appendChild(el('td', String(p.stills), 'num'));
      tr.appendChild(el('td', p.why_off ? (WHY[p.why_off] || p.why_off) : 'running' + (p.unproven_n ? ' · ' + p.unproven_n + ' unconfirmed on the mic' : '') + (p.frozen_until ? ' · ❄ frozen' : '')));
      tr.appendChild(el('td', healthText(p), 'mf-health'));      // 1.99afl (S3)
      var act = el('td');
      if (p.on) {
        var b = el('button', 'Turn off here'); b.type = 'button'; b.className = 'btn danger';
        b.addEventListener('click', function () {
          var why = prompt('Turn mic follows off on ' + (p.title || p.room) + '? The owner is told. Reason (optional):');
          if (why === null) return;
          b.disabled = true;
          post('/api/stage/admin/micfollow/pad', { room: p.room, on: false, reason: why }).then(function (d) { if (d.ok && d.view) { V = d.view; paint(); } else { alert(d.error || 'Could not do that.'); b.disabled = false; } });
        });
        act.appendChild(b);
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    });
  }
  function paintMetrics() {
    var tb = $('mfMetrics');
    if (!tb || !V.metrics) return;
    tb.textContent = '';
    var m = V.metrics, c = m.counts || {};
    var row = function (k, v) { var tr = el('tr'); tr.appendChild(el('th', k)); tr.appendChild(el('td', String(v == null ? '–' : v))); tb.appendChild(tr); };
    row('Now: on mic stages / live / stills / mic-only relays', [m.current.tiles, m.current.live, m.current.stills, m.current.mf_only_relays].join(' / '));
    row('Holders seen / proven / unproven', [c.holders_seen || 0, c.proven || 0, c.unproven || 0].join(' / '));
    row('Added / removed / changes / deferred', [c.adds || 0, c.removes || 0, c.changes || 0, c.deferred || 0].join(' / '));
    row('Changes a minute (max / p95)', m.changes_per_min.max + ' / ' + m.changes_per_min.p95);
    var q = m.qualify_to_picture;
    row('Mic to picture, warm (p50 / p95 ms)', q.warm.n ? q.warm.p50 + ' / ' + q.warm.p95 : '–');
    row('Mic to picture, cold (p50 / p95 ms)', q.cold.n ? q.cold.p50 + ' / ' + q.cold.p95 : '–');
    row('Cold opens ok / failed · warm reuses ok', [c.cold_ok || 0, c.cold_failed || 0].join(' / ') + ' · ' + (c.warm_ok || 0));
    row('Yields to a manual slot', c.yields || 0);
    row('Stills: frames / refusals', [c.still_frames || 0, c.still_refusals || 0].join(' / '));
    // 1.99afl (S1/S3): still refusals by Pepe's code, and the "can't read the people list" alerts sent
    var srf = Object.keys(c).filter(function (k) { return k.indexOf('still_refused:') === 0; }).map(function (k) { return k.slice(14) + ' ' + c[k]; });
    row('Still refusals by code · list alerts sent', (srf.length ? srf.join(' · ') : '–') + ' · ' + (c.list_alerts || 0));
    var of = Object.keys(c).filter(function (k) { return k.indexOf('open_failed:') === 0; }).map(function (k) { return k.slice(12) + ' ' + c[k]; });
    row('Failed opens by code', of.length ? of.join(' · ') : '–');
    // 1.99afn (FU-1): one courtesy notice per Camfrog login, ever - sent / told before (nothing sent) / PMs off (inbox only) · homepage · failed
    row('Courtesy notices: sent / told before / PMs off · homepage · failed', [c.notices_courtesy || 0, c.notices_known || 0, c.notices_pm_off || 0].join(' / ') +
        ' · ' + (c.notices_home || 0) + ' · ' + (c.notice_failed || 0));
    row('Reports: all / qualified / cuts · grab-spam hold-outs · stages cleared', [c.reports || 0, c.reports_qualified || 0, c.report_cuts || 0].join(' / ') +
        ' · ' + (c.grab_spam || 0) + ' · ' + (c.cleared || 0));
    row('Peak viewers of one tile', m.peak_viewers || 0);
    var cuts = Object.keys(c).filter(function (k) { return k.indexOf('remove:') === 0; }).map(function (k) { return k.slice(7) + ' ' + c[k]; });
    row('Removed because', cuts.length ? cuts.join(' · ') : '–');
    var refused = Object.keys(c).filter(function (k) { return k.indexOf('ticket_refused:') === 0; }).map(function (k) { return k.slice(15) + ' ' + c[k]; });
    row('Tickets / refused', (c.tickets || 0) + (refused.length ? ' / ' + refused.join(' · ') : ''));
  }
  function paintCfg() {
    var f = $('mfCfg');
    if (!f || !V.fields) return;
    if (!f.getAttribute('data-built')) {
      var first = f.firstChild;
      Object.keys(V.fields).forEach(function (k) {
        if (k === 'enabled') return;
        var fd = V.fields[k], lab = el('label');
        lab.appendChild(document.createTextNode(k + ' '));
        var inp = document.createElement('input');
        inp.name = k;
        if (fd.bool) { inp.type = 'checkbox'; lab.className = 'chk'; }
        else { inp.type = 'number'; inp.min = fd.min; inp.max = fd.max; }
        lab.appendChild(inp);
        f.insertBefore(lab, first);
      });
      f.setAttribute('data-built', '1');
    }
    Object.keys(V.fields).forEach(function (k) {
      var inp = f.elements[k];
      if (!inp) return;
      if (inp.type === 'checkbox') inp.checked = !!V.cfg[k]; else inp.value = V.cfg[k];
    });
  }
  function paintSpans() {
    var tb = $('mfSpans');
    if (!tb || !V.spans) return;
    tb.textContent = '';
    V.spans.forEach(function (s) {
      var tr = el('tr');
      [when(s.started), s.room_id, s.login, s.secs == null ? 'on now' : s.secs, s.video_secs || 0, s.peak_viewers || 0, s.end_reason || ''].forEach(function (v, i) {
        tr.appendChild(el('td', String(v), i >= 3 && i <= 5 ? 'num' : null));
      });
      tb.appendChild(tr);
    });
  }
  function paint() {
    var k = $('mfKill');
    if (k) k.checked = !!V.cfg.enabled;
    paintPads(); paintReports(); paintMetrics(); paintCfg(); paintSpans();
  }
  var kill = $('mfKill');
  if (kill) kill.addEventListener('change', function () {
    var on = kill.checked;
    if (!on && !confirm('Switch mic follows OFF on every pad now? Everyone comes off the mic stages at once.')) { kill.checked = true; return; }
    kill.disabled = true;
    post('/api/stage/admin/micfollow/kill', { enabled: on, reason: ($('mfKillWhy') || {}).value || '' }).then(function (d) {
      kill.disabled = false;
      $('mfKillMsg').textContent = d.ok ? (on ? 'On.' : 'Off - every mic stage cleared.') : (d.error || 'Could not save.');
      if (d.ok && d.view) { V = d.view; paint(); } else kill.checked = !on;
    }).catch(function () { kill.disabled = false; kill.checked = !on; $('mfKillMsg').textContent = 'Could not reach the server.'; });
  });
  var cf = $('mfCfg');
  if (cf) cf.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var body = { reason: cf.elements.reason ? cf.elements.reason.value : '' };
    Object.keys(V.fields).forEach(function (k) {
      if (k === 'enabled') return;
      var inp = cf.elements[k];
      if (inp) body[k] = inp.type === 'checkbox' ? inp.checked : Number(inp.value);
    });
    $('mfCfgMsg').textContent = 'Saving…';
    post('/api/stage/admin/micfollow/config', body).then(function (d) {
      $('mfCfgMsg').textContent = d.ok ? (d.same ? 'Nothing changed.' : 'Saved (v' + d.v + ').') : (d.error || 'Could not save.');
      if (d.ok && d.view) { V = d.view; paint(); }
    }).catch(function () { $('mfCfgMsg').textContent = 'Could not reach the server.'; });
  });
  paint();
  setInterval(function () {
    if (document.hidden) return;
    fetch('/api/stage/admin/micfollow', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) { var keep = V.fields; V = d; if (!V.fields) V.fields = keep; paintPads(); paintReports(); paintMetrics(); paintSpans(); if (kill) kill.checked = !!V.cfg.enabled; } }).catch(function () {});
  }, 10000);
})();
