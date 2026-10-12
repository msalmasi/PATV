// The pad's 🔊 Soundboard drawer (1.99rh, soundboards.js) under the Live tab's relay box: tabs Room / Global / Season / Packs /
// Legendary, a button per clip (label, rarity border, price or ∞). A click sends `!sb <clip id>` through the existing web
// relay (POST /api/rooms/:slug/say) - Pepe plays it as the account's linked Camfrog name, with every cooldown, price and
// queue rule of chat. A ring shows the 45 s per-person cooldown; 🚩 reports a clip. Strings: __t (js.sbd.*).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var host = document.getElementById('rmSb');
  if (!host) return;
  var slug = host.getAttribute('data-slug');
  var GAP = 45000;
  var last = 0, data = null, tab = null, timer = null;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var toggle = el('button', 'rb-btn sbd-toggle', '🔊 ' + _t('js.sbd.open', 'Soundboard')); toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'sbd-' + slug);
  var panel = el('div', 'sbd hide'); panel.id = 'sbd-' + slug;
  var tabs = el('div', 'sbd-tabs'); tabs.setAttribute('role', 'tablist');
  var grid = el('div', 'sbd-grid'); grid.setAttribute('role', 'tabpanel');
  var status = el('p', 'sbd-msg'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  var foot = el('p', 'sbd-foot');
  var a = el('a', null, _t('js.sbd.store', 'Get packs')); a.href = '/soundboards'; foot.appendChild(a);
  // 1.99ta: the voice store too (Pepe's voices for !say / soundboard lines) - it was linked from nowhere
  foot.appendChild(document.createTextNode(' · '));
  var av = el('a', null, _t('js.sbd.voices', 'Voices')); av.href = '/voices'; foot.appendChild(av);
  panel.appendChild(tabs); panel.appendChild(grid); panel.appendChild(status); panel.appendChild(foot);
  host.appendChild(toggle); host.appendChild(panel);
  function say(t, c) { status.textContent = t || ''; status.className = 'sbd-msg' + (c ? ' ' + c : ''); }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function ring() {
    var left = Math.max(0, GAP - (Date.now() - last));
    grid.style.setProperty('--sbd-cd', left ? String(Math.round(100 * left / GAP)) : '0');
    grid.classList.toggle('cooling', left > 0);
    grid.querySelectorAll('.sbd-b').forEach(function (b) { b.disabled = left > 0; });
    if (left > 0) { clearTimeout(timer); timer = setTimeout(ring, 1000); toggle.setAttribute('data-cd', Math.ceil(left / 1000)); } else toggle.removeAttribute('data-cd');
  }
  function paint() {
    tabs.textContent = ''; grid.textContent = '';
    if (!data || !data.on) { grid.appendChild(el('p', 'sbd-empty', _t('js.sbd.off', 'Soundboards are switched off right now.'))); return; }
    // 1.99tf: switched off in this room (the pad owner) or everywhere (Pepe's admins) - say so instead of offering buttons
    if (data.room_on === false) {
      grid.appendChild(el('p', 'sbd-empty', data.room_why === 'admins'
        ? _t('js.sbd.off_admins', 'The soundboard is taking a break everywhere right now (Pepe\'s admins switched it off).')
        : _t('js.sbd.off_room', 'The soundboard is switched off in this room - the pad owner can switch it back on.')));
      return;
    }
    if (!data.tabs.length) { grid.appendChild(el('p', 'sbd-empty', _t('js.sbd.empty', 'No clips here yet.'))); return; }
    if (!tab || !data.tabs.some(function (x) { return x.key === tab; })) tab = data.tabs[0].key;
    data.tabs.forEach(function (x) {
      var b = el('button', 'sbd-tab' + (x.key === tab ? ' on' : ''), x.emoji + ' ' + x.name); b.type = 'button';
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', x.key === tab ? 'true' : 'false');
      b.addEventListener('click', function () { tab = x.key; paint(); });
      tabs.appendChild(b);
    });
    var cur = data.tabs.filter(function (x) { return x.key === tab; })[0];
    cur.clips.forEach(function (c) {
      var wrap = el('div', 'sbd-it');
      var b = el('button', 'sbd-b ' + (c.rarity || 'common')); b.type = 'button';
      b.appendChild(el('span', 'sbd-e', c.emoji || '🔊'));
      b.appendChild(el('span', 'sbd-l', c.label));
      b.appendChild(el('span', 'sbd-p', c.free ? '∞' : (c.price ? num(c.price) : _t('js.sbd.free', 'free'))));
      b.setAttribute('aria-label', c.label + ' - ' + (c.free ? _t('js.sbd.owned', 'yours, unlimited') : (c.price ? _t('js.sbd.costs', '{pat} PAT', { pat: num(c.price) }) : _t('js.sbd.free', 'free'))));
      b.addEventListener('click', function () { play(c); });
      var r = el('button', 'sbd-rep', '🚩'); r.type = 'button'; r.setAttribute('aria-label', _t('js.sbd.report', 'Report') + ': ' + c.label);
      r.addEventListener('click', function () { report(c); });
      wrap.appendChild(b); wrap.appendChild(r);
      grid.appendChild(wrap);
    });
    ring();
  }
  function load() {
    return fetch('/api/rooms/' + encodeURIComponent(slug) + '/soundboard', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (d) { if (d && d.ok) { data = d; paint(); } else say((d && d.error) || _t('js.sbd.failed', 'Couldn\'t load the soundboard.'), 'bad'); });
  }
  function play(c) {
    if (Date.now() - last < GAP) return;
    last = Date.now(); ring();
    say(_t('js.sbd.sending', 'Asking Pepe to play {label}…', { label: c.label }));
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/say', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ text: '!sb ' + c.id }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        if (!d || !d.ok) { last = 0; ring(); say((d && d.error) || _t('js.sbd.failed_play', 'Pepe couldn\'t take that one.'), 'bad'); return; }
        say(_t('js.sbd.queued', 'Sent - Pepe answers in the chat.'), 'ok');
      })
      .catch(function () { last = 0; ring(); say(_t('js.sbd.failed_play', 'Pepe couldn\'t take that one.'), 'bad'); });
  }
  function report(c) {
    var why = window.prompt(_t('js.sbd.report_q', 'What\'s wrong with “{label}”?', { label: c.label }));
    if (why == null) return;
    fetch('/api/soundboards/report', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ clip: c.id, reason: why }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) { say(d && d.ok ? _t('js.sbd.reported', 'Thanks - staff will look at it.') : ((d && d.error) || _t('js.sbd.failed', 'Couldn\'t load the soundboard.')), d && d.ok ? 'ok' : 'bad'); });
  }
  toggle.addEventListener('click', function () {
    var open = panel.classList.contains('hide');
    panel.classList.toggle('hide', !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && !data) load();
  });
})();
