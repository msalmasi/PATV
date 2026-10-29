/* A/V sync's admin-only settings and measured timing readout. No audio or relay controls live here. */
(function () {
  'use strict';
  var form = document.getElementById('avsForm'); if (!form) return;
  var fields = document.getElementById('avsFields'), message = document.getElementById('avsMessage');
  var view = null, editing = false, saving = false;
  var labels = {
    mode: 'Who gets sync', apply_video: 'Delay relayed cams', apply_mic: 'Delay mic signs', apply_mp3: 'Also sync with standard MP3 audio',
    engine_chromium: 'Enable Chromium video delay', engine_firefox: 'Enable Firefox video delay', engine_safari: 'Enable Safari video delay',
    fallback_rtc_ms: 'WebRTC fallback delay (ms)', fallback_mp3_ms: 'MP3 fallback delay (ms)',
    k_pt_ms: 'Pass-through calibration (ms)', k_re_ms: 'Re-encode calibration (ms)',
    ind_path_ms: 'Mic-sign delivery time (ms)', k_ind_ms: 'Mic-sign calibration (ms)',
    cap_ms: 'Maximum video delay (ms)', cap_ind_ms: 'Maximum mic-sign delay (ms)', deadband_ms: 'Ignore changes smaller than (ms)',
    period_s: 'Recompute every (s)', mods_instant: 'Show the moderation mic panel instantly for room moderators'
  };
  function node(tag, text, cls) { var el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; }
  function buttons(disabled) { Array.prototype.forEach.call(form.querySelectorAll('button'), function (el) { el.disabled = disabled; }); }
  function build() {
    fields.textContent = '';
    Object.keys(view.fields).forEach(function (key) {
      var def = view.fields[key], label = node('label'), input;
      label.style.display = 'block'; label.style.margin = '8px 0';
      if (typeof def.def === 'boolean') { input = node('input'); input.type = 'checkbox'; label.appendChild(input); label.appendChild(document.createTextNode(' ' + labels[key])); }
      else {
        label.appendChild(document.createTextNode(labels[key] + ' '));
        input = node(def.choices ? 'select' : 'input');
        if (def.choices) def.choices.forEach(function (choice) { var option = node('option', choice); option.value = choice; input.appendChild(option); });
        else { input.type = 'number'; input.min = def.min; input.max = def.max; input.step = '1'; input.inputMode = 'numeric'; }
        label.appendChild(input);
      }
      input.name = key;
      label.appendChild(node('small', ' · default ' + def.def + (def.min == null ? '' : ' · ' + def.min + '–' + def.max), 'adm-help'));
      fields.appendChild(label);
    });
  }
  function fill() {
    Object.keys(view.fields).forEach(function (key) { var input = form.elements[key]; if (input.type === 'checkbox') input.checked = view.cfg[key]; else input.value = view.cfg[key]; });
    document.getElementById('avsVersion').textContent = view.v ? 'v' + view.v : 'off by default · never saved';
  }
  function ms(value) { return value == null ? 'unknown' : value + ' ms'; }
  function table(id, rows, columns, empty) {
    var body = document.getElementById(id); body.textContent = '';
    rows.forEach(function (row) { var tr = node('tr'); columns.forEach(function (col) { tr.appendChild(node('td', col(row))); }); body.appendChild(tr); });
    if (!rows.length) { var tr = node('tr'), td = node('td', empty, 'adm-help'); td.colSpan = columns.length; tr.appendChild(td); body.appendChild(tr); }
  }
  function render(next) {
    var first = !view; view = next;
    if (first) build();
    if (!editing) fill();
    table('avsRooms', view.rooms || [], [function (r) { return r.room; }, function (r) { return ms(r.lat.mix_ms); }, function (r) { return ms(r.lat.helper_ms); },
      function (r) { return ms(r.lat.rtc_ms); }, function (r) { return ms(r.lat.mp3_ms); }, function (r) { return r.age_s.toFixed(1) + ' s'; }], 'No recent streaming-room report.');
    table('avsRelays', view.relays || [], [function (r) { return r.path; }, function (r) { return r.src; }, function (r) { return ms(r.hold_ms); }], 'No relay timing reported.');
    var list = document.getElementById('avsAudit'); list.textContent = '';
    (view.audit || []).forEach(function (a) {
      var detail = a.detail || {}, changed = detail.changed || {};
      var text = Object.keys(changed).map(function (key) { return key + ' ' + changed[key][0] + ' → ' + changed[key][1]; }).join(', ') || 'no value changes';
      list.appendChild(node('li', new Date(a.at).toLocaleString() + ' · ' + (a.admin || '?') + ' · v' + detail.v + ': ' + text));
    });
    buttons(saving);
  }
  function request(body) {
    var opts = { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } };
    if (body) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/admin/pepe/avsync', opts).then(function (response) { return response.json(); });
  }
  function send(reset) {
    if (!view || saving) return;
    var cfg = {}; Object.keys(view.fields).forEach(function (key) { var input = form.elements[key]; cfg[key] = input.type === 'checkbox' ? input.checked : input.value; });
    saving = true; buttons(true); message.textContent = 'Saving…';
    request({ cfg: cfg, reset: reset, reason: form.elements.reason.value.trim() }).then(function (data) {
      if (!data.ok) { message.textContent = data.error || 'Could not save.'; return; }
      editing = false; render(data.view); form.elements.reason.value = ''; message.textContent = 'Saved as v' + data.v + '. Viewers pick it up on their next check.';
    }).catch(function () { message.textContent = 'The site did not answer.'; }).then(function () { saving = false; buttons(false); });
  }
  form.addEventListener('input', function () { editing = true; }); form.addEventListener('change', function () { editing = true; });
  form.addEventListener('submit', function (event) { event.preventDefault(); send(false); });
  document.getElementById('avsReset').addEventListener('click', function () { if (window.confirm('Reset A/V sync to its disabled defaults?')) send(true); });
  function load() { if (saving) return; request().then(function (data) { if (data.ok) { render(data); if (message.textContent === 'Loading…') message.textContent = ''; } else message.textContent = data.error || 'Could not load.'; }).catch(function () { if (!view) message.textContent = 'The site did not answer.'; }); }
  load(); setInterval(function () { if (!document.hidden) load(); }, 5000);
}());
