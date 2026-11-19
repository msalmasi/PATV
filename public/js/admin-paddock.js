/* Room Dock audience settings. One explicit load/save; no pad controls or public polling.
   1.99aot gifs: the GIF control is a mode (off / free / partner) - #paddockGifs says plainly what each does, what it is missing (a key's
   state only, never a key) and lists the GIFs moderators removed everywhere, each with Unblock. */
(function () {
  'use strict';
  var form = document.getElementById('paddockForm'); if (!form) return;
  var fields = document.getElementById('paddockFields'), msg = document.getElementById('paddockMessage');
  var view = null, busy = false;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var labels = { mode: _t('js.pad.dock.admin.audience', 'Who gets the Room Dock'),
    cfstickers: _t('js.pad.dock.admin.cfstickers', 'Camfrog stickers'), gifs: _t('js.pad.dock.admin.gifs', 'KLIPY GIFs') };
  var choices = { off: _t('js.pad.dock.admin.off', 'Off'), staff: _t('js.pad.dock.admin.staff', 'Staff'), everyone: _t('js.pad.dock.admin.everyone', 'Everyone'),
    free: _t('js.pad.dock.admin.gifs_free', 'Free — members’ browsers ask KLIPY'), partner: _t('js.pad.dock.admin.gifs_partner', 'Partner — PATV’s server asks KLIPY') };
  function node(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function buttons(on) { Array.prototype.forEach.call(form.querySelectorAll('button'), function (b) { b.disabled = on; }); }
  var KEY_STATE = { set: _t('js.pad.dock.admin.key_set', 'set'), missing: _t('js.pad.dock.admin.key_missing', 'missing'), malformed: _t('js.pad.dock.admin.key_malformed', 'set but malformed') };
  function gifPanel(data) {
    var box = document.getElementById('paddockGifs'); if (!box) return;
    box.textContent = '';
    var g = data.gifs; if (!g || !g.keys) return;
    box.appendChild(node('p', 'adm-help', _t('js.pad.dock.admin.gifs_free_what', 'Free: members’ browsers search KLIPY themselves with the browser key and the pad’s rating (G; PG-13 on 18+ pads); PATV’s server never calls KLIPY. The server checks each sent GIF’s link, size and title but can’t confirm its rating — moderators can remove a GIF everywhere. Needs KLIPY_PUBLIC_KEY: {state}.', { state: KEY_STATE[g.keys.free] || g.keys.free })));
    box.appendChild(node('p', 'adm-help', _t('js.pad.dock.admin.gifs_partner_what', 'Partner: PATV’s server searches KLIPY (G only) and members can send only GIFs that search returned. Needs KLIPY’s paid server-side plan and KLIPY_API_KEY: {state}.', { state: KEY_STATE[g.keys.partner] || g.keys.partner })));
    if (data.cfg && data.cfg.gifs !== 'off' && !g.on) {
      var why = data.cfg.mode === 'off' ? _t('js.pad.dock.admin.gifs_off_dock', 'GIFs are not on: the Room Dock is off.')
        : _t('js.pad.dock.admin.gifs_off_key', 'GIFs are not on: the {mode} mode’s key is {state}.', { mode: choices[data.cfg.gifs] || data.cfg.gifs, state: KEY_STATE[g.keys[data.cfg.gifs]] || g.keys[data.cfg.gifs] });
      box.appendChild(node('p', 'adm-help', '⚠️ ' + why));
    }
    var list = g.blocks || [];
    box.appendChild(node('p', 'adm-help', list.length ? _t('js.pad.dock.admin.gifs_blocked', 'GIFs removed everywhere by moderators (newest first):') : _t('js.pad.dock.admin.gifs_blocked_none', 'No GIFs removed everywhere.')));
    if (!list.length) return;
    var ul = node('ul', 'adm-help');
    list.forEach(function (b) {
      var li = node('li', '', b.id + ' · ' + new Date(b.at).toLocaleString() + (b.room ? ' · ' + b.room : '') + (b.kind ? ' · ' + b.kind : '') + (b.why ? ' · ' + b.why : '') + ' ');
      var un = node('button', 'ds-btn quiet', _t('js.pad.dock.admin.gifs_unblock', 'Unblock')); un.type = 'button';
      un.addEventListener('click', function () {
        if (busy) return;
        busy = true; buttons(true); msg.textContent = _t('js.pad.dock.admin.saving', 'Saving…');
        fetch('/api/admin/gifs/unblock', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.id, reason: form.elements.reason ? form.elements.reason.value.trim() : '' }) })
          .then(function (r) { return r.json(); }).then(function (d) { if (!d.ok) throw new Error(d.error || 'unavailable'); return request(); })
          .then(function (data2) { render(data2); msg.textContent = _t('js.pad.dock.admin.gifs_unblocked', 'Unblocked.'); })
          .catch(failed).then(function () { busy = false; buttons(false); });
      });
      li.appendChild(un); ul.appendChild(li);
    });
    box.appendChild(ul);
  }
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
    gifPanel(data);
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
