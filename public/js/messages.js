// messages.js — the /messages page (1.99cp): conversation list + chat, live over /events?type=dm with a fallback poll.
// 1.99cu: + the pinned "🔔 Notices" item: selecting it (/messages/notices) shows the notices (inbox.js) in the right-hand
// pane - categories, mark read, and the per-category Camfrog PM switches live in the ⚙ dialog.
// 1.99cz: groups (✎ dialog: 1 person = DM, 2-9 = group; members dialog; system lines), pictures (chunked uploads to
// /api/messages/uploads, a tray, NSFW marks, thumbnails + a lightbox; the files are members-only), post cards, and
// messages from people you blocked shown collapsed.
// Server text goes in with textContent; the only innerHTML is a message's `html`, which the server built by escaping
// the text and adding safe links (messages.js render()). Notices, system lines and post cards are text only.
(function () {
  'use strict';
  var bootEl = document.getElementById('dmBoot');
  if (!bootEl) return;
  var B = JSON.parse(bootEl.textContent || '{}');
  var me = B.me || {};
  var $ = function (id) { return document.getElementById(id); };
  var root = $('dm'), listEl = $('dmList'), msgsEl = $('dmMsgs'), scrollEl = $('dmScroll'), text = $('dmText'), form = $('dmCompose');

  var S = {
    convs: B.conversations || [],
    open: null,            // conversation id
    draft: null,           // {username, display} for a conversation that doesn't exist yet
    head: null,            // header of the open conversation
    msgs: [],              // messages of the open conversation, oldest first
    more: false, loadingOld: false, readTimer: null, sending: false,
    prefs: B.prefs || {}, blocks: B.blocks || [],
    view: null,            // 'notices' while the 🔔 Notices pane is open
    nt: B.notices || {},   // the notices page shown: items, counts, page/pages, kind, unread, latest, kinds, pm
    ntLoading: 0,
    tray: [],              // pictures to send: {key, file, id, state, pct, thumb, nsfw, error}
    share: B.share || null,
    shown: {},             // message ids of collapsed (blocked) messages the viewer chose to show
  };
  var KIND = {};
  (S.nt.kinds || []).forEach(function (k) { KIND[k.key] = k; });
  function kindOf(k) { return KIND[k] || KIND.system || { key: 'system', icon: '🐸', label: 'Pepe' }; }

  // ── helpers ──
  function api(url, body, method) {
    return fetch(url, {
      method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) { var e = new Error(d.error || ('HTTP ' + r.status)); e.code = d.code; e.status = r.status; e.refused = d.refused; e.data = d; throw e; }
        return d;
      });
    });
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'cls') n.className = attrs[k];
      else if (k === 'style') n.setAttribute('style', attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function hue(s) { var h = 0; Array.from(String(s || '')).forEach(function (ch) { h = (h * 31 + ch.codePointAt(0)) >>> 0; }); return h % 360; }
  function initial(s) { var t = Array.from(String(s || '?').replace(/^[^\p{L}\p{N}]+/u, ''))[0] || '?'; return t.toUpperCase(); }
  // 1.99ex: a profile photo (server: userlook.js) sits over the monogram; one that fails to load removes itself
  function okPhoto(src) { return typeof src === 'string' && /^(https:\/\/[^\s"'<>()]+|\/[A-Za-z0-9\/_.\-]+)$/.test(src); }
  function photoOn(a, src) {
    if (!okPhoto(src)) return a;
    var im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.referrerPolicy = 'no-referrer';
    im.onerror = function () { im.remove(); a.classList.remove('av-ph'); }; im.src = src;
    a.classList.add('av-ph'); a.appendChild(im); return a;
  }
  function avatar(username, disp, extra, photo) { return photoOn(el('span', { cls: 'av' + (extra ? ' ' + extra : ''), style: '--h:' + hue(username), 'aria-hidden': 'true', text: initial(disp || username) }), photo); }
  // 1.99ex: a name in the person's equipped name style (cosmetics name colour / gradient)
  function nameNode(text, css) { var s = el('span', { text: text }); if (css) { s.className = 'cx-name'; s.setAttribute('style', css); } return s; }
  // a group's default picture: the initials of (up to) two members, on two halves
  function groupAvatar(members, extra) {
    var m = (members || []).slice(0, 2);
    var a = el('span', { cls: 'av av-grp' + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' });
    if (!m.length) { a.textContent = '👥'; return a; }
    m.forEach(function (p) { a.appendChild(photoOn(el('span', { style: '--h:' + hue(p.username), text: initial(p.display || p.username) }), p.avatar)); });
    if (m.length === 1) a.classList.add('one');
    return a;
  }
  function convAvatar(c, extra) { return c.kind === 'group' ? groupAvatar(c.members, extra) : avatar((c.with || {}).username, (c.with || {}).display, extra, (c.with || {}).avatar); }
  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(ms) {
    var d = new Date(ms), t = new Date(), y = new Date(Date.now() - 86400e3);
    if (dayKey(ms) === dayKey(t.getTime())) return 'Today';
    if (dayKey(ms) === dayKey(y.getTime())) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
  }
  function hm(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function shortWhen(ms) {
    if (!ms) return '';
    if (dayKey(ms) === dayKey(Date.now())) return hm(ms);
    var s = (Date.now() - ms) / 1000;
    if (s < 6 * 86400) return new Date(ms).toLocaleDateString([], { weekday: 'short' });
    return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function visible() { return document.visibilityState === 'visible'; }
  function isPhone() { return window.matchMedia('(max-width: 760px)').matches; }
  function setView(v) { root.setAttribute('data-view', v); }
  function isGroup() { return !!(S.head && S.head.kind === 'group'); }
  function openDlg(d) { if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); }
  function closeDlg(d) { if (d.close) d.close(); else d.removeAttribute('open'); }

  // ── nav badge (layout's 💬) + title ──
  function unreadSum() { return S.convs.reduce(function (n, c) { return n + (c.muted ? 0 : (c.unread || 0)); }, 0); }
  function setBadge(n) {
    var a = document.getElementById('navDm');
    if (a) {
      var b = a.querySelector('.nav-badge');
      if (n > 0) { if (!b) { b = el('span', { cls: 'nav-badge' }); a.appendChild(b); } b.textContent = n > 99 ? '99+' : String(n); a.classList.add('has'); }
      else { if (b) b.remove(); a.classList.remove('has'); }
      a.setAttribute('aria-label', 'Messages' + (n ? ', ' + n + ' unread' : ''));
    }
    setTitle();
  }
  function setTitle() {
    var n = S.view === 'notices' ? (S.nt.unread || 0) : unreadSum();
    var t = S.view === 'notices' ? 'Notices' : 'Messages';
    document.title = n ? t + ' (' + n + ')' : t;
  }
  // the layout's 🔔 and the pinned Notices item
  function setBell(n) {
    S.nt.unread = n;
    var a = document.getElementById('navBell');
    if (a) {
      var b = a.querySelector('.nav-badge');
      if (n > 0) { if (!b) { b = el('span', { cls: 'nav-badge' }); a.appendChild(b); } b.textContent = n > 99 ? '99+' : String(n); a.classList.add('has'); }
      else { if (b) b.remove(); a.classList.remove('has'); }
      a.setAttribute('aria-label', 'Notices' + (n ? ', ' + n + ' unread' : ''));
    }
    renderPin();
    setTitle();
  }
  function renderPin() {
    var a = $('dmNotices'), n = S.nt.unread || 0, L = S.nt.latest;
    a.classList.toggle('on', S.view === 'notices');
    a.classList.toggle('unread', n > 0);
    if (S.view === 'notices') a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    $('dmPinSn').textContent = L ? L.title : 'From Pepe and the site';
    $('dmPinTm').textContent = L ? shortWhen(L.created) : '';
    var bd = $('dmPinBd');
    bd.hidden = !n; bd.textContent = n > 99 ? '99+' : String(n); bd.setAttribute('aria-label', n + ' unread');
    var all = $('dmNtAll'); if (all) all.disabled = !n;
  }

  // ── the list ──
  function renderList() {
    S.convs.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    listEl.textContent = '';
    S.convs.forEach(function (c) {
      var w = c.with || {};
      var sn = el('span', { cls: 'sn' });
      if (c.last) {
        if (c.last.deleted) sn.appendChild(el('i', { text: 'message deleted' }));
        else if (c.last.system) sn.appendChild(el('i', { text: c.last.text }));
        else if (c.last.blocked) sn.appendChild(el('i', { text: 'message from someone you blocked' }));
        else sn.textContent = (c.last.mine ? 'You: ' : c.last.from ? c.last.from + ': ' : '') + c.last.text;
      }
      var nm = el('span', { cls: 'nm' }, [c.kind === 'group' ? (c.title || w.display || 'Group') : nameNode(w.display || '[gone]', w.nameCss)]);
      if (c.muted) nm.appendChild(el('span', { cls: 'mu', title: 'Muted', text: ' 🔕' }));
      var a = el('a', { cls: 'dm-it' + (c.id === S.open ? ' on' : '') + (c.unread ? ' unread' : '') + (c.blocked ? ' blocked' : '') + (c.muted ? ' muted' : ''), href: '/messages/c/' + c.id, 'data-c': c.id },
        [convAvatar(c), nm, el('span', { cls: 'tm', text: shortWhen(c.at) }), sn,
         c.unread ? el('span', { cls: 'bd', text: c.unread > 99 ? '99+' : String(c.unread), 'aria-label': c.unread + ' unread' }) : null]);
      if (c.id === S.open) a.setAttribute('aria-current', 'true');
      listEl.appendChild(el('li', null, [a]));
    });
    $('dmListEmpty').hidden = S.convs.length > 0;
    setBadge(unreadSum());
  }
  function convById(id) { for (var i = 0; i < S.convs.length; i++) if (S.convs[i].id === id) return S.convs[i]; return null; }
  function loadList() {
    return api('/api/messages/conversations').then(function (d) {
      S.convs = d.conversations || []; renderList();
      if (d.notices) {
        var before = S.nt.unread || 0, newer = (d.notices.latest && d.notices.latest.created) !== (S.nt.latest && S.nt.latest.created);
        S.nt.latest = d.notices.latest; setBell(d.notices.unread || 0);
        // a new notice arrived while the pane is open: refresh the page being looked at (quietly)
        if (S.view === 'notices' && (newer || (d.notices.unread || 0) > before)) loadNotices(S.nt.kind, S.nt.page, false, true);
      }
    }).catch(function () {});
  }

  // ── the chat ──
  function showChat(on) {
    if (on && S.view === 'notices') { S.view = null; $('dmNt').hidden = true; renderPin(); }
    $('dmNone').hidden = on || S.view === 'notices';
    $('dmHead').hidden = !on; scrollEl.hidden = !on; form.hidden = !on;
  }
  function renderHead() {
    var h = S.head, grp = isGroup(), w = h ? h.with : (S.draft || {});
    var av = $('dmHeadAv');
    av.textContent = ''; av.className = 'av av-l'; av.removeAttribute('style');
    if (grp) {
      var others = (h.members || []).filter(function (m) { return !m.you; });
      var g = groupAvatar(others, 'av-l'); av.className = g.className; while (g.firstChild) av.appendChild(g.firstChild); if (!others.length) av.textContent = '👥';
    } else { av.textContent = initial(w.display || w.username); av.style.setProperty('--h', hue(w.username)); photoOn(av, w.avatar); }
    var href = !grp && w.username ? '/u/' + encodeURIComponent(w.username) : '#';
    $('dmHeadName').textContent = '';
    $('dmHeadName').appendChild(grp ? document.createTextNode(h.title) : nameNode(w.display || '[gone]', w.nameCss));
    $('dmHeadName').href = href;
    $('dmMProfile').href = href;
    $('dmHeadHandle').textContent = grp ? (h.members || []).length + ' members' + (h.owner ? ' · you own it' : '') : (w.username ? '@' + w.username : '');
    $('dmHeadMuted').hidden = !(h && h.muted);
    var blk = $('dmMBlock');
    blk.textContent = h && h.youBlocked ? 'Unblock' : 'Block';
    blk.setAttribute('data-on', h && h.youBlocked ? '0' : '1');
    root.querySelectorAll('.dm-pop [data-for]').forEach(function (b) { b.hidden = b.getAttribute('data-for') === 'group' ? !grp : grp; });
    blk.hidden = grp || !w.username;
    var mute = $('dmMMute'); mute.hidden = !S.open; mute.textContent = h && h.muted ? 'Unmute (Camfrog alerts back on)' : 'Mute (no Camfrog alerts)';
    root.querySelectorAll('[data-dm="clear"], [data-dm="hide"]').forEach(function (b) { b.hidden = !S.open; });
    var can = h ? h.canSend : (S.draft && S.draft.canSend);
    var why = h ? h.refusal : (S.draft && S.draft.refusal);
    var pn = h ? h.pepe : (S.draft && S.draft.pepe);          // 1.99ik: talking to Pepe - his price / away note
    $('dmPepeNote').hidden = !(pn && pn.note);
    $('dmPepeNote').textContent = pn && pn.note ? pn.note : '';
    $('dmRefuse').hidden = !!can;
    $('dmRefuse').textContent = can ? '' : (why || "You can't send messages here.");
    form.classList.toggle('off', !can);
    text.placeholder = grp ? 'Message ' + h.title : 'Message @' + (w.username || '');
    var att = $('dmAttach');
    att.disabled = !me.pictures;
    att.title = me.pictures ? 'Add pictures (up to ' + (B.maxPics || 4) + ')' : (me.picturesWhy || "You can't send pictures yet.");
  }
  function nearBottom() { return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120; }
  function toBottom() { scrollEl.scrollTop = scrollEl.scrollHeight; }

  // pictures in a message: thumbnails (NSFW ones blurred until clicked), click = the lightbox
  function picsNode(m) {
    var P = m.images || [];
    if (!P.length) return null;
    var g = el('div', { cls: 'dm-pics n' + Math.min(P.length, 4) });
    P.forEach(function (p, i) {
      var img = el('img', { src: p.thumb, alt: 'Picture ' + (i + 1) + ' of ' + P.length, loading: 'lazy', decoding: 'async' });
      if (p.w && p.h) { img.width = p.w; img.height = p.h; }
      var b = el('button', { type: 'button', cls: 'dm-pic' + (p.nsfw ? ' nsfw' : ''), 'data-pic': String(i), 'aria-label': p.nsfw ? 'NSFW picture - click to show' : 'Open picture ' + (i + 1) }, [img]);
      if (p.nsfw) b.appendChild(el('span', { cls: 'gate', text: 'NSFW · click to show' }));
      g.appendChild(b);
    });
    return g;
  }
  // PATV post cards (dmembeds.js): text only; unavailable = no details at all
  function embedsNode(m) {
    var E = m.embeds || [];
    if (!E.length) return null;
    var box = el('div', { cls: 'dm-embeds' });
    E.forEach(function (e) {
      if (e.unavailable) { box.appendChild(el('div', { cls: 'dm-card gone', text: 'Post unavailable - it was removed or hidden.' })); return; }
      var meta = el('div', { cls: 'cm' }, [e.pad ? el('span', { cls: 'pad', text: e.pad.label || ('p/' + e.pad.slug) }) : null,
        e.author ? el('span', null, [nameNode('u/' + e.author.username, e.author.nameCss)]) : null,
        el('span', { text: (e.score || 0) + ' point' + (e.score === 1 ? '' : 's') + ' · ' + (e.comments || 0) + ' comment' + (e.comments === 1 ? '' : 's') })]);
      var tx = el('div', { cls: 'ct' }, [meta, el('div', { cls: 'tt' }, [e.nsfw ? el('span', { cls: 'tag', text: 'NSFW' }) : null, e.title || 'Post'])]);
      var th = e.thumb ? el('span', { cls: 'th' + (e.nsfw ? ' nsfw' : '') }, [el('img', { src: e.thumb, alt: '', loading: 'lazy' })]) : el('span', { cls: 'th none', 'aria-hidden': 'true', text: '📰' });
      box.appendChild(el('a', { cls: 'dm-card', href: e.href, 'data-nsfw': e.nsfw ? '1' : '' }, [th, tx]));
    });
    return box;
  }
  function msgNode(m) {
    var mine = m.from === me.username;
    var t = el('div', { cls: 'dm-t' });
    var collapsed = m.blocked && !S.shown[m.id] && !m.deleted;
    if (m.deleted) t.textContent = m.byAdmin ? 'message removed by an admin' : 'message deleted';
    else if (collapsed) t.append(el('i', { text: 'Message from someone you blocked. ' }), el('button', { type: 'button', cls: 'lnk', 'data-mact': 'show', text: 'Show' }));
    else if (m.html) t.innerHTML = m.html;             // server-escaped (see the top of this file)
    var acts = null;
    if (!m.deleted && m.id > 0) {
      acts = el('div', { cls: 'dm-acts' });
      if (mine) acts.appendChild(el('button', { type: 'button', cls: 'danger', 'data-mact': 'delete', title: 'Delete for everyone', 'aria-label': 'Delete message', text: '🗑' }));
      else acts.appendChild(el('button', { type: 'button', 'data-mact': 'report', title: 'Report to the site admins', 'aria-label': 'Report message', text: '⚑' }));
    }
    var kids = [el('time', { cls: 'mt', datetime: new Date(m.at).toISOString(), text: hm(m.at) })];
    if (m.html || m.deleted || collapsed) kids.push(t);
    if (!m.deleted && !collapsed) { kids.push(picsNode(m)); kids.push(embedsNode(m)); }
    kids.push(acts);
    return el('div', { cls: 'dm-m' + (m.deleted ? ' del' : '') + (collapsed ? ' blk' : '') + (m.id < 0 ? ' pending' : ''), 'data-id': String(m.id), tabindex: '-1' }, kids);
  }
  function renderMsgs() {
    msgsEl.textContent = '';
    var lastDay = null, g = null, prev = null;
    S.msgs.forEach(function (m) {
      var dk = dayKey(m.at);
      if (dk !== lastDay) {
        msgsEl.appendChild(el('div', { cls: 'dm-day', role: 'separator', text: dayLabel(m.at) }));
        lastDay = dk; g = null;
      }
      if (m.kind === 'system') {
        msgsEl.appendChild(el('div', { cls: 'dm-sys', 'data-id': String(m.id) }, [el('span', { text: m.system || '' }), el('time', { datetime: new Date(m.at).toISOString(), text: hm(m.at) })]));
        g = null; prev = null;
        return;
      }
      if (!g || !prev || prev.from !== m.from || m.at - prev.at > 7 * 60e3) {
        var mine = m.from === me.username;
        var body = el('div', { cls: 'dm-gb' }, [el('div', { cls: 'dm-gh' }, [m.blocked && !S.shown[m.id] ? el('b', { text: 'Blocked' }) : el('b', null, [nameNode(m.fromDisplay || m.from || '[gone]', m.fromCss)]),
          el('time', { datetime: new Date(m.at).toISOString(), title: new Date(m.at).toLocaleString(), text: hm(m.at) })])]);
        g = el('div', { cls: 'dm-g' + (mine ? ' mine' : '') }, [m.blocked && !S.shown[m.id] ? el('span', { cls: 'av av-blk', 'aria-hidden': 'true', text: '⊘' }) : avatar(m.from, m.fromDisplay, null, m.fromAvatar), body]);
        msgsEl.appendChild(g);
      }
      g.lastChild.appendChild(msgNode(m));
      prev = m;
    });
    var start = $('dmStart');
    var w = S.head ? S.head.with : (S.draft || {});
    start.hidden = S.more;
    start.textContent = '';
    if (!S.more) {
      if (isGroup()) start.append(el('b', { text: S.head.title }), 'The start of this group (for you).');
      else start.append(el('b', { text: w.display || '' }), 'This is the start of your conversation with @' + (w.username || '?') + '.');
    }
  }
  function upsertMsg(m) {
    for (var i = S.msgs.length - 1; i >= 0; i--) if (S.msgs[i].id === m.id) { S.msgs[i] = m; return false; }
    S.msgs.push(m);
    S.msgs.sort(function (a, b) { return (a.id < 0 ? 1e15 : a.id) - (b.id < 0 ? 1e15 : b.id); });
    return true;
  }

  function markRead(soon) {
    if (!S.open || !visible()) return;
    clearTimeout(S.readTimer);
    var id = S.open;
    S.readTimer = setTimeout(function () {
      var c = convById(id);
      if (c) { c.unread = 0; renderList(); }
      api('/api/messages/c/' + id + '/read', {}).then(function (d) { setBadge(Math.max(unreadSum(), 0)); if (typeof d.unread === 'number') setBadge(d.unread); }).catch(function () {});
    }, soon ? 0 : 400);
  }
  function useShare() {
    if (!S.share) return;
    if (!text.value.trim()) { text.value = S.share.url + ' '; autoGrow(); }
    S.share = null; $('dmShare').hidden = true;
    if (history.replaceState && /[?&]share=/.test(location.search)) history.replaceState(history.state, '', location.pathname);
  }

  function openConv(id, push) {
    S.open = id; S.draft = null; S.head = null; S.msgs = []; S.more = false; S.shown = {};
    showChat(true); setView('chat'); renderList();
    msgsEl.textContent = ''; $('dmStart').hidden = true; $('dmOlder').hidden = false;
    if (push) history.pushState({ c: id }, '', '/messages/c/' + id);
    return api('/api/messages/c/' + id + '?head=1').then(function (d) {
      if (S.open !== id) return;
      S.head = d.conversation; S.msgs = d.messages || []; S.more = !!d.more;
      $('dmOlder').hidden = true;
      renderHead(); renderMsgs(); toBottom();
      markRead(true);
      if (S.head.canSend) useShare();
      if (!isPhone()) text.focus();
    }).catch(function (e) {
      $('dmOlder').hidden = true;
      if (e.status === 404) { S.convs = S.convs.filter(function (c) { return c.id !== id; }); closeChat(true); }
      else showErr(e.message);
    });
  }
  function reloadHead() {
    if (!S.open) return Promise.resolve();
    var id = S.open;
    return api('/api/messages/c/' + id + '?head=1&limit=1').then(function (d) { if (S.open === id) { S.head = d.conversation; renderHead(); renderMsgs(); } }).catch(function (e) {
      if (e.status === 404 && S.open === id) closeChat(true);
    });
  }
  function openNew(username, push) {
    if (!username) return;
    return api('/api/messages/check?to=' + encodeURIComponent(username)).then(function (d) {
      if (d.conversation) return openConv(d.conversation, true);
      S.open = null; S.head = null; S.msgs = []; S.more = false;
      S.draft = { username: d.user.username, display: d.user.display, canSend: d.canSend, refusal: d.refusal, pepe: d.pepe || null };
      showChat(true); setView('chat'); renderList(); renderHead(); renderMsgs();
      if (push) history.pushState({ to: d.user.username }, '', '/messages?to=' + encodeURIComponent(d.user.username));
      if (d.canSend) { useShare(); text.focus(); }
    }).catch(function (e) {
      $('dmFindMsg').textContent = e.status === 404 ? 'No one called "' + username + '".' : e.message;
      if (isPhone()) setView('list');
    });
  }
  function closeChat(push) {
    S.open = null; S.draft = null; S.head = null; S.msgs = [];
    S.view = null; $('dmNt').hidden = true;
    showChat(false); setView('list'); renderList(); renderPin(); setTitle();
    if (push) history.pushState({}, '', '/messages');
  }

  // ── the 🔔 Notices pane ──
  function ntUrl(kind, page) {
    var q = [];
    if (kind) q.push('kind=' + encodeURIComponent(kind));
    if (page > 1) q.push('page=' + page);
    return '/messages/notices' + (q.length ? '?' + q.join('&') : '');
  }
  function openNotices(push, kind, page) {
    S.open = null; S.draft = null; S.head = null; S.msgs = [];
    showChat(false);
    S.view = 'notices';
    $('dmNone').hidden = true; $('dmNt').hidden = false;
    setView('chat'); renderList(); renderPin(); setTitle();
    kind = kind || null; page = page || 1;
    if (push) history.pushState({ nt: 1 }, '', ntUrl(kind, page));
    // the boot data already holds the page asked for: no round trip
    if (S.nt.items && (S.nt.kind || null) === kind && (S.nt.page || 1) === page && !S.ntStale) renderNotices();
    else loadNotices(kind, page, false);
    S.ntStale = true;          // after the first show, re-fetch when coming back to it
  }
  function loadNotices(kind, page, push, quiet) {
    var seq = ++S.ntLoading;
    if (!quiet) $('dmNtScroll').setAttribute('aria-busy', 'true');
    return api('/api/inbox/notices?' + (kind ? 'kind=' + encodeURIComponent(kind) + '&' : '') + 'page=' + (page || 1)).then(function (d) {
      if (seq !== S.ntLoading) return;
      var keep = { kinds: S.nt.kinds, pm: S.nt.pm };
      S.nt = d; S.nt.kinds = keep.kinds; S.nt.pm = keep.pm;
      if (push) history.pushState({ nt: 1 }, '', ntUrl(d.kind, d.page));
      renderNotices(); setBell(d.unread || 0);
      if (!quiet) $('dmNtScroll').scrollTop = 0;
    }).catch(function (e) { showNtMsg(e.message || "Couldn't load your notices."); })
      .then(function () { if (seq === S.ntLoading) $('dmNtScroll').removeAttribute('aria-busy'); });
  }
  function showNtMsg(s) { var m = $('dmNtMsg'); m.textContent = s || ''; m.hidden = !s; }
  function longWhen(ms) { return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  function renderNotices() {
    var N = S.nt, kind = N.kind || null;
    if (N.msg) { showNtMsg(N.msg); N.msg = null; }
    // category chips: All + the categories that have notices, with their unread counts
    var chips = $('dmNtChips'); chips.textContent = '';
    var counts = N.counts || [];
    if (counts.length) {
      var unreadOf = {}; counts.forEach(function (c) { unreadOf[c.kind] = c.unread || 0; });
      var mk = function (k, label) {
        var a = el('a', { cls: 'dm-chip' + ((k || null) === kind ? ' on' : ''), href: ntUrl(k, 1), 'data-kind': k || '' }, [label]);
        if (k && unreadOf[k]) a.appendChild(el('span', { cls: 'n', text: String(unreadOf[k]) }));
        if ((k || null) === kind) a.setAttribute('aria-current', 'true');
        return a;
      };
      chips.appendChild(mk(null, 'All'));
      (N.kinds || []).forEach(function (k) { if (unreadOf[k.key] !== undefined) chips.appendChild(mk(k.key, k.icon + ' ' + k.label)); });
    }
    $('dmNtSub').textContent = (N.unread ? N.unread + ' unread · ' : '') + 'From Pepe and the site';
    // the list
    var ul = $('dmNtList'); ul.textContent = '';
    (N.items || []).forEach(function (n) {
      var k = kindOf(n.kind);
      var tt = el('div', { cls: 'tt' });
      if (n.unread) tt.appendChild(el('span', { cls: 'vh', text: 'Unread: ' }));
      tt.appendChild(document.createTextNode(n.title));
      var acts = el('div', { cls: 'acts' }, [
        n.link ? el('a', { cls: 'open', href: '/inbox/open/' + encodeURIComponent(n.id), text: 'Open →' }) : null,
        n.unread ? el('button', { type: 'button', cls: 'mark', 'data-read': String(n.id), text: 'Mark read' }) : null]);
      ul.appendChild(el('li', { cls: 'dm-n' + (n.unread ? ' unread' : ''), 'data-id': String(n.id) }, [
        el('div', { cls: 'ic', 'aria-hidden': 'true', text: k.icon }),
        el('div', { cls: 'tx' }, [tt, n.body ? el('div', { cls: 'bdy', text: n.body }) : null,
          el('div', { cls: 'meta' }, [el('span', { cls: 'cat', text: k.label }),
            el('time', { datetime: new Date(n.created).toISOString(), text: longWhen(n.created) })])]),
        acts]));
    });
    // empty
    var em = $('dmNtEmpty'); em.textContent = '';
    em.hidden = (N.items || []).length > 0;
    if (em.hidden === false) {
      em.appendChild(el('div', { cls: 'big', 'aria-hidden': 'true', text: '📭' }));
      em.appendChild(el('p', null, [el('b', { text: kind ? 'Nothing here in ' + kindOf(kind).label + '.' : 'No notices yet.' })]));
      var p = el('p', { text: 'When Pepe executes a stake, a loan gets paid, you\'re picked to judge a wager, an order ships or someone tips you, it shows up here.' });
      if (!me.camfrog) {
        p.appendChild(document.createTextNode(' '));
        p.appendChild(el('a', { href: '/u/' + encodeURIComponent(me.username) + '/edit', text: 'Link your Camfrog name' }));
        p.appendChild(document.createTextNode(' to get Pepe\'s notices too.'));
      }
      em.appendChild(p);
    }
    // pager
    var pg = $('dmNtPager'); pg.textContent = '';
    pg.hidden = !(N.pages > 1);
    if (N.pages > 1) {
      var prev = el('button', { type: 'button', cls: 'dm-btn', 'data-page': String(N.page - 1), text: '← Newer' });
      var next = el('button', { type: 'button', cls: 'dm-btn', 'data-page': String(N.page + 1), text: 'Older →' });
      prev.disabled = N.page <= 1; next.disabled = N.page >= N.pages;
      pg.append(prev, el('span', { text: 'Page ' + N.page + ' of ' + N.pages + ' · ' + N.total + ' notices' }), next);
    }
    renderPin();
  }
  function noticeRead(id) {
    var body = id === 'all' ? { all: 1 } : { id: id };
    return api('/inbox/read', body).then(function (d) {
      (S.nt.items || []).forEach(function (n) { if (id === 'all' || n.id === id) n.unread = false; });
      (S.nt.counts || []).forEach(function (c) {
        if (id === 'all') c.unread = 0;
        else if (d.changed) { var it = (S.nt.items || []).filter(function (n) { return n.id === id; })[0]; if (it && it.kind === c.kind && c.unread) c.unread--; }
      });
      setBell(typeof d.unread === 'number' ? d.unread : 0);
      renderNotices();
    }).catch(function (e) { showNtMsg(e.message); });
  }
  $('dmNotices').addEventListener('click', function (e) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    e.preventDefault();
    openNotices(true, null, 1);
  });
  $('dmNtBack').addEventListener('click', function () { closeChat(true); });
  $('dmNtChips').addEventListener('click', function (e) {
    var a = e.target.closest('a[data-kind]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    e.preventDefault();
    showNtMsg('');
    loadNotices(a.getAttribute('data-kind') || null, 1, true);
  });
  $('dmNtPager').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-page]');
    if (b && !b.disabled) loadNotices(S.nt.kind, parseInt(b.getAttribute('data-page'), 10), true);
  });
  $('dmNtList').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-read]');
    if (b) { b.disabled = true; noticeRead(parseInt(b.getAttribute('data-read'), 10)); }
  });
  $('dmNtAll').addEventListener('click', function () { if (S.nt.unread) noticeRead('all'); });

  function loadOlder() {
    if (!S.open || !S.more || S.loadingOld || !S.msgs.length) return;
    S.loadingOld = true; $('dmOlder').hidden = false;
    var id = S.open, first = S.msgs[0].id;
    api('/api/messages/c/' + id + '?before=' + first).then(function (d) {
      if (S.open !== id) return;
      var h0 = scrollEl.scrollHeight, t0 = scrollEl.scrollTop;
      S.msgs = (d.messages || []).concat(S.msgs); S.more = !!d.more;
      renderMsgs();
      scrollEl.scrollTop = scrollEl.scrollHeight - h0 + t0;
    }).catch(function () {}).then(function () { S.loadingOld = false; $('dmOlder').hidden = true; });
  }
  scrollEl.addEventListener('scroll', function () { if (scrollEl.scrollTop < 80) loadOlder(); }, { passive: true });

  function fetchNewer() {
    if (!S.open) return Promise.resolve();
    var id = S.open, last = 0;
    S.msgs.forEach(function (m) { if (m.id > last) last = m.id; });
    return api('/api/messages/c/' + id + '?after=' + last + '&limit=100').then(function (d) {
      if (S.open !== id || !(d.messages || []).length) return;
      var stick = nearBottom();
      d.messages.forEach(upsertMsg);
      renderMsgs(); if (stick) toBottom();
      markRead();
    }).catch(function () {});
  }

  // ── pictures: the tray + chunked uploads (same protocol as the feed's) ──
  var trayKey = 0;
  function renderTray() {
    var ul = $('dmTray'); ul.textContent = '';
    ul.hidden = !S.tray.length;
    S.tray.forEach(function (p) {
      var th = el('span', { cls: 'th' + (p.nsfw ? ' nsfw' : '') });
      if (p.preview) th.appendChild(el('img', { src: p.preview, alt: '' }));
      var st = p.state === 'ready' ? '' : p.state === 'failed' ? (p.error || 'Failed') : p.state === 'processing' ? 'Processing…' : (p.pct || 0) + '%';
      ul.appendChild(el('li', { cls: 'dm-tp ' + p.state, 'data-key': String(p.key) }, [th,
        st ? el('span', { cls: 'st', text: st }) : null,
        el('label', { cls: 'nsfw-t', title: 'Blurred until clicked' }, [el('input', { type: 'checkbox', 'data-tnsfw': String(p.key) }), ' NSFW']),
        el('button', { type: 'button', cls: 'x', 'data-tx': String(p.key), 'aria-label': 'Remove picture', text: '✕' })]));
      if (p.nsfw) ul.lastChild.querySelector('input').checked = true;
    });
    updateSend();
  }
  function updateSend() {
    var busy = S.tray.some(function (p) { return p.state !== 'ready' && p.state !== 'failed'; });
    $('dmSend').disabled = S.sending || busy;
  }
  function upload(p) {
    var f = p.file;
    return api('/api/messages/uploads', { size: f.size }).then(function (d) {
      p.id = d.id; var size = d.chunk || 524288, off = 0;
      var next = function () {
        if (p.gone) return api('/api/messages/uploads/' + p.id + '/discard', {}).catch(function () {});
        if (off >= f.size) return api('/api/messages/uploads/' + p.id + '/finish', {}).then(poll);
        var part = f.slice(off, Math.min(f.size, off + size));
        return fetch('/api/messages/uploads/' + p.id + '?offset=' + off, { method: 'PUT', credentials: 'same-origin', body: part,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch' } }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status)); off = j.received; p.pct = Math.round(off * 100 / f.size); renderTray(); return next(); });
        });
      };
      return next();
    });
    function poll() {
      p.state = 'processing'; renderTray();
      return new Promise(function (res) { setTimeout(res, 700); }).then(function () {
        return api('/api/messages/uploads/' + p.id);
      }).then(function (d) {
        if (d.state === 'ready') { p.state = 'ready'; renderTray(); return; }
        if (d.state === 'failed') throw new Error(d.error || "That picture couldn't be processed.");
        return poll();
      });
    }
  }
  function addFiles(files) {
    var max = B.maxPics || 4;
    Array.prototype.slice.call(files || []).forEach(function (f) {
      if (S.tray.length >= max) { showErr('Up to ' + max + ' pictures per message.'); return; }
      var p = { key: ++trayKey, file: f, state: 'uploading', pct: 0, nsfw: false, preview: null };
      try { if (/^image\/(jpeg|png|gif|webp|avif)$/.test(f.type)) p.preview = URL.createObjectURL(f); } catch (e) { /* none */ }
      S.tray.push(p);
      upload(p).catch(function (e) { p.state = 'failed'; p.error = e.message; renderTray(); });
    });
    renderTray();
  }
  function clearTray(discard) {
    S.tray.forEach(function (p) {
      if (p.preview) { try { URL.revokeObjectURL(p.preview); } catch (e) { /* */ } }
      if (discard) { p.gone = true; if (p.id && p.state !== 'uploading') api('/api/messages/uploads/' + p.id + '/discard', {}).catch(function () {}); }
    });
    S.tray = []; renderTray();
  }
  $('dmAttach').addEventListener('click', function () { if (me.pictures) $('dmFile').click(); else showErr(me.picturesWhy || "You can't send pictures yet."); });
  $('dmFile').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  $('dmTray').addEventListener('click', function (e) {
    var x = e.target.closest('[data-tx]');
    if (!x) return;
    var k = parseInt(x.getAttribute('data-tx'), 10);
    S.tray = S.tray.filter(function (p) {
      if (p.key !== k) return true;
      p.gone = true;
      if (p.id && p.state !== 'uploading') api('/api/messages/uploads/' + p.id + '/discard', {}).catch(function () {});
      if (p.preview) { try { URL.revokeObjectURL(p.preview); } catch (er) { /* */ } }
      return false;
    });
    renderTray();
  });
  $('dmTray').addEventListener('change', function (e) {
    var c = e.target.closest('[data-tnsfw]');
    if (!c) return;
    var k = parseInt(c.getAttribute('data-tnsfw'), 10);
    S.tray.forEach(function (p) { if (p.key === k) p.nsfw = c.checked; });
    renderTray();
  });
  // paste / drop pictures into the chat
  text.addEventListener('paste', function (e) {
    var files = (e.clipboardData && e.clipboardData.files) || [];
    if (files.length && me.pictures) { e.preventDefault(); addFiles(files); }
  });
  form.addEventListener('dragover', function (e) { if (me.pictures && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); form.classList.add('drop'); } });
  form.addEventListener('dragleave', function () { form.classList.remove('drop'); });
  form.addEventListener('drop', function (e) { form.classList.remove('drop'); if (me.pictures && e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

  // ── sending ──
  function showErr(s) { $('dmErr').textContent = s || ''; }
  function autoGrow() { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 180) + 'px'; }
  text.addEventListener('input', function () { autoGrow(); showErr(''); });
  text.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
  });
  form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
  var tmpId = -1;
  function send() {
    var body = text.value.replace(/\s+$/, '');
    var pics = S.tray.filter(function (p) { return p.state === 'ready'; });
    if ((!body.trim() && !pics.length) || S.sending) return;
    if (S.tray.some(function (p) { return p.state !== 'ready' && p.state !== 'failed'; })) { showErr('Wait for the pictures to finish uploading.'); return; }
    if (body.length > (B.maxLen || 2000)) { showErr('Messages can be up to ' + B.maxLen + ' characters.'); return; }
    var payload = S.open ? { conversation: S.open, body: body } : S.draft ? { to: S.draft.username, body: body } : null;
    if (!payload) return;
    if (pics.length) { payload.pictures = pics.map(function (p) { return p.id; }); payload.nsfw = pics.filter(function (p) { return p.nsfw; }).map(function (p) { return p.id; }); }
    S.sending = true; updateSend();
    // shown at once, greyed until the server has it
    var temp = { id: tmpId--, from: me.username, fromDisplay: me.display, fromAvatar: me.avatar || null, fromCss: me.nameCss || '', at: Date.now(), html: '', text: body, images: [] };
    temp.html = body.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }).replace(/\n/g, '<br>');
    if (pics.length && !body) temp.html = '<i>sending ' + pics.length + ' picture' + (pics.length === 1 ? '' : 's') + '…</i>';
    S.msgs.push(temp); renderMsgs(); toBottom();
    var keepTray = S.tray.slice();
    text.value = ''; autoGrow();
    S.tray = S.tray.filter(function (p) { return p.state !== 'ready' && p.state !== 'failed'; }); renderTray();
    api('/api/messages/send', payload).then(function (d) {
      keepTray.forEach(function (p) { if (p.preview) { try { URL.revokeObjectURL(p.preview); } catch (e) { /* */ } } });
      S.msgs = S.msgs.filter(function (m) { return m.id !== temp.id; });
      var fresh = !S.open;
      if (fresh) { S.open = d.conversation.id; S.draft = null; history.replaceState({ c: S.open }, '', '/messages/c/' + S.open); }
      upsertMsg(d.message);
      bumpConv(d.conversation.id, d.conversation, d.message, true);
      if (fresh) return api('/api/messages/c/' + S.open + '?head=1&after=' + d.message.id).then(function (x) { S.head = x.conversation; renderHead(); renderMsgs(); toBottom(); });
      renderMsgs(); toBottom();
    }).catch(function (e) {
      S.msgs = S.msgs.filter(function (m) { return m.id !== temp.id; });
      renderMsgs();
      if (!text.value) { text.value = body; autoGrow(); }
      if (pics.length && !S.tray.length) { S.tray = keepTray; renderTray(); }
      showErr(e.message);
      if (e.status === 403 && e.code !== 'members' && (S.head || S.draft)) { if (S.head) { S.head.canSend = false; S.head.refusal = e.message; } else { S.draft.canSend = false; S.draft.refusal = e.message; } renderHead(); }
    }).then(function () { S.sending = false; updateSend(); });
  }
  function lastText(m) {
    if (m.kind === 'system') return m.system || '';
    var t = (m.text || '').replace(/\s+/g, ' ').slice(0, 90);
    if (!t && (m.images || []).length) t = m.images.length === 1 ? '📷 Photo' : '📷 ' + m.images.length + ' photos';
    return t;
  }
  function bumpConv(id, head, m, mine) {
    var c = convById(id);
    if (!c) { c = { id: id, kind: (head && head.kind) || 'dm', with: (head && head.with) || {}, unread: 0 }; S.convs.unshift(c); }
    if (head && head.kind === 'group') { c.kind = 'group'; c.title = head.title; c.with = head.with; if (!c.members) loadList(); }
    else if (head && head.with && head.with.username) c.with = head.with;
    c.at = m.at; c.lastId = m.id;
    c.last = { mine: !!mine, text: lastText(m), deleted: !!m.deleted, system: m.kind === 'system', blocked: !!m.blocked,
               from: c.kind === 'group' && !mine && m.kind !== 'system' ? m.fromDisplay : null };
    renderList();
    return c;
  }

  // ── live: SSE + a fallback poll ──
  var es = null, lastPoll = Date.now();
  function onEvent(ev) {
    if (!ev || !ev.t) return;
    if (ev.t === 'msg') {
      var m = ev.m, mine = m.from === me.username && m.kind !== 'system';
      var c = bumpConv(ev.c, ev.conv, m, mine);
      var counts = !mine && m.kind !== 'system' && !m.blocked;
      if (ev.c === S.open) {
        var stick = nearBottom() || mine;
        if (upsertMsg(m)) { renderMsgs(); if (stick) toBottom(); }
        if (m.kind === 'system') reloadHead();
        if (counts) { if (visible()) markRead(); else { c.unread = (c.unread || 0) + 1; renderList(); } }
      } else if (counts) { c.unread = (c.unread || 0) + 1; renderList(); }
    } else if (ev.t === 'del') {
      if (ev.c === S.open) S.msgs.forEach(function (m) { if (m.id === ev.id) { m.deleted = true; m.html = ''; m.text = ''; m.images = []; m.embeds = []; } });
      if (ev.c === S.open) renderMsgs();
      loadList();
    } else if (ev.t === 'read') {
      var r = convById(ev.c);
      if (r && (!r.lastId || ev.upTo >= r.lastId)) { r.unread = 0; renderList(); }
      if (typeof ev.unread === 'number') setBadge(ev.unread);
    } else if (ev.t === 'gone') {
      S.convs = S.convs.filter(function (x) { return x.id !== ev.c; });
      if (ev.c === S.open) closeChat(true); else renderList();
    } else if (ev.t === 'cleared') {
      if (ev.c === S.open) { S.msgs = []; S.more = false; renderMsgs(); }
      loadList();
    } else if (ev.t === 'conv') {
      loadList();
      if (ev.c === S.open) reloadHead();
    }
  }
  function connect() {
    if (!window.EventSource) return;
    try { es = new EventSource('/events?type=dm'); } catch (e) { es = null; return; }
    es.onmessage = function (e) { lastPoll = Date.now(); try { onEvent(JSON.parse(e.data)); } catch (x) { /* ignore */ } };
    es.onopen = function () { loadList(); fetchNewer(); };      // catch up on anything missed while disconnected
  }
  connect();
  setInterval(function () {
    var live = es && es.readyState === 1;
    if (live && Date.now() - lastPoll < 90e3) return;            // the stream is up: a slow safety poll only
    lastPoll = Date.now();
    loadList(); fetchNewer();
  }, 15e3);
  document.addEventListener('visibilitychange', function () {
    if (!visible()) return;
    var c = S.open && convById(S.open);
    if (c && c.unread) markRead(true);
  });

  // ── the lightbox ──
  var lb = $('dmLightbox'), LB = { list: [], i: 0 };
  function lbShow() {
    var p = LB.list[LB.i];
    if (!p) return;
    $('dmLbImg').src = p.full; $('dmLbImg').alt = 'Picture ' + (LB.i + 1) + ' of ' + LB.list.length;
    $('dmLbN').textContent = LB.list.length > 1 ? (LB.i + 1) + ' / ' + LB.list.length : '';
    $('dmLbPrev').hidden = $('dmLbNext').hidden = LB.list.length < 2;
  }
  function openLightbox(list, i) { LB.list = list; LB.i = i; lbShow(); openDlg(lb); }
  $('dmLbClose').addEventListener('click', function () { closeDlg(lb); });
  $('dmLbPrev').addEventListener('click', function () { LB.i = (LB.i + LB.list.length - 1) % LB.list.length; lbShow(); });
  $('dmLbNext').addEventListener('click', function () { LB.i = (LB.i + 1) % LB.list.length; lbShow(); });
  lb.addEventListener('click', function (e) { if (e.target === lb) closeDlg(lb); });
  lb.addEventListener('keydown', function (e) { if (e.key === 'ArrowLeft') $('dmLbPrev').click(); else if (e.key === 'ArrowRight') $('dmLbNext').click(); });
  lb.addEventListener('close', function () { $('dmLbImg').removeAttribute('src'); });

  // ── clicks ──
  listEl.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-c]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    e.preventDefault();
    openConv(a.getAttribute('data-c'), true);
  });
  $('dmBack').addEventListener('click', function () { closeChat(true); });
  window.addEventListener('popstate', route);
  $('dmHeadName').addEventListener('click', function (e) { if (isGroup()) { e.preventDefault(); openMembers(); } });
  msgsEl.addEventListener('click', function (e) {
    var pic = e.target.closest('[data-pic]');
    var row = e.target.closest('.dm-m');
    if (pic && row) {
      if (pic.classList.contains('nsfw')) { pic.classList.remove('nsfw'); var gt = pic.querySelector('.gate'); if (gt) gt.remove(); pic.setAttribute('aria-label', 'Open picture'); return; }
      var mm = S.msgs.filter(function (x) { return String(x.id) === row.getAttribute('data-id'); })[0];
      if (mm) openLightbox(mm.images || [], parseInt(pic.getAttribute('data-pic'), 10) || 0);
      return;
    }
    var card = e.target.closest('.dm-card[data-nsfw="1"] .th.nsfw');
    if (card) { e.preventDefault(); card.classList.remove('nsfw'); return; }
    var b = e.target.closest('[data-mact]');
    if (!b) { if (row && isPhone()) { msgsEl.querySelectorAll('.dm-m.act').forEach(function (x) { if (x !== row) x.classList.remove('act'); }); row.classList.toggle('act'); } return; }
    var id = parseInt(row.getAttribute('data-id'), 10);
    var act = b.getAttribute('data-mact');
    if (act === 'show') { S.shown[id] = true; renderMsgs(); return; }
    if (act === 'delete') {
      if (!window.confirm('Delete this message for everyone? It will show as "message deleted" (pictures included).')) return;
      api('/api/messages/m/' + id + '/delete', {}).then(function () { onEvent({ t: 'del', c: S.open, id: id }); }).catch(function (x) { showErr(x.message); });
    } else if (act === 'report') openReport(id);
  });
  root.querySelector('.dm-pop').addEventListener('click', function (e) {
    var b = e.target.closest('[data-dm]');
    if (!b) return;
    $('dmMenu').removeAttribute('open');
    var act = b.getAttribute('data-dm');
    var w = S.head ? S.head.with : (S.draft || {});
    var name = isGroup() ? S.head.title : '@' + w.username;
    if (act === 'clear' && S.open) {
      if (!window.confirm('Clear this conversation\'s history for you? ' + (isGroup() ? 'Everyone else keeps theirs.' : '@' + w.username + ' keeps their copy.'))) return;
      api('/api/messages/c/' + S.open + '/clear', {}).then(function () { S.msgs = []; S.more = false; renderMsgs(); loadList(); }).catch(function (x) { showErr(x.message); });
    } else if (act === 'hide' && S.open) {
      if (!window.confirm('Delete this conversation for you? It disappears from your list and its history is cleared for you. A new message in ' + name + ' brings it back.')) return;
      var id = S.open;
      api('/api/messages/c/' + id + '/clear', { hide: true }).then(function () { S.convs = S.convs.filter(function (c) { return c.id !== id; }); closeChat(true); }).catch(function (x) { showErr(x.message); });
    } else if (act === 'block' && w.username) {
      var on = b.getAttribute('data-on') === '1';
      if (on && !window.confirm('Block @' + w.username + '? Neither of you can message the other, and their messages in groups are collapsed for you. They aren\'t told.')) return;
      api('/api/messages/block', { username: w.username, on: on }).then(function () {
        return S.open ? openConv(S.open, false) : openNew(w.username, false);
      }).then(function () { return refreshPrefs(); }).then(loadList).catch(function (x) { showErr(x.message); });
    } else if (act === 'mute' && S.open) {
      var muted = !(S.head && S.head.muted);
      api('/api/messages/c/' + S.open + '/mute', { on: muted }).then(function () { if (S.head) S.head.muted = muted; var c = convById(S.open); if (c) c.muted = muted; renderHead(); renderList(); }).catch(function (x) { showErr(x.message); });
    } else if (act === 'members') openMembers();
    else if (act === 'rename' && isGroup()) {
      var t = window.prompt('Rename the group (everyone sees the new name):', S.head.title);
      if (t === null || !t.trim()) return;
      api('/api/messages/c/' + S.open + '/rename', { title: t.trim().slice(0, B.titleMax || 60) }).then(reloadHead).then(loadList).catch(function (x) { showErr(x.message); });
    } else if (act === 'leave' && isGroup()) {
      if (!window.confirm('Leave ' + S.head.title + '? You stop getting its messages; someone in it can add you again.' + (S.head.owner ? ' You own it - the longest-standing member becomes the owner.' : ''))) return;
      var lid = S.open;
      api('/api/messages/c/' + lid + '/leave', {}).then(function () { S.convs = S.convs.filter(function (c) { return c.id !== lid; }); closeChat(true); }).catch(function (x) { showErr(x.message); });
    }
  });
  document.addEventListener('click', function (e) { var m = $('dmMenu'); if (m.open && !m.contains(e.target)) m.removeAttribute('open'); });
  $('dmShareX').addEventListener('click', function () { S.share = null; $('dmShare').hidden = true; });

  // ── ✎ new conversation / group ──
  var newDlg = $('dmNewDlg'), N = { people: [] };   // [{username, display, ok, why}]
  function renderPeople() {
    var ul = $('dmNewPeople'); ul.textContent = '';
    N.people.forEach(function (p) {
      ul.appendChild(el('li', { cls: p.ok ? 'ok' : p.ok === false ? 'no' : 'wait' }, [avatar(p.username, p.display, 'av-s'),
        el('span', { cls: 'pn' }, [el('b', { text: p.display || p.username }), el('small', { text: p.ok === false ? p.why : p.ok ? '@' + p.username : 'checking…' })]),
        el('button', { type: 'button', 'data-unpick': p.username, 'aria-label': 'Remove ' + p.username, text: '✕' })]));
    });
    var good = N.people.filter(function (p) { return p.ok; }).length, bad = N.people.some(function (p) { return p.ok !== true; });
    var grp = N.people.length >= 2;
    $('dmNewTitleL').hidden = !grp;
    $('dmNewT').textContent = grp ? 'New group' : 'New conversation';
    var go = $('dmNewGo');
    go.textContent = grp ? 'Create group (' + (good + 1) + ')' : 'Message';
    go.disabled = !good || bad || N.people.length > (B.groupMax || 10) - 1;
    $('dmNewMsg').textContent = N.people.length > (B.groupMax || 10) - 1 ? 'A group can have up to ' + (B.groupMax || 10) + ' people, you included.' : bad && N.people.some(function (p) { return p.ok === false; }) ? 'Remove the people who can\'t be added.' : '';
  }
  function pick(name) {
    name = String(name || '').trim().replace(/^@/, '');
    if (!name) return;
    if (name.toLowerCase() === String(me.username).toLowerCase()) { $('dmNewMsg').textContent = "You're in it already."; return; }
    if (N.people.some(function (p) { return p.username.toLowerCase() === name.toLowerCase(); })) return;
    var p = { username: name, display: name, ok: null };
    N.people.push(p); renderPeople();
    api('/api/messages/check?to=' + encodeURIComponent(name)).then(function (d) {
      p.username = d.user.username; p.display = d.user.display; p.ok = !!d.canSend; p.why = d.refusal; p.conversation = d.conversation;
    }).catch(function (e) { p.ok = false; p.why = e.status === 404 ? 'No one by that name.' : e.message; }).then(renderPeople);
  }
  function openNewDlg() {
    N.people = []; $('dmNewIn').value = ''; $('dmNewTitle').value = ''; $('dmNewMsg').textContent = ''; $('dmFindMsg').textContent = '';
    renderPeople(); openDlg(newDlg); $('dmNewIn').focus();
  }
  $('dmNewBtn').addEventListener('click', openNewDlg);
  $('dmNewClose').addEventListener('click', function () { closeDlg(newDlg); });
  $('dmNewAdd').addEventListener('click', function () { pick($('dmNewIn').value); $('dmNewIn').value = ''; $('dmNewIn').focus(); });
  $('dmNewIn').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if ($('dmNewIn').value.trim()) { pick($('dmNewIn').value); $('dmNewIn').value = ''; } else if (!$('dmNewGo').disabled) $('dmNewGo').click(); }
  });
  $('dmNewPeople').addEventListener('click', function (e) {
    var b = e.target.closest('[data-unpick]');
    if (!b) return;
    var u = b.getAttribute('data-unpick');
    N.people = N.people.filter(function (p) { return p.username !== u; }); renderPeople();
  });
  $('dmNewForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var ok = N.people.filter(function (p) { return p.ok; });
    if (!ok.length) return;
    if (N.people.length === 1) { closeDlg(newDlg); openNew(ok[0].username, true); return; }
    $('dmNewGo').disabled = true;
    api('/api/messages/groups', { title: $('dmNewTitle').value.trim(), members: ok.map(function (p) { return p.username; }) }).then(function (d) {
      closeDlg(newDlg); loadList(); openConv(d.conversation.id, true);
    }).catch(function (x) {
      (x.refused || []).forEach(function (r) { N.people.forEach(function (p) { if (p.username.toLowerCase() === String(r.username).toLowerCase()) { p.ok = false; p.why = r.error; } }); });
      renderPeople(); $('dmNewMsg').textContent = x.message;
    });
  });

  // ── the members dialog (groups) ──
  var memDlg = $('dmMembersDlg');
  function renderMembers() {
    var h = S.head || {};
    $('dmMemT').textContent = (h.title || 'Group') + ' · ' + (h.members || []).length + ' members';
    var ul = $('dmMemList'); ul.textContent = '';
    (h.members || []).forEach(function (m) {
      var acts = el('span', { cls: 'pa' });
      if (!m.you && m.username) {
        acts.appendChild(el('a', { href: '/u/' + encodeURIComponent(m.username), text: 'Profile' }));
        acts.appendChild(el('button', { type: 'button', 'data-mblock': m.username, 'data-on': m.blocked ? '0' : '1', text: m.blocked ? 'Unblock' : 'Block' }));
        if (h.owner) acts.appendChild(el('button', { type: 'button', cls: 'danger', 'data-mremove': m.username, text: 'Remove' }));
      }
      ul.appendChild(el('li', { cls: 'ok' }, [avatar(m.username, m.display, 'av-s', m.avatar),
        el('span', { cls: 'pn' }, [el('b', { text: (m.display || m.username || '[gone]') + (m.you ? ' (you)' : '') }),
          el('small', { text: (m.username ? '@' + m.username : '') + (m.role === 'owner' ? ' · owner' : '') + (m.blocked ? ' · blocked by you' : '') })]), acts]));
    });
    var full = (h.members || []).length >= (h.max || B.groupMax || 10);
    $('dmMemIn').disabled = $('dmMemAdd').disabled = full;
    $('dmMemHint').textContent = full ? 'The group is full (' + (h.max || 10) + ' people).' : 'Anyone in the group can add people. They see messages from when they were added. Only the owner can remove people.';
  }
  function openMembers() { if (!isGroup()) return; $('dmMemResults').textContent = ''; $('dmMemMsg').textContent = ''; renderMembers(); openDlg(memDlg); }
  $('dmMemClose').addEventListener('click', function () { closeDlg(memDlg); });
  function addMember() {
    var v = $('dmMemIn').value.trim().replace(/^@/, '');
    if (!v || !S.open) return;
    var names = v.split(/[\s,]+/).filter(Boolean);
    $('dmMemAdd').disabled = true;
    api('/api/messages/c/' + S.open + '/members', { usernames: names }).then(function (d) {
      var ul = $('dmMemResults'); ul.textContent = '';
      (d.added || []).forEach(function (a) { ul.appendChild(el('li', { cls: 'ok' }, [el('span', { cls: 'pn' }, [el('b', { text: a.display }), el('small', { text: 'added' })])])); });
      (d.refused || []).forEach(function (r) { ul.appendChild(el('li', { cls: 'no' }, [el('span', { cls: 'pn' }, [el('b', { text: r.display || r.username }), el('small', { text: r.error })])])); });
      $('dmMemIn').value = '';
      return reloadHead().then(renderMembers);
    }).catch(function (x) { $('dmMemMsg').textContent = x.message; }).then(function () { $('dmMemAdd').disabled = false; });
  }
  $('dmMemAdd').addEventListener('click', addMember);
  $('dmMemIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addMember(); } });
  $('dmMemList').addEventListener('click', function (e) {
    var rm = e.target.closest('[data-mremove]'), bl = e.target.closest('[data-mblock]');
    if (rm) {
      var u = rm.getAttribute('data-mremove');
      if (!window.confirm('Remove @' + u + ' from ' + S.head.title + '?')) return;
      api('/api/messages/c/' + S.open + '/remove', { username: u }).then(reloadHead).then(renderMembers).catch(function (x) { $('dmMemMsg').textContent = x.message; });
    } else if (bl) {
      var who = bl.getAttribute('data-mblock'), on = bl.getAttribute('data-on') === '1';
      if (on && !window.confirm('Block @' + who + '? Their messages here are collapsed for you, they can\'t message you or add you to groups, and they aren\'t told.')) return;
      api('/api/messages/block', { username: who, on: on }).then(refreshPrefs).then(function () { return openConv(S.open, false); }).then(renderMembers).catch(function (x) { $('dmMemMsg').textContent = x.message; });
    }
  });

  // ── report dialog ──
  var repDlg = $('dmReport'), repId = null;
  (B.reasons || []).forEach(function (r, i) {
    var lab = el('label', null, [el('input', { type: 'radio', name: 'reason', value: r.key }), ' ' + r.label, r.hint ? el('small', { text: r.hint }) : null]);
    if (i === 0) lab.querySelector('input').checked = true;
    $('dmReasons').appendChild(lab);
  });
  function openReport(id) {
    repId = id; $('dmRepMsg').textContent = '';
    $('dmRepForm').reset();
    var first = $('dmReasons').querySelector('input'); if (first) first.checked = true;
    openDlg(repDlg);
  }
  $('dmRepClose').addEventListener('click', function () { repDlg.close(); });
  $('dmRepForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, r = f.querySelector('input[name=reason]:checked');
    api('/api/messages/m/' + repId + '/report', { reason: r ? r.value : 'other', note: f.note.value }).then(function (d) {
      $('dmRepMsg').textContent = d.already ? 'You already reported this one.' : 'Reported - thank you. An admin will look at it.';
      $('dmRepMsg').style.color = '#a5d6a7';
      setTimeout(function () { repDlg.close(); }, 1400);
    }).catch(function (x) { $('dmRepMsg').style.color = ''; $('dmRepMsg').textContent = x.message; });
  });

  // ── settings dialog ──
  var setDlg = $('dmSettings'), setForm = $('dmSetForm');
  function fillSettings() {
    var P = S.prefs || {};
    setForm.querySelectorAll('input[name=who]').forEach(function (r) { r.checked = r.value === (P.who || 'everyone'); });
    setForm.alerts.checked = P.alerts !== false;
    setForm.nopreview.checked = P.preview === false;
    var linked = !!me.camfrog;
    setForm.alerts.disabled = !linked; setForm.nopreview.disabled = !linked || !setForm.alerts.checked;
    $('dmSetCf').textContent = linked ? 'At most one alert per conversation every 10 minutes, and only in a Camfrog room where you are. Never sent while you\'re reading it here. Mute a conversation (⋯) to stop its alerts.'
                                      : 'Link your Camfrog name first (type !verify in a Camfrog room with Pepe) to get alerts there.';
    // notices: one Camfrog-PM switch per category (direct messages are the "Camfrog alerts" switch above)
    var np = $('dmNtPrefs'); np.textContent = '';
    var PM = S.nt.pm || {};
    (S.nt.kinds || []).forEach(function (k) {
      if (k.key === 'dm' || k.key === 'mention') return;     // 1.99ii: mention alerts are 🔔-only (never a Camfrog PM)
      var cb = el('input', { type: 'checkbox', name: 'pm_' + k.key, 'data-pm': k.key });
      cb.checked = !PM[k.key] || PM[k.key].pm !== false;
      np.appendChild(el('label', null, [cb, ' ' + k.icon + ' ' + k.label]));
    });
    var ul = $('dmBlocks'); ul.textContent = '';
    if (!S.blocks.length) ul.appendChild(el('li', { cls: 'mut', text: 'Nobody.' }));
    S.blocks.forEach(function (b) {
      ul.appendChild(el('li', null, [el('span', { text: (b.display || b.username) + ' (@' + b.username + ')' }), el('button', { type: 'button', 'data-unblock': b.username, text: 'Unblock' })]));
    });
  }
  function refreshPrefs() { return api('/api/messages/prefs').then(function (d) { S.prefs = d.prefs; S.blocks = d.blocks || []; if (setDlg.open) fillSettings(); }).catch(function () {}); }
  setForm.alerts.addEventListener('change', function () { setForm.nopreview.disabled = !setForm.alerts.checked; });
  $('dmGearBtn').addEventListener('click', function () { fillSettings(); $('dmSetMsg').textContent = ''; openDlg(setDlg); });
  $('dmSetClose').addEventListener('click', function () { setDlg.close(); });
  $('dmBlocks').addEventListener('click', function (e) {
    var b = e.target.closest('[data-unblock]');
    if (!b) return;
    api('/api/messages/block', { username: b.getAttribute('data-unblock'), on: false }).then(refreshPrefs).then(function () { fillSettings(); if (S.open) openConv(S.open, false); loadList(); })
      .catch(function (x) { $('dmSetMsg').textContent = x.message; });
  });
  setForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var who = (setForm.querySelector('input[name=who]:checked') || {}).value || 'everyone';
    var body = { who: who };
    if (me.camfrog) { body.alerts = setForm.alerts.checked; body.preview = !setForm.nopreview.checked; }
    var pm = {};
    setForm.querySelectorAll('input[data-pm]').forEach(function (c) { pm[c.getAttribute('data-pm')] = c.checked; });
    api('/api/messages/prefs', body).then(function (d) {
      S.prefs = d.prefs;
      return api('/api/inbox/prefs', { pm: pm });
    }).then(function (d) {
      S.nt.pm = d.prefs; $('dmSetMsg').style.color = '#a5d6a7'; $('dmSetMsg').textContent = 'Saved ✔';
      setTimeout(function () { setDlg.close(); }, 700);
    }).catch(function (x) { $('dmSetMsg').style.color = ''; $('dmSetMsg').textContent = x.message; });
  });

  // ── routing ──
  function route() {
    var m = location.pathname.match(/^\/messages\/c\/([a-f0-9]{16})$/);
    var qs = new URLSearchParams(location.search), to = qs.get('to');
    if (/^\/messages\/notices\/?$/.test(location.pathname)) openNotices(false, qs.get('kind') || null, parseInt(qs.get('page'), 10) || 1);
    else if (m) openConv(m[1], false);
    else if (to) openNew(to, false);
    else closeChat(false);
  }
  renderList();
  if (S.share) $('dmShare').hidden = false;
  if (B.view === 'notices') openNotices(false, S.nt.kind || null, S.nt.page || 1);
  else if (B.open) openConv(B.open, false);
  else if (B.to) openNew(B.to, false);
  else { showChat(false); setView('list'); renderPin(); }
})();
