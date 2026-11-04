// pad-bans.js - 1.99?? padppl: the pad owner page's "⛔ Banned & blocked from the website" list (padbans.js GET /api/rooms/:slug/bans) - ONE
// merged list of the website bridge blocks, whole-pad bans, bans on Camfrog logins with no PATV account and bans on frog names (shown as
// "🐸 label · identity hidden"), each with Lift. Bans are made from the person menu on the pad (pad-ban-sheet.js). textContent only.
(function () {
  'use strict';
  var box = document.getElementById('poBans');
  if (!box) return;
  var slug = box.getAttribute('data-slug'), list = document.getElementById('poBansList'), msg = document.getElementById('poBansMsg');
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) { return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function api(url, body) {
    return fetch(url, body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) }
      : { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  var SCOPE = { bridge: function () { return _t('js.pad.bans.scope_bridge', 'website bridge'); }, pad: function () { return _t('js.pad.bans.scope_pad', 'whole pad'); },
                site: function () { return _t('js.pad.bans.scope_site', 'whole site'); } };
  function utc(ms) { try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch (e) { return ''; } }
  function load() {
    api('/api/rooms/' + encodeURIComponent(slug) + '/bans').then(function (d) {
      list.textContent = '';
      if (!d.bans.length) { list.appendChild(el('li', 'ds-meta', _t('js.pad.bans.none', 'Nobody is banned or blocked from the website here.'))); return; }
      d.bans.forEach(function (b) {
        var li = el('li', 'po-bans-row');
        li.appendChild(el('b', null, b.who));
        var sc = String(b.scope || '').split(':')[0];
        li.appendChild(el('span', 'ds-meta', ' · ' + (SCOPE[sc] ? SCOPE[sc]() : sc) + ' · ' + (b.until ? _t('js.pad.bans.until', 'until {when}', { when: utc(b.until) }) : _t('js.pad.bans.perm', 'until lifted'))
          + (b.reason ? ' · ' + b.reason : '') + (b.by ? ' · ' + _t('js.pad.bans.by', 'by {who}', { who: b.by }) : '')));
        var lift = el('button', 'ds-btn ghost sm', _t('js.pad.bans.lift', 'Lift')); lift.type = 'button';
        lift.addEventListener('click', function () {
          lift.disabled = true;
          var body = b.entry ? { entry: b.entry } : { ref: { k: 'user', v: b.username }, scope: sc };
          api('/api/rooms/' + encodeURIComponent(slug) + '/unban', body).then(function () { msg.textContent = _t('js.pad.bans.lifted', 'Lifted.'); load(); })
            .catch(function (e) { lift.disabled = false; msg.textContent = e.message; });
        });
        li.appendChild(document.createTextNode(' ')); li.appendChild(lift);
        list.appendChild(li);
      });
    }).catch(function (e) { list.textContent = ''; list.appendChild(el('li', 'ds-meta', e.message)); });
  }
  load();
})();
