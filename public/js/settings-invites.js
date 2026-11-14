// settings-invites.js - 1.99anv: /settings/invites (views/settingsInvites.ejs, invites.js). Create an invite (POST /api/invites ->
// the page reloads with ?made=<id> so the new link is on top and highlighted), copy a link, revoke a pending one (POST
// /api/invites/:id/revoke). Same-origin fetches with X-Requested-With: fetch (the site's rule for account writes). Text via
// textContent only.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  var msg = document.getElementById('invMsg');
  function say(text, tone) {
    if (!msg) return;
    msg.textContent = text || '';
    msg.className = 'inv-msg' + (tone ? ' ' + tone : '');
  }
  function post(path) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
                         headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: '{}' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.ok) throw new Error(j.error || _t('js.invites.failed', "That didn't work - try again."));
          return j;
        });
      });
  }

  var create = document.getElementById('invCreate');
  if (create) {
    create.addEventListener('click', function () {
      if (create.disabled) return;
      var idle = create.textContent;
      create.disabled = true;
      create.setAttribute('aria-busy', 'true');
      create.textContent = create.getAttribute('data-busy') || idle;
      post('/api/invites').then(function (j) {
        window.location.href = '/settings/invites?made=' + encodeURIComponent(j.invite.id) + '#pending';
      }).catch(function (e) {
        create.disabled = false;
        create.removeAttribute('aria-busy');
        create.textContent = idle;
        say(e.message, 'bad');
      });
    });
  }

  function copied(btn, ok) {
    var idle = btn.getAttribute('data-idle') || btn.textContent;
    btn.setAttribute('data-idle', idle);
    btn.textContent = ok ? _t('js.invites.copied', 'Copied!') : idle;
    if (!ok) say(_t('js.invites.copy_failed', "Couldn't copy - select the link and copy it yourself."), 'bad');
    setTimeout(function () { btn.textContent = idle; }, 1800);
  }
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var link = btn.getAttribute('data-copy') || '';
      var row = btn.closest('li');
      var input = row ? row.querySelector('input[data-link]') : null;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () { copied(btn, true); }, function () {
          if (input) { input.focus(); input.select(); }
          copied(btn, false);
        });
      } else if (input) {
        input.focus(); input.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        copied(btn, ok);
      }
    });
  });
  // a tap on the link selects it all (easy to copy by hand on a phone)
  document.querySelectorAll('input[data-link]').forEach(function (input) {
    input.addEventListener('focus', function () { input.select(); });
  });

  document.querySelectorAll('[data-revoke]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!window.confirm(_t('js.invites.revoke_confirm', 'Revoke this invite? The link stops working and the invite comes back to you.'))) return;
      btn.disabled = true;
      post('/api/invites/' + encodeURIComponent(btn.getAttribute('data-revoke')) + '/revoke').then(function () {
        window.location.assign('/settings/invites');
      }).catch(function (e) { btn.disabled = false; say(e.message, 'bad'); });
    });
  });
})();
