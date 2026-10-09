// pad-launch.js - the pad launchpad card on a pad page (views/room.ejs #padLaunch; launchpad.js on the server).
// GET /api/rooms/:slug/launch -> the public progress bar ("🚀 23/30 regulars toward launch"), the tiers, the boost
// credit and the newcomer welcome; the owner (and site staff) also get who didn't count and why, the owner match and
// the graduation rows. Hidden when the launchpad is off or this pad isn't on it. All server text via textContent.
(function () {
  'use strict';
  var box = document.getElementById('padLaunch');
  if (!box || !window.fetch) return;
  var slug = box.getAttribute('data-slug');
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  var WHY = { owner: 'the owner (or their own accounts)', duplicate: 'flagged as duplicate / alt accounts', unlinked: 'not linked (Camfrog, Discord, Twitch or a verified email)',
              'too new': 'accounts that are too new', 'low level': 'below the minimum level', bot: 'Pepe', 'no account': 'no PATV account' };
  function render(d) {
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!d || !d.ok || !d.on || !d.eligible || !d.launch) { box.hidden = true; return; }
    var p = d.progress || {};
    var next = p.next;
    var h = el('h2');
    h.appendChild(el('span', null, d.graduated ? '🚀 Graduated from the launchpad' : '🚀 Launchpad'));
    h.appendChild(el('small', null, d.launch.open ? d.launch.days_left + ' day' + (d.launch.days_left === 1 ? '' : 's') + ' left to launch'
                                                  : 'launch window closed'));
    box.appendChild(h);
    if (next) {
      box.appendChild(el('p', 'pl-goal', '🚀 ' + p.regulars + '/' + next.regulars + ' regulars toward ' +
        (next.n === d.tiers.length ? 'launch' : 'tier ' + next.n) + (next.active_days ? ' · ' + Math.min(p.active_days, next.active_days) + '/' + next.active_days + ' active days' : '')));
      var bar = el('div', 'pl-bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(next.regulars));
      bar.setAttribute('aria-valuenow', String(Math.min(p.regulars, next.regulars)));
      bar.setAttribute('aria-label', 'Regulars toward the next launch tier');
      var fill = el('i');
      fill.style.width = Math.min(100, Math.round(100 * p.regulars / Math.max(1, next.regulars))) + '%';
      bar.appendChild(fill);
      box.appendChild(bar);
    }
    var r = d.rules || {};
    box.appendChild(el('p', 'pl-meta', 'A new pad builds momentum toward a launch grant into its room vault: a regular is a real member (linked, ' +
      (r.min_account_days || 0) + '+ days old, level ' + (r.min_level || 0) + '+) active here on ' + (r.regular_days || 2) +
      '+ different days in the last ' + d.launch.window_days + ' days - chat, mic or posts. The owner\'s own activity doesn\'t count. ' +
      'Last ' + d.launch.window_days + ' days: ' + fmt(d.metrics.chatters) + ' chatters, ' + fmt(d.metrics.mic_min) + ' mic minutes, ' +
      fmt(d.metrics.posts) + ' posts, ' + fmt(d.metrics.returning) + ' returning.'));
    var ul = el('ul', 'pl-tiers');
    ul.setAttribute('aria-label', 'Launch tiers');
    (d.tiers || []).forEach(function (t) {
      var label = (t.n === d.tiers.length ? '🚀 Launch' : 'Tier ' + t.n) + ': ' + t.regulars + ' regulars, ' + t.active_days + ' active days → PAT ' + fmt(t.grant);
      if (t.state === 'paid') label += ' ✓ paid';
      else if (t.state === 'review') label += ' · in review';
      else if (t.state === 'approved') label += ' · approved' + (d.room_vaults ? '' : ' (waiting for room vaults)');
      else if (t.state === 'rejected') label += ' · not approved';
      ul.appendChild(el('li', t.state === 'paid' ? 'done' : '', label));
    });
    box.appendChild(ul);
    var extra = [];
    if (d.welcome && d.welcome.open && d.welcome.amount > 0 && d.live) extra.push('👋 New here? Your first chat, mic or post in this pad earns PAT ' + fmt(d.welcome.amount) + ' (once per person).');
    if (d.boost && d.boost.active) extra.push('🚀 Front-page boost credit until ' + new Date(d.boost.until).toISOString().slice(0, 10) + '.');
    if (extra.length) box.appendChild(el('p', 'pl-meta', extra.join(' ')));
    if (d.owner) {
      var o = el('div', 'pl-owner');
      o.appendChild(el('b', null, 'Owner view'));
      var list = el('ul');
      var ex = d.owner.excluded || {};
      var keys = Object.keys(ex);
      list.appendChild(el('li', null, keys.length ? 'Not counted: ' + keys.map(function (k) { return ex[k] + ' ' + (WHY[k] || k); }).join(' · ') : 'Everyone active here counted.'));
      var m = d.owner.match || {};
      list.appendChild(el('li', null, 'Owner match: PAT ' + fmt(m.used) + ' of ' + fmt(m.cap) + ' (' + m.ratio_pct + '% of your own !roomvault deposits' +
        (m.open ? ', until ' + new Date(m.until).toISOString().slice(0, 10) : ', closed') + ')' + (m.camfrog ? '' : ' - deposits are made in the pad\'s Camfrog room') +
        (m.needs_room_vaults ? ' - waiting for room vaults' : '') + '.'));
      var w = d.owner.welcomes || {};
      list.appendChild(el('li', null, 'Newcomer welcomes paid here: ' + fmt(w.n) + ' of ' + fmt(w.cap) + ' (PAT ' + fmt(w.total) + ').'));
      list.appendChild(el('li', null, d.owner.review ? 'Each tier is reviewed by an admin before Pepe pays it.' : 'Tiers are paid without review.'));
      o.appendChild(list);
      box.appendChild(o);
    }
    if (!d.live) box.appendChild(el('p', 'pl-meta', 'The launchpad is paused right now - progress still counts.'));
    box.hidden = false;
  }
  fetch('/api/rooms/' + encodeURIComponent(slug) + '/launch', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { box.hidden = true; });
})();
