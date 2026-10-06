// feed-safety.js — the report modal (posts, comments, users), the one-time Terms prompt and the admin-only
// details panel (1.99cc). Exposes window.patvSafety = { report, termsAsk, details }.
// Every write is a same-site JSON fetch with X-Requested-With: fetch. Text from the server is only ever
// put in the page with textContent (never innerHTML).
(function () {
  'use strict';
  if (window.patvSafety) return;

  function req(url, body, method) {
    return fetch(url, {
      method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) { var e = new Error(d.error || ('HTTP ' + r.status)); e.code = d.code; e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'cls') n.className = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  // ── styles (one place; the modal is used on the feed, post, room, profile and admin pages) ──
  var css = [
    '.sfm{border:1px solid #2c2c33;border-radius:14px;background:#17171b;color:#e6e6e6;padding:0;width:min(520px,calc(100vw - 24px));max-height:calc(100vh - 32px);font-family:Ubuntu,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '.sfm::backdrop{background:rgba(0,0,0,.6)}',
    '.sfm.wide{width:min(980px,calc(100vw - 24px))}',
    '.sfm-in{display:flex;flex-direction:column;max-height:calc(100vh - 34px)}',
    '.sfm-h{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #26262c}',
    '.sfm-h h2{margin:0;font-size:17px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sfm-x{background:none;border:0;color:#aaa;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px}',
    '.sfm-x:hover,.sfm-x:focus-visible{background:#26262c;color:#fff}',
    '.sfm-b{padding:12px 16px;overflow-y:auto;font-size:14.5px;line-height:1.5}',
    '.sfm-f{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:12px 16px;border-top:1px solid #26262c;flex-wrap:wrap}',
    '.sfm-f .err{flex:1;color:#ff8a80;font-size:13.5px;min-width:140px}',
    '.sfm-f .err:empty{display:none}',
    '.sfm-f .err.mut{color:#9a9a9a}',
    '.sfm .btn{border-radius:8px;border:1px solid #34343c;background:#222228;color:#ddd;padding:8px 14px;font:bold 14px Ubuntu,sans-serif;cursor:pointer}',
    '.sfm .btn:hover,.sfm .btn:focus-visible{background:#2c2c34;color:#fff}',
    '.sfm .btn.go{background:#4caf50;border-color:#4caf50;color:#fff}',
    '.sfm .btn.bad{background:#c62828;border-color:#c62828;color:#fff}',
    '.sfm .btn:disabled{opacity:.55;cursor:default}',
    '.sfm-rs{display:grid;gap:6px;margin:4px 0 10px;padding:0;border:0}',
    '.sfm-rs legend{font-weight:bold;margin-bottom:6px;padding:0}',
    '.sfm-r{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:start;padding:8px 10px;border:1px solid #2a2a30;border-radius:10px;cursor:pointer;background:#1b1b20}',
    '.sfm-r:hover{border-color:#3d3d46}',
    '.sfm-r input{margin:3px 0 0;accent-color:#4caf50}',
    '.sfm-r b{font-size:14.5px}',
    '.sfm-r small{grid-column:2;color:#9a9a9a;font-size:12.5px;line-height:1.4}',
    '.sfm-r.urgent b{color:#ff8a80}',
    '.sfm-r:has(input:checked){border-color:#4caf50;background:#1c2a1e}',
    '.sfm-r.urgent:has(input:checked){border-color:#e53935;background:#2a1a1a}',
    '.sfm label.nt{display:block;font-weight:bold;margin:6px 0 4px}',
    '.sfm textarea{width:100%;box-sizing:border-box;min-height:70px;background:#101013;color:#eee;border:1px solid #2f2f36;border-radius:8px;padding:8px;font:14px Ubuntu,sans-serif;resize:vertical}',
    '.sfm .mut{color:#9a9a9a;font-size:13px}',
    '.sfm .ok{display:flex;gap:12px;align-items:flex-start;padding:6px 0}',
    '.sfm .ok .ic{font-size:30px;line-height:1;flex:none}',
    '.sfm .ok p{margin:6px 0 0}',
    '.sfm .warn{background:#2a1a1a;border:1px solid #6d2a2a;color:#ffcdd2;border-radius:8px;padding:8px 10px;margin:8px 0;font-size:13.5px}',
    '.sfm a{color:#81c784}',
    // details panel
    '.sfd h3{margin:14px 0 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#ffd700}',
    '.sfd .who{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline}',
    '.sfd .who b{font-size:16px}',
    '.sfd .chip{display:inline-block;border:1px solid #33333b;border-radius:999px;padding:1px 8px;font-size:12px;color:#ccc;background:#1d1d22}',
    '.sfd .chip.y{border-color:#3CC47C;color:#c8f0d3}',
    '.sfd .chip.n{color:#888}',
    '.sfd .tw{overflow-x:auto;border:1px solid #26262c;border-radius:10px}',
    '.sfd table{border-collapse:collapse;width:100%;font-size:13px;min-width:900px}',
    '.sfd th,.sfd td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid #222;white-space:nowrap}',
    '.sfd th{color:#aaa;background:#141418;font-weight:bold}',
    '.sfd td.ua{white-space:normal;min-width:220px;max-width:300px;font-size:12px;color:#bbb;overflow-wrap:anywhere}',
    '.sfd td .mut{white-space:normal;max-width:160px}',
    '.sfd code{font-size:12px;background:#111;border:1px solid #2a2a2a;border-radius:4px;padding:0 4px}',
    '.sfd ul{margin:4px 0;padding-left:18px}',
    '.sfd .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
    '.sfd .box{border:1px solid #26262c;border-radius:10px;padding:8px 10px;background:#1a1a1f}',
    '.sfd .priv{font-size:12px;color:#e9dca8;background:#1c1a12;border:1px solid #4a4220;border-radius:8px;padding:6px 8px;margin-top:10px}',
    '@media (max-width:520px){.sfm-h{padding:12px}.sfm-b{padding:10px 12px}.sfm-f{padding:10px 12px}.sfm .btn{flex:1}.sfm-f .err{flex-basis:100%}}'
  ].join('\n');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ── the modal shell ──
  function modal(title, opts) {
    opts = opts || {};
    var d = el('dialog', { cls: 'sfm' + (opts.wide ? ' wide' : ''), 'aria-labelledby': 'sfmT' });
    var body = el('div', { cls: 'sfm-b' });
    var foot = el('div', { cls: 'sfm-f' });
    var close = function () { try { d.close(); } catch (e) { /* closed */ } };
    d.appendChild(el('div', { cls: 'sfm-in' }, [
      el('div', { cls: 'sfm-h' }, [el('h2', { id: 'sfmT', text: title }), el('button', { type: 'button', cls: 'sfm-x', 'aria-label': 'Close', text: '×', onclick: close })]),
      body, foot]));
    d.addEventListener('close', function () { d.remove(); if (opts.onclose) opts.onclose(); });
    d.addEventListener('click', function (ev) { if (ev.target === d) close(); });     // the backdrop
    document.body.appendChild(d);
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    return { d: d, body: body, foot: foot, close: close };
  }

  // ── report ──
  var menus = null;
  function reasons() {
    if (menus) return Promise.resolve(menus);
    return req('/api/feed/report-reasons').then(function (d) { menus = d; return d; });
  }
  /** target: {post, comment?} | {user: username}. */
  function report(target) {
    var isUser = !!target.user;
    var what = isUser ? 'user' : target.comment ? 'comment' : 'post';
    var m = modal(isUser ? 'Report @' + target.user : 'Report this ' + what);
    m.body.appendChild(el('p', { cls: 'mut', text: 'Loading…' }));
    reasons().then(function (R) {
      var list = isUser ? R.user : R.post;
      m.body.textContent = '';
      var form = el('form', { id: 'sfmForm', novalidate: 'novalidate' });
      var fs = el('fieldset', { cls: 'sfm-rs' }, [el('legend', { text: 'What\'s wrong with this ' + what + '?' })]);
      list.forEach(function (x, i) {
        var input = el('input', { type: 'radio', name: 'reason', value: x.key, id: 'sfr-' + x.key });
        if (i === 0) input.required = true;
        fs.appendChild(el('label', { cls: 'sfm-r' + (x.urgent ? ' urgent' : ''), 'for': 'sfr-' + x.key }, [input, el('b', { text: x.label }), el('small', { text: x.hint })]));
      });
      form.appendChild(fs);
      var warn = el('div', { cls: 'warn', hidden: 'hidden', text: 'This is hidden as soon as you send it and goes straight to the site admins. Don\'t download, screenshot or share it - that can be a crime in itself.' });
      form.appendChild(warn);
      form.appendChild(el('label', { cls: 'nt', 'for': 'sfmNote', text: 'Anything to add? (optional)' }));
      var note = el('textarea', { id: 'sfmNote', name: 'note', maxlength: '300', rows: '3', placeholder: 'Links, context, who it targets…' });
      form.appendChild(note);
      form.appendChild(el('p', { cls: 'mut', text: (isUser ? 'Site admins' : 'Site admins (and, for posts in a pad, that pad\'s owner - except child-safety, non-consensual imagery and copyright reports)') + ' will see your report. The person you report isn\'t told who reported them.' }));
      m.body.appendChild(form);
      fs.addEventListener('change', function () {
        var v = form.querySelector('input[name=reason]:checked');
        var u = v && list.some(function (x) { return x.key === v.value && x.urgent; });
        warn.hidden = !u;
      });
      var err = el('span', { cls: 'err', role: 'alert' });
      var send = el('button', { type: 'submit', cls: 'btn go', form: 'sfmForm', text: 'Send report' });
      m.foot.appendChild(err);
      m.foot.appendChild(el('button', { type: 'button', cls: 'btn', text: 'Cancel', onclick: m.close }));
      m.foot.appendChild(send);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var v = form.querySelector('input[name=reason]:checked');
        if (!v) { err.textContent = 'Pick a reason.'; return; }
        send.disabled = true; err.textContent = '';
        var url = isUser ? '/api/users/' + encodeURIComponent(target.user) + '/report' : '/api/feed/posts/' + encodeURIComponent(target.post) + '/report';
        var body = { reason: v.value, note: note.value.slice(0, 300) };
        if (target.comment) body.comment = target.comment;
        req(url, body).then(function (d) { done(m, d, what); }).catch(function (e) { err.textContent = e.message; send.disabled = false; });
      });
      var first = form.querySelector('input[name=reason]'); if (first) first.focus();
    }).catch(function (e) { m.body.textContent = ''; m.body.appendChild(el('p', { cls: 'err', text: e.message })); });
  }
  function done(m, d, what) {
    m.body.textContent = ''; m.foot.textContent = '';
    var lines = d.already ? ['You already reported this ' + what + ' - it\'s in the queue.']
      : d.urgent ? ['Thank you. It\'s been hidden and sent straight to the site admins as urgent.', 'If someone is in immediate danger, contact your local emergency services.']
      : ['Thanks - your report was sent.', 'We\'ll send you an inbox update when it\'s been reviewed.'];
    m.body.appendChild(el('div', { cls: 'ok', role: 'status' }, [el('span', { cls: 'ic', 'aria-hidden': 'true', text: d.urgent ? '🛡️' : '✅' }),
      el('div', null, lines.map(function (l, i) { return el(i ? 'p' : 'b', { cls: i ? 'mut' : '', text: l }); }))]));
    var ok = el('button', { type: 'button', cls: 'btn go', text: 'Done', onclick: m.close });
    m.foot.appendChild(ok); ok.focus();
  }

  // ── the one-time Terms prompt (a post or comment answered 428 {code: "terms"}) -> Promise<bool> ──
  function termsAsk() {
    return new Promise(function (resolve) {
      var agreed = false;
      var m = modal('Before you post', { onclose: function () { resolve(agreed); } });
      m.body.appendChild(el('p', null, ['PATV has ', el('a', { href: '/terms', target: '_blank', rel: 'noopener', text: 'Terms of Service' }), ' and a ',
        el('a', { href: '/privacy', target: '_blank', rel: 'noopener', text: 'Privacy Policy' }), '. Please read them - they cover what you can post, how reports and moderation work, and that PAT has no cash value.']));
      m.body.appendChild(el('p', { cls: 'mut', text: 'By posting you agree to the Terms and confirm you\'re 18 or older. We\'ll only ask again if they change.' }));
      m.foot.appendChild(el('button', { type: 'button', cls: 'btn', text: 'Not now', onclick: m.close }));
      var go = el('button', { type: 'button', cls: 'btn go', text: 'I agree - post it', onclick: function () { agreed = true; m.close(); } });
      m.foot.appendChild(go); go.focus();
    });
  }

  // ── admin details (site Admins only; the server checks and logs every view) ──
  function fmtDate(ms) { if (!ms) return '-'; var d = new Date(ms); return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  function age(days) { if (days == null) return 'unknown'; if (days < 1) return 'under a day'; if (days < 60) return days + ' day' + (days === 1 ? '' : 's'); if (days < 730) return Math.round(days / 30) + ' months'; return (days / 365).toFixed(1) + ' years'; }
  function linkedChips(L) {
    L = L || {};
    return ['camfrog', 'discord', 'twitch'].map(function (k) { return el('span', { cls: 'chip ' + (L[k] ? 'y' : 'n'), text: (L[k] ? '✓ ' : '✗ ') + k }); });
  }
  function details(target) {
    var m = modal('Details (admin)', { wide: true });
    m.body.classList.add('sfd');
    m.body.appendChild(el('p', { cls: 'mut', text: 'Loading… (this view is logged)' }));
    var qs = target.post ? 'post=' + encodeURIComponent(target.post) : target.comment ? 'comment=' + encodeURIComponent(target.comment) : 'user=' + encodeURIComponent(target.user);
    req('/api/feed/admin/details?' + qs).then(function (r) { renderDetails(m, r.details); })
      .catch(function (e) { m.body.textContent = ''; m.body.appendChild(el('p', { cls: 'err', text: e.message })); });
    m.foot.appendChild(el('span', { cls: 'err mut', text: 'Admin-only. Don\'t copy this anywhere else.' }));
    m.foot.appendChild(el('button', { type: 'button', cls: 'btn', text: 'Close', onclick: m.close }));
  }
  function renderDetails(m, D) {
    var b = m.body; b.textContent = '';
    var S = D.subject || {};
    var who = el('div', { cls: 'who' }, [el('b', { text: S.display || S.username || '?' }), el('span', { cls: 'mut', text: '@' + (S.username || '?') }),
      el('span', { cls: 'chip', text: 'account age ' + age(S.ageDays) }), el('span', { cls: 'chip', text: 'level ' + (S.level || 0) })]
      .concat(linkedChips(S.linked)).concat(S.archived ? [el('span', { cls: 'chip', text: 'archived' })] : []).concat(S.restricted ? [el('span', { cls: 'chip', text: 'restricted' })] : []));
    b.appendChild(who);
    if (S.username) b.appendChild(el('p', { cls: 'mut' }, ['Profile: ', el('a', { href: '/u/' + encodeURIComponent(S.username) + '/profile', target: '_blank', rel: 'noopener', text: '/u/' + S.username }),
      D.target && D.target.post ? ' · ' : '', D.target && D.target.post ? el('a', { href: '/feed/p/' + encodeURIComponent(D.target.post) + (D.target.kind === 'comment' ? '#c-' + encodeURIComponent(D.target.id) : ''), target: '_blank', rel: 'noopener', text: 'open the ' + D.target.kind }) : '']));

    b.appendChild(el('h3', { text: D.target && D.target.kind === 'user' ? 'Latest posting records' : 'When it was posted / edited' }));
    if (!D.records.length) b.appendChild(el('p', { cls: 'mut', text: 'No record (posted before 1.99cc, or older than a year).' }));
    else {
      var t = el('table'), th = el('tr');
      ['When', 'What', 'IP', 'Network', 'Browser', 'Language', 'Country', 'Account age', 'Linked', 'Device'].forEach(function (h) { th.appendChild(el('th', { text: h })); });
      t.appendChild(el('thead', null, [th]));
      var tb = el('tbody');
      D.records.forEach(function (r) {
        tb.appendChild(el('tr', null, [
          el('td', { text: fmtDate(r.at) }), el('td', { text: r.kind + ' ' + r.event + (r.bot ? ' (bot-generated: Pepe)' : '') }),
          el('td', null, [r.ip ? el('code', { text: r.ip }) : el('span', { cls: 'mut', text: r.rawPurged ? 'deleted (90 d)' : '-' }), r.via && r.via !== 'cf' && r.via !== 'bot' ?el('div', { cls: 'mut', text: 'via ' + r.via + ' (not Cloudflare - may be spoofed)' }) : null]),
          el('td', null, [r.ipKey ? el('code', { text: r.ipKey }) : '-']),
          el('td', { cls: 'ua', text: r.ua || (r.rawPurged ? 'deleted (90 d)' : '-') }),
          el('td', { text: r.lang || '-' }), el('td', { text: r.country || '-' }), el('td', { text: age(r.acctAgeDays) }),
          el('td', null, linkedChips(r.linked)), el('td', null, [r.deviceKey ? el('code', { text: r.deviceKey }) : '-'])]));
      });
      t.appendChild(tb);
      b.appendChild(el('div', { cls: 'tw' }, [t]));
    }

    var grid = el('div', { cls: 'grid' });
    var others = function (title, xs, emptyText) {
      var box = el('div', { cls: 'box' }, [el('h3', { text: title })]);
      if (!xs.length) box.appendChild(el('p', { cls: 'mut', text: emptyText }));
      else box.appendChild(el('ul', null, xs.map(function (x) {
        return el('li', null, [el('a', { href: '/u/' + encodeURIComponent(x.username) + '/profile', target: '_blank', rel: 'noopener', text: x.username }), ' · ' + x.count + ' post' + (x.count === 1 ? '' : 's') + '/comments · last ' + fmtDate(x.last)]);
      })));
      return box;
    };
    grid.appendChild(others('Other accounts, same network (' + D.windowDays + ' d)', D.sameIp || [], 'None seen.'));
    grid.appendChild(others('Other accounts, same browser (' + D.windowDays + ' d)', D.sameDevice || [], 'None seen.'));
    var H = D.history || {}, T = H.totals || {};
    var hist = el('div', { cls: 'box' }, [el('h3', { text: 'History' }), el('ul', null, [
      el('li', { text: T.posts + ' posts (' + T.postsRemoved + ' removed by admins), ' + T.comments + ' comments (' + T.commentsRemoved + ' removed by mods)' }),
      el('li', { text: 'Reports against them: ' + ((H.reportsAgainst || []).map(function (r) { return r.reason + ' ×' + r.n; }).join(', ') || 'none') }),
      el('li', { text: 'Reports they filed: ' + T.reportsFiled + (T.reportsFalse ? ' (' + T.reportsFalse + ' found in bad faith)' : '') }),
      el('li', { text: 'Feed bans: ' + ((H.bans || []).map(function (x) { return (x.room_id || 'whole feed') + (x.until ? ' until ' + fmtDate(x.until) : ' (forever)'); }).join(', ') || 'none') })])]);
    grid.appendChild(hist);
    b.appendChild(grid);
    var recent = el('div', { cls: 'box' }, [el('h3', { text: 'Recent posts & comments' })]);
    var items = (H.posts || []).map(function (p) { return { at: p.created, text: p.text, href: '/feed/p/' + p.id, tag: p.deleted ? (p.byAdmin ? 'removed' : 'deleted') : p.hidden ? 'hidden' : 'post' }; })
      .concat((H.comments || []).map(function (c) { return { at: c.created, text: c.text, href: '/feed/p/' + c.post + '#c-' + c.id, tag: c.deleted ? (c.byMod ? 'removed' : 'deleted') : 'comment' }; }))
      .sort(function (a, z) { return z.at - a.at; }).slice(0, 12);
    if (!items.length) recent.appendChild(el('p', { cls: 'mut', text: 'Nothing yet.' }));
    else recent.appendChild(el('ul', null, items.map(function (x) {
      return el('li', null, [el('span', { cls: 'chip', text: x.tag }), ' ', el('a', { href: x.href, target: '_blank', rel: 'noopener', text: (x.text || '(no text)').slice(0, 90) }), el('span', { cls: 'mut', text: ' · ' + fmtDate(x.at) })]);
    })));
    b.appendChild(recent);
    b.appendChild(el('p', { cls: 'priv', text: 'Raw IPs and browsers are deleted after ' + D.rawDays + ' days; network / device keys are salted hashes (shown shortened). Your view was written to the audit log.' }));
  }

  window.patvSafety = { report: report, termsAsk: termsAsk, details: details, req: req };

  // a "Report user" / data-safety button anywhere on the page
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-safety]');
    if (!b) return;
    ev.preventDefault();
    var k = b.getAttribute('data-safety');
    if (k === 'report-user') report({ user: b.getAttribute('data-user') });
    else if (k === 'details') details({ post: b.getAttribute('data-post') || undefined, comment: b.getAttribute('data-comment') || undefined, user: b.getAttribute('data-user-id') || undefined });
  });
})();
