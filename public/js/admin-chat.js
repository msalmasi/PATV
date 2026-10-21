// admin-chat.js - /admin/chat, the chat hub's break-glass form (adminchat.js, S1 V1; ADR 0007 D15). One change at a time:
// a same-origin POST (X-Requested-With: fetch) with the reason typed at the top of the page (asked for when it is empty).
// Turning OFF (the chat hub, a pad back to v1 chat) is one click. Turning ON (the chat hub, a pad to the hub) is a Pepe owner's
// and takes a confirm step: the server answers the first post with 409 "confirm" and what would happen (its preview), the
// page asks, and only a yes posts again with confirm: true. Messages go in with textContent only; the page reloads after a change.
(function () {
  'use strict';
  var _t = typeof window.__t === 'function' ? window.__t : function (k, d, v) {
    return String(d).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; });
  };
  function say(el, msg, bad) { if (el) { el.textContent = msg || ''; el.className = 'adm-msg' + (bad ? ' err' : msg ? ' ok' : ''); } }
  function msgNear(btn) { var box = btn && btn.parentNode; return box ? box.querySelector('.adm-msg') : null; }
  function reason(msg) {
    var input = document.getElementById('acReason');
    var r = input ? String(input.value || '').trim() : '';
    if (!r) r = String(window.prompt(_t('js.admchat.reason_prompt', 'Why? The reason goes in the admin audit log.', {})) || '').trim();
    if (!r) { say(msg, _t('js.admchat.reason_needed', 'Type a reason first.', {}), true); return null; }
    if (input && !input.value) input.value = r;
    return r;
  }
  function post(path, body, msg, done) {
    say(msg, _t('js.admchat.working', 'Saving…', {}));
    fetch(path, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false }; })
      .then(function (j) { done(j || { ok: false }); });
  }
  // a refusal in the reader's language: js.admchat.e.<code> when the page knows the code, else the server's own text
  var CODES = ['cross_site', 'auth', 'admin_only', 'owner_only', 'reason_required', 'bad_request', 'bad_backend', 'hub_read_s2',
               'no_pad', 'site_pads_only', 'chat_hub_needs', 'internal'];
  function refusal(j) {
    var plain = j.error || _t('js.admchat.failed', 'That did not work - try again.', {});
    if (CODES.indexOf(j.code) < 0) return plain;
    return _t('js.admchat.e.' + j.code, plain, { list: (j.missing || []).join(', ') });
  }
  function finish(msg) {
    return function (j) {
      if (!j.ok) return say(msg, refusal(j), true);
      say(msg, j.changed === false ? _t('js.admchat.unchanged', 'Already like that - nothing changed.', {}) : _t('js.admchat.saved', 'Saved.', {}));
      setTimeout(function () { location.reload(); }, 600);
    };
  }
  // the confirm step: post; on 409 "confirm" ask with the server's preview, then post again with confirm: true
  function withConfirm(path, body, msg, question) {
    post(path, body, msg, function (j) {
      if (j.ok || j.code !== 'confirm') return finish(msg)(j);
      say(msg, '');
      if (!window.confirm(question(j.preview || {}))) return;
      body.confirm = true;
      post(path, body, msg, finish(msg));
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button[data-hub-on], button[data-pad-backend]') : null;
    if (!b || b.disabled) return;
    var msg = msgNear(b);
    var why = reason(msg);
    if (!why) return;
    if (b.hasAttribute('data-hub-on')) {
      if (b.getAttribute('data-hub-on') !== '1') return post('/api/admin/chat/hub', { on: false, reason: why }, msg, finish(msg));
      return withConfirm('/api/admin/chat/hub', { on: true, reason: why }, msg, function (p) {
        var n = Number(p.n) || 0;
        return n ? _t('js.admchat.confirm_hub', 'Turn the chat hub ON? Members will get the hub chat on the {n} pad(s) on the hub: {pads}. Any admin can turn it off again in one click.', { n: n, pads: (p.pads || []).join(', ') })
          : _t('js.admchat.confirm_hub_none', 'Turn the chat hub ON? No pad is on the hub yet, so members see nothing until a pad moves there. Any admin can turn it off again in one click.', {});
      });
    }
    var to = b.getAttribute('data-pad-backend');
    if (to === 'v1') return post('/api/admin/chat/pad', { room_id: b.getAttribute('data-room') || '', backend: 'v1', reason: why }, msg, finish(msg));
    var sel = document.getElementById('acMovePad');
    var room = sel ? sel.value : '';
    if (!room) return say(msg, _t('js.admchat.pick_pad', 'Pick a pad first.', {}), true);
    withConfirm('/api/admin/chat/pad', { room_id: room, backend: 'hub', reason: why }, msg, function (p) {
      return p.chat_hub ? _t('js.admchat.confirm_pad_live', 'Move {name} to the chat hub? The chat hub is on, so the pad switches to the hub chat now. Any admin can move it back in one click.', { name: p.title || room })
        : _t('js.admchat.confirm_pad', 'Move {name} to the chat hub? The chat hub is off, so nothing shows until an owner turns it on. Any admin can move it back in one click.', { name: p.title || room });
    });
  });
})();
