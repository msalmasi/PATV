// admin-roles.js - /admin/roles (adminroles.js, pepeperms.js, 1.99acj): role holders, per-command permissions (admin powers /
// can use), moderation targets; 1.99ack: the website's permissions (siteperms.js - a capability's minimum class, reset). Every change is a same-origin POST checked on the server with Pepe's own !role / !perm rules;
// the page reloads to show the result (the ladder, who set what). Messages go in with textContent only.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  var $ = function (id) { return document.getElementById(id); };
  var H = { 'content-type': 'application/json', 'X-Requested-With': 'fetch' };
  function errText(j) { return (j && j.error) || _t('js.admroles.failed', 'That did not work - try again.'); }
  function say(el, msg, bad) { if (el) { el.textContent = msg || ''; el.className = 'adm-msg' + (bad ? ' err' : msg ? ' ok' : ''); } }
  function msgNear(el) { var f = el && el.closest('tr, form, section'); return f ? f.querySelector('.adm-msg') : null; }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false }; });
  }
  function reloadSoon() { setTimeout(function () { location.reload(); }, 500); }
  function done(el, j, undo) {
    if (!j || !j.ok) { say(msgNear(el), errText(j), true); if (undo) undo(); return false; }
    say(msgNear(el), _t('js.admroles.saved', 'Saved.'));
    reloadSoon();
    return true;
  }

  // owner answers 2026-10-20: making or removing an OWNER needs the password step-up - a single-use nonce from
  // /api/admin/roles/nonce + the account password (the #arOwnerPw field, shown to owners); other role changes post as before
  function heldRole(login) {
    var s = document.querySelector('select[data-set-role="' + String(login).replace(/["\\]/g, '') + '"]');
    return s ? s.getAttribute('data-was') : null;
  }
  function setRole(el, login, role, was, undo) {
    var owner = role === 'owner' || was === 'owner';
    if (!owner) return post('/api/admin/roles/role', { login: login, role: role }).then(function (j) { done(el, j, undo); });
    var pw = $('arOwnerPw') ? $('arOwnerPw').value : '';
    if (!pw) { say(msgNear(el), _t('js.admroles.owner_pw_needed', 'Owner changes need your account password - enter it above first.'), true); if (undo) undo(); return Promise.resolve(); }
    return post('/api/admin/roles/nonce', {}).then(function (n) {
      if (!n || !n.ok || !n.nonce) return done(el, n, undo);
      return post('/api/admin/roles/role', { login: login, role: role, nonce: n.nonce, password: pw }).then(function (j) {
        if ($('arOwnerPw')) $('arOwnerPw').value = '';
        done(el, j, undo);
      });
    });
  }

  // role holders
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'SELECT') return;
    if (el.hasAttribute('data-set-role')) {
      var was = el.getAttribute('data-was');
      say(msgNear(el), _t('js.admroles.working', 'Saving…'));
      setRole(el, el.getAttribute('data-set-role'), el.value, was, function () { el.value = was; });
      return;
    }
    if (el.hasAttribute('data-site-perm')) {
      var before = el.getAttribute('data-prev');
      say(msgNear(el), _t('js.admroles.working', 'Saving…'));
      post('/api/admin/roles/site', { key: el.getAttribute('data-site-perm'), value: el.value })
        .then(function (j) { done(el, j, function () { if (before != null) el.value = before; }); });
      return;
    }
    if (el.hasAttribute('data-perm')) {
      var prev = el.getAttribute('data-prev');
      var body = { kind: el.getAttribute('data-perm'), cmd: el.getAttribute('data-cmd'), value: el.value };
      if (el.hasAttribute('data-role')) body.role = el.getAttribute('data-role');
      say(msgNear(el), _t('js.admroles.working', 'Saving…'));
      post('/api/admin/roles/perm', body).then(function (j) { done(el, j, function () { if (prev != null) el.value = prev; }); });
    }
  });
  // remember each select's value so a refused change puts it back
  Array.prototype.forEach.call(document.querySelectorAll('select[data-perm], select[data-site-perm]'), function (s) { s.setAttribute('data-prev', s.value); });

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-remove-role], button[data-reset], button[data-site-reset]') : null;
    if (!b) return;
    if (b.hasAttribute('data-site-reset')) {
      var key = b.getAttribute('data-site-reset');
      if (!window.confirm(_t('js.admroles.confirm_site_reset', 'Put {key} back to its default?', { key: key }))) return;
      say(msgNear(b), _t('js.admroles.working', 'Saving…'));
      post('/api/admin/roles/site', { key: key, value: 'default' }).then(function (j) { done(b, j); });
      return;
    }
    if (b.hasAttribute('data-remove-role')) {
      var login = b.getAttribute('data-remove-role');
      if (!window.confirm(_t('js.admroles.confirm_remove', 'Remove the role of {login}?', { login: login }))) return;
      say(msgNear(b), _t('js.admroles.working', 'Saving…'));
      setRole(b, login, 'none', heldRole(login));
      return;
    }
    var cmd = b.getAttribute('data-reset');
    if (!window.confirm(_t('js.admroles.confirm_reset', 'Put {cmd} back to Pepe defaults?', { cmd: cmd }))) return;
    say(msgNear(b), _t('js.admroles.working', 'Saving…'));
    post('/api/admin/roles/reset', { cmd: cmd }).then(function (j) { done(b, j); });
  });

  // PO-0b: an owner change from Pepe's sync - confirm / reject it with a single-use nonce + the account password (step-up)
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-pending-act]') : null;
    if (!b) return;
    var act = b.getAttribute('data-pending-act'), login = b.getAttribute('data-login');
    var pw = $('arPendPw') ? $('arPendPw').value : '';
    if (!pw) return say(msgNear(b), _t('js.admroles.pw_needed', 'Enter your account password first.'), true);
    var q = act === 'confirm' ? _t('js.admroles.confirm_pending', 'Apply the owner change for {login}?', { login: login })
      : _t('js.admroles.reject_pending', 'Reject the owner change for {login}?', { login: login });
    if (!window.confirm(q)) return;
    say(msgNear(b), _t('js.admroles.working', 'Saving…'));
    post('/api/admin/roles/nonce', {}).then(function (n) {
      if (!n || !n.ok || !n.nonce) return done(b, n);
      post('/api/admin/roles/pending', { login: login, action: act, nonce: n.nonce, password: pw }).then(function (j) {
        if ($('arPendPw')) $('arPendPw').value = '';
        done(b, j);
      });
    });
  });

  if ($('arAddRole')) $('arAddRole').addEventListener('submit', function (e) {
    e.preventDefault();
    var login = ($('arAddLogin').value || '').trim().replace(/^@/, '').toLowerCase();
    if (!login) return say($('arAddMsg'), _t('js.admroles.need_login', 'Enter a Camfrog login.'), true);
    say($('arAddMsg'), _t('js.admroles.working', 'Saving…'));
    setRole($('arAddRole'), login, $('arAddRoleSel').value, heldRole(login));
  });

  if ($('arAddCmd')) $('arAddCmd').addEventListener('submit', function (e) {
    e.preventDefault();
    var cmd = ($('arAddCmdName').value || '').trim().toLowerCase();
    if (cmd && cmd.charAt(0) !== '!') cmd = '!' + cmd;
    if (!cmd) return say($('arAddCmdMsg'), _t('js.admroles.need_cmd', 'Enter a command.'), true);
    var pw = $('arAddCmdPw').value, use = $('arAddCmdUse').value;
    if (pw === 'default' && use === 'default') return say($('arAddCmdMsg'), _t('js.admroles.need_change', 'Pick a setting that differs from the default.'), true);
    say($('arAddCmdMsg'), _t('js.admroles.working', 'Saving…'));
    var first = pw !== 'default' ? post('/api/admin/roles/perm', { kind: 'powers', cmd: cmd, value: pw }) : Promise.resolve({ ok: true });
    first.then(function (j) {
      if (!j || !j.ok) return done($('arAddCmd'), j);
      if (use === 'default') return done($('arAddCmd'), j);
      post('/api/admin/roles/perm', { kind: 'use', cmd: cmd, value: use }).then(function (j2) { done($('arAddCmd'), j2); });
    });
  });
})();
