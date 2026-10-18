// webpush.js — 1.99acd: the 🔔 Browser notifications part of the 💬 Messages ⚙ dialog (views/messages.ejs #push, webpush.js on the
// server, QW-1). Per browser: "Turn on" asks the browser's permission (only ever from that click), registers /sw.js, subscribes
// with the site's VAPID key and saves the subscription with the kinds ticked; the kind boxes save on change; "Turn off" /
// "Turn off everywhere"; "Send a test". Saves on its own (the dialog's Save button keeps saving the other settings).
// data-push-off (not offered right now, but browsers of yours are still saved): only "Turn off everywhere". Errors are shown
// by the server's code in this page's language, and say what failed (turning on, a test, turning off, saving).
// Also window.PATVPush.clear(tag): close this browser's notifications with that tag (public/js/messages.js, when a
// conversation is opened: "dm:<id>"). Text goes in with textContent only.
(function () {
  'use strict';
  var _t = function (k, d, v) {
    if (typeof window.__t === 'function') return window.__t(k, d, v);
    var s = d && typeof d === 'object' ? (v && Number(v.count) === 1 && d.one != null ? d.one : d.other) : d;
    return String(s).replace(/\{!?(\w+)\}/g, function (m, n) { return v && v[n] != null ? String(v[n]) : m; });
  };
  var hasSW = 'serviceWorker' in navigator;

  function clear(tag) {
    if (!hasSW || !tag) return;
    navigator.serviceWorker.getRegistration('/').then(function (r) {
      if (!r || !r.getNotifications) return null;
      return r.getNotifications({ tag: String(tag) }).then(function (list) { list.forEach(function (n) { n.close(); }); });
    }).catch(function () {});
  }
  window.PATVPush = { clear: clear };
  var opened = /^\/messages\/c\/([A-Za-z0-9]{1,64})$/.exec(location.pathname);
  if (opened) clear('dm:' + opened[1]);          // the conversation this page opened with (messages.js ran first)

  var fs = document.querySelector('[data-push]');
  if (!fs) return;
  var KEY = fs.getAttribute('data-key') || '';
  var KINDS = (fs.getAttribute('data-kinds') || '').split(',').filter(Boolean);
  var box = fs.querySelector('.dm-push'), acts = fs.querySelector('.dm-push-acts'), st = fs.querySelector('.dm-push-st');
  var OTHERS = { one: 'Also on in {count} other browser.', other: 'Also on in {count} other browsers.' };
  // the server's answer codes -> this page's language (the server's own error text is English only, so it's never shown)
  var ERR = {
    E_ENDPOINT: ['js.push.err.endpoint', "This browser's push service isn't supported."],
    E_KEYS: ['js.push.err.keys', "This browser sent keys that can't be used."],
    E_KINDS: ['js.push.err.kinds', 'Pick at least one kind of notification.'],
    E_RATE: ['js.push.err.rate', 'Too many tries - wait a minute.'],
    E_NODEVICE: ['js.push.err.nodevice', "Notifications aren't on in this browser."],
    E_OFF: ['js.push.err.off', 'Browser notifications are switched off on PATV right now.'],
    E_SESSION: ['js.push.err.session', 'Sign in again, then try again.']
  };
  // what failed, when the code doesn't say more: turning on, a test, turning off, saving the kinds
  var FAILED = {
    on: ['js.push.failed', "Couldn't turn notifications on - try again."],
    test: ['js.push.test_failed', "Couldn't send a test - try again."],
    off: ['js.push.off_failed', "Couldn't turn notifications off - try again."],
    save: ['js.push.save_failed', "Couldn't save that - try again."]
  };
  function errText(e, ctx) {
    if (e && e.code === 'E_RATE' && ctx === 'test') return _t('js.push.err.test_rate', "That's enough tests for now - try again in a few minutes.");
    var m = (e && e.code && ERR[e.code]) || FAILED[ctx] || FAILED.on;
    return _t(m[0], m[1]);
  }

  function say(text) { if (st) st.textContent = text || ''; }
  function api(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                         body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || !d.ok) { var e = new Error(d.error || 'error'); e.status = r.status; e.code = d.code; throw e; }
          return d;
        });
      });
  }
  function unb64u(s) {
    var b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var raw = atob(b), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function sameKey(s) {
    try {
      var k = s && s.options && s.options.applicationServerKey;
      if (!k) return true;
      var a = new Uint8Array(k), b = unb64u(KEY);
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    } catch (e) { return true; }
  }

  // not offered right now (switched off, out of the audience) but browsers of yours are still saved: only "Turn off everywhere"
  if (fs.hasAttribute('data-push-off')) {
    if (!acts) return;
    var offAll = document.createElement('button');
    offAll.type = 'button';
    offAll.textContent = _t('js.push.off_all', 'Turn off everywhere');
    offAll.addEventListener('click', function () {
      offAll.disabled = true;
      api('/api/push/unsubscribe', { all: true }).then(function () {
        if (!hasSW) return null;                       // and this browser's own subscription, if it has one
        return navigator.serviceWorker.getRegistration('/').then(function (r) { return r && r.pushManager ? r.pushManager.getSubscription() : null; })
          .then(function (s) { return s ? s.unsubscribe() : null; }).catch(function () { return null; });
      }).then(function () {
        acts.textContent = '';
        say(_t('js.push.off_done', 'Turned off in all your browsers.'));
      }, function (e) { offAll.disabled = false; say(errText(e, 'off')); });
    });
    acts.appendChild(offAll);
    return;
  }

  var supported = hasSW && 'PushManager' in window && 'Notification' in window && window.isSecureContext !== false;
  if (!supported) {
    var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    say(ios && !navigator.standalone
      ? _t('js.push.ios', "On iPhone and iPad, website notifications need the site on your Home Screen, which PATV doesn't support yet.")
      : _t('js.push.unsupported', "This browser can't get notifications from websites."));
    return;
  }

  var reg = null, sub = null, mine = null, others = 0, busy = false, tmr = null;
  var checks = box ? Array.prototype.slice.call(box.querySelectorAll('input[data-kind]')) : [];
  function picked() { return checks.filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-kind'); }); }
  function setPicked(list) { checks.forEach(function (c) { c.checked = list.indexOf(c.getAttribute('data-kind')) >= 0; }); }
  function isOn() { return !!(sub && mine && mine.known); }
  function button(text, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.disabled = busy;
    b.addEventListener('click', fn);
    return b;
  }
  function render(msg) {
    var denied = Notification.permission === 'denied';
    if (box) box.hidden = denied;
    acts.textContent = '';
    if (denied && !isOn()) {
      say(_t('js.push.denied', "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."));
      if (others) acts.appendChild(button(_t('js.push.off_all', 'Turn off everywhere'), function () { disable(true); }));
      return;
    }
    if (isOn()) {
      acts.appendChild(button(_t('js.push.disable', 'Turn off for this browser'), function () { disable(false); }));
      acts.appendChild(button(_t('js.push.test', 'Send a test'), test));
    } else {
      var on = button(_t('js.push.enable', 'Turn on for this browser'), enable);
      on.className = 'pri';
      acts.appendChild(on);
    }
    if (others || isOn()) acts.appendChild(button(_t('js.push.off_all', 'Turn off everywhere'), function () { disable(true); }));
    var line = isOn() ? _t('js.push.on', 'On for this browser.') : _t('js.push.off', 'Off for this browser.');
    if (others) line += ' ' + _t('js.push.others', OTHERS, { count: others });
    say(msg ? msg + ' ' + line : line);
  }
  // -> a handler for a failed call in that context (on | test | off | save): the code's own line, else what failed
  function fail(ctx) {
    return function (e) { busy = false; render(errText(e, ctx)); };
  }
  function load() {
    navigator.serviceWorker.getRegistration('/').then(function (r) {
      reg = r || null;
      return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
    }).then(function (s) {
      sub = s && sameKey(s) ? s : null;
      return api('/api/push/state', sub ? { endpoint: sub.endpoint } : {});
    }).then(function (d) {
      mine = d.mine; others = d.others || 0;
      if (isOn()) setPicked(mine.kinds); else setPicked(KINDS);
      render();
    }).catch(function () { mine = null; render(); });
  }

  // "Turn on": the ONLY place the browser's permission prompt is asked for - always from this click
  function enable() {
    if (busy) return;
    var kinds = picked();
    if (!kinds.length) { kinds = KINDS.slice(); setPicked(kinds); }
    busy = true;
    render(Notification.permission === 'granted' ? '' : _t('js.push.asking', 'Your browser will ask you to allow notifications…'));
    var perm = Notification.permission === 'granted' ? Promise.resolve('granted') : new Promise(function (done) {
      var q = Notification.requestPermission(done);
      if (q && typeof q.then === 'function') q.then(done, function () { done('default'); });
    });
    perm.then(function (p) {
      if (p !== 'granted') { var e = new Error('permission'); e.permission = p; throw e; }
      return navigator.serviceWorker.register('/sw.js', { scope: '/' });
    }).then(function () { return navigator.serviceWorker.ready; }).then(function (r) {
      reg = r;
      return r.pushManager.getSubscription();
    }).then(function (s) {
      if (s && !sameKey(s)) return s.unsubscribe().then(function () { return null; }, function () { return null; });
      return s;
    }).then(function (s) {
      return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(KEY) });
    }).then(function (s) {
      sub = s;
      return api('/api/push/subscribe', { subscription: s.toJSON(), kinds: kinds });
    }).then(function (d) {
      busy = false;
      mine = { known: true, kinds: d.kinds }; others = d.others || 0;
      setPicked(d.kinds);
      render(_t('js.push.saved', 'Saved.'));
    }).catch(function (e) {
      if (e && e.permission) { busy = false; render(e.permission === 'denied' ? '' : _t('js.push.failed', "Couldn't turn notifications on - try again.")); return; }
      fail('on')(e);
    });
  }
  function disable(all) {
    if (busy) return;
    busy = true;
    render();
    var ep = sub ? sub.endpoint : null;
    var p = all ? api('/api/push/unsubscribe', { all: true }) : ep ? api('/api/push/unsubscribe', { endpoint: ep }) : Promise.resolve(null);
    p.then(function () { return sub ? sub.unsubscribe().catch(function () { return false; }) : null; }).then(function () {
      busy = false;
      sub = null; mine = { known: false, kinds: [] };
      if (all) others = 0;
      setPicked(KINDS);
      render(_t('js.push.saved', 'Saved.'));
    }).catch(fail('off'));
  }
  function test() {
    if (!sub) return;
    api('/api/push/test', { endpoint: sub.endpoint }).then(function () { render(_t('js.push.test_sent', 'Test sent - it should show up in a few seconds.')); }).catch(fail('test'));
  }
  // the kind boxes: while on, a change saves (all unticked = off); while off they only pick what "Turn on" uses
  if (box) box.addEventListener('change', function () {
    if (!isOn()) return;
    clearTimeout(tmr);
    tmr = setTimeout(function () {
      var kinds = picked();
      if (!kinds.length) { disable(false); return; }
      api('/api/push/subscribe', { subscription: sub.toJSON(), kinds: kinds }).then(function (d) {
        mine.kinds = d.kinds; others = d.others || 0;
        render(_t('js.push.saved', 'Saved.'));
      }).catch(fail('save'));
    }, 400);
  });
  load();
})();
