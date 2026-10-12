// /voices + /voices/mine (1.99rh): ▶ samples, filters, buying an unlock, and the owner's controls. Strings: __t (js.vs.*).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var root = document.getElementById('vsx');
  if (!root) return;
  var player = null, playing = null;
  function ref() { var a = new Uint8Array(12); window.crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) { if (!d || !d.ok) throw new Error((d && d.error) || _t('js.vs.failed', 'That didn\'t work - try again.')); return d; });
  }
  function msgFor(el) { var c = el.closest('[data-vs-voice]'); return c ? c.querySelector('.vs-msg') : document.getElementById('vsMsg'); }
  function say(el, text, cls) { var m = msgFor(el); if (!m) return; m.textContent = text || ''; m.className = 'vs-msg' + (cls ? ' ' + cls : ''); }
  root.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b) return;
    if (b.classList.contains('vs-play')) {
      var src = b.getAttribute('data-audio');
      if (!src) return;
      if (player && playing === b) { player.pause(); player = null; b.textContent = '▶'; playing = null; return; }
      if (player) { player.pause(); if (playing) playing.textContent = '▶'; }
      player = new Audio(src); playing = b; b.textContent = '■';
      player.addEventListener('ended', function () { if (playing === b) { b.textContent = '▶'; playing = null; player = null; } });
      player.play().catch(function () { b.textContent = '▶'; });
      return;
    }
    var f = b.getAttribute('data-vs-filter');
    if (f) {
      root.querySelectorAll('[data-vs-filter]').forEach(function (x) { var on = x === b; x.setAttribute('aria-pressed', on ? 'true' : 'false'); x.classList.toggle('ghost', !on); });
      root.querySelectorAll('.vs-card').forEach(function (c) {
        var show = f === 'all' || (f === 'free' ? c.getAttribute('data-free') === '1' : f === 'owned' ? c.getAttribute('data-owned') === '1' : c.getAttribute('data-kind') === f);
        c.hidden = !show;
      });
      return;
    }
    var v = b.getAttribute('data-vs-buy');
    if (v) {
      if (!window.confirm(_t('js.vs.confirm', 'Buy unlimited use of this voice with your PAT?'))) return;
      b.disabled = true;
      post('/api/voices/buy', { voice: v, ref: ref() }).then(function () { say(b, _t('js.vs.bought', 'It\'s yours - !say -v uses it free now.'), 'ok'); setTimeout(function () { location.reload(); }, 900); })
        .catch(function (e) { b.disabled = false; say(b, e.message, 'bad'); });
      return;
    }
    var st = b.getAttribute('data-vs-status');
    if (st) {
      var card = b.closest('[data-vs-voice]');
      b.disabled = true;
      post('/api/voices/mine', { voice: card.getAttribute('data-vs-voice'), status: st }).then(function () { location.reload(); })
        .catch(function (e) { b.disabled = false; say(b, e.message, 'bad'); });
    }
  });
  root.addEventListener('change', function (ev) {
    var el = ev.target;
    var flag = el && el.getAttribute && el.getAttribute('data-vs-flag');
    if (!flag) return;
    var card = el.closest('[data-vs-voice]');
    var body = { voice: card.getAttribute('data-vs-voice') };
    body[flag] = !!el.checked;
    el.disabled = true;
    post('/api/voices/mine', body).then(function () { el.disabled = false; say(el, _t('js.vs.saved', 'Saved.'), 'ok'); })
      .catch(function (e) { el.disabled = false; el.checked = !el.checked; say(el, e.message, 'bad'); });
  });
  root.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form.hasAttribute('data-vs-prices')) return;
    ev.preventDefault();
    var card = form.closest('[data-vs-voice]');
    var body = { voice: card.getAttribute('data-vs-voice') };
    ['price_use', 'price_unlock', 'royalty_pct'].forEach(function (k) { var i = form.querySelector('[name="' + k + '"]'); if (i) body[k] = Number(i.value); });
    post('/api/voices/mine', body).then(function () { say(form, _t('js.vs.saved', 'Saved.'), 'ok'); }).catch(function (e) { say(form, e.message, 'bad'); });
  });
})();
