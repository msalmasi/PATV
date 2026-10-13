// chat-signin.js - the !signin landing page (views/chatSignin.ejs, chatsignin.js on the server).
// The one-time token is in the URL fragment (#t=...), which browsers never send: read it, clear it from the address bar and the
// history entry, ask the server who it is for (POST /api/chatsignin/peek - nothing is spent), then show ONE button: a same-origin
// form POST to /signin that spends it and signs in. A link preview or scanner that only fetches the URL never sees the token.
(function () {
  'use strict';
  var box = document.getElementById('csBox');
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var m = /(?:^#|&)t=([A-Za-z0-9_-]{32})(?:&|$)/.exec(window.location.hash || '');
  var token = m ? m[1] : '';
  try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* old browser: the fragment stays local anyway */ }
  function gone(text) {
    $('csH').textContent = 'This sign-in link has expired';
    $('csWhat').textContent = text || 'Chat sign-in links work once, for a few minutes. Type !signin in any room with Pepe for a new one.';
    box.setAttribute('data-state', 'expired');
  }
  if (!token) { gone(); return; }
  fetch('/api/chatsignin/peek', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' },
                                  body: JSON.stringify({ token: token }) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok) { gone(j && j.error === 'slow' ? 'Too many tries from your network. Wait a few minutes, then type !signin again.' : ''); return; }
      $('csH').textContent = 'Sign in as ' + j.username + '?';
      $('csWhat').textContent = 'Pepe sent you this link because your Camfrog name asked for it with !signin. It works once.';
      $('csToken').value = token;
      $('csGo').textContent = 'Sign in as ' + j.username;
      $('csForm').hidden = false;
      $('csMore').hidden = false;
      box.setAttribute('data-state', 'ready');
    })
    .catch(function () { gone('Something went wrong. Type !signin in chat for a new link.'); });
})();
