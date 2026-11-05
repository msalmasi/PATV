// pad-ban-sheet.js - 1.99ajn padppl: the WEBSITE's bans from the person menu (padbans.js). The menu items (P.banItems, used by room-mod.js
// menuItems for viewers the live view gave `wmod`) and the confirm sheet (block-sheet.js PATVSheet - the 💸 Tip sheet's look, textContent
// only). The sheet first asks the server WHO the clicked row / line is (POST .../ban/preview {ref}) and says the identity's KIND - "PATV
// account @x", "Camfrog login y", "The person behind 🐸 Soggy Bullfrog · identity hidden from you" - never re-reading a typed name. Then:
// where (website bridge / whole pad / whole site for staff - a frog name: this pad's website chat while they're a frog, or site-wide),
// how long (1 h / 1 d / 7 d / permanent - a permanent one needs a reason, said under the box), why, and for admins "also block the networks
// they used" with the accounts that share them (let them through). Lifting a NAMED ban is one confirm that says what is lifted; a frog
// name's ban is lifted from the pad's list.
//
// Review fixes: ONE "⛔ Website ban…" menu item (the sheet picks the scope) and ONE "↩️ Lift website ban…" - not four look-alike items next
// to Pepe's 🔨 Ban…; one Close when the preview fails; the Camfrog-room note only for a login, and only for a viewer Pepe gives 🔨 Ban…
// 1.99ajw padppl rework (owner: a frog-name ban should cover ANY frog name the person uses): on a frog name the item is "⛔ Incognito ban…" -
// the person behind it can't post incognito in this pad (every frog name, now and later), whoever it is; they see only "You can't post
// incognito on this pad right now." (never the reason or the end), so the reason box says who reads it.
//
// profmod: the profile's ⋯ More "Admin" group (profile-mod.js) opens the same sheet on the person's profile pad with only: ['site'] - the
// "Where" offers only the whole site (a profile has no pad of its own to ban from), its Lift lifts the site-wide ban (the preview's
// current.site, for viewers who may ban site-wide), and onDone(answer) runs after a ban / lift landed.
//
//   PATVRoom.banItems(out, u, x, ref, veil)       PATVBanSheet.open({ ref, slug, scope?, only?, lift?, wban?, name, veil?, anchor?, onDone? })
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
   *  person's current bans in this pad (never on a veil). */
  P.banItems = function (out, u, x, ref, veil) {
    var w = x && x.wmod; if (!w || !ref || !x.slug || !(w.bridge || w.pad || w.site)) return;
    var wb = veil ? null : (x.wban || (u && u.wban) || null);
    out.push({ kind: 'ban', id: 'ban', group: 'ban', label: '⛔ ' + (veil ? _t('js.ban.menu_veil', 'Incognito ban…') : _t('js.ban.menu', 'Website ban…')), ref: ref, scope: 'bridge', veil: !!veil, danger: true });
    if (wb && (wb.b || wb.p)) out.push({ kind: 'ban', id: 'lift', group: 'ban', label: '↩️ ' + _t('js.ban.menu_lift', 'Lift website ban…'), ref: ref, lift: true, wban: wb });
  };

  var SCOPE_TXT = {
    bridge: function () { return [_t('js.ban.scope_bridge', 'Website bridge only'), _t('js.ban.scope_bridge_sub', 'Chat, commands, clips, cams and room audio from the website')]; },
    pad: function () { return [_t('js.ban.scope_pad', 'Whole pad'), _t('js.ban.scope_pad_sub', 'Feed posts, comments, stories, stage, chat and room audio')]; },
    site: function () { return [_t('js.ban.scope_site', 'Whole site'), _t('js.ban.scope_site_sub', 'PATV staff: everywhere, and they are signed out')]; },
    vbridge: function () { return [_t('js.ban.scope_veil', 'Posting incognito in this pad'), _t('js.ban.scope_veil_sub', 'Every frog name they use here, now and later - chat, commands, clips and cams from the website. What they do under their own name doesn\'t change, and you never learn who it is.')]; },
    vsite: function () { return [_t('js.ban.scope_veil_site', 'Posting incognito in every pad'), _t('js.ban.scope_veil_site_sub', 'PATV staff: every frog name they use, in every pad')]; }
  };
  var DURS = [['1h', function () { return _t('js.ban.dur_1h', '1 hour'); }], ['1d', function () { return _t('js.ban.dur_1d', '1 day'); }],
              ['7d', function () { return _t('js.ban.dur_7d', '7 days'); }], ['perm', function () { return _t('js.ban.dur_perm', 'Permanent'); }]];
  var KIND_TXT = { account: function () { return _t('js.ban.kind_account', 'PATV account'); }, login: function () { return _t('js.ban.kind_login', 'Camfrog login'); },
                   veil: function () { return _t('js.ban.kind_veil', 'Frog name'); } };
  function S_() { return W.PATVSheet; }
  function base(slug) { return '/api/rooms/' + encodeURIComponent(slug); }
  function utc(ms) { try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch (e) { return ''; } }

  function openLift(o) {
    var SH = S_(); if (!SH) return;
    var S = SH.open({ title: '↩️ ' + _t('js.ban.lift_title', 'Lift a website ban on {name}?', { name: o.name || '' }), cls: 'psh-ban', anchor: o.anchor });
    var wait = el('p', 'psh-hint', _t('js.ban.loading', 'Checking who this is…')); S.body.appendChild(wait);
    api(base(o.slug) + '/ban/preview', { ref: o.ref }).then(function (pv) {
      if (S.done) return;
      wait.remove();
      if (!pv.ok) { S.body.appendChild(el('p', 'psh-p', pv.error || '')); SH.buttons(S, null); return; }
      // (review fix: which person, and what exactly is lifted - scope, end, reason, who set it)
      S.body.appendChild(el('p', 'psh-sub', pv.who.title + ' · ' + pv.who.sub));
      var cur = pv.current || {}, wb = o.wban || {}, opts = [];
      var only = Array.isArray(o.only) ? o.only : null, want = function (sc) { return !only || only.indexOf(sc) >= 0; };
      if (want('pad') && (cur.pad || wb.p)) opts.push(['pad', cur.pad || { until: wb.p > 0 ? wb.p : null }]);
      if (want('bridge') && (cur.bridge || wb.b)) opts.push(['bridge', cur.bridge || { until: wb.b > 0 ? wb.b : null }]);
      // (profmod: the site-wide ban - only where the page asked for it, and only what the server says is in force now)
      if (only && want('site') && cur.site) opts.push(['site', cur.site]);
      if (!opts.length) { S.body.appendChild(el('p', 'psh-p', only && want('site') ? _t('js.ban.lift_none_site', 'There\'s no site-wide ban on them any more.') : _t('js.ban.lift_none', 'There\'s no website ban on them in this pad any more.'))); SH.buttons(S, null); return; }
      var scope = opts[0][0];
      var fs = el('fieldset', 'psh-opts'); fs.appendChild(el('legend', 'psh-k', _t('js.ban.lift_which', 'Which ban')));
      opts.forEach(function (op) {
        var lab = el('label', 'psh-opt'), r = el('input'); r.type = 'radio'; r.name = S.id + 'L'; r.value = op[0]; r.checked = op[0] === scope;
        var b = op[1], sp = el('span', null, SCOPE_TXT[op[0]]()[0]);
        sp.appendChild(el('small', null, (b.until ? _t('js.ban.until', 'until {when}', { when: utc(b.until) }) : _t('js.ban.until_lifted', 'until lifted'))
          + (b.reason ? ' · ' + b.reason : '') + (b.by ? ' · ' + _t('js.ban.by', 'by {who}', { who: b.by }) : '')));
        r.addEventListener('change', function () { if (r.checked) { scope = op[0]; paint(); } });
        lab.appendChild(r); lab.appendChild(sp); fs.appendChild(lab);
      });
      S.body.appendChild(fs);
      var what = el('p', 'psh-p', ''); S.body.appendChild(what);
      function paint() {
        what.textContent = scope === 'site' ? _t('js.ban.lift_site_body', 'They can post, comment and take part across the whole site again.')
          : scope === 'pad' ? _t('js.ban.lift_pad_body', 'They can post, comment, book the stage and chat from the website in this pad again.')
          : _t('js.ban.lift_bridge_body', 'They can chat and use commands in this room from the website again.');
      }
      paint();
      var B = SH.buttons(S, '↩️ ' + _t('js.ban.lift_go', 'Lift it'), 'go');
      B.go.addEventListener('click', function () {
        B.go.disabled = true; B.out.className = 'psh-out'; B.out.textContent = _t('js.ban.sending', 'One moment…');
        api(base(o.slug) + '/unban', { ref: o.ref, scope: scope }).then(function (a) {
          if (S.done) return;
          if (!a.ok) { B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = a.error || _t('js.ban.failed', 'Not changed.'); return; }
          B.out.className = 'psh-out ok'; B.out.textContent = _t('js.ban.lifted', 'Lifted.'); S.later(900);
          if (typeof o.onDone === 'function') { try { o.onDone(a); } catch (e) { /* the page's own */ } }
        }).catch(function () { if (S.done) return; B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = _t('js.ban.offline', 'Couldn\'t reach the site.'); });
      });
      B.no.focus();
    }).catch(function () { if (!S.done) { wait.textContent = _t('js.ban.offline', 'Couldn\'t reach the site.'); SH.buttons(S, null); } });
  }

  function open(o) {
    o = o || {};
    if (o.lift) return openLift(o);
    var SH = S_(); if (!SH) return;
    var S = SH.open({ title: '⛔ ' + _t('js.ban.title', 'Website ban'), cls: 'psh-ban', anchor: o.anchor });
    var wait = el('p', 'psh-hint', _t('js.ban.loading', 'Checking who this is…')); S.body.appendChild(wait);
    api(base(o.slug) + '/ban/preview', { ref: o.ref, scope: o.scope }).then(function (pv) {
      if (S.done) return;
      wait.remove();
      // (review fix: one Close button when the preview fails - not a second Cancel)
      if (!pv.ok) { S.h.textContent = '⛔ ' + _t('js.ban.cant', 'Can\'t ban from here'); S.body.appendChild(el('p', 'psh-p', pv.error || '')); SH.buttons(S, null); return; }
      // the identity's kind first, then which one (the tricon case reads unambiguously)
      S.h.textContent = '⛔ ' + pv.who.title;
      var kind = el('span', 'psh-sr', (KIND_TXT[pv.who.kind] || KIND_TXT.account)()); kind.id = S.id + 'K'; S.body.appendChild(kind);
      S.d.setAttribute('aria-describedby', kind.id);
      S.body.appendChild(el('p', 'psh-sub', pv.who.sub));
      // where
      var fs = el('fieldset', 'psh-opts'); fs.appendChild(el('legend', 'psh-k', _t('js.ban.where', 'Where')));
      // (profmod: a page that offers only some scopes - the profile: the whole site; none of them allowed = one Close)
      var scopes = Array.isArray(o.only) ? pv.scopes.filter(function (sc) { return o.only.indexOf(sc) >= 0; }) : pv.scopes;
      if (!scopes.length) { S.h.textContent = '⛔ ' + _t('js.ban.cant', 'Can\'t ban from here'); S.body.appendChild(el('p', 'psh-p', _t('js.ban.only_none', 'You can\'t make that ban.'))); SH.buttons(S, null); return; }
      var scope = scopes.indexOf(o.scope) >= 0 ? o.scope : scopes[0];
      scopes.forEach(function (sc) {
        var lab = el('label', 'psh-opt'); var r = el('input'); r.type = 'radio'; r.name = S.id + 'S'; r.value = sc; r.checked = sc === scope;
        var tx = SCOPE_TXT[pv.veil ? 'v' + sc : sc] ? SCOPE_TXT[pv.veil ? 'v' + sc : sc]() : SCOPE_TXT[sc](), sp = el('span', null, tx[0]); sp.appendChild(el('small', null, tx[1]));
        r.addEventListener('change', function () { if (r.checked) { scope = sc; paint(); } });
        lab.appendChild(r); lab.appendChild(sp); fs.appendChild(lab);
      });
      S.body.appendChild(fs);
      // how long
      var dl = el('p', 'psh-k', _t('js.ban.how_long', 'How long')); dl.id = S.id + 'D'; S.body.appendChild(dl);
      var chips = el('div', 'psh-chips'); chips.setAttribute('role', 'radiogroup'); chips.setAttribute('aria-labelledby', dl.id);
      var dur = '1d';
      DURS.forEach(function (dd) {
        var lab = el('label', 'psh-chip'); var r = el('input'); r.type = 'radio'; r.name = S.id + 'U'; r.value = dd[0]; r.checked = dd[0] === dur;
        r.addEventListener('change', function () { if (r.checked) { dur = dd[0]; paint(); } });
        lab.appendChild(r); lab.appendChild(el('span', null, dd[1]())); chips.appendChild(lab);
      });
      S.body.appendChild(chips);
      // why (review fix: "needed for a permanent ban" is said under the box - a disabled button's tooltip never reaches a touch screen)
      var fld = el('div', 'psh-fld');
      var rl = el('label', 'psh-k', pv.veil ? _t('js.ban.reason_veil', 'Reason (only this pad\'s mods and PATV staff see it)') : _t('js.ban.reason', 'Reason (they see it)')); rl.htmlFor = S.id + 'W';
      var why = el('input'); why.type = 'text'; why.id = S.id + 'W'; why.maxLength = 120; why.autocomplete = 'off';
      var need = el('p', 'psh-need', ''); need.id = S.id + 'N'; why.setAttribute('aria-describedby', need.id);
      why.addEventListener('input', paint);
      fld.appendChild(rl); fld.appendChild(why); fld.appendChild(need); S.body.appendChild(fld);
      // networks (admins) - its own box, not a fourth "where"
      var netBox = null, exempt = [];
      if (pv.nets && pv.nets.on) {
        var nb = el('div', 'psh-nets'), nl = el('label', 'psh-ck'); netBox = el('input'); netBox.type = 'checkbox';
        var ns = el('span', null, _t('js.ban.nets', 'Also block the networks they used'));
        ns.appendChild(el('small', null, _t('js.ban.nets_how', 'Networks used in the last 30 days, blocked for 1 day (a 1 hour or 1 day ban) or 7 days (longer ones).')));
        nl.appendChild(netBox); nl.appendChild(ns); nb.appendChild(nl);
        var acc = Array.isArray(pv.nets.accounts) ? pv.nets.accounts : [];
        if (pv.nets.shared) {
          nb.appendChild(el('p', 'psh-hint', _t('js.ban.nets_shared', '{n} other accounts share these networks - tick any to let through:', { n: pv.nets.shared })));
          var ex = el('div', 'psh-ex');
          acc.forEach(function (a) {
            var l2 = el('label', 'psh-ck sm'), c = el('input'); c.type = 'checkbox'; c.value = a.userId;
            c.addEventListener('change', function () { exempt = Array.prototype.map.call(ex.querySelectorAll('input:checked'), function (i) { return i.value; }); });
            l2.appendChild(c); l2.appendChild(el('span', 'psh-mono', '@' + a.username)); ex.appendChild(l2);
          });
          nb.appendChild(ex);
        } else nb.appendChild(el('p', 'psh-hint', _t('js.ban.nets_none', 'No other account shares them.')));
        S.body.appendChild(nb);
      }
      S.body.appendChild(el('p', 'psh-k', _t('js.ban.they_see', 'They will see')));
      var see = el('p', 'psh-refuse', ''); S.body.appendChild(see);
      if (pv.room) S.body.appendChild(el('p', 'psh-hint', _t('js.ban.room_note', 'This is the website. To remove them from the Camfrog room, use 🔨 Ban… in this menu.')));
      var B = SH.buttons(S, '⛔ ' + _t('js.ban.go', 'Ban'), 'danger');
      function paint() {
        var r = pv.refusal && pv.refusal[scope] ? String(pv.refusal[scope]) : '';
        var UNTIL = { '1h': _t('js.ban.until_1h', 'an hour from now'), '1d': _t('js.ban.until_1d', 'this time tomorrow'), '7d': _t('js.ban.until_7d', '7 days from now') };
        r = r.replace(/ until [^(.]+UTC/, dur === 'perm' ? '' : ' until ' + UNTIL[dur]);
        var w = why.value.replace(/\s+/g, ' ').trim();
        if (w && !pv.veil) r = r.replace(/\.$/, ' (' + w + ').');   // (1.99ajw padppl rework: an incognito ban never shows them the reason)
        see.textContent = r;
        var blocked = dur === 'perm' && !w;
        B.go.disabled = blocked;
        need.textContent = dur === 'perm' ? _t('js.ban.need_reason', 'A permanent ban needs a reason.') : '';
        need.className = 'psh-need' + (blocked ? ' bad' : '');
      }
      paint();
      B.go.addEventListener('click', function () {
        B.go.disabled = true; B.out.className = 'psh-out'; B.out.textContent = _t('js.ban.sending', 'One moment…');
        api(base(o.slug) + '/ban', { ref: o.ref, scope: scope, dur: dur, reason: why.value, nets: !!(netBox && netBox.checked), exempt: netBox && netBox.checked ? exempt : [] }).then(function (a) {
          if (S.done) return;
          if (!a.ok) { B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = a.error || _t('js.ban.failed', 'Not changed.'); return; }
          B.out.className = 'psh-out ok';
          B.out.textContent = scope === 'site' && !pv.veil ? _t('js.ban.done_site', 'Done - they\'re banned site-wide and signed out.') : _t('js.ban.done', 'Done - it\'s in the pad\'s list of bans.');
          S.later(1100);
          if (typeof o.onDone === 'function') { try { o.onDone(a); } catch (e) { /* the page's own */ } }
        }).catch(function () { if (S.done) return; B.go.disabled = false; B.out.className = 'psh-out bad'; B.out.textContent = _t('js.ban.offline', 'Couldn\'t reach the site.'); });
      });
      var first = fs.querySelector('input:checked'); if (first) first.focus();
    }).catch(function () { if (!S.done) { wait.textContent = _t('js.ban.offline', 'Couldn\'t reach the site.'); SH.buttons(S, null); } });
  }

  W.PATVBanSheet = { open: open, close: function () { var c = S_() && S_().current(); if (c) c.close(); } };
})(window, document);
