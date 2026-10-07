// pad-settings.js — the pad settings hub's own parts (1.99dc, /p/<slug>/settings, padsettings.js):
//   - the tabs: one section at a time; the address keeps #<section> (a reload, a shared link and the old
//     /manage + /mod anchors - #royalties, #reports, #pepe ... - land on the section that holds them)
//   - "Pepe on this pad's feed" (the master switch, saved on change)
//   - the automod form, the rules editor, reversing an automod call
//   - the Camfrog room's live Manage panel (room-mod.js) fed by the pad's live view, with a people list
// Same-site JSON fetches; the server checks who may change what on every request.
(function () {
  'use strict';
  var root = document.querySelector('.ps');
  if (!root) return;
  var slug = root.getAttribute('data-slug');
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
          if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
          return d;
        });
      });
  }

  // ── tabs ──
  var secs = Array.prototype.slice.call(root.querySelectorAll('.ps-sec'));
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.ps-tab'));
  var ids = secs.map(function (s) { return s.id; });
  root.classList.add('ps-js');
  function sectionOf(hash) {
    var id = String(hash || '').replace(/^#/, '');
    if (!id) return null;
    if (ids.indexOf(id) >= 0) return id;
    var t = null;
    try { t = document.getElementById(decodeURIComponent(id)); } catch (e) { t = null; }
    var s = t && t.closest ? t.closest('.ps-sec') : null;
    return s ? s.id : null;
  }
  function show(id, target, push) {
    if (ids.indexOf(id) < 0) id = ids[0];
    secs.forEach(function (s) { s.classList.toggle('on', s.id === id); });
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.classList.toggle('on', on);
      if (on && t.scrollIntoView && window.matchMedia('(max-width: 760px)').matches) {
        try { t.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* old browsers */ }
      }
    });
    var want = '#' + (target && target !== id ? target : id);
    if (push !== false && location.hash !== want) {
      try { history.replaceState(null, '', location.pathname + location.search.replace(/([?&])tab=[^&]*&?/, '$1').replace(/[?&]$/, '') + want); } catch (e) { /* file:// */ }
    }
    var t = target ? document.getElementById(target) : null;
    if (t && target !== id) setTimeout(function () { t.scrollIntoView({ block: 'start' }); t.classList.add('ps-flash'); setTimeout(function () { t.classList.remove('ps-flash'); }, 1600); }, 30);
    else if (push !== false) window.scrollTo(0, Math.min(window.scrollY, root.offsetTop));
  }
  function fromHash(push) {
    var h = location.hash.replace(/^#/, '');
    var s = sectionOf(h);
    if (s) return show(s, h, push);
    show(root.getAttribute('data-tab') || ids[0], null, push);
  }
  function first() {
    fromHash(true);
    // a section's own #id would leave the page scrolled to it; start at the top instead (deeper anchors still scroll)
    if (ids.indexOf(location.hash.replace(/^#/, '')) >= 0 || !location.hash) window.scrollTo(0, 0);
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function (e) { e.preventDefault(); show(t.getAttribute('data-tab')); });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      var i = tabs.indexOf(t) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
      var n = tabs[(i + tabs.length) % tabs.length];
      n.focus(); show(n.getAttribute('data-tab'));
    });
  });
  root.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-goto]');
    if (!a) return;
    e.preventDefault();
    var tgt = (a.getAttribute('href') || '').replace(/^#/, '');
    show(a.getAttribute('data-goto'), tgt || null);
  });
  window.addEventListener('hashchange', function () { fromHash(false); });
  first();

  // ── Pepe on this pad's feed (the master switch) ──
  var master = $('psPepeOn');
  if (master) master.addEventListener('change', function () {
    var on = master.checked, err = $('psPepeErr');
    if (err) err.textContent = '';
    master.disabled = true;
    api(master.getAttribute('data-url'), { settings: { enabled: on } }).then(function () {
      var card = master.closest('.ps-master');
      if (card) card.classList.toggle('is-off', !on);
      var st = card ? card.querySelector('.ps-state') : null;
      if (st) st.textContent = on ? 'ON' : 'OFF';
      var dot = root.querySelector('.ps-tab[data-tab="pepe"] .ps-dot');
      if (dot) { dot.className = 'ps-dot ' + (on ? 'on' : 'off'); dot.title = 'Pepe on this pad\'s feed: ' + (on ? 'on' : 'off'); }
      var next = card ? card.nextElementSibling : null;
      if (next) next.classList.toggle('ps-dim', !on);
      master.disabled = false;
    }, function (e) { master.checked = !on; master.disabled = false; if (err) err.textContent = e.message; else alert(e.message); });
  });

  // ── switches that say ON / OFF next to them ──
  root.addEventListener('change', function (e) {
    var cb = e.target;
    if (!cb || cb.type !== 'checkbox') return;
    var lab = cb.closest('.ps-switch');
    var st = lab ? lab.querySelector('.ps-state') : null;
    if (st && cb !== master) st.textContent = cb.checked ? st.getAttribute('data-on') : st.getAttribute('data-off');
  });

  // ── automod ──
  var amf = $('psAutomod');
  if (amf) amf.addEventListener('submit', function (e) {
    e.preventDefault();
    var err = amf.querySelector('.fc-err'); err.textContent = ''; err.classList.remove('ok');
    var s = {};
    Array.prototype.forEach.call(amf.elements, function (x) { if (x.name) s[x.name] = x.type === 'checkbox' ? x.checked : x.value; });
    var b = amf.querySelector('button[type=submit]'); if (b) b.disabled = true;
    api(amf.getAttribute('data-url'), { settings: s }).then(function () {
      err.textContent = 'Saved ✔'; err.classList.add('ok');
      setTimeout(function () { location.reload(); }, 500);
    }, function (x) { if (b) b.disabled = false; err.textContent = x.message; });
  });
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-am-reverse]');
    if (!b) return;
    var note = window.prompt('Reverse Pepe\'s call? The post or comment goes back, his report is closed and the author is told.\nA note for the log (optional):', '');
    if (note === null) return;
    b.disabled = true;
    api('/api/feed/automod/' + encodeURIComponent(b.getAttribute('data-am-reverse')) + '/reverse', { note: note })
      .then(function () { location.reload(); }, function (x) { b.disabled = false; alert(x.message); });
  });

  // ── rules editor ──
  var rf = $('psRules');
  if (rf) {
    var list = $('psRuleList'), tpl = $('psRuleTpl'), max = Number(rf.getAttribute('data-max')) || 15;
    var count = $('psRuleCount'), add = $('psRuleAdd');
    var paint = function () {
      var n = list.children.length;
      count.textContent = n + ' of ' + max + ' rules';
      add.disabled = n >= max;
      Array.prototype.forEach.call(list.children, function (li, i) {
        li.querySelector('[data-r=up]').disabled = i === 0;
        li.querySelector('[data-r=down]').disabled = i === n - 1;
      });
    };
    var addRule = function () {
      if (list.children.length >= max) return;
      var li = tpl.content.firstElementChild.cloneNode(true);
      list.appendChild(li); paint();
      li.querySelector('input').focus();
    };
    add.addEventListener('click', addRule);
    list.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-r]');
      if (!b) return;
      var li = b.closest('li'), r = b.getAttribute('data-r');
      if (r === 'del') li.remove();
      else if (r === 'up' && li.previousElementSibling) list.insertBefore(li, li.previousElementSibling);
      else if (r === 'down' && li.nextElementSibling) list.insertBefore(li.nextElementSibling, li);
      paint();
    });
    if (!list.children.length) addRule();
    paint();
    var save = function (body) {
      var err = rf.querySelector('.fc-err'); err.textContent = ''; err.classList.remove('ok');
      return api(rf.getAttribute('data-url'), body).then(function () {
        err.textContent = 'Saved ✔'; err.classList.add('ok');
        setTimeout(function () { location.reload(); }, 500);
      }, function (x) { err.textContent = x.message; });
    };
    rf.addEventListener('submit', function (e) {
      e.preventDefault();
      var rules = Array.prototype.map.call(list.children, function (li) {
        return { title: li.querySelector('input').value, desc: li.querySelector('textarea').value };
      });
      save({ intro: rf.elements.intro.value, rules: rules });
    });
    var clr = $('psRuleClear');
    if (clr) clr.addEventListener('click', function () {
      if (!window.confirm('Remove all of this pad\'s rules? It goes back to following the site-wide guidelines.')) return;
      save({ intro: '', rules: [] });
    });
  }

  // ── the Camfrog room: the live Manage panel (room-mod.js) fed by the pad's live view ──
  var host = $('psMod');
  if (host && window.PATVRoom && window.PATVRoom.mod) {
    var panel = window.PATVRoom.mod(host, slug, {});
    var note = $('psModNote'), pplBox = $('psPeopleBox'), ppl = $('psPeople'), pplN = $('psPplN');
    var cursor = 0, fails = 0, lastKey = '';
    var label = function (u) { return !u || u.anon ? 'someone' : (u.display || u.login); };
    var draw = function (d) {
      panel.update(d);
      var active = panel.active();
      var live = d && d.room && d.room.live;
      note.textContent = active ? 'You moderate this room. Pick an action, or click someone below.'
        : !live ? 'The Camfrog room isn\'t live right now — the Manage panel shows here when it is (and Pepe sees your moderator powers there).'
        : 'Pepe doesn\'t see moderator powers for your linked Camfrog name in this room, so the Manage panel stays hidden. Link your name with !verify in a room with Pepe.';
      var members = (d && d.members) || [];
      var key = JSON.stringify(members.map(function (u) { return [u.login, u.anon, u.self]; })) + (active ? '1' : '0');
      pplBox.classList.toggle('hide', !active);
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
    };
    var poll = function () {
      if (document.hidden) { setTimeout(poll, 5000); return; }
      fetch('/api/rooms/' + encodeURIComponent(slug) + '/live?after=' + cursor, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { fails = 0; if (d && d.cursor != null) cursor = d.cursor; draw(d); })
        .catch(function () { fails++; if (fails === 2) note.textContent = 'This pad\'s Camfrog room isn\'t bridged to the website right now, so there\'s nothing to manage from here.'; })
        .then(function () { setTimeout(poll, fails ? Math.min(30000, 4000 * fails) : 4000); });
    };
    poll();
  }
})();
