// /settings/privacy (1.99wa, incognito.js): the incognito switch. A change is a request to Pepe (POST /api/privacy/incognito);
// the switch keeps showing Pepe's LAST REPORTED state with "Waiting for Pepe…" until his report of the change arrives
// (GET /api/privacy/incognito: waiting -> null), then shows what he reports. A change made in chat shows up here too (the page
// re-reads the state every minute). Server text goes in via textContent.
(function () {
  'use strict';
  var card = document.getElementById('incognito');
  var box = document.getElementById('pvInc');
  if (!card || !box) return;
  var row = document.getElementById('pvRow');
  var st = document.getElementById('pvSt');
  var rep = document.getElementById('pvRep');
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var want = null, polls = 0, timer = null;
  // wave 3 (design §N): with a Pepe that has the 🧠 memory switch, incognito is about the website only (data-mem)
  var memOn = card.getAttribute('data-mem') === '1';
  function say(text, kind) { st.textContent = text || ''; st.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  function stateText(on) {
    return on === null ? _t('js.inc.st_unknown', 'Pepe hasn\'t reported your incognito yet.')
      : on ? (memOn ? _t('js.inc.st_on_v2', 'Incognito is ON - the website hides who you are.') : _t('js.inc.st_on', 'Incognito is ON - Pepe isn\'t remembering what you say.'))
      : _t('js.inc.st_off', 'Incognito is OFF.');
  }
  function busy(on) { box.disabled = !!on; if (row) row.classList.toggle('pending', !!on); }
  function api(body) {
    return fetch('/api/privacy/incognito', body
      ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function paint(d, confirmMsg) {
    if (d.on !== null && d.on !== undefined) box.checked = !!d.on;
    if (rep && d.reported) rep.textContent = _t('js.inc.reported', 'Pepe last reported it {when}.', { when: new Date(d.reported).toLocaleString(window.PATV_I18N && PATV_I18N.lang || undefined) });
    if (d.waiting) { busy(true); say(_t('js.inc.waiting', 'Waiting for Pepe…'), 'wait'); return; }
    busy(false);
    if (d.failed) return say(_t('js.inc.failed', 'Pepe couldn\'t do that - nothing changed. Try again, or type !incognito in chat.') + (d.failed.message ? ' (' + d.failed.message + ')' : ''), 'bad');
    if (confirmMsg && want !== null) {
      var same = !!d.on === want;
      want = null;
      return say(same ? _t('js.inc.confirmed', 'Pepe confirmed it.') + ' ' + stateText(d.on)
        : _t('js.inc.differs', 'Pepe reports it\'s still the other way - try again.'), same ? 'ok' : 'bad');
    }
    say(stateText(d.on === undefined ? null : d.on));
  }
  function poll() {
    clearTimeout(timer);
    api().then(function (d) {
      if (!d || !d.ok) { timer = setTimeout(poll, 5000); return; }
      paint(d, true);
      if (d.waiting) {
        polls++;
        if (polls > 90) { busy(false); return say(_t('js.inc.slow', 'Pepe hasn\'t answered yet - it will happen when he does.'), 'wait'); }
        timer = setTimeout(poll, 2000);
      } else {
        polls = 0;
        timer = setTimeout(poll, 60000);
      }
    }).catch(function () { timer = setTimeout(poll, 5000); });
  }
  box.addEventListener('change', function () {
    var on = !!box.checked;
    box.checked = !on;                        // keep showing Pepe's state until he confirms
    busy(true);
    say(_t('js.inc.sending', 'Sending to Pepe…'), 'wait');
    api({ on: on }).then(function (d) {
      if (!d || !d.ok) { busy(false); return say((d && d.error) || _t('js.inc.not_sent', 'Not sent - try again.'), 'bad'); }
      want = on; polls = 0;
      say(_t('js.inc.waiting', 'Waiting for Pepe…'), 'wait');
      timer = setTimeout(poll, 1500);
    }).catch(function () { busy(false); say(_t('js.inc.unreachable', 'Couldn\'t reach the site - try again.'), 'bad'); });
  });
  if (card.getAttribute('data-waiting')) { var w = card.getAttribute('data-want'); want = w === '' ? null : w === '1'; timer = setTimeout(poll, 1500); }
  else timer = setTimeout(poll, 60000);
})();
