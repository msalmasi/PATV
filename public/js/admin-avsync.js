/* A/V sync's admin-only settings and measured timing readout. No audio or relay controls live here. */
(function () {
  'use strict';
  var form = document.getElementById('avsForm'); if (!form) return;
  var fields = document.getElementById('avsFields'), message = document.getElementById('avsMessage');
  var view = null, editing = false, saving = false;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  var labels = {
    mode: 'Who gets sync', apply_video: 'Delay relayed cams', apply_mic: 'Delay mic signs', apply_mp3: 'Also sync with standard MP3 audio',
    // 1.99ahm: the "On the mic" card and the chat's grab / drop lines, each its own switch
    apply_mic_card: _t('js.admavsync.apply_mic_card', 'Delay the On the mic card'),
    apply_mic_chat: _t('js.admavsync.apply_mic_chat', 'Delay mic grab/drop lines in chat'),
    apply_mic_list: _t('js.admavsync.apply_mic_list', "Delay the people list's 🎙 icons"),   // 1.99ahm: the people list's 🎙 icons, its own switch
    engine_chromium: 'Enable Chromium video delay', engine_firefox: 'Enable Firefox video delay', engine_safari: 'Enable Safari video delay',
    // (1.99ait avf review: "Cam" - the mic signs have their own fallbacks now, below)
    fallback_rtc_ms: 'Cam WebRTC fallback delay (ms)', fallback_mp3_ms: 'Cam MP3 fallback delay (ms)',
    // 1.99ait avf (F4, F5): the mic signs' own fallback; whether the viewer's toggle holds the mic signs too
    fallback_ind_rtc_ms: _t('js.admavsync.fallback_ind_rtc_ms', 'Mic-sign WebRTC fallback delay (ms)'),
    fallback_ind_mp3_ms: _t('js.admavsync.fallback_ind_mp3_ms', 'Mic-sign MP3 fallback delay (ms)'),
    mic_follow_toggle: _t('js.admavsync.mic_follow_toggle', "Viewers' Sync to the audio toggle also holds the mic signs"),
    k_pt_ms: 'Pass-through calibration (ms)', k_re_ms: 'Re-encode calibration (ms)',
    ind_path_ms: 'Mic-sign delivery time (ms)', k_ind_ms: 'Mic-sign calibration (ms)',
    cap_ms: 'Maximum video delay (ms)', cap_ind_ms: 'Maximum mic-sign delay (ms)', deadband_ms: 'Ignore changes smaller than (ms)',
    period_s: 'Recompute every (s)', mods_instant: 'Show the moderation mic panel instantly for room moderators'
  };
  // 1.99ahm: what each mic switch holds back (all four by the same mic-sign delay, so they line up with each other)
  var helps = {
    apply_mic: _t('js.admavsync.apply_mic_help', 'The mic stage’s tiles: a new speaker’s tile, the ring and newest highlights, who is speaking and the layout.'),
    apply_mic_card: _t('js.admavsync.apply_mic_card_help', 'The On the mic card beside the chat: people joining or leaving it and its order. Same delay as the mic signs.'),
    apply_mic_chat: _t('js.admavsync.apply_mic_chat_help', 'The chat’s “grabbed the mic” and “dropped the mic” lines: each shows in its place once the audio catches up. Typed chat is never held. Same delay as the mic signs.'),
    apply_mic_list: _t('js.admavsync.apply_mic_list_help', "The 🎙 icons in the people list and its on-mic order, and the homepage's mic chips. Same delay as the mic signs."),   // 1.99ahm
    // 1.99ait avf (F4, F5)
    mic_follow_toggle: _t('js.admavsync.mic_follow_toggle_help', 'On (the default): a viewer who turns their toggle off sees the cams and the mic signs as they come. Off: the mic signs are held for everyone the switches above apply to, whatever their toggle says; the toggle then holds the cams only.'),
    fallback_ind_rtc_ms: _t('js.admavsync.fallback_ind_help', "The mic signs' delay while the room audio isn't measured yet (the first seconds after it starts, or a long quiet stretch): about the whole audio path. The cams keep their own fallback above."),
    // 1.99ait avf review: which way each calibration moves (av-sync.js adds it: + = later) - the owner calibrates from a pad's ?avsync=1 panel
    k_pt_ms: _t('js.admavsync.k_pt_help', "Added to the delay of pass-through cams (Source passthrough in the table below and in a pad's ?avsync=1 panel). Cams ahead of the voice (lips move before you hear the words): raise it. Cams behind: lower it, below 0 if needed - until that cam's target_ms in the panel reads null: a cam can't be shown sooner than it arrives. The mic stage's recordings line their cams up with it too."),
    k_re_ms: _t('js.admavsync.k_re_help', 'The same for re-encoded cams (Source reencode): ahead of the voice - raise it, behind - lower it.'),
    k_ind_ms: _t('js.admavsync.k_ind_help', "Added to the mic signs' delay: signs that change before you hear the voice - raise it; after it - lower it.")
  };
  function node(tag, text, cls) { var el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; }
  function buttons(disabled) { Array.prototype.forEach.call(form.querySelectorAll('button'), function (el) { el.disabled = disabled; }); }
  function build() {
    fields.textContent = '';
    Object.keys(view.fields).forEach(function (key) {
      var def = view.fields[key], label = node('label'), input;
      label.style.display = 'block'; label.style.margin = '8px 0';
      if (typeof def.def === 'boolean') { input = node('input'); input.type = 'checkbox'; label.appendChild(input); label.appendChild(document.createTextNode(' ' + (labels[key] || key))); }
      else {
        label.appendChild(document.createTextNode((labels[key] || key) + ' '));
        input = node(def.choices ? 'select' : 'input');
        if (def.choices) def.choices.forEach(function (choice) { var option = node('option', choice); option.value = choice; input.appendChild(option); });
        else { input.type = 'number'; input.min = def.min; input.max = def.max; input.step = '1'; input.inputMode = 'numeric'; }
        label.appendChild(input);
      }
      input.name = key;
      label.appendChild(node('small', ' · default ' + def.def + (def.min == null ? '' : ' · ' + def.min + '–' + def.max), 'adm-help'));
      if (helps[key]) { var help = node('small', helps[key], 'adm-help'); help.style.display = 'block'; label.appendChild(help); }
      fields.appendChild(label);
    });
  }
  // 1.99ahm: review fix (C-1) - the card reads and writes only the fields it has drawn (form.elements has no others), and is drawn
  // again when the site's field list changes (a deploy while this page was open) - it used to throw on a field it never drew, so the
  // readout stopped refreshing and Save / Reset did nothing
  var drawn = null;
  function values() {
    var out = {}; Object.keys(view ? view.fields : {}).forEach(function (key) { var input = form.elements[key]; if (input) out[key] = input.type === 'checkbox' ? input.checked : input.value; });
    return out;
  }
  function put(cfg) {
    Object.keys(view.fields).forEach(function (key) { var input = form.elements[key]; if (!input || !Object.prototype.hasOwnProperty.call(cfg, key)) return; if (input.type === 'checkbox') input.checked = !!cfg[key]; else input.value = cfg[key]; });
  }
  function fill() {
    put(view.cfg || {});
    document.getElementById('avsVersion').textContent = view.v ? 'v' + view.v : 'off by default · never saved';
  }
  function ms(value) { return value == null ? 'unknown' : value + ' ms'; }
  function table(id, rows, columns, empty) {
    var body = document.getElementById(id); body.textContent = '';
    rows.forEach(function (row) { var tr = node('tr'); columns.forEach(function (col) { tr.appendChild(node('td', col(row))); }); body.appendChild(tr); });
    if (!rows.length) { var tr = node('tr'), td = node('td', empty, 'adm-help'); td.colSpan = columns.length; tr.appendChild(td); body.appendChild(tr); }
  }
  function render(next) {
    var keys = Object.keys(next.fields || {}).join(','), redraw = keys !== drawn, typed = redraw && editing ? values() : null;
    view = next;
    // 1.99ahm: (C-1) another field list: drawn again from the site's values, keeping what the admin was changing
    if (redraw) { build(); drawn = keys; fill(); if (typed) put(typed); }
    else if (!editing) fill();
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
    var cfg = values();
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
