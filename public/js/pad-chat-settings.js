// pad-chat-settings.js — CL3: the pad settings' 💬 Chat tab (padchat.js; views/padSettings.ejs #padChatSet):
//   - "Chat history visitors can scroll back": a preset, Custom (a number + minutes / hours / days), or everything the tier keeps;
//     the line under it says what the tier caps it at
//   - Search this pad's chat, Allow downloads, Room mods can read all history (switches, saved on change)
//   - "Also open earlier history…" when a narrower setting closed lines that the current one would show (7 days later, announced)
// Same-site JSON fetches; the server checks who may change what (owner + site staff, a site admin's lock) on every request.
(function () {
  'use strict';
  var root = document.getElementById('padChatSet');
  var stEl = document.getElementById('pcsState');
  if (!root || !stEl) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    if (d && typeof d === 'object') d = v && v.count === 1 ? d.one : d.other;
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var slug = root.getAttribute('data-slug');
  var S = {};
  try { S = JSON.parse(stEl.textContent) || {}; } catch (e) { S = {}; }
  var $ = function (id) { return document.getElementById(id); };
  var sel = $('pcsWin'), custom = $('pcsCustom'), num = $('pcsNum'), unit = $('pcsUnit'), saveC = $('pcsCustomSave');
  var cap = $('pcsCap'), msg = $('pcsMsg'), openBox = $('pcsOpen'), lockNote = $('pcsLocked');
  var busy = false;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function say(t, err) { msg.textContent = t || ''; msg.className = 'msg' + (err ? ' err' : ''); }
  // CL3 fix-up: the server's refusals in the viewer's language, by their code (padchat.js); an unknown one keeps the server's text
  function errText(code, fallback) {
    switch (code) {
      case 'bad_window': return _t('js.pad.chatset.err_bad_window', 'Pick Off, a time from 1 minute to 3,650 days, or Everything your tier keeps.');
      case 'bad_value': return _t('js.pad.chatset.err_bad_value', 'That setting is on or off.');
      case 'empty': return _t('js.pad.chatset.err_empty', 'Nothing to change.');
      case 'rate': return _t('js.pad.chatset.err_rate', 'That’s a lot of changes at once - try again in a minute.');
      case 'locked': return _t('js.pad.chatset.err_locked', 'A site admin has locked this pad’s chat settings.');
      case 'signin': return _t('js.pad.chatset.err_signin', 'Sign in first.');
      case 'no_pad': return _t('js.pad.chatset.err_no_pad', 'No such pad.');
      case 'profile': return _t('js.pad.chatset.err_profile', 'A profile has no pad chat.');
      case 'not_owner': return _t('js.pad.chatset.err_not_owner', 'Only this pad’s owner (and site staff) can change its chat settings.');
      case 'admin_only': return _t('js.pad.chatset.err_admin_only', 'Site admins only.');
      case 'bad_scope': return _t('js.pad.chatset.err_bad_scope', 'Pick what to open: the window, search or both.');
      case 'pending': return _t('js.pad.chatset.err_pending', 'An earlier-history opening is already scheduled.');
      case 'nothing': return _t('js.pad.chatset.err_nothing', 'Nothing earlier is closed there - every line your settings allow is already shown.');
      case 'none': return _t('js.pad.chatset.err_none', 'Nothing is scheduled.');
      case 'security': return _t('js.pad.chatset.err_security', 'Security check failed - reload the page.');
      case 'error': return _t('js.pad.chatset.err_error', 'Something went wrong - nothing was changed.');
      default: return fallback;
    }
  }

  var SPAN_D = { one: '{count} day', other: '{count} days' }, SPAN_H = { one: '{count} hour', other: '{count} hours' }, SPAN_M = { one: '{count} minute', other: '{count} minutes' };
  function spanOf(s) {
    if (s % 86400 === 0 && s >= 172800) return _t('js.pad.chat.span_d', SPAN_D, { count: s / 86400 });
    if (s % 3600 === 0) return _t('js.pad.chat.span_h', SPAN_H, { count: s / 3600 });
    return _t('js.pad.chat.span_min', SPAN_M, { count: Math.max(1, Math.round(s / 60)) });
  }
  function daysOf(d) { return d == null ? _t('js.pad.chatset.for_good', 'for good') : spanOf(d * 86400); }
  // the line under the window: what the tier keeps, and what visitors get with this setting
  function capText() {
    var tier = S.tier === 'unlimited' ? _t('js.pad.chatset.tier_plus', 'Your 💎 Prime Time Plus pad')
      : S.tier === 'prime' ? _t('js.pad.chatset.tier_prime', 'Your 📺 Prime Time pad') : _t('js.pad.chatset.tier_none', 'A pad without a tier');
    var r = S.retention || {};
    var what = r.chat_days == null && r.rec_days == null ? _t('js.pad.chatset.what_good', 'chat and mic transcripts for good')
      : r.chat_days === r.rec_days ? _t('js.pad.chatset.what_same', 'chat and mic transcripts {days}', { days: daysOf(r.chat_days) })
      : _t('js.pad.chatset.what_split', 'chat {chat} and mic transcripts {rec}', { chat: daysOf(r.chat_days), rec: daysOf(r.rec_days) });
    var w = S.window_s, eff = S.effective ? S.effective.chat_s : null;
    if (w === 0) return _t('js.pad.chatset.cap_off', '{tier} keeps {what}; visitors see no earlier messages.', { tier: tier, what: what });
    if (w == null) return eff == null ? _t('js.pad.chatset.cap_all', '{tier} keeps {what}, so visitors can scroll back through all of it.', { tier: tier, what: what })
      : _t('js.pad.chatset.cap_ok', '{tier} keeps {what}, so visitors can scroll back {span}.', { tier: tier, what: what, span: spanOf(eff) });
    if (eff != null && eff < w) return _t('js.pad.chatset.cap_capped', '{tier} keeps {what} — your {span} setting works as {cap} until you upgrade.', { tier: tier, what: what, span: spanOf(w), cap: spanOf(eff) });
    return _t('js.pad.chatset.cap_ok', '{tier} keeps {what}, so visitors can scroll back {span}.', { tier: tier, what: what, span: spanOf(w) });
  }
  function dayText(ms) {
    try { return new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return new Date(ms).toDateString(); }
  }
  var SCOPE = function (s) {
    return s === 'window' ? _t('js.pad.chatset.scope_window', 'what visitors can scroll back to')
      : s === 'search' ? _t('js.pad.chatset.scope_search', 'search') : _t('js.pad.chatset.scope_both', 'scrollback and search');
  };
  var locked = function () { return !!S.locked && !S.can_unlock; };
  function renderOpen() {
    openBox.textContent = '';
    if (S.open) {
      openBox.appendChild(el('p', 'ds-meta', _t('js.pad.chatset.open_pending', 'Earlier history ({scope}) opens on {date}. It was announced in the pad and in the Camfrog room.',
        { scope: SCOPE(S.open.scope), date: dayText(S.open.effective) })));
      if (!locked()) {
        var c = el('button', 'ds-btn sm ghost', _t('js.pad.chatset.open_cancel', 'Cancel the opening'));
        c.type = 'button';
        c.addEventListener('click', function () { send('DELETE', '/open-earlier', null); });
        openBox.appendChild(c);
      }
      return;
    }
    var cl = S.closed || {};
    if (!(cl.window || cl.search) || locked()) return;
    openBox.appendChild(el('p', 'ds-meta', _t('js.pad.chatset.open_what', 'Lines said while a narrower setting was on stay hidden from visitors. You can open them again: it takes effect {days} days after you ask, and it’s announced in the pad and in the Camfrog room.', { days: S.open_days || 7 })));
    var row = el('div', 'ds-row');
    var scopes = cl.window && cl.search ? ['both', 'window', 'search'] : cl.window ? ['window'] : ['search'];
    var pick = null;
    if (scopes.length > 1) {
      pick = el('select', 'ds-select');
      pick.setAttribute('aria-label', _t('js.pad.chatset.open_scope', 'What to open'));
      scopes.forEach(function (s) { var o = el('option', null, SCOPE(s)); o.value = s; pick.appendChild(o); });
      row.appendChild(pick);
    }
    var b = el('button', 'ds-btn sm', _t('js.pad.chatset.open_btn', 'Also open earlier history…'));
    b.type = 'button';
    b.addEventListener('click', function () {
      var scope = pick ? pick.value : scopes[0];
      var when = dayText(Date.now() + (S.open_days || 7) * 864e5);
      row.textContent = '';
      row.appendChild(el('span', 'ds-meta', _t('js.pad.chatset.open_confirm', 'Open {scope} on {date}? It’s announced now in the pad and in the Camfrog room.', { scope: SCOPE(scope), date: when })));
      var yes = el('button', 'ds-btn sm', _t('js.pad.chatset.open_yes', 'Yes, open it'));
      var no = el('button', 'ds-btn sm ghost', _t('js.pad.chatset.open_no', 'Not now'));
      yes.type = no.type = 'button';
      yes.addEventListener('click', function () { send('POST', '/open-earlier', { scope: scope }); });
      no.addEventListener('click', renderOpen);
      row.appendChild(yes); row.appendChild(no);
      yes.focus();
    });
    row.appendChild(b);
    openBox.appendChild(row);
  }
  function render() {
    cap.textContent = capText();
    var dis = locked();
    lockNote.hidden = !S.locked;
    [sel, num, unit, saveC].forEach(function (x) { if (x) x.disabled = dis; });
    Array.prototype.forEach.call(root.querySelectorAll('[data-pcs]'), function (x) {
      x.disabled = dis;
      var k = x.getAttribute('data-pcs');
      x.checked = !!S[k];
    });
    var w = S.window_s;
    var presets = (S.presets || []).map(String);
    var v = w == null ? 'all' : presets.indexOf(String(w)) >= 0 ? String(w) : 'custom';
    if (document.activeElement !== sel) sel.value = v;
    custom.hidden = sel.value !== 'custom';
    if (v === 'custom' && w != null && document.activeElement !== num) {
      var u = w % 86400 === 0 ? 86400 : w % 3600 === 0 ? 3600 : 60;
      unit.value = String(u); num.value = String(Math.round(w / u));
    }
    renderOpen();
  }
  // one request at a time; a settings change made meanwhile is merged and sent right after (never lost)
  var queued = null;
  function flush() {
    var q = queued;
    queued = null;
    if (q) send(q.method, q.path, q.body);
  }
  function send(method, path, body) {
    if (busy) {
      if (method === 'POST' && !path && body && queued && queued.method === 'POST' && !queued.path) Object.assign(queued.body, body);
      else queued = { method: method, path: path, body: body ? Object.assign({}, body) : null };
      return;
    }
    busy = true;
    say(_t('js.pad.chatset.saving', 'Saving…'));
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/chat-settings' + (path || ''), {
      method: method, credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' } : { 'X-Requested-With': 'fetch' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(errText(d.code, d.error || ('HTTP ' + r.status)));
        return d;
      });
    }).then(function (d) {
      busy = false;
      delete d.ok;
      S = d;
      render();
      say(_t('js.pad.chatset.saved', 'Saved. Visitors see the change at once.'));
      flush();
    }).catch(function (e) {
      busy = false;
      queued = null;
      render();
      say(_t('js.pad.chatset.failed', 'Couldn’t save: {error}', { error: e.message }), true);
    });
  }
  sel.addEventListener('change', function () {
    if (sel.value === 'custom') { custom.hidden = false; num.focus(); return; }
    custom.hidden = true;
    send('POST', '', { window_s: sel.value === 'all' ? null : Number(sel.value) });
  });
  function saveCustom() {
    var n = Math.floor(Number(num.value)), u = Number(unit.value);
    var s = n * u;
    if (!(n >= 1) || s < (S.min || 60) || s > (S.max || 315360000)) { say(_t('js.pad.chatset.custom_range', 'Pick from 1 minute to 3,650 days.'), true); num.focus(); return; }
    send('POST', '', { window_s: s });
  }
  saveC.addEventListener('click', saveCustom);
  num.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveCustom(); } });
  Array.prototype.forEach.call(root.querySelectorAll('[data-pcs]'), function (x) {
    x.addEventListener('change', function () {
      var b = {};
      b[x.getAttribute('data-pcs')] = !!x.checked;
      send('POST', '', b);
    });
  });
  render();
})();
