// roomwars-map.js - Room Wars R4b: draws the room map on /gtf/roomwars (views/roomwars.ejs) from the page's JSON (#rwData),
// then polls /api/gtf/roomwars once a minute: the map redraws with the new data and, when the revision changed, the
// "the map changed" note offers a reload (the room cards below are server-rendered). Rings = tiers (centre = the busiest
// rooms); a held room takes its gang's colour. Plain text only (textContent / SVG text nodes) - no HTML from the data.
// R9 (1.99ahr): dashed lines between rooms that share regulars (data.links: {a, b, score}), under the room boxes, thicker for
// a bigger overlap; each line's title names the two rooms and the overlap - never who.
(function () {
  'use strict';
  var box = document.getElementById('rwMap'), dataEl = document.getElementById('rwData');
  if (!box || !dataEl) return;
  var _t = window.__t || function (k, d, v) { return String(d).replace(/\{(\w+)\}/g, function (m, n) { return v && v[n] != null ? v[n] : m; }); };
  var NS = 'http://www.w3.org/2000/svg';
  var RING = { center: 95, mid: 200, outer: 290 };
  var C = 340;
  var RL = { center: _t('js.rw.ring_center', 'CENTRE'), mid: _t('js.rw.ring_mid', 'MIDDLE'), outer: _t('js.rw.ring_outer', 'OUTER') };
  var data;
  try { data = JSON.parse(dataEl.textContent || '{}'); } catch (e) { data = { rooms: [] }; }
  var shown = Number(box.getAttribute('data-revision')) || data.revision || 0;

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function text(parent, x, y, cls, s, fill) {
    var n = el('text', { x: x, y: y, 'class': cls }, parent);
    if (fill) n.setAttribute('fill', fill);
    n.textContent = s;
    return n;
  }
  function short(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  // rooms without Pepe's position (an older push): spread evenly round their ring
  function place(rooms) {
    var by = { center: [], mid: [], outer: [] };
    rooms.forEach(function (r) { if (!(r.xy && r.xy.length === 2)) (by[r.tier] || by.outer).push(r); });
    Object.keys(by).forEach(function (ring) {
      var list = by[ring], rad = ring === 'center' && list.length === 1 ? 0 : RING[ring];
      list.forEach(function (r, i) {
        var a = 2 * Math.PI * i / Math.max(1, list.length) - Math.PI / 2;
        r.xy = [Math.round(C + rad * Math.cos(a)), Math.round(C + rad * Math.sin(a))];
      });
    });
  }
  function draw(d) {
    var rooms = (d && d.rooms ? d.rooms : []).map(function (r) { return Object.assign({}, r); });
    place(rooms);
    var svg = el('svg', { viewBox: '0 0 680 680', role: 'group', 'aria-label': _t('js.rw.map_aria', 'Room Wars map') });
    // a phone shrinks the 680-unit map to ~320 px: bigger boxes and type there, so a name stays readable
    var big = (box.clientWidth || 680) < 520;
    var W = big ? 212 : 132, H = big ? 76 : 52, NM = big ? 23 : 12, SB = big ? 18 : 10, RLS = big ? 15 : 9, MAXC = big ? 15 : 18;
    ['outer', 'mid', 'center'].forEach(function (ring) {
      el('circle', { cx: C, cy: C, r: RING[ring], 'class': 'ring' }, svg);
      text(svg, C, C - RING[ring] - 6, 'ring-l', RL[ring]).style.fontSize = RLS + 'px';
    });
    var pos = {};
    rooms.forEach(function (r) {
      pos[r.id] = { x: Math.min(680 - W / 2 - 2, Math.max(W / 2 + 2, r.xy[0])), y: Math.min(680 - H / 2 - 2, Math.max(H / 2 + 14, r.xy[1])), name: r.name };
    });
    // R9: the shared-regular lines go under the boxes (drawn first), centre to centre
    var lg = el('g', { 'class': 'links' }, svg);
    (d && Array.isArray(d.links) ? d.links : []).forEach(function (l) {
      var p = pos[l && l.a], q = pos[l && l.b], s = Number(l && l.score);
      if (!p || !q || !(s > 0 && s <= 1)) return;
      var tip = _t('js.rw.link_title', '{a} and {b} share regulars ({pct}% overlap)', { a: p.name, b: q.name, pct: Math.round(s * 100) });
      var line = el('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, 'class': 'link', role: 'img', 'aria-label': tip,
                              'stroke-width': ((2 + 6 * Math.min(1, Math.max(0, (s - 0.15) / 0.85))) * (big ? 1.6 : 1)).toFixed(1) }, lg);
      el('title', {}, line).textContent = tip;
    });
    rooms.forEach(function (r) {
      var x = pos[r.id].x, y = pos[r.id].y;
      var held = r.held, cls = 'node ' + (held ? 'held' : r.state === 'free' ? 'free' : 'dormant') + (r.raid ? ' raid' : '');
      var sub = held ? '[' + (held.tag || '?') + ']' : r.state === 'free' ? _t('js.rw.free_bond', 'free · bond {n}', { n: short(r.bond) }) : _t('js.rw.dormant', 'not contestable');
      var label = held ? _t('js.rw.held_aria', '{room}: held by {tag}', { room: r.name, tag: '[' + (held.tag || '?') + ']' })
        : r.state === 'free' ? _t('js.rw.free_aria', '{room}: free to claim, bond {n} PAT', { room: r.name, n: Number(r.bond || 0).toLocaleString('en-US') })
          : _t('js.rw.dormant_aria', '{room}: not contestable', { room: r.name });
      var wrap = r.href ? el('a', { href: r.href, 'aria-label': label }, svg) : el('g', { role: 'img', 'aria-label': label }, svg);
      var g = el('g', { 'class': cls }, wrap);
      var rect = el('rect', { x: x - W / 2, y: y - H / 2, width: W, height: H, rx: 8 }, g);
      if (held && held.color) rect.setAttribute('fill', held.color);
      var ink = held && held.ink ? held.ink : null;
      text(g, x, y - H * 0.08, 'nm', clip(r.name, MAXC), ink).style.fontSize = NM + 'px';
      text(g, x, y + H * 0.3, 'sub', sub, ink).style.fontSize = SB + 'px';
      if (r.raid) text(g, x + W / 2 - 8, y - H / 2 - 4, 'badge', '🚨').style.fontSize = (NM + 1) + 'px';
      if (r.convoy) text(g, x - W / 2 + 8, y - H / 2 - 4, 'badge', '🚚').style.fontSize = (NM + 1) + 'px';
    });
    box.textContent = '';
    box.appendChild(svg);
  }
  draw(data);
  var last = data, rt = null;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { draw(last); }, 200); });

  var note = document.getElementById('rwNew');
  var api = box.getAttribute('data-api');
  function poll() {
    if (!api || document.hidden) return;
    fetch(api, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok || !j.live) return;
      var rooms = (j.rooms || []).map(function (r) {
        return { id: r.id, name: r.name, tier: r.tier, xy: r.xy, state: r.state, bond: r.bond, href: r.pad ? r.pad.href : null,
                 held: r.held ? { tag: r.held.tag, color: r.held.color, ink: r.held.ink } : null, raid: !!r.raid, convoy: !!r.convoy };
      });
      last = { revision: j.revision, rooms: rooms, links: Array.isArray(j.links) ? j.links : [] };
      draw(last);
      if (note && j.revision && j.revision !== shown) note.hidden = false;
    }).catch(function () { /* the next poll tries again */ });
  }
  setInterval(poll, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
