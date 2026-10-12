// /soundboards (1.99rh): ▶ previews and buying (POST /api/soundboards/buy {item, ref, allowance}). Every string goes through __t (js.sb.*).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var root = document.getElementById('sbx');
  if (!root) return;
  var msg = document.getElementById('sbMsg');
  var player = null, playing = null;
  function say(t, c) { if (!msg) return; msg.textContent = t || ''; msg.className = 'sb-msg' + (c ? ' ' + c : ''); }
  function ref() { var a = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  root.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    if (b.classList.contains('sb-play')) {
      var src = b.getAttribute('data-audio');
      if (!src) return;
      if (player && playing === b) { player.pause(); player = null; playing.textContent = '▶'; playing = null; return; }
      if (player) { player.pause(); if (playing) playing.textContent = '▶'; }
      player = new Audio(src); playing = b; b.textContent = '■';
      player.addEventListener('ended', function () { if (playing === b) { b.textContent = '▶'; playing = null; player = null; } });
      player.play().catch(function () { b.textContent = '▶'; say(_t('js.sb.cant_play', 'Couldn\'t play that preview.'), 'bad'); });
      return;
    }
    var item = b.getAttribute('data-sb-buy');
    if (!item) return;
    var free = b.getAttribute('data-sb-free') === '1';
    if (!free && !window.confirm(_t('js.sb.confirm', 'Buy this with your PAT?'))) return;
    b.disabled = true;
    say(_t('js.sb.working', 'Working…'));
    fetch('/api/soundboards/buy', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ item: item, ref: ref(), allowance: free }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        if (!d || !d.ok) { b.disabled = false; say((d && d.error) || _t('js.sb.failed', 'That didn\'t work - try again.'), 'bad'); return; }
        say(_t('js.sb.bought', 'Done - it\'s yours. Play it in a Camfrog room with !sb.'), 'ok');
        setTimeout(function () { location.reload(); }, 900);
      })
      .catch(function () { b.disabled = false; say(_t('js.sb.failed', 'That didn\'t work - try again.'), 'bad'); });
  });
})();
