// admin-guests.js - 1.99anv: Users & Accounts → 🚪 "Guest access" (guestaccess.js). One checkbox per section, grouped like the
// navbar (Watch & hang out, Play, You, Shop, Info), with what each covers; Save sends only the switches that changed, with what the
// card loaded as `expect` (409 E_STALE when another admin changed one meanwhile - nothing saved). The log below.
// GET / POST /api/admin/guest-access - same-origin fetches. Text via textContent only.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  if (!$('gaForm')) return;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(body) {
    var o = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body) { o.method = 'POST'; o.headers['content-type'] = 'application/json'; o.headers['x-requested-with'] = 'fetch'; o.body = JSON.stringify(body); }
    return fetch('/api/admin/guest-access', o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.code; throw e; } return j; });
    });
  }
  function msg(t, bad) { var m = $('gaMsg'); m.textContent = t || ''; m.className = 'adm-msg' + (t ? (bad ? ' err' : ' ok') : ''); }
  function day(ms) { try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch (e) { return ''; } }
  var SEC = { watch: 'Watch & hang out', play: 'Play', you: 'You', shop: 'Shop, sounds & support', info: 'Info & links' };
  var loaded = {};      // what the card shows as saved: key -> on

  function paint(d) {
    loaded = Object.assign({}, d.settings);
    var off = Object.keys(loaded).filter(function (k) { return !loaded[k]; }).length;
    var pill = $('gaCount');
    pill.textContent = off ? off + ' off for guests' : 'all open';
    pill.className = 'adm-pill ' + (off ? 'bad' : 'ok');
    $('gaMode').textContent = 'Sign-ups are ' + (d.mode === 'invite' ? 'INVITE-ONLY - the "sign in" page offers "Got an invite?"' : 'open - the "sign in" page offers "Sign up"') +
      '. ' + (off ? off + ' section' + (off === 1 ? ' is' : 's are') + ' off for signed-out visitors.' : 'Every section is open to signed-out visitors.');
    var list = $('gaList'); list.textContent = '';
    (d.sections || []).forEach(function (s) {
      var fs = el('fieldset', 'ga-sec');
      fs.appendChild(el('legend', null, SEC[s.key] || s.key));
      var rows = el('div', 'ga-rows');
      s.groups.forEach(function (g) {
        var lab = el('label', 'ga-row' + (g.on ? '' : ' off'));
        var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!g.on; cb.setAttribute('data-ga', g.key);
        cb.setAttribute('aria-describedby', 'ga-d-' + g.key);
        cb.addEventListener('change', function () {
          lab.classList.toggle('off', !cb.checked);
          lab.classList.toggle('dirty', cb.checked !== !!loaded[g.key]);
        });
        lab.appendChild(cb);
        lab.appendChild(el('b', null, g.label + (g.on ? '' : ' - off for guests')));
        var sm = el('small', null, g.covers); sm.id = 'ga-d-' + g.key;
        lab.appendChild(sm);
        rows.appendChild(lab);
      });
      fs.appendChild(rows);
      list.appendChild(fs);
    });
    var al = $('gaAudit'); al.textContent = '';
    if (!(d.audit || []).length) al.appendChild(el('li', null, 'No changes yet.'));
    (d.audit || []).forEach(function (a) {
      var det = a.detail || {};
      al.appendChild(el('li', null, day(a.at) + ' · @' + (a.admin || '?') + ' turned ' + (det.section || '?') + ' ' + (det.to ? 'ON' : 'OFF') + ' for guests' + (a.reason ? ' · ' + a.reason : '')));
    });
  }
  function load() { return api(null).then(paint).catch(function (e) { $('gaMode').textContent = e.message; }); }

  function save(all) {
    var changes = {}, expect = {};
    Array.prototype.forEach.call($('gaList').querySelectorAll('[data-ga]'), function (cb) {
      var k = cb.getAttribute('data-ga'), want = all ? true : cb.checked;
      if (want !== !!loaded[k]) { changes[k] = want; expect[k] = !!loaded[k]; }
    });
    if (!Object.keys(changes).length) { msg('Nothing changed.'); return; }
    var offs = Object.keys(changes).filter(function (k) { return !changes[k]; });
    if (offs.length && !window.confirm('Turn ' + offs.length + ' section' + (offs.length === 1 ? '' : 's') + ' off for signed-out visitors? Their pages will ask guests to sign in, and their links leave the menus for guests.')) return;
    msg('Saving…');
    api({ changes: changes, expect: expect, reason: $('gaReason').value.trim() })
      .then(function (d) { paint(d); $('gaReason').value = ''; msg('Saved - ' + d.changed.length + ' change' + (d.changed.length === 1 ? '' : 's') + '.'); })
      .catch(function (e) { msg(e.message, true); if (e.code === 'E_STALE') load(); });
  }
  $('gaSave').addEventListener('click', function () { save(false); });
  $('gaAll').addEventListener('click', function () { save(true); });
  load();
})();
