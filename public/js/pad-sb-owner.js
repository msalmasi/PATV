// The room owner's soundboard editor on /p/<slug>/owner#soundboard (1.99rh, soundboards.js): slots used / max, add a TTS clip
// (label, line, voice, price), add a 🔊 mic clip already posted on the pad (the person heard in it must allow soundboards),
// per-clip price, reorder, remove, ▶ preview. Strings: __t (js.sbo.*).
(function () {
  'use strict';
  var _t = typeof __t === 'function' ? __t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var host = document.getElementById('poSb');
  if (!host) return;
  var slug = host.getAttribute('data-slug');
  var api = '/api/rooms/' + encodeURIComponent(slug) + '/soundboard';
  var state = null, player = null;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function post(body) {
    return fetch(api + '/clips', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) { if (!d || !d.ok) throw new Error((d && d.error) || _t('js.sbo.failed', 'That didn\'t work.')); return d; });
  }
  var msg = el('p', 'po-msg'); msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite');
  function say(t, c) { msg.textContent = t || ''; msg.className = 'po-msg' + (c ? ' ' + c : ''); }
  function field(label, input, hint) {
    var l = el('label', 'ds-field'); l.appendChild(el('span', 'ds-label', label)); l.appendChild(input);
    if (hint) l.appendChild(el('small', 'ds-hint', hint));
    return l;
  }
  function render() {
    var s = state;
    host.textContent = '';
    var stats = el('div', 'ds-stats');
    var st = el('div', 'ds-stat'); st.appendChild(el('span', null, _t('js.sbo.slots', 'Slots'))); st.appendChild(el('b', null, s.used + ' / ' + s.slots)); stats.appendChild(st);
    host.appendChild(stats);
    if (!s.slots) { host.appendChild(el('p', 'po-why', _t('js.sbo.need_prime', 'Room soundboards come with 📺 Prime Time (8 clips) or 💎 Prime Time Plus (24).'))); return; }
    var ul = el('ul', 'po-hist');
    s.clips.forEach(function (c, i) {
      var li = el('li');
      var left = el('div');
      var b = el('b', null, (c.emoji || '🔊') + ' ' + c.label);
      left.appendChild(b);
      var meta = c.kind === 'audio' ? _t('js.sbo.mic_of', 'mic clip of {who}', { who: c.subject || '?' }) : ('“' + (c.text || '') + '”' + (c.voice ? ' · ' + c.voice : ''));
      left.appendChild(el('div', 'ds-meta', meta + ' · ' + _t('js.sbo.st_' + c.status, c.status) + (c.note ? ' (' + c.note + ')' : '')));
      li.appendChild(left);
      var acts = el('div', 'po-quick');
      if (c.audio) {
        var pb = el('button', 'ds-btn sm ghost', '▶'); pb.type = 'button'; pb.setAttribute('aria-label', _t('js.sbo.preview', 'Preview') + ': ' + c.label);
        pb.addEventListener('click', function () { if (player) player.pause(); player = new Audio(c.audio); player.play().catch(function () {}); });
        acts.appendChild(pb);
      }
      var price = el('input', 'ds-in'); price.type = 'number'; price.min = 0; price.max = s.max_price; price.value = c.price; price.style.width = '7em';
      price.setAttribute('aria-label', _t('js.sbo.price', 'Price per play (PAT)') + ': ' + c.label);
      price.addEventListener('change', function () { post({ action: 'price', clip: c.id, price: Number(price.value) }).then(function (d) { state = d; say(_t('js.sbo.saved', 'Saved.'), 'ok'); render(); }).catch(function (e) { say(e.message, 'bad'); }); });
      acts.appendChild(price);
      [['up', '↑', i > 0], ['down', '↓', i < s.clips.length - 1]].forEach(function (m) {
        if (!m[2]) return;
        var mb = el('button', 'ds-btn sm ghost', m[1]); mb.type = 'button'; mb.setAttribute('aria-label', _t('js.sbo.move_' + m[0], m[0] === 'up' ? 'Move up' : 'Move down'));
        mb.addEventListener('click', function () { post({ action: 'move', clip: c.id, dir: m[0] }).then(function (d) { state = d; render(); }).catch(function (e) { say(e.message, 'bad'); }); });
        acts.appendChild(mb);
      });
      var rb = el('button', 'ds-btn sm danger', _t('js.sbo.remove', 'Remove')); rb.type = 'button';
      rb.addEventListener('click', function () {
        if (!window.confirm(_t('js.sbo.remove_q', 'Remove “{label}” from the board?', { label: c.label }))) return;
        post({ action: 'remove', clip: c.id }).then(function (d) { state = d; say(_t('js.sbo.removed', 'Removed.'), 'ok'); render(); }).catch(function (e) { say(e.message, 'bad'); });
      });
      acts.appendChild(rb);
      li.appendChild(acts);
      ul.appendChild(li);
    });
    if (!s.clips.length) host.appendChild(el('p', 'ds-meta', _t('js.sbo.empty', 'No clips yet - add the first one below.')));
    host.appendChild(ul);
    if (s.used >= s.slots) { host.appendChild(el('p', 'ds-meta', _t('js.sbo.full', 'The board is full - remove a clip to add another.'))); host.appendChild(msg); return; }

    // add a TTS line
    var f = el('form', 'ds-form'); f.noValidate = true;
    f.appendChild(el('h3', 'ds-h3', _t('js.sbo.add_tts', 'Add a line Pepe says')));
    var label = el('input', 'ds-in'); label.maxLength = 32; label.required = true;
    var text = el('input', 'ds-in'); text.maxLength = 120; text.required = true;
    var voice = el('select', 'ds-select');
    var o0 = el('option', null, _t('js.sbo.voice_default', 'Pepe\'s voice')); o0.value = ''; voice.appendChild(o0);
    (s.voices || []).forEach(function (v) { var o = el('option', null, v.display); o.value = v.id; voice.appendChild(o); });
    var pr = el('input', 'ds-in'); pr.type = 'number'; pr.min = 0; pr.max = s.max_price; pr.value = s.default_price;
    f.appendChild(field(_t('js.sbo.label', 'Label'), label));
    f.appendChild(field(_t('js.sbo.text', 'What Pepe says (120 characters)'), text, _t('js.sbo.text_hint', 'No slurs, threats, sexual content about real people, phone numbers or fake staff announcements.')));
    f.appendChild(field(_t('js.sbo.voice', 'Voice'), voice));
    f.appendChild(field(_t('js.sbo.price', 'Price per play (PAT)'), pr, _t('js.sbo.price_hint', '0 - {max} PAT. Your pad gets 20% of every paid play.', { max: num(s.max_price) })));
    var go = el('button', 'ds-btn', _t('js.sbo.add', 'Add')); go.type = 'submit'; f.appendChild(go);
    f.addEventListener('submit', function (ev) {
      ev.preventDefault(); go.disabled = true;
      post({ action: 'add_tts', label: label.value, text: text.value, voice: voice.value || null, price: Number(pr.value) })
        .then(function (d) { state = d; say(_t('js.sbo.added', 'Added - Pepe renders it in a minute or two.'), 'ok'); render(); })
        .catch(function (e) { go.disabled = false; say(e.message, 'bad'); });
    });
    host.appendChild(f);

    // add a posted mic clip
    var g = el('form', 'ds-form'); g.noValidate = true;
    g.appendChild(el('h3', 'ds-h3', _t('js.sbo.add_mic', 'Add a 🔊 mic clip from this pad')));
    var ml = el('input', 'ds-in'); ml.maxLength = 32;
    var mp = el('input', 'ds-in'); mp.placeholder = '/p/' + slug + '/posts/…';
    var ms = el('input', 'ds-in'); ms.type = 'number'; ms.min = 0; ms.step = '0.1'; ms.value = 0;
    var me = el('input', 'ds-in'); me.type = 'number'; me.min = 0; me.step = '0.1'; me.value = s.secs;
    g.appendChild(field(_t('js.sbo.label', 'Label'), ml));
    g.appendChild(field(_t('js.sbo.post', 'The mic clip post (link)'), mp, _t('js.sbo.post_hint', 'One person heard in it, who hasn\'t opted out of soundboards. They earn a cut of every paid play.')));
    g.appendChild(field(_t('js.sbo.start', 'From (seconds)'), ms));
    g.appendChild(field(_t('js.sbo.end', 'To (seconds, at most {n} s later)', { n: s.secs }), me));
    var go2 = el('button', 'ds-btn', _t('js.sbo.add', 'Add')); go2.type = 'submit'; g.appendChild(go2);
    g.addEventListener('submit', function (ev) {
      ev.preventDefault(); go2.disabled = true;
      post({ action: 'add_mic', label: ml.value, post: mp.value, start: Number(ms.value), end: Number(me.value), price: Number(pr.value) })
        .then(function (d) { state = d; say(_t('js.sbo.added', 'Added - Pepe renders it in a minute or two.'), 'ok'); render(); })
        .catch(function (e) { go2.disabled = false; say(e.message, 'bad'); });
    });
    host.appendChild(g);
    host.appendChild(el('p', 'ds-meta', _t('js.sbo.chat', 'In the room: !sb add [label] = [line] -v [voice] · !sb addmic [label] @user · !sb remove [label] · !sb on|off')));
    host.appendChild(msg);
  }
  fetch(api + '/manage', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
    .then(function (d) { if (!d || !d.ok) { host.textContent = (d && d.error) || _t('js.sbo.failed', 'That didn\'t work.'); return; } state = d; render(); })
    .catch(function () { host.textContent = _t('js.sbo.failed', 'That didn\'t work.'); });
})();
