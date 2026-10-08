// /stage/admin — paid Main Stage slots: open slots (cut / cut + ban), settings, bans, log.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return n == null ? '–' : Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var when = function (ms) { if (!ms) return '–'; var d = new Date(Number(ms)); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  var mmss = function (s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  // 1.99fv: Pepe's main stage source (stage setting pepe_embed): his stream (default) or a YouTube / Twitch embed
  function renderSrc(P) {
    if (!P || !$('psNow')) return;
    var url = typeof P.url === 'string' && /^https:\/\/(www\.)?(youtube\.com|youtu\.be|twitch\.tv)\//.test(P.url) ? P.url : '';
    $('psNow').innerHTML = P.mode === 'embed'
      ? 'Showing an embed: <b>' + esc(P.label || 'embed') + '</b>' + (url ? ' · <a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>' : '')
      : 'Showing <b>Pepe\'s stream (HLS + ⚡)</b> - the default.';
    var back = document.querySelector('[data-ps="pepe"]');
    if (back) back.disabled = P.mode !== 'embed';
  }
  function setSrc(v) {
    $('psMsg').textContent = 'Saving…';
    return post('/api/stage/admin/config', { pepe_embed: v }).then(function (j) {
      if (!j.ok) { $('psMsg').textContent = j.error || 'Could not save.'; return false; }
      $('psMsg').textContent = 'Saved - viewers switch within 10 s.';
      load();
      return true;
    });
  }
  function render(S) {
    renderSrc(S.pepe_src);
    var o = S.open || [];
    $('openRows').innerHTML = o.length ? o.map(function (s) {
      return '<tr><td><a href="/u/' + encodeURIComponent(s.username) + '">' + esc(s.display) + '</a><br><span class="muted">' + esc(s.room_id || '') +
        (s.featured ? ' · ★ ' + esc(s.feature_by || '') : '') + (s.mode === 'embed' ? ' · ' + esc(s.embed_label || 'video') : '') + '</span></td>' +
        '<td>' + (s.live ? '<span class="live-tag">● LIVE</span>' : esc(s.status === 'waiting' ? 'waiting to go live' : 'off air')) + (s.relay ? ' · browser' : '') + '</td>' +
        '<td class="num">' + mmss(s.live_seconds) + '</td><td class="num">' + fmt(s.charged) + ' / ' + fmt(s.held) + '</td><td>' + when(s.created) + '</td>' +
        '<td><span class="row" style="margin:0"><button type="button" class="btn danger" data-cut="' + esc(s.id) + '">✂ Cut</button>' +
        '<button type="button" class="btn danger" data-cut="' + esc(s.id) + '" data-ban="1">Cut + ban</button></span></td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">Nobody has the stage - Pepe\'s stream is on.</td></tr>';
    $('cutAll').disabled = !o.length;
    var b = S.bans || [];
    $('banRows').innerHTML = b.length ? b.map(function (x) {
      return '<tr><td>' + esc(x.username) + '</td><td>' + esc(x.reason || '') + '</td><td>' + esc(x.by || '') + '</td><td>' + when(x.at) + '</td>' +
        '<td><button type="button" class="btn" data-unban="' + esc(x.userId) + '">Unban</button></td></tr>';
    }).join('') : '<tr><td colspan="5" class="muted">No one.</td></tr>';
    var l = S.log || [];
    $('logRows').innerHTML = l.length ? l.map(function (s) {
      return '<tr><td>' + when(s.created) + '</td><td>' + esc(s.display) + '</td><td class="num">' + s.max_minutes + 'm</td><td class="num">' + mmss(s.live_seconds) + '</td>' +
        '<td class="num">' + fmt(s.held) + '</td><td class="num">' + fmt(s.charged) + '</td><td class="num">' + fmt(s.refunded) + '</td>' +
        '<td>' + (s.status === 'ended' ? esc(s.end_reason) + (s.ended_by && s.ended_by !== 'system' ? ' by ' + esc(s.ended_by) : '') : '<i>open</i>') + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="muted">No bookings yet.</td></tr>';
    var e = S.events || [];
    $('evRows').innerHTML = e.length ? e.map(function (x) {
      return '<tr><td>' + when(x.ts) + '</td><td>' + esc(x.what) + '</td><td>' + esc(x.actor || '') + '</td><td>' + esc(x.detail || '') + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>';
  }
  function load() {
    return fetch('/api/stage/admin/state', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); })
      .then(function (j) { if (j.ok) render(j); }).catch(function () {});
  }
  try { render(JSON.parse($('saState').textContent)); } catch (e) { load(); }
  setInterval(load, 5000);

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-cut')) {
      var ban = b.hasAttribute('data-ban');
      if (!confirm(ban ? 'Cut this slot to Pepe and ban them from booking?' : 'Cut this slot to Pepe? Unused PAT is refunded.')) return;
      b.disabled = true;
      post('/api/stage/admin/cut', { id: b.getAttribute('data-cut'), ban: ban }).then(function (j) { if (!j.ok) alert(j.error); load(); });
    } else if (b.hasAttribute('data-unban')) {
      post('/api/stage/admin/unban', { userId: b.getAttribute('data-unban') }).then(load);
    } else if (b.hasAttribute('data-ps')) {
      b.disabled = true;
      setSrc(b.getAttribute('data-ps')).then(function () { if (b.getAttribute('data-ps') !== 'pepe') b.disabled = false; });
    } else if (b.id === 'cutAll') {
      if (!confirm('Cut every slot back to Pepe?')) return;
      post('/api/stage/admin/cut', {}).then(load);
    }
  });
  $('cfg').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, body = {};
    Array.prototype.forEach.call(f.elements, function (el) {
      if (!el.name) return;
      body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    $('cfgMsg').textContent = 'Saving…';
    post('/api/stage/admin/config', body).then(function (j) {
      $('cfgMsg').textContent = j.ok ? 'Saved.' : (j.error || 'Could not save.');
      if (j.ok) Object.keys(j.config).forEach(function (k) { var el = f.elements[k]; if (!el) return; if (el.type === 'checkbox') el.checked = !!j.config[k]; else el.value = j.config[k]; });
    });
  });
  if ($('psForm')) $('psForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var inp = e.target.elements.pepe_embed, v = inp.value.trim();
    if (!v) { $('psMsg').textContent = 'Paste a Twitch channel or a YouTube / Twitch link.'; return; }
    setSrc(v).then(function (ok) { if (ok) inp.value = ''; });
  });
  $('banForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    post('/api/stage/admin/ban', { username: f.username.value, reason: f.reason.value }).then(function (j) {
      if (!j.ok) { alert(j.error || 'Could not ban.'); return; }
      f.reset(); load();
    });
  });
})();
