// creators.js — ⭐ PATV Creators in the browser (1.99pv): the composer's lock options (window.patvCreatorLock), the purchase
// modal (subscribe / unlock: a quote from the server, the price, renewal date and balance after, an explicit confirm), the 18+
// confirmation, subscription management (/subscriptions, the dashboard), the apply form and the creator / admin tools.
// Loaded by every partial / page that needs it; it initialises once.
(function () {
  'use strict';
  if (window.__patvCreators) return;
  window.__patvCreators = true;
  var _t = function (k, d, v) { return window.__t ? window.__t(k, d, v) : String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var lang = (window.PATV_I18N && window.PATV_I18N.lang) || undefined;
  var num = function (n) { return Number(n || 0).toLocaleString(lang); };
  var day = function (ms) { try { return new Date(Number(ms)).toLocaleDateString(lang, { dateStyle: 'medium' }); } catch (e) { return new Date(Number(ms)).toISOString().slice(0, 10); } };
  function key() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return 'w' + Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                        body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.ok === false) { var e = new Error(j.error || _t('js.cr.failed', 'Something went wrong - nothing was charged.')); e.code = j.code; throw e; }
        return j;
      }); });
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'cls') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  // ── the composer ──
  window.patvCreatorLock = function (form) {
    var box = form && form.querySelector('#crLock');
    if (!box) return undefined;
    var k = box.querySelector('input[name=crKind]:checked');
    if (!k || k.value === 'none') return undefined;
    var tier = box.querySelector('select[name=crTier]'), free = box.querySelector('select[name=crFree]');
    return {
      kind: k.value,
      tier: k.value === 'sub' ? (tier ? Number(tier.value) : null) : (free && free.value ? Number(free.value) : null),
      price: k.value === 'ppv' ? (box.querySelector('input[name=crPrice]') || {}).value : undefined,
      teaser: (box.querySelector('textarea[name=crTeaser]') || {}).value || ''
    };
  };
  function syncLock(box) {
    var k = box.querySelector('input[name=crKind]:checked');
    var v = k ? k.value : 'none';
    Array.prototype.forEach.call(box.querySelectorAll('[data-cr-for]'), function (x) {
      var f = x.getAttribute('data-cr-for');
      x.hidden = !(f === v || (f === 'any' && v !== 'none'));
    });
    var nsfw = box.form && box.form.elements.nsfw;
    if (nsfw) { if (v !== 'none') nsfw.checked = false; nsfw.disabled = v !== 'none'; }
  }
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t && t.name === 'crKind') { var box = t.closest('#crLock'); if (box) syncLock(box); }
  });

  // ── the modal ──
  var open = null;
  function closeModal() {
    if (!open) return;
    var o = open; open = null;
    o.scrim.remove();
    document.removeEventListener('keydown', o.esc, true);
    if (o.back && o.back.focus) o.back.focus();
  }
  function modal(title, body, actions) {
    closeModal();
    var back = document.activeElement;
    var h = el('h2', { id: 'crModalH', text: title });
    var x = el('button', { type: 'button', cls: 'ds-close', 'aria-label': _t('js.cr.close', 'Close') }, ['×']);
    var foot = el('div', { cls: 'ds-modal-f' }, actions);
    var dlg = el('div', { cls: 'ds-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'crModalH' }, [el('div', { cls: 'ds-modal-h' }, [h, x]), body, foot]);
    var scrim = el('div', { cls: 'ds-scrim sheet cr-modal' }, [dlg]);
    scrim.style.zIndex = 'var(--ds-z-modal)';
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeModal(); });
    x.addEventListener('click', closeModal);
    var esc = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeModal(); } };
    document.addEventListener('keydown', esc, true);
    document.body.appendChild(scrim);
    open = { scrim: scrim, esc: esc, back: back };
    var f = dlg.querySelector('button.ds-btn:not(.ghost), input, button');
    if (f) f.focus();
    return dlg;
  }
  function sumRows(rows) {
    return el('div', { cls: 'cr-sum' }, rows.map(function (r) { return el('div', {}, [el('span', { text: r[0] }), el('b', { cls: r[2] || '', text: r[1] })]); }));
  }
  function msgEl() { return el('p', { cls: 'cr-msg', role: 'status', 'aria-live': 'polite' }); }
  function busy(btn, on, label) { btn.disabled = on; btn.setAttribute('aria-busy', on ? 'true' : 'false'); if (label) btn.textContent = label; }

  function ageModal(then) {
    var ck = el('input', { type: 'checkbox', id: 'crAgeCk' });
    var m = msgEl();
    var go = el('button', { type: 'button', cls: 'ds-btn' }, [_t('js.cr.age_go', 'Continue')]);
    var body = el('div', { cls: 'ds-form' }, [
      el('p', { cls: 'ds-sub', text: _t('js.cr.age_p', 'This profile or pad is 18+: R-rated, suggestive content (never explicit). Confirm your age to see it. We remember it for your account.') }),
      el('label', { cls: 'ds-check', for: 'crAgeCk' }, [ck, ' ' + _t('js.cr.age_ck', 'I am 18 years old or older')]), m]);
    modal(_t('js.cr.age_h', '🔞 18+ content'), body, [el('button', { type: 'button', cls: 'ds-btn ghost', 'data-close': '1' }, [_t('js.cr.cancel', 'Cancel')]), go]);
    body.parentNode.querySelector('[data-close]').addEventListener('click', closeModal);
    go.addEventListener('click', function () {
      if (!ck.checked) { m.className = 'cr-msg bad'; m.textContent = _t('js.cr.age_tick', 'Tick the box to confirm.'); return; }
      busy(go, true);
      api('/api/creators/age', { yes: true }).then(function () { if (then) then(); else location.reload(); })
        .catch(function (e) { busy(go, false); m.className = 'cr-msg bad'; m.textContent = e.message; });
    });
  }

  function buyModal(q, opts) {
    if (q.r18 && !q.attested) return ageModal(function () { closeModal(); start(opts); });
    var price = Number(q.price) || 0;
    var after = q.balance == null ? null : Number(q.balance) - price;
    var rows = [];
    var title;
    if (q.kind === 'sub') {
      title = _t('js.cr.sub_h', 'Subscribe to {name}', { name: q.creator });
      rows.push([_t('js.cr.tier', 'Tier'), q.plan.tier + ' · ' + q.plan.name]);
      rows.push([_t('js.cr.price', 'Price'), _t('js.cr.per', '{n} PAT / {d} days', { n: num(price), d: q.periodDays }), 'gold']);
      rows.push([_t('js.cr.renews', 'Renews on'), day(q.renewsOn)]);
    } else {
      title = _t('js.cr.unlock_h', 'Unlock this post');
      rows.push([_t('js.cr.post', 'Post'), q.title || '']);
      rows.push([_t('js.cr.by', 'By'), q.creator || '']);
      rows.push([_t('js.cr.price', 'Price'), num(price) + ' PAT' + (q.discount ? ' (−' + q.discount + '%)' : ''), 'gold']);
    }
    if (after != null) rows.push([_t('js.cr.after', 'Your balance after'), num(after) + ' PAT', after < 0 ? '' : 'gold']);
    var m = msgEl();
    var kids = [sumRows(rows)];
    var renew = null, big = null;
    if (q.kind === 'sub') {
      renew = el('input', { type: 'checkbox', id: 'crRenew', checked: 'checked' });
      kids.push(el('label', { cls: 'ds-check', for: 'crRenew' }, [renew, ' ' + _t('js.cr.auto', 'Renew automatically (cancel any time)')]));
    }
    if (q.confirmOver && price > q.confirmOver) {
      big = el('input', { type: 'checkbox', id: 'crBig' });
      kids.push(el('label', { cls: 'ds-check', for: 'crBig' }, [big, ' ' + _t('js.cr.big', 'Yes, spend {n} PAT', { n: num(price) })]));
    }
    kids.push(el('p', { cls: 'ds-fine', text: _t('js.cr.fine', 'Paid in PAT. The creator gets it after a {d}-day hold; report a problem in that time and the staff can refund it. PAT has no cash value.', { d: q.holdDays }) }));
    if (!q.live) kids.push(el('div', { cls: 'ds-note warn' }, [el('div', { text: _t('js.cr.not_live', 'Purchases open once the PAT escrow is live on this site.') })]));
    if (after != null && after < 0) {
      kids.push(el('div', { cls: 'ds-note warn' }, [el('div', {}, [_t('js.cr.short', 'You need {n} more PAT.', { n: num(-after) }) + ' ', el('a', { href: '/support', text: _t('js.cr.get_pat', 'Get PAT') })])]));
    }
    kids.push(m);
    var go = el('button', { type: 'button', cls: 'ds-btn gold' }, [q.kind === 'sub' ? _t('js.cr.go_sub', 'Subscribe for {n} PAT', { n: num(price) }) : _t('js.cr.go_unlock', 'Unlock for {n} PAT', { n: num(price) })]);
    if (!q.live || (after != null && after < 0)) go.disabled = true;
    var body = el('div', { cls: 'ds-form' }, kids);
    modal(title, body, [el('button', { type: 'button', cls: 'ds-btn ghost', 'data-close': '1' }, [_t('js.cr.cancel', 'Cancel')]), go]);
    body.parentNode.querySelector('[data-close]').addEventListener('click', closeModal);
    var k = key();
    go.addEventListener('click', function () {
      if (big && !big.checked) { m.className = 'cr-msg bad'; m.textContent = _t('js.cr.big_tick', 'Tick the box to confirm the amount.'); return; }
      busy(go, true, _t('js.cr.paying', 'Paying…'));
      var p = q.kind === 'sub'
        ? api('/api/creators/subscribe', { creator: q.creator, tier: q.plan.tier, renew: renew ? renew.checked : true, pad: opts.pad || undefined, expect: price, key: k })
        : api('/api/creators/unlock', { post: q.post, expect: price, key: k });
      p.then(function () {
        m.className = 'cr-msg ok'; m.textContent = q.kind === 'sub' ? _t('js.cr.done_sub', 'Subscribed ✔') : _t('js.cr.done_unlock', 'Unlocked ✔');
        setTimeout(function () { location.reload(); }, 500);
      }).catch(function (e) { busy(go, false, q.kind === 'sub' ? _t('js.cr.go_sub', 'Subscribe for {n} PAT', { n: num(price) }) : _t('js.cr.go_unlock', 'Unlock for {n} PAT', { n: num(price) })); m.className = 'cr-msg bad'; m.textContent = e.message; });
    });
  }
  function start(opts) {
    var body = opts.post ? { post: opts.post } : { creator: opts.creator, tier: opts.tier || undefined };
    api('/api/creators/quote', body).then(function (q) { buyModal(q, opts); }).catch(function (e) { window.alert(e.message); });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-cr-sub],[data-cr-unlock],[data-cr-age],[data-cr-act],[data-cr-dispute],[data-cr-remove],[data-cr-gate-set],[data-cr-admin],[data-cr-td]') : null;
    if (!t) return;
    if (t.hasAttribute('data-cr-sub')) { ev.preventDefault(); return start({ creator: t.getAttribute('data-cr-sub'), tier: t.getAttribute('data-tier'), pad: t.getAttribute('data-pad') }); }
    if (t.hasAttribute('data-cr-unlock')) { ev.preventDefault(); return start({ post: t.getAttribute('data-cr-unlock') }); }
    if (t.hasAttribute('data-cr-age')) { ev.preventDefault(); return ageModal(null); }
    if (t.hasAttribute('data-cr-act')) {
      ev.preventDefault();
      var act = t.getAttribute('data-cr-act'), id = t.getAttribute('data-id');
      var body = {};
      if (act === 'tier') {
        var sel = document.querySelector('select[data-cr-tier-for="' + id + '"]');
        body = { tier: sel ? Number(sel.value) : null, key: key() };
        if (sel && sel.selectedOptions[0] && sel.selectedOptions[0].getAttribute('data-up')) {
          if (!window.confirm(_t('js.cr.up_confirm', 'Upgrade now? You pay the difference for the rest of this period.'))) return;
        }
      }
      if (act === 'cancel' && !window.confirm(_t('js.cr.cancel_confirm', 'Cancel? You keep access until the end of the paid period.'))) return;
      busy(t, true);
      return api('/api/creators/subs/' + encodeURIComponent(id) + '/' + act, body).then(function () { location.reload(); })
        .catch(function (e) { busy(t, false); window.alert(e.message); });
    }
    if (t.hasAttribute('data-cr-dispute')) {
      ev.preventDefault();
      var why = window.prompt(_t('js.cr.dispute_p', 'What went wrong? (not as described, empty, harassment...) The payment stays held until the staff look at it.'));
      if (why == null) return;
      return api('/api/creators/dispute', { ledger: t.getAttribute('data-cr-dispute'), reason: /empty/i.test(why) ? 'empty' : /harass/i.test(why) ? 'harassment' : /describ/i.test(why) ? 'not_as_described' : 'other', note: why })
        .then(function () { location.reload(); }).catch(function (e) { window.alert(e.message); });
    }
    if (t.hasAttribute('data-cr-remove')) {
      ev.preventDefault();
      if (!window.confirm(_t('js.cr.remove_confirm', 'Remove this subscriber? Their unreleased payment is refunded and the subscription ends now.'))) return;
      return api('/api/creators/subs/' + encodeURIComponent(t.getAttribute('data-cr-remove')) + '/remove', {}).then(function () { location.reload(); }).catch(function (e) { window.alert(e.message); });
    }
    if (t.hasAttribute('data-cr-admin')) {
      ev.preventDefault();
      var a = t.getAttribute('data-cr-admin'), url = t.getAttribute('data-url');
      var note = t.hasAttribute('data-note') ? window.prompt(t.getAttribute('data-note')) : '';
      if (note == null) return;
      if (t.hasAttribute('data-confirm') && !window.confirm(t.getAttribute('data-confirm'))) return;
      busy(t, true);
      return api(url, { action: a, note: note }).then(function (j) { if (j && j.message) window.alert(j.message); location.reload(); })
        .catch(function (e) { busy(t, false); window.alert(e.message); });
    }
    if (t.hasAttribute('data-cr-td')) {
      ev.preventDefault();
      var tda = t.getAttribute('data-cr-td');
      var n2 = window.prompt(tda === 'remove' ? _t('js.cr.td_remove', 'Remove the content and block exact copies? Add a note for the record.') : _t('js.cr.td_note', 'Note for the record (required for a rejection):'));
      if (n2 == null) return;
      busy(t, true);
      return api('/api/admin/takedowns/' + encodeURIComponent(t.getAttribute('data-id')) + '/' + tda, { note: n2 }).then(function (j) {
        if (j.late) window.alert(_t('js.cr.td_late', 'Removed - after the 48-hour deadline.'));
        location.reload();
      }).catch(function (e) { busy(t, false); window.alert(e.message); });
    }
  });

  // ── forms that post JSON (apply, plans, pads, comp, broadcast, admin config, the takedown request, explicit gates) ──
  function formJson(f) {
    var o = {};
    Array.prototype.forEach.call(f.elements, function (x) {
      if (!x.name || x.disabled) return;
      var path = x.name.split('.');
      var v = x.type === 'checkbox' ? x.checked : x.value;
      if (x.type === 'radio' && !x.checked) return;
      var cur = o;
      for (var i = 0; i < path.length - 1; i++) {
        var p = path[i], nx = path[i + 1];
        if (cur[p] == null) cur[p] = /^\d+$/.test(nx) ? [] : {};
        cur = cur[p];
      }
      cur[path[path.length - 1]] = v;
    });
    if (Array.isArray(o.plans)) o.plans = o.plans.filter(function (p) { return p && (p.name || p.price); });
    return o;
  }
  document.addEventListener('submit', function (ev) {
    var f = ev.target;
    if (!f || !f.hasAttribute || !f.hasAttribute('data-cr-form')) return;
    ev.preventDefault();
    var m = f.querySelector('.cr-msg');
    var btn = f.querySelector('button[type=submit]');
    if (f.hasAttribute('data-confirm') && !window.confirm(f.getAttribute('data-confirm'))) return;
    if (btn) busy(btn, true);
    api(f.getAttribute('data-cr-form'), formJson(f)).then(function (j) {
      if (m) { m.className = 'cr-msg ok'; m.textContent = f.getAttribute('data-ok') || _t('js.cr.saved', 'Saved ✔'); }
      var go = f.getAttribute('data-next');
      if (go === 'reload') setTimeout(function () { location.reload(); }, 600);
      else if (go) setTimeout(function () { location.href = go; }, 600);
      if (f.hasAttribute('data-show-id') && j && j.id) { var box = document.getElementById(f.getAttribute('data-show-id')); if (box) { box.hidden = false; var b = box.querySelector('b'); if (b) b.textContent = '#' + j.id; } f.hidden = true; }
      if (btn) busy(btn, false);
    }).catch(function (e) {
      if (btn) busy(btn, false);
      if (m) { m.className = 'cr-msg bad'; m.textContent = e.message; } else window.alert(e.message);
    });
  });
  // the rating choice on the apply form: the 18+ attestation only when it's chosen
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t && t.name === 'rating') {
      var box = document.getElementById('crAttest');
      if (box) box.hidden = t.value !== 'r18';
    }
    if (t && t.name === 'r18' && t.closest('[data-cr-pad]')) {
      var att = t.closest('[data-cr-pad]').querySelector('.cr-attest');
      if (att) att.hidden = !t.checked;
    }
  });
})();
