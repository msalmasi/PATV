/* Room Dock audience settings. One explicit load/save; no pad controls or public polling. */
(function () {
  'use strict';
  var form = document.getElementById('paddockForm'); if (!form) return;
  var fields = document.getElementById('paddockFields'), msg = document.getElementById('paddockMessage');
  var view = null, busy = false;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var labels = { mode: _t('js.pad.dock.admin.audience', 'Who gets the Room Dock'),
    cfstickers: _t('js.pad.dock.admin.cfstickers', 'Camfrog stickers'), gifs: _t('js.pad.dock.admin.gifs', 'KLIPY GIFs') };
  var choices = { off: _t('js.pad.dock.admin.off', 'Off'), staff: _t('js.pad.dock.admin.staff', 'Staff'), everyone: _t('js.pad.dock.admin.everyone', 'Everyone') };
  function node(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function buttons(on) { Array.prototype.forEach.call(form.querySelectorAll('button'), function (b) { b.disabled = on; }); }
  function render(data) {
    view = data; fields.textContent = '';
    Object.keys(data.fields || {}).forEach(function (key) {
      var def = data.fields[key], label = node('label'), input;
      label.appendChild(document.createTextNode(labels[key] || key));
      input = node(def.choices ? 'select' : 'input', def.choices ? 'ds-select' : 'ds-switch'); input.name = key;
      if (def.choices) def.choices.forEach(function (value) { var option = node('option', '', choices[value] || value); option.value = value; input.appendChild(option); });
      else input.type = 'checkbox';
      if (def.choices) input.value = data.cfg[key]; else input.checked = data.cfg[key] === true;
      label.appendChild(input); fields.appendChild(label);
    });
    var history = document.getElementById('paddockAudit'); history.textContent = '';
    (data.audit || []).forEach(function (row) {
      history.appendChild(node('li', '', new Date(row.at).toLocaleString() + ' · ' + (row.admin || '') + ' · ' +
        _t('js.pad.dock.admin.version', 'version {n}', { n: row.detail && row.detail.v || 0 })));
    });
  }
  function request(body) {
    var opts = { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch' } };
    if (body) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/admin/paddock', opts).then(function (r) { return r.json(); }).then(function (d) { if (!d.ok) throw new Error(d.error || 'unavailable'); return d; });
  }
  function failed(error) {
    msg.textContent = error.message === 'rate' ? _t('js.pad.dock.admin.rate', 'Wait a moment before changing the setting again.') :
      error.message === 'invalid' ? _t('js.pad.dock.admin.invalid', 'Choose one of the available settings.') :
      _t('js.pad.dock.admin.failed', 'The setting could not be saved or loaded. Reload and try again.');
  }
  function save(reset) {
    if (busy || !view) return;
    var cfg = {}; Object.keys(view.fields).forEach(function (key) { var input = form.elements[key]; if (input) cfg[key] = input.type === 'checkbox' ? input.checked : input.value; });
    busy = true; buttons(true); msg.textContent = _t('js.pad.dock.admin.saving', 'Saving…');
    request({ cfg: cfg, reset: reset, reason: form.elements.reason.value.trim() }).then(function (data) {
      render(data.view); form.elements.reason.value = ''; msg.textContent = _t('js.pad.dock.admin.saved', 'Saved. Reload an open pad to apply the audience setting.');
    }).catch(failed).then(function () { busy = false; buttons(false); });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); save(false); });
  document.getElementById('paddockReset').addEventListener('click', function () { save(true); });
  buttons(true);
  request().then(function (data) { render(data); msg.textContent = ''; buttons(false); }).catch(failed);
}());
