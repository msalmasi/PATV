// pad-bans.js - 1.99ajn padppl: the pad owner page's "⛔ Banned & blocked from the website" list (padbans.js GET /api/rooms/:slug/bans) - ONE
// merged list of the website bridge blocks, whole-pad bans (one row with the bridge block made with them), bans on Camfrog logins with no
// PATV account and bans on frog names (shown as "🐸 label · identity hidden"), each with Lift. Staff also see the site-wide frog-name and
// login bans. Bans are made from the person menu on the pad (pad-ban-sheet.js); the old card's add-by-name form above still works and
// this list reloads when it changes (patv:bans-changed). textContent only.
// Review fixes: rows look like Settings → Blocked people (bordered, the button on the right - never a pill in the middle of a sentence);
// a named row's Lift names the account by its id ({k: 'acct', v: 'u:<id>'}), so a rename never breaks it or hits whoever took the name.
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
  var FEAT = { chat: 'chat', commands: 'commands', soundboard: 'soundboard', voice: 'voice', snapshots: 'snapshots', livecams: 'live cams', clips: 'clips' };
  function when(ms) {
    try { return window.PATVTime && window.PATVTime.format ? window.PATVTime.format(ms, 'datetime') : new Date(ms).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  if (!document.getElementById('poBansCss')) {
    var st = el('style'); st.id = 'poBansCss';
    st.textContent = '#poBansList{list-style:none;margin:0;padding:0;display:grid;gap:6px}' +
      '#poBansList .pb-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--ds-line,#262626);border-radius:10px;min-width:0}' +
      '#poBansList .pb-who{min-width:0;overflow-wrap:anywhere}#poBansList .pb-who small{display:block;color:var(--ds-text-muted,#9a9a9a);font-size:12px}' +
      '#poBansList .pb-row .ds-btn{flex:none}';
    document.head.appendChild(st);
  }
  function load() {
    api('/api/rooms/' + encodeURIComponent(slug) + '/bans').then(function (d) {
      list.textContent = '';
      if (!d.bans.length) { list.appendChild(el('li', 'ds-meta', _t('js.pad.bans.none', 'Nobody is banned or blocked from the website here.'))); return; }
      d.bans.forEach(function (b) {
        var li = el('li', 'pb-row'), who = el('span', 'pb-who');
        who.appendChild(el('b', null, b.who));
        var parts = String(b.scope || '').split(':'), sc = parts[0];
        var scText = (SCOPE[sc] ? SCOPE[sc]() : sc) + (parts[1] ? ' (' + (FEAT[parts[1]] || parts[1]) + ')' : '') + (b.site ? ' · ' + _t('js.pad.bans.sitewide', 'site-wide') : '');
        who.appendChild(el('small', null, scText + ' · ' + (b.until ? _t('js.pad.bans.until', 'until {when}', { when: when(b.until) }) : _t('js.pad.bans.perm', 'until lifted'))
          + (b.reason ? ' · ' + b.reason : '') + (b.by ? ' · ' + _t('js.pad.bans.by', 'by {who}', { who: b.by }) : '')));
        li.appendChild(who);
        var lift = el('button', 'ds-btn ghost sm', '↩️ ' + _t('js.pad.bans.lift', 'Lift')); lift.type = 'button';
        lift.addEventListener('click', function () {
          lift.disabled = true;
          var body = b.entry ? { entry: b.entry } : { ref: b.userId ? { k: 'acct', v: 'u:' + b.userId } : { k: 'user', v: b.username }, scope: sc, feature: parts[1] || null };
          api('/api/rooms/' + encodeURIComponent(slug) + '/unban', body).then(function () { msg.textContent = _t('js.pad.bans.lifted', 'Lifted.'); load(); })
            .catch(function (e) { lift.disabled = false; msg.textContent = e.message; });
        });
        li.appendChild(lift);
        list.appendChild(li);
      });
    }).catch(function (e) { list.textContent = ''; list.appendChild(el('li', 'ds-meta', e.message)); });
  }
  document.addEventListener('patv:bans-changed', function () { load(); });
  load();
})();
