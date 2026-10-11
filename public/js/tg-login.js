// tg-login.js — 1.99lb: the "Telegram" button on /login and /register (views/partials/auth-oauth.ejs).
// Opens Telegram's own Login Widget popup (telegram-widget.js, Telegram.Login.auth) and posts the signed data it returns
// to /auth/telegram/callback, which checks the signature (telegramsso.js) and says where to go next.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d) { return d; };
  function say(msg) {
    var m = document.querySelector('[data-tg-msg]');
    if (!m) return;
    m.textContent = msg || '';
    m.hidden = !msg;
  }
  function send(btn, data) {
    btn.disabled = true;
    fetch('/auth/telegram/callback', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ auth: data, next: btn.getAttribute('data-next') || '' })
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { window.location.href = (j && typeof j.redirect === 'string' && j.redirect.charAt(0) === '/' && j.redirect.charAt(1) !== '/') ? j.redirect : '/login'; })
      .catch(function () { btn.disabled = false; say(_t('js.auth.tg_failed', 'Telegram sign-in didn\'t work. Please try again.')); });
  }
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('[data-tg-login]');
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    var T = window.Telegram && window.Telegram.Login;
    if (!T || typeof T.auth !== 'function') { say(_t('js.auth.tg_loading', 'Telegram is still loading. Try again in a moment.')); return; }
    say('');
    T.auth({ bot_id: btn.getAttribute('data-bot'), request_access: 'write', lang: btn.getAttribute('data-lang') || 'en' }, function (data) {
      if (!data) { say(_t('js.auth.tg_cancelled', 'Telegram sign-in was cancelled.')); return; }
      send(btn, data);
    });
  });
})();
