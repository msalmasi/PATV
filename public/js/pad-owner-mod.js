// pad-owner-mod.js — the owner panel's "Moderate your room" card (1.99ti, views/padOwner.ejs #mod): the pad page's Manage
// panel (room-mod.js, padmod.js) fed by the pad's live view (GET /api/rooms/:slug/live, the same feed the pad page polls -
// polling it also tells Pepe this signed-in owner is watching, so his snapshot carries their caps). Pepe decides what the
// owner may do in their own room (pepe_roomowner OWNER_MOD_CMDS: kick, ban / unban, punish, mic block, time out - 1.99uf: in
// this room only, lifted with !untimeout -, fine and
// the room roles - never on Pepe's admins / owners); every action has its confirm step and lands in the mod log.
// The people list opens the Manage dialog for that person; the panel's "Banned list" shows who is banned / muted /
// mic-blocked / timed out with undo. Strings: __t (js.owner.mod_*); user-visible text via textContent.
(function () {
  'use strict';
  var card = document.getElementById('mod');
  var host = document.getElementById('poMod');
  if (!card || !host || !window.PATVRoom || !window.PATVRoom.mod) return;
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var slug = card.getAttribute('data-slug');
  var panel = window.PATVRoom.mod(host, slug, {});
  var note = document.getElementById('poModNote'), box = document.getElementById('poPeopleBox'),
    ppl = document.getElementById('poPeople'), pplN = document.getElementById('poPplN');
  var cursor = 0, fails = 0, lastKey = '';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function label(u) { return !u || u.anon ? _t('js.owner.mod_someone', 'someone') : (u.display || u.login); }
  function draw(d) {
    panel.update(d);
    var active = panel.active();
    var live = d && d.room && d.room.live;
    note.textContent = active ? _t('js.owner.mod_active', 'Pick an action, or click someone below.')
      : !live ? _t('js.owner.mod_offline', 'The Camfrog room isn\'t live on the pad right now - this shows when it is.')
      : _t('js.owner.mod_nolink', 'Pepe doesn\'t see your linked Camfrog name as this pad\'s owner yet. Link it with !verify in a room with Pepe, then reload.');
    var members = (d && d.members) || [];
    var key = JSON.stringify(members.map(function (u) { return [u.login, u.anon, u.self]; })) + (active ? '1' : '0');
    box.hidden = !active;
    if (key === lastKey) return;
    lastKey = key;
    ppl.textContent = '';
    members.filter(function (u) { return !u.self; }).forEach(function (u) {
      var li = el('li');
      if (active && !u.anon && u.login) {
        var b = el('button', 'pm-btn', label(u)); b.type = 'button';
        b.addEventListener('click', function () { panel.open(u); });
        li.appendChild(b);
      } else li.appendChild(el('span', 'muted', label(u)));
      ppl.appendChild(li);
    });
    pplN.textContent = members.length ? '(' + members.length + ')' : '';
  }
  function poll() {
    if (document.hidden) { setTimeout(poll, 5000); return; }
    fetch('/api/rooms/' + encodeURIComponent(slug) + '/live?after=' + cursor, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { fails = 0; if (d && d.cursor != null) cursor = d.cursor; draw(d); })
      .catch(function () { fails++; if (fails === 2) note.textContent = _t('js.owner.mod_unbridged', 'This pad\'s Camfrog room isn\'t on the website right now, so there\'s nothing to moderate from here.'); })
      .then(function () { setTimeout(poll, fails ? Math.min(30000, 4000 * fails) : 4000); });
  }
  poll();
})();
