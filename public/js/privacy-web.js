// /settings/privacy - 🌉 "On the website" (1.99aid privacy controls S6; privacystate.js). A master switch "Show me on the website
// (bridge)" (checked = shown; unchecked = !bridge hide) over one switch per website control, each checked = that privacy switch ON:
// Name (incognito - POST /api/privacy/incognito, incognito.js), Mic transcripts (POST /api/privacy/state {kind: "tx"}), Cam (live cam
// off - POST /api/privacy/livecam, livecam.js). Bridge and transcripts are Pepe's: a change is a request, and the switch keeps showing
// Pepe's LAST REPORTED state with "Waiting for Pepe…" until his report of it arrives (GET /api/privacy/state: waiting -> null). While the
// bridge is off the other switches show on and greyed (bridge off is an override: the person's own switches come back with it).
// The page re-reads the state every minute (a change made in a Camfrog room shows up here too). Server text goes in via textContent.
(function () {
  'use strict';
  var card = document.getElementById('web');
  var master = document.getElementById('pvWebBridge');
  if (!card || !master) return;
  var inc = document.getElementById('pvWebInc');
  var tx = document.getElementById('pvWebTx');
  var cam = document.getElementById('pvWebCam');
  var forced = document.getElementById('pvWebForced');
  var stB = document.getElementById('pvWebBridgeSt');
  var stI = document.getElementById('pvWebIncSt');
  var stT = document.getElementById('pvWebTxSt');
  var stC = document.getElementById('pvWebCamSt');
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var last = null, timer = null, polls = 0, want = { bridge: null, tx: null };
  function say(el, text, kind) { if (!el) return; el.textContent = text || ''; el.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  function row(el, on) { var r = el && el.closest('.pv-set'); if (r) r.classList.toggle('pending', !!on); }
  function api(url, body) {
    return fetch(url, body
      ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function bridgeText(on) {
    return on === null || on === undefined ? _t('js.pv3.st_unknown', 'Pepe hasn\'t reported this yet - it shows here once he does.')
      : on ? _t('js.pv3.st_hidden', 'Bridge off - the website shows you under a random frog name, blacks out your messages and mic transcripts, and hides your cam.')
        : _t('js.pv3.st_shown', 'You\'re on the website - your own switches below apply.');
  }
  // paint everything from a state answer ({bridge, tx, incognito, livecam})
  function paint(d, confirm) {
    last = d;
    var B = d.bridge || {}, X = d.tx || {}, I = d.incognito || {}, L = d.livecam || {};
    var hidden = B.on === true;
    if (B.on !== null && B.on !== undefined) master.checked = !hidden;
    master.disabled = !!B.waiting;
    row(master, B.waiting);
    if (B.waiting) say(stB, _t('js.inc.waiting', 'Waiting for Pepe…'), 'wait');
    else if (B.failed) say(stB, _t('js.pv3.failed', 'Pepe couldn\'t do that - nothing changed. Try again, or use the command in a Camfrog room.') + (B.failed.message ? ' (' + B.failed.message + ')' : ''), 'bad');
    else if (confirm && want.bridge !== null) {
      var same = (B.on === true) === want.bridge;
      want.bridge = null;
      say(stB, same ? _t('js.inc.confirmed', 'Pepe confirmed it.') + ' ' + bridgeText(B.on) : _t('js.inc.differs', 'Pepe reports it\'s still the other way - try again.'), same ? 'ok' : 'bad');
    } else say(stB, bridgeText(B.on));
    if (forced) forced.hidden = !hidden;
    // the sub-switches: on and greyed while the bridge is off; else each person's own switch
    if (inc) { inc.checked = hidden || I.on === true; inc.disabled = hidden || !!I.waiting; row(inc, I.waiting); }
    if (tx) { tx.checked = hidden || X.on === true; tx.disabled = hidden || !!X.waiting; row(tx, X.waiting); }
    if (cam) { cam.checked = hidden || L.off === true; cam.disabled = hidden; }
    if (X.waiting) say(stT, _t('js.inc.waiting', 'Waiting for Pepe…'), 'wait');
    else if (X.failed) say(stT, _t('js.pv3.failed', 'Pepe couldn\'t do that - nothing changed. Try again, or use the command in a Camfrog room.'), 'bad');
    else if (confirm && want.tx !== null) {
      var same2 = (X.on === true) === want.tx;
      want.tx = null;
      say(stT, same2 ? _t('js.inc.confirmed', 'Pepe confirmed it.') : _t('js.inc.differs', 'Pepe reports it\'s still the other way - try again.'), same2 ? 'ok' : 'bad');
    }
    if (I.waiting) say(stI, _t('js.inc.waiting', 'Waiting for Pepe…'), 'wait');
  }
  function poll() {
    clearTimeout(timer);
    api('/api/privacy/state').then(function (d) {
      if (!d || !d.ok) { timer = setTimeout(poll, 5000); return; }
      paint(d, true);
      var waiting = (d.bridge && d.bridge.waiting) || (d.tx && d.tx.waiting) || (d.incognito && d.incognito.waiting);
      if (waiting) {
        polls++;
        if (polls > 90) { say(stB, _t('js.inc.slow', 'Pepe hasn\'t answered yet - it will happen when he does.'), 'wait'); return; }
        timer = setTimeout(poll, 2000);
      } else {
        polls = 0;
        timer = setTimeout(poll, 60000);
      }
    }).catch(function () { timer = setTimeout(poll, 5000); });
  }
  function sent(d, el, st) {
    if (!d || !d.ok) { if (el) { el.disabled = false; row(el, false); } say(st, (d && d.error) || _t('js.inc.not_sent', 'Not sent - try again.'), 'bad'); return false; }
    polls = 0;
    say(st, _t('js.inc.waiting', 'Waiting for Pepe…'), 'wait');
    timer = setTimeout(poll, 1500);
    return true;
  }
  function unreachable(el, st) { if (el) { el.disabled = false; row(el, false); } say(st, _t('js.inc.unreachable', 'Couldn\'t reach the site - try again.'), 'bad'); }
  master.addEventListener('change', function () {
    var hide = !master.checked;
    master.checked = hide;                      // keep showing Pepe's state until he confirms
    master.disabled = true; row(master, true);
    say(stB, _t('js.inc.sending', 'Sending to Pepe…'), 'wait');
    api('/api/privacy/state', { kind: 'bridge', on: hide }).then(function (d) { if (sent(d, master, stB)) want.bridge = hide; })
      .catch(function () { unreachable(master, stB); });
  });
  if (tx) tx.addEventListener('change', function () {
    var off = !!tx.checked;
    tx.checked = !off;
    tx.disabled = true; row(tx, true);
    say(stT, _t('js.inc.sending', 'Sending to Pepe…'), 'wait');
    api('/api/privacy/state', { kind: 'tx', on: off }).then(function (d) { if (sent(d, tx, stT)) want.tx = off; })
      .catch(function () { unreachable(tx, stT); });
  });
  if (inc) inc.addEventListener('change', function () {
    var on = !!inc.checked;
    inc.checked = !on;
    inc.disabled = true; row(inc, true);
    say(stI, _t('js.inc.sending', 'Sending to Pepe…'), 'wait');
    api('/api/privacy/incognito', { on: on }).then(function (d) { sent(d, inc, stI); })
      .catch(function () { unreachable(inc, stI); });
  });
  if (cam) cam.addEventListener('change', function () {
    var off = !!cam.checked;                    // the site's own switch: it applies at once
    cam.disabled = true;
    api('/api/privacy/livecam', { off: off }).then(function (d) {
      cam.disabled = false;
      if (!d || !d.ok) { cam.checked = !off; return say(stC, (d && d.error) || _t('js.inc.not_sent', 'Not sent - try again.'), 'bad'); }
      cam.checked = !!d.off;
      say(stC, d.off ? _t('js.pv3.cam_on', 'Your cam is hidden from the website.') : _t('js.pv3.cam_off', 'Your cam can be watched on the website (who: Live cam, below).'), 'ok');
      var lc = document.getElementById('pvLc');  // the Live cam card's own switch shows the same
      if (lc) lc.checked = !d.off;
    }).catch(function () { cam.disabled = false; cam.checked = !off; say(stC, _t('js.inc.unreachable', 'Couldn\'t reach the site - try again.'), 'bad'); });
  });
  var wb = card.getAttribute('data-wait-bridge'), wt = card.getAttribute('data-wait-tx');
  if (wb) want.bridge = wb === '1';
  if (wt) want.tx = wt === '1';
  timer = setTimeout(poll, wb || wt ? 1500 : 60000);
})();
