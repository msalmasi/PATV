// push-sw.js — the service worker for browser notifications (1.99acd, webpush.js, QW-1). Served as /sw.js (root scope).
//
// It does three things and nothing else: shows a push as a notification, opens the right page when one is clicked, and
// re-subscribes when the browser rotates a subscription. There is NO fetch handler and no cache, so it never touches a
// page load or a request - registering it changes nothing about how the site loads.
//
// A push payload is content-free by contract (webpush.js render(), v:1): {v, k: kind, t: title, b: body, u: a local path,
// tag, ts, d: text direction}. Only a local path is ever opened. A focused, visible tab already on that page gets no
// notification (it's told with postMessage instead) - except test pushes, which always show.
'use strict';

function localPath(u) {
  return typeof u === 'string' && u.length <= 300 && /^\/(?![\/\\])/.test(u) && u.indexOf('\\') < 0 ? u : '/';
}
function pathOf(u) {
  try { return new URL(u, self.location.origin).pathname; } catch (e) { return '/'; }
}
function str(v, n, d) { return typeof v === 'string' && v ? v.slice(0, n) : d; }

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var d = null;
  try { d = event.data ? event.data.json() : null; } catch (e) { d = null; }
  if (!d || typeof d !== 'object') d = { k: 'other', t: 'PATV', u: '/' };
  var u = localPath(d.u);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    if (d.k !== 'test') {
      var target = pathOf(u);
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.focused && c.visibilityState === 'visible' && pathOf(c.url) === target) {
          try { c.postMessage({ t: 'push', k: d.k, u: u }); } catch (e) { /* the tab went away */ }
          return null;
        }
      }
    }
    return self.registration.showNotification(str(d.t, 120, 'PATV'), {
      body: str(d.b, 200, ''), tag: str(d.tag, 120, 'patv'), renotify: true, icon: '/public/img/icon-192.png',
      timestamp: Number(d.ts) || Date.now(), dir: d.d === 'rtl' || d.d === 'ltr' ? d.d : 'auto', data: { u: u },
    });
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var u = localPath(event.notification.data && event.notification.data.u);
  var target = pathOf(u);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (pathOf(c.url) === target && 'focus' in c) {
        var full = new URL(u, self.location.origin).href;
        return c.focus().then(function (w) {
          if (w && w.url !== full && 'navigate' in w) return w.navigate(full).catch(function () { return w; });
          return w;
        });
      }
    }
    return self.clients.openWindow(u);
  }));
});

function api(path, body) {
  return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
                       body: JSON.stringify(body || {}) });
}
function keyBytes(b64) {
  var s = String(b64 || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  var raw = atob(s), out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
// the browser replaced (or dropped) the subscription: make a new one with the same key and tell the site which row it replaces.
// Any failure is swallowed - the old row dies at its next push (404 / 410) and the member can turn notifications on again.
self.addEventListener('pushsubscriptionchange', function (event) {
  var old = event.oldSubscription || null;
  if (!old) return;
  var fresh = event.newSubscription ? Promise.resolve(event.newSubscription)
    : (old.options && old.options.applicationServerKey ? Promise.resolve(old.options.applicationServerKey)
      : api('/api/push/state', {}).then(function (r) { return r.json(); }).then(function (d) { return d && d.ok && d.key ? keyBytes(d.key) : null; }))
      .then(function (key) { return key ? self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null; });
  event.waitUntil(fresh.then(function (sub) {
    if (!sub) return null;
    return api('/api/push/resubscribe', { old_endpoint: old.endpoint, subscription: sub.toJSON() });
  }).catch(function () { return null; }));
});
