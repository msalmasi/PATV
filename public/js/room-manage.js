// /rooms/:slug/manage — a room owner's dashboard (1.99bi). Draws the stage tables from
// /api/rooms/:slug/owner-state (polled), runs the owner actions, saves the settings forms.
(function () {
  'use strict';
  var root = document.getElementById('rmg');
  if (!root) return;
  var slug = root.getAttribute('data-slug');
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return n == null ? '–' : Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var when = function (ms) { if (!ms) return '–'; var d = new Date(Number(ms)); return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
  var mmss = function (s) { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  function src(s) { return s.mode === 'embed' ? esc(s.embed_label || 'video link') : (s.relay ? 'browser' : 'stream'); }
  function render(S) {
    var o = S.open || [];
    $('openRows').innerHTML = o.length ? o.map(function (s) {
      return '<tr><td><a href="/u/' + encodeURIComponent(s.username) + '/profile">' + esc(s.display) + '</a>' + (s.title ? '<br><span class="muted">' + esc(s.title) + '</span>' : '') + '</td>' +
        '<td>' + (s.live ? '<span class="live-tag">● LIVE</span>' : esc(s.status === 'waiting' ? 'waiting to go live' : 'off air')) +
        (s.featured ? ' <span class="tag gold">★ ' + (s.feature_by === 'paid' ? 'paid feature' : 'featured') + '</span>' : '') + '</td>' +
        '<td>' + src(s) + '</td><td class="num">' + mmss(s.live_seconds) + '</td><td class="num">' + fmt(s.charged) + ' / ' + fmt(s.held) + '</td>' +
        '<td><span class="row" style="margin:0">' + (s.featured ? '<button type="button" class="btn gold" data-act="unfeature" data-id="' + esc(s.id) + '">☆ Unfeature</button>'
                                                       : '<button type="button" class="btn gold" data-act="feature" data-id="' + esc(s.id) + '">★ Feature</button>') +
        '<button type="button" class="btn danger" data-act="cut" data-id="' + esc(s.id) + '">✂ Cut</button>' +
        '<button type="button" class="btn danger" data-act="cut" data-ban="1" data-id="' + esc(s.id) + '">Cut + ban</button></span></td></tr>';
    }).join('') : '<tr><td colspan="6" class="muted">Nobody is on the stage — Pepe\'s stream shows.</td></tr>';
    var li = function (s, btns) {
      return '<li><span><b>' + esc(s.display) + '</b> · ' + when(s.start_at) + ' · ' + s.max_minutes + ' min' + (s.featured ? ' · ★ featured' : '') +
             (s.embed_label ? ' · ' + esc(s.embed_label) : '') + (s.title ? ' · ' + esc(s.title) : '') + '</span>' + btns + '</li>';
    };
    var r = S.requested || [];
    $('reqList').innerHTML = r.length ? r.map(function (s) {
      return li(s, '<button type="button" class="btn primary" data-act="approve" data-id="' + esc(s.id) + '">Approve</button><button type="button" class="btn danger" data-act="deny" data-id="' + esc(s.id) + '">Deny</button>');
    }).join('') : '<li class="muted">None.</li>';
    var sc = S.scheduled || [];
    $('schedList').innerHTML = sc.length ? sc.map(function (s) {
      return li(s, (s.featured ? '' : '<button type="button" class="btn gold" data-act="feature" data-id="' + esc(s.id) + '">★ Feature</button>') +
                   '<button type="button" class="btn danger" data-act="cut" data-id="' + esc(s.id) + '">Cancel</button>');
    }).join('') : '<li class="muted">Nothing booked.</li>';
    var q = S.queue || [];
    $('queueList').innerHTML = q.length ? q.map(function (e) {
      return '<li><span>#' + e.position + ' <b>' + esc(e.display) + '</b> · ' + e.minutes + ' min' + (e.feature ? ' · wants featured' : '') + (e.mode === 'embed' ? ' · video link' : '') + ' · since ' + when(e.created) + '</span></li>';
    }).join('') : '<li class="muted">Nobody waiting.</li>';
    var b = S.bans || [];
    $('banRows').innerHTML = b.length ? b.map(function (x) {
      return '<tr><td>' + esc(x.username) + '</td><td>' + esc(x.reason || '') + '</td><td>' + esc(x.by || '') + '</td><td><button type="button" class="btn" data-unban="' + esc(x.userId) + '">Unban</button></td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">No one.</td></tr>';
  }
  function load() {
    return fetch('/api/rooms/' + encodeURIComponent(slug) + '/owner-state', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json(); }).then(function (j) { if (j.ok) render(j); }).catch(function () {});
  }
  try { render(JSON.parse($('rmgState').textContent)); } catch (e) {}
  setInterval(load, 5000);

  root.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act) {
      var ban = b.hasAttribute('data-ban');
      var ask = { feature: 'Feature this slot? It becomes the room\'s main stream.', unfeature: 'Stop featuring it? A paid feature is refunded for the unused minutes.',
                  cut: ban ? 'Cut this slot AND ban them from this room\'s stage?' : 'End this slot? Anything unused is refunded.', approve: null, deny: 'Decline this booking? Their hold is refunded.' }[act];
      if (ask && !confirm(ask)) return;
      var body = { ban: ban };
      if (act === 'deny') { var why = prompt('A reason for them (optional):', ''); if (why === null) return; body.reason = why; }
      b.disabled = true;
      post('/api/stage/slots/' + encodeURIComponent(b.getAttribute('data-id')) + '/' + act, body).then(function (j) {
        $('nowMsg').textContent = j.ok ? 'Done.' : (j.error || 'Could not do that.');
        load();
      }).catch(function () { b.disabled = false; });
      return;
    }
    if (b.hasAttribute('data-unban')) {
      post('/api/rooms/' + encodeURIComponent(slug) + '/unban', { userId: b.getAttribute('data-unban') }).then(load);
      return;
    }
    if (b.hasAttribute('data-sw')) {
      var key = b.getAttribute('data-sw'), on = b.getAttribute('data-on') === '1';
      b.disabled = true; $('brMsg').textContent = 'Sending to Pepe…';
      post('/api/rooms/' + encodeURIComponent(slug) + '/bridge', { key: key, on: on }).then(function (j) {
        if (!j.ok) { $('brMsg').textContent = j.error || 'Not sent.'; b.disabled = false; return; }
        var tries = 0;
        (function check() {
          fetch('/api/rooms/action/' + j.id, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (a) {
            if (a.status === 'done') {
              $('brMsg').textContent = '✓ ' + (a.message || 'Done');
              var st = document.querySelector('[data-state="' + key + '"]');
              if (st) { st.textContent = on ? 'ON' : 'OFF'; st.className = on ? 'on' : 'off'; }
              b.setAttribute('data-on', on ? '0' : '1'); b.textContent = on ? 'Turn off' : 'Turn on'; b.disabled = false;
              return;
            }
            if (a.status === 'failed') { $('brMsg').textContent = '✗ ' + (a.message || 'Pepe refused'); b.disabled = false; return; }
            if (++tries > 30) { $('brMsg').textContent = 'Pepe hasn\'t answered yet - is he online?'; b.disabled = false; return; }
            $('brMsg').textContent = 'Waiting for Pepe…'; setTimeout(check, 2000);
          }).catch(function () { $('brMsg').textContent = 'Couldn\'t reach the site.'; b.disabled = false; });
        })();
      });
    }
  });

  function formJson(f) {
    var o = {};
    Array.prototype.forEach.call(f.elements, function (el) {
      if (!el.name) return;
      o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return o;
  }
  $('stageForm').addEventListener('submit', function (e) {
    e.preventDefault();
    post('/api/rooms/' + encodeURIComponent(slug) + '/stage-settings', formJson(e.target)).then(function (j) {
      $('stageMsg').textContent = j.ok ? 'Saved: ' + j.room.slot_count + ' slot' + (j.room.slot_count === 1 ? '' : 's') + ', ' + (j.room.slot_price ? fmt(j.room.slot_price) + ' PAT/min' : 'free') + (j.room.approval ? ', approval on' : '') + '.' : (j.error || 'Not saved.');
      load();
    });
  });
  $('pageForm').addEventListener('submit', function (e) {
    e.preventDefault();
    post('/api/rooms/' + encodeURIComponent(slug) + '/page', formJson(e.target)).then(function (j) {
      $('pageMsg').textContent = j.ok ? 'Saved.' : (j.error || 'Not saved.');
    });
  });
  $('banForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = formJson(e.target);
    post('/api/rooms/' + encodeURIComponent(slug) + '/ban', f).then(function (j) {
      if (!j.ok) alert(j.error || 'Could not ban.'); else e.target.reset();
      load();
    });
  });
})();
