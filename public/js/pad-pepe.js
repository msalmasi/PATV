// pad-pepe.js — the pad page's 🐸 Pepe submenu (1.99qr, padpepe.js on the server): Pepe's paid people-commands on someone in
// the room - 👀 Look (!look), 🔥 Cam roast (!camroast), 🎤 Roast (!roast) - from the live user list's ⋯ menu (room-mod.js)
// and from a viewer's cam preview (the 📷 snapshot popover in views/room.ejs).
//
//   PATVRoom.pepe.items(menu, u)                 -> [{action, label, price, disabled, note}]   (pure; tests pin it)
//   PATVRoom.pepe.confirm(host, slug, action, u, menu, {onCancel, onDone}) -> the price + confirm step, then the run
//
// `menu` is the live view's room.pepe ({look|camroast|roast: {on, price, why}}, from Pepe's snapshot). Every action shows
// its price and asks first ("Pay 10,000 PAT"); Pepe charges it as the viewer's linked Camfrog login (Pepe admins are
// free), in the room, with his cooldowns and room switches. 👀 and 🔥 need the person's cam OPEN - greyed out otherwise
// (the server and Pepe re-check, nothing is charged for a closed cam). All user-visible text goes in via textContent.
(function () {
  'use strict';
  var P = window.PATVRoom = window.PATVRoom || {};
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var ORDER = ['look', 'camroast', 'roast'];
  var A = {
    look: { icon: '👀', cam: true, label: function () { return _t('js.pad.pepe.look', 'Look at their cam'); },
            what: function (n) { return _t('js.pad.pepe.look_what', 'Pepe opens {name}\'s cam and reacts to what he sees, in the room.', { name: n }); } },
    camroast: { icon: '🔥', cam: true, label: function () { return _t('js.pad.pepe.camroast', 'Cam roast'); },
                what: function (n) { return _t('js.pad.pepe.camroast_what', 'Pepe roasts {name} using their cam, in the room.', { name: n }); } },
    roast: { icon: '🎤', cam: false, label: function () { return _t('js.pad.pepe.roast', 'Roast'); },
             what: function (n) { return _t('js.pad.pepe.roast_what', 'Pepe roasts {name} in the room.', { name: n }); } },
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmt(n) { return Number(n || 0).toLocaleString(window.PATV_I18N && PATV_I18N.lang || undefined); }
  function priceText(n) { return n > 0 ? _t('js.pad.pepe.price', '{n} PAT', { n: fmt(n) }) : _t('js.pad.pepe.free', 'free'); }
  function who(u) { return (u && (u.display || u.login)) || '?'; }

  /** What the submenu offers for person u (nothing for Pepe, anonymous people or bots). */
  function items(menu, u) {
    if (!menu || !u || u.self || u.anon || u.bot || !u.login) return [];
    var out = [];
    ORDER.forEach(function (a) {
      var m = menu[a];
      if (!m) return;
      var camShut = A[a].cam && u.on_cam !== true;
      var note = !m.on ? (m.why || _t('js.pad.pepe.off_here', 'switched off here')) : camShut ? _t('js.pad.pepe.cam_closed', 'their cam is closed') : '';
      out.push({ action: a, icon: A[a].icon, label: A[a].label(), price: m.price || 0, disabled: !m.on || camShut, note: note });
    });
    return out;
  }

  function api(url, body) {
    return fetch(url, body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }

  /** The price + confirm step inside `host` (replaces its content), then the run and Pepe's answer. */
  function confirm(host, slug, action, u, menu, opts) {
    opts = opts || {};
    var m = (menu || {})[action] || { price: 0 };
    host.textContent = '';
    var box = el('div', 'pp-confirm');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', A[action].label());
    box.appendChild(el('p', 'pp-q', A[action].icon + ' ' + A[action].what(who(u))));
    var cost = el('p', 'pp-cost');
    cost.appendChild(document.createTextNode(_t('js.pad.pepe.costs', 'Costs') + ' '));
    var pat = el('span', 'ds-pat'); pat.appendChild(el('b', null, fmt(m.price))); pat.appendChild(el('small', null, 'PAT'));
    cost.appendChild(m.price > 0 ? pat : el('b', null, _t('js.pad.pepe.free', 'free')));
    cost.appendChild(document.createTextNode(' ' + _t('js.pad.pepe.costs_tail', 'from your balance, charged by Pepe as your linked chat name (Pepe admins are free).')));
    box.appendChild(cost);
    var row = el('div', 'pp-row');
    var no = el('button', 'ds-btn sm ghost', _t('js.pad.pepe.cancel', 'Cancel')); no.type = 'button';
    var go = el('button', 'ds-btn sm gold', m.price > 0 ? _t('js.pad.pepe.pay', 'Pay {price}', { price: priceText(m.price) }) : _t('js.pad.pepe.go', 'Ask Pepe')); go.type = 'button';
    row.appendChild(no); row.appendChild(go);
    box.appendChild(row);
    var out = el('div', 'pp-out'); out.setAttribute('role', 'status'); out.setAttribute('aria-live', 'polite');
    box.appendChild(out);
    host.appendChild(box);
    no.addEventListener('click', function () { if (opts.onCancel) opts.onCancel(); });
    function say(text, kind) { out.textContent = text || ''; out.className = 'pp-out' + (kind ? ' ' + kind : ''); }
    go.addEventListener('click', function () {
      go.disabled = true; no.disabled = true; go.setAttribute('aria-busy', 'true');
      say(_t('js.pad.pepe.sending', 'Sending to Pepe…'));
      api('/api/rooms/' + encodeURIComponent(slug) + '/pepe', { action: action, target: u.login }).then(function (d) {
        if (!d || !d.ok) { go.disabled = false; no.disabled = false; go.removeAttribute('aria-busy'); say((d && d.error) || _t('js.pad.pepe.not_sent', 'Not sent.'), 'bad'); return; }
        say(_t('js.pad.pepe.waiting', 'Pepe is on it… ({line})', { line: d.line }));
        var n = 0;
        (function poll() {
          api('/api/rooms/' + encodeURIComponent(slug) + '/pepe/job/' + encodeURIComponent(d.id)).then(function (j) {
            if (!j || !j.ok) { say((j && j.error) || _t('js.pad.pepe.lost', 'Lost track of it - check the room.'), 'bad'); return finish(false); }
            if (j.done && j.success === false) { say(j.msg || _t('js.pad.pepe.refused', 'Pepe didn\'t run it.'), 'bad'); return finish(false); }
            var ans = (j.replies || []).filter(function (x) { return x.indexOf('🌐') !== 0; });
            if (ans.length) { say(ans[ans.length - 1], 'ok'); return finish(true); }
            if (++n > 60) { say(_t('js.pad.pepe.room', 'Sent - Pepe\'s answer shows in the room.'), 'ok'); return finish(true); }
            setTimeout(poll, 1500);
          }).catch(function () { if (++n > 60) return finish(false); setTimeout(poll, 3000); });
        })();
      }).catch(function () { go.disabled = false; no.disabled = false; go.removeAttribute('aria-busy'); say(_t('js.pad.pepe.unreachable', 'Couldn\'t reach the site.'), 'bad'); });
    });
    function finish(ok) {
      go.removeAttribute('aria-busy');
      no.disabled = false; no.textContent = _t('js.pad.pepe.close', 'Close');
      if (opts.onDone) opts.onDone(ok);
    }
    setTimeout(function () { (go.disabled ? no : go).focus(); }, 0);
    return box;
  }

  /** Buttons for a cam preview (the snapshot popover): 👀 Look / 🔥 Cam roast / 🎤 Roast with their prices. */
  function camRow(host, slug, u, menu) {
    var list = items(menu, Object.assign({}, u, { on_cam: true }));      // the preview is open: their cam is on
    if (!list.length) return null;
    var wrap = el('div', 'pp-cam');
    var lab = el('span', 'pp-cam-l', '🐸 ' + _t('js.pad.pepe.menu', 'Pepe'));
    wrap.appendChild(lab);
    var acts = el('div', 'pp-cam-a');
    var stage = el('div', 'pp-cam-c');
    list.forEach(function (it) {
      var b = el('button', 'ds-btn sm ghost pp-cam-b', it.icon + ' ' + it.label + ' · ' + priceText(it.price)); b.type = 'button';
      if (it.disabled) { b.disabled = true; b.title = it.note; }
      b.addEventListener('click', function () {
        acts.hidden = true;
        confirm(stage, slug, it.action, u, menu, { onCancel: function () { stage.textContent = ''; acts.hidden = false; },
                                                   onDone: function () {} });
      });
      acts.appendChild(b);
    });
    wrap.appendChild(acts); wrap.appendChild(stage);
    host.appendChild(wrap);
    return wrap;
  }

  P.pepe = { items: items, confirm: confirm, camRow: camRow, priceText: priceText, A: A };
})();
