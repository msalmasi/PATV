// /settings/privacy - 🎬 your cam on pads' Stages (stagefix site, stageleave.js + stagepin.js): where a pad's owner (or staff) has
// your Camfrog cam on its Stage right now, each with "Take me off this Stage" (it ends at once; that pad can't put you back for an
// hour, doubling on repeats up to 24 h), and the pads that can't put you back yet (until when).
// stagefix final round (D-17 / DF-45, stagepin.js): your level (Yes / only after I say yes, pad by pad / never), the asks out to
// you right now (a pad asking to put your cam up: Allow / No; "keep going?" after 10 minutes on a Stage: Keep going / Keep going
// and don't ask again on this pad / Take me off - 2 minutes to answer), and the pads you said yes to (Remove).
//   GET  /api/privacy/stage         {linked, on, off, level, yes: [{pad, title, slug, at}], asks: [{id, kind, pad, title, slug, by, expires}]}
//   POST /api/stage/leave           {slot} | {room} (mfix: a pin on a pad's mic stage)
//   POST /api/privacy/stage/level   {level}
//   POST /api/privacy/stage/pad     {room, yes: false}
//   POST /api/stage/ask/<id>        {answer}
(function () {
  'use strict';
  var root = document.getElementById('pvSl');
  if (!root) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var onEl = document.getElementById('pvSlOn'), offEl = document.getElementById('pvSlOff'), st = document.getElementById('pvSlSt');
  var lvEl = document.getElementById('pvSlLevel'), askBox = document.getElementById('pvSlAsks'), askEl = document.getElementById('pvSlAskList');
  var yesEl = document.getElementById('pvSlYes');
  var timer = null;
  function say(text, kind) { st.textContent = text || ''; st.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  function when(ms) {
    try { return new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return new Date(ms).toISOString(); }
  }
  function clock(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return new Date(ms).toISOString(); }
  }
  function padLink(p) {
    var a = document.createElement('a');
    a.href = '/p/' + encodeURIComponent(p.slug || p.pad);
    a.textContent = p.title || p.pad;
    return a;
  }
  function btn(text, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ds-btn sm'; b.textContent = text;
    b.addEventListener('click', function () { fn(b); });
    return b;
  }
  function row(p, right, btns) {
    var li = document.createElement('li');
    var a = document.createElement('span'); a.appendChild(padLink(p)); li.appendChild(a);
    if (right) { var b = document.createElement('span'); b.textContent = right; li.appendChild(b); }
    (btns || []).forEach(function (x) { if (x) li.appendChild(x); });
    return li;
  }
  function empty(el, text) { el.textContent = ''; var li = document.createElement('li'); var s = document.createElement('span'); s.textContent = text; li.appendChild(s); el.appendChild(li); }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function busy(on, b) { if (b) b.disabled = !!on; }
  function paint(d) {
    if (lvEl && d.level && document.activeElement !== lvEl) lvEl.value = d.level;
    // the asks out to you now
    var asks = d.asks || [];
    if (askBox) askBox.hidden = !asks.length;
    if (askEl) {
      askEl.textContent = '';
      asks.forEach(function (a) {
        var text = a.kind === 'pin' ? _t('js.sl.ask_pin', 'wants to put your cam on its Stage') : _t('js.sl.ask_check', 'has had your cam on its Stage for 10 minutes - keep going?');
        var right = text + ' · ' + _t('js.sl.ask_until', 'answer by {when}', { when: clock(a.expires) });
        var btns = a.kind === 'pin'
          ? [btn(_t('js.sl.allow', 'Allow'), function (b) { answer(a, 'yes', b); }), btn(_t('js.sl.no', 'No'), function (b) { answer(a, 'no', b); })]
          : [btn(_t('js.sl.keep', 'Keep going'), function (b) { answer(a, 'keep', b); }),
             btn(_t('js.sl.keep_always', 'Keep going - don\'t ask again on this pad'), function (b) { answer(a, 'keep_always', b); }),
             btn(_t('js.sl.take_off', 'Take me off this Stage'), function (b) { answer(a, 'off', b); })];
        askEl.appendChild(row(a, right, btns));
      });
    }
    onEl.textContent = '';
    if (!d.on || !d.on.length) empty(onEl, _t('js.sl.none_on', "Your cam isn't on any Stage right now."));
    else d.on.forEach(function (p) { onEl.appendChild(row(p, null, [btn(_t('js.sl.take_off', 'Take me off this Stage'), function (b) { leave(p, b); })])); });
    offEl.textContent = '';
    if (!d.off || !d.off.length) empty(offEl, _t('js.sl.none_off', 'No pad is being kept away.'));
    else d.off.forEach(function (p) { offEl.appendChild(row(p, _t('js.sl.until', 'until {when}', { when: when(p.until) }))); });
    if (yesEl) {
      yesEl.textContent = '';
      if (!d.yes || !d.yes.length) empty(yesEl, _t('js.sl.none_yes', "You haven't said yes to any pad."));
      else d.yes.forEach(function (p) { yesEl.appendChild(row(p, _t('js.sl.since', 'since {when}', { when: when(p.at) }), [btn(_t('js.sl.remove', 'Remove'), function (b) { dropYes(p, b); })])); });
    }
    // an ask has minutes (a "keep going?" two): look again sooner while one is out
    schedule(asks.length ? 10000 : 30000);
  }
  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { if (document.hidden) schedule(ms); else load(); }, ms);
  }
  function load() {
    fetch('/api/privacy/stage', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d || !d.ok || !d.linked) throw new Error('no'); paint(d); })
      .catch(function () { say(_t('js.sl.load_failed', "Couldn't load this - reload the page."), 'bad'); schedule(30000); });
  }
  function done(d, b, okText) {
    busy(false, b);
    if (!d || !d.ok) { say((d && d.error) || _t('js.sl.failed', "That didn't work - try again."), 'bad'); return; }
    say(okText, 'ok');
    load();
  }
  function leave(p, b) {
    busy(true, b);
    say(_t('js.sl.working', 'Taking you off…'), 'wait');
    post('/api/stage/leave', p.slot ? { slot: p.slot } : { room: p.slug || p.pad })      // mfix: a mic-stage pin goes by its pad
      .then(function (d) { done(d, b, d && d.ok ? _t('js.sl.done', "You're off {pad}'s Stage until {when}.", { pad: p.title || p.pad, when: when(d.until) }) : ''); })
      .catch(function () { busy(false, b); say(_t('js.sl.failed', "That didn't work - try again."), 'bad'); });
  }
  function answer(a, ans, b) {
    busy(true, b);
    post('/api/stage/ask/' + encodeURIComponent(a.id), { answer: ans })
      .then(function (d) {
        var text = ans === 'yes' ? _t('js.sl.allowed', 'Allowed - {pad} can put your cam on its Stage.', { pad: a.title || a.pad })
          : ans === 'no' ? _t('js.sl.declined', 'OK - your cam stays off {pad}\'s Stage.', { pad: a.title || a.pad })
          : ans === 'off' ? (d && d.until ? _t('js.sl.done', "You're off {pad}'s Stage until {when}.", { pad: a.title || a.pad, when: when(d.until) }) : '')
          : _t('js.sl.kept', 'OK - you stay on {pad}\'s Stage.', { pad: a.title || a.pad });
        done(d, b, text);
      })
      .catch(function () { busy(false, b); say(_t('js.sl.failed', "That didn't work - try again."), 'bad'); });
  }
  function dropYes(p, b) {
    busy(true, b);
    post('/api/privacy/stage/pad', { room: p.pad, yes: false })
      .then(function (d) { done(d, b, _t('js.sl.removed', 'Removed - {pad} has to ask you again.', { pad: p.title || p.pad })); })
      .catch(function () { busy(false, b); say(_t('js.sl.failed', "That didn't work - try again."), 'bad'); });
  }
  if (lvEl) {
    lvEl.addEventListener('change', function () {
      lvEl.disabled = true;
      post('/api/privacy/stage/level', { level: lvEl.value })
        .then(function (d) { lvEl.disabled = false; done(d, null, _t('js.sl.level_saved', 'Saved.')); })
        .catch(function () { lvEl.disabled = false; say(_t('js.sl.failed', "That didn't work - try again."), 'bad'); });
    });
  }
  load();
})();
