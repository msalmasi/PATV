// launchpad-admin.js - the 🚀 Pad launchpad card on /admin/economy (launchpad.js on the server).
// GET /api/admin/launchpad: Pepe's launchpad state + settings, the review queue (graduations), the launch pads with
// their momentum, welcomes paid. Approve / reject a graduation (POST /api/admin/launchpad/grad), enroll / exclude a
// pad (POST /api/admin/launchpad/pad). All server text via textContent.
(function () {
  'use strict';
  var root = document.getElementById('lpAdmin');
  if (!root || !window.fetch) return;
  var fmt = function (n) { return n == null ? '-' : Math.round(Number(n) || 0).toLocaleString('en-US'); };
  var date = function (t) { return t ? new Date(Number(t)).toISOString().slice(0, 10) : '-'; };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }
  function table(label, head, rows) {
    var wrap = el('div', 'adm-tbl');
    var t = el('table');
    t.setAttribute('aria-label', label);
    var th = el('thead'), tr = el('tr');
    head.forEach(function (h) { tr.appendChild(el('th', h.num ? 'num' : '', h.t)); });
    th.appendChild(tr);
    t.appendChild(th);
    var tb = el('tbody');
    if (!rows.length) { var r = el('tr'); var c = el('td', 'empty', 'Nothing yet.'); c.colSpan = head.length; r.appendChild(c); tb.appendChild(r); }
    rows.forEach(function (cells) {
      var r = el('tr');
      cells.forEach(function (c, i) {
        var td = el('td', head[i] && head[i].num ? 'num' : '');
        if (c && c.nodeType) td.appendChild(c); else td.textContent = c == null ? '' : String(c);
        r.appendChild(td);
      });
      tb.appendChild(r);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }
  function act(g, action) {
    var reason = action === 'reject' ? window.prompt('Why is it rejected? (shown to staff; a rejected tier is never offered again unless you approve it later)') : '';
    if (action === 'reject' && reason === null) return;
    post('/api/admin/launchpad/grad', { id: g.id, action: action, reason: reason || '' }).then(function (d) {
      if (!d || !d.ok) window.alert((d && d.error) || 'Not saved.');
      load();
    });
  }
  function render(d) {
    while (root.firstChild) root.removeChild(root.firstChild);
    if (!d || !d.ok) { root.appendChild(el('p', 'adm-help', (d && d.error) || 'Couldn\'t read the launchpad.')); return; }
    var s = d.state, c = d.cfg || {};
    var kv = el('div', 'adm-kv');
    var add = function (k, v) { var x = el('div'); x.appendChild(el('b', null, k)); x.appendChild(el('span', null, v)); kv.appendChild(x); };
    add('Status', !d.on ? 'off (!econ launchpad on)' : d.live ? 'live' + (s && s.room_vaults ? '' : ' - grants / matches wait for room vaults') : 'on, not live (needs the E-2 treasury)');
    if (s) {
      add('Budget group (week ' + (s.week || '-') + ')', fmt(s.budget.left) + ' of ' + fmt(s.budget.cap) + ' PAT left · spendable now ' + fmt(s.spendable));
      add('Welcomes', fmt(d.welcomes.n) + ' paid (PAT ' + fmt(d.welcomes.total) + ') · room now ' + fmt(d.welcome_room));
    }
    add('Tiers', (c.tiers || []).map(function (t, i) { return 'T' + (i + 1) + ' ' + t[0] + ' regulars + ' + t[1] + ' days → ' + fmt(t[2]); }).join(' · '));
    add('Rules', 'window ' + c.window_days + 'd · launch ' + c.max_age_days + 'd · regular = ' + c.regular_days + '+ days · active day = ' + c.active_day_people +
        '+ people · account ' + c.min_account_days + 'd+ / level ' + c.min_level + '+ · review ' + (c.review ? 'on' : 'off'));
    add('Welcome · match · boost', fmt(c.welcome_amount) + ' (≤' + c.welcome_per_pad + '/pad, ' + c.welcome_min_age_hours + 'h+) · ' + c.match_ratio_pct + '% ≤ ' +
        fmt(c.match_cap) + ' for ' + c.match_days + 'd · ' + fmt(c.boost_credit_pat) + ' for ' + c.boost_days + 'd · keep ' + fmt(c.keep_balance) + ' · since ' + date(c.since));
    root.appendChild(kv);
    root.appendChild(el('h3', null, 'Review queue'));
    root.appendChild(table('Launchpad graduations', [{ t: 'Pad' }, { t: 'Tier' }, { t: 'PAT', num: true }, { t: 'Momentum' }, { t: 'State' }, { t: '' }],
      (d.grads || []).map(function (g) {
        var m = g.metrics || {};
        var btns = el('span');
        if (g.state === 'review' || g.state === 'rejected') {
          var a = el('button', null, 'Approve'); a.type = 'button'; a.addEventListener('click', function () { act(g, 'approve'); }); btns.appendChild(a);
        }
        if (g.state === 'review' || g.state === 'approved') {
          var r = el('button', null, 'Reject'); r.type = 'button'; r.addEventListener('click', function () { act(g, 'reject'); }); btns.appendChild(r);
        }
        var ex = m.excluded ? Object.keys(m.excluded).map(function (k) { return m.excluded[k] + ' ' + k; }).join(', ') : '';
        return ['p/' + (g.slug || g.room_id), g.tier, g.state === 'paid' ? g.paid_amount : g.amount,
                (m.regulars || 0) + ' regulars · ' + (m.active_days || 0) + ' days · ' + (m.chatters || 0) + ' chatters · ' + (m.posts || 0) + ' posts' + (ex ? ' · excluded: ' + ex : ''),
                g.state + (g.decided_by ? ' (' + g.decided_by + ')' : '') + (g.reason ? ': ' + g.reason : ''), btns];
      })));
    root.appendChild(el('h3', null, 'Launch pads'));
    root.appendChild(table('Launch pads', [{ t: 'Pad' }, { t: 'Owner' }, { t: 'Since' }, { t: 'Ends' }, { t: 'Regulars', num: true }, { t: 'Active days', num: true }, { t: 'Matched', num: true }],
      (d.pads || []).map(function (p) {
        return ['p/' + p.slug + (p.enrolled ? ' (enrolled)' : '') + ' · ' + p.platform, p.owner || '-', date(p.start), date(p.ends) + (p.open ? '' : ' (closed)'),
                p.regulars, p.active_days, p.matched];
      })));
  }
  function load() {
    fetch('/api/admin/launchpad', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(render).catch(function () { render(null); });
  }
  var form = document.getElementById('lpEnroll');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = new FormData(form);
      post('/api/admin/launchpad/pad', { room: f.get('room'), action: f.get('action'), note: f.get('note') }).then(function (d) {
        if (!d || !d.ok) window.alert((d && d.error) || 'Not saved.');
        else form.reset();
        load();
      });
    });
  }
  load();
})();
