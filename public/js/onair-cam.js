// onair-cam.js — 📺 "Put on Pepe's cam" in the pad's cam popover, admins only (1.99aag; onair.js decides). One click =
// the same as !onair cam <login>: the cam goes on Pepe's OBS (his main stream + his Camfrog cam). When the cam owner
// hasn't opted in (or the pad is Approved-only) the server says so and the admin can send them the on-demand request.
(function () {
  'use strict';
  var mark = document.getElementById('oaCamRoom');
  if (!mark) return;
  var room = mark.getAttribute('data-room');
  function post(body) {
    return fetch('/api/stage/admin/onair', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  window.PATVOnAirCam = {
    row: function (box, who) {
      if (!box || !who || !who.login) return;
      var row = el('div', 'row oa-cam');
      var b = el('button', null, '📺 Put on Pepe’s cam'); b.type = 'button';
      b.title = 'Admins: show this cam on Pepe’s main stream and his Camfrog cam (needs the cam owner’s OK)';
      var msg = el('span', 'muted');
      row.appendChild(b); row.appendChild(msg);
      function done(j) {
        var T = j.target;
        msg.textContent = T && (T.pending || []).length ? 'Asked them - it goes on air once they allow it.' : 'On Pepe’s cam now.';
      }
      b.addEventListener('click', function () {
        b.disabled = true; msg.textContent = 'Working…';
        post({ action: 'cam', room: room, login: who.login }).then(function (j) {
          b.disabled = false;
          if (j.ok) return done(j);
          if (j.code === 'no_optin' || j.code === 'pad_private') {
            msg.textContent = (j.code === 'no_optin' ? 'They haven’t allowed their cam on Pepe’s main stream. ' : 'Approved-only pad: its owner has to allow it. ') ;
            var ask = el('button', null, 'Ask them'); ask.type = 'button';
            ask.addEventListener('click', function () {
              ask.disabled = true;
              post({ action: 'cam', room: room, login: who.login, ask: true }).then(function (k) {
                if (k.ok) { ask.remove(); done(k); } else { ask.disabled = false; msg.textContent = k.error || 'Couldn’t ask.'; }
              });
            });
            msg.appendChild(ask);
            return;
          }
          msg.textContent = j.error || 'Couldn’t do that.';
        }).catch(function () { b.disabled = false; msg.textContent = 'Couldn’t reach the site.'; });
      });
      box.appendChild(row);
    },
  };
})();
