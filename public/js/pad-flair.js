// pad-flair.js — pad flair in the browser (1.99ir, padflair.js):
//   * the pad page's "Your flair here" card ([data-pfl]): pick one of the pad's self-assignable flairs (or none)
//     -> POST /api/pads/<slug>/flair/mine
//   * the pad settings hub's Flair tab (#flairMgr): create / edit / delete the pad's flairs, give a member a flair or take
//     it off. The page renders the starting state as JSON (data-state); every change is a same-site JSON POST and the
//     server re-checks that the viewer manages the pad, then answers with the new state, which is drawn again.
// Everything user-visible goes in via textContent; colours are only ever strict #rrggbb custom properties.
(function () {
  'use strict';
  var HEX = /^#[0-9a-f]{6}$/;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (j) {
          if (!j.ok) throw new Error(j.error || 'Something went wrong.');
          return j;
        });
      });
  }
  function chip(f) {
    var s = el('span', 'ufl', f.name);
    s.title = 'Pad flair: ' + f.name;
    if (f.emoji) s.insertBefore(el('span', 'ufl-e', f.emoji), s.firstChild);
    if (HEX.test(f.color || '')) s.style.setProperty('--fl', f.color);
    if (HEX.test(f.ink || '')) s.style.setProperty('--fli', f.ink);
    return s;
  }

  // ── the member's picker on the pad page ──
  document.querySelectorAll('[data-pfl]').forEach(function (box) {
    var slug = box.getAttribute('data-pfl');
    var sel = box.querySelector('[data-pfl-pick]');
    var cur = box.querySelector('[data-pfl-cur]');
    var msg = box.querySelector('.pfl-msg');
    if (!sel) return;
    sel.addEventListener('change', function () {
      sel.disabled = true; if (msg) { msg.className = 'pfl-msg'; msg.textContent = 'Saving…'; }
      api('/api/pads/' + encodeURIComponent(slug) + '/flair/mine', { flair: sel.value ? Number(sel.value) : null }).then(function (j) {
        sel.disabled = false;
        if (cur) { cur.textContent = ''; cur.appendChild(j.mine && j.mine.flair ? chip(j.mine.flair) : el('span', 'mut', 'none')); }
        if (msg) msg.textContent = j.mine && j.mine.flair ? 'Saved - it shows next to your name in this pad.' : 'Flair taken off.';
      }).catch(function (e) { sel.disabled = false; if (msg) { msg.className = 'pfl-msg err'; msg.textContent = e.message; } });
    });
  });

  // ── the settings hub ──
  var mgr = document.getElementById('flairMgr');
  if (!mgr) return;
  var base = '/api/pads/' + encodeURIComponent(mgr.getAttribute('data-slug')) + '/flair';
  var S = null;
  try { S = JSON.parse(mgr.getAttribute('data-state') || 'null'); } catch (e) { S = null; }
  if (!S) return;
  var sec = mgr.closest('section') || document;          // the flair card + the "give someone flair" card
  var listEl = sec.querySelector('[data-fl=list]'), peopleEl = sec.querySelector('[data-fl=people]');
  var form = sec.querySelector('form[data-fl=form]'), give = sec.querySelector('form[data-fl=give]');
  var msgEl = sec.querySelector('[data-fl=msg]'), giveMsg = sec.querySelector('[data-fl=givemsg]');
  if (!listEl || !peopleEl || !form || !give) return;
  var editing = null;
  function say(t, bad, where) { var m = where || msgEl; if (!m) return; m.className = 'fl-msg' + (bad ? ' err' : ''); m.textContent = t || ''; }

  // the palette swatches fill the colour box
  var sw = form.querySelector('.fl-sw');
  (S.palette || []).forEach(function (c) {
    var b = el('button'); b.type = 'button'; b.title = c.name; b.setAttribute('aria-label', c.name);
    if (HEX.test(c.hex)) b.style.setProperty('--c', c.hex);
    b.addEventListener('click', function () { form.elements.color.value = c.hex; });
    sw.appendChild(b);
  });

  function resetForm() {
    editing = null;
    form.reset();
    form.elements.color.value = '#66bb6a';
    form.querySelector('[data-fl=save]').textContent = 'Add flair';
    form.querySelector('[data-fl=cancel]').hidden = true;
  }
  function draw() {
    listEl.textContent = '';
    if (!S.flairs.length) listEl.appendChild(el('li', 'mut', 'No flairs yet - add the first one below.'));
    S.flairs.forEach(function (f) {
      var li = el('li', 'fl-row');
      li.appendChild(chip(f));
      li.appendChild(el('span', 'fl-meta', (f.self ? 'members can pick it' : 'mods give it') + ' · ' + f.n + ' wearing'));
      li.appendChild(el('span', 'grow'));
      var ed = el('button', 'btn-s ghost', 'Edit'); ed.type = 'button';
      ed.addEventListener('click', function () {
        editing = f.id;
        form.elements.name.value = f.name; form.elements.emoji.value = f.emoji || '';
        form.elements.color.value = HEX.test(f.color) ? f.color : '#66bb6a'; form.elements.self.checked = !!f.self;
        form.querySelector('[data-fl=save]').textContent = 'Save changes';
        form.querySelector('[data-fl=cancel]').hidden = false;
        form.elements.name.focus();
      });
      var del = el('button', 'btn-s ghost', 'Delete'); del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete the flair "' + f.name + '"?' + (f.n ? ' ' + f.n + ' member' + (f.n === 1 ? '' : 's') + ' lose it.' : ''))) return;
        del.disabled = true;
        api(base + '/delete', { id: f.id }).then(function (j) { S = Object.assign(S, j.manage); if (editing === f.id) resetForm(); draw(); say('Deleted.'); })
          .catch(function (e) { del.disabled = false; say(e.message, true); });
      });
      li.appendChild(ed); li.appendChild(del);
      listEl.appendChild(li);
    });
    form.querySelector('[data-fl=count]').textContent = S.flairs.length + ' / ' + S.max;
    // the give form's choices
    var gs = give.elements.flair;
    var keep = gs.value;
    gs.textContent = '';
    gs.appendChild(el('option', null, '— no flair (take it off) —')).value = '';
    S.flairs.forEach(function (f) { var o = el('option', null, (f.emoji ? f.emoji + ' ' : '') + f.name); o.value = String(f.id); gs.appendChild(o); });
    if (keep && S.flairs.some(function (f) { return String(f.id) === keep; })) gs.value = keep;
    // who wears what
    peopleEl.textContent = '';
    if (!S.people.length) { var tr0 = el('tr'); var td0 = el('td', 'mut', 'Nobody has flair here yet.'); td0.colSpan = 4; tr0.appendChild(td0); peopleEl.appendChild(tr0); }
    S.people.forEach(function (p) {
      var tr = el('tr');
      var tdN = el('td');
      if (p.username) { var a = el('a', null, p.display || p.username); a.href = '/u/' + encodeURIComponent(p.username); tdN.appendChild(a); } else tdN.textContent = p.display || '[gone]';
      var tdF = el('td'); if (p.flair) tdF.appendChild(chip(p.flair));
      var tdW = el('td', 'mut', p.self ? 'picked it themselves' : 'given by ' + (p.by || 'a mod'));
      var tdA = el('td');
      var rm = el('button', 'lnk', 'Take off'); rm.type = 'button';
      rm.addEventListener('click', function () {
        rm.disabled = true;
        api(base + '/assign', { userId: p.userId, flair: null }).then(function (j) { S = Object.assign(S, j.manage); draw(); say('Flair taken off ' + (p.display || p.username) + '.', false, giveMsg); })
          .catch(function (e) { rm.disabled = false; say(e.message, true, giveMsg); });
      });
      tdA.appendChild(rm);
      [tdN, tdF, tdW, tdA].forEach(function (x) { tr.appendChild(x); });
      peopleEl.appendChild(tr);
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var b = form.querySelector('[data-fl=save]');
    b.disabled = true; say('Saving…');
    var body = { name: form.elements.name.value, emoji: form.elements.emoji.value, color: form.elements.color.value, self: form.elements.self.checked };
    if (editing) body.id = editing;
    api(base + '/save', body).then(function (j) { b.disabled = false; S = Object.assign(S, j.manage); resetForm(); draw(); say('Saved.'); })
      .catch(function (e) { b.disabled = false; say(e.message, true); });
  });
  form.querySelector('[data-fl=cancel]').addEventListener('click', function () { resetForm(); say(''); });
  give.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var b = give.querySelector('button[type=submit]');
    b.disabled = true; say('Saving…', false, giveMsg);
    api(base + '/assign', { user: give.elements.user.value, flair: give.elements.flair.value ? Number(give.elements.flair.value) : null }).then(function (j) {
      b.disabled = false; S = Object.assign(S, j.manage); give.elements.user.value = ''; draw(); say('Done.', false, giveMsg);
    }).catch(function (e) { b.disabled = false; say(e.message, true, giveMsg); });
  });
  resetForm();
  draw();
})();
