// admin-roomwars.js - the Room Wars card on /admin/games#roomwars (views/partials/admin-roomwars.ejs; roomwars.js).
(function () {
  'use strict';
  var f = document.getElementById('rwCfgForm'), msg = document.getElementById('rwCfgMsg'), st = document.getElementById('rwFeedState');
  if (!f) return;
  var KEYS = ['feed_on', 'disband_guard', 'show_slice', 'show_dormant'];
  function say(t) { if (msg) msg.textContent = t; }
  function show(c) { if (c) KEYS.forEach(function (k) { if (f.elements[k]) f.elements[k].checked = c[k] === true; }); }
  function feed(j) {
    if (!st) return;
    if (!j.feed) { st.textContent = 'Pepe has not pushed a room map yet.'; return; }
    var d = new Date(Number(j.feed.updated));
    st.textContent = 'Latest copy: revision ' + j.feed.revision + ', received ' + (isNaN(d) ? '?' : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC')
      + ' - ' + j.feed.rooms + ' rooms on the map, ' + j.feed.held + ' held' + (j.feed.on ? '' : ' (Room Wars is off in chat)')
      + '. Daily history: ' + (j.history.days || 0) + ' day(s)' + (j.history.first ? ' since ' + j.history.first : '') + '.';
  }
  fetch('/api/admin/roomwars-cfg', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.ok) { show(j.cfg); feed(j); } else say('Could not load.'); }).catch(function () { say('Could not load.'); });
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {};
    KEYS.forEach(function (k) { if (f.elements[k]) body[k] = !!f.elements[k].checked; });
    say('Saving…');
    fetch('/api/admin/roomwars-cfg', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { show(j.cfg); say('Saved.'); } else say((j && j.error) || 'Not saved.'); })
      .catch(function () { say('Not saved.'); });
  });
})();
