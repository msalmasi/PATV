// admin-keys.js - /admin/keys (adminkeys.js, 1.99acf): mint / rotate / revoke bot keys (a fresh key shows ONCE, in this page
// only, and is gone when you leave), scopes -> enforce, route-family legacy switches, the /events mode, the hub seam switches.
// Every change is an owner-only same-origin POST; the page reloads to show the result.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var $ = function (id) { return document.getElementById(id); };
  var H = { 'content-type': 'application/json', 'X-Requested-With': 'fetch' };
  var ERR = {
    owner_only: function () { return _t('js.admkeys.err.owner_only', 'Only an owner can change bot keys.'); },
    bad_caller: function () { return _t('js.admkeys.err.bad_caller', 'A caller is 2-32 characters: a-z, 0-9 and -, starting with a letter.'); },
    exists: function () { return _t('js.admkeys.err.exists', 'That caller already has a live key - rotate it instead.'); },
    revoked: function () { return _t('js.admkeys.err.revoked', 'That caller has no live key.'); },
    too_early: function () { return _t('js.admkeys.err.too_early', 'Observe for 7 days first, or tick the box to enforce early.'); },
    reason: function () { return _t('js.admkeys.err.reason', 'Give a reason.'); },
    tickets_need: function () { return _t('js.admkeys.err.tickets_need', 'Chat tickets need sign-outs to the hub and the heartbeat on (a signed-out session has to reach the hub). Turn those on first, or turn tickets off first.'); },
    bad_key: function () { return _t('js.admkeys.err.bad_key', 'Give a chat login, or # and a 20-character hash.'); },
    bad_kind: function () { return _t('js.admkeys.err.bad_kind', 'Pick what to un-hide.'); },
    not_found: function () { return _t('js.admkeys.err.held_gone', 'That held change is gone - reload the page.'); },
    decided: function () { return _t('js.admkeys.err.held_decided', 'That was already decided - reload the page.'); },
    not_ready: function () { return _t('js.admkeys.err.hidden_not_ready', 'The hidden set isn\'t loaded yet - try again in a minute.'); }
  };
  function errText(j) { return (j && j.code && ERR[j.code] ? ERR[j.code]() : (j && j.error)) || _t('js.admkeys.err.failed', 'That did not work - try again.'); }
  function say(el, msg, bad) { if (el) { el.textContent = msg || ''; el.className = 'adm-msg' + (bad ? ' err' : msg ? ' ok' : ''); } }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false }; });
  }
  function reloadSoon() { setTimeout(function () { location.reload(); }, 600); }
  function msgNear(el) { var f = el && el.closest('form, td, section'); return f ? f.querySelector('.adm-msg') : null; }

  // a fresh key: shown once, here only
  function showSecret(key) {
    var box = $('akSecretBox'), code = $('akSecret');
    if (!box || !code) return;
    code.textContent = key;
    box.hidden = false;
    box.scrollIntoView({ block: 'center' });
  }
  function clearSecret() { var code = $('akSecret'); if (code) code.textContent = ''; var box = $('akSecretBox'); if (box) box.hidden = true; }
  window.addEventListener('pagehide', clearSecret);
  if ($('akCopy')) $('akCopy').addEventListener('click', function () {
    var v = ($('akSecret') || {}).textContent || '';
    if (navigator.clipboard && v) navigator.clipboard.writeText(v).then(function () { say($('akMsg'), _t('js.admkeys.copied', 'Copied.')); }, function () {});
  });
  if ($('akDone')) $('akDone').addEventListener('click', function () { clearSecret(); location.reload(); });

  if ($('akMint')) $('akMint').addEventListener('submit', function (e) {
    e.preventDefault();
    var caller = ($('akCaller').value || '').trim().toLowerCase();
    say($('akMsg'), _t('js.admkeys.working', 'Working…'));
    post('/api/admin/keys/mint', { caller: caller, label: ($('akLabel').value || '').trim() }).then(function (j) {
      if (!j || !j.ok) return say($('akMsg'), errText(j), true);
      say($('akMsg'), _t('js.admkeys.minted', 'Key made for {caller}.', { caller: j.caller }));
      showSecret(j.key);
    });
  });

  if ($('akSettings')) $('akSettings').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { enabled: $('akEnabled').checked, bad_key: $('akBadKey').value };
    if ($('akCtlGet')) {
      body.control_get = $('akCtlGet').value;
      if (body.control_get === 'refuse' && !window.confirm(_t('js.admkeys.control_get_confirm', 'Refuse the GET claim? Check the route log first: the VM must claim with POST, or the control panel stops reaching it.'))) return;
    }
    post('/api/admin/keys/settings', body).then(function (j) {
      if (!j || !j.ok) return say($('akSetMsg'), errText(j), true);
      say($('akSetMsg'), _t('js.admkeys.saved', 'Saved.')); reloadSoon();
    });
  });
  if ($('akEvents')) $('akEvents').addEventListener('submit', function (e) {
    e.preventDefault();
    var mode = $('akEvMode').value;
    if (mode === 'enforce' && !window.confirm(_t('js.admkeys.events_confirm', 'Enforce /events auth? Check that both bots listen with their key (the table shows key, not anon) first.'))) return;
    post('/api/admin/keys/settings', { events: mode }).then(function (j) {
      if (!j || !j.ok) return say($('akEvMsg'), errText(j), true);
      say($('akEvMsg'), _t('js.admkeys.saved', 'Saved.')); reloadSoon();
    });
  });
  if ($('akSeam')) $('akSeam').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-seam]'), function (c) { body[c.getAttribute('data-seam')] = c.checked; });
    post('/api/admin/hubseam/settings', body).then(function (j) {
      if (!j || !j.ok) return say($('akSeamMsg'), errText(j), true);
      say($('akSeamMsg'), _t('js.admkeys.saved', 'Saved.')); reloadSoon();
    });
  });
  // 1.99add: un-hide one chat login in Pepe's sticky hidden set - or a hash, written "#<20 hex>" (a chat login can itself be 20
  // hex characters: without the # it is always taken as a login)
  // 1.99add refix 4: the set keeps why someone is hidden - one kind or all of them is un-hidden
  var KIND_TEXT = {
    bridge: function () { return _t('js.admkeys.kind.bridge', '!bridge hide (left out)'); },
    incognito: function () { return _t('js.admkeys.kind.incognito', 'incognito (shown as “someone”)'); },
    incognito_web: function () { return _t('js.admkeys.kind.incognito_web', 'a website Incognito ON Pepe hasn\'t applied yet (shown as “someone”)'); },
    unknown: function () { return _t('js.admkeys.kind.unknown', 'an older Pepe\'s list (left out)'); }
  };
  function kindsText(list) {
    return (list || []).map(function (k) {
      var name = typeof k === 'string' ? k : (k && k.kind === 'incognito' && k.src === 'web' ? 'incognito_web' : k && k.kind);
      return KIND_TEXT[name] ? KIND_TEXT[name]() : String(name || '');
    }).join(', ');
  }
  if ($('akUnhide')) $('akUnhide').addEventListener('submit', function (e) {
    e.preventDefault();
    var key = ($('akUnhideKey').value || '').trim(), why = ($('akUnhideWhy').value || '').trim();
    var sel = $('akUnhideKind'), kind = sel ? sel.value : 'all';
    if (why.length < 3) return say($('akUnhideMsg'), ERR.reason(), true);
    if (!key || key === '#') return say($('akUnhideMsg'), ERR.bad_key(), true);
    if (!/^(all|bridge|incognito|unknown)$/.test(kind)) return say($('akUnhideMsg'), ERR.bad_kind(), true);
    var isHash = key.charAt(0) === '#';
    if (isHash && !/^#[0-9a-f]{20}$/i.test(key)) return say($('akUnhideMsg'), ERR.bad_key(), true);
    var kindLabel = sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : kind;
    if (!window.confirm(_t('js.admkeys.unhide_confirm', 'Un-hide {key} ({kind})? Their name shows again in quotes and on the chat hub unless something else still hides them.', { key: key, kind: kindLabel }))) return;
    var body = isHash ? { h: key.slice(1).toLowerCase(), kind: kind, reason: why } : { login: key, kind: kind, reason: why };
    post('/api/admin/hubseam/unhide', body).then(function (j) {
      if (!j || !j.ok) return say($('akUnhideMsg'), errText(j), true);
      if (!j.was_hidden) return say($('akUnhideMsg'), _t('js.admkeys.unhidden_none', 'They weren\'t hidden that way.'));
      if (j.still && j.still.length) say($('akUnhideMsg'), _t('js.admkeys.unhidden_still', 'Un-hidden there - still hidden by: {kinds}.', { kinds: kindsText(j.still) }));
      else say($('akUnhideMsg'), _t('js.admkeys.unhidden', 'Un-hidden.'));
      reloadSoon();
    });
  });

  // 1.99add refix 3: look the same key up first (changes nothing) - hidden or not, held in which batch above, an OFF waiting
  if ($('akCheck')) $('akCheck').addEventListener('click', function () {
    var key = ($('akUnhideKey').value || '').trim();
    if (!key || key === '#') return say($('akUnhideMsg'), ERR.bad_key(), true);
    var isHash = key.charAt(0) === '#';
    if (isHash && !/^#[0-9a-f]{20}$/i.test(key)) return say($('akUnhideMsg'), ERR.bad_key(), true);
    var body = isHash ? { h: key.slice(1).toLowerCase() } : { login: key };
    say($('akUnhideMsg'), _t('js.admkeys.working', 'Working…'));
    post('/api/admin/hubseam/check', body).then(function (j) {
      if (!j || !j.ok) return say($('akUnhideMsg'), errText(j), true);
      var v = { key: key, kinds: kindsText(j.kinds) };
      if (!j.hidden) return say($('akUnhideMsg'), _t('js.admkeys.check_not', '{key} isn\'t hidden.', v));
      if (j.held) {
        v.at = new Date(Number(j.held.at) || 0).toLocaleString();
        var li = document.querySelector('#akHeld [data-held="' + String(j.held.id).replace(/[^0-9a-f]/g, '') + '"]');
        if (li) li.scrollIntoView({ block: 'center' });
        return say($('akUnhideMsg'), _t('js.admkeys.check_held', '{key} is hidden by: {kinds} - held in the list above ({at}): un-hide them here, or decide that batch there.', v));
      }
      if (j.absent_once) return say($('akUnhideMsg'), _t('js.admkeys.check_absent', '{key} is hidden by: {kinds} - missing from one of Pepe\'s lists; a second list in a row without them un-hides them.', v));
      say($('akUnhideMsg'), _t('js.admkeys.check_hidden', '{key} is hidden by: {kinds}.', v));
    });
  });

  // 1.99add: a held batch of the hidden set - approve (un-hide them) or dismiss (they stay hidden); the page never knows who
  Array.prototype.forEach.call(document.querySelectorAll('#akHeld [data-held-act]'), function (btn) {
    btn.addEventListener('click', function () {
      var li = btn.closest('[data-held]'), id = li ? li.getAttribute('data-held') : '';
      var approve = btn.getAttribute('data-held-act') === 'approve';
      var why = ($('akHeldWhy').value || '').trim();
      if (why.length < 3) return say($('akHeldMsg'), ERR.reason(), true);
      if (approve && !window.confirm(_t('js.admkeys.held_confirm', 'Un-hide these {n} people? Unless something else still hides them, their names show again in quotes, tips, mentions and on the chat hub - and nobody can tell you who they were.', { n: btn.getAttribute('data-held-n') || '?' }))) return;
      say($('akHeldMsg'), _t('js.admkeys.working', 'Working…'));
      post('/api/admin/hubseam/held', { id: id, approve: approve, reason: why }).then(function (j) {
        if (!j || !j.ok) return say($('akHeldMsg'), errText(j), true);
        if (!approve) say($('akHeldMsg'), _t('js.admkeys.held_dismissed', 'They stay hidden.'));
        else if (j.still_hidden) say($('akHeldMsg'), _t('js.admkeys.held_approved_still', 'Un-hidden ({n}; {still} of them stay hidden another way).', { n: j.removed, still: j.still_hidden }));
        else say($('akHeldMsg'), _t('js.admkeys.held_approved', 'Un-hidden ({n}).', { n: j.removed }));
        reloadSoon();
      });
    });
  });

  // an early-enforce tick enables that key's enforce button
  Array.prototype.forEach.call(document.querySelectorAll('[data-scopes] [data-early]'), function (box) {
    box.addEventListener('change', function () {
      var f = box.closest('form'), b = f && f.querySelector('[data-act="enforce"]');
      if (b) b.disabled = !box.checked;
    });
  });

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act'), caller = b.getAttribute('data-caller');
    var m = msgNear(b);
    if (act === 'rotate') {
      var g = document.querySelector('[data-grace="' + caller + '"]');
      if (!window.confirm(_t('js.admkeys.rotate_confirm', 'Make a new key for {caller}? The old one keeps working for the grace period.', { caller: caller }))) return;
      post('/api/admin/keys/rotate', { caller: caller, grace_h: g ? Number(g.value) : 24 }).then(function (j) {
        if (!j || !j.ok) return say($('akMsg'), errText(j), true);
        say($('akMsg'), _t('js.admkeys.rotated', 'New key for {caller}.', { caller: j.caller }));
        showSecret(j.key);
      });
    } else if (act === 'revoke') {
      var w = document.querySelector('[data-why="' + caller + '"]');
      var reason = w ? w.value.trim() : '';
      if (reason.length < 3) return say($('akMsg'), ERR.reason(), true);
      if (!window.confirm(_t('js.admkeys.revoke_confirm', 'Revoke the key of {caller}? It stops working at once.', { caller: caller }))) return;
      post('/api/admin/keys/revoke', { caller: caller, reason: reason }).then(function (j) {
        if (!j || !j.ok) return say($('akMsg'), errText(j), true);
        reloadSoon();
      });
    } else if (act === 'enforce' || act === 'observe') {
      var form = b.closest('form');
      var scopes = [];
      Array.prototype.forEach.call(form.querySelectorAll('input[type=checkbox][value]'), function (c) { if (c.checked) scopes.push(c.value); });
      var early = !!(form.querySelector('[data-early]') && form.querySelector('[data-early]').checked);
      if (act === 'enforce' && early && !window.confirm(_t('js.admkeys.early_confirm', 'Enforce before 7 days of observing? A route the key has not used yet will be refused.'))) return;
      post('/api/admin/keys/mode', { caller: caller, mode: act, scopes: scopes, early: early }).then(function (j) {
        if (!j || !j.ok) return say(m, errText(j), true);
        say(m, _t('js.admkeys.saved', 'Saved.')); reloadSoon();
      });
    } else if (act === 'grant') {
      post('/api/admin/keys/grant', { caller: caller, family: b.getAttribute('data-family') }).then(function (j) {
        if (!j || !j.ok) return say(m, errText(j), true);
        reloadSoon();
      });
    } else if (act === 'family') {
      var on = b.getAttribute('data-on') === '1';
      if (on && b.getAttribute('data-nonzero') === '1' &&
          !window.confirm(_t('js.admkeys.family_warn', 'The shared token was used on this family in the last 14 days. Refuse it there anyway?'))) return;
      post('/api/admin/keys/family', { family: b.getAttribute('data-family'), legacy_enforce: on }).then(function (j) {
        if (!j || !j.ok) return window.alert(errText(j));
        reloadSoon();
      });
    }
  });
})();
