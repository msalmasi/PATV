// profile-feed.js — the owner's "Profile feed settings" on their profile (1.99df): Pepe answering mentions on their
// profile posts (POST /api/profile/settings {pepe}), and blocking / unblocking people from commenting on the profile
// (the pad owner's ban: POST /api/feed/ban / /api/feed/unban with room = the profile pad's slug). Same-site JSON
// with X-Requested-With: fetch, like the rest of the feed.
(function () {
  'use strict';
  if (window.__patvProfileFeed) return;
  window.__patvProfileFeed = true;
  function api(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) { if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  var box = document.querySelector('[data-pp-settings]');
  if (!box) return;
  // the profile pad is made on first use: its slug comes back from /api/profile/settings when it didn't exist yet
  function slug() {
    var s = box.getAttribute('data-slug');
    if (s) return Promise.resolve(s);
    return api('/api/profile/settings', {}).then(function (d) { box.setAttribute('data-slug', d.slug); return d.slug; });
  }
  var pepe = box.querySelector('[data-pp-pepe]');
  if (pepe) pepe.addEventListener('change', function () {
    pepe.disabled = true;
    api('/api/profile/settings', { pepe: pepe.checked }).then(function (d) { pepe.checked = !!d.pepe; if (d.slug) box.setAttribute('data-slug', d.slug); })
      .catch(function (e) { pepe.checked = !pepe.checked; alert(e.message); })
      .then(function () { pepe.disabled = false; });
  });
  // 1.99dn: "Don't post my room generations" (POST /api/profile/settings {roomgenOff})
  var rg = box.querySelector('[data-pp-roomgen]');
  if (rg) rg.addEventListener('change', function () {
    rg.disabled = true;
    api('/api/profile/settings', { roomgenOff: rg.checked }).then(function (d) { rg.checked = !!d.roomgenOff; if (d.slug) box.setAttribute('data-slug', d.slug); })
      .catch(function (e) { rg.checked = !rg.checked; alert(e.message); })
      .then(function () { rg.disabled = false; });
  });
  box.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-pp-unban]');
    if (!b) return;
    b.disabled = true;
    slug().then(function (s) { return api('/api/feed/unban', { userId: b.getAttribute('data-pp-unban'), room: s }); })
      .then(function () { location.hash = 'profile-settings'; location.reload(); })
      .catch(function (e) { b.disabled = false; alert(e.message); });
  });
  var f = box.querySelector('[data-pp-ban]');
  if (f) f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = f.querySelector('.fc-err');
    var who = f.elements.user.value.trim().replace(/^@|^u\//, '');
    if (!who) { err.textContent = 'Type a username.'; return; }
    err.textContent = '';
    slug().then(function (s) { return api('/api/feed/ban', { user: who, room: s, days: parseInt(f.elements.days.value, 10) || 0, reason: 'blocked from commenting on a profile' }); })
      .then(function () { location.hash = 'profile-settings'; location.reload(); })
      .catch(function (e) { err.textContent = e.message; });
  });
  if (location.hash === '#profile-settings') { var d = document.getElementById('profile-settings'); if (d) d.open = true; }
})();
