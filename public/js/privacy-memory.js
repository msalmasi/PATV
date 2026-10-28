// /settings/privacy - 🧠 Pepe's memory (wave 3, design §N; memoryoptout.js). The switch shows REMEMBERING ("Let Pepe remember what I
// tell him"): checked = Pepe remembers. A change is a request to Pepe (POST /api/privacy/memory {on}, where on = "don't remember me");
// the switch keeps showing Pepe's LAST REPORTED state with "Waiting for Pepe…" until his report of the change arrives (GET
// /api/privacy/memory: waiting -> null). Turning it off with "Also forget what Pepe already knows about me" ticked runs Make Pepe
// forget me instead, after its FORGET confirm (POST /api/privacy/pepe-forget {confirm, keep_off: true} - the forget and the switch in
// one request). A change made in chat shows up here too (the page re-reads the state every minute). Server text goes in via
// textContent.
(function () {
  'use strict';
  var card = document.getElementById('memory');
  var box = document.getElementById('pvMem');
  if (!card || !box) return;
  var row = document.getElementById('pvMemRow');
  var st = document.getElementById('pvMemSt');
  var rep = document.getElementById('pvMemRep');
  var also = document.getElementById('pvMemForget');
  var pf = document.getElementById('pvMemPf');
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var lang = window.PATV_I18N && PATV_I18N.lang || undefined;
  var want = null, polls = 0, timer = null;
  function say(text, kind) { st.textContent = text || ''; st.className = 'pv-st' + (kind ? ' ' + kind : ''); }
  function stateText(d) {
    var on = d.on === undefined ? null : d.on;
    if (on === null) return _t('js.mem.st_unknown', 'Pepe hasn\'t reported your memory switch yet.');
    if (!on) return _t('js.mem.st_on', 'Pepe remembers what you tell him.');
    return d.since ? _t('js.mem.st_off_since', 'Pepe\'s memory is off for you since {when} - he learns nothing new from what you say.', { when: new Date(d.since).toLocaleString(lang) })
      : _t('js.mem.st_off', 'Pepe\'s memory is off for you - he learns nothing new from what you say.');
  }
  function busy(on) { box.disabled = !!on; if (row) row.classList.toggle('pending', !!on); }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function get() {
    return fetch('/api/privacy/memory', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }
  function paint(d, confirmMsg) {
    if (d.on !== null && d.on !== undefined) box.checked = !d.on;          // checked = remembering
    if (rep && d.reported) rep.textContent = _t('js.inc.reported', 'Pepe last reported it {when}.', { when: new Date(d.reported).toLocaleString(lang) });
    if (d.waiting) { busy(true); say(_t('js.inc.waiting', 'Waiting for Pepe…'), 'wait'); return; }
    busy(false);
    if (d.failed) return say(_t('js.mem.failed', 'Pepe couldn\'t do that - nothing changed. Try again, or type !remember in chat.') + (d.failed.message ? ' (' + d.failed.message + ')' : ''), 'bad');
    if (confirmMsg && want !== null) {
      var same = !!d.on === want;
      want = null;
      return say(same ? _t('js.inc.confirmed', 'Pepe confirmed it.') + ' ' + stateText(d)
        : _t('js.inc.differs', 'Pepe reports it\'s still the other way - try again.'), same ? 'ok' : 'bad');
    }
    say(stateText(d));
  }
  function poll() {
    clearTimeout(timer);
    get().then(function (d) {
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
  function sent(d, optOut) {
    if (!d || !d.ok) { busy(false); return say((d && d.error) || _t('js.inc.not_sent', 'Not sent - try again.'), 'bad'); }
    want = optOut; polls = 0;
    say(_t('js.inc.waiting', 'Waiting for Pepe…'), 'wait');
    timer = setTimeout(poll, 1500);
  }
  box.addEventListener('change', function () {
    var optOut = !box.checked;                 // unchecked = "don't remember me"
    box.checked = optOut;                      // keep showing Pepe's state until he confirms
    if (optOut && also && also.checked && pf) {
      // "Also forget what Pepe already knows about me": Make Pepe forget me's own confirm first
      pf.hidden = false;
      say(_t('js.mem.type_forget', 'Type FORGET to switch Pepe\'s memory off and make him forget you.'), 'wait');
      var inp = pf.querySelector('input');
      if (inp) inp.focus();
      return;
    }
    busy(true);
    say(_t('js.inc.sending', 'Sending to Pepe…'), 'wait');
    post('/api/privacy/memory', { on: optOut }).then(function (d) { sent(d, optOut); })
      .catch(function () { busy(false); say(_t('js.inc.unreachable', 'Couldn\'t reach the site - try again.'), 'bad'); });
  });
  if (pf) {
    pf.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = pf.confirm.value.trim();
      if (v.toLowerCase() !== 'forget') return say(_t('js.pf.type', 'Type FORGET to confirm.'), 'bad');
      var b = pf.querySelector('button');
      b.disabled = true;
      busy(true);
      say(_t('js.inc.sending', 'Sending to Pepe…'), 'wait');
      post('/api/privacy/pepe-forget', { confirm: v, keep_off: true, hide_lines: false }).then(function (d) {
        b.disabled = false;
        if (d && d.ok) { pf.confirm.value = ''; pf.hidden = true; if (also) also.checked = false; }
        if (d && d.ok && !d.memory_action) { busy(false); return say(_t('js.mem.forgot_only', 'Pepe forgets what he knew about you - the switch didn\'t change (try it again).'), 'bad'); }
        sent(d, true);
      }).catch(function () { b.disabled = false; busy(false); say(_t('js.inc.unreachable', 'Couldn\'t reach the site - try again.'), 'bad'); });
    });
  }
  if (also && pf) also.addEventListener('change', function () { if (!also.checked) pf.hidden = true; });
  // Make Pepe forget me (privacy-forget.js) with "Keep it that way" queues the switch too: show its wait here
  window.addEventListener('pv-memory-request', function () { want = true; polls = 0; busy(true); say(_t('js.inc.waiting', 'Waiting for Pepe…'), 'wait'); timer = setTimeout(poll, 1500); });
  if (card.getAttribute('data-waiting')) { var w = card.getAttribute('data-want'); want = w === '' ? null : w === '1'; timer = setTimeout(poll, 1500); }
  else timer = setTimeout(poll, 60000);
})();
