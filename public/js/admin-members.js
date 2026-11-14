// admin-members.js - 1.99anv: Users & Accounts → 👥 "All members" (members.js). One page of 50 accounts from GET /api/admin/members:
// the counts, filter chips (All / Website members / Chat-only / Banned / Deleted), a search box, sortable column headers (created,
// last seen, level, username - each click flips the direction), Prev / Next. After a change the view is kept in the address
// (?mf= &ms= &md= &mq= &mp= #members) so a reload keeps it. Text via textContent only; no email, IP or other contact detail is ever sent here.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var card = $('members');
  if (!card || !$('mmRows')) return;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-US'); };

  var METHOD = {
    password: ['🔑', 'Password'], google: ['G', 'Google'], apple: ['A', 'Apple'], telegram: ['✈️', 'Telegram'], plex: ['📼', 'Plex'],
    twitch: ['🟣', 'Twitch'], discord: ['💬', 'Discord'], camfrog: ['🐸', 'Camfrog (linked login: chat sign-in links)'],
  };
  var STATUS = {
    admin: ['Admin', 'admin'], staff: ['Staff', 'admin'], assistant: ['Assistant', ''], chat: ['Chat-only', ''], banned: ['Banned', 'bad'],
    deleted: ['Deleted', 'bad'], deleting: ['Deletion scheduled', 'bad'], archived: ['Archived (stale)', ''], invited: ['Invited', 'ok'],
  };
  var CHAT_SRC = { camfrog: "made by Pepe for a Camfrog login", twitch: 'made by the Twitch bot', discord: 'made by the Discord bot', bot: 'made by a chat bot' };
  var DEF_DIR = { created: 'desc', seen: 'desc', level: 'desc', username: 'asc' };

  // the address keeps the view (after the first change): /admin/users?mf=chat&ms=level&md=asc&mq=frog&mp=2#members
  var st = { filter: 'all', sort: 'created', dir: 'desc', q: '', page: 1 };
  function readUrl() {
    var p = new URLSearchParams(location.search || '');
    if (p.get('mf')) st.filter = p.get('mf');
    if (DEF_DIR[p.get('ms')]) st.sort = p.get('ms');
    st.dir = p.get('md') === 'asc' || p.get('md') === 'desc' ? p.get('md') : DEF_DIR[st.sort];
    st.q = (p.get('mq') || '').slice(0, 64);
    st.page = Math.max(1, parseInt(p.get('mp'), 10) || 1);
  }
  function writeUrl() {
    var p = new URLSearchParams(location.search || '');
    ['mf', 'ms', 'md', 'mq', 'mp'].forEach(function (k) { p.delete(k); });
    if (st.filter !== 'all') p.set('mf', st.filter);
    if (st.sort !== 'created') p.set('ms', st.sort);
    if (st.dir !== DEF_DIR[st.sort]) p.set('md', st.dir);
    if (st.q) p.set('mq', st.q);
    if (st.page > 1) p.set('mp', String(st.page));
    var qs = p.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + '#members'); } catch (e) { /* old browser */ }
  }

  function ago(ms) {
    if (!ms) return '';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 0) s = 0;
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 172800) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 60) return Math.round(s / 86400) + ' days ago';
    if (s < 86400 * 730) return Math.round(s / (86400 * 30.44)) + ' months ago';
    return (s / (86400 * 365.25)).toFixed(1) + ' years ago';
  }
  function abs(ms) { try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch (e) { return ''; } }
  function when(ms, none) {
    var td = el('td', 'mm-when');
    if (!ms) { td.appendChild(el('span', 'mm-mut', none)); return td; }
    var t = el('time', null, abs(ms).slice(0, 10)); t.setAttribute('datetime', new Date(ms).toISOString()); t.title = abs(ms);
    td.appendChild(t);
    td.appendChild(el('small', 'mm-mut', ago(ms)));
    return td;
  }

  var links = false, seq = 0;
  function row(r) {
    var tr = el('tr');
    if (r.gone) tr.className = 'mm-gone';
    var u = el('td', 'mm-user');
    if (links && !r.gone) {
      var a = el('a', null, r.username); a.href = '/admin/accounts?u=' + encodeURIComponent(r.username) + '#lookup'; a.title = 'Account security: sessions, deletion';
      u.appendChild(a);
      var pa = el('a', 'mm-prof', '↗'); pa.href = '/u/' + encodeURIComponent(r.username); pa.title = 'Profile'; pa.setAttribute('aria-label', 'Profile of ' + r.username);
      u.appendChild(pa);
    } else if (!r.gone) {
      var b = el('a', null, r.username); b.href = '/u/' + encodeURIComponent(r.username); b.title = 'Profile';
      u.appendChild(b);
    } else u.appendChild(el('span', null, r.username));
    tr.appendChild(u);
    tr.appendChild(el('td', 'mm-dn', r.displayname || ''));
    tr.appendChild(when(r.created, 'unknown'));
    // (review) not "never on the website": sign-ins are on record since sessions began (1.99wj) and page-view days for 120 days, so an
    // older member who hasn't been back since has no visit on record either
    var seenTd = when(r.seen, 'no visit recorded');
    if (!r.seen) seenTd.title = 'No website visit on record: sign-ins are recorded since 1.99wj and visit days are kept 120 days.';
    tr.appendChild(seenTd);
    tr.appendChild(el('td', 'num', String(r.level)));
    var m = el('td', 'mm-methods');
    if (!r.methods.length) m.appendChild(el('span', 'mm-mut', 'none'));
    r.methods.forEach(function (k) {
      var d = METHOD[k] || [k, k];
      var s = el('span', 'mm-ic', d[0] || d[1].charAt(0)); s.title = d[1]; s.setAttribute('role', 'img'); s.setAttribute('aria-label', d[1]);
      m.appendChild(s);
    });
    tr.appendChild(m);
    var inv = el('td', 'mm-inv');
    if (r.invited_by) { var ia = el('a', null, '@' + r.invited_by); ia.href = '/u/' + encodeURIComponent(r.invited_by); inv.appendChild(ia); }
    tr.appendChild(inv);
    var sc = el('td', 'mm-st');
    r.status.forEach(function (k) {
      var d = STATUS[k] || [k, ''];
      var p = el('span', 'adm-pill' + (d[1] ? ' ' + d[1] : ''), d[0]);
      if (k === 'chat' && r.chat_source) p.title = CHAT_SRC[r.chat_source] || '';
      sc.appendChild(p);
    });
    tr.appendChild(sc);
    return tr;
  }

  function paintCounts(c) {
    $('mmCounts').textContent = fmt(c.total) + ' accounts · ' + fmt(c.website) + ' website members · ' + fmt(c.chat) + ' chat-only · ' +
      fmt(c.banned) + ' banned · ' + fmt(c.deleted) + ' deleted · new: ' + fmt(c.new7) + ' in the last 7 days, ' + fmt(c.new30) + ' in 30 days';
    var n = { all: c.total, website: c.website, chat: c.chat, banned: c.banned, deleted: c.deleted };
    Array.prototype.forEach.call(card.querySelectorAll('[data-mm-filter]'), function (b) {
      var k = b.getAttribute('data-mm-filter');
      var s = b.querySelector('.mm-n'); if (s) s.textContent = fmt(n[k]);
    });
  }
  function paintHead() {
    Array.prototype.forEach.call(card.querySelectorAll('[data-mm-filter]'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mm-filter') === st.filter ? 'true' : 'false');
    });
    Array.prototype.forEach.call(card.querySelectorAll('th[data-mm-sort]'), function (th) {
      var k = th.getAttribute('data-mm-sort'), on = k === st.sort;
      th.setAttribute('aria-sort', on ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      var ar = th.querySelector('.mm-ar'); if (ar) ar.textContent = on ? (st.dir === 'asc' ? '▲' : '▼') : '';
    });
  }
  function load(changed) {
    var my = ++seq;
    paintHead();
    if (changed) writeUrl();
    $('mmMsg').textContent = 'Loading…';
    var qs = new URLSearchParams({ page: String(st.page), sort: st.sort, dir: st.dir, filter: st.filter });
    if (st.q) qs.set('q', st.q);
    fetch('/api/admin/members?' + qs.toString(), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
      .then(function (d) {
        if (my !== seq) return;            // a newer request is on its way
        links = !!d.account_links;
        st.page = d.page; st.filter = d.filter; st.sort = d.sort; st.dir = d.dir;
        paintHead();
        paintCounts(d.counts || {});
        var tb = $('mmRows'); tb.textContent = '';
        if (!d.rows.length) { var e = el('tr'); var td = el('td', 'empty', st.q ? 'Nobody matches "' + st.q + '".' : 'No accounts here.'); td.colSpan = 8; e.appendChild(td); tb.appendChild(e); }
        d.rows.forEach(function (r) { tb.appendChild(row(r)); });
        $('mmPage').textContent = 'Page ' + fmt(d.page) + ' of ' + fmt(d.pages) + ' · ' + fmt(d.total) + ' account' + (d.total === 1 ? '' : 's');
        $('mmPrev').disabled = d.page <= 1;
        $('mmNext').disabled = d.page >= d.pages;
        $('mmMsg').textContent = '';
      })
      .catch(function (e) { if (my === seq) $('mmMsg').textContent = e.message; });
  }

  Array.prototype.forEach.call(card.querySelectorAll('[data-mm-filter]'), function (b) {
    b.addEventListener('click', function () { st.filter = b.getAttribute('data-mm-filter'); st.page = 1; load(true); });
  });
  Array.prototype.forEach.call(card.querySelectorAll('th[data-mm-sort] button'), function (b) {
    b.addEventListener('click', function () {
      var k = b.parentNode.getAttribute('data-mm-sort');
      if (st.sort === k) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = k; st.dir = DEF_DIR[k]; }
      st.page = 1; load(true);
    });
  });
  $('mmPrev').addEventListener('click', function () { if (st.page > 1) { st.page--; load(true); } });
  $('mmNext').addEventListener('click', function () { st.page++; load(true); });
  var qBox = $('mmQ'), qT = null;
  qBox.addEventListener('input', function () {
    clearTimeout(qT);
    qT = setTimeout(function () { var v = qBox.value.trim().slice(0, 64); if (v === st.q) return; st.q = v; st.page = 1; load(true); }, 300);
  });
  $('mmForm').addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(qT); st.q = qBox.value.trim().slice(0, 64); st.page = 1; load(true); });

  readUrl();
  qBox.value = st.q;
  load();
})();
