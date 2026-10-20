// /settings/privacy - 👁 who's watching your cam (1.99yq, camviewers.js): who has your Camfrog cam open live through the
// website right now, who took a snapshot / clip in the last 30 minutes, and the accounts you blocked from it (add / remove).
// Same list as !blockviewer in Camfrog - one home on the site.
(function () {
  'use strict';
  var root = document.getElementById('pvCv');
  if (!root) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var liveEl = document.getElementById('pvCvLive'), recEl = document.getElementById('pvCvRecent'), blkEl = document.getElementById('pvCvBlocks');
  var form = document.getElementById('pvCvForm'), input = document.getElementById('pvCvName'), st = document.getElementById('pvCvSt');
  function say(text, kind) { st.textContent = text || ''; st.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  function who(p) {
    var name = p.display || p.username || '?';
    var bits = [];
    if (p.username && p.username !== name) bits.push(p.username);
    if (p.camfrog) bits.push(_t('js.cv.camfrog', 'Camfrog: {name}', { name: p.camfrog }));
    return bits.length ? name + ' (' + bits.join(', ') + ')' : name;
  }
  function row(text, right, btn) {
    var li = document.createElement('li');
    var a = document.createElement('span'); a.textContent = text; li.appendChild(a);
    if (right) { var b = document.createElement('span'); b.textContent = right; li.appendChild(b); }
    if (btn) li.appendChild(btn);
    return li;
  }
  function empty(el, text) { el.textContent = ''; el.appendChild(row(text)); }
  function kindsOf(p) {
    var L = { live: _t('js.cv.live', 'live'), snap: _t('js.cv.snap', 'snapshot'), clip: _t('js.cv.clip', 'clip') };
    return (p.kinds || []).map(function (k) { return L[k] || k; }).join(', ');
  }
  function ago(ms) { return _t('js.cv.ago', '{n} min ago', { n: Math.max(0, Math.round((Date.now() - ms) / 60000)) }); }
  function blockBtn(p) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ds-btn sm ghost'; b.textContent = _t('js.cv.block', 'Block');
    b.addEventListener('click', function () { send('block', p.username || p.camfrog, b); });
    return p.username || p.camfrog ? b : null;
  }
  function paintBlocks(list) {
    blkEl.textContent = '';
    if (!list || !list.length) return empty(blkEl, _t('js.cv.no_blocks', "You haven't blocked anyone."));
    list.forEach(function (x) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ds-btn sm ghost'; b.textContent = _t('js.cv.unblock', 'Unblock');
      b.addEventListener('click', function () { send('unblock', x.username || ('u:' + x.userId), b); });
      blkEl.appendChild(row(x.username || x.userId, null, b));
    });
  }
  function paint(d) {
    liveEl.textContent = '';
    var micN = Math.max(0, Number(d.mic_stage_n) || 0);
    if ((!d.live || !d.live.length) && !micN) empty(liveEl, _t('js.cv.nobody', 'Nobody right now.'));
    else (d.live || []).forEach(function (p) { liveEl.appendChild(row(who(p), p.since ? ago(p.since) : null, blockBtn(p))); });
    // micfollow (D-19): people who see your cam only on a pad's 🎙 mic stage while you hold the mic - counted, never named
    if (micN) liveEl.appendChild(row(_t('js.cv.mic_stage_n', 'On a pad\'s 🎙 mic stage: {n} watching (not named)', { n: micN })));
    recEl.textContent = '';
    if (!d.recent || !d.recent.length) empty(recEl, _t('js.cv.none_recent', 'Nobody in the last 30 minutes.'));
    else d.recent.forEach(function (p) { recEl.appendChild(row(who(p) + ' · ' + kindsOf(p), ago(p.at), blockBtn(p))); });
    paintBlocks(d.blocks);
  }
  function load() {
    fetch('/api/privacy/camviewers', { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d || !d.ok || !d.linked) throw new Error('no'); paint(d); })
      .catch(function () { say(_t('js.cv.load_failed', "Couldn't load this - reload the page."), 'bad'); });
  }
  function send(op, target, btn) {
    if (!target) return;
    if (btn) btn.disabled = true;
    say(_t('js.cv.saving', 'Saving…'), 'wait');
    fetch('/api/privacy/camviewers', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ op: op, target: target }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (d) {
        if (btn) btn.disabled = false;
        if (!d || !d.ok) return say((d && d.error) || _t('js.cv.failed', 'Not saved - try again.'), 'bad');
        var name = (d.user && d.user.username) || target;
        say(op === 'block' ? _t('js.cv.blocked', 'Blocked {name}.', { name: name }) : _t('js.cv.unblocked', 'Unblocked {name}.', { name: name }), 'ok');
        if (op === 'block') input.value = '';
        load();
      })
      .catch(function () { if (btn) btn.disabled = false; say(_t('js.cv.failed', 'Not saved - try again.'), 'bad'); });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = (input.value || '').trim();
    if (v) send('block', v, form.querySelector('button'));
  });
  load();
  setInterval(function () { if (!document.hidden) load(); }, 30000);
})();
