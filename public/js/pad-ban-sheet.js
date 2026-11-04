// pad-ban-sheet.js - 1.99?? padppl: the WEBSITE's bans from the person menu (padbans.js). The menu items (P.banItems, used by room-mod.js
// menuItems for viewers the live view gave `wmod`) and the confirm sheet: a modal <dialog> (focus stays inside; Esc / Cancel close it),
// textContent only. The sheet first asks the server WHO the clicked row / line is (POST .../ban/preview {ref}) and says the identity's
// KIND - "PATV account @x", "Camfrog login y", "The person behind 🐸 Soggy Bullfrog · identity hidden from you" - never re-reading a
// typed name. Then: where (website bridge / whole pad / whole site for staff), how long (1 h / 1 d / 7 d / permanent), why, and for
// admins "also block the networks they used". Lifting a NAMED ban is one confirm; a frog name's ban is lifted from the pad's list.
//
//   PATVRoom.banItems(out, u, x, ref, veil)       PATVBanSheet.open({ ref, slug, scope, lift?, name, veil?, anchor? })
(function (W, D) {
  'use strict';
  var _t = typeof W.__t === 'function' ? W.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  var P = W.PATVRoom = W.PATVRoom || {};

  /** The ban items for one person (room-mod.js menuItems calls it). x.wmod = what this viewer may do here; u.wban / x.wban = the named
   *  person's current bans (never on a veil). */
  P.banItems = function (out, u, x, ref, veil) {
    var w = x && x.wmod; if (!w || !ref || !x.slug) return;
    var wb = veil ? null : (x.wban || (u && u.wban) || null);
    if (w.bridge) out.push(wb && wb.b ? { kind: 'ban', id: 'lift_bridge', group: 'ban', label: '🌐 ' + _t('js.ban.lift_bridge', 'Lift the website-bridge block'), ref: ref, scope: 'bridge', lift: true }
      : { kind: 'ban', id: 'ban_bridge', group: 'ban', label: '🌐🚫 ' + _t('js.ban.menu_bridge', 'Block from the website bridge…'), ref: ref, scope: 'bridge', veil: !!veil, danger: true });
    if (w.pad) out.push(wb && wb.p ? { kind: 'ban', id: 'lift_pad', group: 'ban', label: '⛔ ' + _t('js.ban.lift_pad', 'Lift the pad ban'), ref: ref, scope: 'pad', lift: true }
      : { kind: 'ban', id: 'ban_pad', group: 'ban', label: '⛔ ' + _t('js.ban.menu_pad', 'Ban from this pad…'), ref: ref, scope: 'pad', veil: !!veil, danger: true });
    if (w.site) out.push({ kind: 'ban', id: 'ban_site', group: 'ban', label: '🛑 ' + _t('js.ban.menu_site', 'Ban site-wide…'), ref: ref, scope: 'site', veil: !!veil, danger: true });
  };

  var SCOPE_TXT = {
    bridge: function () { return [_t('js.ban.scope_bridge', 'Website bridge only'), _t('js.ban.scope_bridge_sub', 'Chat, commands, clips and cams from the website')]; },
    pad: function () { return [_t('js.ban.scope_pad', 'Whole pad'), _t('js.ban.scope_pad_sub', 'Feed posts, comments, stories, stage and chat')]; },
    site: function () { return [_t('js.ban.scope_site', 'Whole site'), _t('js.ban.scope_site_sub', 'PATV staff: everywhere, and they are signed out')]; }
  };
  var DURS = [['1h', function () { return _t('js.ban.dur_1h', '1 hour'); }], ['1d', function () { return _t('js.ban.dur_1d', '1 day'); }],
              ['7d', function () { return _t('js.ban.dur_7d', '7 days'); }], ['perm', function () { return _t('js.ban.dur_perm', 'Permanent'); }]];
  var KIND_TXT = { account: function () { return _t('js.ban.kind_account', 'PATV account'); }, login: function () { return _t('js.ban.kind_login', 'Camfrog login'); },
                   veil: function () { return _t('js.ban.kind_veil', 'Frog name'); } };

  var cur = null, seq = 0;
  function close() {
    if (!cur) return;
    var c = cur; cur = null;
    try { if (c.d.open && c.d.close) c.d.close(); } catch (e) { /* old engine */ }
    c.d.remove();
    if (c.anchor && c.anchor.isConnected && c.anchor.focus) c.anchor.focus();
  }
  function shell(title, anchor) {
    close();
    var d = el('dialog', 'psh psh-ban'); var id = 'pshBanT' + (++seq); d.setAttribute('aria-labelledby', id);
    var inner = el('div', 'psh-in'); var h = el('h3', 'psh-t', title); h.id = id;
    inner.appendChild(h); d.appendChild(inner);
    d.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    D.body.appendChild(d);
    cur = { d: d, anchor: anchor || D.activeElement };
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    return { d: d, inner: inner, h: h };
  }
  function buttons(inner, goText, danger) {
    var row = el('div', 'psh-row');
    var go = el('button', 'psh-btn ' + (danger ? 'danger' : 'go'), goText); go.type = 'button';
    var no = el('button', 'psh-btn', _t('js.ban.cancel', 'Cancel')); no.type = 'button'; no.addEventListener('click', close);
    var out = el('p', 'psh-out'); out.setAttribute('aria-live', 'polite');
    row.appendChild(go); row.appendChild(no); inner.appendChild(row); inner.appendChild(out);
    return { go: go, no: no, out: out };
  }
  function base(slug) { return '/api/rooms/' + encodeURIComponent(slug); }

  function openLift(o) {
    var S = shell(_t('js.ban.lift_title', 'Lift this ban on {name}?', { name: o.name || '' }), o.anchor);
    S.inner.appendChild(el('p', 'psh-p', o.scope === 'pad' ? _t('js.ban.lift_pad_body', 'They can post, comment, book the stage and chat from the website in this pad again.')
      : _t('js.ban.lift_bridge_body', 'They can chat and use commands in this room from the website again.')));
    var B = buttons(S.inner, _t('js.ban.lift_go', 'Lift it'), false);
    B.go.addEventListener('click', function () {
      B.go.disabled = true; B.out.className = 'psh-out'; B.out.textContent = _t('js.ban.sending', 'One moment…');
      api(base(o.slug) + '/unban', { ref: o.ref, scope: o.scope }).then(function (a) {
        if (!a.ok) { B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = a.error || _t('js.ban.failed', 'Not changed.'); return; }
        B.out.className = 'psh-out ok'; B.out.textContent = _t('js.ban.lifted', 'Lifted.'); setTimeout(close, 900);
      }).catch(function () { B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = _t('js.ban.offline', 'Couldn\'t reach the site.'); });
    });
    B.no.focus();
  }

  function open(o) {
    o = o || {};
    if (o.lift) return openLift(o);
    var S = shell(_t('js.ban.loading', 'Checking who this is…'), o.anchor);
    var wait = el('p', 'psh-hint', ''); S.inner.appendChild(wait);
    api(base(o.slug) + '/ban/preview', { ref: o.ref, scope: o.scope }).then(function (pv) {
      if (!cur || cur.d !== S.d) return;
      if (!pv.ok) { S.h.textContent = _t('js.ban.cant', 'Can\'t ban from here'); wait.textContent = pv.error || ''; buttons(S.inner, _t('js.ban.cancel', 'Cancel'), false).go.addEventListener('click', close); return; }
      wait.remove();
      // (the title names the identity's kind itself - "PATV account @x", "Camfrog login y", "The person behind 🐸 ...")
      S.h.textContent = pv.who.title;
      S.d.setAttribute('aria-describedby', 'pshKind' + seq);
      var kind = el('span', 'psh-sr', (KIND_TXT[pv.who.kind] || KIND_TXT.account)()); kind.id = 'pshKind' + seq; S.inner.appendChild(kind);
      S.inner.appendChild(el('p', 'psh-sub', pv.who.sub));
      // where
      var fs = el('fieldset', 'psh-opts'); var lg = el('legend', 'psh-k', _t('js.ban.where', 'Where')); fs.appendChild(lg);
      var scope = pv.scopes.indexOf(o.scope) >= 0 ? o.scope : pv.scopes[0];
      pv.scopes.forEach(function (sc) {
        var lab = el('label', 'psh-opt'); var r = el('input'); r.type = 'radio'; r.name = 'pshScope' + seq; r.value = sc; r.checked = sc === scope;
        var tx = SCOPE_TXT[sc](), sp = el('span', null, tx[0]); sp.appendChild(el('small', null, tx[1]));
        r.addEventListener('change', function () { if (r.checked) { scope = sc; paint(); } });
        lab.appendChild(r); lab.appendChild(sp); fs.appendChild(lab);
      });
      S.inner.appendChild(fs);
      // how long
      S.inner.appendChild(el('p', 'psh-k', _t('js.ban.how_long', 'How long')));
      var chips = el('div', 'psh-chips'); chips.setAttribute('role', 'radiogroup'); chips.setAttribute('aria-label', _t('js.ban.how_long', 'How long'));
      var dur = '1d';
      DURS.forEach(function (dd) {
        var lab = el('label', 'psh-chip'); var r = el('input'); r.type = 'radio'; r.name = 'pshDur' + seq; r.value = dd[0]; r.checked = dd[0] === dur;
        r.addEventListener('change', function () { if (r.checked) { dur = dd[0]; paint(); } });
        lab.appendChild(r); lab.appendChild(el('span', null, dd[1]())); chips.appendChild(lab);
      });
      S.inner.appendChild(chips);
      // why
      var rl = el('label', 'psh-k', _t('js.ban.reason', 'Reason (they see it)')); rl.htmlFor = 'pshWhy' + seq;
      var why = el('input'); why.type = 'text'; why.id = 'pshWhy' + seq; why.maxLength = 120; why.autocomplete = 'off';
      why.addEventListener('input', paint);
      S.inner.appendChild(rl); S.inner.appendChild(why);
      // networks (admins)
      var netBox = null;
      if (pv.nets && pv.nets.on) {
        var nl = el('label', 'psh-opt'); netBox = el('input'); netBox.type = 'checkbox';
        var ns = el('span', null, _t('js.ban.nets', 'Also block the networks they used (30 days)'));
        ns.appendChild(el('small', null, pv.nets.shared ? _t('js.ban.nets_shared', '{n} other accounts share these networks', { n: pv.nets.shared }) : _t('js.ban.nets_none', 'No other account shares them')));
        nl.appendChild(netBox); nl.appendChild(ns); S.inner.appendChild(nl);
      }
      var seeT = el('p', 'psh-k', _t('js.ban.they_see', 'They will see')); var see = el('p', 'psh-refuse', '');
      S.inner.appendChild(seeT); S.inner.appendChild(see);
      if (pv.room) S.inner.appendChild(el('p', 'psh-hint', _t('js.ban.room_note', 'This is the website. To remove them from the Camfrog room use Ban (room) in this menu.')));
      var B = buttons(S.inner, _t('js.ban.go', 'Ban'), true);
      function paint() {
        var r = pv.refusal && pv.refusal[scope] ? String(pv.refusal[scope]) : '';
        var UNTIL = { '1h': _t('js.ban.until_1h', 'an hour from now'), '1d': _t('js.ban.until_1d', 'this time tomorrow'), '7d': _t('js.ban.until_7d', '7 days from now') };
        r = r.replace(/ until [^(.]+UTC/, dur === 'perm' ? '' : ' until ' + UNTIL[dur]);
        var w = why.value.replace(/\s+/g, ' ').trim();
        if (w) r = r.replace(/\.$/, ' (' + w + ').');
        see.textContent = r;
        B.go.disabled = dur === 'perm' && !w;
        B.go.title = B.go.disabled ? _t('js.ban.need_reason', 'A permanent ban needs a reason.') : '';
      }
      paint();
      B.go.addEventListener('click', function () {
        B.go.disabled = true; B.out.className = 'psh-out'; B.out.textContent = _t('js.ban.sending', 'One moment…');
        api(base(o.slug) + '/ban', { ref: o.ref, scope: scope, dur: dur, reason: why.value, nets: !!(netBox && netBox.checked) }).then(function (a) {
          if (!a.ok) { B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = a.error || _t('js.ban.failed', 'Not changed.'); return; }
          B.out.className = 'psh-out ok'; B.out.textContent = _t('js.ban.done', 'Done - it\'s in the pad\'s list of bans.');
          setTimeout(close, 1100);
        }).catch(function () { B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = _t('js.ban.offline', 'Couldn\'t reach the site.'); });
      });
      var first = fs.querySelector('input:checked'); if (first) first.focus();
    }).catch(function () { if (cur && cur.d === S.d) { S.h.textContent = _t('js.ban.offline', 'Couldn\'t reach the site.'); } });
  }

  W.PATVBanSheet = { open: open, close: close };
})(window, document);
